#!/usr/bin/env node
/**
 * Журнал боя из файла трейса (CLI-12):
 *   node bin/journal.mjs <trace.jsonl> [--dict <path>] [--format=jsonl|text] [--out <path>]
 *
 * Инструмент ОДИН на оба вида трейса — прогона сценария (CLI-7) и настоящего
 * матча (DIAG-8): формат трейса один, и второй инструмент означал бы вторую
 * реализацию разбора.
 *
 * Симуляции команда не запускает: разбор боя обязан быть возможен там, где
 * прогона уже нет, — на трейсе, приехавшем с другой машины или снятом неделю
 * назад.
 *
 * Словарь приходит путём (`--dict`). Встроенного словаря конкретной игры здесь
 * нет и быть не может: словарь описывает события контента, а знание контента в
 * пакетах движка не живёт (CONT-1). Прогон без словаря законен — журнал
 * собирается, и все факты идут с неизвестной семантикой.
 *
 * Потоки не смешиваются (CLI-12): журнал уходит в stdout либо в `--out`, а
 * отчёт о встреченных незнакомых типах — всегда в stderr. Строка отчёта внутри
 * журнала сделала бы его непригодным к автоматическому разбору ровно по
 * основанию CLI-7.
 *
 * Шага сборки нет по той же причине, что у `bin/sim.mjs`: типы Node стрипает
 * сам (>=22.18), а хук резолва добавляет единственное, чего ему не хватает.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const FORMATS = ['jsonl', 'text'];

const USAGE =
  'usage: node bin/journal.mjs <trace.jsonl> [--dict <path>] [--format=jsonl|text] [--out <path>]\n';

const {
  buildJournal,
  journalJsonl,
  journalText,
  parseJournalDictionary,
} = await import('../src/sim/journal.ts');

/**
 * Сборка журнала по путям — общая точка для CLI и для отладочного прогона
 * стенда (CLI-11): стенд кладёт журнал рядом с трейсом тем же кодом, которым
 * его собирает команда, а не второй реализацией.
 */
export function journalFromFile(tracePath, dictPath) {
  const dictionary =
    dictPath === undefined
      ? undefined
      : parseJournalDictionary(JSON.parse(readFileSync(dictPath, 'utf8')), `словарь "${dictPath}"`);
  return buildJournal(readFileSync(tracePath, 'utf8'), dictionary);
}

/** Отчёт прогона (DIAG-10, CLI-12): что инструмент встретил и чего не понял. */
export function journalReport(result) {
  let report = `журнал: ${result.entries.length} фактов\n`;
  if (result.malformedLines > 0) {
    report += `неразобранных строк трейса: ${result.malformedLines} (усечённый хвост оборванного прогона?)\n`;
  }
  if (result.unknownTypes.length > 0) {
    report +=
      `типов событий вне словаря: ${result.unknownTypes.length} — ${result.unknownTypes.join(', ')}\n` +
      'чтобы они стали фактами со своей семантикой, правится документ словаря, а не код (DIAG-10)\n';
  }
  return report;
}

function main() {
  const args = process.argv.slice(2);
  let file;
  let dict;
  let out;
  let format = 'jsonl';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg === '--dict') dict = args[++i];
    else if (arg.startsWith('--dict=')) dict = arg.slice('--dict='.length);
    else if (arg === '--out') out = args[++i];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else file = arg;
  }

  if (file === undefined || file.startsWith('--') || !FORMATS.includes(format)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const result = journalFromFile(file, dict);
  const document = format === 'text' ? journalText(result.entries) : journalJsonl(result.entries);
  if (out === undefined) process.stdout.write(document);
  else writeFileSync(out, document);

  // Отчёт — в поток, отдельный от журнала (CLI-12). Незнакомый тип отказом
  // прогона не является: он означает, что словарь отстал от контента.
  process.stderr.write(journalReport(result));
}

// Импорт этого файла как модуля (стенд демо) разбора аргументов не запускает:
// у чужого процесса свой `process.argv`, и его флаги здесь не при чём.
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) main();
