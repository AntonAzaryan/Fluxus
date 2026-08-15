/**
 * Хук резолва для запускалок: исходники импортируют './x.js', а рядом лежит
 * './x.ts'. Шага сборки нет по той же причине, что у `core-ts/bin/sim.mjs`:
 * типы Node стрипает сам (>=22.18), и хук добавляет единственное, чего ему не
 * хватает.
 *
 * Отдельным модулем, потому что регистрация действует на ПОТОК: воркер бота
 * поднимается своим `worker_threads.Worker`, хуков главного потока не наследует
 * и обязан зарегистрировать тот же самый — импортом этого файла, а не второй
 * копией кода.
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
