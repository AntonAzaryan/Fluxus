/**
 * Picking вьюпорта (REND-15): разрешение точки экрана в то, что автор видит под
 * курсором, — ручку служебного наложения (REND-16), размещённый объект или
 * точку поверхности террейна.
 *
 * Сервис лежит целиком ЗА входной границей рендера (REND-1): поза камеры,
 * визуальная поверхность и presentation-состояние — уже float, поэтому конверсии
 * Q16.16 у picking'а нет нигде, кроме приёма сетки (`tileSize`). Обратной
 * конверсии тоже нет: мировая точка отдаётся во float, а квантование авторской
 * величины в валидный fixed-point делает редактор вызовом ядра (ED-1, ED-16).
 * Индекс клетки — целое число сетки, а не Q16.16-величина.
 *
 * Луч и поверхностная ветвь у сервиса НЕ СВОИ: их даёт проекция курсора
 * (`cursorSurface.ts`, REND-42) — тот же вопрос «где под курсором поверхность»
 * задаёт и потребитель кадра, у которого ни ручек, ни документного слоя нет
 * вовсе. Picking надстраивает над ней порядок разрешения и прокси; редакторным
 * (REND-15) остаётся он, а не общая под ним проекция.
 *
 * Согласованность с картинкой достигается тем, что второго источника данных не
 * заведено, а не аккуратностью настроек:
 *
 * - луч строится общей реализацией посадки позы на камеру (`applyCameraPose`,
 *   CAM-1) — той же, которой кадр и нарисован;
 * - поверхность — `VisualSurface` (REND-9), то самое поле высот, по которому
 *   построена геометрия террейна;
 * - объект — объём-прокси инстанса, преобразованный НЕ повторным расчётом позы,
 *   а ТЕМ ЖЕ ПРЕОБРАЗОВАНИЕМ, которым подсистема моделей нарисовала его в кадре
 *   (посадка на поверхность REND-9, вертикальное смещение REND-12, наклон
 *   REND-10, курс с поправкой переда REND-13, масштаб REND-11 — всё уже в нём).
 *
 * Детерминированный raycast ядра (PHYS-6) здесь не используется намеренно: он
 * считает по коллайдерам симуляционного мира, которого в режиме правки нет
 * (ED-15), decorations в нём отсутствуют (ED-19), а кривизны он не видит
 * (REND-9) — попадание по нему расходилось бы с изображением.
 *
 * Аллокаций на кадр в пути наведения нет: луч, попадание, скретч-векторы и
 * запись прокси переиспользуются между вызовами.
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { CameraPose } from './camera/rig.js';
import type { VisualSurfaceSource } from './surfaceSource.js';
import { CursorSurface } from './cursorSurface.js';
import type {
  MutablePickHit,
  PickHit,
  PickKind,
  PickRay,
  ViewportPoint,
} from './pickContracts.js';
import { SLAB_RANGE, slabAxis } from './slab.js';

// ------------------------------------------------------------------- прокси

/**
 * Объём-прокси участника picking'а: ВИДИМОЕ ПРЕОБРАЗОВАНИЕ и габариты в его
 * локальных осях. Запись переиспользуется источником, поэтому читать её можно
 * только внутри визита — по образцу `TickResult` ядра (OBS-3).
 *
 * Преобразование приходит числами (позиция, кватернион, масштаб), а не узлом
 * сцены: узел — представление инстанса детального яруса, и у батчевой записи
 * (REND-20) его не существует вовсе. Публичный контракт рендера узлов конкретной
 * библиотеки не отдаёт (REND-3); алгоритм пересечения от этого не меняется —
 * матрица собирается из тех же величин, которыми объект нарисован.
 */
export interface PickProxy {
  /** Сущность presentation-состояния; 0 — прокси не сущности, а ручки. */
  entity: EntityId;
  /**
   * Прокси decoration-инстанса (REND-18), а не сущности presentation-состояния.
   * Нумерация у двух наборов своя, поэтому одного `entity` для адресации
   * попадания недостаточно — без признака ключ искали бы не в том наборе.
   */
  decoration: boolean;
  /** Идентичность ручки наложения (REND-16); null — прокси инстанса. */
  handle: string | null;
  /** Позиция видимого преобразования, мировые оси. */
  posX: number;
  posY: number;
  posZ: number;
  /** Кватернион видимого преобразования `(x, y, z, w)`. */
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  /** Масштаб видимого преобразования по осям. */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export type PickProxyVisitor = (proxy: PickProxy) => void;

/** Источник объёмов-прокси: подсистема, которая эти объекты и рисует. */
export interface PickProxySource {
  /** Обходит прокси нарисованного в порядке набора (REND-15). */
  eachProxy(visit: PickProxyVisitor): void;
}

/**
 * Источник прокси инстансов — дополнительно умеет отдать прокси одной сущности.
 * Им пользуется подсветка выделения (REND-16): рамка обязана стоять там же, где
 * нарисован инстанс.
 */
export interface InstanceProxySource extends PickProxySource {
  /**
   * Прокси инстанса в out; false — рендер его не рисует, выделять нечего.
   * `decoration` выбирает набор (REND-18): без него подсветка декорации встала
   * бы на сущность presentation-состояния с тем же номером.
   */
  proxyOf(entity: EntityId, out: PickProxy, decoration?: boolean): boolean;
}

/** Пустая запись прокси — источники заполняют её на каждый визит. */
export function createPickProxy(): PickProxy {
  return {
    entity: 0,
    decoration: false,
    handle: null,
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
  };
}

export interface ViewportPickingOptions {
  /** Источник визуальной поверхности (REND-9): поле высот берётся текущее, а не захваченное. */
  readonly surface: VisualSurfaceSource;
  /** Прокси нарисованных инстансов — подсистема моделей (REND-15). */
  readonly instances?: PickProxySource;
  /** Прокси ручек служебных наложений — подсистема наложений (REND-16). */
  readonly handles?: PickProxySource;
  /**
   * Камера вьюпорта — уезжает проекции курсора (REND-42), которая луч и строит.
   * По умолчанию она заводит свою, с МИРОВЫМ верхом сцены (0, 0, 1); передать
   * свою полезно, чтобы объект был буквально один, и тогда её верх — дело
   * вызывающего: луч обязан совпадать с ТОЙ камерой, которой нарисован кадр
   * (REND-15).
   */
  readonly camera?: THREE.PerspectiveCamera;
  /** Подшагов на клетку при марше по полю высот; меньше — грубее на выпуклостях. */
  readonly cellSteps?: number;
}

// ---------------------------------------------------------------- сервис

export class ViewportPicking {
  private readonly options: ViewportPickingOptions;
  /**
   * Общая проекция курсора (REND-42): ею считаются и луч, и попадание в
   * поверхность. Своих камеры и марша у сервиса нет — вторая их пара разошлась
   * бы с первой ровно так же, как разошёлся бы с кадром луч по «почти той же»
   * позе (REND-15).
   */
  private readonly cursor: CursorSurface;

  /** Переиспользуемое попадание и скретчи преобразования прокси. */
  private readonly hit: MutablePickHit = {
    kind: 'surface',
    handle: null,
    entity: 0,
    decoration: false,
    distance: 0,
    x: 0,
    y: 0,
    z: 0,
    cell: -1,
    cellX: -1,
    cellY: -1,
    noFloor: false,
    wall: false,
  };
  private readonly inverse = new THREE.Matrix4();
  private readonly localOrigin = new THREE.Vector3();
  private readonly localTip = new THREE.Vector3();
  /** Скретчи сборки матрицы прокси из его преобразования; между вызовами живут. */
  private readonly proxyPosition = new THREE.Vector3();
  private readonly proxyQuaternion = new THREE.Quaternion();
  private readonly proxyScale = new THREE.Vector3();

  /** Состояние поиска ближайшего прокси — поля, а не замыкание: визит зовётся на каждый инстанс. */
  private searchRay: PickRay | null = null;
  private bestT = Number.POSITIVE_INFINITY;
  private bestEntity: EntityId = 0;
  private bestDecoration = false;
  private bestHandle: string | null = null;

  /** Визитор источника прокси; создан один раз — аллокаций в пути наведения нет. */
  private readonly visitProxy: PickProxyVisitor = (proxy: PickProxy): void => {
    const ray = this.searchRay;
    if (ray === null) return;
    const t = this.intersectProxy(ray, proxy);
    // Побеждает ближайший; при равной дистанции — первый в порядке набора
    // (REND-15). Порядок обхода задаёт источник, и он же ставит decoration-
    // инстансы после инстансов presentation-состояния (REND-18).
    if (t < 0 || t >= this.bestT) return;
    this.bestT = t;
    this.bestEntity = proxy.entity;
    this.bestDecoration = proxy.decoration;
    this.bestHandle = proxy.handle;
  };

  constructor(options: ViewportPickingOptions) {
    this.options = options;
    this.cursor = new CursorSurface({
      surface: options.surface,
      ...(options.camera !== undefined ? { camera: options.camera } : {}),
      ...(options.cellSteps !== undefined ? { cellSteps: options.cellSteps } : {}),
    });
  }

  /**
   * Мировой луч из позы камеры и точки вьюпорта (CAM-1) — общей проекцией
   * курсора (REND-42). Второго способа его посчитать нет: позу на камеру сажает
   * `applyCameraPose`, та же функция, что рисует кадр. Возвращаемый объект
   * переиспользуется.
   */
  ray(pose: CameraPose, point: ViewportPoint, out?: PickRay): PickRay {
    return out === undefined ? this.cursor.ray(pose, point) : this.cursor.ray(pose, point, out);
  }

  /**
   * Разрешает курсор: ручки наложений → размещённые объекты → поверхность
   * (REND-15). Ручки идут первыми независимо от дистанции — gizmo нарисован
   * поверх кадра, и ручка, закрытая объектом позади, была бы бесполезна.
   * Результат — переиспользуемый объект, валидный до следующего запроса; null —
   * курсор не пришёлся ни на что нарисованное.
   */
  pick(pose: CameraPose, point: ViewportPoint): PickHit | null {
    const ray = this.ray(pose, point);
    if (this.pickProxies(ray, this.options.handles, 'handle')) return this.hit;
    if (this.pickProxies(ray, this.options.instances, 'entity')) return this.hit;
    return this.pickSurfaceRay(ray) ? this.hit : null;
  }

  /**
   * Только поверхность: кистям террейна (ED-10, ED-11) клетка нужна и тогда,
   * когда над ней стоит объект. Порядок разрешения этим не отменяется — им
   * пользуется `pick`, а инструмент вправе спросить именно поверхность.
   * Walkable-поверхность — часть поверхности (REND-15): кисть по настилу
   * попадает в настил, а не в лощину под ним.
   */
  pickSurface(pose: CameraPose, point: ViewportPoint): PickHit | null {
    return this.pickSurfaceRay(this.ray(pose, point)) ? this.hit : null;
  }

  /**
   * Попадание в поверхность — общей проекцией курсора (REND-42): min-t марша по
   * террейн-форме и рейкаста по walkable-мешам. Пишется в ЭТУ запись — ту же,
   * которую заполняют ветви прокси, поэтому `pick` отдаёт один объект, каким бы
   * ни оказалось попадание.
   */
  private pickSurfaceRay(ray: PickRay): boolean {
    return this.cursor.pickRay(ray, this.hit);
  }

  // ------------------------------------------------------------- прокси

  /** Ближайший прокси источника; заполняет попадание и возвращает true. */
  private pickProxies(
    ray: PickRay,
    source: PickProxySource | undefined,
    kind: PickKind,
  ): boolean {
    if (source === undefined) return false;
    this.searchRay = ray;
    this.bestT = Number.POSITIVE_INFINITY;
    this.bestEntity = 0;
    this.bestDecoration = false;
    this.bestHandle = null;
    source.eachProxy(this.visitProxy);
    if (!Number.isFinite(this.bestT)) return false;

    const hit = this.hit;
    hit.kind = kind;
    hit.handle = this.bestHandle;
    hit.entity = this.bestEntity;
    hit.decoration = this.bestDecoration;
    hit.distance = this.bestT;
    hit.x = ray.originX + ray.dirX * this.bestT;
    hit.y = ray.originY + ray.dirY * this.bestT;
    hit.z = ray.originZ + ray.dirZ * this.bestT;
    hit.cell = -1;
    hit.cellX = -1;
    hit.cellY = -1;
    hit.noFloor = false;
    hit.wall = false;
    return true;
  }

  /**
   * Пересечение луча с объёмом прокси. Луч переводится в ЛОКАЛЬНЫЕ ОСИ ПРОКСИ —
   * матрицей, собранной из того самого преобразования, которым объект нарисован:
   * позы инстанса здесь не вычисляются заново — ни посадки на поверхность, ни
   * наклона, ни курса. Параметр `t` при этом остаётся мировым: направление
   * переводится как вектор без нормировки, поэтому шкала параметра сохраняется.
   *
   * Алгоритм — тот же слэбовый тест AABB, что и до перехода прокси с узла сцены
   * на преобразование: сменился источник матрицы, а не пересечение (REND-15).
   */
  private intersectProxy(ray: PickRay, proxy: PickProxy): number {
    this.proxyPosition.set(proxy.posX, proxy.posY, proxy.posZ);
    this.proxyQuaternion.set(proxy.quatX, proxy.quatY, proxy.quatZ, proxy.quatW);
    this.proxyScale.set(proxy.scaleX, proxy.scaleY, proxy.scaleZ);
    this.inverse.compose(this.proxyPosition, this.proxyQuaternion, this.proxyScale).invert();
    this.localOrigin.set(ray.originX, ray.originY, ray.originZ).applyMatrix4(this.inverse);
    this.localTip
      .set(ray.originX + ray.dirX, ray.originY + ray.dirY, ray.originZ + ray.dirZ)
      .applyMatrix4(this.inverse);
    const ox = this.localOrigin.x;
    const oy = this.localOrigin.y;
    const oz = this.localOrigin.z;
    const dx = this.localTip.x - ox;
    const dy = this.localTip.y - oy;
    const dz = this.localTip.z - oz;
    // Вырожденное преобразование (нулевой масштаб набора или записи) необратимо,
    // и локальный луч приходит нечисловым: слэбы на NaN не отсекают ничего и
    // отдали бы попадание на нулевой дистанции — ближайшее из возможных.
    // Схлопнутый инстанс в кадре не виден, значит и попадать в него нечем
    // (REND-15).
    if (!Number.isFinite(ox + oy + oz + dx + dy + dz)) return -1;

    // Слэбы по трём осям; вырожденная по оси коробка отсекает всё, что не лежит
    // ровно в её плоскости, — и это верно: рисовать там нечего.
    SLAB_RANGE.tMin = 0;
    SLAB_RANGE.tMax = Number.POSITIVE_INFINITY;
    const inside =
      slabAxis(ox, dx, proxy.minX, proxy.maxX) &&
      slabAxis(oy, dy, proxy.minY, proxy.maxY) &&
      slabAxis(oz, dz, proxy.minZ, proxy.maxZ);
    if (!inside) return -1;
    return SLAB_RANGE.tMin > SLAB_RANGE.tMax ? -1 : SLAB_RANGE.tMin;
  }
}

