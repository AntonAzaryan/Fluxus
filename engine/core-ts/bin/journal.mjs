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
 * сам (>=22.18), а хук резолва добавляет единственное, чего ему не хватает
 * (`tsHook.mjs`, общий на обе команды).
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// Ради побочного действия: регистрация хука резолва (см. `tsHook.mjs`).
import './tsHook.mjs';

const FORMATS = ['jsonl', 'text'];

const USAGE =
  'usage: node bin/journal.mjs <trace.jsonl> [--dict=<path>] [--format=jsonl|text] [--out=<path>]\n';

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

/**
 * Документ журнала в одной из двух форм. Машинная первична (DIAG-10), и
 * собирается она каноническим сериализатором ядра: журнал, собранный стендом,
 * обязан совпадать байт-в-байт с журналом, собранным этой командой.
 */
export function journalDocument(result, format = 'jsonl') {
  return format === 'text' ? journalText(result.entries) : journalJsonl(result.entries);
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

/**
 * Разбор аргументов. Опечатка — отказ с кодом 2 и usage, как у `bin/sim.mjs`, а
 * не тихое умолчание: `--dict` без значения дал бы ПОЛНЫЙ журнал, в котором все
 * факты идут с неизвестной семантикой, — то есть результат, неотличимый от
 * законного прогона без словаря (CLI-12). Такую разницу читатель журнала не
 * заметит вовсе.
 *
 * Возвращает разобранное либо строку причины отказа.
 */
export function parseJournalArgs(args) {
  let file;
  let dict;
  let out;
  let format = 'jsonl';

  /** Значение флага, взятого раздельной формой: соседний аргумент — не флаг. */
  const valueAt = (index) => {
    const value = args[index];
    if (value === undefined || value.startsWith('--')) return undefined;
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg === '--format') {
      format = valueAt(i + 1);
      if (format === undefined) return { error: 'флаг --format назван без значения' };
      i++;
    } else if (arg === '--dict' || arg === '--out') {
      const value = valueAt(i + 1);
      if (value === undefined) return { error: `флаг ${arg} назван без значения` };
      if (arg === '--dict') dict = value;
      else out = value;
      i++;
    } else if (arg.startsWith('--dict=')) dict = arg.slice('--dict='.length);
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    // Незнакомый флаг не становится путём трейса и не пропадает молча: опечатка
    // в имени иначе читалась бы как «прогон без словаря» либо как ENOENT.
    else if (arg.startsWith('--')) return { error: `неизвестный флаг ${arg}` };
    else if (file !== undefined) return { error: `лишний аргумент "${arg}": файл трейса один` };
    else file = arg;
  }

  if (file === undefined) return { error: 'не назван файл трейса' };
  if (!FORMATS.includes(format)) {
    return { error: `неизвестная форма "${format}"; известные: ${FORMATS.join(', ')}` };
  }
  return { file, dict, out, format };
}

function main() {
  const parsed = parseJournalArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  const { file, dict, out, format } = parsed;

  const result = journalFromFile(file, dict);
  const document = journalDocument(result, format);
  if (out === undefined) process.stdout.write(document);
  else writeFileSync(out, document);

  // Отчёт — в поток, отдельный от журнала (CLI-12). Незнакомый тип отказом
  // прогона не является: он означает, что словарь отстал от контента.
  process.stderr.write(journalReport(result));
}

/**
 * Запущен ли файл КАК КОМАНДА. Импорт этого файла как модуля (стенд демо)
 * разбора аргументов не запускает: у чужого процесса свой `process.argv`, и его
 * флаги здесь не при чём.
 *
 * Сравниваются URL после разрешения симлинков, а не строки путей: `import.meta`
 * несёт уже разрешённый путь, а `process.argv[1]` — тот, что набрали в
 * командной строке. Через симлинк на каталог репозитория они не совпадают, и
 * команда молча ничего не делала бы, возвращая при этом ноль, — самый дорогой
 * вид отказа для того, кто зовёт её из скрипта.
 */
function launchedAsCommand() {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argv)).href === import.meta.url;
  } catch {
    // Пути нет на диске (`node --eval` и подобное) — командой это не является.
    return false;
  }
}

if (launchedAsCommand()) main();
