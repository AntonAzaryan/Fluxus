/**
 * Guard границы инструментов авторинга (`blender-pipeline` BLND-7, BLND-12):
 * конвейер Blender не является зависимостью пакетов движка и редактора, а
 * рантайм — клиент, сервер, воркеры — импортёра не зовёт и за источниками не
 * следит.
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
 * загрузка клиента.
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
): AuthoringViolation[] {
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

/** Пустая строка ⇔ нарушений нет; иначе по строке на нарушение. */
export function formatAuthoringViolations(violations: readonly AuthoringViolation[]): string {
  return violations.map((v) => `${v.file} [${v.rule}] ${v.message}`).join('\n');
}
