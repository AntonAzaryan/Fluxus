/**
 * Точка входа контейнера: `electron src/electron/entry.mjs --app <манифест>`.
 *
 * Шага сборки нет — по той же причине и тем же приёмом, что у CLI ядра
 * (`engine/core-ts/bin/sim.mjs`) и импортёра конвейера
 * (`tools/blender-ts/bin/import.mjs`): типы Node стрипает сам (>=22.18), а хук
 * резолва добавляет единственное, чего ему не хватает, — исходники импортируют
 * `./x.js`, и это `./x.ts`. Альтернатива — компилировать пакет в dist перед
 * каждым запуском контейнера — стоила бы шага сборки там, где его нигде больше
 * в репозитории нет.
 *
 * Цена та же, что у ядра: strip-only режим удаляет типы, но ничего не
 * порождает, поэтому в слоях `bridge/` и `host/` нет ни enum, ни namespace, ни
 * parameter properties.
 *
 * Отказ загрузки называется, а не проглатывается: контейнер, молча не
 * стартовавший в незнакомой сборке Electron, — худший из возможных отказов.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Настоящего .ts нет — резолвим как просили.
      }
    }
    return next(specifier, context);
  },
});

try {
  await import('./main.ts');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[desktop-shell] главный процесс не загрузился: ${reason}\n` +
      '[desktop-shell] если сборка Electron не стрипает типы, соберите пакет в JS и укажите собранный main\n',
  );
  process.exit(1);
}
