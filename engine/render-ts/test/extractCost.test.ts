/**
 * Счётчики стадии «экстракция и канал доставки» (`performance-budget` PERF-2,
 * PERF-3).
 *
 * Стадия эта — воркер-сторона потока тиков (SHELL-2): её работу не видит ни
 * браузерный бенч кадра (экстракция идёт не в rAF-колбэке), ни счётчики
 * доставки и кадра. Поэтому здесь проверяется ровно то, ради чего счётчики
 * заведены: величины считаются те, что заявлены, объём канала растёт числом
 * КОЛОНОК плоской формы, а выключенный сток не стоит ничего.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  FLOOR_COMPONENT,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type Scene,
  type Simulation,
  type System,
} from '@fluxus/core';
import {
  Extractor,
  createCostCounters,
  costSink,
  kindByTags,
  withCostSink,
} from '../src/index.js';

const F = (n: number): number => fixed.fromFloat(n);

/**
 * Сцена стенда: террейн 2×2 (его singleton-сущность носит карту пола, но НЕ
 * носит `Position` — на ней и видно разницу между просмотренным и
 * скопированным) и двое бегунов со статом здоровья.
 */
function makeScene(): { scene: Scene; sim: Simulation } {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Health', fields: { hp: 'i32' } },
    ],
    prefabs: [
      {
        name: 'Runner',
        components: { Position: {}, Velocity: {}, Health: { hp: 10 } },
        tags: ['Runner'],
      },
    ],
    terrain: {
      width: 2,
      height: 2,
      tileSize: FIXED_ONE,
      levels: ['00', '00'],
      flags: ['..', '..'],
    },
  });
  // Пол выбивается на шестом тике: дельта пола — единственная работа зеркала,
  // которая доезжает до канала значениями, а не остаётся просмотром (TERR-6).
  const breaker: System = {
    name: 'FloorBreaker',
    order: 40,
    run(ctx) {
      if (ctx.tick !== 6) return;
      for (const terrain of ctx.query({ withTag: 'terrain' })) {
        const word = ctx.get(terrain, FLOOR_COMPONENT, 'w0');
        ctx.commands.setField(terrain, FLOOR_COMPONENT, 'w0', word & ~1);
      }
    },
  };
  const caster: System = {
    name: 'Caster',
    order: 20,
    run(ctx) {
      if (ctx.tick !== 3) return;
      ctx.events.emit('CastFireball', { dirX: 0, dirY: F(1) });
    },
  };
  scene.systems.register(caster);
  scene.systems.register(breaker);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };
  return { scene, sim };
}

function stand(): { extractor: Extractor; sim: Simulation; state: ReturnType<typeof initialState> } {
  const { scene, sim } = makeScene();
  for (const x of [0.5, 1.5]) {
    worldInitSpawn(scene.world, 'Runner', {
      Position: { x: F(x), y: F(0.5) },
      Velocity: { x: F(0.1), y: F(0) },
    });
  }
  const state = initialState(scene.world, 7);
  const extractor = new Extractor({
    kindOf: kindByTags(['Runner']),
    terrainGrid: scene.terrain!.grid,
    aimEvents: ['CastFireball'],
    stats: [{ name: 'hp', component: 'Health', field: 'hp' }],
  });
  return { extractor, sim, state };
}

/** Колонок на сущность в плоской форме — множитель объёма канала (SHELL-3). */
const CHANNEL_COLUMNS = 13;

describe('PERF-2: стадия «экстракция и канал доставки» считает свою работу', () => {
  it('вызовы, просмотренные и скопированные сущности, статы, события и клетки пола', () => {
    const { extractor, sim, state } = stand();
    const counters = createCostCounters();

    withCostSink(counters, () => {
      for (let step = 0; step < 8; step++) extractor.extract(tick(sim, state));
    });

    // Восемь тиков — восемь вызовов: знаменатель стадии.
    expect(counters.extractCalls).toBe(8);
    // Скопированы двое бегунов на тик; просмотрена ещё и сущность террейна —
    // `Position` у неё нет, и в доставку она не едет, а обход её проверяет.
    expect(counters.extractEntitiesCopied).toBe(16);
    expect(counters.extractEntitiesScanned).toBe(24);
    // Стат объявлен один и есть у обоих бегунов: пара на сущность на тик.
    expect(counters.extractStatPairs).toBe(16);
    // Событие каста ровно одно за прогон (третий тик).
    expect(counters.extractEvents).toBe(1);
    // Зеркало пола перечитывает карту (четыре клетки) на первом тике и на том,
    // где дельта тронула компонент, — но не на каждом (REND-7).
    expect(counters.extractFloorCellsScanned).toBe(8);
  });

  it('объём канала — колонки плоской формы, а не одно число сущностей', () => {
    const { extractor, sim, state } = stand();
    const counters = createCostCounters();

    withCostSink(counters, () => {
      for (let step = 0; step < 8; step++) extractor.extract(tick(sim, state));
    });

    // Канал копирует ровно колонки экстракта (`codec.writeTick`, SHELL-3):
    // сущности × колонки, пары статов (индекс и значение) и пары клеток пола.
    // Пара пола за прогон одна — выбитая клетка шестого тика.
    expect(counters.extractChannelValues).toBe(
      counters.extractEntitiesCopied * CHANNEL_COLUMNS + counters.extractStatPairs * 2 + 2,
    );
    // Из числа сущностей величина не выводится: она растёт и от статов, и от
    // пола, и от числа колонок — ради последнего счётчик и заведён.
    expect(counters.extractChannelValues).toBeGreaterThan(
      counters.extractEntitiesCopied * CHANNEL_COLUMNS,
    );
  });

  it('PERF-3: выключенный учёт бесплатен — без стока экстракция ничего не считает', () => {
    const { extractor, sim, state } = stand();
    const counters = createCostCounters();

    // Замера нет: сток не подключён вовсе, и работы учёта не выполняется.
    for (let step = 0; step < 4; step++) extractor.extract(tick(sim, state));
    expect(costSink()).toBeUndefined();
    expect(counters.extractCalls).toBe(0);
    expect(counters.extractEntitiesScanned).toBe(0);
    expect(counters.extractChannelValues).toBe(0);

    // Тот же экстрактор под стоком считает: инструментирование не зависит от
    // истории вызовов, только от наличия стока.
    withCostSink(counters, () => {
      extractor.extract(tick(sim, state));
    });
    expect(counters.extractCalls).toBe(1);
    expect(counters.extractEntitiesCopied).toBe(2);
  });
});
