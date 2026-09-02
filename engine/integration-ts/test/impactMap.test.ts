/**
 * Сторож полноты карты влияния — scripts/impact.mjs (change gate-impact-mapping).
 *
 * Карта — данные, и устареть она может молча: новый пакет workspace, новый
 * корень дерева, новый тест, читающий чужое дерево с диска. Любое из трёх сузило
 * бы выборку без единого красного теста, поэтому проверяется всё три в обычном
 * прогоне тестов — тем же способом, каким guard-проверки CLI-8 держат честными
 * свои списки.
 *
 * Скан путей — по AST, а не grep'ом (машинерия engine/tests/guard/scanner.ts):
 * путь, названный в комментарии, ссылкой не является, и краснить на нём сторож
 * не вправе. Переаппроксимация здесь безопасна в одну сторону: лишнее ребро
 * стоит лишнего прогона, пропущенное — пропущенного регресса.
 *
 * Известная граница метода, названная прямо: проверяется СТРОКОВЫЙ ЛИТЕРАЛ
 * пути, а не поток данных. Путь, собранный из отдельных сегментов
 * (`join(REPO, 'game', 'demo-ts')`) или из шаблона с подстановкой, единым
 * литералом не является и сторожу не виден — анализа потока данных здесь нет и
 * не предполагается. Требование нормирует именно литерал; цена промаха та же,
 * что у дыры в карте, — лишний полный прогон, а не пропущенный регресс.
 *
 * ID требований change'а не цитируются намеренно: до архивации дельты
 * `spec-graph check` посчитал бы такую цитату висячей ссылкой.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectStringLiteralsInDir, type SourceLiteral } from '../../tests/guard/scanner.js';
import { classify, closure, TEST_EDGES, trackedPaths } from '../../../scripts/impact.mjs';
import { loadWorkspaces, type WorkspacePackage } from '../../../scripts/workspaces.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKSPACES = loadWorkspaces();

/**
 * Каталоги пакета, где живут пути в чужие деревья, и чем в каждом считать
 * исходник. Требование называет тесты и бины; профили приложений
 * десктоп-контейнера (`apps/*.app.json`) добавлены сверх него намеренно — это
 * ТЕ ЖЕ чужие пути, и читает их рантайм, а не тест, поэтому новый профиль,
 * указавший на новый пакет, обязан краснеть так же. Переаппроксимация
 * безопасна. `.json` берётся только там: в `test/` он принёс бы фикстуры.
 */
const SCANNED_SUBDIRS: readonly { readonly name: string; readonly exts?: readonly string[] }[] = [
  { name: 'test' },
  { name: 'bin' },
  { name: 'apps', exts: ['.json'] },
];

/**
 * Литерал, адресующий дерево репозитория: начинается с кодового корня, возможно
 * через `./` или сколько угодно `../`. Именно «начинается» — путь в середине
 * текста сообщения об ошибке чтением не является, а перечислять такие тексты
 * исключениями значило бы держать список прозы.
 */
const CROSS_TREE = /^(\.\.?\/)*(engine|editor|game|tools|desktop)\/[A-Za-z0-9_.-]+/;
/** Тот же префикс, снимаемый перед поиском адресуемого дерева. */
const RELATIVE_PREFIX = /^(\.\.?\/)+/;

/**
 * Точечные исключения: литерал, который путём не является (например, ожидаемый
 * текст сообщения, начинающийся с имени каталога). Причина обязательна — по
 * образцу GuardException.
 */
interface LiteralException {
  readonly file: string;
  readonly literal: string;
  readonly reason: string;
}
const LITERAL_EXCEPTIONS: readonly LiteralException[] = [];

interface Finding {
  readonly where: string;
  readonly message: string;
}

/** Корни, ни один путь которых не назван правилом карты: fail-closed молчалив, сторож — нет. */
function unnamedRoots(paths: readonly string[], workspaces: readonly WorkspacePackage[]): string[] {
  const unnamed = new Map<string, string>();
  for (const path of paths) {
    if (classify(path, workspaces).rule !== 'unknown') continue;
    const root = path.split('/')[0] ?? path;
    if (!unnamed.has(root)) unnamed.set(root, path);
  }
  return [...unnamed.entries()].map(([root, example]) => `${root} (например, ${example})`);
}

/**
 * Проверка одного литерала: пакет, в чьём тесте или бине он написан, обязан
 * попадать в выборку от правки дерева, которое литерал адресует.
 *
 * Три законных случая: своё дерево; дерево, не принадлежащее никакому пакету
 * (широкие ворота или fail-closed — правка там даёт полный гейт); чужой пакет,
 * от правки которого читающий выбирается замыканием карты.
 */
function literalFinding(
  pkg: WorkspacePackage,
  subdir: string,
  literal: SourceLiteral,
  workspaces: readonly WorkspacePackage[],
): Finding | null {
  if (!CROSS_TREE.test(literal.text)) return null;
  const where = `${pkg.dir}/${subdir}/${literal.file}:${literal.line}`;
  if (LITERAL_EXCEPTIONS.some((e) => where.startsWith(e.file) && e.literal === literal.text)) return null;

  const target = literal.text.replace(RELATIVE_PREFIX, '');
  const owner = workspaces.find((w) => target === w.dir || target.startsWith(`${w.dir}/`));
  if (owner === undefined) {
    return classify(target, workspaces).kind === 'full'
      ? null
      : { where, message: `путь «${literal.text}» не даёт полного гейта и не принадлежит пакету` };
  }
  if (owner.dir === pkg.dir) return null;
  if (closure([owner.dir], workspaces).has(pkg.dir)) return null;
  return {
    where,
    message:
      `путь «${literal.text}» ведёт в дерево ${owner.dir}, но правка ${owner.dir} этот пакет не выбирает: ` +
      'объявите тест-ребро в TEST_EDGES (scripts/impact.mjs) или зависимость в манифесте',
  };
}

/** Все находки скана литералов по дереву репозитория. */
function scanLiterals(workspaces: readonly WorkspacePackage[]): { findings: Finding[]; scanned: number } {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const pkg of workspaces) {
    for (const subdir of SCANNED_SUBDIRS) {
      const dir = join(REPO_ROOT, pkg.dir, subdir.name);
      if (!existsSync(dir)) continue;
      const literals =
        subdir.exts === undefined ? collectStringLiteralsInDir(dir) : collectStringLiteralsInDir(dir, subdir.exts);
      for (const literal of literals) {
        if (CROSS_TREE.test(literal.text)) scanned += 1;
        const finding = literalFinding(pkg, subdir.name, literal, workspaces);
        if (finding !== null) findings.push(finding);
      }
    }
  }
  return { findings, scanned };
}

const format = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.where} ${f.message}`).join('\n');

describe('полнота карты влияния: пакеты и корни дерева', () => {
  it('каждый пакет корневого манифеста известен карте', () => {
    for (const pkg of WORKSPACES) {
      const found = classify(`${pkg.dir}/src/index.ts`, WORKSPACES);
      expect(found.kind, pkg.dir).toBe('pkg');
      expect(found.pkg, pkg.dir).toBe(pkg.dir);
    }
  });

  it('каждый отслеживаемый корень дерева подходит под правило карты', () => {
    expect(unnamedRoots(trackedPaths(), WORKSPACES)).toEqual([]);
  });

  it('корень, не подошедший ни под одно правило, назван по имени', () => {
    // Тот же предикат на пути в вымышленном корне: сторож обязан назвать корень,
    // а не молча расширить выборку до полной.
    expect(unnamedRoots(['warehouse/crate/box.ts'], WORKSPACES)).toEqual([
      'warehouse (например, warehouse/crate/box.ts)',
    ]);
  });
});

describe('полнота карты влияния: чтения чужих деревьев в тестах и бинах', () => {
  const { findings, scanned } = scanLiterals(WORKSPACES);

  it('ни один путь-литерал чужого дерева не остался вне карты', () => {
    expect(format(findings)).toBe('');
  });

  it('скан не выродился: литералы путей на дереве действительно находятся', () => {
    // Порог с запасом — от вырождения сканера (сменился API AST, каталог не
    // тот), а не от роста дерева: сегодняшних литералов заметно больше.
    expect(scanned).toBeGreaterThan(20);
  });

  it('литерал чужого дерева мимо карты краснеет с файлом и строкой', () => {
    const hud = WORKSPACES.find((w) => w.dir === 'engine/hud-ts');
    expect(hud).toBeDefined();
    const literal: SourceLiteral = { file: 'demoStand.test.ts', line: 42, text: 'game/demo-ts/bin/demo-serve.mjs' };
    const finding = literalFinding(hud!, 'test', literal, WORKSPACES);
    expect(finding?.where).toBe('engine/hud-ts/test/demoStand.test.ts:42');
    expect(finding?.message).toContain('game/demo-ts');
    expect(finding?.message).toContain('TEST_EDGES');
  });

  it('объявленное тест-ребро снимает находку у читающего пакета', () => {
    const desktop = WORKSPACES.find((w) => w.dir === 'desktop/shell-ts');
    const literal: SourceLiteral = { file: 'apps.test.ts', line: 1, text: 'game/demo-ts/bin/demo-serve.mjs' };
    expect(literalFinding(desktop!, 'test', literal, WORKSPACES)).toBeNull();
    expect(TEST_EDGES['desktop/shell-ts']).toContain('game/demo-ts');
  });

  it('исключения скана точечные и с причиной', () => {
    for (const exception of LITERAL_EXCEPTIONS) {
      expect(exception.reason.length, exception.file).toBeGreaterThan(10);
    }
  });
});
