#!/usr/bin/env node
/**
 * CLI поверх ядра (CLI-1): `node bin/sim.mjs <scenario.json>` печатает в stdout
 * потиковые снапшоты (CLI-3). Ни рендера, ни сети — только ядро.
 *
 * Трейс (CLI-7) включается флагом `--trace=<off|systems|full>` и идёт в stderr
 * либо в файл из `--trace-out=<path>`. В stdout он не попадает никогда: документ
 * CLI-3 сверяется побитово (CLI-5), и строка трейса в нём покрасила бы все
 * эталоны разом.
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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

const TRACE_LEVELS = ['off', 'systems', 'full'];

const args = process.argv.slice(2);
let file;
let trace = 'off';
let traceOut;

for (const arg of args) {
  if (arg.startsWith('--trace-out=')) traceOut = arg.slice('--trace-out='.length);
  else if (arg.startsWith('--trace=')) trace = arg.slice('--trace='.length);
  else if (arg === '--trace') trace = 'full';
  else file = arg;
}

if (file === undefined || !TRACE_LEVELS.includes(trace)) {
  process.stderr.write(
    'usage: node bin/sim.mjs <scenario.json> [--trace=off|systems|full] [--trace-out=<path>]\n',
  );
  process.exit(2);
}

const { runScenarioBytes } = await import('../src/sim/scenario.ts');
const { createJsonlSink } = await import('../src/sim/trace.ts');

let diagnostics;
if (trace !== 'off') {
  if (traceOut !== undefined) {
    // Файл создаётся пустым заранее: дописывание в остаток прошлого прогона
    // склеило бы два трейса, которые сравнивают построчно (DIAG-6).
    writeFileSync(traceOut, '');
    diagnostics = createJsonlSink(trace, (line) => appendFileSync(traceOut, line));
  } else {
    diagnostics = createJsonlSink(trace, (line) => process.stderr.write(line));
  }
}

// Документ CLI-3 в stdout пишется ПОСЛЕ прогона, трейс — по ходу. Прогон,
// оборванный жёсткой границей, оставляет трейс на диске, а stdout пустым.
process.stdout.write(runScenarioBytes(JSON.parse(readFileSync(file, 'utf8')), diagnostics));
