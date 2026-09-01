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
  ['.presentation.json', 'парный presentation-документ сцены (presentation-scene PRES-1)'],
  ['.bots.json', 'парный документ бот-аннотаций сцены (bot-player BOT-12)'],
  ['.match.json', 'конфиг матча'],
  ['.mdx', 'модель'],
  // glTF — формат моделей контента (assets ASSET-3, ASSET-5): загрузчик его
  // зарегистрирован, и `.mdx` остаётся историческим форматом реестра
  // (blender-pipeline BLND-11). Знай сканер только `.mdx`, ровно та же модель
  // в текущем формате проезжала бы границу CONT-1 молча.
  ['.gltf', 'модель (assets ASSET-3)'],
  ['.glb', 'модель (assets ASSET-3)'],
  // Авторский источник level-дизайна и его экспорт лежат в дереве контента
  // рядом со сценой (CONT-6); внутри пакета движка им места нет тем более.
  ['.blend', 'авторский источник level-дизайна (game-content CONT-6)'],
  ['.png', 'текстура'],
  ['.blp', 'текстура'],
  // Эмиттерный ассет (assets ASSET-14) — presentation-документ дерева визуалов,
  // как и модель: его правит дизайнер эффектов, а грузит модуль ассетов.
  ['.effect.json', 'эмиттерный ассет (assets ASSET-14)'],
  // Иконка интерфейса адресуется из данных HUD asset ID дерева контента
  // (match-hud HUD-4, assets ASSET-2) — художественный ассет наравне с текстурой.
  ['.svg', 'иконка интерфейса (match-hud HUD-4, assets ASSET-2)'],
]);

/**
 * Документы контента, опознаваемые по полному имени: вид не читается ни из
 * суффикса, ни обязательно из места. Карта кривизны (`assets` ASSET-7)
 * адресуется из манифеста произвольным путём, поэтому ловится и по имени —
 * иначе её копия вне дерева визуалов (`engine/render-ts/src/arena-curvature.json`)
 * проезжала бы границу молча.
 */
const CONTENT_NAMES = new Map<string, string>([
  ['manifest.json', 'манифест визуалов (assets ASSET-6)'],
  ['arena-curvature.json', 'карта кривизны террейна (assets ASSET-7)'],
]);

/**
 * Документы контента, опознаваемые по директории: имя файла ничего о виде не
 * говорит, а место — говорит (CONT-1). Профиль бота (`bot-player` BOT-6) назван
 * уровнем сложности (`easy.json`), скины и прочие документы дерева визуалов —
 * своим назначением, и по суффиксу их не отличить от любого JSON. Место здесь
 * второй признак, а не единственный: вид, у которого имя устойчиво (манифест,
 * карта кривизны), ловится ещё и по имени — см. `CONTENT_NAMES`.
 *
 * Имя директории ищется на ЛЮБОМ уровне пути, а не только у непосредственного
 * родителя: документы поведения ботов лежат в `bots/behaviors/`, и проверка
 * только родителя оставляла бы их за границей — ровно тот вид, ради которого
 * правило по месту и заведено.
 */
const CONTENT_DIRS = new Map<string, string>([
  ['bots', 'документ ботов — профиль или поведение (bot-player BOT-6, BOT-8)'],
  ['visuals', 'presentation-документ дерева визуалов (assets ASSET-2, game-content CONT-2)'],
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
  {
    dir: 'assets-ts/test/fixtures',
    reason: 'эталонные фикстуры парсеров ассетов (game-content CONT-4)',
  },
  {
    dir: 'render-ts/test/fixtures',
    reason: 'эталонные фикстуры потребителя эмиттерных ассетов (game-content CONT-4)',
  },
];

/**
 * Вид документа по имени и по месту. `dirs` — сегменты пути от корня скана до
 * файла: имя директории ищется на любом уровне (см. `CONTENT_DIRS`), поэтому
 * передаётся весь путь, а не один родитель.
 */
function classify(name: string, dirs: readonly string[]): string | undefined {
  const byName = CONTENT_NAMES.get(name);
  if (byName !== undefined) return byName;
  for (const [suffix, kind] of CONTENT_SUFFIXES) {
    if (name.endsWith(suffix)) return kind;
  }
  if (!name.endsWith('.json')) return undefined;
  for (const dir of dirs) {
    const byDir = CONTENT_DIRS.get(dir);
    if (byDir !== undefined) return byDir;
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
    // Сегменты пути ОТ КОРНЯ СКАНА: имя контентной директории ищется на любом
    // уровне (`bots/behaviors/classic.json` — документ ботов), а директории над
    // корнем к делу не относятся вовсе.
    const kind = classify(entry, relative(rootDir, dir).split(sep));
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
