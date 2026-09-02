/**
 * Инвентарь workspace: список пакетов корневого манифеста с их каталогами и
 * объявленными зависимостями внутри репозитория.
 *
 * Общий модуль двух инструментов гейта — параллельного раннера типизации
 * (`typecheck.mjs`) и выборочного прогона (`impact.mjs`): оба отвечают на один
 * вопрос «какие пакеты есть и как называются», и второй такой ответ разъехался
 * бы с первым. Источник правды — сами манифесты, а не список в коде: новый
 * пакет workspace попадает сюда добавлением в корневой `package.json`.
 *
 * Stateless и без кэша, по образцу spec-graph.mjs: чтение пятнадцати манифестов
 * стоит миллисекунды.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Префикс пакетов репозитория: по нему зависимость отличается от внешней. */
const SCOPE = '@fluxus/';

/**
 * Пакеты workspace: `{ dir, name, deps }`, где `dir` — путь от корня репозитория
 * (`engine/core-ts`), `name` — имя из манифеста (`@fluxus/core`, оно же имя
 * проекта vitest), `deps` — имена пакетов репозитория из всех трёх секций
 * зависимостей.
 */
export function loadWorkspaces(repoRoot = REPO_ROOT) {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return (root.workspaces ?? []).map((dir) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    return {
      dir,
      name: manifest.name,
      deps: Object.keys(declared)
        .filter((d) => d.startsWith(SCOPE))
        .sort(),
    };
  });
}

/**
 * Разрешает аргументы командной строки в каталоги пакетов: принимает и имя
 * (`@fluxus/core`), и путь (`engine/core-ts`) — разработчик набирает то, что у
 * него под рукой, а не то, что удобно скрипту. Неизвестное имя — ошибка с
 * перечнем известных: молча пропущенный пакет означал бы непроверенный пакет.
 */
export function resolveSelectors(selectors, workspaces) {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const out = [];
  const unknown = [];
  for (const raw of selectors) {
    const key = raw.replace(/\/+$/, '');
    const found = byName.get(key) ?? byDir.get(key);
    if (found === undefined) unknown.push(raw);
    else if (!out.includes(found)) out.push(found);
  }
  if (unknown.length > 0) {
    const known = workspaces.map((w) => `${w.name} (${w.dir})`).join('\n  ');
    throw new Error(`неизвестные пакеты: ${unknown.join(', ')}\nизвестны:\n  ${known}`);
  }
  return out;
}
