/**
 * Guard источника (`game-content` CONT-5, сценарий «Документ контент-пака
 * запекли в сборку»): ни один модуль страницы не получает документ матча или
 * конфиг сцены ИМПОРТОМ СБОРЩИКА — их байты приезжают из раздачи оболочки.
 *
 * Проверяется сборкой, а не ревью, по той же причине, по которой граница
 * контента в движке проверяется сканером (`engine/integration-ts/test/
 * contentBoundary.test.ts`): запечённый документ — вторая копия документа
 * дерева (CONT-3), и расходится она с ним МОЛЧА. Наблюдаемо это было бы отказом
 * входа по хешу контент-пака (NTR-5) у игрока, а не красной строкой у автора.
 *
 * Скан — по AST, а не grep'ом: пути документов названы в комментариях половины
 * модулей сборки, а комментарий импортом не является. Ловятся три входа
 * сборщика, и все три кладут документ в бандл одинаково: спецификатор
 * `import`/`export … from`, аргумент динамического `import()` и шаблоны
 * `import.meta.glob`/`globEager` — пачка тех же импортов, записанная маской.
 *
 * Файлов скан не пропускает НИ ОДНОГО, и это несущее: пропуск по имени файла
 * спрятал бы и настоящий импорт сцены, случись он завтра в том же модуле.
 * Законные импорты документов ДЕРЕВА (профиль бота) названы ниже списком —
 * записью факта, а не освобождением от правила: правило про `scenes/` и
 * `matches/`, и `bots.ts` ему просто не противоречит (это и проверяется).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('../app/', import.meta.url));

/**
 * Директории дерева контента, документы которых входят в контент-пак матча и
 * потому в хеш версии (NET-17): их байты страница обязана читать из раздачи.
 * Список — данные правила: его правка обязана попадать в дифф на ревью (CLI-8).
 */
const PACK_DIRS: readonly { readonly dir: string; readonly what: string }[] = [
  { dir: 'scenes', what: 'конфиг сцены контент-пака' },
  { dir: 'matches', what: 'документ матча' },
];

/**
 * Модули сборки, законно импортирующие документы ДЕРЕВА, и причина у каждого.
 *
 * Освобождением от правила они не являются и им быть не должны: профиль бота и
 * документы его поведения (BOT-6, BOT-8) в контент-пак не входят и хеш версии
 * не двигают (NET-17) — их доставка отдельный вопрос без сегодняшнего симптома
 * (Non-Goals дизайна change'а). Список — запись этого факта, и держит его
 * честным третий тест ниже: названный файл обязан импортировать документ дерева
 * И не давать сканеру ни одной находки. Разойдись это — либо запись устарела,
 * либо правило перестало отличать пак от остального дерева.
 */
interface NamedContentImport {
  readonly file: string;
  readonly reason: string;
}
const NON_PACK_IMPORTS: readonly NamedContentImport[] = [
  {
    file: 'bots.ts',
    reason:
      'профиль бота и документы его поведения (BOT-6, BOT-8) в контент-пак не входят ' +
      "и в хеш версии не попадают (NET-17) — Non-Goals change'а sec09",
  },
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Спецификатор, попавший в исходник: строка и её строка в файле. */
interface Specifier {
  readonly line: number;
  readonly text: string;
}

/** Вызов вида `import.meta.<что-то>(…)` — вход сборщика, а не обычная функция. */
function isImportMetaCall(node: ts.CallExpression): boolean {
  const target = node.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isMetaProperty(target.expression) &&
    target.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * Спецификаторы одного исходника: статических импортов, динамического `import()`
 * и шаблонов `import.meta.glob(…)`. Шаблон берётся и строкой, и списком строк:
 * `glob` принимает оба, и пачка импортов — те же импорты.
 */
function importSpecifiers(fileName: string, text: string): Specifier[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: Specifier[] = [];
  const push = (node: ts.Expression): void => {
    if (!ts.isStringLiteralLike(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ line: line + 1, text: node.text });
  };
  const pushArgument = (node: ts.Expression | undefined): void => {
    if (node === undefined) return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) push(element);
      return;
    }
    push(node);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      push(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) pushArgument(node.arguments[0]);
      else if (isImportMetaCall(node)) pushArgument(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* appSources(dir: string, rel = ''): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const relPath = rel === '' ? name : `${rel}/${name}`;
    if (statSync(join(dir, name)).isDirectory()) {
      yield* appSources(join(dir, name), relPath);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield relPath;
  }
}

/** Импорт документа контент-пака: спецификатор ведёт в `content/<dir>/`. */
function packImportOf(specifier: string): { readonly what: string } | undefined {
  for (const { dir, what } of PACK_DIRS) {
    if (specifier.includes(`content/${dir}/`)) return { what };
  }
  return undefined;
}

function scanContentImports(rootDir: string): Finding[] {
  const out: Finding[] = [];
  for (const relPath of appSources(rootDir)) {
    for (const specifier of importSpecifiers(relPath, readFileSync(join(rootDir, relPath), 'utf8'))) {
      const pack = packImportOf(specifier.text);
      if (pack === undefined) continue;
      out.push({
        file: relPath,
        line: specifier.line,
        message:
          `${pack.what} импортирован сборщиком ('${specifier.text}'): у документа контент-пака ` +
          'в приложении один источник — дерево, читаемое из раздачи (CONT-5)',
      });
    }
  }
  return out;
}

function format(findings: readonly Finding[], prefix = 'app/'): string {
  return findings.map((f) => `${prefix}${f.file}:${f.line} ${f.message}`).join('\n');
}

describe('guard: документы контент-пака в сборку страницы не запекаются (CONT-5)', () => {
  it('ни один модуль app/ не импортирует сцену или документ матча', () => {
    expect(format(scanContentImports(APP_ROOT))).toBe('');
  });

  it('сканер видит все три входа сборщика и не видит комментария', () => {
    // Статический импорт — тот самый, который этот change убрал из `match.ts`.
    const source = "import sceneJson from '../../../content/scenes/duel.scene.json';\nexport const x = sceneJson;\n";
    const found = importSpecifiers('match.ts', source).filter((s) => packImportOf(s.text) !== undefined);
    expect(found).toHaveLength(1);
    expect(packImportOf(found[0]!.text)?.what).toBe('конфиг сцены контент-пака');
    // Динамический импорт — тот же запечённый документ: сборщик кладёт его в
    // бандл ровно так же, только отдельным чанком.
    const dynamic = "export const later = () => import('../../../content/matches/duel.match.json');\n";
    expect(
      importSpecifiers('later.ts', dynamic).filter((s) => packImportOf(s.text) !== undefined),
    ).toHaveLength(1);
    // Маска `import.meta.glob` — пачка тех же импортов: один шаблон запекает в
    // бандл все сцены разом, и не увидеть его значило бы держать правило только
    // против поимённого импорта.
    const glob =
      "export const all = import.meta.glob('../../../content/scenes/*.scene.json', { eager: true });\n";
    expect(
      importSpecifiers('glob.ts', glob).filter((s) => packImportOf(s.text) !== undefined),
    ).toHaveLength(1);
    const globList =
      "export const some = import.meta.glob(['./local.json', '../../../content/matches/*.match.json']);\n";
    expect(
      importSpecifiers('globList.ts', globList).filter((s) => packImportOf(s.text) !== undefined),
    ).toHaveLength(1);
    // А путь, названный в КОММЕНТАРИИ, импортом не является — иначе половина
    // модулей сборки краснела бы за свои же шапки.
    const mentioned = '// см. content/scenes/duel.scene.json\nexport const y = 1;\n';
    expect(importSpecifiers('mentioned.ts', mentioned)).toEqual([]);
  });

  describe('на дереве с запечённым документом скан краснеет с именем модуля', () => {
    let root: string;

    beforeAll(() => {
      // Синтетическое дерево модулей, а не правка настоящего `app/`: предмет —
      // сам скан, и красный путь у него обязан быть исполнен, иначе «зелено»
      // означало бы лишь то, что искать нечего.
      root = mkdtempSync(join(tmpdir(), 'demo-content-imports-'));
      mkdirSync(join(root, 'deep'), { recursive: true });
      writeFileSync(
        join(root, 'match.ts'),
        "// документ матча читается из раздачи (CONT-5)\nimport matchJson from '../../../content/matches/duel.match.json';\nexport const doc = matchJson;\n",
      );
      writeFileSync(
        join(root, 'deep/scenes.ts'),
        "export const all = import.meta.glob('../../../../content/scenes/*.scene.json', { eager: true });\n",
      );
      // Документ дерева ВНЕ пака — законный импорт: сканер о нём молчит.
      writeFileSync(
        join(root, 'bots.ts'),
        "import profileJson from '../../../content/bots/normal.json';\nexport const profile = profileJson;\n",
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('находка называет модуль, строку и вид документа', () => {
      const report = format(scanContentImports(root), '');
      expect(report).toContain('match.ts:2 документ матча импортирован сборщиком');
      expect(report).toContain('deep/scenes.ts:1 конфиг сцены контент-пака импортирован сборщиком');
      expect(report).toContain('CONT-5');
      // Ровно две находки: документ вне пака в отчёт не попадает.
      expect(scanContentImports(root)).toHaveLength(2);
      expect(report).not.toContain('bots.ts');
    });
  });

  it('названные импорты документов дерева правилу не противоречат и не пропускаются', () => {
    const findings = scanContentImports(APP_ROOT);
    for (const named of NON_PACK_IMPORTS) {
      expect(named.reason.length, named.file).toBeGreaterThan(0);
      const source = readFileSync(join(APP_ROOT, named.file), 'utf8');
      // Запись не устарела: файл действительно импортирует документы дерева…
      const specifiers = importSpecifiers(named.file, source).map((s) => s.text);
      expect(specifiers.some((text) => text.includes('content/')), named.file).toBe(true);
      // …и ни один из них не документ контент-пака, поэтому файл не пропускается
      // сканом, а просто не даёт находок: пропуск прятал бы и настоящий импорт
      // сцены, случись он завтра в этом же модуле.
      expect(findings.filter((f) => f.file === named.file), named.file).toEqual([]);
    }
  });
});
