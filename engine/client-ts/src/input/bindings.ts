/**
 * Валидация биндингов (input-devices INP-4): раскладка «физический орган →
 * имя действия» — данные, и сломанные данные должны падать при загрузке с
 * внятной ошибкой, а не молчать в рантайме. Соответствие «имя действия →
 * бит» — отдельный уровень данных, его проверяет `InputSampler`.
 */
import type { GamepadBindings } from './gamepad.js';
import type { KeyboardMouseBindings } from './keyboardMouse.js';
import type { TouchBindings, TouchZone } from './touch.js';

/** Раскладки всех устройств клиента; отсутствие секции — устройства нет. */
export interface InputBindings {
  readonly keyboardMouse: KeyboardMouseBindings;
  readonly touch?: TouchBindings;
  readonly gamepad?: GamepadBindings;
}

export function validateBindings(value: unknown): InputBindings {
  const root = record(value, 'bindings');
  const result: {
    keyboardMouse: KeyboardMouseBindings;
    touch?: TouchBindings;
    gamepad?: GamepadBindings;
  } = { keyboardMouse: validateKeyboardMouse(root['keyboardMouse']) };
  if (root['touch'] !== undefined) result.touch = validateTouch(root['touch']);
  if (root['gamepad'] !== undefined) result.gamepad = validateGamepad(root['gamepad']);
  return result;
}

function validateKeyboardMouse(value: unknown): KeyboardMouseBindings {
  const kb = record(value, 'keyboardMouse');
  const move = record(kb['move'], 'keyboardMouse.move');
  for (const side of ['up', 'down', 'left', 'right'] as const) {
    nonEmptyString(move[side], `keyboardMouse.move.${side}`);
  }
  return {
    move: move as unknown as KeyboardMouseBindings['move'],
    keys: actionMap(kb['keys'], 'keyboardMouse.keys'),
    pointerButtons: actionMap(kb['pointerButtons'], 'keyboardMouse.pointerButtons'),
  };
}

function validateTouch(value: unknown): TouchBindings {
  const touch = record(value, 'touch');
  const moveStick = stick(touch['moveStick'], 'touch.moveStick');
  const result: {
    moveStick: TouchBindings['moveStick'];
    aimStick?: TouchBindings['aimStick'];
    buttons?: TouchBindings['buttons'];
  } = { moveStick };
  if (touch['aimStick'] !== undefined) {
    const aim = record(touch['aimStick'], 'touch.aimStick');
    const base = stick(aim, 'touch.aimStick');
    result.aimStick = {
      ...base,
      ...(aim['releaseAction'] !== undefined
        ? { releaseAction: nonEmptyString(aim['releaseAction'], 'touch.aimStick.releaseAction') }
        : {}),
      ...(aim['deadzone'] !== undefined
        ? { deadzone: fraction(aim['deadzone'], 'touch.aimStick.deadzone') }
        : {}),
    };
  }
  if (touch['buttons'] !== undefined) {
    if (!Array.isArray(touch['buttons'])) throw fail('touch.buttons', 'ожидается массив');
    result.buttons = touch['buttons'].map((b: unknown, i: number) => {
      const button = record(b, `touch.buttons[${i}]`);
      return {
        zone: zone(button['zone'], `touch.buttons[${i}].zone`),
        action: nonEmptyString(button['action'], `touch.buttons[${i}].action`),
      };
    });
  }
  return result;
}

function validateGamepad(value: unknown): GamepadBindings {
  const pad = record(value, 'gamepad');
  const result: {
    moveAxes: readonly [number, number];
    aimAxes?: readonly [number, number];
    deadzone: number;
    buttons: Readonly<Record<string, string>>;
  } = {
    moveAxes: axes(pad['moveAxes'], 'gamepad.moveAxes'),
    deadzone: fraction(pad['deadzone'], 'gamepad.deadzone'),
    buttons: actionMap(pad['buttons'], 'gamepad.buttons'),
  };
  for (const key of Object.keys(result.buttons)) {
    if (!Number.isInteger(Number(key)) || Number(key) < 0) {
      throw fail(`gamepad.buttons.${key}`, 'ключ — индекс кнопки геймпада (целое ≥ 0)');
    }
  }
  if (pad['aimAxes'] !== undefined) result.aimAxes = axes(pad['aimAxes'], 'gamepad.aimAxes');
  return result;
}

// ------------------------------------------------------------------ примитивы

function fail(path: string, expectation: string): Error {
  return new Error(`биндинги: ${path} — ${expectation}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(path, 'ожидается объект');
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw fail(path, 'ожидается непустая строка');
  return value;
}

function actionMap(value: unknown, path: string): Readonly<Record<string, string>> {
  const map = record(value ?? {}, path);
  for (const [key, action] of Object.entries(map)) nonEmptyString(action, `${path}.${key}`);
  return map as Record<string, string>;
}

function fraction(value: unknown, path: string): number {
  if (typeof value !== 'number' || !(value >= 0) || value >= 1) {
    throw fail(path, 'ожидается число в [0..1)');
  }
  return value;
}

function zone(value: unknown, path: string): TouchZone {
  const z = record(value, path);
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    const n = z[side];
    if (typeof n !== 'number' || !(n >= 0) || n > 1) {
      throw fail(`${path}.${side}`, 'ожидается доля вьюпорта в [0..1]');
    }
  }
  return z as unknown as TouchZone;
}

function stick(value: unknown, path: string): { zone: TouchZone; radius: number } {
  const s = record(value, path);
  const radius = s['radius'];
  if (typeof radius !== 'number' || !(radius > 0) || radius > 1) {
    throw fail(`${path}.radius`, 'ожидается доля меньшей стороны в (0..1]');
  }
  return { zone: zone(s['zone'], `${path}.zone`), radius };
}

function axes(value: unknown, path: string): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
  ) {
    throw fail(path, 'ожидается пара индексов осей [x, y]');
  }
  return [value[0] as number, value[1] as number];
}
