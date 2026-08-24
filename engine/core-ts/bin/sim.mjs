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
 * Отбор записей — `--trace-select=<вид|код>,...`, тем же словарём и с тем же
 * пропуском записей о нарушенных инвариантах (FP-4), каким его принимают
 * запускалки матча (CLI-11): трейс матча переснимается прогоном его записи
 * (DIAG-9), и «тот же отбор» обязан быть той же функцией. Разбор — общий
 * (`bin/traceSelect.mjs`), сам отбор — `selectingSink` ядра.
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
// Ради побочного действия: регистрация хука резолва (см. `tsHook.mjs`).
import './tsHook.mjs';

const TRACE_LEVELS = ['off', 'systems', 'full'];

const USAGE =
  'usage: node bin/sim.mjs <scenario.json> [--trace=off|systems|full]' +
  ' [--trace-select=<вид|код>,...] [--trace-out=<path>]\n';

const args = process.argv.slice(2);
let file;
let trace = 'off';
let traceOut;
let traceSelect;
let parseError;

/** Значение флага, взятого раздельной формой: соседний аргумент — не флаг. */
const valueAt = (index) => {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};

// Каждый флаг принимается ОБЕИМИ формами — `--k=v` и `--k v` (CLI-11): обе
// напечатаны в описании команд, и форма, которая молча превращается в путь
// сценария, — не отказ, а прогон, делающий не то, что написано в команде.
// Незнакомый флаг и лишний позиционный аргумент — отказ с кодом 2, как у
// `bin/journal.mjs`: опечатка иначе читалась бы как ENOENT либо как прогон
// без трейса, неотличимый от законного.
for (let i = 0; i < args.length && parseError === undefined; i++) {
  const arg = args[i];
  if (arg.startsWith('--trace-out=')) traceOut = arg.slice('--trace-out='.length);
  else if (arg.startsWith('--trace-select=')) traceSelect = arg.slice('--trace-select='.length);
  else if (arg.startsWith('--trace=')) trace = arg.slice('--trace='.length);
  else if (arg === '--trace-out' || arg === '--trace-select') {
    const value = valueAt(i + 1);
    if (value === undefined) parseError = `флаг ${arg} назван без значения`;
    else if (arg === '--trace-out') traceOut = value;
    else traceSelect = value;
    i++;
  } else if (arg === '--trace') {
    // Голая форма — уровень `full`; раздельная (`--trace systems`) забирает
    // соседний аргумент, как `option()` у запускалок матча (CLI-11).
    const value = valueAt(i + 1);
    if (value === undefined) trace = 'full';
    else {
      trace = value;
      i++;
    }
  } else if (arg.startsWith('--')) parseError = `неизвестный флаг ${arg}`;
  else if (file !== undefined) parseError = `лишний аргумент "${arg}": файл сценария один`;
  else file = arg;
}

if (parseError === undefined && !TRACE_LEVELS.includes(trace)) {
  parseError = `неизвестный уровень трейса "${trace}"; известные: ${TRACE_LEVELS.join(', ')}`;
}
if (parseError !== undefined) {
  process.stderr.write(`${parseError}\n${USAGE}`);
  process.exit(2);
}
if (file === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const { runScenarioBytes } = await import('../src/sim/scenario.ts');
const { createJsonlSink, parseTraceSelect, selectingSink } = await import('../src/sim/trace.ts');

let select;
try {
  select = parseTraceSelect(traceSelect);
} catch (error) {
  // Незнакомое имя отбора — отказ с кодом возврата, а не пустой трейс: файл без
  // единой строки читался бы как «в бою ничего не происходило».
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exit(2);
}

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
  // Отбор — обёртка над приёмником, та же самая, что у хоста матча (DIAG-9):
  // записи о нарушенных инвариантах (FP-4) сквозь неё проходят всегда.
  diagnostics = selectingSink(diagnostics, select);
}

// Документ CLI-3 в stdout пишется ПОСЛЕ прогона, трейс — по ходу. Прогон,
// оборванный жёсткой границей, оставляет трейс на диске, а stdout пустым.
process.stdout.write(runScenarioBytes(JSON.parse(readFileSync(file, 'utf8')), diagnostics));
