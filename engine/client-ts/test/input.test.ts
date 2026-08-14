/**
 * Слой источников ввода (input-devices INP-1..5): латчинг фронтов, свёртка
 * источников, клампы и квантование — headless, на синтетических событиях
 * (design D8). Поведенческий контракт закреплён до миграции демо.
 */
import { describe, expect, it } from 'vitest';
import {
  InputSystem,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick as simTick,
  world as coreWorld,
  worldInitSpawn,
  type SceneDef,
  type Simulation,
} from '@game-mvp/core';
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

const BITS = { cast: 0, kill: 1, dodge: 2, jump: 3 } as const;

/**
 * Раскладка-фикстура: своя, а не взятая у сборки игры. Тест здесь про МЕХАНИЗМ
 * `src/input` (INP-1..5), и раскладка ему нужна как вход, а не как утверждение
 * о чьих-то данных: раскладка реальной игры — контент её сборки, и прогон
 * движка от него не зависит (`game-content` CONT-4). Валидность самой игровой
 * раскладки закреплена там же, где она лежит, — `game/demo-ts/test/bindings.test.ts`.
 *
 * Числа подобраны под вьюпорт тестов 1000×500: ход стика 0,12 × 500 = 60 px,
 * зона кнопки `jump` — правый верхний угол, мёртвая зона прицела 0,25.
 */
const BINDINGS = {
  keyboardMouse: {
    move: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
    keys: { ShiftLeft: 'dodge', ShiftRight: 'dodge', Space: 'jump', KeyK: 'kill' },
    pointerButtons: { 0: 'cast' },
  },
  touch: {
    moveStick: { zone: { left: 0, top: 0.4, width: 0.5, height: 0.6 }, radius: 0.12 },
    aimStick: {
      zone: { left: 0.5, top: 0.4, width: 0.5, height: 0.6 },
      radius: 0.12,
      releaseAction: 'cast',
      deadzone: 0.25,
    },
    buttons: [
      { zone: { left: 0.86, top: 0.05, width: 0.12, height: 0.1 }, action: 'jump' },
      { zone: { left: 0.72, top: 0.05, width: 0.12, height: 0.1 }, action: 'dodge' },
    ],
  },
  gamepad: {
    moveAxes: [0, 1],
    aimAxes: [2, 3],
    deadzone: 0.25,
    buttons: { 0: 'jump', 1: 'dodge', 5: 'cast', 8: 'kill' },
  },
};

const makeSampler = (): InputSampler => new InputSampler({ actionBits: BITS });

/** Источник-стенд: непрерывное состояние и удержания задаются тестом напрямую. */
class StubSource implements InputSource {
  press: ((action: string) => void) | null = null;
  state: { moveX: number; moveY: number; aim: number | null } | null = {
    moveX: 0,
    moveY: 0,
    aim: null,
  };
  readonly heldActions = new Set<string>();
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
  held(): ReadonlySet<string> {
    return this.heldActions;
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

describe('InputSampler: удержание и отпускание (INP-2)', () => {
  it('удержание десять тиков — бит стоит все десять выборок подряд', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.heldActions.add('cast');
    for (let i = 0; i < 10; i++) expect(sampler.sample().buttons).toBe(1 << BITS.cast);
    // Отпускание наблюдаемо как falling edge между соседними масками.
    source.heldActions.clear();
    expect(sampler.sample().buttons).toBe(0);
  });

  it('удержание не съедает фронт чужого действия — маски объединяются', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.heldActions.add('cast');
    source.press!('jump');
    expect(sampler.sample().buttons).toBe((1 << BITS.cast) | (1 << BITS.jump));
    // Латч обнулён, удержание — нет.
    expect(sampler.sample().buttons).toBe(1 << BITS.cast);
  });

  it('удержания разных источников объединяются по OR (INP-5)', () => {
    const sampler = makeSampler();
    const a = new StubSource('a');
    const b = new StubSource('b');
    sampler.add(a);
    sampler.add(b);
    a.heldActions.add('cast');
    b.heldActions.add('dodge');
    expect(sampler.sample().buttons).toBe((1 << BITS.cast) | (1 << BITS.dodge));
  });

  it('удержание неизвестного действия — ошибка конфигурации, не тишина', () => {
    const sampler = makeSampler();
    const source = new StubSource('stub');
    sampler.add(source);
    source.heldActions.add('teleport');
    expect(() => sampler.sample()).toThrow(/teleport/);
  });

  it('источник без удержаний работает как раньше — метод опционален', () => {
    const sampler = makeSampler();
    const edgesOnly: InputSource = {
      id: 'edges-only',
      start: () => {},
      stop: () => {},
      poll: () => null,
    };
    sampler.add(edgesOnly);
    expect(sampler.sample().buttons).toBe(0);
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
      bindings: validateBindings(BINDINGS).keyboardMouse,
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

  it('зажатая клавиша держит бит все тики, отпускание — falling edge (INP-2)', () => {
    const sampler = makeSampler();
    const source = kb();
    sampler.add(source);
    source.handleKeyDown('Space');
    for (let i = 0; i < 3; i++) expect(sampler.sample().buttons).toBe(1 << BITS.jump);
    source.handleKeyUp('Space');
    expect(sampler.sample().buttons).toBe(0);
  });

  it('автоповтор ОС удержание не ломает: бит один и тот же', () => {
    const sampler = makeSampler();
    const source = kb();
    sampler.add(source);
    source.handleKeyDown('KeyK');
    expect(sampler.sample().buttons).toBe(1 << BITS.kill);
    source.handleKeyDown('KeyK', true);
    expect(sampler.sample().buttons).toBe(1 << BITS.kill);
  });

  it('потеря фокуса окна сбрасывает удержания — залипания нет (INP-5)', () => {
    const sampler = makeSampler();
    const source = kb();
    sampler.add(source);
    source.handleKeyDown('Space');
    source.handleKeyDown('KeyW');
    expect(sampler.sample().buttons).toBe(1 << BITS.jump);
    source.handleBlur();
    expect(sampler.sample().buttons).toBe(0);
    expect(source.poll()).toMatchObject({ moveX: 0, moveY: 0 }); // и движение тоже
  });

  it('зажатая кнопка мыши держит бит до отпускания', () => {
    const sampler = makeSampler();
    const source = kb();
    sampler.add(source);
    source.handlePointerDown(0, 10, 20);
    expect(sampler.sample().buttons).toBe(1 << BITS.cast);
    expect(sampler.sample().buttons).toBe(1 << BITS.cast);
    source.handlePointerUp(0);
    expect(sampler.sample().buttons).toBe(0);
  });

  it('клик без направления не создаёт удержания', () => {
    const sampler = makeSampler();
    const source = new KeyboardMouseSource({
      bindings: validateBindings(BINDINGS).keyboardMouse,
      aimAt: () => null,
    });
    sampler.add(source);
    source.handlePointerDown(0, 10, 20);
    expect(sampler.sample().buttons).toBe(0);
  });

  it('клик даёт фронт с прицелом; клик без направления — не действие', () => {
    const withAim = new KeyboardMouseSource({
      bindings: validateBindings(BINDINGS).keyboardMouse,
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
  const bindings = validateBindings(BINDINGS).touch!;
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
    // Тап уложился между тиками: ровно один тик с битом.
    expect(sampler.sample().buttons).toBe(0);
  });

  it('палец на кнопке действия держит бит до отрыва (INP-2)', () => {
    const sampler = makeSampler();
    const source = make();
    sampler.add(source);
    source.handlePointerDown(1, 900, 40); // зона jump
    for (let i = 0; i < 3; i++) expect(sampler.sample().buttons).toBe(1 << BITS.jump);
    source.handlePointerUp(1);
    expect(sampler.sample().buttons).toBe(0);
  });
});

describe('GamepadSource (INP-3, INP-5, D7)', () => {
  const bindings = validateBindings(BINDINGS).gamepad!;
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

  it('удержание кнопки геймпада семантически равно клавиатурному (INP-2)', () => {
    let current: GamepadLike | null = pad([0, 0, 0, 0], [5]); // cast зажат
    const sampler = makeSampler();
    sampler.add(new GamepadSource(bindings, () => current));
    for (let i = 0; i < 3; i++) expect(sampler.sample().buttons).toBe(1 << BITS.cast);
    current = pad([0, 0, 0, 0]); // отпустили
    expect(sampler.sample().buttons).toBe(0);
  });

  it('отключение с зажатой кнопкой снимает бит — залипания нет (INP-5)', () => {
    let current: GamepadLike | null = pad([0, 0, 0, 0], [5]);
    const sampler = makeSampler();
    sampler.add(new GamepadSource(bindings, () => current));
    expect(sampler.sample().buttons).toBe(1 << BITS.cast);
    current = null;
    expect(sampler.sample().buttons).toBe(0);
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
  it('полная раскладка разбирается: секции устройств на месте', () => {
    const bindings = validateBindings(BINDINGS);
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
        ...(BINDINGS as object),
        gamepad: { moveAxes: [0], deadzone: 0.25, buttons: {} },
      }),
    ).toThrow(/moveAxes/);
  });
});

/**
 * Отпускание доезжает до симуляции (INP-2 + `tick-loop` TICK-4): весь путь
 * целиком — источник → сэмплер → `InputFrame` → `InputSystem` → JSON-система,
 * которая ловит falling edge обычным выражением DSL. Зеркало теста «каст не
 * спамится при зажатой кнопке» (`demoScene.test.ts`) с другого конца нажатия.
 */
describe('отпускание кнопки в симуляции (INP-2, TICK-4)', () => {
  /** Мини-сцена: игрок, счётчик отпусканий и системa-политика на falling edge. */
  const SCENE: SceneDef = {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Released', fields: { count: 'i32' } },
    ],
    prefabs: [
      { name: 'Hero', components: { Player: { slot: 0 }, Input: {}, Released: { count: 0 } } },
    ],
    systems: [
      {
        name: 'ReleaseCounter',
        order: 10,
        query: { all: ['Input', 'Released'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'prevButtons'] }, BITS.cast] },
                  {
                    '!': [
                      { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'buttons'] }, BITS.cast] },
                    ],
                  },
                ],
              },
              then: [
                {
                  modifyComponent: {
                    entity: { var: 'e' },
                    component: 'Released',
                    values: {
                      count: {
                        '+': [{ getComponent: [{ var: 'e' }, 'Released', 'count'] }, 1],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    capacity: 8,
  };

  /** Сборка «сэмплер → тик»: сэмпл границы тика уходит во фрейм как есть. */
  function harness() {
    const { world, systems } = loadScene(SCENE);
    systems.register(new InputSystem({ players: ['p1'] }));
    const hero = worldInitSpawn(world, 'Hero');
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi };
    const state = initialState(world, 1);
    const sampler = makeSampler();
    const source = new KeyboardMouseSource({
      bindings: validateBindings(BINDINGS).keyboardMouse,
      aimAt: () => 0,
    });
    sampler.add(source);

    let at = 0;
    return {
      source,
      /** Один тик: выборка ввода и прогон систем — как делает оболочка (SHELL-6). */
      step: (): void => {
        at += 1;
        const input = sampler.sample();
        simTick(sim, state, [{ tick: at, playerId: 'p1', seq: at, ...input }]);
      },
      released: (): number => coreWorld.getField(state.world, hero, 'Released', 'count'),
    };
  }

  it('система на falling edge срабатывает ровно один раз на отпускание', () => {
    const h = harness();
    // Кнопка каста — левая кнопка мыши демо-раскладки (INP-4).
    h.source.handlePointerDown(0, 10, 20);
    for (let i = 0; i < 4; i++) h.step();
    expect(h.released()).toBe(0); // удержание — не отпускание

    h.source.handlePointerUp(0);
    h.step();
    expect(h.released()).toBe(1);
    h.step();
    h.step();
    expect(h.released()).toBe(1); // отпускание не повторяется

    // Второе нажатие и отпускание — второй раз.
    h.source.handlePointerDown(0, 10, 20);
    h.step();
    h.source.handlePointerUp(0);
    h.step();
    expect(h.released()).toBe(2);
  });

  it('тап между тиками виден как нажатие и следом как отпускание', () => {
    const h = harness();
    // Нажатие и отпускание целиком между тиками: латч даёт бит одного тика,
    // следующий тик — уже falling edge.
    h.source.handlePointerDown(0, 10, 20);
    h.source.handlePointerUp(0);
    h.step();
    expect(h.released()).toBe(0);
    h.step();
    expect(h.released()).toBe(1);
  });
});
