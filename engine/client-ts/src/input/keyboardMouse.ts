/**
 * Клавиатура+мышь — целевой источник (input-devices INP-1). Поглощает
 * `heroMoveFromKeys`: движение из состояния клавиш по биндингам, нормализация
 * диагонали; при захвате клавиатуры камерой (fly, `camera` CAM-1) движение —
 * ноль. Прицел — точка клика через колбэк приложения: raycast по полу — знание
 * приложения, не слоя ввода.
 *
 * Обработчики принимают данные события, а не DOM-типы: headless-тесты без
 * браузера (design D8); `bind(window)` — тонкая обвязка для рантайма.
 */
import type { ActionSink, ContinuousSample, InputSource } from './types.js';

export interface KeyboardMouseBindings {
  /** Оси движения: `KeyboardEvent.code` четырёх направлений (мир, Y вверх). */
  readonly move: {
    readonly up: string;
    readonly down: string;
    readonly left: string;
    readonly right: string;
  };
  /** `KeyboardEvent.code` → имя действия (INP-4). */
  readonly keys: Readonly<Record<string, string>>;
  /** `MouseEvent.button` (ключ — строка индекса) → имя действия. */
  readonly pointerButtons: Readonly<Record<string, string>>;
}

export interface KeyboardMouseOptions {
  readonly bindings: KeyboardMouseBindings;
  /** Захват движения камерой (fly): герой стоит, клавиши — камере (CAM-1). */
  readonly movementCaptured?: () => boolean;
  /**
   * Прицел по точке экрана в единицах угла ядра; null — направления нет
   * (клик мимо мира или в себя), фронт действия не возникает.
   */
  readonly aimAt?: (clientX: number, clientY: number) => number | null;
}

export class KeyboardMouseSource implements InputSource {
  readonly id = 'keyboard-mouse';

  private readonly bindings: KeyboardMouseBindings;
  private readonly movementCaptured: (() => boolean) | undefined;
  private readonly aimAt: ((clientX: number, clientY: number) => number | null) | undefined;
  private press: ActionSink | null = null;
  /** Зажатые `KeyboardEvent.code` — источник движения и удержаний (INP-2). */
  private readonly heldKeys = new Set<string>();
  /** Зажатые кнопки указателя: `MouseEvent.button` → имя действия. */
  private readonly heldPointerButtons = new Map<number, string>();
  /** Ответ `held()`; пересобирается на месте — выборка не аллоцирует. */
  private readonly heldActions = new Set<string>();
  private lastAim: number | null = null;

  constructor(options: KeyboardMouseOptions) {
    this.bindings = options.bindings;
    this.movementCaptured = options.movementCaptured;
    this.aimAt = options.aimAt;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  stop(): void {
    this.press = null;
    this.clearHeld();
  }

  handleKeyDown(code: string, repeat = false): void {
    this.heldKeys.add(code);
    if (repeat) return; // автоповтор ОС — не новый фронт (INP-2)
    const action = this.bindings.keys[code];
    if (action !== undefined) this.press?.(action);
  }

  handleKeyUp(code: string): void {
    this.heldKeys.delete(code);
  }

  handlePointerDown(button: number, clientX: number, clientY: number): void {
    const action = this.bindings.pointerButtons[String(button)];
    if (action === undefined || this.press === null) return;
    const aim = this.aimAt?.(clientX, clientY) ?? null;
    // Клик без направления — не действие: ни фронта, ни удержания.
    if (aim === null) return;
    this.lastAim = aim;
    this.heldPointerButtons.set(button, action);
    this.press(action);
  }

  handlePointerUp(button: number): void {
    this.heldPointerButtons.delete(button);
  }

  /**
   * Потеря фокуса окна: `keyup`/`mouseup` за его пределами не придут, и без
   * сброса бит остался бы зажатым навсегда (INP-5 — нейтраль вместо залипания).
   */
  handleBlur(): void {
    this.clearHeld();
  }

  private clearHeld(): void {
    this.heldKeys.clear();
    this.heldPointerButtons.clear();
  }

  held(): ReadonlySet<string> {
    this.heldActions.clear();
    for (const code of this.heldKeys) {
      const action = this.bindings.keys[code];
      if (action !== undefined) this.heldActions.add(action);
    }
    for (const action of this.heldPointerButtons.values()) this.heldActions.add(action);
    return this.heldActions;
  }

  poll(): ContinuousSample {
    let moveX = 0;
    let moveY = 0;
    if (this.movementCaptured?.() !== true) {
      const { move } = this.bindings;
      if (this.heldKeys.has(move.up)) moveY += 1;
      if (this.heldKeys.has(move.down)) moveY -= 1;
      if (this.heldKeys.has(move.left)) moveX -= 1;
      if (this.heldKeys.has(move.right)) moveX += 1;
      const length = Math.hypot(moveX, moveY);
      if (length > 0) {
        moveX /= length;
        moveY /= length;
      }
    }
    return { moveX, moveY, aim: this.lastAim };
  }

  /** Подключение к DOM-событиям; возвращает отписку. */
  bind(target: Window): () => void {
    const onKeyDown = (e: KeyboardEvent): void => { this.handleKeyDown(e.code, e.repeat); };
    const onKeyUp = (e: KeyboardEvent): void => { this.handleKeyUp(e.code); };
    const onMouseDown = (e: MouseEvent): void =>
      { this.handlePointerDown(e.button, e.clientX, e.clientY); };
    const onMouseUp = (e: MouseEvent): void => { this.handlePointerUp(e.button); };
    const onBlur = (): void => { this.handleBlur(); };
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('mouseup', onMouseUp);
    target.addEventListener('blur', onBlur);
    return () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('blur', onBlur);
    };
  }
}
