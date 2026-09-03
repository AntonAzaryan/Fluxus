/**
 * Мировые якоря инстансов для экранного слоя (REND-41): мировая точка над
 * нарисованным инстансом → координаты кадра.
 *
 * Рядом с посадкой позы (`camera/apply.ts`), а не внутри подсистемы моделей,
 * потому что это ВТОРАЯ грань той же посадки: рендер уже умеет поставить камеру
 * в позу (CAM-1), и проекция мировой точки — та же матрица, прочитанная в
 * обратную сторону. Считать её у потребителя (DOM-слой HUD, `match-hud` HUD-10)
 * значило бы завести вторую посадку позы — она разъезжалась бы с кадром ровно
 * так же, как разъехался бы с ним второй луч курсора (REND-42).
 *
 * ## Вход — только доставленное (REND-1)
 *
 * Якорь считается по ВИДИМОЙ позе инстанса и границам его модели
 * (`ModelInstanceView`, REND-3, ASSET-5) — то есть по тому, что построено из
 * доставленного presentation-состояния. Ни канала в мир, ни расширения
 * `TickResult` здесь нет и быть не может.
 *
 * ## Набор называет потребитель
 *
 * Кому положена полоса здоровья, а кому имя — политика игры, не механизм
 * рендера (тот же раздел механизма и политики, что у ручек качества QUAL-1).
 * Поэтому сущности приходят `track`/`untrack`, а не выводятся обходом сцены.
 *
 * ## Аллокаций на кадр нет (REND-26)
 *
 * Запись якоря заводится один раз на сущность в `track` и переиспользуется;
 * кадр только переписывает её поля. Снятая `untrack` запись возвращается в
 * свободный список — оборот набора не растит память (PERF-9).
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import { applyCameraPose } from './camera/apply.js';
import type { CameraPose } from './camera/rig.js';
import type { ModelInstanceView } from './subsystems/models/instanceRecord.js';

/** Прямоугольник кадра: свои размеры знает потребитель, а не рендер (REND-41). */
export interface ScreenViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Опубликованный якорь. Объект СТАБИЛЕН на всё время, пока сущность в наборе:
 * потребитель, взявший его один раз, обязан видеть кадр текущий, а не тот, что
 * был в момент вызова, — то же соображение, что у `ModelInstanceView`.
 */
export interface ScreenAnchor {
  readonly entity: EntityId;
  /** Мировая точка якоря. */
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  /** Нормализованные координаты кадра: X вправо, Y вверх, оба в [-1, 1] на экране. */
  readonly ndcX: number;
  readonly ndcY: number;
  /** Пиксели прямоугольника вьюпорта от его левого верхнего угла. */
  readonly x: number;
  readonly y: number;
  /** Расстояние по взгляду от камеры до точки якоря, мировые единицы. */
  readonly distance: number;
  /**
   * Точка перед камерой И внутри прямоугольника вьюпорта. Координаты есть и у
   * невидимого якоря: прижать элемент к кромке — решение потребителя (REND-41).
   */
  readonly onScreen: boolean;
  /**
   * Инстанс нарисован этим кадром: он есть и не отсечён (REND-21). `false` —
   * якоря по существу нет, и элемент над ним потребитель гасит.
   */
  readonly drawn: boolean;
}

type MutableAnchor = { -readonly [K in keyof ScreenAnchor]: ScreenAnchor[K] };

/** Источник инстансов — публичный вид подсистемы моделей (REND-3). */
export interface AnchorInstanceSource {
  instanceFor(entity: EntityId, decoration?: boolean): ModelInstanceView | null;
}

export interface ScreenAnchorsOptions {
  /** Кто рисует инстансы: у него и спрашивается их видимая поза (REND-3). */
  readonly instances: AnchorInstanceSource;
  /**
   * Камера, на которую садится поза. По умолчанию служба заводит свою — с
   * МИРОВЫМ верхом сцены (0, 0, 1), по тому же основанию, что проекция курсора
   * (REND-42): `lookAt` строит крен из `camera.up`, и камера с верхом THREE по
   * умолчанию проецировала бы точку не туда, куда её нарисовал кадр.
   *
   * Камеру КАДРА отдавать не следует: служба переписывает её соотношение сторон
   * и матрицы, то есть меняла бы кадр под собой.
   */
  readonly camera?: THREE.PerspectiveCamera;
}

/** Запрос якоря одной сущности — политика потребителя поверх умолчаний. */
export interface AnchorRequest {
  /** Инстанс — decoration (REND-18), а не сущность presentation-состояния. */
  readonly decoration?: boolean;
  /**
   * Высота якоря над позой инстанса, мировые единицы. Не задана — верх границ
   * инстанса (REND-41): «над макушкой» по умолчанию.
   */
  readonly height?: number;
}

const NO_REQUEST: AnchorRequest = {};

/**
 * Служба экранных якорей (REND-41). Кадр: `update(pose, viewport)` — после
 * покадрового обновления подсистемы, которая инстансы рисует, и до кадра
 * потребителя (REND-8).
 */
export class ScreenAnchors {
  private readonly instances: AnchorInstanceSource;
  private readonly cameraRef: THREE.PerspectiveCamera;
  /** Набор: сущность → её якорь и запрос. Меняется событием, не кадром. */
  private readonly tracked = new Map<EntityId, MutableAnchor>();
  private readonly requests = new Map<EntityId, AnchorRequest>();
  /** Снятые записи: оборот набора не заводит новых объектов (PERF-9). */
  private readonly free: MutableAnchor[] = [];
  /** Скретч проекции — один на службу, между кадрами живёт (REND-26). */
  private readonly point = new THREE.Vector3();
  private width = 0;
  private height = 0;

  constructor(options: ScreenAnchorsOptions) {
    this.instances = options.instances;
    if (options.camera === undefined) {
      this.cameraRef = new THREE.PerspectiveCamera();
      this.cameraRef.up.set(0, 0, 1);
    } else {
      this.cameraRef = options.camera;
    }
  }

  /** Сущностей в наборе — вход тестов и величин состояния. */
  get size(): number {
    return this.tracked.size;
  }

  /**
   * Сущность в набор (REND-41). Повторный вызов переписывает запрос, но не
   * запись: объект якоря стабилен на всё время, пока сущность в наборе.
   */
  track(entity: EntityId, request: AnchorRequest = NO_REQUEST): ScreenAnchor {
    this.requests.set(entity, request);
    const existing = this.tracked.get(entity);
    if (existing !== undefined) return existing;
    const anchor = this.free.pop() ?? createAnchor();
    resetAnchor(anchor, entity);
    this.tracked.set(entity, anchor);
    return anchor;
  }

  /** Сущность из набора; её запись возвращается в свободный список. */
  untrack(entity: EntityId): void {
    const anchor = this.tracked.get(entity);
    if (anchor === undefined) return;
    this.tracked.delete(entity);
    this.requests.delete(entity);
    this.free.push(anchor);
  }

  /** Весь набор долой — снос сцены и смена арены. */
  clear(): void {
    for (const anchor of this.tracked.values()) this.free.push(anchor);
    this.tracked.clear();
    this.requests.clear();
  }

  /**
   * Якорь сущности; null — её нет в наборе. Ненарисованная сущность якорь
   * ИМЕЕТ, но с `drawn: false` — «данных нет» и «не в наборе» обязаны
   * различаться (REND-41).
   */
  anchorOf(entity: EntityId): ScreenAnchor | null {
    return this.tracked.get(entity) ?? null;
  }

  /** Обход опубликованных якорей в порядке набора; замыкания на кадр нет. */
  each(visit: (anchor: ScreenAnchor) => void): void {
    for (const anchor of this.tracked.values()) visit(anchor);
  }

  /**
   * Кадр: пересчёт якорей набора по позе, которой нарисован кадр (CAM-1), и
   * прямоугольнику вьюпорта. Аллокаций не делает — пишет в заведённые записи.
   */
  update(pose: CameraPose, viewport: ScreenViewport): void {
    const camera = this.cameraRef;
    this.width = viewport.width;
    this.height = viewport.height;
    const aspect = viewport.height === 0 ? 1 : viewport.width / viewport.height;
    const aspectChanged = camera.aspect !== aspect;
    if (aspectChanged) camera.aspect = aspect;
    applyCameraPose(camera, pose);
    // `applyCameraPose` пересчитывает проекцию только на смену FOV — соотношение
    // сторон вьюпорта её собственный вход (то же правило, что у REND-42).
    if (aspectChanged) camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // По значениям, а не по парам: деструктуризация записи Map заводит на
    // каждой итерации кортеж, то есть аллокацию НА КАДР (REND-26). Сущность и
    // так лежит в самой записи — её ставит `track`.
    for (const anchor of this.tracked.values()) {
      this.write(anchor, camera, pose);
    }
  }

  /** Один якорь: мировая точка над инстансом и её проекция. */
  private write(
    anchor: MutableAnchor,
    camera: THREE.PerspectiveCamera,
    pose: CameraPose,
  ): void {
    const entity = anchor.entity;
    const request = this.requests.get(entity) ?? NO_REQUEST;
    const view = this.instances.instanceFor(entity, request.decoration ?? false);
    // Инстанса нет либо он отсечён кадром (REND-21): элемент над невидимым —
    // та же ложь, что выделение ненарисованного (REND-15).
    if (view?.visible !== true) {
      anchor.drawn = false;
      anchor.onScreen = false;
      return;
    }
    const instance = view.pose;
    // Высота якоря: величина потребителя либо верх границ инстанса. Границы
    // несут масштаб записи манифеста, `pose.scale` — масштаб набора (REND-11).
    const height = request.height ?? (view.bounds === null ? 0 : view.bounds.maxZ * instance.scale);
    const wx = instance.x;
    const wy = instance.y;
    const wz = instance.z + height;
    anchor.drawn = true;
    anchor.worldX = wx;
    anchor.worldY = wy;
    anchor.worldZ = wz;
    // Расстояние по взгляду — до посадки на камеру: та же поза, которой
    // нарисован кадр, и второго её источника здесь нет.
    anchor.distance = Math.hypot(wx - pose.posX, wy - pose.posY, wz - pose.posZ);
    this.point.set(wx, wy, wz).project(camera);
    const ndcX = this.point.x;
    const ndcY = this.point.y;
    anchor.ndcX = ndcX;
    anchor.ndcY = ndcY;
    anchor.x = ((ndcX + 1) / 2) * this.width;
    anchor.y = ((1 - ndcY) / 2) * this.height;
    // Точка ЗА камерой после перспективного деления отражается в
    // противоположный угол кадра — знак глубины в NDC не виден, и без проверки
    // полоса зашедшего за спину юнита выехала бы на экран зеркально. `z > 1` —
    // дальше дальней плоскости либо позади ближней после деления.
    const behind = this.point.z > 1;
    anchor.onScreen = !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
  }
}

function createAnchor(): MutableAnchor {
  return {
    entity: 0,
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    ndcX: 0,
    ndcY: 0,
    x: 0,
    y: 0,
    distance: 0,
    onScreen: false,
    drawn: false,
  };
}

function resetAnchor(anchor: MutableAnchor, entity: EntityId): void {
  anchor.entity = entity;
  anchor.worldX = 0;
  anchor.worldY = 0;
  anchor.worldZ = 0;
  anchor.ndcX = 0;
  anchor.ndcY = 0;
  anchor.x = 0;
  anchor.y = 0;
  anchor.distance = 0;
  anchor.onScreen = false;
  anchor.drawn = false;
}
