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
import type { AimPoint, AimResolution, ActionSink, ContinuousSample, InputSource } from './types.js';

/**
 * Клавиши-модификаторы, состояние которых различает раскладка (INP-4). Набор
 * ЗАКРЫТ и повторяет флаги события указателя: имя вне набора — опечатка, и
 * падать она обязана на загрузке документа, а не молчать в рантайме.
 */
export const POINTER_MODIFIERS = ['Alt', 'Ctrl', 'Shift', 'Meta'] as const;
export type PointerModifier = (typeof POINTER_MODIFIERS)[number];

/** Состояние модификаторов на момент нажатия; отсутствие флага = не зажат. */
export type PointerModifierState = Partial<Record<PointerModifier, boolean>>;

/**
 * Привязка кнопки указателя: имя действия либо оно же с оговорками (INP-4).
 *
 * `suppressedBy` называет модификаторы, при которых кнопка действия НЕ даёт.
 * Это данные раскладки, а не ветка в коде источника: сочетание вроде «Alt+ПКМ»
 * приложение вправе занять своей, не мировой, работой — осмотром камеры,
 * инспектором, чем угодно, — и единственный способ не отдать миру этот же
 * клик вторым смыслом состоит в том, чтобы раскладка сказала об этом сама.
 * Гасится только НАЖАТИЕ: подавленная кнопка не попадает в удержания, а
 * модификатор, зажатый после неё, действия уже не отменяет — иначе одно и то
 * же нажатие меняло бы смысл посреди удержания.
 */
export type PointerButtonBinding =
  | string
  | {
      readonly action: string;
      readonly suppressedBy?: readonly PointerModifier[];
    };

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
  /** `MouseEvent.button` (ключ — строка индекса) → привязка кнопки. */
  readonly pointerButtons: Readonly<Record<string, PointerButtonBinding>>;
}

/** Имя действия привязки — короткая форма и полная различаются только записью. */
export function pointerAction(binding: PointerButtonBinding): string {
  return typeof binding === 'string' ? binding : binding.action;
}

/** Подавлено ли нажатие состоянием модификаторов (см. `PointerButtonBinding`). */
export function pointerSuppressed(
  binding: PointerButtonBinding,
  modifiers: PointerModifierState,
): boolean {
  if (typeof binding === 'string' || binding.suppressedBy === undefined) return false;
  for (const modifier of binding.suppressedBy) {
    if (modifiers[modifier] === true) return true;
  }
  return false;
}

export interface KeyboardMouseOptions {
  readonly bindings: KeyboardMouseBindings;
  /** Захват движения камерой (fly): герой стоит, клавиши — камере (CAM-1). */
  readonly movementCaptured?: () => boolean;
  /**
   * Разрешение экранной позиции в прицел (INP-1): направление в единицах угла
   * ядра И точка на полу, одним лучом. `null` — прицела нет (клик мимо мира
   * или в себя), фронт действия не возникает.
   *
   * Обе величины даёт приложение и даёт вместе: raycast — знание приложения, а
   * два независимых ответа на один клик разъезжались бы между собой.
   */
  readonly aimAt?: (clientX: number, clientY: number) => AimResolution | null;
}

export class KeyboardMouseSource implements InputSource {
  readonly id = 'keyboard-mouse';

  private readonly bindings: KeyboardMouseBindings;
  private readonly movementCaptured: (() => boolean) | undefined;
  private readonly aimAt:
    | ((clientX: number, clientY: number) => AimResolution | null)
    | undefined;
  private press: ActionSink | null = null;
  /** Зажатые `KeyboardEvent.code` — источник движения и удержаний (INP-2). */
  private readonly heldKeys = new Set<string>();
  /** Зажатые кнопки указателя: `MouseEvent.button` → имя действия. */
  private readonly heldPointerButtons = new Map<number, string>();
  /** Ответ `held()`; пересобирается на месте — выборка не аллоцирует. */
  private readonly heldActions = new Set<string>();
  private lastAim: number | null = null;
  /**
   * Последняя разрешённая точка клика (INP-1). Запись одна и переписывается на
   * месте — опрос идёт покадрово, и свежий объект на каждый был бы мусором;
   * читается она до следующей выборки, как и множество `held()`.
   */
  private readonly lastTarget: { x: number; y: number } = { x: 0, y: 0 };
  private hasTarget = false;

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

  /**
   * Нажатие кнопки указателя. `modifiers` — состояние клавиш-модификаторов на
   * момент нажатия: по нему раскладка вправе не отдать миру сочетание, которое
   * приложение заняло собой (`PointerButtonBinding.suppressedBy`). Пустое
   * состояние — ни одного модификатора, то есть поведение прежних раскладок.
   */
  handlePointerDown(
    button: number,
    clientX: number,
    clientY: number,
    modifiers: PointerModifierState = {},
  ): void {
    const binding = this.bindings.pointerButtons[String(button)];
    if (binding === undefined || this.press === null) return;
    if (pointerSuppressed(binding, modifiers)) return;
    const action = pointerAction(binding);
    const aim = this.aimAt?.(clientX, clientY) ?? null;
    // Клик без направления — не действие: ни фронта, ни удержания.
    if (aim === null) return;
    this.lastAim = aim.angle;
    this.lastTarget.x = aim.x;
    this.lastTarget.y = aim.y;
    this.hasTarget = true;
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
    return { moveX, moveY, aim: this.lastAim, target: this.target() };
  }

  /** Точка последнего клика; `null` — кликов, попавших в мир, ещё не было. */
  private target(): AimPoint | null {
    return this.hasTarget ? this.lastTarget : null;
  }

  /** Подключение к DOM-событиям; возвращает отписку. */
  bind(target: Window): () => void {
    const onKeyDown = (e: KeyboardEvent): void => { this.handleKeyDown(e.code, e.repeat); };
    const onKeyUp = (e: KeyboardEvent): void => { this.handleKeyUp(e.code); };
    const onMouseDown = (e: MouseEvent): void => {
      // Флаги события, а не собственный учёт нажатых клавиш: модификатор мог
      // быть зажат до того, как страница получила фокус, и своё состояние
      // разошлось бы с системным.
      this.handlePointerDown(e.button, e.clientX, e.clientY, {
        Alt: e.altKey,
        Ctrl: e.ctrlKey,
        Shift: e.shiftKey,
        Meta: e.metaKey,
      });
    };
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
