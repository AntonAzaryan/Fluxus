/**
 * Трейс авторитетного матча (DIAG-8): sink диагностики плюс приёмник отметок
 * ветви истории (DIAG-9) — одним объектом.
 *
 * Одним, а не двумя полями конфига, потому что обе половины пишут одним и тем
 * же `write`: порядок строк в файле тогда естественный — отметка стоит ровно
 * перед записями тика, к которому относится. Разведи их по разным приёмникам —
 * и порядок стал бы свойством того, кто их склеивает.
 *
 * Ввода-вывода здесь нет ровно так же, как в ядре (DIAG-1): запись строки —
 * инъектируемая функция, а куда она пишет — файл, буфер теста или stderr —
 * решает хост. Сервер матча от подключения трейса ввода-вывода не приобретает
 * (NTR-3): он лишь передаёт sink в сборку мира и зовёт `mark`.
 */
import { traceLine, type DiagnosticRecord, type DiagnosticsSink, type TraceLevel } from '@game-mvp/core';

/** Вид отметки ветви (DIAG-9): границы, которые знает только сервер матча. */
export type MatchTraceMarkKind = 'live' | 'replayBegin' | 'replayEnd';

/**
 * Отметка ветви истории. Данных окружения в ней нет — ни отметки реального
 * времени, ни идентификатора процесса (DIAG-9): два прогона одной записи
 * обязаны сравниваться посимвольно.
 */
export interface MatchTraceMark {
  readonly mark: MatchTraceMarkKind;
  /** Эпоха матча (NTR-16). В ядре её нет и быть не может (DI-6) — поэтому она здесь. */
  readonly epoch: number;
  readonly tick: number;
}

/**
 * Отбор записей (DIAG-9) — чистая функция от записи, а не четвёртый уровень
 * детализации: уровень входит в определение воспроизводимости (DIAG-6) и в
 * матрицу кросс-языковой сверки (CLI-6).
 */
export type TraceSelect = (entry: DiagnosticRecord) => boolean;

export interface MatchTrace {
  /** То, что уезжает в сборку мира матча (DI-5). */
  readonly sink: DiagnosticsSink;
  /** Отметку ставит сервер — единственный, кто знает границы ветвей (DIAG-9). */
  mark(mark: MatchTraceMark): void;
  /**
   * Первая ошибка записи; `undefined` — трейс писался целиком. Отказ записи
   * гасит трейс, а не матч (DIAG-8), и называется он отчётом прогона: бросить
   * наружу нельзя — исключение из sink'а объявлено дефектом хоста (DIAG-4), и
   * полный диск убивал бы матч.
   */
  readonly failure: string | undefined;
}

/**
 * Запись о нарушенном инварианте (FP-4). Отбор её не выбрасывает никогда
 * (DIAG-9): DIAG-3 уже вывела такие записи из-под регулятора объёма, и sink,
 * глушащий сигнал о дефекте ради размера файла, отменял бы это решение задним
 * числом.
 */
function isInvariantRecord(entry: DiagnosticRecord): boolean {
  return entry.kind === 'invariant' || entry.kind === 'assert';
}

/**
 * Отметка каноническим JSON — ТЕМ ЖЕ сериализатором, которым ядро пишет свою
 * запись (`traceLine` — это канонический JSON под доменным именем, SER-6).
 * Второй канон рядом разъехался бы с первым на первой же правке, а строки обоих
 * видов лежат в одном файле и сравниваются посимвольно (DIAG-9). Приведение
 * типа здесь и означает «сериализуй как запись»: отметка — такой же плоский
 * набор скаляров, а её отличие от записи держит поле-признак `mark`.
 */
function markLine(mark: MatchTraceMark): string {
  return traceLine(mark as unknown as DiagnosticRecord);
}

export function createMatchTrace(
  trace: TraceLevel,
  select: TraceSelect | undefined,
  write: (line: string) => void,
): MatchTrace {
  let failure: string | undefined;

  const emit = (line: string): void => {
    if (failure !== undefined) return;
    try {
      write(line);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
  };

  return {
    sink: {
      trace,
      record(entry) {
        if (select !== undefined && !select(entry) && !isInvariantRecord(entry)) return;
        emit(`${traceLine(entry)}\n`);
      },
    },
    mark(mark) {
      // Отметка — отдельная строка со своим полем-признаком `mark`, по которому
      // читатель отличает её от записи DIAG-2, не разбирая содержимого.
      // Отбросив отметки, получаем ровно тот файл, который даёт реплей записи, —
      // на этом стоит проверка парности (DIAG-9).
      emit(`${markLine(mark)}\n`);
    },
    get failure() {
      return failure;
    },
  };
}
