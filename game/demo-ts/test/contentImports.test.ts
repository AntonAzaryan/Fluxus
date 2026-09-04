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
 * модулей сборки, а комментарий импортом не является. Ловится спецификатор
 * `import`/`export ... from` и динамического `import()` — то есть ровно то, что
 * сборщик кладёт в бандл.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
 * Названные исключения: модуль, которому импорт документа дерева разрешён, и
 * причина. Профили и документы поведения ботов (BOT-6, BOT-8) в контент-пак не
 * входят и хеш версии не двигают (NET-17) — их доставка отдельный вопрос без
 * сегодняшнего симптома (Non-Goals дизайна change'а). Никакого документа
 * контент-пака `bots.ts` при этом не импортирует: его освобождает не файл, а
 * пара «файл + правило», и правило здесь ровно про `scenes/` и `matches/`.
 */
interface ImportException {
  readonly file: string;
  readonly reason: string;
}
const EXCEPTIONS: readonly ImportException[] = [
  {
    file: 'bots.ts',
    reason:
      'профиль бота и документы его поведения (BOT-6, BOT-8) в контент-пак не входят ' +
      'и в хеш версии не попадают (NET-17) — Non-Goals change\'а sec09',
  },
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Спецификаторы импортов одного исходника: статических и динамических. */
function importSpecifiers(fileName: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: { line: number; text: string }[] = [];
  const push = (node: ts.Expression): void => {
    if (!ts.isStringLiteralLike(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ line: line + 1, text: node.text });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      push(node.moduleSpecifier);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined
    ) {
      push(node.arguments[0]);
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
    if (EXCEPTIONS.some((exception) => exception.file === relPath)) continue;
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

function format(findings: readonly Finding[]): string {
  return findings.map((f) => `app/${f.file}:${f.line} ${f.message}`).join('\n');
}

describe('guard: документы контент-пака в сборку страницы не запекаются (CONT-5)', () => {
  it('ни один модуль app/ не импортирует сцену или документ матча', () => {
    expect(format(scanContentImports(APP_ROOT))).toBe('');
  });

  it('сканер называет модуль и вид документа: вернувшийся импорт краснит', () => {
    // Контроль самого правила: без него «зелено» означало бы лишь то, что скан
    // ничего не ищет. Исходник синтетический — тот самый импорт, который этот
    // change убрал из `match.ts`.
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
    // А путь, названный в КОММЕНТАРИИ, импортом не является — иначе половина
    // модулей сборки краснела бы за свои же шапки.
    const mentioned = "// см. content/scenes/duel.scene.json\nexport const y = 1;\n";
    expect(importSpecifiers('mentioned.ts', mentioned)).toEqual([]);
  });

  it('каждое исключение названо причиной и живёт на диске', () => {
    for (const exception of EXCEPTIONS) {
      expect(exception.reason.length, exception.file).toBeGreaterThan(0);
      expect(() => statSync(join(APP_ROOT, exception.file)), exception.file).not.toThrow();
    }
  });
});
