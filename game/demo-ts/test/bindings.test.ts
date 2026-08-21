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
import { pointerAction, pointerSuppressed, validateBindings } from '@game-mvp/client';
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
      ...Object.values(b.keyboardMouse.pointerButtons).map(pointerAction),
      ...(b.touch?.buttons ?? []).map((button) => button.action),
      ...(b.touch?.aimStick?.releaseAction === undefined ? [] : [b.touch.aimStick.releaseAction]),
      ...Object.values(b.gamepad?.buttons ?? {}),
    ];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(Object.keys(ACTION_BITS)).toContain(action);
  });

  /**
   * Щит — на ПРАВОЙ кнопке мыши, и это единственное место, где сказано, какая
   * кнопка его ставит: смысл биту даёт определение способности сцены, а органу
   * управления — вот эта раскладка (INP-4, ABIL-3). Раньше щит висел на `E`, а
   * правая кнопка подтверждала шаг прицеливания.
   */
  it('щит ставится правой кнопкой мыши и только ею (INP-4)', () => {
    const b = validateBindings(demoBindings);
    const right = b.keyboardMouse.pointerButtons['2']!;
    expect(pointerAction(right)).toBe('shield');
    // Alt+ПКМ принадлежит камере облёта (`main.ts`), и раскладка отдаёт это
    // сочетание ей САМА: `KeyboardMouseSource` гасит в облёте только оси
    // движения, не биты действий, — то есть без оговорки осмотр камеры заодно
    // ставил бы щит и жёг его перезарядку.
    expect(pointerSuppressed(right, { Alt: true })).toBe(true);
    expect(pointerSuppressed(right, {})).toBe(false);
    expect(pointerSuppressed(right, { Shift: true })).toBe(false);
    // Прежняя клавиша освобождена: «меняем клавишу», а не «добавляем вторую».
    expect(Object.keys(b.keyboardMouse.keys)).not.toContain('KeyE');
    expect(Object.values(b.keyboardMouse.keys)).not.toContain('shield');
    // Левая осталась за кастом: обе кнопки мыши заняты миром, и обе — героем.
    expect(pointerAction(b.keyboardMouse.pointerButtons['0']!)).toBe('cast');
    // Левая оговорок не несёт: короткая форма записи осталась законной.
    expect(b.keyboardMouse.pointerButtons['0']).toBe('cast');
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
