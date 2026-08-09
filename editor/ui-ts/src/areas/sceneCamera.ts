/**
 * @contribution Камера вьюпорта сцены — часть вклада области, а не каркаса.
 *
 * ED-13: поза приходит конвейером `camera` (CAM-1), применяет её общая
 * реализация из `rendering`, и «собственный контроллер камеры редактора MUST
 * NOT существовать». Поэтому здесь нет ни одной строки, считающей позу: только
 * сбор сэмпла ввода (`CameraInput`) и вызовы `CameraRig`. Отличие редакторского
 * кадра от игрового — режим конвейера (`fly`, CAM-2), а не второй способ
 * считать позу.
 *
 * ED-15 требует в режиме правки как минимум free-RTS и fly. Follow-цели в
 * режиме правки нет — симуляции нет вовсе (CAM-7), — и наземный режим rig'а
 * при `target === null` и есть free-RTS: панорама, зум, высота по поверхности
 * (CAM-2, CAM-3). Явного «сделай режим free» у конвейера нет, и заводить его
 * здесь нельзя: это была бы правка чужого слоя из вклада.
 *
 * Источник поверхности и границ — редактируемый документ террейна (ED-15,
 * CAM-7): `terrainGroundApi` над сеткой, пересчитанной ядром, и переподача
 * `setSources` при правке кистью. Presentation-состояние прогона тут ни при
 * чём: прогона нет.
 */
import {
  CameraRig,
  createCameraInput,
  edgePanAxes,
  resetCameraInput,
  terrainGroundApi,
  type CameraBounds,
  type CameraConfig,
  type CameraInput,
  type CameraPose,
  type TerrainCameraSource,
} from '@game-mvp/render';
import type { TerrainGrid } from '@game-mvp/core';

/**
 * Раскладка камеры вьюпорта. Данными, а не разбросанными по коду сравнениями:
 * подсказка автору (W2-3) обязана называть те же клавиши, что работают.
 */
export const CAMERA_KEYS = {
  panLeft: 'ArrowLeft',
  panRight: 'ArrowRight',
  panUp: 'ArrowUp',
  panDown: 'ArrowDown',
  flyToggle: 'KeyF',
  flyLeft: 'KeyA',
  flyRight: 'KeyD',
  flyForward: 'KeyW',
  flyBack: 'KeyS',
  flyUp: 'KeyE',
  flyDown: 'KeyQ',
} as const;

/**
 * Настройки конвейера у кадра редактора (CAM-1) — ровно то одно, чем он
 * отличается от игрового.
 *
 * ED-13 требует совпадения с игровым конфигом по наклону, дистанции и FOV **по
 * умолчанию**; потолка зума в этом перечне нет, и он остаётся настройкой
 * конвейера (CAM-1). Поднят он не по вкусу, а по замеру: обзор арены сцены из
 * `content/` (34×34) требует дистанции около полусотни, тогда как игровой
 * потолок — 28. На нём обзорный кадр упирается в кламп (CAM-8 прямо говорит,
 * что кадрирование клампа не обходит), южный край арены остаётся за кадром, а
 * «Отдалить» сразу после открытия не делает ничего. Design работы называет это
 * решение прямо: потолок зума лечится потолком в конфиге вьюпорта, а не
 * исключением из клампа и не своим расчётом позы.
 *
 * Число щедрое, а не подогнанное под сегодняшнюю арену: подогнанное разошлось
 * бы с первой же ареной, которую автор нарисует крупнее. `DEFAULT_CAMERA_CONFIG`
 * при этом не трогается — игровой кадр остаётся с игровым потолком.
 */
export const EDITOR_CAMERA_CONFIG: Partial<CameraConfig> = Object.freeze({ maxDistance: 240 });

/** Положение указателя в прямоугольнике кадра — вход edge-панорамы (CAM-3). */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly rect: { left: number; top: number; width: number; height: number };
}

export interface SceneCameraOptions {
  /**
   * Сетка террейна документа: поверхность и границы конвейера (CAM-7).
   * Нет сетки — нет и арены: кадр без террейна (превью ассета ED-20) идёт тем
   * же конвейером без источников, а не вторым способом считать позу (ED-13).
   */
  readonly grid?: TerrainGrid;
  /** Шаг высоты уровня — параметр рендера (REND-7); тот же, что у подсистемы. */
  readonly heightStep: number;
  /**
   * Настройки конвейера (CAM-1) поверх редакторских (`EDITOR_CAMERA_CONFIG`):
   * поданное здесь перекрывает их, всё остальное остаётся игровым умолчанием.
   */
  readonly config?: Partial<CameraConfig>;
}

export interface SceneCamera {
  /** Сэмпл ввода за кадр; наполняется событиями кадра и гасится после `frame`. */
  readonly input: CameraInput;
  /** Идёт ли облёт (CAM-2). Наземный режим при отсутствии цели — free-RTS. */
  readonly flying: boolean;
  /** Точка наблюдения — её показывает бар области. */
  readonly focusX: number;
  readonly focusY: number;
  /**
   * Границы арены документа; `null` — кадра без террейна (ED-20) арена не
   * касается. Отдаются тем же источником, что инжектирован в конвейер (CAM-7):
   * второго вычисления размеров арены в редакторе не заводится.
   */
  readonly arena: CameraBounds | null;
  /** Правка документа террейна под камерой: переподача источников (CAM-7). */
  setGrid(grid: TerrainGrid): void;
  /**
   * Кадрирование по заданным границам (CAM-8) — прокси к входу конвейера.
   * Считает позу конвейер: ED-13 запрещает второй способ её считать, и потому
   * здесь нет ни одной строки арифметики. ЧТО кадрировать и КОГДА — политика
   * потребителя, поэтому прямоугольник и пропорции приходят аргументами:
   * свои размеры знает кадр, а не камера.
   */
  frameBounds(rect: CameraBounds, aspect: number, immediate?: boolean): void;
  /** Оси панорамы по зажатым клавишам и указателю (CAM-3). */
  sample(keys: ReadonlySet<string>, pointer: PointerSample | null): void;
  /** Drag средней кнопкой (CAM-3) и осмотр в облёте — в пикселях за кадр. */
  drag(dx: number, dy: number): void;
  look(dx: number, dy: number): void;
  /** Колесо: дистанция в наземных режимах, скорость облёта в fly (CAM-4). */
  zoom(steps: number): void;
  /** Переключатель облёта (CAM-2) — тот же фронт, что клавиша. */
  toggleFly(): void;
  /** Кадр конвейера: логическая поза (CAM-1). Follow-цели в режиме правки нет. */
  frame(dt: number): CameraPose;
}

const axis = (keys: ReadonlySet<string>, positive: string, negative: string): number =>
  (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);

export function createSceneCamera(options: SceneCameraOptions): SceneCamera {
  // Источники конвейера опциональны (CAM-7), и это не заглушка: кадр без
  // террейна не имеет ни границ, ни поверхности, и подсунуть ему выдуманную
  // арену значило бы клампить камеру по несуществующему.
  let ground: TerrainCameraSource | null =
    options.grid === undefined ? null : terrainGroundApi(options.grid, options.heightStep);
  const input = createCameraInput();
  const rig = new CameraRig({
    ...(ground === null
      ? {}
      : {
          groundHeightAt: ground.groundHeightAt,
          bounds: ground.bounds,
          // Старт — центр арены: в режиме правки цели, к которой можно приехать, нет.
          startX: (ground.bounds.maxX + ground.bounds.minX) / 2,
          startY: (ground.bounds.maxY + ground.bounds.minY) / 2,
        }),
    // Конфиг кадра правки — редакторский; поданное сборкой ложится поверх.
    config: { ...EDITOR_CAMERA_CONFIG, ...options.config },
  });

  return {
    input,
    get flying(): boolean {
      return rig.capturesMovement();
    },
    get focusX(): number {
      return rig.focusX;
    },
    get focusY(): number {
      return rig.focusY;
    },
    get arena(): CameraBounds | null {
      return ground?.bounds ?? null;
    },

    frameBounds(rect, aspect, immediate = false) {
      rig.frameBounds({ rect, aspect, immediate });
    },

    setGrid(grid) {
      // Первая сетка заводит источник: кадр, у которого арены не было, получает
      // её теми же средствами, а не остаётся без границ молча.
      ground ??= terrainGroundApi(grid, options.heightStep);
      ground.setGrid(grid);
      // Границы — значение, и без переподачи камера осталась бы клампиться по
      // прежней арене (CAM-7). Высоту источник отдаёт замыканием и по новой
      // сетке отвечает сам.
      rig.setSources({ groundHeightAt: ground.groundHeightAt, bounds: ground.bounds });
    },

    sample(keys, pointer) {
      const fly = rig.capturesMovement();
      input.panX = axis(keys, CAMERA_KEYS.panRight, CAMERA_KEYS.panLeft);
      input.panY = axis(keys, CAMERA_KEYS.panUp, CAMERA_KEYS.panDown);
      const edge =
        pointer === null
          ? { x: 0, y: 0 }
          : edgePanAxes(pointer.x, pointer.y, pointer.rect, rig.config.edgeMarginPx);
      input.edgeX = edge.x;
      input.edgeY = edge.y;
      // Клавиши перемещения принадлежат облёту и только ему (CAM-2).
      input.moveX = fly ? axis(keys, CAMERA_KEYS.flyRight, CAMERA_KEYS.flyLeft) : 0;
      input.moveY = fly ? axis(keys, CAMERA_KEYS.flyForward, CAMERA_KEYS.flyBack) : 0;
      input.moveZ = fly ? axis(keys, CAMERA_KEYS.flyUp, CAMERA_KEYS.flyDown) : 0;
    },

    drag(dx, dy) {
      input.dragDX += dx;
      input.dragDY += dy;
    },

    look(dx, dy) {
      input.lookDX += dx;
      input.lookDY += dy;
    },

    zoom(steps) {
      input.wheelSteps += steps;
    },

    toggleFly() {
      input.flyToggle = true;
    },

    frame(dt) {
      // Цели нет и быть не может: следить в режиме правки не за чем (CAM-7).
      const pose = rig.update(input, dt, null);
      resetCameraInput(input);
      return pose;
    },
  };
}
