/**
 * Проекция курсора на визуальную поверхность (REND-42): точка вьюпорта → луч →
 * мировая точка на поле высот (REND-9).
 *
 * Отдельным сервисом, а не половиной picking'а, потому что потребителей у этого
 * вопроса два, а сервисов до сих пор был один. Игровому клиенту нужны ровно две
 * вещи — луч и точка пола под курсором; ручек наложений (REND-16), прокси
 * инстансов и порядка разрешения у него нет вовсе, а `ViewportPicking` — сервис
 * вьюпорта РЕДАКТОРА (REND-15). Поэтому общее ядро живёт здесь, а picking
 * надстраивает над ним своё: второй реализации марша по полю высот и второго
 * способа посчитать луч не появляется (REND-42, REND-15).
 *
 * Совпадение с картинкой держится тем же, чем у picking'а:
 *
 * - луч строит `applyCameraPose` (CAM-1) — та же функция, которой нарисован
 *   кадр; второго способа посадить позу на камеру нет;
 * - поверхность — `VisualSurface` (REND-9), то самое поле высот, по которому
 *   построена геометрия террейна; читается ТЕКУЩАЯ, поэтому правка кистью
 *   меняет ответ без пересоздания сервиса;
 * - walkable-часть поля проверяется теми же мешами и тем же преобразованием,
 *   какими walkable-инстансы нарисованы (ASSET-11).
 *
 * Всё здесь — float (REND-1): за входной границей рендера fixed-point не
 * существует, а квантование мировой точки делает её потребитель вызовом ядра.
 *
 * Аллокаций на кадр нет: луч, попадание и скретч проекции переиспользуются.
 */
import * as THREE from 'three';
import { FIXED_ONE } from '@fluxus/core';
import { applyCameraPose } from './camera/apply.js';
import type { CameraPose } from './camera/rig.js';
import type { VisualSurfaceSource } from './surfaceSource.js';
import {
  createPickRay,
  type MutablePickHit,
  type PickHit,
  type PickRay,
  type ViewportPoint,
} from './pickContracts.js';
import { SurfaceMarch, clampIndex, writeSurfaceHit } from './surfaceMarch.js';

/** Подшагов на клетку при марше по полю высот по умолчанию. */
export const DEFAULT_CURSOR_CELL_STEPS = 4;

export interface CursorSurfaceOptions {
  /** Источник визуальной поверхности (REND-9): поле высот берётся текущее, а не захваченное. */
  readonly surface: VisualSurfaceSource;
  /**
   * Камера, на которую садится поза. По умолчанию сервис заводит свою — с
   * МИРОВЫМ верхом сцены (0, 0, 1), тем же, который ставит своей камере всякая
   * сборка движка: позу сажает `applyCameraPose` через `lookAt` (CAM-1), а
   * `lookAt` строит крен из `camera.up`, и камера с верхом THREE по умолчанию
   * (0, 1, 0) дала бы луч, повёрнутый вокруг оси взгляда, — в центре вьюпорта
   * он совпал бы с нарисованным, а под курсором в углу разошёлся бы на десятки
   * градусов.
   *
   * Передать свою полезно, чтобы объект был буквально один; тогда её верх —
   * дело вызывающего: луч обязан совпадать с ТОЙ камерой, которой нарисован
   * кадр (REND-42). Камеру КАДРА при этом отдавать не следует, если проекция
   * считается между отсечением и рисованием: сервис переписывает соотношение
   * сторон и матрицы, то есть менял бы кадр под собой.
   */
  readonly camera?: THREE.PerspectiveCamera;
  /** Подшагов на клетку при марше по полю высот; меньше — грубее на выпуклостях. */
  readonly cellSteps?: number;
}

/**
 * Разрешение точки вьюпорта в точку визуальной поверхности (REND-42).
 * Результат — переиспользуемый объект, валидный до следующего запроса.
 */
export class CursorSurface {
  private readonly source: VisualSurfaceSource;
  private readonly cameraRef: THREE.PerspectiveCamera;
  private readonly march: SurfaceMarch;

  /** Переиспользуемые: луч, попадание и скретч обратной проекции. */
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

  constructor(options: CursorSurfaceOptions) {
    this.source = options.surface;
    if (options.camera === undefined) {
      // Своя камера — сразу в осях сцены: мир движка Z-up, и верх камеры кадра
      // всякая сборка ставит так же. Чужую камеру сервис не трогает: её оси —
      // дело вызывающего (REND-42).
      this.cameraRef = new THREE.PerspectiveCamera();
      this.cameraRef.up.set(0, 0, 1);
    } else {
      this.cameraRef = options.camera;
    }
    this.march = new SurfaceMarch(
      options.surface,
      Math.max(1, Math.floor(options.cellSteps ?? DEFAULT_CURSOR_CELL_STEPS)),
    );
  }

  /**
   * Мировой луч из позы камеры и точки вьюпорта (CAM-1). Второго способа его
   * посчитать нет: позу на камеру сажает `applyCameraPose` — та же функция, что
   * рисует кадр (REND-42). Возвращаемый объект переиспользуется.
   */
  ray(pose: CameraPose, point: ViewportPoint, out: PickRay = this.rayScratch): PickRay {
    const camera = this.cameraRef;
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
   * Точка поверхности под курсором (REND-42); null — луч не задел ни поля
   * высот, ни walkable-поверхности. Результат переиспользуется и валиден до
   * следующего запроса — потребитель, которому нужно пережить кадр, копирует
   * нужные поля.
   */
  project(pose: CameraPose, point: ViewportPoint): PickHit | null {
    return this.pickRay(this.ray(pose, point), this.hit) ? this.hit : null;
  }

  /**
   * Попадание в поверхность — min-t двух ветвей (REND-42, REND-15): марш по
   * террейн-форме и рейкаст по walkable-мешам тем же преобразованием, каким они
   * нарисованы (ASSET-11 — второй реализации пересечения с мешом нет).
   * Walkable-`t` ограничивает марш сверху: террейн-попадание дальше него
   * не ищется — побеждает walkable.
   *
   * Пишет в запись ВЫЗЫВАЮЩЕГО — та же форма, что у марша: у надстройки
   * (REND-15) запись своя, и второй её копии не заводится.
   */
  pickRay(ray: PickRay, hit: MutablePickHit): boolean {
    const tWalk = this.source.walkableRaycast(
      ray.originX, ray.originY, ray.originZ,
      ray.dirX, ray.dirY, ray.dirZ,
    );
    const limit = tWalk < 0 ? Number.POSITIVE_INFINITY : tWalk;
    if (this.march.pick(ray, hit, limit)) return true;
    if (tWalk < 0) return false;
    // Walkable-победа: surface-hit с клеткой сетки ПОД мировой точкой попадания
    // (REND-15) — noFloor из неё же, стенкой обрыва попадание не является.
    const grid = this.source.terrain;
    // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
    const tile = grid.tileSize / FIXED_ONE;
    const wx = ray.originX + ray.dirX * tWalk;
    const wy = ray.originY + ray.dirY * tWalk;
    const cx = clampIndex(Math.floor(wx / tile), grid.width);
    const cy = clampIndex(Math.floor(wy / tile), grid.height);
    writeSurfaceHit(hit, grid, ray, tWalk, cx, cy, false);
    return true;
  }
}
