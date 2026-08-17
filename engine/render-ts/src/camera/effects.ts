/**
 * Слой эффектов камеры (CAM-6): стек эффектов между логической и финальной
 * позой. Каждый эффект покадрово выдаёт офсет (сдвиг, углы, FOV); офсеты
 * складываются и накладываются на копию логической позы с глобальным
 * множителем. Эффект не пишет в состояние установки: завершился — вклад
 * ноль, камера в точности там, где была бы без него.
 *
 * Float, шум и Math-тригонометрия здесь легальны: слой живёт в рендере
 * (REND-1), в симуляцию ничего не течёт.
 */
import { POSITIVE_MIN, type CameraEffectParamSpec, type CameraEffectTypeSpec } from '@game-mvp/assets';
import type { CameraPose } from './rig.js';

/** Аддитивный офсет позы; поля соответствуют `CameraPose`. */
export interface PoseOffset {
  dx: number;
  dy: number;
  dz: number;
  dyaw: number;
  dpitch: number;
  droll: number;
  dfovDeg: number;
}

/**
 * Контракт эффекта (CAM-6): прибавить свой вклад в `out`, вернуть false —
 * эффект завершён и снимается со стека. Добавление нового вида эффекта —
 * новый класс, режимы и другие эффекты не меняются.
 */
export interface CameraEffect {
  update(dt: number, out: PoseOffset): boolean;
}

/** Импульсный эффект (CAM-9): запускается событием тика с силой импульса. */
export interface ImpulseEffect extends CameraEffect {
  trigger(strength: number): void;
}

/** Длящийся эффект (CAM-9): висит, пока состояние присутствует на цели. */
export interface LastingEffect extends CameraEffect {
  setActive(active: boolean): void;
}

/**
 * Дескриптор типа эффекта: описание CAM-9 плюс фабрика. Фабрика живёт здесь, а
 * не в контракте `@game-mvp/assets`, потому что она render-специфична — валидации
 * секции и редактору хватает описания без неё (design.md).
 *
 * Видов два, и каждый обещает свой контракт запуска: импульсный строит
 * `ImpulseEffect`, длящийся — `LastingEffect`. Обещание в типе, а не в
 * договорённости: диспетчер зовёт `trigger`/`setActive` без приведений и без
 * проверок в рантайме.
 */
export interface ImpulseEffectType extends CameraEffectTypeSpec {
  readonly kind: 'impulse';
  create(params: Readonly<Record<string, number>>): ImpulseEffect;
}

export interface LastingEffectType extends CameraEffectTypeSpec {
  readonly kind: 'lasting';
  create(params: Readonly<Record<string, number>>): LastingEffect;
}

export type CameraEffectType = ImpulseEffectType | LastingEffectType;

/**
 * Умолчания типа одним объектом — единственный способ их узнать. Отдельной
 * константы умолчаний у эффекта нет: она жила бы рядом с дескриптором и
 * разошлась бы с ним при первой правке.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- baseline
export function defaults<T>(spec: CameraEffectTypeSpec): T {
  const out: Record<string, number> = {};
  for (const param of spec.params) out[param.name] = param.defaultValue;
  return out as T;
}

/** Неотрицательное число — самая частая граница осмысленности параметра. */
const nonNegative = (name: string, defaultValue: number): CameraEffectParamSpec =>
  Object.freeze({ name, defaultValue, min: 0 });

/**
 * Положительное число: частота нулём не бывает — это остановленное время.
 * Границы описания включающие, и строгую положительность выражает `POSITIVE_MIN`
 * — общее слово формата, а не число на месте (`@game-mvp/assets`).
 */
const positive = (name: string, defaultValue: number): CameraEffectParamSpec =>
  Object.freeze({ name, defaultValue, min: POSITIVE_MIN });

/**
 * Детерминированный value-noise [-1..1]: сглаженная интерполяция хэша
 * целых узлов. Не криптография и не симуляция — визуальный шум тряски.
 */
export function valueNoise(t: number, channel: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return hash(i, channel) * (1 - s) + hash(i + 1, channel) * s;
}

function hash(i: number, channel: number): number {
  const x = Math.sin(i * 127.1 + channel * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Параметры тряски; политика — числа приходят из манифеста (ASSET-8). */
export interface ShakeParams {
  /** Частота шума, Гц. */
  readonly frequency: number;
  /** Максимальный сдвиг позиции на полном trauma, мировых единиц. */
  readonly maxOffset: number;
  /** Максимальный крен на полном trauma, радианы. */
  readonly maxRoll: number;
  /** Скорость затухания trauma, 1/с. */
  readonly decay: number;
}

/**
 * Дескриптор тряски (CAM-9): идентификатор, вид, параметры с умолчаниями и
 * границами осмысленности. Человекочитаемых формулировок здесь нет и быть не
 * должно — тексты живут в строковых ресурсах потребителя (ED-28).
 */
export const SHAKE_TYPE: ImpulseEffectType = Object.freeze({
  id: 'shake',
  kind: 'impulse',
  params: Object.freeze([
    positive('frequency', 13),
    nonNegative('maxOffset', 0.35),
    nonNegative('maxRoll', 0.05),
    nonNegative('decay', 1.4),
  ]),
  create: (params: Readonly<Record<string, number>>): ImpulseEffect =>
    new TraumaShake(params as unknown as Partial<ShakeParams>),
});

/** Умолчания тряски выведены из дескриптора: второго места у умолчания нет. */
export const DEFAULT_SHAKE: ShakeParams = Object.freeze(defaults<ShakeParams>(SHAKE_TYPE));

/**
 * Тряска по trauma (Squirrel Eiserloh, GDC «Juicing Your Cameras With Math»):
 * события добавляют trauma [0..1], амплитуда ∝ trauma² — второй взрыв
 * усиливает тряску, а не заводит конкурирующую; смещения — value-noise,
 * не рандомные дёрганья.
 */
export class TraumaShake implements ImpulseEffect {
  private readonly params: ShakeParams;
  private trauma = 0;
  private time = 0;

  constructor(params: Partial<ShakeParams> = {}) {
    this.params = { ...DEFAULT_SHAKE, ...params };
  }

  /** Импульс (CAM-9): trauma аккумулируется и клампится к 1. */
  trigger(strength: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, strength));
  }

  update(dt: number, out: PoseOffset): boolean {
    if (this.trauma <= 0) return true; // постоянный жилец стека, вклад ноль
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.params.decay * dt);
    const amp = this.trauma * this.trauma;
    const t = this.time * this.params.frequency;
    out.dx += amp * this.params.maxOffset * valueNoise(t, 0);
    out.dy += amp * this.params.maxOffset * valueNoise(t, 1);
    out.dz += amp * this.params.maxOffset * 0.5 * valueNoise(t, 2);
    out.droll += amp * this.params.maxRoll * valueNoise(t, 3);
    return true;
  }
}

/** Параметры sway («опьянение»); политика — из манифеста (ASSET-8). */
export interface SwayParams {
  /** Амплитуда крена, радианы. */
  readonly rollAmp: number;
  /** Амплитуда рысканья, радианы. */
  readonly yawAmp: number;
  /** Амплитуда пульсации FOV, градусы. */
  readonly fovAmp: number;
  /** Базовая частота качания, Гц. */
  readonly frequency: number;
  /** Плавный вход/выход эффекта, секунды. */
  readonly fadeSeconds: number;
}

/** Дескриптор качания (CAM-9) — рядом со своим классом, как и у тряски. */
export const SWAY_TYPE: LastingEffectType = Object.freeze({
  id: 'sway',
  kind: 'lasting',
  params: Object.freeze([
    nonNegative('rollAmp', 0.05),
    nonNegative('yawAmp', 0.02),
    nonNegative('fovAmp', 2.5),
    positive('frequency', 0.9),
    nonNegative('fadeSeconds', 1.2),
  ]),
  create: (params: Readonly<Record<string, number>>): LastingEffect =>
    new SwayEffect(params as unknown as Partial<SwayParams>),
});

export const DEFAULT_SWAY: SwayParams = Object.freeze(defaults<SwayParams>(SWAY_TYPE));

/**
 * Длящийся эффект качания: активен, пока состояние присутствует на цели
 * (CAM-6); конверт плавно вводит и гасит вклад — исчезновение состояния не
 * обрывает картинку скачком.
 */
export class SwayEffect implements LastingEffect {
  private readonly params: SwayParams;
  private active = false;
  private envelope = 0;
  private time = 0;

  constructor(params: Partial<SwayParams> = {}) {
    this.params = { ...DEFAULT_SWAY, ...params };
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  update(dt: number, out: PoseOffset): boolean {
    const rate = this.params.fadeSeconds <= 0 ? 1 : dt / this.params.fadeSeconds;
    this.envelope = Math.min(1, Math.max(0, this.envelope + (this.active ? rate : -rate)));
    if (this.envelope <= 0) return true; // жилец стека: ждёт следующей активации
    this.time += dt;
    const w = this.params.frequency * 2 * Math.PI;
    const e = this.envelope;
    const t = this.time;
    out.droll += e * this.params.rollAmp * Math.sin(t * w);
    out.dyaw += e * this.params.yawAmp * Math.sin(t * w * 0.77 + 1.3);
    out.dfovDeg += e * this.params.fovAmp * Math.sin(t * w * 0.53 + 2.1);
    return true;
  }
}

/**
 * Стек эффектов: обновляет жильцов, складывает офсеты и накладывает их на
 * копию логической позы с глобальным множителем (0 — финальная поза равна
 * логической, CAM-6). Финальная поза — переиспользуемый объект стека.
 */
export class EffectStack {
  /** Глобальный множитель силы (CAM-6): политика, доступность при укачивании. */
  multiplier: number;

  private readonly effects: CameraEffect[] = [];
  private readonly offset: PoseOffset = {
    dx: 0,
    dy: 0,
    dz: 0,
    dyaw: 0,
    dpitch: 0,
    droll: 0,
    dfovDeg: 0,
  };
  private readonly finalPose: CameraPose = {
    posX: 0,
    posY: 0,
    posZ: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    fovDeg: 45,
  };

  constructor(multiplier = 1) {
    this.multiplier = multiplier;
  }

  add(effect: CameraEffect): void {
    this.effects.push(effect);
  }

  /**
   * Кадр слоя: логическая поза → финальная. Возвращаемая поза
   * переиспользуется и валидна до следующего вызова.
   */
  apply(logical: CameraPose, dt: number): CameraPose {
    const o = this.offset;
    o.dx = o.dy = o.dz = o.dyaw = o.dpitch = o.droll = o.dfovDeg = 0;
    // Тряска и качание необратимы: отрицательный шаг накачивал бы trauma
    // вместо её затухания. Придя часами презентации со знаком (REND-25),
    // обратный ход и пауза эффекты ЗАМОРАЖИВАЮТ, а не отматывают.
    const step = dt > 0 ? dt : 0;
    // Компактация на месте, а не `filter`: в установившемся кадре путь не
    // аллоцирует пропорционально числу жильцов стека, а `filter` заводил бы на
    // КАЖДЫЙ кадр и новый массив, и новое замыкание. Тот же приём, что у
    // отыгравших вспышек подсистемы эффектов: пишем в тот же массив, читая
    // впереди курсора записи.
    let alive = 0;
    for (const effect of this.effects) {
      if (effect.update(step, o)) this.effects[alive++] = effect;
    }
    this.effects.length = alive;
    const m = this.multiplier;
    const pose = this.finalPose;
    pose.posX = logical.posX + o.dx * m;
    pose.posY = logical.posY + o.dy * m;
    pose.posZ = logical.posZ + o.dz * m;
    pose.yaw = logical.yaw + o.dyaw * m;
    pose.pitch = logical.pitch + o.dpitch * m;
    pose.roll = logical.roll + o.droll * m;
    pose.fovDeg = logical.fovDeg + o.dfovDeg * m;
    return pose;
  }
}
