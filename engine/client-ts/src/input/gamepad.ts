/**
 * Геймпад (input-devices INP-1, design D7). Gamepad API опросный — фронты
 * вычисляются в `poll()` сравнением prev/current (`HeldActions`); частота
 * опроса — каденс сэмплера. Источник дремлет, пока `getGamepad` отдаёт null
 * (до `gamepadconnected`), и при отключении объявляет себя неактивным —
 * нейтраль вместо залипания (INP-5).
 */
import { HeldActions } from './sampler.js';
import { aimAngle, type ActionSink, type ContinuousSample, type InputSource } from './types.js';

export interface GamepadBindings {
  /** Индексы осей движения [x, y]; экранный Y (вниз) — инверсия внутри. */
  readonly moveAxes: readonly [number, number];
  /** Индексы осей прицела; без них прицелом источник не владеет. */
  readonly aimAxes?: readonly [number, number];
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
  private press: ActionSink | null = null;
  /** Детектор фронтов опросного устройства (INP-2). */
  private readonly edges = new HeldActions();
  private readonly current = new Set<string>();
  private lastAim: number | null = null;

  constructor(bindings: GamepadBindings, getGamepad: () => GamepadLike | null) {
    this.bindings = bindings;
    this.getGamepad = getGamepad;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  stop(): void {
    this.press = null;
    this.edges.reset();
    this.current.clear();
  }

  /**
   * Удержания опросного устройства — состояние кнопок последнего `poll()`
   * (INP-2): та же гарантия, что у событийной клавиатуры.
   */
  held(): ReadonlySet<string> | null {
    return this.current;
  }

  poll(): ContinuousSample | null {
    const pad = this.getGamepad();
    if (pad === null) {
      // Отключение: кнопки не «дожаты» при переподключении, движение — нейтраль.
      this.edges.reset();
      this.current.clear();
      return null;
    }

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
      if (Math.hypot(ax, ay) >= this.bindings.deadzone) this.lastAim = aimAngle(ax, -ay);
    }

    // `|| 0` гасит -0 от инверсии экранного Y.
    return { moveX: move.x, moveY: -move.y || 0, aim: this.lastAim };
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
