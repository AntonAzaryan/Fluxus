/**
 * Геймпад (input-devices INP-1, design D7). Gamepad API опросный — фронты
 * вычисляются в `poll()` сравнением prev/current (`HeldActions`); частота
 * опроса — каденс сэмплера. Источник дремлет, пока `getGamepad` отдаёт null
 * (до `gamepadconnected`), и при отключении объявляет себя неактивным —
 * нейтраль вместо залипания (INP-5).
 */
import { HeldActions } from './sampler.js';
import {
  aimAngle,
  aimTarget,
  type ActionSink,
  type AimPoint,
  type ContinuousSample,
  type InputSource,
} from './types.js';

export interface GamepadBindings {
  /** Индексы осей движения [x, y]; экранный Y (вниз) — инверсия внутри. */
  readonly moveAxes: readonly [number, number];
  /** Индексы осей прицела; без них прицелом источник не владеет. */
  readonly aimAxes?: readonly [number, number];
  /**
   * Мировые единицы на полный ход стика прицела (INP-1): экранного указателя у
   * геймпада нет, и точку прицела источник строит из своего органа управления
   * сам — отклонением стика от начала прицеливания. Число — данные биндинга, а
   * не код: как далеко «дотягивается» стик, решает раскладка устройства.
   *
   * Без него (и без начала прицеливания) источник точкой не владеет и молчит о
   * ней — ровно как без `aimAxes` он молчит о направлении.
   */
  readonly aimReach?: number;
  /** Радиальная мёртвая зона стиков в долях хода [0..1). */
  readonly deadzone: number;
  /** Индекс кнопки геймпада (ключ — строка) → имя действия (INP-4). */
  readonly buttons: Readonly<Record<string, string>>;
}

/** Структурный минимум `Gamepad` — тестируемость без браузера (D8). */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

export class GamepadSource implements InputSource {
  readonly id = 'gamepad';

  private readonly bindings: GamepadBindings;
  private readonly getGamepad: () => GamepadLike | null;
  private readonly aimOrigin: (() => AimPoint | null) | undefined;
  private press: ActionSink | null = null;
  /** Детектор фронтов опросного устройства (INP-2). */
  private readonly edges = new HeldActions();
  private readonly current = new Set<string>();
  /** Было ли устройство на последнем опросе: неактивный источник — `null` (INP-5). */
  private connected = false;
  private lastAim: number | null = null;
  /** Ответ `poll().target`; переписывается на месте — опрос не аллоцирует. */
  private readonly targetScratch = { x: 0, y: 0 };
  private hasTarget = false;

  /**
   * `aimOrigin` — начало прицеливания в мировых координатах: та точка, от
   * которой отклонение стика отсчитывается (обычно — тот, кем играют). Знание
   * мира принадлежит приложению и приезжает сюда тем же способом, что raycast
   * указателя в клавиатурно-мышиный источник, — колбэком, а не запросом
   * источника к симуляции.
   */
  constructor(
    bindings: GamepadBindings,
    getGamepad: () => GamepadLike | null,
    aimOrigin?: () => AimPoint | null,
  ) {
    this.bindings = bindings;
    this.getGamepad = getGamepad;
    this.aimOrigin = aimOrigin;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  stop(): void {
    this.press = null;
    this.edges.reset();
    this.current.clear();
    this.connected = false;
  }

  /**
   * Удержания опросного устройства — состояние кнопок последнего `poll()`
   * (INP-2): та же гарантия, что у событийной клавиатуры.
   */
  held(): ReadonlySet<string> | null {
    return this.connected ? this.current : null;
  }

  poll(): ContinuousSample | null {
    const pad = this.getGamepad();
    if (pad === null) {
      // Отключение: кнопки не «дожаты» при переподключении, движение — нейтраль.
      this.edges.reset();
      this.current.clear();
      this.connected = false;
      return null;
    }
    this.connected = true;

    this.current.clear();
    for (const [index, action] of Object.entries(this.bindings.buttons)) {
      if (pad.buttons[Number(index)]?.pressed === true) this.current.add(action);
    }
    if (this.press !== null) this.edges.update(this.current, this.press);

    const [mxAxis, myAxis] = this.bindings.moveAxes;
    const move = radialDeadzone(pad.axes[mxAxis] ?? 0, pad.axes[myAxis] ?? 0, this.bindings.deadzone);

    if (this.bindings.aimAxes !== undefined) {
      const [axAxis, ayAxis] = this.bindings.aimAxes;
      const ax = pad.axes[axAxis] ?? 0;
      const ay = pad.axes[ayAxis] ?? 0;
      const deflection = Math.hypot(ax, ay);
      if (deflection >= this.bindings.deadzone) {
        this.lastAim = aimAngle(ax, -ay);
        this.aimPoint(this.lastAim, Math.min(deflection, 1));
      }
    }

    // `|| 0` гасит -0 от инверсии экранного Y.
    return {
      moveX: move.x,
      moveY: -move.y || 0,
      aim: this.lastAim,
      target: this.hasTarget ? this.targetScratch : null,
    };
  }

  /**
   * Точка прицела стика (INP-1): начало прицеливания плюс отклонение, взятое в
   * мировых единицах биндинга. Дальностью способности и границей арены точка
   * НЕ обрезается — это политика симуляции (ABIL-5), и клиенту её не отдают.
   */
  private aimPoint(angle: number, deflection: number): void {
    const reach = this.bindings.aimReach;
    const origin = reach === undefined ? null : (this.aimOrigin?.() ?? null);
    if (origin === null || reach === undefined) return;
    aimTarget(origin, angle, reach * deflection, this.targetScratch);
    this.hasTarget = true;
  }
}

/**
 * Радиальная мёртвая зона с ремапом остатка в полный ход: частичный наклон
 * даёт дробную длину (INP-3), около нуля стик не дрейфует.
 */
function radialDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length < deadzone) return { x: 0, y: 0 };
  const scaled = Math.min((length - deadzone) / (1 - deadzone), 1);
  return { x: (x / length) * scaled, y: (y / length) * scaled };
}

/**
 * Обвязка Gamepad API браузера: активация по `gamepadconnected` первым
 * подключённым пэдом. Возвращает `getGamepad` для конструктора источника.
 */
export function navigatorGamepad(win: Window): () => GamepadLike | null {
  let padIndex: number | null = null;
  win.addEventListener('gamepadconnected', (e) => {
    padIndex ??= e.gamepad.index;
  });
  win.addEventListener('gamepaddisconnected', (e) => {
    if (padIndex === e.gamepad.index) padIndex = null;
  });
  return () => {
    if (padIndex === null) return null;
    return win.navigator.getGamepads()[padIndex] ?? null;
  };
}
