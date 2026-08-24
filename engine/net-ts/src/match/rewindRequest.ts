/**
 * Событие-запрос перемотки (REW-12): конвенция ХОСТА мира, а не ядра.
 *
 * Ульту отката инициирует геймплейная система в evaluator (WSM-5): она гейтит
 * cooldown и стоимость и эмитит обычное событие шины с политикой в payload.
 * Ядро это событие не интерпретирует — `tick()` машину состояний мира по
 * событию не двигает (TICK-3), — а хост читает его из `TickResult` ПОСЛЕ тика и
 * проводит переходы сам (`MatchServer` в матче, `WorkerShell` в локальном
 * режиме, `client-shell` SHELL-6).
 *
 * Имя намеренно вынесено из пространства доменных фактов контента (`Killed`,
 * `ShieldCast`): служебное событие протокола хоста, а не факт мира, и знака `$`
 * с косой чертой в именах сцены нет ни у одного. Коллизия с контентом поэтому
 * не «маловероятна», а невозможна по конвенции.
 *
 * Payload — это балансная политика, приезжающая из контента: инициатор и
 * глубина автостопа в тиках. Ни одного числа хост от себя не добавляет (WSM-5).
 */
import type { EntityId, GameEvent } from '@fluxus/core';

/** Тип служебного события-запроса на шине тика. */
export const REWIND_REQUEST_EVENT = '$rewind/request';

/** Разобранный запрос перемотки. */
export interface RewindRequest {
  /** Сущность-инициатор: хост сопоставляет ей слот игрока, ведущего скраб. */
  readonly initiator: EntityId;
  /** Глубина автостопа в тиках — политика контента (REW-1: ориентир 420). */
  readonly depthTicks: number;
}

/** Диагностика запроса, который хост не исполнил; по умолчанию — в консоль. */
export type RewindRequestWarn = (message: string) => void;

/**
 * Умолчание канала: строка в консоль. Экспортируется, потому что тот же канал
 * нужен хосту для СВОЕЙ диагностики — запроса, который матч не может исполнить
 * структурно (`MatchServer.drainRewindRequest`), — а второе умолчание рядом с
 * первым и есть способ им разойтись.
 */
export const warnToConsole: RewindRequestWarn = (message) => { console.warn(message); };

/**
 * Первый ГОДНЫЙ запрос тика, если он есть. Первый, а не все: в `Rewinding` мир
 * входит один раз, и второй запрос того же тика исполнять некуда (REW-8).
 *
 * Испорченный payload — предупреждение и пропуск, а не исключение. Событие
 * приезжает из КОНТЕНТА: имя ему даёт JSON-система ульты, а `depthTicks` —
 * произвольное выражение DSL, из которого дробное число получается тривиально.
 * Брошенное отсюда исключение вылетело бы из `advance()`/`stepTick()` — то есть
 * матч умирал бы от опечатки в сцене, а по тому же доводу, по которому запрос в
 * матче без истории игнорируется, умирать ему нельзя. Полей проверяется три
 * вещи: обязательность, целочисленность (`seekTo` дробный тик не принимает) и
 * неотрицательность глубины.
 *
 * Молчания при этом нет: тихо принятое умолчание («глубина 0») выглядело бы как
 * сработавшая ульта, не отматывающая мир, — дефект, который автор контента ищет
 * глазами вместо того, чтобы прочитать.
 */
export function firstRewindRequest(
  events: Iterable<GameEvent>,
  warn: RewindRequestWarn = warnToConsole,
): RewindRequest | undefined {
  for (const event of events) {
    if (event.type !== REWIND_REQUEST_EVENT) continue;
    const initiator = event.data.initiator;
    const depthTicks = event.data.depthTicks;
    if (initiator === undefined || !Number.isInteger(initiator)) {
      warn(
        `${REWIND_REQUEST_EVENT}: "initiator" — целое EntityId, а в payload ${String(initiator)}; запрос игнорирован (REW-12)`,
      );
      continue;
    }
    if (depthTicks === undefined || !Number.isInteger(depthTicks) || depthTicks < 0) {
      warn(
        `${REWIND_REQUEST_EVENT}: "depthTicks" — целое ≥ 0 (глубина в тиках), а в payload ${String(depthTicks)}; запрос игнорирован (REW-12)`,
      );
      continue;
    }
    return { initiator, depthTicks };
  }
  return undefined;
}
