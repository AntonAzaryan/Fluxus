/**
 * CameraRig — клиентская камера как чистый конвейер позы (CAM-1): режимы
 * follow / free-RTS / fly (CAM-2) → логическая поза; эффекты (`effects.ts`)
 * накладываются поверх отдельным слоем. Поза — данные без привязки к
 * графической библиотеке; применение к THREE-камере — одна функция на
 * стороне сборки.
 *
 * Камера не касается симуляции: ввод камеры не пересекает границу воркера,
 * состояние rig'а не входит в откатываемое состояние и не реагирует на
 * rewind/replay (CAM-5) — единственная видимая ему сторона отката — snap
 * follow-цели, приезжающий готовым флагом из `ViewBuffer` (REND-2).
 *
 * Высота точки наблюдения во всех режимах, кроме fly, — уровень клифа под
 * ней (CAM-2), сглаженный; вертикальная координата цели не читается вовсе:
 * подброс героя камеру не качает.
 */
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';

// ---------------------------------------------------------------- контракты

export type CameraMode = 'follow' | 'free' | 'fly';

/**
 * Логическая поза камеры (CAM-1): позиция глаза и углы взгляда.
 * `yaw` — азимут в плоскости XY (радианы), `pitch` — наклон вниз от
 * горизонтали (положительный — смотрим вниз), `roll` — крен, `fovDeg` —
 * вертикальный угол обзора в градусах.
 */
export interface CameraPose {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  roll: number;
  fovDeg: number;
}

/**
 * Сэмпл ввода камеры за кадр. Оси — [-1..1], дельты — в пикселях за кадр,
 * фронты (`*Tap`, `*Toggle`) взводятся событием и сбрасываются
 * `resetCameraInput` после `update`. Ничто из этого не отправляется в
 * симуляцию (CAM-1).
 */
export interface CameraInput {
  /** Клавиши панорамирования (стрелки), [-1..1]. */
  panX: number;
  panY: number;
  /** Панорамирование краем экрана, [-1..1]. */
  edgeX: number;
  edgeY: number;
  /** Drag средней кнопкой, px за кадр (положительный — контент тянут вправо/вверх). */
  dragDX: number;
  dragDY: number;
  /** Шаги колеса (+1 — отдалить); в fly управляет скоростью (CAM-4). */
  wheelSteps: number;
  /** Короткое нажатие клавиши центрирования (фронт). */
  centerTap: boolean;
  /** Клавиша центрирования удерживается. */
  centerHeld: boolean;
  /** Переключатель залипающего follow (фронт). */
  followToggle: boolean;
  /** Переключатель fly-режима (фронт). */
  flyToggle: boolean;
  /** Fly: осмотр мышью, px за кадр. */
  lookDX: number;
  lookDY: number;
  /** Fly: перемещение [-1..1] — вбок, вперёд, вертикально. */
  moveX: number;
  moveY: number;
  moveZ: number;
}

export function createCameraInput(): CameraInput {
  return {
    panX: 0,
    panY: 0,
    edgeX: 0,
    edgeY: 0,
    dragDX: 0,
    dragDY: 0,
    wheelSteps: 0,
    centerTap: false,
    centerHeld: false,
    followToggle: false,
    flyToggle: false,
    lookDX: 0,
    lookDY: 0,
    moveX: 0,
    moveY: 0,
    moveZ: 0,
  };
}

/** Сбрасывает фронты и накопленные дельты после `update`; оси-удержания не трогает. */
export function resetCameraInput(input: CameraInput): void {
  input.dragDX = 0;
  input.dragDY = 0;
  input.wheelSteps = 0;
  input.centerTap = false;
  input.followToggle = false;
  input.flyToggle = false;
  input.lookDX = 0;
  input.lookDY = 0;
}

/** Follow-цель: интерполированная горизонталь и snap-флаг из `EntityView` (REND-2). */
export interface FollowTarget {
  readonly x: number;
  readonly y: number;
  /** Разрыв непрерывности цели в последнем тике — прыгнуть без проезда (CAM-5). */
  readonly snap: boolean;
}

/** Границы, в которых живёт точка наблюдения (CAM-3). */
export interface CameraBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Политика камеры (CAM-1): все настроечные числа в одном месте, код режимов —
 * механизм. Дефолты — стартовая точка, сборка переопределяет частично.
 */
export interface CameraConfig {
  /** Наклон взгляда вниз от горизонтали, радианы. */
  readonly pitch: number;
  /** Азимут взгляда, радианы; π/2 — камера южнее цели, смотрит на север. */
  readonly yaw: number;
  readonly fovDeg: number;
  readonly distance: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Множитель дистанции на один шаг колеса (CAM-4). */
  readonly zoomStep: number;
  /** Экспоненты сглаживаний, 1/с. */
  readonly followSmoothing: number;
  readonly zoomSmoothing: number;
  readonly heightSmoothing: number;
  readonly recenterSmoothing: number;
  /** Панорама, мировых единиц/с на дистанции `distance` (масштабируется зумом). */
  readonly panSpeed: number;
  /** Drag: мировых единиц на пиксель на дистанции `distance`. */
  readonly dragPanPerPx: number;
  /** Ширина зоны edge-pan у границ канваса, px (используется сборкой). */
  readonly edgeMarginPx: number;
  /** Запас клампа точки наблюдения внутрь границ арены, мировых единиц. */
  readonly boundsMargin: number;
  /** Разрыв follow-цели больше этого — snap без проезда (CAM-5). */
  readonly snapDistance: number;
  /** Перелёт центрирования считается завершённым ближе этого, мировых единиц. */
  readonly recenterEpsilon: number;
  /** Fly: стартовая скорость (ед/с), пределы и множитель шага колеса. */
  readonly flySpeed: number;
  readonly flySpeedMin: number;
  readonly flySpeedMax: number;
  readonly flySpeedStep: number;
  /** Fly: чувствительность осмотра, радиан на пиксель. */
  readonly lookSensitivity: number;
  /** Глобальный множитель силы эффектов камеры, 0 — полное отключение (CAM-6). */
  readonly effectsMultiplier: number;
}

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  pitch: (50 * Math.PI) / 180,
  yaw: Math.PI / 2,
  fovDeg: 45,
  distance: 16,
  minDistance: 8,
  maxDistance: 28,
  zoomStep: 1.15,
  followSmoothing: 6,
  zoomSmoothing: 8,
  heightSmoothing: 8,
  recenterSmoothing: 10,
  panSpeed: 14,
  dragPanPerPx: 0.02,
  edgeMarginPx: 24,
  boundsMargin: 2,
  snapDistance: 2,
  recenterEpsilon: 0.1,
  flySpeed: 12,
  flySpeedMin: 2,
  flySpeedMax: 60,
  flySpeedStep: 1.2,
  lookSensitivity: 0.005,
  effectsMultiplier: 1,
};

export interface CameraRigOptions {
  readonly config?: Partial<CameraConfig>;
  /** Высота поверхности (уровень клифа × шаг высоты) под мировой точкой (CAM-2). */
  readonly groundHeightAt?: (x: number, y: number) => number;
  readonly bounds?: CameraBounds;
  /** Стартовая точка наблюдения. */
  readonly startX?: number;
  readonly startY?: number;
}

// ------------------------------------------------------------------- helpers

/** Экспоненциальное сглаживание, независимое от кадровой частоты. */
const ease = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Edge-pan по положению указателя относительно прямоугольника канваса:
 * [-1..1] по осям, 0 вне зоны `margin` и за пределами прямоугольника.
 * Ось Y экранная (вниз) конвертируется в мировую (вверх).
 */
export function edgePanAxes(
  pointerX: number,
  pointerY: number,
  rect: { left: number; top: number; width: number; height: number },
  margin: number,
): { x: number; y: number } {
  const px = pointerX - rect.left;
  const py = pointerY - rect.top;
  if (px < 0 || py < 0 || px > rect.width || py > rect.height || margin <= 0) {
    return { x: 0, y: 0 };
  }
  let x = 0;
  let y = 0;
  if (px < margin) x = px / margin - 1;
  else if (px > rect.width - margin) x = 1 - (rect.width - px) / margin;
  if (py < margin) y = 1 - py / margin;
  else if (py > rect.height - margin) y = (rect.height - py) / margin - 1;
  return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
}

/**
 * Поверхность и границы камеры из сетки террейна (CAM-2, CAM-3): уровень
 * клифа клетки под точкой × шаг высоты; точки за сеткой прижимаются к
 * крайним клеткам. Читает те же данные, что рендер террейна (REND-7).
 */
export function terrainGroundApi(
  grid: TerrainGrid,
  heightStep: number,
): { groundHeightAt: (x: number, y: number) => number; bounds: CameraBounds } {
  const tile = grid.tileSize / FIXED_ONE;
  return {
    groundHeightAt: (x: number, y: number): number => {
      const cx = clamp(Math.floor(x / tile), 0, grid.width - 1);
      const cy = clamp(Math.floor(y / tile), 0, grid.height - 1);
      return grid.levels[cy * grid.width + cx]! * heightStep;
    },
    bounds: { minX: 0, minY: 0, maxX: grid.width * tile, maxY: grid.height * tile },
  };
}

// ----------------------------------------------------------------------- rig

export class CameraRig {
  readonly config: CameraConfig;

  private readonly groundHeightAt: ((x: number, y: number) => number) | null;
  private readonly bounds: CameraBounds | null;

  private modeState: CameraMode = 'follow';
  /** Точка наблюдения (сглаженная) и её высота по поверхности. */
  private targetX: number;
  private targetY: number;
  private targetZ = 0;
  private hasGround = false;
  /** Дистанция: желаемая (мгновенно от колеса) и сглаженная (CAM-4). */
  private desiredDistance: number;
  private distance: number;
  /** Перелёт центрирования к герою (CAM-2), гасится вводом панорамы. */
  private recentering = false;
  /** Fly-состояние; за пределами fly не используется. */
  private flyX = 0;
  private flyY = 0;
  private flyZ = 0;
  private flyYaw: number;
  private flyPitch: number;
  private flySpeed: number;

  /** Переиспользуемая поза (CAM-1): валидна до следующего `update`. */
  private readonly pose: CameraPose;

  constructor(options: CameraRigOptions = {}) {
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...options.config };
    this.groundHeightAt = options.groundHeightAt ?? null;
    this.bounds = options.bounds ?? null;
    this.targetX = options.startX ?? 0;
    this.targetY = options.startY ?? 0;
    this.desiredDistance = this.config.distance;
    this.distance = this.config.distance;
    this.flyYaw = this.config.yaw;
    this.flyPitch = this.config.pitch;
    this.flySpeed = this.config.flySpeed;
    this.pose = {
      posX: 0,
      posY: 0,
      posZ: 0,
      yaw: this.config.yaw,
      pitch: this.config.pitch,
      roll: 0,
      fovDeg: this.config.fovDeg,
    };
  }

  get mode(): CameraMode {
    return this.modeState;
  }

  /** Fly владеет клавиатурой движения: ввод героя в симуляцию не уходит (CAM-2). */
  capturesMovement(): boolean {
    return this.modeState === 'fly';
  }

  /** Высота поверхности под точкой наблюдения — плоскость прицельного луча сборки. */
  get groundZ(): number {
    return this.targetZ;
  }

  /** Точка наблюдения — центр затухания импульсных эффектов по расстоянию (CAM-6). */
  get focusX(): number {
    return this.targetX;
  }

  get focusY(): number {
    return this.targetY;
  }

  /**
   * Кадр камеры: ввод + dt + follow-цель → логическая поза. Возвращаемый
   * объект переиспользуется (валиден до следующего вызова); эффекты
   * накладываются поверх отдельным слоем (CAM-6).
   */
  update(input: CameraInput, dt: number, target: FollowTarget | null): CameraPose {
    if (input.flyToggle) this.toggleFly();

    if (this.modeState === 'fly') {
      this.updateFly(input, dt);
    } else {
      this.updateGrounded(input, dt, target);
    }
    return this.pose;
  }

  // ------------------------------------------------------------- follow/free

  private updateGrounded(input: CameraInput, dt: number, target: FollowTarget | null): void {
    const cfg = this.config;
    const panX = this.panAxis(input.panX + input.edgeX);
    const panY = this.panAxis(input.panY + input.edgeY);
    const panActive =
      panX !== 0 || panY !== 0 || input.dragDX !== 0 || input.dragDY !== 0;

    // Переходы (CAM-2): панорама открепляет, followToggle залипает,
    // centerTap запускает перелёт, centerHeld держит на герое.
    if (panActive) {
      this.modeState = 'free';
      this.recentering = false;
    }
    if (input.followToggle && target !== null) {
      this.modeState = 'follow';
      this.recentering = false;
    }
    if (input.centerTap && this.modeState === 'free' && target !== null) {
      this.recentering = true;
    }

    // Зум (CAM-4): желаемая дистанция мгновенно, фактическая — сглаженно.
    if (input.wheelSteps !== 0) {
      this.desiredDistance = clamp(
        this.desiredDistance * Math.pow(cfg.zoomStep, input.wheelSteps),
        cfg.minDistance,
        cfg.maxDistance,
      );
    }
    this.distance += (this.desiredDistance - this.distance) * ease(cfg.zoomSmoothing, dt);

    if (this.modeState === 'follow' && target !== null) {
      if (target.snap) {
        // Разрыв цели (телепорт, rewind) — прыжок без проезда (CAM-5).
        this.targetX = target.x;
        this.targetY = target.y;
      } else {
        const s = ease(cfg.followSmoothing, dt);
        this.targetX += (target.x - this.targetX) * s;
        this.targetY += (target.y - this.targetY) * s;
      }
    } else {
      // Free-RTS (CAM-3): скорость панорамы масштабируется дистанцией —
      // на отдалённой камере экранная скорость ощущается одинаковой.
      const zoomScale = this.distance / cfg.distance;
      const speed = cfg.panSpeed * zoomScale;
      this.targetX += panX * speed * dt;
      this.targetY += panY * speed * dt;
      this.targetX -= input.dragDX * cfg.dragPanPerPx * zoomScale;
      this.targetY += input.dragDY * cfg.dragPanPerPx * zoomScale;

      const held = input.centerHeld && target !== null;
      if ((this.recentering || held) && target !== null) {
        const s = ease(cfg.recenterSmoothing, dt);
        this.targetX += (target.x - this.targetX) * s;
        this.targetY += (target.y - this.targetY) * s;
        if (Math.hypot(target.x - this.targetX, target.y - this.targetY) < cfg.recenterEpsilon) {
          this.recentering = false;
        }
      }
    }

    if (this.bounds !== null) {
      this.targetX = clamp(
        this.targetX,
        this.bounds.minX + cfg.boundsMargin,
        this.bounds.maxX - cfg.boundsMargin,
      );
      this.targetY = clamp(
        this.targetY,
        this.bounds.minY + cfg.boundsMargin,
        this.bounds.maxY - cfg.boundsMargin,
      );
    }

    // Высота — уровень клифа под точкой наблюдения (CAM-2), не z цели;
    // snap цели протаскивает и высоту без проезда.
    if (this.groundHeightAt !== null) {
      const ground = this.groundHeightAt(this.targetX, this.targetY);
      if (!this.hasGround || (target?.snap ?? false)) {
        this.targetZ = ground;
        this.hasGround = true;
      } else {
        this.targetZ += (ground - this.targetZ) * ease(cfg.heightSmoothing, dt);
      }
    }

    const pose = this.pose;
    const forwardXY = Math.cos(cfg.pitch);
    pose.posX = this.targetX - Math.cos(cfg.yaw) * forwardXY * this.distance;
    pose.posY = this.targetY - Math.sin(cfg.yaw) * forwardXY * this.distance;
    pose.posZ = this.targetZ + Math.sin(cfg.pitch) * this.distance;
    pose.yaw = cfg.yaw;
    pose.pitch = cfg.pitch;
    pose.roll = 0;
    pose.fovDeg = cfg.fovDeg;
  }

  /** Мёртвая зона и кламп осей панорамы. */
  private panAxis(v: number): number {
    return Math.abs(v) < 1e-3 ? 0 : clamp(v, -1, 1);
  }

  // -------------------------------------------------------------------- fly

  private toggleFly(): void {
    if (this.modeState === 'fly') {
      // Возврат в free-RTS: точка наблюдения осталась где была до полёта.
      this.modeState = 'free';
      return;
    }
    // Вход: полёт стартует из текущей позы, чтобы не было скачка.
    this.flyX = this.pose.posX;
    this.flyY = this.pose.posY;
    this.flyZ = this.pose.posZ;
    this.flyYaw = this.pose.yaw;
    this.flyPitch = this.pose.pitch;
    this.modeState = 'fly';
  }

  private updateFly(input: CameraInput, dt: number): void {
    const cfg = this.config;
    // Колесо в fly — скорость полёта, не дистанция (CAM-4).
    if (input.wheelSteps !== 0) {
      this.flySpeed = clamp(
        this.flySpeed * Math.pow(cfg.flySpeedStep, -input.wheelSteps),
        cfg.flySpeedMin,
        cfg.flySpeedMax,
      );
    }
    this.flyYaw -= input.lookDX * cfg.lookSensitivity;
    this.flyPitch = clamp(
      this.flyPitch + input.lookDY * cfg.lookSensitivity,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );

    const cosP = Math.cos(this.flyPitch);
    // Векторы взгляда: forward — куда смотрим, right — вбок в плоскости XY.
    const fx = Math.cos(this.flyYaw) * cosP;
    const fy = Math.sin(this.flyYaw) * cosP;
    const fz = -Math.sin(this.flyPitch);
    const rx = Math.sin(this.flyYaw);
    const ry = -Math.cos(this.flyYaw);
    const step = this.flySpeed * dt;
    this.flyX += (fx * input.moveY + rx * input.moveX) * step;
    this.flyY += (fy * input.moveY + ry * input.moveX) * step;
    this.flyZ += (fz * input.moveY + input.moveZ) * step;

    const pose = this.pose;
    pose.posX = this.flyX;
    pose.posY = this.flyY;
    pose.posZ = this.flyZ;
    pose.yaw = this.flyYaw;
    pose.pitch = this.flyPitch;
    pose.roll = 0;
    pose.fovDeg = cfg.fovDeg;
  }
}
