/**
 * Событие-запрос перемотки: конвенция ХОСТА мира, а не ядра.
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
import type { EntityId, GameEvent } from '@game-mvp/core';

/** Тип служебного события-запроса на шине тика. */
export const REWIND_REQUEST_EVENT = '$rewind/request';

/** Разобранный запрос перемотки. */
export interface RewindRequest {
  /** Сущность-инициатор: хост сопоставляет ей слот игрока, ведущего скраб. */
  readonly initiator: EntityId;
  /** Глубина автостопа в тиках — политика контента (REW-1: ориентир 420). */
  readonly depthTicks: number;
}

/**
 * Первый запрос тика, если он есть. Первый, а не все: в `Rewinding` мир входит
 * один раз, и второй запрос того же тика исполнять некуда (REW-8).
 *
 * Неполный payload — отказ, а не молчание: событие с таким именем эмитит
 * только система ульты, и запрос без инициатора или без глубины означает
 * дефект контента. Молча принятое умолчание («глубина 0») выглядело бы как
 * сработавшая ульта, не отматывающая мир, — то есть дефект, который автор
 * контента ищет глазами вместо того, чтобы прочитать.
 */
export function firstRewindRequest(events: Iterable<GameEvent>): RewindRequest | undefined {
  for (const event of events) {
    if (event.type !== REWIND_REQUEST_EVENT) continue;
    const initiator = event.data.initiator;
    const depthTicks = event.data.depthTicks;
    if (initiator === undefined || depthTicks === undefined) {
      throw new Error(
        `${REWIND_REQUEST_EVENT}: в payload обязаны быть "initiator" и "depthTicks" (WSM-5)`,
      );
    }
    return { initiator, depthTicks };
  }
  return undefined;
}
