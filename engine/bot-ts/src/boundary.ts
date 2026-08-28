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
} from '@fluxus/core';
import { toWorldFixed } from '@fluxus/client';
import type { InputSample } from '@fluxus/net';

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
  /**
   * Точка прицела в мировых единицах, float (BOT-5). Необязательна: мозг,
   * ничем не целящийся, о ней молчит — и кадр её не возит вовсе, как не возит
   * её кадр человека без источника точки (TICK-2).
   *
   * Ограничений здесь ещё нет: приведение к домену INP-3 делает
   * `toInputSample`, и делает тем же кодом, что приводит точку с устройства.
   */
  readonly target?: BotAimPoint;
  /**
   * Бит подтверждения шага прицеливания на этом тике (ABIL-5); `undefined` —
   * мозг ничего не подтверждает. Индекс бита — данные профиля: смысл битов
   * назначает контент (INP-4), и константы этого смысла в мозге не живут.
   *
   * Собственного канала «подтвердить шаг» у бота нет и быть не должно: бит
   * подмешивается в ту же маску `buttons`, цепочка накапливается в симуляции
   * одинаково для всех участников (BOT-5).
   */
  readonly confirmBit?: number;
  /** Бит отмены начатого каста — тем же путём и по тем же основаниям. */
  readonly cancelBit?: number;
  /** Маска действий; биты выше 15 отсекаются шириной поля (TICK-2). */
  readonly buttons?: number;
}

/** Точка прицела намерения: мировые единицы, float, оси мира (Y вверх). */
export interface BotAimPoint {
  readonly x: number;
  readonly y: number;
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
 * усекается до u16 (TICK-2), и биты подтверждения с отменой подмешиваются в неё
 * ЗДЕСЬ же — своего канала под них у бота нет.
 *
 * Точка прицела проходит `toWorldFixed` слоя ввода — ту самую единственную
 * точку приведения, через которую идёт точка с устройства (INP-3): не копию
 * формулы, а тот же код. Геймплейных границ — дальности способности, границы
 * арены — здесь нет: это политика симуляции (ABIL-5), и бот подчиняется ей на
 * тех же основаниях, что человек, — на подтверждении шага, а не на съёме.
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
  const buttons =
    (Math.trunc(finite(intent.buttons ?? 0)) | bitMask(intent.confirmBit) | bitMask(intent.cancelBit)) &
    BUTTON_MASK;
  const target = intent.target;
  return {
    move: { x: fixed.fromFloat(moveX), y: fixed.fromFloat(moveY) },
    aimDir: Math.round(turns * TURN_UNITS) & TURN_MASK,
    ...(target === undefined
      ? {}
      : { target: { x: toWorldFixed(target.x), y: toWorldFixed(target.y) } }),
    buttons,
  };
}

/**
 * Индекс бита → маска. Бит вне ширины `buttons` даёт ноль, а не заворачивается
 * в чужой бит: маска у человека и у бота одна, и «подтверждение, приехавшее
 * прыжком» было бы хуже несработавшего подтверждения.
 */
function bitMask(bit: number | undefined): number {
  if (bit === undefined || !Number.isInteger(bit) || bit < 0 || bit > 15) return 0;
  return 1 << bit;
}

/** Угол ввода (единицы ядра) → радианы: чтение той же границы в обратную сторону. */
export function aimToRadians(aimDir: number): number {
  return ((aimDir & TURN_MASK) / TURN_UNITS) * TAU;
}

/**
 * Целочисленное поле компонента снапшота (слот, маска, счётчик).
 * `undefined` — компоненты или поля на сущности нет.
 */
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

/**
 * То же поле как float (BOT-5): единственное место, где мозг встречается с
 * Q16.16. Читается ТЕМ ЖЕ чтением, что и целое, — разница ровно в конверсии, и
 * второго набора проверок «есть ли компонента» под неё не заводится.
 */
export function readFixedField(
  world: WorldState,
  entity: EntityId,
  component: string,
  field: string,
): number | undefined {
  const raw = readIntField(world, entity, component, field);
  return raw === undefined ? undefined : fixed.toFloat(raw);
}
