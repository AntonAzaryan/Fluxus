/**
 * Guard границы инструментов авторинга (`blender-pipeline` BLND-7, BLND-12):
 * рантайм — клиент, сервер, воркеры — импортёра не зовёт и за источниками не
 * следит, а пакеты движка о конвейере не знают вовсе.
 *
 * ## Кого запрет касается, а кого нет
 *
 * BLND-7 запрещает зависимость от BLENDER — «ни рантаймной, ни тестовой», — и
 * держится он на том, что гейт `npm run check` проходит без установленного
 * Blender. Пакет `@game-mvp/blender-ts` этим Blender'ом НЕ является: он на
 * TypeScript, читает закоммиченные фикстуры экспорта и Blender не вызывает ни в
 * какой форме (проверка — `scanProcessLaunch` ниже и тест гейта рядом).
 *
 * Поэтому запрет здесь сужен до того, что нормирует спека:
 *
 * - **пакеты движка** — импортёра не знают: он инструмент времени авторинга, а
 *   рантайм читает документы (BLND-7, сценарий «Предложение импортировать на
 *   старте клиента»);
 * - **сборка редактора** — знает и обязана знать. BLND-5 требует, чтобы «импорт
 *   запускали командой workspace и операцией из работающего редактора» и оба
 *   пути исполняли ОДНУ зарегистрированную операцию, а BLND-2 — чтобы правка
 *   производных данных мимо импорта подсвечивалась «валидацией редактора на
 *   общих основаниях (ED-8) правилом-вкладом (ED-25)». Регистрирует вклады
 *   сборка (ED-25), и запрет ей импортировать пакет вклада означал бы, что обе
 *   клаузы не исполняет ничто. Направление зависимости при этом прежнее:
 *   `blender-ts` → `editor-core`, `editor-ui` → `blender-ts`, цикла нет.
 *
 * Список файлов сборки, которым это разрешено, — данные теста рядом: он назван
 * поимённо и с причиной, чтобы «редактор вправе» не расползлось на headless-ядро
 * редактора и на каркас интерфейса, которым знать о конвейере незачем.
 *
 * Это вопрос того, ЧТО пакет импортирует, поэтому сканируются спецификаторы
 * модулей, а не файловая раскладка (соседний `contentLocation.ts`) и не
 * значения выражений (`scanner.ts`, AST детерминизма). Комментарии вырезаются:
 * ссылка на `tools/blender-ts` в шапке модуля — объяснение, а не зависимость.
 *
 * Списки запрещённого — данные этого файла: их правка обязана попадать в дифф
 * на ревью, тот же приём, что у соседних guard'ов. Снять правило можно, но не
 * молча.
 *
 * Чего проверка не ловит: вызов инструмента через оболочку (`child_process`
 * ловится тем же списком, а строка команды в конфиге сборки — нет) и
 * зависимость, добавленную в `package.json` без единого импорта, — для второго
 * есть `scanAuthoringDependencies`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface AuthoringViolation {
  /** Путь относительно `rootDir`, разделители — прямые слэши. */
  readonly file: string;
  readonly rule: string;
  readonly message: string;
}

/** Запрещённая ссылка: по чему опознаётся и почему её здесь быть не должно. */
export interface ForbiddenReference {
  /** Подстрока спецификатора модуля либо исходного текста. */
  readonly match: string;
  readonly rule: string;
  readonly why: string;
}

export interface AuthoringScanConfig {
  /** Абсолютный путь сканируемой директории. */
  readonly rootDir: string;
  /** Запрещённые спецификаторы модулей. */
  readonly imports?: readonly ForbiddenReference[];
  /**
   * Запрещённый текст исходника: то, что импортом не является, — канал
   * оболочки (`import.meta.hot`) или глобальный API среды.
   */
  readonly text?: readonly ForbiddenReference[];
  /** Пути (файлы или директории) относительно `rootDir`, не подлежащие обходу. */
  readonly exclude?: readonly string[];
}

const CONFIG_HINT = 'конфиг: engine/tests/guard/authoringBoundary.ts';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite']);

/**
 * Инструменты авторинга конвейера. Рантайм их не зовёт: импорт — авторинг,
 * рантайм читает документы, а забытый импорт ловит валидация (BLND-2), а не
 * загрузка клиента. Сборке редактора это разрешено — см. шапку файла.
 */
export const AUTHORING_IMPORTS: readonly ForbiddenReference[] = [
  {
    match: '@game-mvp/blender-ts',
    rule: 'authoring-in-runtime',
    why: 'импортёр конвейера Blender — инструмент времени авторинга (BLND-7)',
  },
  {
    match: 'tools/blender',
    rule: 'authoring-in-runtime',
    why: 'пакет конвейера Blender мимо имени пакета — та же зависимость (BLND-7)',
  },
];

/**
 * Слежение за файлами и канал переподачи документов. Watch — часть цикла
 * BLND-12 и живёт в инструментах авторинга: клиент матча читает документы и об
 * источниках не знает (BLND-1, BLND-7, сценарий «Матчевый клиент и watch»).
 */
export const WATCH_REFERENCES: readonly ForbiddenReference[] = [
  {
    match: 'node:fs',
    rule: 'watch-in-match-client',
    why: 'слежение за файлами дерева — watch-режим конвейера, а не клиент (BLND-12)',
  },
  {
    match: 'chokidar',
    rule: 'watch-in-match-client',
    why: 'наблюдатель файловой системы в клиенте матча (BLND-12)',
  },
];

export const HOT_CHANNEL_TEXT: readonly ForbiddenReference[] = [
  {
    match: 'import.meta.hot',
    rule: 'watch-in-match-client',
    why: 'канал dev-сервера «документы обновились» — потребитель кадра редактора, не клиент (BLND-12)',
  },
];

/** Блочные и строчные комментарии. `[^:]` бережёт `https://` от вырезания. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Спецификаторы модулей файла: статический импорт, динамический и `require`. */
export function moduleSpecifiers(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const [, specifier] of text.matchAll(pattern)) if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

function inspect(
  file: string,
  relativePath: string,
  config: AuthoringScanConfig,
  out: AuthoringViolation[],
): void {
  const source = readFileSync(file, 'utf8');
  const specifiers = moduleSpecifiers(source);
  for (const forbidden of config.imports ?? []) {
    if (!specifiers.some((specifier) => specifier.includes(forbidden.match))) continue;
    out.push({
      file: relativePath,
      rule: forbidden.rule,
      message: `импорт "${forbidden.match}": ${forbidden.why} (${CONFIG_HINT})`,
    });
  }
  const text = stripComments(source);
  for (const forbidden of config.text ?? []) {
    if (!text.includes(forbidden.match)) continue;
    out.push({
      file: relativePath,
      rule: forbidden.rule,
      message: `"${forbidden.match}": ${forbidden.why} (${CONFIG_HINT})`,
    });
  }
}

function walk(
  dir: string,
  config: AuthoringScanConfig,
  excluded: ReadonlySet<string>,
  out: AuthoringViolation[],
): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const relativePath = relative(config.rootDir, full).split(sep).join('/');
    if (excluded.has(relativePath)) continue;
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      walk(full, config, excluded, out);
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.mts') && !entry.endsWith('.mjs')) continue;
    inspect(full, relativePath, config, out);
  }
}

export function scanAuthoringBoundary(config: AuthoringScanConfig): AuthoringViolation[] {
  const out: AuthoringViolation[] = [];
  walk(config.rootDir, config, new Set(config.exclude ?? []), out);
  return out;
}

/**
 * Зависимость, объявленную манифестом пакета, но ни разу не импортированную,
 * сканер импортов не увидит — а BLND-7 запрещает именно зависимость.
 */
export function scanAuthoringDependencies(
  rootDir: string,
  forbidden: readonly ForbiddenReference[] = AUTHORING_IMPORTS,
  exclude: readonly string[] = [],
): AuthoringViolation[] {
  const out: AuthoringViolation[] = [];
  const excluded = new Set(exclude);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
        visit(full);
        continue;
      }
      if (entry !== 'package.json') continue;
      if (excluded.has(relative(rootDir, full).split(sep).join('/'))) continue;
      const manifest = JSON.parse(readFileSync(full, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const rule of forbidden) {
        if (!names.some((name) => name.includes(rule.match))) continue;
        out.push({
          file: relative(rootDir, full).split(sep).join('/'),
          rule: rule.rule,
          message: `зависимость "${rule.match}": ${rule.why} (${CONFIG_HINT})`,
        });
      }
    }
  };
  visit(rootDir);
  return out;
}

/**
 * Запуск Blender откуда угодно в гейте: команда `npm`-скрипта и запуск
 * подпроцесса из кода.
 *
 * Утверждение BLND-7 «гейт `npm run check` SHALL проходить без установленного
 * Blender» на одних импортах не держится: бинарь зовут не импортом, а оболочкой,
 * и сканер спецификаторов такого вызова не видит вовсе (о чём и сказано выше).
 * Здесь проверяются оба доступных канала, и вместе они закрывают вопрос:
 *
 * 1. **Скрипты манифестов** — по слову-командой `blender` в значении скрипта.
 *    Слово, а не подстрока: `tools/blender-ts/bin/import.mjs` и
 *    `-w @game-mvp/blender-ts` — пути и имена пакетов, а не команда.
 * 2. **Запуск подпроцесса из кода** — по модулю `child_process`. Тоньше не
 *    нужно и нельзя: имя бинаря в коде собирается из чего угодно, а без
 *    подпроцесса его не запустить ни под каким именем. Гейт подпроцессов не
 *    запускает вовсе, и это утверждение о нём — сильнее и проверяемее, чем
 *    перечень имён бинарей.
 */
export const PROCESS_LAUNCH_IMPORTS: readonly ForbiddenReference[] = [
  {
    match: 'child_process',
    rule: 'blender-in-gate',
    why: 'запуск подпроцесса в пакете гейта: единственный канал, которым Blender мог бы быть позван (BLND-7)',
  },
];

/** Команда `blender` в значении скрипта — как слово, а не как часть пути. */
const BLENDER_COMMAND = /(^|[\s;&|(`])blender(\.exe)?($|[\s;&|)`])/i;

/**
 * Скрипты манифестов, зовущие Blender. Возвращает нарушения тем же видом, что
 * и остальные сканеры, — их печатает тот же `formatAuthoringViolations`.
 */
export function scanProcessLaunch(rootDir: string): AuthoringViolation[] {
  const out: AuthoringViolation[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
        visit(full);
        continue;
      }
      if (entry !== 'package.json') continue;
      const manifest = JSON.parse(readFileSync(full, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        if (!BLENDER_COMMAND.test(command)) continue;
        out.push({
          file: relative(rootDir, full).split(sep).join('/'),
          rule: 'blender-in-gate',
          message: `скрипт "${name}" зовёт Blender: гейт проходит без него (BLND-7) (${CONFIG_HINT})`,
        });
      }
    }
  };
  visit(rootDir);
  return out;
}

/** Пустая строка ⇔ нарушений нет; иначе по строке на нарушение. */
export function formatAuthoringViolations(violations: readonly AuthoringViolation[]): string {
  return violations.map((v) => `${v.file} [${v.rule}] ${v.message}`).join('\n');
}
