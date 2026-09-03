/**
 * Локальные источники света инстансов (REND-33) — пул подсистемы освещения и
 * отбор активных источников кадра.
 *
 * ## Носитель и источник — не одно и то же
 *
 * НОСИТЕЛЬ — инстанс, чья запись манифеста несёт блок `light` (`assets`
 * ASSET-16); их в сцене столько, сколько наставил автор. ИСТОЧНИК — объект
 * three.js, который в этом кадре светит; их ровно столько, сколько разрешает
 * ручка качества (`lighting.maxLocalLights`, QUAL-1). Носителей может быть
 * больше, и тогда кадр выбирает, кому светить (design D3).
 *
 * ## Почему пул, а не источник на носителя
 *
 * three.js — форвард-рендерер: число источников каждого рода входит в программу
 * КАЖДОГО освещаемого материала, и смена этого числа пересобирает программы.
 * Поэтому источники создаются один раз в число потолка и остаются в сцене
 * навсегда: неактивный слот стоит с нулевой интенсивностью (design D2).
 * Переключение активных — запись чисел в готовые объекты, без единой
 * перекомпиляции.
 *
 * Пул рода создаётся ЛЕНИВО — по первому носителю этого рода (уточнение design
 * D2): сцена без конусов не платит за конусы, а сцена вовсе без локального
 * света остаётся ровно тем кадром, каким была до REND-33. Событие это разовое —
 * появление первого носителя рода, — а не кадровое: дальше пул уже полон, и
 * второго носителя он встречает готовыми слотами.
 *
 * ## Поза носителя — прошлого кадра, и это осознанно
 *
 * Подсистема освещения владеет портом и потому зарегистрирована РАНЬШЕ
 * владельцев инстансов (REND-31), а кадры идут в порядке регистрации (REND-8):
 * когда пул спрашивает позу, подсистема моделей ещё не ставила инстансы в позу
 * ЭТОГО кадра. Стоящая декорация разницы не знает вовсе, а у движущегося
 * носителя источник отстаёт ровно на кадр — доли сантиметра на арене. Догонять
 * его пришлось бы вторым проходом по инстансам после их позы, то есть платить
 * кадром за то, чего не видно; появившийся носитель по той же причине
 * загорается следующим кадром — «не позже следующего кадра» (`editor` ED-15).
 *
 * ## Граница отбора и рампа у неё
 *
 * Отбор считается заново каждым кадром и памяти о прошлом не имеет (REND-33:
 * «повтор того же кадра отбирает те же источники»). Без рампы это значило бы
 * скачок на границе рейтинга: панорама камеры на пол-юнита гасит один факел и
 * зажигает другой в полную силу. Поэтому интенсивность отобранного носителя
 * умножается на его ЗАПАС до границы отбора (`fadeOf`) — величину того же
 * кадра, а не состояние: у самой границы носитель горит слабо, и обмен местами
 * происходит на нуле. Гистерезисом это не является и «того же кадра» не
 * нарушает.
 *
 * ## Теней локальный источник не отбрасывает
 *
 * `castShadow` не поднимается ни на одном слоте (REND-33): карты теней
 * принадлежат направленному источнику (REND-30), и в реестр кастеров локальные
 * источники не входят — они не нарисованное, а свет.
 */
import * as THREE from 'three';
import type { QualityKnob } from '../types.js';
import type { LightCarrier, LightCarrierPose } from '../types.js';
import { costSink } from '../cost.js';

/**
 * Ручка качества подсистемы (QUAL-1, QUAL-3): потолок числа ОДНОВРЕМЕННО
 * активных локальных источников. Семантика прямая, а не потолок над авторским
 * значением: авторского числа активных источников не существует — автор ставит
 * НОСИТЕЛЕЙ, а сколько из них светит, решает пресет (то же основание, что у
 * `models.defaultTier`).
 */
export const LIGHTING_MAX_LOCAL_LIGHTS = 'lighting.maxLocalLights';

/**
 * Умолчание потолка — значение кода, действующее без документа пресета
 * (QUAL-1). Четыре: столько локальных источников арена вроде дуэльной несёт,
 * не заставляя форвард-рендер считать свет, которого игрок не видит.
 */
export const DEFAULT_MAX_LOCAL_LIGHTS = 4;

/**
 * Ширина рампы затухания у ГРАНИЦЫ ОТБОРА, мировые единицы оценки (design D3).
 *
 * Отбор переранжируется каждым кадром, и без рампы источник на границе рейтинга
 * переключался бы скачком: панорама камеры на пол-юнита гасила бы один факел и
 * зажигала другой в полную силу. Рампа делает интенсивность НЕПРЕРЫВНОЙ функцией
 * оценок кадра: чем меньше запас отобранного носителя до границы, тем тусклее он
 * горит, и в точке, где два носителя меняются местами, обмен идёт на нуле —
 * видимого переключения не происходит вовсе.
 *
 * Памяти о прошлом кадре у рампы нет (это не гистерезис): значение остаётся
 * функцией данных ЭТОГО кадра, и «повтор того же кадра отбирает те же
 * источники» (REND-33) выполняется наравне с отбором.
 *
 * Единица — клетка типовой арены: запас в клетку носитель проходит за доли
 * секунды панорамирования, и рампа читается плавным, а не медленным.
 */
const SELECTION_FADE_WORLD_UNITS = 1;

/**
 * Верхняя граница, которую вправе написать автор пресета. Не «столько бывает
 * нужно», а «дальше форвард-рендер платит за каждый источник на каждом
 * фрагменте»: граница диапазона ручки — это граница осмысленности документа
 * (QUAL-1), и её выход за пределы отвергается адресно.
 */
export const MAX_LOCAL_LIGHTS_LIMIT = 16;

/** Объявление ручки — рядом с пулом, которым она правит (QUAL-1, QUAL-3). */
export function localLightsKnob(): QualityKnob {
  return {
    name: LIGHTING_MAX_LOCAL_LIGHTS,
    cost: 'локальные источники в программах материалов: форвард-рендер считает свет каждого активного источника на каждом фрагменте освещаемой поверхности',
    semantics: 'value',
    default: DEFAULT_MAX_LOCAL_LIGHTS,
    min: 0,
    max: MAX_LOCAL_LIGHTS_LIMIT,
  };
}

/** Свежая переиспользуемая запись позы носителя (REND-33). */
function emptyPose(): LightCarrierPose {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

/**
 * Слот пула: источник three.js плюс тон, которым он покрашен сейчас. Тон
 * держится СТРОКОЙ, а не сравнением цветов: `Color.set` разбирает `#rrggbb`
 * регулярным выражением, и делать это каждым кадром на каждом слоте значило бы
 * аллоцировать на кадровом пути ради значения, которое почти никогда не меняется.
 */
interface PointSlot {
  readonly light: THREE.PointLight;
  color: string;
}

interface SpotSlot {
  readonly light: THREE.SpotLight;
  color: string;
}

/** Слот любого рода — вход общих операций пула (покраска, гашение, снос). */
interface AnySlot {
  readonly light: THREE.PointLight | THREE.SpotLight;
  color: string;
}

export class LocalLightPool {
  private scene: THREE.Scene | null = null;
  private ceiling = DEFAULT_MAX_LOCAL_LIGHTS;
  /**
   * Носители сцены (REND-33). Порядок обхода на отбор не влияет: он определён
   * оценкой и устойчивым ключом носителя (design D3), а не порядком вставки.
   */
  private readonly carriers = new Set<LightCarrier>();
  private readonly point: PointSlot[] = [];
  private readonly spot: SpotSlot[] = [];
  /**
   * Отобранные кадром носители, их оценки и их ключи — массивы длины потолка.
   * Ключ лежит рядом со оценкой, а не спрашивается у носителя: сравнение идёт
   * на каждом шаге вставки, и разыменование там ни к чему.
   */
  private readonly chosen: (LightCarrier | null)[] = [];
  private readonly scores: number[] = [];
  private readonly keys: string[] = [];
  /** Сколько источников горело в последнем кадре — пробник для тестов и отладки. */
  private lit = 0;
  /**
   * Граница отбора кадра — середина между оценкой последнего ОТОБРАННОГО и
   * лучшей оценкой ОТВЕРГНУТОГО носителя; по запасу до неё считается рампа
   * затухания (см. `SELECTION_FADE_WORLD_UNITS`). `-Infinity` — отвергнутых нет
   * вовсе (носителей не больше потолка), и рампе не от чего отсчитывать: все
   * отобранные горят авторской силой.
   */
  private cut = Number.NEGATIVE_INFINITY;

  // Переиспользуемое хозяйство кадра: аллокаций пропорционально носителям нет.
  private readonly pose: LightCarrierPose = emptyPose();
  private readonly quat = new THREE.Quaternion();
  private readonly at = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();

  /** Сцена подсистемы: до неё источникам некуда встать (REND-8). */
  init(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /**
   * Снос (REND-31, design D6): источники обоих пулов уходят из сцены вместе с
   * целями конусов, реестр носителей чистится. Сами носители принадлежат
   * подсистемам-владельцам инстансов — здесь освобождаются только ссылки на них.
   */
  dispose(): void {
    release(this.point);
    release(this.spot);
    this.carriers.clear();
    this.chosen.fill(null);
    this.lit = 0;
    this.scene = null;
  }

  /**
   * Носитель появился (REND-33); повторное объявление последствий не имеет.
   *
   * Пул его рода строится ЗДЕСЬ, а не на первом кадре: состав света входит в
   * ключ программы материала three, и прогрев презентации компилирует программы
   * ПОД СВЕТ НАСТОЯЩЕЙ СЦЕНЫ (`game/demo-ts/app/prewarm.ts`). Появись источники
   * позже прогрева — все прогретые программы пересобрались бы первым же кадром,
   * то есть ровно тем всплеском, ради снятия которого прогрев и заведён.
   * Регистрация носителей идёт доставкой набора (REND-18) — до первого кадра.
   */
  add(carrier: LightCarrier): void {
    this.carriers.add(carrier);
    if (carrier.light.type === 'spot') this.growSpot();
    else this.growPoint();
  }

  /** Носитель ушёл: снятый инстанс либо снятый переподачей блок (REND-17). */
  remove(carrier: LightCarrier): void {
    if (!this.carriers.delete(carrier)) return;
    // Погашенным слот станет ближайшим кадром; гасить его здесь незачем —
    // отбор всё равно идёт заново, и снятый носитель в него не попадёт.
    for (let i = 0; i < this.chosen.length; i++) {
      if (this.chosen[i] === carrier) this.chosen[i] = null;
    }
  }

  /** Носителей в сцене — вход счётчика стоимости и тестов. */
  get carrierCount(): number {
    return this.carriers.size;
  }

  /** Источников горело в последнем кадре (REND-33). */
  get activeCount(): number {
    return this.lit;
  }

  /** Источники пула — вход тестов: их числа и есть наблюдаемый свет. */
  get lights(): readonly (THREE.PointLight | THREE.SpotLight)[] {
    return [...this.point.map((slot) => slot.light), ...this.spot.map((slot) => slot.light)];
  }

  /**
   * Потолок ручки (QUAL-1). Смена — СОБЫТИЕ: уже созданные пулы пересоздаются
   * под новый размер, и перекомпиляция программ материалов, которой это стоит,
   * приходится на смену пресета, а не на кадр (design D2).
   */
  setCeiling(ceiling: number): void {
    const next = Math.max(0, Math.min(MAX_LOCAL_LIGHTS_LIMIT, Math.round(ceiling)));
    if (next === this.ceiling) return;
    this.ceiling = next;
    const hadPoint = this.point.length > 0;
    const hadSpot = this.spot.length > 0;
    release(this.point);
    release(this.spot);
    if (hadPoint) this.growPoint();
    if (hadSpot) this.growSpot();
    this.chosen.length = next;
    this.scores.length = next;
    this.keys.length = next;
    this.chosen.fill(null);
    this.lit = 0;
  }

  /**
   * Кадр пула (REND-33): отбор активных носителей и запись их чисел в слоты.
   * `camera` — камера кадра: точкой взгляда меряется важность источника (design
   * D3); её нет — точкой берётся центр арены, и отбор остаётся определённым.
   */
  updateFrame(camera: THREE.Camera | undefined, centerX: number, centerY: number): void {
    const cost = costSink();
    if (cost !== undefined) cost.lightingLocalCarriers += this.carriers.size;
    let count = 0;
    if (this.scene !== null && this.ceiling > 0 && this.carriers.size > 0) {
      this.aim(camera, centerX, centerY);
      count = this.select();
    }
    this.apply(count);
    this.lit = count;
    if (cost !== undefined) cost.lightingLocalActive += count;
  }

  /**
   * Точка взгляда камеры — пересечение её направления с плоскостью пола арены
   * (design D3). Камера, не смотрящая вниз (её нет вовсе, взгляд из-под пола,
   * взгляд в горизонт), точки на полу не даёт: тогда берётся центр арены —
   * величина, от кадра не зависящая, и отбор остаётся воспроизводимым (REND-33).
   */
  private aim(camera: THREE.Camera | undefined, centerX: number, centerY: number): void {
    this.focus.set(centerX, centerY, 0);
    if (camera === undefined) return;
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.dir);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    if (this.dir.z >= 0) return;
    const t = -this.eye.z / this.dir.z;
    if (!(t > 0)) return;
    this.focus.copy(this.eye).addScaledVector(this.dir, t);
  }

  /**
   * Отбор активных (REND-33, design D3): оценка носителя — расстояние от опоры
   * его источника до точки взгляда МИНУС граница действия источника, то есть
   * «насколько близко его свет подходит к тому, куда смотрит игрок». Меньше —
   * важнее. Тай-брейк — устойчивый ключ носителя, а не порядок обхода реестра:
   * повтор того же кадра обязан отобрать те же источники.
   *
   * Отбирается префикс длины потолка вставкой: потолок мал (единицы), и это
   * дешевле сортировки всего реестра — а главное, не аллоцирует.
   */
  private select(): number {
    const ceiling = this.ceiling;
    let count = 0;
    // Лучшая оценка среди ОТВЕРГНУТЫХ — вторая половина границы отбора. Она же
    // и есть «кто зажёгся бы следующим», а расстояние до неё — запас, по
    // которому считается рампа затухания (REND-33, design D3).
    let rejected = Number.POSITIVE_INFINITY;
    for (const carrier of this.carriers) {
      if (!carrier.pose(this.pose)) continue;
      this.anchor(carrier);
      const score = this.at.distanceTo(this.focus) - carrier.light.distance;
      const full = count === ceiling;
      const tail = full ? ceiling - 1 : count;
      if (full && !closer(score, carrier.key, this.scores[tail]!, this.keys[tail]!)) {
        rejected = Math.min(rejected, score);
        continue;
      }
      // Отобранный вытесняет последнего — вытесненный отвергнут наравне с теми,
      // кто в префикс не попал, и на границу претендует так же.
      if (full) rejected = Math.min(rejected, this.scores[tail]!);
      this.insert(carrier, score, tail);
      count = full ? count : count + 1;
    }
    this.cut = this.cutOf(count, rejected);
    return count;
  }

  /**
   * Граница отбора кадра — СЕРЕДИНА между оценкой последнего отобранного и
   * лучшей оценкой отвергнутого: ровно в ней два носителя меняются местами, и
   * рампа затухания обеих сторон обращается там в ноль. Отвергнутых не было —
   * границы не существует, и рампе не от чего отсчитывать.
   */
  private cutOf(count: number, rejected: number): number {
    if (count === 0 || !Number.isFinite(rejected)) return Number.NEGATIVE_INFINITY;
    return (this.scores[count - 1]! + rejected) / 2;
  }

  /**
   * Отобранный носитель — в префикс на своё место: менее важные сдвигаются
   * вправо, вытесненный (если префикс был полон) уходит из него совсем.
   * Вставкой, а не сортировкой всего реестра: потолок мал (единицы), и это и
   * дешевле, и не аллоцирует (design D3).
   */
  private insert(carrier: LightCarrier, score: number, at: number): void {
    let i = at;
    while (i > 0 && closer(score, carrier.key, this.scores[i - 1]!, this.keys[i - 1]!)) {
      this.scores[i] = this.scores[i - 1]!;
      this.keys[i] = this.keys[i - 1]!;
      this.chosen[i] = this.chosen[i - 1]!;
      i--;
    }
    this.scores[i] = score;
    this.keys[i] = carrier.key;
    this.chosen[i] = carrier;
  }

  /**
   * Доля авторской интенсивности отобранного носителя (REND-33): запас его
   * оценки до границы отбора, нормированный шириной рампы. Единица — носитель
   * уверенно в отборе, ноль — он ровно на границе и в этот момент меняется
   * местами со следующим кандидатом.
   *
   * Отвергнутых кадром нет — рампе не от чего отсчитывать: носителей не больше
   * потолка, гаснуть некому, и все горят авторской силой.
   */
  private fadeOf(index: number): number {
    if (!Number.isFinite(this.cut)) return 1;
    const margin = (this.cut - this.scores[index]!) / SELECTION_FADE_WORLD_UNITS;
    return margin <= 0 ? 0 : margin >= 1 ? 1 : margin;
  }

  /** Опора источника: позиция инстанса плюс смещение блока в его опоре (ASSET-16). */
  private anchor(carrier: LightCarrier): void {
    const light = carrier.light;
    const pose = this.pose;
    this.quat.set(pose.qx, pose.qy, pose.qz, pose.qw);
    this.at.set(light.offsetX, light.offsetY, light.offsetZ).applyQuaternion(this.quat);
    this.at.x += pose.x;
    this.at.y += pose.y;
    this.at.z += pose.z;
  }

  /**
   * Числа отобранных — в слоты пулов, остальные слоты гасятся. Роды считаются
   * порознь: у каждого свой пул, и слотов в нём столько же, сколько в потолке, —
   * отобранных одного рода больше потолка не бывает.
   */
  private apply(count: number): void {
    let points = 0;
    let spots = 0;
    for (let i = 0; i < count; i++) {
      const carrier = this.chosen[i];
      if (carrier?.pose(this.pose) !== true) continue;
      this.anchor(carrier);
      // Доля рампы у границы отбора (design D3): без неё источник на границе
      // рейтинга переключался бы скачком от панорамы камеры.
      const fade = this.fadeOf(i);
      if (carrier.light.type === 'spot') {
        this.lightSpot(spots++, carrier, fade);
      } else {
        this.lightPoint(points++, carrier, fade);
      }
    }
    dim(this.point, points);
    dim(this.spot, spots);
  }

  /** Точечный источник слота: позиция, тон и числа блока (ASSET-16). */
  private lightPoint(index: number, carrier: LightCarrier, fade: number): void {
    if (this.point.length === 0) this.growPoint();
    const slot = this.point[index];
    if (slot === undefined) return;
    const light = carrier.light;
    slot.light.position.copy(this.at);
    paint(slot, light.color);
    slot.light.intensity = light.intensity * fade;
    slot.light.distance = light.distance;
    slot.light.decay = light.decay;
  }

  /** Конус слота: то же плюс направление, угол и полутень (ASSET-16). */
  private lightSpot(index: number, carrier: LightCarrier, fade: number): void {
    if (this.spot.length === 0) this.growSpot();
    const slot = this.spot[index];
    if (slot === undefined) return;
    const light = carrier.light;
    slot.light.position.copy(this.at);
    paint(slot, light.color);
    slot.light.intensity = light.intensity * fade;
    slot.light.distance = light.distance;
    slot.light.decay = light.decay;
    slot.light.angle = light.angleRad;
    slot.light.penumbra = light.penumbra;
    // Направление конуса задано в опоре инстанса: цель — точка перед источником
    // по повёрнутому направлению блока. Матрица цели обновляется здесь же —
    // иначе three взял бы её позу прошлого кадра.
    this.dir.set(light.directionX, light.directionY, light.directionZ).applyQuaternion(this.quat);
    slot.light.target.position.copy(this.at).add(this.dir);
    slot.light.target.updateMatrixWorld();
  }

  /**
   * Пул точечных источников на весь потолок — строится по первому носителю
   * этого рода: одна перекомпиляция программ материалов на появление первого
   * точечного носителя сцены, и ни одной дальше (design D2).
   */
  private growPoint(): void {
    const scene = this.scene;
    if (scene === null) return;
    for (let i = this.point.length; i < this.ceiling; i++) {
      const light = new THREE.PointLight();
      light.name = `lighting:local-point:${i}`;
      // Неактивный слот не светит и теней не отбрасывает (REND-33, REND-30):
      // `castShadow` здесь не поднимается ни при каких значениях блока.
      light.intensity = 0;
      light.castShadow = false;
      scene.add(light);
      this.point.push({ light, color: '' });
    }
  }

  /** То же для конусов; цель конуса — объект сцены, иначе три не видит его позы. */
  private growSpot(): void {
    const scene = this.scene;
    if (scene === null) return;
    for (let i = this.spot.length; i < this.ceiling; i++) {
      const light = new THREE.SpotLight();
      light.name = `lighting:local-spot:${i}`;
      light.intensity = 0;
      light.castShadow = false;
      scene.add(light);
      scene.add(light.target);
      this.spot.push({ light, color: '' });
    }
  }
}

/** Источники пула — из сцены и в отвал (REND-31): пул пересоздаётся целиком. */
function release(pool: AnySlot[]): void {
  for (const slot of pool) {
    if (slot.light instanceof THREE.SpotLight) slot.light.target.removeFromParent();
    slot.light.removeFromParent();
    slot.light.dispose();
  }
  pool.length = 0;
}

/**
 * Носитель `a` важнее носителя `b` (design D3): меньшая оценка, а при равных
 * оценках — меньший ключ. Тай-брейк по ключу, а не по порядку обхода реестра:
 * два одинаково удалённых факела не должны меняться местами от того, в каком
 * порядке их сегодня перечисляет `Set`. Что обещает сам ключ и чего не обещает
 * — у его владельца (`subsystems/models.ts`, `lightCarrierKey`).
 */
function closer(score: number, key: string, other: number, otherKey: string): boolean {
  if (score !== other) return score < other;
  return key < otherKey;
}

/** Тон слота — только на смене строки: разбор `#rrggbb` аллоцирует (PERF-3). */
function paint(slot: AnySlot, color: string): void {
  if (slot.color === color) return;
  slot.light.color.set(color);
  slot.color = color;
}

/** Слоты пула от `from` и дальше — погашены: неактивный слот не светит (design D2). */
function dim(pool: readonly AnySlot[], from: number): void {
  for (let i = from; i < pool.length; i++) pool[i]!.light.intensity = 0;
}
