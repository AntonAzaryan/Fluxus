/**
 * Guard-сканер инвариантов, проверяемых по AST (CLI-8): обход исходников через
 * TypeScript Compiler API. Комментарии и строки не сканируются — это AST,
 * а не grep, поэтому «Q16.16» в тексте ошибки не даёт ложного срабатывания.
 *
 * Инвариантов здесь два, и оба — про то, чего в коде быть не должно:
 * детерминизм ядра (часы, чужая случайность, float-литералы, async) и свобода
 * пакета рендера от DOM (`rendering` REND-19, `render-debug` RDBG-3).
 *
 * Списки запрещённого и разрешённого — данные этого файла: их правка обязана
 * попадать в дифф на ревью (CLI-8). Сканер общий для всех реализаций-пакетов,
 * какие директории под каким режимом — объявляют адаптер-тесты пакетов.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type GuardMode = 'strict' | 'pure-cycle';

export interface GuardViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

/** Точечное исключение: файл целиком освобождается от одного правила, причина обязательна. */
export interface GuardException {
  readonly file: string;
  readonly rule: string;
  readonly reason: string;
}

export interface ScanConfig {
  /** Абсолютный путь к сканируемой директории. */
  readonly rootDir: string;
  readonly mode: GuardMode;
  /** Относительные пути (файлы или директории) внутри rootDir, не подлежащие сканированию. */
  readonly exclude?: readonly string[];
  readonly exceptions?: readonly GuardException[];
}

const CONFIG_HINT = 'конфиг: engine/tests/guard/scanner.ts';

/**
 * Члены `Math`, точные на целых числах: детерминированы на всех платформах,
 * их запрет дал бы поток ложных срабатываний (CLI-8). Всё остальное —
 * трансцендентные функции и `random` — запрещено в обоих режимах.
 */
const MATH_ALLOWED = new Set(['min', 'max', 'abs', 'floor', 'ceil', 'trunc', 'imul', 'sign']);

/** Глобальные значения, запрещённые в детерминированном коде: часы, таймеры, чужая случайность. */
const FORBIDDEN_GLOBALS = new Map<string, string>([
  ['Date', 'wall-clock внутри симуляции (DET-5)'],
  ['performance', 'wall-clock внутри симуляции (DET-5)'],
  ['process', 'окружение и hrtime — внешний вход мимо тика (DET-5)'],
  ['setTimeout', 'таймер внутри детерминированного цикла (DET-5)'],
  ['setInterval', 'таймер внутри детерминированного цикла (DET-5)'],
  ['setImmediate', 'таймер внутри детерминированного цикла (DET-5)'],
  ['queueMicrotask', 'отложенное исполнение внутри детерминированного цикла (DET-5)'],
  ['crypto', 'источник случайности вне ГПСЧ ядра (DET-4)'],
]);

function isFloatLiteral(text: string): boolean {
  if (/^0[xXbBoO]/.test(text)) return false; // hex/bin/oct: 'e' в 0x9e… — цифра, а не экспонента
  return text.includes('.') || /[eE]/.test(text);
}

/**
 * Родитель узла. Отдельной функцией с честным типом: `ts.Node.parent` объявлено
 * API непустым, но у корня и у узла ВНЕ дерева родителя нет, — и подъём вверх
 * обязан на этом останавливаться, а не гасить линтер на каждой такой проверке.
 */
function parentOf(node: ts.Node): ts.Node | undefined {
  return (node as { parent?: ts.Node }).parent;
}

/** Идентификатор — использование значения, а не имя свойства/типа/импорта. */
function isValueUsage(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isEnumMember(p) ||
      ts.isBindingElement(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  for (let a: ts.Node | undefined = p; a !== undefined && !ts.isSourceFile(a); a = parentOf(a)) {
    if (ts.isTypeNode(a)) return false; // `x: Promise<void>` — тип, ловим только значение
  }
  return true;
}

/** Куда сканер складывает нарушение: узел, правило, текст. */
type GuardPush = (node: ts.Node, rule: string, message: string) => void;

/**
 * Проверки строгого режима: float-литералы и асинхронность (DET-2, TICK-1).
 *
 * Отдельной функцией, а не веткой внутри обхода: режимов два, и вырожденный
 * `pure-cycle` не обязан читаться сквозь чужие правила.
 */
function visitStrict(node: ts.Node, sf: ts.SourceFile, push: GuardPush): void {
  if (ts.isNumericLiteral(node) && isFloatLiteral(node.getText(sf))) {
    // node.text нормализован (1e3 → «1000»), поэтому смотрим на исходную запись.
    push(node, 'float-literal', `float-литерал ${node.getText(sf)} в геймплейной математике (DET-2)`);
  }
  if (ts.isAwaitExpression(node)) {
    push(node, 'async', 'await внутри детерминированного кода: тик синхронный (TICK-1)');
  }
  if (ts.canHaveModifiers(node)) {
    const asyncMod = ts.getModifiers(node)?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (asyncMod) push(asyncMod, 'async', 'async-функция внутри детерминированного кода: тик синхронный (TICK-1)');
  }
  if (ts.isIdentifier(node) && node.text === 'Promise' && isValueUsage(node)) {
    push(node, 'async', 'Promise внутри детерминированного кода: тик синхронный (TICK-1)');
  }
}

/** Сканирует один исходник; `fileName` попадает в нарушения как есть. */
export function scanSourceText(fileName: string, text: string, mode: GuardMode): GuardViolation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: GuardViolation[] = [];
  const push = (node: ts.Node, rule: string, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file: fileName, line: line + 1, rule, message: `${message} — ${CONFIG_HINT}` });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      !MATH_ALLOWED.has(node.name.text)
    ) {
      push(node, 'math-api', `Math.${node.name.text}: не точен на целых или недетерминирован (DET-2, DET-4)`);
    }

    if (ts.isIdentifier(node)) {
      const why = FORBIDDEN_GLOBALS.get(node.text);
      if (why !== undefined && isValueUsage(node)) push(node, 'forbidden-global', `${node.text}: ${why}`);
    }

    if (mode === 'strict') visitStrict(node, sf, push);

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Глобальные значения DOM. Пакет рендера обязан быть от DOM свободен (REND-19):
 * текста в кадре нет и быть не может — текст в сцене это канвас-текстура, то
 * есть DOM, — а канвас слоя миникарты приносит СБОРКА фабрикой (`fog.ts`), и
 * структурного минимума ей довольно.
 *
 * Ловится ЗНАЧЕНИЕ, а не имя: `private document: QualityPreset` и `this.document`
 * — поля своих классов, к DOM отношения не имеющие, и краснить на них сканер не
 * вправе. Типовое употребление (`HTMLCanvasElement` в сигнатуре) тоже мимо:
 * тип живёт в объявлении, а не в кадре.
 */
const DOM_GLOBALS = new Map<string, string>([
  ['document', 'DOM внутри пакета рендера (REND-19): текст и узлы страницы — дело встраивающего приложения'],
  ['window', 'глобал страницы внутри пакета рендера (REND-19)'],
  ['navigator', 'глобал страницы внутри пакета рендера (REND-19)'],
  ['HTMLElement', 'тип DOM как значение внутри пакета рендера (REND-19)'],
  ['HTMLCanvasElement', 'канвас страницы: слою миникарты его приносит сборка фабрикой (REND-19)'],
  ['Image', 'декодирование изображения средствами страницы внутри рендера (REND-19)'],
]);

/**
 * Обращения к DOM мимо имени глобала: `(globalThis as { document?: X }).document`
 * читается как обычное свойство, и списком глобалов не ловится. Имена узкие —
 * фабрики и поиск узлов страницы; `getContext` сюда НЕ входит: его зовут на
 * канвасе, который приносит сборка (`FogLayerCanvas`), и это законный вход.
 */
const DOM_MEMBERS = new Map<string, string>([
  ['createElement', 'создание узла страницы внутри пакета рендера (REND-19)'],
  ['createTextNode', 'текстовый узел страницы внутри пакета рендера (REND-19, RDBG-3)'],
  ['getElementById', 'поиск узла страницы внутри пакета рендера (REND-19)'],
  ['querySelector', 'поиск узла страницы внутри пакета рендера (REND-19)'],
  ['appendChild', 'вставка узла страницы внутри пакета рендера (REND-19)'],
]);

/**
 * Сканирует один исходник на обращения к DOM. Отдельная функция, а не режим
 * `scanSourceText`: запрет не про детерминизм, и смешивать их в одном перечне
 * значило бы, что правка одного молча трогает другой.
 */
export function scanDomInSource(fileName: string, text: string): GuardViolation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: GuardViolation[] = [];
  const push = (node: ts.Node, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file: fileName, line: line + 1, rule: 'dom-in-render', message: `${message} — ${CONFIG_HINT}` });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const why = DOM_GLOBALS.get(node.text);
      if (why !== undefined && isValueUsage(node)) push(node, `${node.text}: ${why}`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const why = DOM_MEMBERS.get(node.name.text);
      if (why !== undefined) push(node, `.${node.name.text}: ${why}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Все спецификаторы import/export/`import()` одного исходника. */
export function scanImportsInSource(fileName: string, text: string): GuardViolation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: GuardViolation[] = [];
  const check = (spec: ts.Expression): void => {
    if (!ts.isStringLiteralLike(spec)) return;
    if (spec.text.startsWith('.')) return;
    const { line } = sf.getLineAndCharacterOfPosition(spec.getStart(sf));
    out.push({
      file: fileName,
      line: line + 1,
      rule: 'import-boundary',
      message: `импорт '${spec.text}': из этого кода разрешены только относительные импорты — ${CONFIG_HINT}`,
    });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      check(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* walkTsFiles(dir: string, rel = ''): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const relPath = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) {
      yield* walkTsFiles(abs, relPath);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      yield relPath;
    }
  }
}

function applyConfig(
  config: ScanConfig,
  scan: (relPath: string, text: string) => GuardViolation[],
): GuardViolation[] {
  const exclude = config.exclude ?? [];
  const exceptions = config.exceptions ?? [];
  const out: GuardViolation[] = [];
  for (const relPath of walkTsFiles(config.rootDir)) {
    if (exclude.some((e) => relPath === e || relPath.startsWith(`${e}/`))) continue;
    const text = readFileSync(join(config.rootDir, relPath), 'utf8');
    for (const violation of scan(relPath, text)) {
      if (exceptions.some((e) => e.file === violation.file && e.rule === violation.rule)) continue;
      out.push(violation);
    }
  }
  return out;
}

/** Скан детерминизма по директории с учётом исключений конфига. */
export function scanDir(config: ScanConfig): GuardViolation[] {
  return applyConfig(config, (rel, text) => scanSourceText(rel, text, config.mode));
}

/** Скан границ импортов по директории: только относительные спецификаторы. */
export function scanImports(config: Omit<ScanConfig, 'mode'>): GuardViolation[] {
  return applyConfig({ ...config, mode: 'strict' }, scanImportsInSource);
}

/** Скан свободы от DOM по директории (REND-19) с учётом исключений конфига. */
export function scanDom(config: Omit<ScanConfig, 'mode'>): GuardViolation[] {
  return applyConfig({ ...config, mode: 'strict' }, scanDomInSource);
}

/** Пустая строка ⇔ нарушений нет; иначе по строке на нарушение — для expect(...).toBe(''). */
export function formatViolations(violations: readonly GuardViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`).join('\n');
}
