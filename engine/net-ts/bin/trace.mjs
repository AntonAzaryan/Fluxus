/**
 * Флаги трейса матча для запускалок (CLI-11) — одно место на все стенды.
 *
 * Одно, потому что уровень, отбор и путь вывода принимаются «тем же образом,
 * каким их принимает CLI прогона сценария» (CLI-11): разойдись запускалки в
 * разборе флагов, и один и тот же `--trace-select` означал бы в двух стендах
 * разное. Разбор отбора берётся у ядра (`parseTraceSelect`) — там же, откуда его
 * берёт CLI прогона сценария. Здесь же живёт файловый писатель: ввод-вывод —
 * дело запускалки, а не `MatchServer` (NTR-3) и не ядра (DIAG-1).
 *
 * ## Объём (замер: отладочный прогон демо-арены, 600 тиков = 10 с, два бота)
 *
 * - `--trace=full` — ~8,9 МиБ и ~60,6 тыс. строк за прогон, то есть ~53 МиБ и
 *   ~365 тыс. строк на минуту боя;
 * - `--trace=systems` — ~5,4 МиБ за прогон, порядка 32 МиБ на минуту: поток
 *   команд отпадает, а границы систем и счётчики стоимости остаются, и это
 *   всего в ~1,7 раза дешевле полного;
 * - `--trace=full --trace-select=event` — ~76 КиБ и ~945 строк за тот же прогон
 *   (600 отметок ветви плюс ~340 событий), то есть ~460 КиБ на минуту боя: в
 *   ~120 раз меньше полного.
 *
 * Отсюда рабочий режим журнальных прогонов: полный уровень нужен ради событий
 * (они едут только там, DIAG-3), а отбор возвращает файлу читаемый размер —
 * `systems` эту задачу не решает вовсе. Четвёртым уровнем детализации отбор
 * становиться MUST NOT (DIAG-9).
 */
import { closeSync, openSync, writeSync } from 'node:fs';
// Статически — только помощник запускалок: он же ставит хук резолва
// (`tsHook.mjs`). Типизированные модули приезжают динамическим импортом ПОСЛЕ
// его установки: статический граф резолвится целиком до первой строки кода, и
// хук на него уже не влияет — тот же приём, что в `serve.mjs`.
import { flag, option } from './matchFile.mjs';

// Словарь и разбор отбора берутся у ядра — там же, где живёт CLI прогона
// сценария: «тем же образом» (CLI-11) означает ту же функцию, а не два похожих
// разбора одной строки.
const { parseTraceSelect, TRACE_LEVELS } = await import('@game-mvp/core');
const { createMatchTrace } = await import('../src/match/trace.ts');

export { parseTraceSelect };

/** Порог сброса буфера писателя: строки трейса мелкие, а их сотни тысяч. */
const FLUSH_BYTES = 64 * 1024;

export const TRACE_USAGE =
  '[--trace=off|systems|full] [--trace-select=<вид|код>,...] [--trace-out=<path>]';

/**
 * Предупреждение «трейс без записи» (CLI-11): трейс невоспроизводим в отрыве от
 * записи матча (DIAG-9) — ввод порождают боты и люди, а не seed. Текст один на
 * все запускалки: разойдись формулировки, и одно и то же положение дел читалось
 * бы в двух стендах как два разных.
 */
export const TRACE_WITHOUT_RECORD =
  'внимание: трейс снимается без записи матча — переснять его будет нечем (DIAG-9);\n';

/**
 * Писатель строк, который ловит отказ записи САМ (design Decision 10): первая
 * ошибка запоминается, дальше писатель молчит, наружу не бросает ничего.
 *
 * Не бросает, потому что исключение из sink'а объявлено дефектом хоста (DIAG-4),
 * а в debug-сборке ядро превращает его в жёсткую границу: полный диск убивал бы
 * матч. По той же причине не бросает и `close()` — сброс хвоста приходится на
 * сворачивание прогона, где исключение унесло бы с собой ВСЕ остальные
 * артефакты (CLI-11), включая сводку, в которой отказ и должен быть назван.
 *
 * Закрытие идемпотентно: закрыть трейс может и конец прогона, и сигнал
 * остановки, а второе закрытие того же дескриптора — ошибка на ровном месте.
 */
export function guardedLineWriter(write, finish) {
  let failure;
  let closed = false;
  const remember = (cause) => {
    failure ??= cause instanceof Error ? cause.message : String(cause);
  };
  return {
    get failure() {
      return failure;
    },
    write(line) {
      if (closed || failure !== undefined) return;
      try {
        write(line);
      } catch (cause) {
        remember(cause);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        finish();
      } catch (cause) {
        remember(cause);
      }
    },
  };
}

/**
 * Буферизованный писатель в файл. Файл создаётся пустым: дописывание в остаток
 * прошлого прогона склеило бы два трейса, которые сравнивают построчно (DIAG-6).
 */
export function fileLineWriter(path) {
  const fd = openSync(path, 'w');
  let buffer = '';
  const flush = () => {
    if (buffer === '') return;
    const pending = buffer;
    // Буфер очищается ДО записи: неудавшийся сброс не должен оставлять хвост,
    // который закрытие попробует дописать ещё раз и упадёт на том же месте.
    buffer = '';
    writeSync(fd, pending);
  };
  return guardedLineWriter(
    (line) => {
      buffer += line;
      if (buffer.length >= FLUSH_BYTES) flush();
    },
    // Дескриптор закрывается в любом исходе сброса: `finally`, а не вторая
    // ветка, — иначе отказ записи оставлял бы за собой открытый файл.
    () => {
      try {
        flush();
      } finally {
        closeSync(fd);
      }
    },
  );
}

/** Писатель в поток процесса: буфера нет, закрывать нечего. */
function streamLineWriter(stream) {
  return guardedLineWriter((line) => stream.write(line), () => {});
}

/**
 * Разбор флагов трейса из `process.argv`. Умолчание — выключенный трейс: с ним
 * прогон обязан быть тем же, каким был до появления отладочного режима (CLI-11).
 */
export function traceOptions(defaults = {}) {
  const level = option('trace', flag('trace') ? 'full' : (defaults.level ?? 'off'));
  if (!TRACE_LEVELS.includes(level)) {
    throw new Error(`--trace: неизвестный уровень "${level}"; известные: ${TRACE_LEVELS.join(', ')}`);
  }
  return {
    level,
    select: parseTraceSelect(option('trace-select', defaults.select)),
    out: option('trace-out', defaults.out),
  };
}

/**
 * Трейс матча по разобранным флагам; `undefined` — трейс выключен.
 *
 * Вывод по умолчанию — stderr: свой отчёт запускалки (соединения, слоты,
 * счётчики) идёт в stdout, и смешивать их нельзя (CLI-11) — артефакт со
 * строками постороннего происхождения разбирается человеком, а не программой.
 *
 * `failure` — ОДИН канал отказа записи на обе его половины: ошибку по ходу
 * матча ловит `createMatchTrace` (DIAG-4), ошибку сброса хвоста — писатель
 * (Decision 10). Сводке прогона положено называть отказ, а не гадать, в каком
 * из двух полей его искать.
 */
export function openMatchTrace(options) {
  if (options.level === 'off') return undefined;
  const writer =
    options.out === undefined ? streamLineWriter(process.stderr) : fileLineWriter(options.out);
  const trace = createMatchTrace(options.level, options.select, writer.write);
  return {
    trace,
    close: () => writer.close(),
    get failure() {
      return trace.failure ?? writer.failure;
    },
  };
}
