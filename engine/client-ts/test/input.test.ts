/**
 * Слой источников ввода (input-devices INP-1..5): латчинг фронтов, свёртка
 * источников, клампы и квантование — headless, на синтетических событиях
 * (design D8). Поведенческий контракт закреплён до миграции демо.
 */
import { describe, expect, it } from 'vitest';
import { fixed } from '@game-mvp/core';
import {
  GamepadSource,
  HeldActions,
  InputSampler,
  KeyboardMouseSource,
  TouchSource,
  aimAngle,
  validateBindings,
  type GamepadLike,
  type InputSource,
} from '../src/index.js';
import demoBindings from '../demo/bindings.json';

const BITS = { cast: 0, kill: 1, dodge: 2, jump: 3 } as const;

const makeSampler = (): InputSampler => new InputSampler({ actionBits: BITS });

/** Источник-стенд: непрерывное состояние задаётся тестом напрямую. */
class StubSource implements InputSource {
  press: ((action: string) => void) | null = null;
  state: { moveX: number; moveY: number; aim: number | null } | null = {
    moveX: 0,
    moveY: 0,
    aim: null,
  };
  constructor(readonly id: string) {}
  start(press: (action: string) => void): void {
    this.press = press;
  }
  stop(): void {
    this.press = null;
  }
  poll(): { moveX: number; moveY: number; aim: number | null } | null {
    return this.state;
  }
}

describe('InputSampler: латчинг фронтов (INP-2)', () => {
  it('нажатие между тиками входит в ближайшую выборку ровно один раз', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.press!('jump');
    expect(sampler.sample().buttons).toBe(1 << BITS.jump);
    // Фронт не удваивается: следующая выборка чистая.
    expect(sampler.sample().buttons).toBe(0);
  });

  it('фронты двух источников объединяются по OR (INP-5)', () => {
    const sampler = makeSampler();
    const a = new StubSource('a');
    const b = new StubSource('b');
    sampler.add(a);
    sampler.add(b);
    a.press!('cast');
    b.press!('kill');
    expect(sampler.sample().buttons).toBe((1 << BITS.cast) | (1 << BITS.kill));
  });

  it('неизвестное действие — ошибка конфигурации, не тишина', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    expect(() => { source.press!('teleport'); }).toThrow(/teleport/);
  });

  it('бит вне u16 отвергается конструктором (TICK-2)', () => {
    expect(() => new InputSampler({ actionBits: { cast: 16 } })).toThrow(/0\.\.15/);
    expect(() => new InputSampler({ actionBits: { cast: -1 } })).toThrow(/0\.\.15/);
  });
});

describe('InputSampler: свёртка непрерывных (INP-5) и квантование (INP-3)', () => {
  it('движение берётся от последнего изменившегося источника', () => {
    const sampler = makeSampler();
    const kb = new StubSource('kb');
    const pad = new StubSource('pad');
    sampler.add(kb);
    sampler.add(pad);
    kb.state = { moveX: 1, moveY: 0, aim: null };
    expect(fixed.toFloat(sampler.sample().move.x)).toBeCloseTo(1, 4);
    // Геймпад наклонили позже — движение переключается на него.
    pad.state = { moveX: 0, moveY: 0.5, aim: null };
    const s = sampler.sample();
    expect(fixed.toFloat(s.move.x)).toBe(0);
    expect(fixed.toFloat(s.move.y)).toBeCloseTo(0.5, 4);
  });

  it('пропавший активный источник даёт нейтраль, а не залипание', () => {
    const sampler = makeSampler();
    const pad = new StubSource('pad');
    sampler.add(pad);
    pad.state = { moveX: 0.7, moveY: 0, aim: null };
    sampler.sample();
    pad.state = null; // отключение устройства
    const s = sampler.sample();
    expect(s.move.x).toBe(0);
    expect(s.move.y).toBe(0);
  });

  it('сумма источников клампится единичным кругом', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.state = { moveX: 3, moveY: 4, aim: null };
    const s = sampler.sample();
    const length = Math.hypot(fixed.toFloat(s.move.x), fixed.toFloat(s.move.y));
    expect(length).toBeLessThanOrEqual(1);
    expect(length).toBeCloseTo(1, 4);
  });

  it('прицел переживает молчание источника и заворачивается в оборот', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.state = { moveX: 0, moveY: 0, aim: 0x12345 };
    expect(sampler.sample().aimDir).toBe(0x2345); // маска оборота (FP-7)
    source.state = { moveX: 0, moveY: 0, aim: null };
    expect(sampler.sample().aimDir).toBe(0x2345);
  });
});

describe('HeldActions: фронты опросных устройств (INP-2)', () => {
  it('удержание через несколько выборок — один фронт', () => {
    const held = new HeldActions();
    const pressed: string[] = [];
    const press = (a: string): void => {
      pressed.push(a);
    };
    held.update(new Set(['jump']), press);
    held.update(new Set(['jump']), press);
    held.update(new Set(), press);
    held.update(new Set(['jump']), press);
    expect(pressed).toEqual(['jump', 'jump']);
  });
});

describe('KeyboardMouseSource (INP-1, миграция heroMoveFromKeys)', () => {
  const kb = (captured = false): KeyboardMouseSource =>
    new KeyboardMouseSource({
      bindings: validateBindings(demoBindings).keyboardMouse,
      movementCaptured: () => captured,
      aimAt: () => 42,
    });

  it('WASD нормализуется; стрелки принадлежат камере и в движение не входят', () => {
    const source = kb();
    source.handleKeyDown('KeyW');
    source.handleKeyDown('KeyD');
    const diagonal = source.poll();
    expect(Math.hypot(diagonal.moveX, diagonal.moveY)).toBeCloseTo(1, 6);
    source.handleKeyUp('KeyW');
    source.handleKeyUp('KeyD');
    source.handleKeyDown('ArrowUp');
    source.handleKeyDown('ArrowRight');
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0 });
  });

  it('захват движения камерой (fly) — ноль, действия живут (CAM-1)', () => {
    const source = kb(true);
    const pressed: string[] = [];
    source.start((a) => pressed.push(a));
    source.handleKeyDown('KeyW');
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0 });
    source.handleKeyDown('Space');
    expect(pressed).toEqual(['jump']);
  });

  it('автоповтор ОС — не новый фронт', () => {
    const source = kb();
    const pressed: string[] = [];
    source.start((a) => pressed.push(a));
    source.handleKeyDown('KeyK');
    source.handleKeyDown('KeyK', true);
    expect(pressed).toEqual(['kill']);
  });

  it('клик даёт фронт с прицелом; клик без направления — не действие', () => {
    const withAim = new KeyboardMouseSource({
      bindings: validateBindings(demoBindings).keyboardMouse,
      aimAt: (x, y) => (x === 0 && y === 0 ? null : aimAngle(1, 1)),
    });
    const pressed: string[] = [];
    withAim.start((a) => pressed.push(a));
    withAim.handlePointerDown(0, 0, 0); // aimAt → null: клик в себя
    expect(pressed).toEqual([]);
    expect(withAim.poll().aim).toBeNull();
    withAim.handlePointerDown(0, 10, 20);
    expect(pressed).toEqual(['cast']);
    expect(withAim.poll().aim).toBe(aimAngle(1, 1));
  });
});

describe('TouchSource (INP-1, INP-2, D6)', () => {
  const bindings = validateBindings(demoBindings).touch!;
  const viewport = { width: 1000, height: 500 };
  const make = (): TouchSource => new TouchSource(bindings, () => viewport);
  // Ход стика: 0.12 × min(1000, 500) = 60 px.
  const STICK_PX = 60;

  it('дремлет до первого касания (INP-5)', () => {
    expect(make().poll()).toBeNull();
  });

  it('плавающий стик: центр — точка касания, отпускание — нейтраль', () => {
    const source = make();
    source.handlePointerDown(1, 200, 400);
    source.handlePointerMove(1, 200 + STICK_PX, 400);
    expect(source.poll()).toMatchObject({ moveX: 1, moveY: 0 });
    // Экранный Y вниз → мировой вверх.
    source.handlePointerMove(1, 200, 400 - STICK_PX / 2);
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0.5 });
    source.handlePointerUp(1);
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0 });
  });

  it('мультитач: движение и прицел одновременно, отпускание прицела — каст', () => {
    const source = make();
    const pressed: string[] = [];
    source.start((a) => pressed.push(a));
    source.handlePointerDown(1, 200, 400);
    source.handlePointerMove(1, 200 + STICK_PX, 400);
    source.handlePointerDown(2, 800, 400);
    source.handlePointerMove(2, 800, 400 - STICK_PX); // прицел вверх
    const both = source.poll();
    expect(both?.moveX).toBe(1);
    expect(both?.aim).toBe(aimAngle(0, 1));
    source.handlePointerUp(2);
    expect(pressed).toEqual(['cast']);
    expect(source.poll()?.moveX).toBe(1); // движение пережило чужой pointerup
  });

  it('тап ниже мёртвой зоны прицела — не каст', () => {
    const source = make();
    const pressed: string[] = [];
    source.start((a) => pressed.push(a));
    source.handlePointerDown(1, 800, 400);
    source.handlePointerUp(1);
    expect(pressed).toEqual([]);
  });

  it('короткий тап по кнопке действия латчится (INP-2)', () => {
    const sampler = makeSampler();
    const source = make();
    sampler.add(source);
    source.handlePointerDown(1, 900, 40); // зона jump
    source.handlePointerUp(1);
    expect(sampler.sample().buttons).toBe(1 << BITS.jump);
  });
});

describe('GamepadSource (INP-3, INP-5, D7)', () => {
  const bindings = validateBindings(demoBindings).gamepad!;
  const pad = (axes: number[], pressedIdx: number[] = []): GamepadLike => ({
    axes,
    buttons: Array.from({ length: 10 }, (_, i) => ({ pressed: pressedIdx.includes(i) })),
  });

  it('дремлет без устройства; частичный наклон — дробное движение', () => {
    let current: GamepadLike | null = null;
    const source = new GamepadSource(bindings, () => current);
    expect(source.poll()).toBeNull();
    current = pad([0, -0.625, 0, 0]); // вверх на полхода за мёртвой зоной
    const s = source.poll();
    expect(s?.moveX).toBe(0);
    expect(s?.moveY).toBeCloseTo(0.5, 6); // ремап (0.625-0.25)/(1-0.25)
  });

  it('стик в мёртвой зоне — ноль, прицел с правого стика персистентен', () => {
    let current: GamepadLike | null = pad([0.1, -0.1, 0, 0]);
    const source = new GamepadSource(bindings, () => current);
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0 });
    current = pad([0, 0, 1, 0]); // прицел вправо
    expect(source.poll()?.aim).toBe(aimAngle(1, 0));
    current = pad([0, 0, 0, 0]); // стик отпущен — прицел остаётся
    expect(source.poll()?.aim).toBe(aimAngle(1, 0));
  });

  it('удержание кнопки — один фронт; отключение не дожимает кнопки', () => {
    let current: GamepadLike | null = pad([0, 0, 0, 0], [5]);
    const source = new GamepadSource(bindings, () => current);
    const pressed: string[] = [];
    source.start((a) => pressed.push(a));
    source.poll();
    source.poll();
    expect(pressed).toEqual(['cast']);
    current = null; // отключение при зажатой кнопке
    expect(source.poll()).toBeNull();
    current = pad([0, 0, 0, 0], [5]); // переподключение с той же зажатой
    source.poll();
    expect(pressed).toEqual(['cast', 'cast']); // новый фронт, не залипание
  });

  it('отключение при наклонённом стике — нейтраль через сэмплер (INP-5)', () => {
    let current: GamepadLike | null = pad([1, 0, 0, 0]);
    const sampler = makeSampler();
    const source = new GamepadSource(bindings, () => current);
    sampler.add(source);
    expect(fixed.toFloat(sampler.sample().move.x)).toBeCloseTo(1, 4);
    current = null;
    expect(sampler.sample().move.x).toBe(0);
  });
});

describe('Биндинги — данные с валидацией (INP-4)', () => {
  it('дефолтная раскладка демо валидна', () => {
    const bindings = validateBindings(demoBindings);
    expect(bindings.keyboardMouse.move.up).toBe('KeyW');
    expect(bindings.touch).toBeDefined();
    expect(bindings.gamepad).toBeDefined();
  });

  it('сломанные данные падают при загрузке с внятной ошибкой', () => {
    expect(() => validateBindings({})).toThrow(/keyboardMouse/);
    expect(() =>
      validateBindings({
        keyboardMouse: { move: { up: 'KeyW', down: 'KeyS', left: 'KeyA' }, keys: {} },
      }),
    ).toThrow(/move\.right/);
    expect(() =>
      validateBindings({
        ...(demoBindings as object),
        gamepad: { moveAxes: [0], deadzone: 0.25, buttons: {} },
      }),
    ).toThrow(/moveAxes/);
  });
});
