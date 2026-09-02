/**
 * Конфиг тестовой стадии гейта: `npm test` из корня.
 *
 * Один пул на все пакеты вместо пятнадцати последовательных стартов vitest.
 * Стартов было пятнадцать не по необходимости, а по способу запуска (`npm run
 * test --workspaces`), и платил за это не прогон тестов, а трансформация и
 * импорт модулей — пятнадцать раз с нуля. Объём проверок при этом не меняется
 * ни на файл: список проектов — весь workspace (`vitest.projects.ts`), и каждый
 * проект разворачивается в своём каталоге, как при попакетном прогоне.
 *
 * Попакетный прогон не меняется: `npm test -w @fluxus/demo` по-прежнему
 * запускает `vitest run` в папке пакета без всякого конфига. Имя этого файла
 * неканоническое именно ради этого — обоснование в `vitest.projects.ts`.
 */
import { defineConfig } from 'vitest/config';
import { GATE_PROJECT_DIRS, projectPaths } from './vitest.projects.ts';

export default defineConfig({
  test: { projects: projectPaths(GATE_PROJECT_DIRS) },
});
