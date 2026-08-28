/**
 * Блок `light` записи манифеста визуалов (ASSET-16) — описание локального
 * источника света, который несёт каждый инстанс записи (`rendering` REND-33).
 * Здесь его состав, его валидация и его разбор в величины рендера.
 *
 * Живёт отдельно от `manifest.ts` по тому же основанию, по какому секция
 * `lighting` живёт отдельно от парного документа (`presentationLighting.ts`):
 * это самостоятельный формат со своим составом, своими единицами и своими
 * адресами находок, а запись манифеста только называет его полем.
 *
 * ## Единицы — авторские, а не рендерные
 *
 * Углы автор пишет ДОЛЯМИ ОБОРОТА — той же конвенцией, что `yaw` записи
 * decoration (`presentation-scene` PRES-2), — а длины мировыми единицами.
 * Конверсия в радианы живёт ровно здесь, на границе разбора: в рендер блок
 * приезжает готовым (`resolveLightBlock`), и второго перевода долей в радианы в
 * репозитории не появляется.
 *
 * ## Чего в блоке нет
 *
 * Полей теней — ни под каким именем (ASSET-16): карты теней принадлежат
 * направленному источнику (`rendering` REND-30), локальные их не отбрасывают
 * (REND-33), и поле вида `castShadow` обещало бы то, чего рендер не делает.
 * Отвергается оно поимённо, а не общим «неизвестное поле», по той же причине,
 * по какой поимённо отвергаются параметры теней в фазе цикла суток (REND-32).
 *
 * Fixed-point-представлений (`fixed-point-math` FP-1) в блоке нет: величины —
 * десятичные числа presentation-слоя, и на симуляцию блок не влияет ни байтом
 * (ASSET-1).
 */

import { HEX_COLOR_RE, closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

/** Род локального источника (ASSET-16); перечень закрыт рендером (REND-33). */
export type VisualLightType = 'point' | 'spot';

/** Значения рода в порядке объявления — единственный их перечень. */
export const VISUAL_LIGHT_TYPES: readonly VisualLightType[] = Object.freeze(['point', 'spot']);

/**
 * Тройка осей блока: смещение опоры света от опоры инстанса и направление
 * конуса. Поля необязательны — отсутствующая ось равна умолчанию своего поля,
 * а не нулю всей тройки.
 */
export interface VisualLightAxes {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

/**
 * Блок `light` записи манифеста как он написан автором (ASSET-16). Состав
 * закрыт и зависит от действующего типа: spot-поля в блоке типа `point`
 * отвергаются адресно.
 */
export interface VisualLight {
  readonly type: VisualLightType;
  /** Тон источника — `#rrggbb`, та же форма, что у тона секции `lighting`. */
  readonly color: string;
  /** Интенсивность, положительная. */
  readonly intensity: number;
  /**
   * Граница действия в мировых единицах, положительная: неограниченного
   * локального источника не существует (ASSET-16) — без границы отбор активных
   * (REND-33) терял бы локальность.
   */
  readonly distance: number;
  /** Затухание, неотрицательное; нет — физическое `DEFAULT_LIGHT_DECAY`. */
  readonly decay?: number;
  /** Смещение опоры света от опоры инстанса, мировые единицы; нет — нули. */
  readonly offset?: VisualLightAxes;
  /**
   * Половинный угол конуса ДОЛЕЙ ОБОРОТА в `(0, MAX_LIGHT_ANGLE_TURNS]` —
   * только у `spot` и у него обязателен.
   */
  readonly angle?: number;
  /** Полутень конуса `[0, 1]`; нет — 0. Только у `spot`. */
  readonly penumbra?: number;
  /** Направление конуса в опоре инстанса; нет — вниз. Только у `spot`. */
  readonly direction?: VisualLightAxes;
}

/**
 * Разобранный блок — то, что едет в рендер (ASSET-16, REND-33): умолчания
 * раскрыты, углы в радианах, направление нормировано. Плоские поля, а не
 * вложенные тройки: кадровый путь подсистемы освещения читает их на каждом
 * носителе, и разыменование вложенного объекта там ни к чему.
 */
export interface ResolvedVisualLight {
  readonly type: VisualLightType;
  readonly color: string;
  readonly intensity: number;
  readonly distance: number;
  readonly decay: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
  /** Половинный угол конуса в РАДИАНАХ — форма three.js (design D4). */
  readonly angleRad: number;
  readonly penumbra: number;
  /** Единичное направление конуса в опоре инстанса. */
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
}

/**
 * Затухание по умолчанию — физическое (обратный квадрат расстояния), то же
 * значение, что у источников three.js. Названо, а не написано числом на месте:
 * умолчание документировано ASSET-16, и читают его и рендер, и тесты.
 */
export const DEFAULT_LIGHT_DECAY = 2;

/**
 * Потолок половинного угла конуса в долях оборота (ASSET-16): четверть оборота
 * — это 90°, верхняя граница угла spot-источника three.js. Больше него конус
 * перестаёт быть конусом.
 */
export const MAX_LIGHT_ANGLE_TURNS = 0.25;

/** Полный оборот в радианах: угол автор пишет долями оборота (design D4). */
const TURN_RADIANS = Math.PI * 2;

/**
 * Направление конуса по умолчанию — вниз (ASSET-16): самое частое для арен,
 * которые смотрят сверху. Настенному факелу автор пишет своё.
 */
const DEFAULT_DIRECTION_Z = -1;

/** Поля, законные в блоке ЛЮБОГО типа (ASSET-16). */
const BASE_KEYS: readonly string[] = ['type', 'color', 'intensity', 'distance', 'decay', 'offset'];

/** Поля, законные только у `spot`: в блоке типа `point` они отвергаются. */
const SPOT_KEYS: readonly string[] = ['angle', 'penumbra', 'direction'];

/** Оси тройки — они же перечень допустимых ключей `offset` и `direction`. */
const AXIS_KEYS: readonly string[] = ['x', 'y', 'z'];

/**
 * Имена, которыми автор попытался бы включить тень локального источника
 * (ASSET-16). Перечень не защита от опечаток, а адресный ответ на попытку: в
 * блоке теней нет ни под каким именем, и находка обязана сказать почему.
 */
const SHADOW_KEYS: readonly string[] = [
  'castShadow',
  'receiveShadow',
  'shadow',
  'shadows',
  'shadowMapSize',
  'shadowBias',
];


/** Ось тройки: отсутствует — умолчание поля, есть — конечное число. */
function axisOf(node: VisualLightAxes | undefined, axis: 'x' | 'y' | 'z', fallback: number): number {
  const value = node?.[axis];
  return isFiniteNumber(value) ? value : fallback;
}

/** То же по неразобранному документу — вход валидации, где типов ещё нет. */
function rawAxis(node: Record<string, unknown>, axis: string, fallback: number): number {
  const value = node[axis];
  return isFiniteNumber(value) ? value : fallback;
}

/**
 * Разбор блока в величины рендера (design D4): умолчания раскрыты, угол
 * переведён в радианы, направление нормировано. `undefined` на входе — записи
 * без блока: света она не несёт, и `null` здесь означает именно это.
 *
 * Разбор ДОВЕРЯЕТ формату: документ, дошедший до рендера, прошёл
 * `validateVisualLight` (ASSET-6). Вырожденное направление нулевой длины
 * валидация отвергает, а здесь оно всё-таки закрыто умолчанием — иначе
 * незамеченный ноль давал бы конус, светящий в никуда.
 */
export function resolveLightBlock(light: VisualLight | undefined): ResolvedVisualLight | null {
  if (light === undefined) return null;
  const dx = axisOf(light.direction, 'x', 0);
  const dy = axisOf(light.direction, 'y', 0);
  const dz = axisOf(light.direction, 'z', DEFAULT_DIRECTION_Z);
  const length = Math.hypot(dx, dy, dz);
  const unit = length > 0 ? 1 / length : 0;
  const angleTurns = isFiniteNumber(light.angle) ? light.angle : MAX_LIGHT_ANGLE_TURNS;
  return {
    type: light.type,
    color: light.color,
    intensity: light.intensity,
    distance: light.distance,
    decay: isFiniteNumber(light.decay) ? light.decay : DEFAULT_LIGHT_DECAY,
    offsetX: axisOf(light.offset, 'x', 0),
    offsetY: axisOf(light.offset, 'y', 0),
    offsetZ: axisOf(light.offset, 'z', 0),
    angleRad: angleTurns * TURN_RADIANS,
    penumbra: isFiniteNumber(light.penumbra) ? light.penumbra : 0,
    directionX: length > 0 ? dx * unit : 0,
    directionY: length > 0 ? dy * unit : 0,
    directionZ: length > 0 ? dz * unit : DEFAULT_DIRECTION_Z,
  };
}

/** Тройка осей блока: состав закрыт, значения — конечные числа (ASSET-16). */
function validateAxes(v: unknown, path: string, what: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { x?, y?, z? } — ${what}, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, AXIS_KEYS, errors);
  for (const axis of AXIS_KEYS) {
    if (axis in v && !isFiniteNumber(v[axis])) {
      errors.push(`${path}.${axis}: ожидалось конечное число — ${what}, получено ${typeName(v[axis])}`);
    }
  }
}

/**
 * Состав блока по ДЕЙСТВУЮЩЕМУ типу (ASSET-16): spot-поле в блоке типа `point`
 * — такая же ошибка автора, как неизвестное поле, и называется она поимённо.
 * Тип, которого формат не знает, о своём составе ничего не говорит: неизвестные
 * ключи тогда считаются по полному перечню, чтобы одна опечатка в `type` не
 * рассыпалась находками на каждом поле блока.
 */
function validateKeys(
  v: Record<string, unknown>,
  path: string,
  type: VisualLightType | null,
  errors: string[],
): void {
  const known = type === 'point' ? BASE_KEYS : [...BASE_KEYS, ...SPOT_KEYS];
  for (const key of Object.keys(v)) {
    if (known.includes(key)) continue;
    if (SHADOW_KEYS.includes(key)) {
      errors.push(
        `${path}.${key}: полей теней в блоке света нет и быть не может — локальные источники теней не отбрасывают, карты теней принадлежат направленному источнику (REND-33, REND-30)`,
      );
      continue;
    }
    if (SPOT_KEYS.includes(key)) {
      errors.push(
        `${path}.${key}: поле есть только у источника типа spot, а блок объявлен как point (ASSET-16)`,
      );
      continue;
    }
    errors.push(`${path}.${key}: неизвестное поле (допустимы: ${known.join(', ')})`);
  }
}

/** Обязательные числа блока: интенсивность и граница действия (ASSET-16). */
function validateNumbers(v: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isFiniteNumber(v.intensity) || v.intensity <= 0) {
    errors.push(
      `${path}.intensity: обязательное поле — положительная интенсивность, получено ${typeName(v.intensity)}`,
    );
  }
  // Граница действия обязательна: неограниченного локального источника не
  // существует (ASSET-16) — без неё отбор активных терял бы локальность.
  if (!isFiniteNumber(v.distance) || v.distance <= 0) {
    errors.push(
      `${path}.distance: обязательное поле — положительная граница действия в мировых единицах, получено ${typeName(v.distance)}`,
    );
  }
  if ('decay' in v && (!isFiniteNumber(v.decay) || v.decay < 0)) {
    errors.push(
      `${path}.decay: ожидалось неотрицательное затухание (умолчание ${DEFAULT_LIGHT_DECAY}), получено ${typeName(v.decay)}`,
    );
  }
}

/** Поля конуса: угол долями оборота, полутень и направление (ASSET-16). */
function validateSpot(v: Record<string, unknown>, path: string, errors: string[]): void {
  const angle = v.angle;
  if (!isFiniteNumber(angle) || angle <= 0 || angle > MAX_LIGHT_ANGLE_TURNS) {
    errors.push(
      `${path}.angle: обязательное поле spot-источника — половинный угол конуса долей оборота в (0..${MAX_LIGHT_ANGLE_TURNS}], получено ${typeName(angle)}`,
    );
  }
  if ('penumbra' in v && (!isFiniteNumber(v.penumbra) || v.penumbra < 0 || v.penumbra > 1)) {
    errors.push(
      `${path}.penumbra: ожидалась полутень конуса в [0..1], получено ${typeName(v.penumbra)}`,
    );
  }
  if (!('direction' in v)) return;
  const direction = v.direction;
  validateAxes(direction, `${path}.direction`, 'направление конуса в опоре инстанса', errors);
  if (!isRecord(direction)) return;
  // Направление нулевой длины — вырожденное значение, а не крайний случай:
  // конусу тогда некуда светить, и прочтения у такого блока нет.
  const dx = rawAxis(direction, 'x', 0);
  const dy = rawAxis(direction, 'y', 0);
  const dz = rawAxis(direction, 'z', DEFAULT_DIRECTION_Z);
  if (Math.hypot(dx, dy, dz) === 0) {
    errors.push(`${path}.direction: направление нулевой длины — конусу некуда светить (ASSET-16)`);
  }
}

/**
 * Валидация блока `light` записи манифеста (ASSET-16). Находки адресные и
 * собираются все разом — по общему правилу манифеста (ASSET-6): правка JSON не
 * должна превращаться в угадывание, какое из полей блока не подошло.
 */
export function validateVisualLight(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(
      `${path}: ожидался объект { type, color, intensity, distance, … }, получено ${typeName(v)}`,
    );
    return;
  }
  const type = VISUAL_LIGHT_TYPES.includes(v.type as VisualLightType)
    ? (v.type as VisualLightType)
    : null;
  if (type === null) {
    errors.push(
      `${path}.type: обязательное поле — род источника (${VISUAL_LIGHT_TYPES.join(' | ')}), получено ${typeName(v.type)}`,
    );
  }
  validateKeys(v, path, type, errors);
  if (typeof v.color !== 'string' || !HEX_COLOR_RE.test(v.color)) {
    errors.push(
      `${path}.color: обязательное поле — цвет формы "#rrggbb", получено ${typeName(v.color)}`,
    );
  }
  validateNumbers(v, path, errors);
  if ('offset' in v) {
    validateAxes(v.offset, `${path}.offset`, 'смещение опоры света в мировых единицах', errors);
  }
  if (type === 'spot') validateSpot(v, path, errors);
}
