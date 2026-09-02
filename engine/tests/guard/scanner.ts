/**
 * Guard-сканер инвариантов, проверяемых по AST (CLI-8): обход исходников через
 * TypeScript Compiler API. Комментарии и строки не сканируются — это AST,
 * а не grep, поэтому «Q16.16» в тексте ошибки не даёт ложного срабатывания.
 *
 * Инвариантов здесь три. Два — про то, чего в коде быть НЕ должно: детерминизм
 * ядра (часы, чужая случайность, float-литералы, async) и свобода пакета
 * рендера от DOM (`rendering` REND-19, `render-debug` RDBG-3). Третий,
 * наоборот, про то, что БЫТЬ ОБЯЗАНО: каждое создание ресурса GPU в рендере
 * проходит через учёт занятой памяти (`performance-budget` PERF-8, PERF-9) —
 * инвариант «после сноса живых ноль» проверяет только учтённое, и ресурс,
 * заведённый мимо учёта, прошёл бы его молча.
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

// ------------------------------------- полнота учёта ресурсов GPU (PERF-8, PERF-9)

/**
 * Классы ресурсов GPU по видам учёта (`performance-budget` PERF-8). Список —
 * ДАННЫЕ правила: его правка обязана попадать в дифф на ревью (CLI-8), как и
 * список исключений. Перечислены классы `three`, у которых есть `dispose()`, —
 * то есть ровно те, чьё создание что-то занимает в GPU и чьё освобождение
 * нормирует `rendering` REND-31.
 *
 * Ловится создание, а не переменная: `new THREE.BufferGeometry()` обязано
 * стоять аргументом `own(...)`, иначе живое число подсистемы недосчитается
 * ресурса, и течь пришлось бы искать профилировщиком вместо красной строки.
 */
const GPU_RESOURCE_CLASSES = new Map<string, string>([
  ...[
    'BufferGeometry',
    'InstancedBufferGeometry',
    'BoxGeometry',
    'CapsuleGeometry',
    'CircleGeometry',
    'ConeGeometry',
    'CylinderGeometry',
    'DodecahedronGeometry',
    'EdgesGeometry',
    'ExtrudeGeometry',
    'IcosahedronGeometry',
    'LatheGeometry',
    'OctahedronGeometry',
    'PlaneGeometry',
    'PolyhedronGeometry',
    'RingGeometry',
    'ShapeGeometry',
    'SphereGeometry',
    'TetrahedronGeometry',
    'TorusGeometry',
    'TorusKnotGeometry',
    'TubeGeometry',
    'WireframeGeometry',
  ].map((name): [string, string] => [name, 'geometry']),
  ...[
    'Material',
    'LineBasicMaterial',
    'LineDashedMaterial',
    'MeshBasicMaterial',
    'MeshDepthMaterial',
    'MeshDistanceMaterial',
    'MeshLambertMaterial',
    'MeshMatcapMaterial',
    'MeshNormalMaterial',
    'MeshPhongMaterial',
    'MeshPhysicalMaterial',
    'MeshStandardMaterial',
    'MeshToonMaterial',
    'PointsMaterial',
    'RawShaderMaterial',
    'ShaderMaterial',
    'ShadowMaterial',
    'SpriteMaterial',
  ].map((name): [string, string] => [name, 'material']),
  ...[
    'Texture',
    'CanvasTexture',
    'CompressedArrayTexture',
    'CompressedTexture',
    'CubeTexture',
    'Data3DTexture',
    'DataArrayTexture',
    'DataTexture',
    'DepthTexture',
    'FramebufferTexture',
    'VideoTexture',
  ].map((name): [string, string] => [name, 'texture']),
  ...[
    'WebGL3DRenderTarget',
    'WebGLArrayRenderTarget',
    'WebGLCubeRenderTarget',
    'WebGLRenderTarget',
  ].map((name): [string, string] => [name, 'renderTarget']),
]);

/** Имя учётной обёртки — то же, что экспортирует `render-ts/src/footprint.ts`. */
const OWN_CALL = 'own';

/**
 * Приёмники `clone()`, чья копия ресурсом GPU НЕ является, — данные правила с
 * причиной у каждого, как и список классов выше. Ключ — текст приёмника, а не
 * его имя: `source.clone()` в одном модуле копирует материал, а `this.source.clone()`
 * в другом — генератор значений, и разрешать их одним именем значило бы
 * простить будущему материалу то, что прощено генератору.
 *
 * Копия материала или геометрии — такое же создание ресурса, как `new`: у неё
 * свои буферы и своя программа, и отдавать её обязан тот же владелец (REND-31).
 * Поэтому по умолчанию `clone()` требует учёта, а исключение объявляется здесь.
 */
const CLONE_ALLOWED_RECEIVERS = new Map<string, string>([
  [
    'template',
    'граф объектов эффекта (three.quarks): клон ДЕЛИТ материал и геометрию с образцом, своих ресурсов не заводит (REND-24)',
  ],
  [
    'this.source',
    'генератор значений three.quarks (`ScaledValue`/`ScaledFunction`): ресурсом GPU не является вовсе',
  ],
]);

/** Имя класса в `new X()` / `new NS.X()`; иначе — `undefined`. */
function newExpressionClass(node: ts.NewExpression): string | undefined {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

/** Стоит ли выражение аргументом `own(...)` — того самого вызова учёта. */
function isOwned(node: ts.Expression): boolean {
  const parent = parentOf(node);
  if (parent === undefined || !ts.isCallExpression(parent)) return false;
  if (!ts.isIdentifier(parent.expression) || parent.expression.text !== OWN_CALL) return false;
  return parent.arguments.some((argument) => argument === node);
}

/** Приёмник вызова `x.clone()` в тексте исходника; `undefined` — вызов не `clone()`. */
function cloneReceiver(node: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  const target = node.expression;
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'clone') return undefined;
  return target.expression.getText(sf).replace(/\s+/g, '');
}

/**
 * Скан полноты учёта ресурсов GPU в одном исходнике (PERF-9): создание ресурса
 * мимо `own(...)` — красная строка с файлом, строкой и видом ресурса.
 *
 * Отдельная функция, а не режим `scanSourceText`: правило не про детерминизм, и
 * смешивать их в одном перечне значило бы, что правка одного молча трогает
 * другой — тот же довод, что у скана DOM.
 */
export function scanResourceOwnershipInSource(fileName: string, text: string): GuardViolation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: GuardViolation[] = [];
  const push = (node: ts.Node, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({
      file: fileName,
      line: line + 1,
      rule: 'gpu-resource-ownership',
      message: `${message} (PERF-8, PERF-9) — ${CONFIG_HINT}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const name = newExpressionClass(node) ?? '';
      const kind = GPU_RESOURCE_CLASSES.get(name);
      if (kind !== undefined && !isOwned(node)) {
        push(
          node,
          `${name}: ресурс GPU вида "${kind}" создан мимо учёта — оберните выражение ` +
            `в ${OWN_CALL}('${kind}', '<владелец>', …)`,
        );
      }
    }
    if (ts.isCallExpression(node)) {
      const receiver = cloneReceiver(node, sf);
      if (
        receiver !== undefined &&
        !CLONE_ALLOWED_RECEIVERS.has(receiver) &&
        !isOwned(node)
      ) {
        push(
          node,
          `${receiver}.clone(): копия — такое же создание ресурса GPU, как \`new\` — ` +
            `оберните её в ${OWN_CALL}('<вид>', '<владелец>', …) либо объявите приёмник ` +
            'в списке не-ресурсов правила',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Скан полноты учёта ресурсов GPU по директории с учётом исключений конфига. */
export function scanResourceOwnership(config: Omit<ScanConfig, 'mode'>): GuardViolation[] {
  return applyConfig({ ...config, mode: 'strict' }, scanResourceOwnershipInSource);
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

/**
 * Обход исходников каталога. Расширения — параметр, потому что сканируемое
 * разное: инварианты пакетов живут в `.ts`, а бины запускалок — в `.mjs`, и
 * второй обход дерева ради этого был бы вторым местом, где решают, что считать
 * исходником. Объявления (`.d.ts`, `.d.mts`) не исходники — кода в них нет.
 */
function* walkSourceFiles(dir: string, exts: readonly string[], rel = ''): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const relPath = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) {
      yield* walkSourceFiles(abs, exts, relPath);
    } else if (exts.some((ext) => name.endsWith(ext)) && !/\.d\.[cm]?ts$/.test(name)) {
      yield relPath;
    }
  }
}

function* walkTsFiles(dir: string, rel = ''): Generator<string> {
  yield* walkSourceFiles(dir, ['.ts'], rel);
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

/** Строковый литерал исходника: текст, файл и строка — материал для правил поверх. */
export interface SourceLiteral {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Строковые литералы одного исходника — без комментариев и без вычисляемых
 * шаблонов.
 *
 * Собираются `StringLiteral` и `NoSubstitutionTemplateLiteral`: у них есть
 * готовый текст. Шаблон с подстановкой — не строка, а выражение, и склеивать
 * его куски значило бы выдумывать литерал, которого в коде нет. Комментарии в
 * AST не узлы — по построению, и это ровно то, зачем правила поверх этого
 * сканера пишут не grep'ом: путь, названный в комментарии, ссылкой не является.
 */
export function collectStringLiterals(fileName: string, text: string): SourceLiteral[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: SourceLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file: fileName, line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Расширения, которые скан литералов берёт по умолчанию: код тестов и бинов запускалок. */
export const LITERAL_SOURCE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

/**
 * Строковые литералы всех исходников каталога, включая `.mjs`/`.cjs`: правила
 * про пути одинаково касаются тестов и бинов запускалок.
 * `file` — путь относительно `rootDir`, как у остальных сканеров.
 *
 * Расширения — параметр: `.json` компилятор разбирает тем же парсером
 * (`ScriptKind.JSON`), и документ-конфиг с путями внутри — такой же материал для
 * правил, что и код, но брать его всюду значило бы сканировать ещё и фикстуры.
 */
export function collectStringLiteralsInDir(
  rootDir: string,
  exts: readonly string[] = LITERAL_SOURCE_EXTS,
): SourceLiteral[] {
  const out: SourceLiteral[] = [];
  for (const relPath of walkSourceFiles(rootDir, exts)) {
    out.push(...collectStringLiterals(relPath, readFileSync(join(rootDir, relPath), 'utf8')));
  }
  return out;
}
