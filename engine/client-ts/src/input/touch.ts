/**
 * Сенсорный экран (input-devices INP-1, design D6): плавающий стик движения,
 * стик прицела с кастом на отпускании, кнопки действий. Источник владеет
 * pointer-событиями своих зон с захватом по pointerId; отрисовка накладки —
 * ответственность приложения, источник лишь отдаёт `overlay()`.
 *
 * Геометрия зон — данные (доли вьюпорта), не код. Оси экрана — Y вниз;
 * в семантический сэмпл уходит мировой Y (вверх) — инверсия умирает здесь.
 */
import {
  aimAngle,
  aimTarget,
  type ActionSink,
  type AimPoint,
  type ContinuousSample,
  type InputSource,
} from './types.js';

/** Зона в долях вьюпорта [0..1] от левого верхнего угла. */
export interface TouchZone {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchStickConfig {
  readonly zone: TouchZone;
  /** Полный ход стика в долях меньшей стороны вьюпорта. */
  readonly radius: number;
}

export interface TouchAimStickConfig extends TouchStickConfig {
  /** Действие на отпускании отклонённого стика (каст «отпустил — выстрелил»). */
  readonly releaseAction?: string;
  /** Доля хода, ниже которой отпускание — тап без направления, не действие. */
  readonly deadzone?: number;
  /**
   * Мировые единицы на полный ход стика прицела (INP-1): указателя у тач-стика
   * нет, и точку прицела источник строит из отклонения сам — те же основания и
   * та же арифметика, что у геймпада. Без него (и без начала прицеливания)
   * источник точкой не владеет.
   */
  readonly aimReach?: number;
}

export interface TouchButtonConfig {
  readonly zone: TouchZone;
  readonly action: string;
}

export interface TouchBindings {
  readonly moveStick: TouchStickConfig;
  readonly aimStick?: TouchAimStickConfig;
  readonly buttons?: readonly TouchButtonConfig[];
}

export interface TouchViewport {
  readonly width: number;
  readonly height: number;
}

/** Состояние для накладки приложения: активные стики в пикселях клиента. */
export interface TouchOverlayState {
  readonly moveStick: { centerX: number; centerY: number; knobX: number; knobY: number } | null;
  readonly aimStick: { centerX: number; centerY: number; knobX: number; knobY: number } | null;
}

interface StickState {
  pointerId: number;
  centerX: number;
  centerY: number;
  /** Отклонение в долях хода, экранные оси (Y вниз), клампится кругом. */
  dx: number;
  dy: number;
}

const DEFAULT_AIM_DEADZONE = 0.25;

export class TouchSource implements InputSource {
  readonly id = 'touch';

  private readonly bindings: TouchBindings;
  private readonly viewport: () => TouchViewport;
  private readonly aimOrigin: (() => AimPoint | null) | undefined;
  private press: ActionSink | null = null;
  private moveStick: StickState | null = null;
  private aimStick: StickState | null = null;
  private lastAim: number | null = null;
  /** Ответ `poll().target`; переписывается на месте — выборка не аллоцирует. */
  private readonly targetScratch = { x: 0, y: 0 };
  private hasTarget = false;
  /** Активен после первого касания (INP-5): до него источник «не появился». */
  private touched = false;
  /** Зажатые кнопки действий: `pointerId` → имя действия (состояние жеста). */
  private readonly heldButtons = new Map<number, string>();
  /** Ответ `held()`; пересобирается на месте — выборка не аллоцирует. */
  private readonly heldActions = new Set<string>();

  /**
   * `aimOrigin` — начало прицеливания в мировых координатах, знание приложения
   * (см. `GamepadSource`): источник строит точку от него отклонением стика, а
   * сам мира не спрашивает.
   */
  constructor(
    bindings: TouchBindings,
    viewport: () => TouchViewport,
    aimOrigin?: () => AimPoint | null,
  ) {
    this.bindings = bindings;
    this.viewport = viewport;
    this.aimOrigin = aimOrigin;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  stop(): void {
    this.press = null;
    this.moveStick = null;
    this.aimStick = null;
    this.heldButtons.clear();
  }

  /**
   * Удержания тача — состояние жеста (INP-2): палец на кнопке действия держит
   * её бит, пока не поднят; `pointercancel` идёт тем же путём, что `pointerup`.
   */
  held(): ReadonlySet<string> {
    this.heldActions.clear();
    for (const action of this.heldButtons.values()) this.heldActions.add(action);
    return this.heldActions;
  }

  handlePointerDown(pointerId: number, clientX: number, clientY: number): void {
    this.touched = true;
    const vp = this.viewport();
    for (const button of this.bindings.buttons ?? []) {
      if (inZone(button.zone, clientX, clientY, vp)) {
        this.heldButtons.set(pointerId, button.action);
        this.press?.(button.action);
        return;
      }
    }
    if (this.moveStick === null && inZone(this.bindings.moveStick.zone, clientX, clientY, vp)) {
      // Плавающий стик: центр — точка первого касания (D6).
      this.moveStick = { pointerId, centerX: clientX, centerY: clientY, dx: 0, dy: 0 };
      return;
    }
    const aim = this.bindings.aimStick;
    if (aim !== undefined && this.aimStick === null && inZone(aim.zone, clientX, clientY, vp)) {
      this.aimStick = { pointerId, centerX: clientX, centerY: clientY, dx: 0, dy: 0 };
    }
  }

  handlePointerMove(pointerId: number, clientX: number, clientY: number): void {
    const vp = this.viewport();
    if (this.moveStick?.pointerId === pointerId) {
      dragStick(this.moveStick, clientX, clientY, this.bindings.moveStick.radius, vp);
    }
    const aim = this.bindings.aimStick;
    if (aim !== undefined && this.aimStick?.pointerId === pointerId) {
      dragStick(this.aimStick, clientX, clientY, aim.radius, vp);
      const deflection = Math.hypot(this.aimStick.dx, this.aimStick.dy);
      if (deflection >= (aim.deadzone ?? DEFAULT_AIM_DEADZONE)) {
        this.lastAim = aimAngle(this.aimStick.dx, -this.aimStick.dy);
        this.aimPoint(aim, this.lastAim, Math.min(deflection, 1));
      }
    }
  }

  /**
   * Точка прицела стика (INP-1): начало прицеливания плюс отклонение в мировых
   * единицах биндинга. Дальностью способности точка не обрезается — это
   * политика симуляции (ABIL-5).
   */
  private aimPoint(config: TouchAimStickConfig, angle: number, deflection: number): void {
    const reach = config.aimReach;
    const origin = reach === undefined ? null : (this.aimOrigin?.() ?? null);
    if (origin === null || reach === undefined) return;
    aimTarget(origin, angle, reach * deflection, this.targetScratch);
    this.hasTarget = true;
  }

  handlePointerUp(pointerId: number): void {
    this.heldButtons.delete(pointerId);
    if (this.moveStick?.pointerId === pointerId) this.moveStick = null;
    const aim = this.bindings.aimStick;
    if (aim !== undefined && this.aimStick?.pointerId === pointerId) {
      const { dx, dy } = this.aimStick;
      this.aimStick = null;
      if (
        aim.releaseAction !== undefined &&
        Math.hypot(dx, dy) >= (aim.deadzone ?? DEFAULT_AIM_DEADZONE)
      ) {
        this.lastAim = aimAngle(dx, -dy);
        this.aimPoint(aim, this.lastAim, Math.min(Math.hypot(dx, dy), 1));
        this.press?.(aim.releaseAction);
      }
    }
  }

  poll(): ContinuousSample | null {
    if (!this.touched) return null;
    const stick = this.moveStick;
    return {
      moveX: stick?.dx ?? 0,
      // `|| 0` гасит -0 от инверсии экранного Y.
      moveY: stick === null ? 0 : -stick.dy || 0,
      aim: this.lastAim,
      target: this.hasTarget ? this.targetScratch : null,
    };
  }

  overlay(): TouchOverlayState {
    const radiusPx = (stick: TouchStickConfig, vp: TouchViewport): number =>
      stick.radius * Math.min(vp.width, vp.height);
    const vp = this.viewport();
    const knob = (
      state: StickState | null,
      config: TouchStickConfig | undefined,
    ): TouchOverlayState['moveStick'] => {
      if (state === null || config === undefined) return null;
      const r = radiusPx(config, vp);
      return {
        centerX: state.centerX,
        centerY: state.centerY,
        knobX: state.centerX + state.dx * r,
        knobY: state.centerY + state.dy * r,
      };
    };
    return {
      moveStick: knob(this.moveStick, this.bindings.moveStick),
      aimStick: knob(this.aimStick, this.bindings.aimStick),
    };
  }

  /** Подключение к pointer-событиям; возвращает отписку. */
  bind(target: Window): () => void {
    const isTouch = (e: PointerEvent): boolean => e.pointerType === 'touch';
    const onDown = (e: PointerEvent): void => {
      if (isTouch(e)) this.handlePointerDown(e.pointerId, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent): void => {
      if (isTouch(e)) this.handlePointerMove(e.pointerId, e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent): void => {
      if (isTouch(e)) this.handlePointerUp(e.pointerId);
    };
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    return () => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
  }
}

function inZone(zone: TouchZone, clientX: number, clientY: number, vp: TouchViewport): boolean {
  const fx = clientX / vp.width;
  const fy = clientY / vp.height;
  return (
    fx >= zone.left && fx <= zone.left + zone.width && fy >= zone.top && fy <= zone.top + zone.height
  );
}

/** Отклонение стика в долях хода с клампом кругом; ход — доля меньшей стороны. */
function dragStick(
  stick: StickState,
  clientX: number,
  clientY: number,
  radius: number,
  vp: TouchViewport,
): void {
  const radiusPx = radius * Math.min(vp.width, vp.height);
  let dx = (clientX - stick.centerX) / radiusPx;
  let dy = (clientY - stick.centerY) / radiusPx;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  stick.dx = dx;
  stick.dy = dy;
}
