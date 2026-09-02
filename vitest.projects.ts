/**
 * Список проектов корневых прогонов vitest — один на два конфига.
 *
 * Корневых прогонов два и они отличаются ровно одним: гейт гоняет тесты всех
 * пакетов (`vitest.gate.config.ts`), сводное покрытие — тех же пакетов без
 * десктоп-контейнера (`vitest.coverage.config.ts`, DSK-6). Список пакетов у них
 * общий, потому что разъехавшись он молча вывел бы пакет из-под одного из
 * прогонов: пакет, добавленный в покрытие и забытый в гейте, выглядел бы
 * проверенным.
 *
 * Имена обоих конфигов неканоничны намеренно (`*.gate.*`, `*.coverage.*`):
 * vitest ищет `vitest.config.*` вверх по дереву, и корневой файл с обычным
 * именем перехватил бы каждый попакетный прогон (`npm test -w @fluxus/demo`),
 * пытаясь развернуть проекты относительно папки пакета. Этот файл конфигом не
 * является вовсе — он только данные для тех двух.
 *
 * Имя проекта в прогоне — имя пакета из его манифеста (`@fluxus/core`): им
 * фильтрует `--project`, и им же пользуется выборочный прогон гейта.
 */
import { fileURLToPath } from 'node:url';

/** Пути от файла, а не от cwd: конфиг задаётся флагом и не обязан совпадать с корнем процесса. */
const root = fileURLToPath(new URL('.', import.meta.url));

/** Пакеты, чьи тесты держит гейт: весь workspace, включая десктоп-контейнер. */
export const GATE_PROJECT_DIRS = [
  'engine/core-ts',
  'engine/net-ts',
  'engine/render-ts',
  'engine/assets-ts',
  'engine/client-ts',
  'engine/hud-ts',
  'engine/bot-ts',
  'engine/integration-ts',
  'editor/core-ts',
  'editor/ui-ts',
  'tools/blender-ts',
  'game/demo-ts',
  'game/server-agent-ts',
  'game/server-manager-ts',
  'desktop/shell-ts',
] as const;

/**
 * Охват сводного покрытия — те же проекты без десктоп-контейнера: Electron
 * стоит вне гейта (DSK-6), и мерить его сводным прогоном значило бы показывать
 * ноль. Тесты контейнера при этом гоняются — просто не в отчёте о покрытии.
 */
export const COVERAGE_PROJECT_DIRS = GATE_PROJECT_DIRS.filter((dir) => dir !== 'desktop/shell-ts');

/** Каталоги проектов абсолютными путями — в таком виде их ждёт `test.projects`. */
export function projectPaths(dirs: readonly string[]): string[] {
  return dirs.map((dir) => root + dir);
}
