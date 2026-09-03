/**
 * Кинематографический путь камеры (CAM-10): запись манифеста (`assets`
 * ASSET-17) → чистая функция времени, дающая позу.
 *
 * Отдельно от рига, потому что оценка ЗАМКНУТА: на входе путь и время, на
 * выходе величины позы; ни состояния конвейера, ни графического контекста
 * оценке не нужно — её читают тесты и редактор так же, как машинное описание
 * (CAM-9). Режим `path` рига над ней надстраивается.
 *
 * Точка наблюдения идёт сплайном Катмулла–Рома по соседним ключам: облёт обязан
 * быть гладким на стыке, а ломаная по отрезкам даёт рывок курса на каждом
 * ключе. Скалярные каналы — линейно по сглаженному параметру; курс — по
 * КРАТЧАЙШЕЙ дуге: путь, разворачивающийся на 350° вместо 10°, был бы дефектом
 * оценки, а не замыслом автора.
 *
 * Сглаживание применяется к ПАРАМЕТРУ отрезка (CAM-10), а не к отдельному
 * каналу: одно имя действует на все каналы одинаково.
 *
 * Канал, ключом не названный, берёт действующее значение конфига камеры —
 * поэтому оценка принимает его аргументом, а не читает конфиг сама: путь
 * headless, а конфиг живёт у конвейера.
 */
import type { CameraPathDef, CameraPathKeyDef } from '@fluxus/assets';
import { CAMERA_PATH_DESCRIPTION, DEFAULT_CAMERA_PATH_EASING, easeParameter } from './pathTypes.js';

/** Значения, которыми путь заполняет каналы, не названные ключом (CAM-10). */
export interface CameraPathDefaults {
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly fovDeg: number;
}

/** Поза, которую путь производит на момент времени. Запись переиспользуется. */
export interface CameraPathPose {
  x: number;
  y: number;
  distance: number;
  yaw: number;
  pitch: number;
  fovDeg: number;
}

/** Разобранный ключ: все каналы уже заполнены — умолчаниями там, где их не назвали. */
interface PathKey {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly fovDeg: number;
  /** Секунды до следующего ключа; у последнего — 0. */
  readonly duration: number;
  readonly easing: string;
}

const TAU = Math.PI * 2;

/** Имена каналов позы — из машинного описания (CAM-10), а не вторым списком. */
const CHANNELS = CAMERA_PATH_DESCRIPTION.channels;

function channelOf(key: CameraPathKeyDef, name: string, fallback: number): number {
  const value = key[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Разобранный путь (CAM-10): ключи с заполненными каналами, общая длительность
 * и признак кольца. Разбор делается ОДИН раз — оценка на кадре только считает.
 */
export class CameraPath {
  readonly loop: boolean;
  /** Полная длительность пути, секунды; 0 — путь из одного ключа. */
  readonly duration: number;

  private readonly keys: readonly PathKey[];
  /** Накопленное время до начала каждого отрезка. */
  private readonly starts: readonly number[];
  /** Переиспользуемая поза: оценка зовётся покадрово и не аллоцирует (REND-26). */
  private readonly pose: CameraPathPose = {
    x: 0, y: 0, distance: 0, yaw: 0, pitch: 0, fovDeg: 0,
  };

  constructor(def: CameraPathDef, defaults: CameraPathDefaults) {
    const keys: PathKey[] = [];
    const starts: number[] = [];
    let total = 0;
    def.keys.forEach((key, index) => {
      const last = index === def.keys.length - 1;
      // Длительность последнего ключа читается только у КОЛЬЦА: там за ним идёт
      // первый, и отрезок между ними существует.
      const declared = channelOf(key, 'duration', 0);
      const duration = last && def.loop !== true ? 0 : Math.max(0, declared);
      starts.push(total);
      total += duration;
      keys.push({
        x: channelOf(key, 'x', 0),
        y: channelOf(key, 'y', 0),
        distance: channelOf(key, 'distance', defaults.distance),
        yaw: channelOf(key, 'yaw', defaults.yaw),
        pitch: channelOf(key, 'pitch', defaults.pitch),
        fovDeg: channelOf(key, 'fovDeg', defaults.fovDeg),
        duration,
        easing: typeof key.easing === 'string' ? key.easing : DEFAULT_CAMERA_PATH_EASING,
      });
    });
    this.keys = keys;
    this.starts = starts;
    this.loop = def.loop === true;
    this.duration = total;
  }

  /** Ключей в пути — вход тестов и отладочной панели. */
  get length(): number {
    return this.keys.length;
  }

  /**
   * Поза на момент времени (CAM-10). Чистая: одно и то же время даёт одно и то
   * же, и от частоты кадров результат не зависит. Время до начала прижимается к
   * первому ключу, за концом — к последнему; у кольца оно заворачивается.
   *
   * Возвращаемая запись переиспользуется и валидна до следующего вызова.
   */
  poseAt(seconds: number): CameraPathPose {
    const keys = this.keys;
    const first = keys[0]!;
    const pose = this.pose;
    if (keys.length === 1 || this.duration <= 0) return writeKey(pose, first);
    const time = this.wrap(seconds);
    const at = this.segmentAt(time);
    const from = keys[at]!;
    const to = keys[(at + 1) % keys.length]!;
    const span = from.duration;
    const raw = span <= 0 ? 0 : (time - (this.starts[at] ?? 0)) / span;
    const t = easeParameter(from.easing, raw < 0 ? 0 : raw > 1 ? 1 : raw);

    // Точка наблюдения — сплайном по соседям отрезка: гладкость на стыке и есть
    // разница между облётом и ломаной.
    const before = keys[this.neighbour(at, -1)]!;
    const after = keys[this.neighbour((at + 1) % keys.length, 1)]!;
    pose.x = catmullRom(before.x, from.x, to.x, after.x, t);
    pose.y = catmullRom(before.y, from.y, to.y, after.y, t);
    pose.distance = lerp(from.distance, to.distance, t);
    pose.pitch = lerp(from.pitch, to.pitch, t);
    pose.fovDeg = lerp(from.fovDeg, to.fovDeg, t);
    pose.yaw = lerpAngle(from.yaw, to.yaw, t);
    return pose;
  }

  /** Путь кончился к этому моменту (CAM-10); кольцо не кончается никогда. */
  finished(seconds: number): boolean {
    return !this.loop && seconds >= this.duration;
  }

  // ------------------------------------------------------------ внутреннее

  private wrap(seconds: number): number {
    if (seconds <= 0) return 0;
    if (!this.loop) return Math.min(seconds, this.duration);
    const time = seconds % this.duration;
    return time < 0 ? time + this.duration : time;
  }

  /** Индекс отрезка, которому принадлежит момент; последний включает свой конец. */
  private segmentAt(time: number): number {
    const starts = this.starts;
    for (let i = starts.length - 1; i >= 0; i--) {
      if (time >= (starts[i] ?? 0) && (this.keys[i]?.duration ?? 0) > 0) return i;
    }
    return 0;
  }

  /**
   * Сосед ключа для сплайна: у кольца — по кругу, у открытого пути крайний ключ
   * соседствует сам с собой (касательная на краю тогда направлена вдоль первого
   * отрезка, а не выдумана).
   */
  private neighbour(at: number, direction: 1 | -1): number {
    const size = this.keys.length;
    if (this.loop) return (at + direction + size) % size;
    const next = at + direction;
    return next < 0 ? 0 : next >= size ? size - 1 : next;
  }
}

function writeKey(pose: CameraPathPose, key: PathKey): CameraPathPose {
  pose.x = key.x;
  pose.y = key.y;
  pose.distance = key.distance;
  pose.yaw = key.yaw;
  pose.pitch = key.pitch;
  pose.fovDeg = key.fovDeg;
  return pose;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Интерполяция угла по КРАТЧАЙШЕЙ дуге (CAM-10). */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return a + delta * t;
}

/** Сплайн Катмулла–Рома с натяжением 0.5 — гладкий проход через ключи. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Проигрыватель пути (CAM-10): путь, его время и ответ «поза этого кадра».
 *
 * Рядом с оценкой, а не в риге, потому что это её ЧАСОВОЙ механизм: рига здесь
 * не видно ни полем, ни вызовом, и проверяется он так же headless. Ригу
 * остаётся режим — куда вернуться по концу и чем прервать.
 */
export class CameraPathPlayer {
  private current: CameraPath | null = null;
  private seconds = 0;

  /** Путь идёт. */
  get active(): boolean {
    return this.current !== null;
  }

  /** Секунды, пройденные текущим путём; пути нет — 0. */
  get time(): number {
    return this.current === null ? 0 : this.seconds;
  }

  start(path: CameraPath): void {
    this.current = path;
    this.seconds = 0;
  }

  stop(): void {
    this.current = null;
    this.seconds = 0;
  }

  /**
   * Поза этого кадра; null — путь не идёт. Путь, доигранный до конца, отдаёт
   * ПОСЛЕДНЮЮ позу и останавливается сам: кадр, на котором он кончился, обязан
   * показать его конец, а не прежнюю позу конвейера (CAM-10).
   */
  advance(dt: number): CameraPathPose | null {
    const path = this.current;
    if (path === null) return null;
    this.seconds += dt;
    const pose = path.poseAt(this.seconds);
    if (path.finished(this.seconds)) this.current = null;
    return pose;
  }
}

/** Каналы описания — вход тестов: перечня каналов вторым списком нет (CAM-10). */
export const CAMERA_PATH_CHANNELS: readonly string[] = Object.freeze(
  CHANNELS.map((channel) => channel.name),
);
