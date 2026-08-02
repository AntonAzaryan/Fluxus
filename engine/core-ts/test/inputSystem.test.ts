import { describe, expect, it } from 'vitest';
import { InputSystem } from '../src/systems/inputSystem.js';
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

/** Мир с героями по числу слотов и симуляция с одной `InputSystem`. */
function harness(players: readonly string[], heroes = players.length) {
  const { world, systems } = loadScene(SCENE);
  systems.register(new InputSystem({ players }));
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
    expect(() => h.step([frame('p2', 1)])).toThrow(/слота 1 без живой сущности/);
  });

  it('фрейм игрока вне списка — ошибка', () => {
    const h = harness(['p1']);
    expect(() => h.step([frame('p9', 1)])).toThrow(/"p9" не объявлен/);
  });

  it('два фрейма одного игрока на тике — ошибка', () => {
    const h = harness(['p1']);
    expect(() => h.step([frame('p1', 1), frame('p1', 1)])).toThrow(/два фрейма/);
  });

  it('дубликат в списке игроков — ошибка конструктора', () => {
    expect(() => new InputSystem({ players: ['p1', 'p1'] })).toThrow(/указан дважды/);
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

  it('players регистрируют InputSystem, ввод виден в снапшоте', () => {
    const def: ScenarioDef = {
      ...base,
      players: ['p1'],
      inputs: [frame('p1', 1, { move: { x: F(3), y: 0 } })],
    };

    const out = runScenario(def);
    expect(out.ticks[1]!.world.components['Input']!['moveX']![0]).toBe(F(3));
  });
});
