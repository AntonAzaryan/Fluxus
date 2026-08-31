/**
 * Эхо собственного `seq` из своего снапшота (NTR-11).
 *
 * Дополнительного сообщения этой величине не нужно и не будет: `seq` пришедшего
 * кадра кладёт в компонент ввода `InputSystem` (TICK-4), а своя сущность в
 * собственном снапшоте присутствует всегда (NET-15). Значит, «какой мой кадр
 * сервер применил последним» возвращается само.
 *
 * Отдельным модулем — потому что потребителей у одного наблюдения два, и они не
 * про одно и то же: задержка «нажал → увидел» (NTR-11) и адаптация запаса
 * разметки ввода (NTR-7, `lead.ts`). Общее у них ровно чтение, и второй его
 * реализации быть не должно.
 */
import { query, world as coreWorld, type EntityId, type Snapshot } from '@fluxus/core';

/**
 * Имена компонентов ввода и слота — параметры `InputSystem` (TICK-4), а не
 * конвенция ядра: сборка вправе назвать их как угодно, поэтому умолчания живут
 * рядом с чтением, а не в контракте.
 */
export interface InputEchoNames {
  readonly playerComponent?: string;
  readonly slotField?: string;
  readonly inputComponent?: string;
}

const DEFAULTS = {
  playerComponent: 'Player',
  slotField: 'slot',
  inputComponent: 'Input',
} as const;

/**
 * `seq` последнего применённого кадра своего слота. `0` — эха нет: компонентов
 * с такими именами в снапшоте не оказалось, своей сущности в нём нет либо ни
 * один кадр слота ещё не применён.
 */
export function ownInputSeq(snapshot: Snapshot, slot: number, names: InputEchoNames): number {
  const playerComponent = names.playerComponent ?? DEFAULTS.playerComponent;
  const inputComponent = names.inputComponent ?? DEFAULTS.inputComponent;
  const slotField = names.slotField ?? DEFAULTS.slotField;
  const own = ownEntity(snapshot, playerComponent, slotField, inputComponent, slot);
  if (own === undefined) return 0;
  return coreWorld.getField(snapshot.world, own, inputComponent, 'seq');
}

function ownEntity(
  snapshot: Snapshot,
  playerComponent: string,
  slotField: string,
  inputComponent: string,
  slot: number,
): EntityId | undefined {
  if (coreWorld.componentId(snapshot.world, playerComponent) === undefined) return undefined;
  if (coreWorld.componentId(snapshot.world, inputComponent) === undefined) return undefined;
  for (const entity of query(snapshot.world, { all: [playerComponent, inputComponent] })) {
    if (coreWorld.getField(snapshot.world, entity, playerComponent, slotField) === slot) return entity;
  }
  return undefined;
}
