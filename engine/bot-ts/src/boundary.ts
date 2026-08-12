/**
 * Граница «мозг ↔ симуляция» (BOT-5): единственный канал влияния мозга на матч —
 * обычный ввод, и проходит он ровно те ограничение и квантование, что ввод с
 * устройства (`input-devices` INP-3).
 *
 * Внутрь мозга ведёт чтение: fixed-point состояния снапшота отдаётся ему
 * float'ом — мозг живёт вне симуляции, и гарантии детерминизма ядра
 * (`determinism-core` CORE-1/CORE-2) на него не распространяются. Наружу ведёт
 * съём: намерение мозга — float-вектор и угол — клампится единичным кругом,
 * квантуется в Q16.16 и маскируется шириной `buttons` (`tick-loop` TICK-2).
 *
 * Обе конверсии живут ЗДЕСЬ и больше нигде — по той же причине, по которой у
 * слоя ввода одна точка квантования (INP-3): реализация мозга, собирающая
 * `InputSample` сама, обошла бы клампы, и бот выразил бы ввод, недоступный
 * человеку. Ссылки на домены поэтому в одном файле, а не в каждом мозге.
 */
import {
  FIXED_ONE,
  fixed,
  world as coreWorld,
  type EntityId,
  type WorldState,
} from '@game-mvp/core';
import type { InputSample } from '@game-mvp/net';

/**
 * Полный оборот в единицах угла ядра (`fixed-point-math` FP-7): угол — binary
 * angle measure, то есть сырое значение совпадает с Q16.16-долей оборота. Своей
 * константы у бота нет: это единица ядра, а не число слоя.
 */
export const TURN_UNITS: number = FIXED_ONE;

const TURN_MASK = TURN_UNITS - 1;
/** Ширина `buttons` — u16 (TICK-2): биты выше 15 не переживают круг через транспорт. */
const BUTTON_MASK = 0xffff;
const TAU = Math.PI * 2;

/**
 * Намерение мозга: float-величины в мировых осях (Y вверх), как у семантического
 * сэмпла устройства (INP-1). Ни клампов, ни квантования здесь ещё нет — их
 * делает `toInputSample`.
 */
export interface BotIntent {
  /** Вектор движения; длина больше единицы будет прижата к единичному кругу. */
  readonly moveX: number;
  readonly moveY: number;
  /**
   * Направление прицела, радианы. Обязательно: `InputFrame` несёт `aimDir`
   * каждым кадром (TICK-2), и «не менять прицел» этим полем не выражается —
   * последнее направление помнит мозг, а не граница.
   */
  readonly aimRadians: number;
  /** Маска действий; биты выше 15 отсекаются шириной поля (TICK-2). */
  readonly buttons?: number;
}

/** Нечисло от мозга — не повод уронить матч: намерения нет, значит нейтраль. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Намерение → канонический сэмпл ввода (BOT-5, INP-3).
 *
 * Вектор движения клампится единичным кругом — «диагональ клавиатуры не быстрее
 * стика, наклонённого по диагонали до упора»; аналоговая длина внутри круга
 * сохраняется, потому что медленный подход — такое же выразимое человеком
 * намерение, как рывок. Угол сворачивается маской оборота, а не обрезается:
 * заворачивание — свойство binary angle measure (FP-7). Маска действий
 * усекается до u16 (TICK-2).
 */
export function toInputSample(intent: BotIntent): InputSample {
  let moveX = finite(intent.moveX);
  let moveY = finite(intent.moveY);
  const length = Math.hypot(moveX, moveY);
  if (length > 1) {
    moveX /= length;
    moveY /= length;
  }
  const turns = finite(intent.aimRadians) / TAU;
  return {
    move: { x: fixed.fromFloat(moveX), y: fixed.fromFloat(moveY) },
    aimDir: Math.round(turns * TURN_UNITS) & TURN_MASK,
    buttons: Math.trunc(finite(intent.buttons ?? 0)) & BUTTON_MASK,
  };
}

/** Угол ввода (единицы ядра) → радианы: чтение той же границы в обратную сторону. */
export function aimToRadians(aimDir: number): number {
  return ((aimDir & TURN_MASK) / TURN_UNITS) * TAU;
}

/**
 * Поле компонента снапшота как float (BOT-5): единственное место, где мозг
 * встречается с Q16.16. `undefined` — компонента или поля на сущности нет.
 */
export function readFixedField(
  world: WorldState,
  entity: EntityId,
  component: string,
  field: string,
): number | undefined {
  if (coreWorld.componentId(world, component) === undefined) return undefined;
  if (!coreWorld.hasComponent(world, entity, component)) return undefined;
  return fixed.toFloat(coreWorld.getField(world, entity, component, field));
}

/** То же для целочисленного поля (слот, маска, счётчик): без Q16.16-конверсии. */
export function readIntField(
  world: WorldState,
  entity: EntityId,
  component: string,
  field: string,
): number | undefined {
  if (coreWorld.componentId(world, component) === undefined) return undefined;
  if (!coreWorld.hasComponent(world, entity, component)) return undefined;
  return coreWorld.getField(world, entity, component, field);
}
