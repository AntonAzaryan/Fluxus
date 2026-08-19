/**
 * Раскладка устройств демо как ДАННЫЕ сборки (`input-devices` INP-4).
 *
 * Тест живёт здесь, а не в пакете оболочки, по той же причине, по какой сюда
 * переехало само демо: `bindings.json` и `ACTION_BITS` — контент игры, и прогон
 * движка от него зависеть не вправе (`game-content` CONT-4). Механизм
 * валидации закреплён у себя дома — `engine/client-ts/test/input.test.ts`;
 * здесь утверждается только то, что данные ЭТОЙ сборки ему подходят.
 */
import { describe, expect, it } from 'vitest';
import { validateBindings } from '@game-mvp/client';
import { ACTION_BITS } from '../app/sim.js';
import demoBindings from '../app/bindings.json';

describe('раскладка демо — данные с валидацией (INP-4)', () => {
  it('дефолтная раскладка демо валидна', () => {
    const bindings = validateBindings(demoBindings);
    expect(bindings.keyboardMouse.move.up).toBe('KeyW');
    expect(bindings.touch).toBeDefined();
    expect(bindings.gamepad).toBeDefined();
  });

  /**
   * Раскладка устройств (`bindings.json`) и смысл битов (`ACTION_BITS`) — два
   * файла демо-сборки, и связывает их только совпадение имён: `InputSampler`
   * узнаёт о расхождении на ПЕРВОМ живом нажатии (`bitOf` бросает), то есть на
   * странице, у игрока. Здесь оно ловится загрузкой файла.
   */
  it('каждое действие раскладки объявлено в ACTION_BITS сборки (INP-4)', () => {
    const b = validateBindings(demoBindings);
    const actions = [
      ...Object.values(b.keyboardMouse.keys),
      ...Object.values(b.keyboardMouse.pointerButtons),
      ...(b.touch?.buttons ?? []).map((button) => button.action),
      ...(b.touch?.aimStick?.releaseAction === undefined ? [] : [b.touch.aimStick.releaseAction]),
      ...Object.values(b.gamepad?.buttons ?? {}),
    ];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(Object.keys(ACTION_BITS)).toContain(action);
  });

  /**
   * Биты подтверждения и отмены шага прицеливания (ABIL-5) — обычные биты
   * маски: смысл им даёт определение способности сцены, а не код клиента
   * (INP-4, ABIL-3). До миграции сцены они объявлены и никем не назначены.
   */
  it('подтверждение и отмена — свободные биты в пределах u16 (TICK-2)', () => {
    const bits = Object.values(ACTION_BITS);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(bit).toBeLessThanOrEqual(15);
    expect(ACTION_BITS.confirm).toBe(8);
    expect(ACTION_BITS.cancel).toBe(9);
  });
});
