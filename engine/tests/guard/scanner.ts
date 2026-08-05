/**
 * Guard-сканер инвариантов детерминизма (CLI-8): AST-обход исходников через
 * TypeScript Compiler API. Комментарии и строки не сканируются — это AST,
 * а не grep, поэтому «Q16.16» в тексте ошибки не даёт ложного срабатывания.
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
  for (let a: ts.Node | undefined = p; a && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isTypeNode(a)) return false; // `x: Promise<void>` — тип, ловим только значение
  }
  return true;
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

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isValueUsage(node)) {
      push(node, 'forbidden-global', `${node.text}: ${FORBIDDEN_GLOBALS.get(node.text)!}`);
    }

    if (mode === 'strict') {
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

/** Пустая строка ⇔ нарушений нет; иначе по строке на нарушение — для expect(...).toBe(''). */
export function formatViolations(violations: readonly GuardViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`).join('\n');
}
