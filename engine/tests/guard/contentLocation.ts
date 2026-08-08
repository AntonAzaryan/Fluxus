/**
 * Guard границы контента (CONT-1): в пакетах движка не лежит игровой контент.
 * Это вопрос расположения файлов, а не кода, поэтому обход файловой системы,
 * а не AST — соседний `scanner.ts` смотрит в исходники TS и про JSON, MDX и
 * PNG сказать ничего не может.
 *
 * Списки — данные этого файла: что считается документом контента и какие
 * директории освобождены. Их правка обязана попадать в дифф на ревью — тот же
 * приём, что CLI-8 задаёт для инвариантов детерминизма.
 *
 * Освобождены только фикстуры движка (CONT-4): они пинают движок, а не
 * описывают игру, и переезду в дерево контента не подлежат.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ContentViolation {
  /** Путь относительно `rootDir`, разделители — прямые слэши. */
  readonly file: string;
  readonly rule: string;
  readonly message: string;
}

/** Освобождённая директория: причина обязательна, как у `GuardException`. */
export interface ContentExclusion {
  /** Путь директории относительно `rootDir`. */
  readonly dir: string;
  readonly reason: string;
}

export interface ContentScanConfig {
  /** Абсолютный путь к сканируемой директории (корень пакетов движка). */
  readonly rootDir: string;
  readonly exclude?: readonly ContentExclusion[];
}

const CONFIG_HINT = 'конфиг: engine/tests/guard/contentLocation.ts';

/** Документы контента, опознаваемые по окончанию имени. */
const CONTENT_SUFFIXES = new Map<string, string>([
  ['.scene.json', 'конфиг сцены (serialization SER-7)'],
  ['.match.json', 'конфиг матча'],
  ['.mdx', 'модель'],
  ['.png', 'текстура'],
  ['.blp', 'текстура'],
]);

/** Документы контента, опознаваемые по полному имени. */
const CONTENT_NAMES = new Map<string, string>([
  ['manifest.json', 'манифест визуалов (assets ASSET-6)'],
]);

/** Не обходятся никогда: сборочный мусор и чужие пакеты — не исходники репозитория. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite']);

/**
 * Освобождения по умолчанию (CONT-4). `*.scenario.json` и `*.golden.json` в
 * списки контента не входят вовсе — эталон прогона документом игры не является,
 * — но директория исключена явно, чтобы правило читалось без вывода.
 */
export const ENGINE_FIXTURE_EXCLUSIONS: readonly ContentExclusion[] = [
  { dir: 'tests/golden', reason: 'golden-эталоны движка (cli-testing CLI-2, CLI-6)' },
  { dir: 'assets-ts/test/fixtures', reason: 'фикстуры парсеров модуля ассетов' },
];

function classify(name: string): string | undefined {
  const byName = CONTENT_NAMES.get(name);
  if (byName !== undefined) return byName;
  for (const [suffix, kind] of CONTENT_SUFFIXES) {
    if (name.endsWith(suffix)) return kind;
  }
  return undefined;
}

/** Обход директории с отсечением освобождённых поддеревьев. */
function walk(dir: string, rootDir: string, excluded: ReadonlySet<string>, out: ContentViolation[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = relative(rootDir, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.') || excluded.has(rel)) continue;
      walk(full, rootDir, excluded, out);
      continue;
    }
    const kind = classify(entry);
    if (kind === undefined) continue;
    out.push({
      file: rel,
      rule: 'content-in-engine',
      message:
        `${kind} — игровой контент, его место в дереве контента, а не в пакете движка ` +
        `(CONT-1; ${CONFIG_HINT})`,
    });
  }
}

export function scanContentLocation(config: ContentScanConfig): ContentViolation[] {
  const excluded = new Set((config.exclude ?? []).map((e) => e.dir));
  const out: ContentViolation[] = [];
  walk(config.rootDir, config.rootDir, excluded, out);
  return out;
}

/** Пустая строка ⇔ нарушений нет; иначе по строке на нарушение — для expect(...).toBe(''). */
export function formatContentViolations(violations: readonly ContentViolation[]): string {
  return violations.map((v) => `${v.file} [${v.rule}] ${v.message}`).join('\n');
}
