import { describe, expect, it } from 'vitest';
import { InputSystem, inputTargetDeclared } from '../src/systems/inputSystem.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { runScenario, type ScenarioDef } from '../src/sim/scenario.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { mathApi } from '../src/math/mathApi.js';
import * as fixed from '../src/math/fixed.js';
import { getField, spawn } from '../src/ecs/world.js';
import type { InputFrame } from '../src/types.js';

const F = fixed.fromFloat;

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
  ],
  prefabs: [
    {
      name: 'Hero',
      components: {
        Player: { slot: 0 },
        Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
      },
    },
  ],
};

function frame(playerId: string, at: number, over: Partial<InputFrame> = {}): InputFrame {
  return { tick: at, playerId, seq: 1, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0, ...over };
}

/**
 * Та же сцена, но с объявленной парой точки прицела (TICK-2, TICK-4): раскладку
 * включает СОСТАВ компонента ввода, а не флаг документа прогона.
 */
const SCENE_WITH_TARGET: SceneDef = {
  components: [
    SCENE.components[0]!,
    {
      name: 'Input',
      fields: { ...SCENE.components[1]!.fields, targetX: 'fixed', targetY: 'fixed' },
    },
  ],
  prefabs: [
    {
      name: 'Hero',
      components: {
        Player: { slot: 0 },
        Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0, targetX: 0, targetY: 0 },
      },
    },
  ],
};

/** Мир с героями по числу слотов и симуляция с одной `InputSystem`. */
function harness(players: readonly string[], heroes = players.length, scene: SceneDef = SCENE) {
  const { world, systems } = loadScene(scene);
  // Ровно то же решение, что принимает `buildSimulation`: спросить состав
  // компонента ввода сцены и передать ответ параметром.
  systems.register(new InputSystem({ players, target: inputTargetDeclared(world) }));
  const entities = Array.from({ length: heroes }, (_, slot) =>
    spawn(world, 'Hero', { Player: { slot } }),
  );
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi };
  const state = initialState(world, 1);
  const step = (inputs: readonly InputFrame[]): void => void tick(sim, state, inputs);
  const read = (slot: number, field: string): number => getField(world, entities[slot]!, 'Input', field);
  return { step, read, state };
}

describe('InputSystem (TICK-4, TICK-5)', () => {
  it('раскладывает фрейм в компонент ввода по слоту', () => {
    const h = harness(['p1', 'p2']);
    h.step([frame('p2', 1, { move: { x: F(2), y: F(-1) }, aimDir: F(0.5), buttons: 5, seq: 7 })]);

    expect(h.read(1, 'moveX')).toBe(F(2));
    expect(h.read(1, 'moveY')).toBe(F(-1));
    expect(h.read(1, 'aimDir')).toBe(F(0.5));
    expect(h.read(1, 'buttons')).toBe(5);
    expect(h.read(1, 'seq')).toBe(7);
    // Слот без фрейма не получает чужой ввод.
    expect(h.read(0, 'buttons')).toBe(0);
  });

  it('prevButtons хранит маску прошлого тика', () => {
    const h = harness(['p1']);
    h.step([frame('p1', 1, { buttons: 1 })]);
    expect(h.read(0, 'prevButtons')).toBe(0);

    h.step([frame('p1', 2, { buttons: 3 })]);
    expect(h.read(0, 'prevButtons')).toBe(1);
    expect(h.read(0, 'buttons')).toBe(3);
  });

  it('пропущенный фрейм обнуляет намерение, но не seq', () => {
    const h = harness(['p1']);
    h.step([frame('p1', 1, { move: { x: F(1), y: F(1) }, buttons: 1, seq: 4 })]);
    h.step([]);

    expect(h.read(0, 'moveX')).toBe(0);
    expect(h.read(0, 'moveY')).toBe(0);
    expect(h.read(0, 'buttons')).toBe(0);
    expect(h.read(0, 'prevButtons')).toBe(1);
    expect(h.read(0, 'seq')).toBe(4);
  });

  it('фрейм слота без живой сущности — ошибка', () => {
    const h = harness(['p1', 'p2'], 1);
    expect(() => { h.step([frame('p2', 1)]); }).toThrow(/слота 1 без живой сущности/);
  });

  it('фрейм игрока вне списка — ошибка', () => {
    const h = harness(['p1']);
    expect(() => { h.step([frame('p9', 1)]); }).toThrow(/"p9" не объявлен/);
  });

  it('два фрейма одного игрока на тике — ошибка', () => {
    const h = harness(['p1']);
    expect(() => { h.step([frame('p1', 1), frame('p1', 1)]); }).toThrow(/два фрейма/);
  });

  it('дубликат в списке игроков — ошибка конструктора', () => {
    expect(() => new InputSystem({ players: ['p1', 'p1'] })).toThrow(/указан дважды/);
  });
});

describe('точка прицела в компоненте ввода (TICK-2, TICK-4)', () => {
  it('раскладывается, когда сцена объявила пару полей', () => {
    const h = harness(['p1'], 1, SCENE_WITH_TARGET);
    h.step([frame('p1', 1, { target: { x: F(3.5), y: F(-2.25) } })]);

    expect(h.read(0, 'targetX')).toBe(F(3.5));
    expect(h.read(0, 'targetY')).toBe(F(-2.25));
  });

  it('сцена без пары полей точку не видит и не ломается о неё', () => {
    const h = harness(['p1']);
    // Кадр несёт точку, компонент её не объявляет — раскладки нет, ошибки тоже:
    // точка нужна ровно той сцене, чьи способности ею целятся (ABIL-5).
    expect(() => { h.step([frame('p1', 1, { target: { x: F(3.5), y: F(-2.25) } })]); }).not.toThrow();
    expect(h.read(0, 'moveX')).toBe(0);
  });

  it('пропущенный фрейм точку НЕ обнуляет: это последнее известное состояние ввода', () => {
    const h = harness(['p1'], 1, SCENE_WITH_TARGET);
    h.step([frame('p1', 1, { move: { x: F(1), y: 0 }, target: { x: F(4), y: F(5) } })]);
    h.step([]);

    // Намерение обнулено...
    expect(h.read(0, 'moveX')).toBe(0);
    expect(h.read(0, 'buttons')).toBe(0);
    // ...а точка держится: обнулённая, она означала бы «целюсь в начало
    // координат» — намерение, которого игрок не выражал.
    expect(h.read(0, 'targetX')).toBe(F(4));
    expect(h.read(0, 'targetY')).toBe(F(5));
  });

  it('фрейм без точки её тоже не гасит', () => {
    const h = harness(['p1'], 1, SCENE_WITH_TARGET);
    h.step([frame('p1', 1, { target: { x: F(4), y: F(5) } })]);
    h.step([frame('p1', 2, { buttons: 1 })]);

    expect(h.read(0, 'targetX')).toBe(F(4));
    expect(h.read(0, 'targetY')).toBe(F(5));
  });

  it('объявление точки — обе половины или ни одной', () => {
    const half: SceneDef = {
      components: [
        SCENE.components[0]!,
        { name: 'Input', fields: { ...SCENE.components[1]!.fields, targetX: 'fixed' } },
      ],
    };
    const { world } = loadScene(half);
    expect(inputTargetDeclared(world)).toBe(false);
    expect(inputTargetDeclared(loadScene(SCENE_WITH_TARGET).world)).toBe(true);
    expect(inputTargetDeclared(loadScene(SCENE).world)).toBe(false);
  });
});

describe('сценарий с вводом (CLI-2)', () => {
  const base: ScenarioDef = {
    name: 'inputs',
    seed: 1,
    ticks: 1,
    scene: SCENE,
    initial: [{ prefab: 'Hero' }],
  };

  it('inputs без players — ошибка до первого тика', () => {
    const def: ScenarioDef = { ...base, inputs: [frame('p1', 1)] };
    expect(() => runScenario(def)).toThrow(/нет "players"/);
  });

  it('пустой inputs без players — тоже ошибка: правило CLI-2 смотрит на наличие поля, не на непустоту', () => {
    const def: ScenarioDef = { ...base, inputs: [] };
    expect(() => runScenario(def)).toThrow(/нет "players"/);
  });

  it('buttons шире u16 — ошибка валидации на загрузке, а не усечённая маска (TICK-2)', () => {
    const def: ScenarioDef = {
      ...base,
      players: ['p1'],
      // Бит №16: через транспорт такая маска не проходит (NTR-7), и документ
      // прогона обязан отказать по той же границе, а не положить её в мир.
      inputs: [frame('p1', 1, { buttons: 70000 })],
    };
    expect(() => runScenario(def)).toThrow(/"buttons".*0\.\.65535 \(TICK-2\)/);
  });

  it('отрицательная и дробная маска отвергаются той же проверкой (TICK-2)', () => {
    const negative: ScenarioDef = { ...base, players: ['p1'], inputs: [frame('p1', 1, { buttons: -1 })] };
    expect(() => runScenario(negative)).toThrow(/"buttons"/);
    const fractional: ScenarioDef = { ...base, players: ['p1'], inputs: [frame('p1', 1, { buttons: 1.5 })] };
    expect(() => runScenario(fractional)).toThrow(/"buttons"/);
  });

  it('границы диапазона законны: 0 и 65535 грузятся и доезжают до мира (TICK-2)', () => {
    const def: ScenarioDef = {
      ...base,
      players: ['p1'],
      inputs: [frame('p1', 1, { buttons: 65535 })],
    };

    const out = runScenario(def);
    expect(out.ticks[1]!.world.components.Input!.buttons![0]).toBe(65535);
  });

  it('players регистрируют InputSystem, ввод виден в снапшоте', () => {
    const def: ScenarioDef = {
      ...base,
      players: ['p1'],
      inputs: [frame('p1', 1, { move: { x: F(3), y: 0 } })],
    };

    const out = runScenario(def);
    expect(out.ticks[1]!.world.components.Input!.moveX![0]).toBe(F(3));
  });

  it('сборка сама включает раскладку точки по составу компонента сцены', () => {
    const def: ScenarioDef = {
      ...base,
      scene: SCENE_WITH_TARGET,
      players: ['p1'],
      inputs: [frame('p1', 1, { target: { x: F(6), y: F(7) } })],
    };

    const out = runScenario(def);
    expect(out.ticks[1]!.world.components.Input!.targetX![0]).toBe(F(6));
    expect(out.ticks[1]!.world.components.Input!.targetY![0]).toBe(F(7));
  });
});
