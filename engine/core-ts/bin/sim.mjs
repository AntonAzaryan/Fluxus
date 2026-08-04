#!/usr/bin/env node
/**
 * CLI поверх ядра (CLI-1): `node bin/sim.mjs <scenario.json>` печатает в stdout
 * потиковые снапшоты (CLI-3). Ни рендера, ни сети — только ядро.
 *
 * Шага сборки нет: типы Node стрипает сам (>=22.18), а хук резолва добавляет
 * единственное, чего ему не хватает, — исходники импортируют './x.js', и это
 * './x.ts'. Альтернатива — компилировать ядро в dist перед каждым прогоном
 * ради инструмента, который зовут из тестов напрямую.
 *
 * Цена такого запуска — ограничение на исходники ядра: strip-only режим Node
 * удаляет типы, но ничего не порождает, поэтому в `src/` нельзя parameter
 * properties (`constructor(private readonly x: T)`), enum и namespace. Каждая
 * такая конструкция валит CLI на старте — это стерегёт `test/cli.test.ts`.
 * Флаг `--experimental-transform-types` снял бы запрет, но печатал бы
 * ExperimentalWarning в вывод при каждом прогоне, а stdout здесь сверяют
 * побайтно golden-тесты (CLI-4).
 */
import { readFileSync } from 'node:fs';
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

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: node bin/sim.mjs <scenario.json>\n');
  process.exit(2);
}

const { runScenarioBytes } = await import('../src/sim/scenario.ts');
process.stdout.write(runScenarioBytes(JSON.parse(readFileSync(file, 'utf8'))));
