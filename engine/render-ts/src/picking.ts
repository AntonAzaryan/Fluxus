/* eslint-disable max-lines -- baseline */
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
 * Согласованность с картинкой достигается тем, что второго источника данных не
 * заведено, а не аккуратностью настроек:
 *
 * - луч строится общей реализацией посадки позы на камеру (`applyCameraPose`,
 *   CAM-1) — той же, которой кадр и нарисован;
 * - поверхность — `VisualSurface` (REND-9), то самое поле высот, по которому
 *   построена геометрия террейна;
 * - объект — объём-прокси инстанса, преобразованный НЕ повторным расчётом позы,
 *   а МАТРИЦЕЙ ТОГО ЖЕ УЗЛА, который подсистема моделей поставила в кадре
 *   (посадка на поверхность REND-9, вертикальное смещение REND-12, наклон
 *   REND-10, курс с поправкой переда REND-13, масштаб REND-11 — всё уже в ней).
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
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import { applyCameraPose } from './camera/apply.js';
import type { CameraPose } from './camera/rig.js';
import type { VisualSurfaceSource } from './surfaceSource.js';
import type { VisualSurface } from './visualSurface.js';

// ------------------------------------------------------------------- прокси

/**
 * Объём-прокси участника picking'а: узел ВИДИМОГО преобразования и габариты в
 * его локальных осях. Запись переиспользуется источником, поэтому читать её
 * можно только внутри визита — по образцу `TickResult` ядра (OBS-3).
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
  /** Узел, чьей мировой матрицей инстанс или ручка нарисованы. */
  node: THREE.Object3D;
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
    node: EMPTY_NODE,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
  };
}

/** Узел-пустышка новой записи; попадания не даёт — объём вырожден. */
const EMPTY_NODE = new THREE.Object3D();

// -------------------------------------------------------------- контракты

/**
 * Точка вьюпорта: положение указателя относительно левого верхнего угла
 * прямоугольника и его размеры, пиксели. Прямоугольник — вход луча наравне с
 * позой: без него неизвестно соотношение сторон (REND-15).
 */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Мировой луч picking'а; направление единичное. */
export interface PickRay {
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
}

export function createPickRay(): PickRay {
  return { originX: 0, originY: 0, originZ: 0, dirX: 0, dirY: 0, dirZ: 0 };
}

/** Во что разрешился курсор (REND-15). */
export type PickKind = 'handle' | 'entity' | 'surface';

/**
 * Попадание. Объект переиспользуется сервисом и валиден до следующего запроса —
 * потребитель, которому нужно пережить кадр, копирует нужные поля.
 */
export interface PickHit {
  readonly kind: PickKind;
  /** Ручка наложения; null — попадание не в ручку. */
  readonly handle: string | null;
  /** Сущность presentation-состояния; 0 — попадание не в объект. Ключ документа даёт `DocumentSource.keyOf` (REND-11). */
  readonly entity: EntityId;
  /**
   * Попадание пришлось на decoration-инстанс (REND-18): ключ документа тогда
   * даёт `DecorationSet.keyOf`, а не документный источник, — наборы разные, и
   * нумерация у них своя.
   */
  readonly decoration: boolean;
  /** Расстояние по лучу от точки наблюдения, мировые единицы. */
  readonly distance: number;
  /** Мировая точка попадания, float (REND-1). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Индекс клетки сетки; -1 — попадание не в поверхность. Целое число сетки, не fixed-point. */
  readonly cell: number;
  readonly cellX: number;
  readonly cellY: number;
  /** В клетке нет пола (REND-7): дыра, но клетка — кисть пола ED-10 в неё попадает. */
  readonly noFloor: boolean;
  /** Попадание пришлось на вертикальную стенку обрыва; клетка — верхняя (REND-7). */
  readonly wall: boolean;
}

/** Внутренняя мутабельная форма `PickHit`. */
interface MutablePickHit {
  kind: PickKind;
  handle: string | null;
  entity: EntityId;
  decoration: boolean;
  distance: number;
  x: number;
  y: number;
  z: number;
  cell: number;
  cellX: number;
  cellY: number;
  noFloor: boolean;
  wall: boolean;
}

export interface ViewportPickingOptions {
  /** Источник визуальной поверхности (REND-9): поле высот берётся текущее, а не захваченное. */
  readonly surface: VisualSurfaceSource;
  /** Прокси нарисованных инстансов — подсистема моделей (REND-15). */
  readonly instances?: PickProxySource;
  /** Прокси ручек служебных наложений — подсистема наложений (REND-16). */
  readonly handles?: PickProxySource;
  /**
   * Камера вьюпорта. По умолчанию сервис заводит свою: позу на неё сажает та же
   * общая реализация (CAM-1), поэтому луч совпадает с нарисованным кадром и
   * так; передать свою полезно, чтобы объект был буквально один.
   */
  readonly camera?: THREE.PerspectiveCamera;
  /** Подшагов на клетку при марше по полю высот; меньше — грубее на выпуклостях. */
  readonly cellSteps?: number;
}

// ------------------------------------------------------------------ числа

/** Направление считается вырожденным по оси ниже этого модуля. */
const EPS_DIR = 1e-12;
/**
 * Насколько глубоко под поверхностью клетки должен оказаться луч на её границе,
 * чтобы попадание считалось стенкой обрыва, а не касанием пола на стыке.
 */
const WALL_EPS = 1e-6;
const DEFAULT_CELL_STEPS = 4;
/** Итераций уточнения корня внутри клетки: 24 деления отрезка клетки пополам. */
const REFINE_ITERATIONS = 24;

// ---------------------------------------------------------------- сервис

export class ViewportPicking {
  private readonly options: ViewportPickingOptions;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cellSteps: number;

  /** Переиспользуемые: луч, попадание и скретчи преобразования прокси. */
  private readonly rayScratch: PickRay = createPickRay();
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
  private readonly unprojected = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  private readonly localOrigin = new THREE.Vector3();
  private readonly localTip = new THREE.Vector3();

  /** Состояние поиска ближайшего прокси — поля, а не замыкание: визит зовётся на каждый инстанс. */
  private searchRay: PickRay = this.rayScratch;
  private bestT = Number.POSITIVE_INFINITY;
  private bestEntity: EntityId = 0;
  private bestDecoration = false;
  private bestHandle: string | null = null;

  /** Визитор источника прокси; создан один раз — аллокаций в пути наведения нет. */
  private readonly visitProxy: PickProxyVisitor = (proxy: PickProxy): void => {
    const t = this.intersectProxy(this.searchRay, proxy);
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
    this.camera = options.camera ?? new THREE.PerspectiveCamera();
    this.cellSteps = Math.max(1, Math.floor(options.cellSteps ?? DEFAULT_CELL_STEPS));
  }

  /**
   * Мировой луч из позы камеры и точки вьюпорта (CAM-1). Второго способа его
   * посчитать нет: позу на камеру сажает `applyCameraPose` — та же функция, что
   * рисует кадр (REND-15). Возвращаемый объект переиспользуется.
   */
  ray(pose: CameraPose, point: ViewportPoint, out: PickRay = this.rayScratch): PickRay {
    const camera = this.camera;
    const aspect = point.height === 0 ? 1 : point.width / point.height;
    const aspectChanged = camera.aspect !== aspect;
    if (aspectChanged) camera.aspect = aspect;
    applyCameraPose(camera, pose);
    // `applyCameraPose` пересчитывает проекцию только на смену FOV — соотношение
    // сторон вьюпорта её собственный вход, и его смену закрывает вызывающий.
    if (aspectChanged) camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const ndcX = point.width === 0 ? 0 : (point.x / point.width) * 2 - 1;
    const ndcY = point.height === 0 ? 0 : 1 - (point.y / point.height) * 2;
    this.unprojected.set(ndcX, ndcY, 0.5).unproject(camera);

    const ox = camera.position.x;
    const oy = camera.position.y;
    const oz = camera.position.z;
    const dx = this.unprojected.x - ox;
    const dy = this.unprojected.y - oy;
    const dz = this.unprojected.z - oz;
    const length = Math.hypot(dx, dy, dz) || 1;
    out.originX = ox;
    out.originY = oy;
    out.originZ = oz;
    out.dirX = dx / length;
    out.dirY = dy / length;
    out.dirZ = dz / length;
    return out;
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
    return this.marchSurface(ray) ? this.hit : null;
  }

  /**
   * Только поверхность: кистям террейна (ED-10, ED-11) клетка нужна и тогда,
   * когда над ней стоит объект. Порядок разрешения этим не отменяется — им
   * пользуется `pick`, а инструмент вправе спросить именно поверхность.
   */
  pickSurface(pose: CameraPose, point: ViewportPoint): PickHit | null {
    return this.marchSurface(this.ray(pose, point)) ? this.hit : null;
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
   * Пересечение луча с объёмом прокси. Луч переводится в локальные оси УЗЛА, то
   * есть той матрицей, которой узел и нарисован: позы инстанса здесь не
   * вычисляются заново — ни посадки на поверхность, ни наклона, ни курса.
   * Параметр `t` при этом остаётся мировым: направление переводится как вектор
   * без нормировки, поэтому шкала параметра сохраняется.
   */
  private intersectProxy(ray: PickRay, proxy: PickProxy): number {
    const node = proxy.node;
    // Мировые матрицы обновляет рендерер перед отрисовкой; наведение спрашивают
    // и между кадрами, поэтому матрица узла подтягивается из его же позы.
    node.updateWorldMatrix(true, false);
    this.inverse.copy(node.matrixWorld).invert();
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

    let tMin = 0;
    let tMax = Number.POSITIVE_INFINITY;
    // Слэбы по трём осям; вырожденная по оси коробка отсекает всё, что не лежит
    // ровно в её плоскости, — и это верно: рисовать там нечего.
    if (Math.abs(dx) < EPS_DIR) {
      if (ox < proxy.minX || ox > proxy.maxX) return -1;
    } else {
      let t1 = (proxy.minX - ox) / dx;
      let t2 = (proxy.maxX - ox) / dx;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
    }
    if (Math.abs(dy) < EPS_DIR) {
      if (oy < proxy.minY || oy > proxy.maxY) return -1;
    } else {
      let t1 = (proxy.minY - oy) / dy;
      let t2 = (proxy.maxY - oy) / dy;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
    }
    if (Math.abs(dz) < EPS_DIR) {
      if (oz < proxy.minZ || oz > proxy.maxZ) return -1;
    } else {
      let t1 = (proxy.minZ - oz) / dz;
      let t2 = (proxy.maxZ - oz) / dz;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
    }
    return tMin > tMax ? -1 : tMin;
  }

  // --------------------------------------------------------- поверхность

  /**
   * Марш луча по полю высот визуальной поверхности (REND-9): по клеткам, с
   * уточнением корня внутри клетки. Поверхность и сетка читаются ТЕКУЩИЕ —
   * правка кистью меняет ответ, пересоздания сервиса для этого не требуется.
   *
   * Вход в клетку, чья поверхность уже выше луча, — это пересечение вертикальной
   * стенки обрыва: попадание разрешается в ЭТУ клетку, то есть в верхнюю, чью
   * площадку стенка подпирает (REND-7, REND-15).
   */
  private marchSurface(ray: PickRay): boolean {
    const source = this.options.surface;
    const surface = source.current;
    if (surface === null) return false;
    const grid = source.terrain;
    // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
    const tile = grid.tileSize / FIXED_ONE;
    const spanX = grid.width * tile;
    const spanY = grid.height * tile;

    // Луч обрезается прямоугольником арены: клеток вне сетки не нарисовано.
    let tEnter = 0;
    let tExit = Number.POSITIVE_INFINITY;
    if (Math.abs(ray.dirX) < EPS_DIR) {
      if (ray.originX < 0 || ray.originX > spanX) return false;
    } else {
      let t1 = (0 - ray.originX) / ray.dirX;
      let t2 = (spanX - ray.originX) / ray.dirX;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
    }
    if (Math.abs(ray.dirY) < EPS_DIR) {
      if (ray.originY < 0 || ray.originY > spanY) return false;
    } else {
      let t1 = (0 - ray.originY) / ray.dirY;
      let t2 = (spanY - ray.originY) / ray.dirY;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
    }
    if (tEnter > tExit) return false;

    let t = tEnter;
    let px = ray.originX + ray.dirX * t;
    let py = ray.originY + ray.dirY * t;
    let cx = clampIndex(Math.floor(px / tile), grid.width);
    let cy = clampIndex(Math.floor(py / tile), grid.height);
    let f = ray.originZ + ray.dirZ * t - surface.heightInCell(cx, cy, px, py);
    if (f <= 0) {
      this.writeSurfaceHit(ray, t, cx, cy, f < -WALL_EPS);
      return true;
    }

    const stepX = ray.dirX > EPS_DIR ? 1 : ray.dirX < -EPS_DIR ? -1 : 0;
    const stepY = ray.dirY > EPS_DIR ? 1 : ray.dirY < -EPS_DIR ? -1 : 0;
    if (stepX === 0 && stepY === 0) {
      // Отвесный луч клетки не меняет: высота под ним постоянна, и корень
      // находится прямо, без марша. Отдельная ветка нужна ещё и потому, что
      // прямоугольник арены такой луч не ограничивает — выхода из него нет.
      if (ray.dirZ >= 0) return false;
      const t = (surface.heightInCell(cx, cy, px, py) - ray.originZ) / ray.dirZ;
      this.writeSurfaceHit(ray, t, cx, cy, false);
      return true;
    }
    const deltaX = stepX === 0 ? Number.POSITIVE_INFINITY : tile / Math.abs(ray.dirX);
    const deltaY = stepY === 0 ? Number.POSITIVE_INFINITY : tile / Math.abs(ray.dirY);
    let nextX =
      stepX === 0
        ? Number.POSITIVE_INFINITY
        : t + ((cx + (stepX > 0 ? 1 : 0)) * tile - px) / ray.dirX;
    let nextY =
      stepY === 0
        ? Number.POSITIVE_INFINITY
        : t + ((cy + (stepY > 0 ? 1 : 0)) * tile - py) / ray.dirY;

    // Клеток вдоль луча не больше периметра арены; запас закрывает вырожденные
    // случаи вроде входа ровно в узел сетки.
    const maxSteps = grid.width + grid.height + 4;
    for (let step = 0; step < maxSteps; step++) {
      const tNext = Math.min(nextX, nextY, tExit);
      let tPrev = t;
      // Подшаги: вдоль отрезка внутри клетки высота — квадратичная, и выпуклость
      // может уйти под луч и вернуться между концами отрезка.
      for (let i = 1; i <= this.cellSteps; i++) {
        const ts = t + ((tNext - t) * i) / this.cellSteps;
        px = ray.originX + ray.dirX * ts;
        py = ray.originY + ray.dirY * ts;
        const fs = ray.originZ + ray.dirZ * ts - surface.heightInCell(cx, cy, px, py);
        if (fs <= 0) {
          const tHit = this.refine(ray, surface, cx, cy, tPrev, ts);
          this.writeSurfaceHit(ray, tHit, cx, cy, false);
          return true;
        }
        tPrev = ts;
      }
      if (tNext >= tExit) return false;

      if (nextX <= nextY) {
        cx += stepX;
        t = nextX;
        nextX += deltaX;
      } else {
        cy += stepY;
        t = nextY;
        nextY += deltaY;
      }
      if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;

      px = ray.originX + ray.dirX * t;
      py = ray.originY + ray.dirY * t;
      f = ray.originZ + ray.dirZ * t - surface.heightInCell(cx, cy, px, py);
      if (f <= 0) {
        this.writeSurfaceHit(ray, t, cx, cy, f < -WALL_EPS);
        return true;
      }
    }
    return false;
  }

  /** Деление пополам между точкой над поверхностью и точкой под ней. */
  private refine(
    ray: PickRay,
    surface: VisualSurface,
    cx: number,
    cy: number,
    tAbove: number,
    tBelow: number,
  ): number {
    let lo = tAbove;
    let hi = tBelow;
    for (let i = 0; i < REFINE_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      const mx = ray.originX + ray.dirX * mid;
      const my = ray.originY + ray.dirY * mid;
      if (ray.originZ + ray.dirZ * mid - surface.heightInCell(cx, cy, mx, my) > 0) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /** Попадание в поверхность: точка, клетка, признак отсутствия пола (REND-15). */
  private writeSurfaceHit(
    ray: PickRay,
    t: number,
    cx: number,
    cy: number,
    wall: boolean,
  ): void {
    const grid = this.options.surface.terrain;
    const cell = cy * grid.width + cx;
    const hit = this.hit;
    hit.kind = 'surface';
    hit.handle = null;
    hit.entity = 0;
    hit.decoration = false;
    hit.distance = t;
    hit.x = ray.originX + ray.dirX * t;
    hit.y = ray.originY + ray.dirY * t;
    hit.z = ray.originZ + ray.dirZ * t;
    hit.cell = cell;
    hit.cellX = cx;
    hit.cellY = cy;
    // Дыра — клетка сетки, а не отсутствие клетки: кисть пола ED-10 в неё бьёт.
    hit.noFloor = grid.floor[cell] === 0;
    hit.wall = wall;
  }
}

function clampIndex(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size - 1);
}
