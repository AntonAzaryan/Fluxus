/**
 * Бюджет кадра подсистем (`rendering` REND-44): сцена владеет потолком и
 * часами, подсистема вписывается необязательным хуком, отложенное не теряется,
 * а синхронные точки доделывают его целиком.
 *
 * Часы здесь — счётчик, который двигают руками: бюджет меряется временем, и
 * тест, полагающийся на настоящие часы, был бы измерением машины, а не
 * поведения (тот же приём, что у `ViewBuffer` и документного источника).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@fluxus/core';
import {
  PresentationStage,
  TerrainSubsystem,
  WaterSubsystem,
  VisualSurfaceSource,
  createCostCounters,
  withCostSink,
  type FrameBudget,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '../src/index.js';
import { makeRenderContext, makeTickView } from './fixtures.js';

/** Часы теста: миллисекунды двигает сам тест, а не машина. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 0;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/**
 * Подсистема с очередью порций: каждая порция «стоит» миллисекунду по часам
 * теста. Ничего не рисует — проверяется механизм сцены, а не картинка.
 */
class Worker implements RenderSubsystem {
  readonly done: string[] = [];
  private pending: number;

  constructor(
    readonly name: string,
    units: number,
    private readonly advance: (ms: number) => void,
    private readonly costMs = 1,
  ) {
    this.pending = units;
  }

  get left(): number {
    return this.pending;
  }

  init(): void {}
  syncTick(_view: TickView): void {}
  updateFrame(): void {}

  updateBudgeted(budget: FrameBudget): void {
    while (this.pending > 0) {
      if (!budget.hasTime()) {
        budget.defer();
        return;
      }
      this.pending--;
      this.advance(this.costMs);
      this.done.push(this.name);
    }
  }
}

describe('REND-44: бюджет кадра — сцена владеет потолком и часами', () => {
  it('бюджет не назван: нарезки нет, счётчик отложений нулевой', () => {
    const clock = fakeClock();
    const worker = new Worker('a', 5, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), { clock: clock.now }).register(worker);

    const cost = createCostCounters();
    withCostSink(cost, () => {
      stage.frame(0.016, 0);
    });

    // Умолчание сцены — «не ограничен» (design D6): кадр делает всё сразу и
    // ведёт себя ровно как сцена без механизма бюджета.
    expect(worker.left).toBe(0);
    expect(cost.frameBudgetDeferrals).toBe(0);
  });

  it('малый бюджет: работа растянута по кадрам и ни одна порция не потеряна', () => {
    const clock = fakeClock();
    const worker = new Worker('a', 5, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 2,
    }).register(worker);

    const cost = createCostCounters();
    withCostSink(cost, () => {
      stage.frame(0.016, 0);
    });
    // Порция начинается, пока время есть: две уместились, третья уже нет.
    expect(worker.done).toEqual(['a', 'a']);
    expect(cost.frameBudgetDeferrals).toBe(1);

    withCostSink(cost, () => {
      stage.frame(0.016, 0);
      stage.frame(0.016, 0);
    });
    // Ни одна порция не потеряна: очередь досчитана следующими кадрами.
    expect(worker.left).toBe(0);
    expect(worker.done).toHaveLength(5);
  });

  it('вписавшихся нет — часы не читаются вовсе', () => {
    let reads = 0;
    const plain: RenderSubsystem = {
      name: 'plain',
      init: () => {},
      syncTick: () => {},
      updateFrame: () => {},
    };
    const stage = new PresentationStage(makeRenderContext(), {
      frameBudgetMs: 1,
      clock: () => {
        reads++;
        return 0;
      },
    }).register(plain);

    stage.frame(0.016, 0);

    // Сцена без вписавшихся не платит за механизм ничем: ни чтения часов, ни
    // взвода бюджета (REND-44).
    expect(reads).toBe(0);
  });

  it('постоянно занятый сосед не съедает бюджет второго навсегда (design D5)', () => {
    const clock = fakeClock();
    const greedy = new Worker('greedy', 100, clock.advance);
    const quiet = new Worker('quiet', 2, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 2,
    })
      .register(greedy)
      .register(quiet);

    for (let frame = 0; frame < 4; frame++) stage.frame(0.016, 0);

    // Сдвиг старта обхода даёт бюджет и второй подсистеме: без него она ждала
    // бы вечно грязного соседа бесконечно.
    expect(quiet.left).toBe(0);
    expect(greedy.left).toBeGreaterThan(0);
  });

  it('вписавшуюся зовут даже без времени: иначе кадр сделал бы её работу мимо бюджета', () => {
    const clock = fakeClock();
    const greedy = new Worker('greedy', 10, clock.advance);
    const seen: boolean[] = [];
    const late: RenderSubsystem = {
      name: 'late',
      init: () => {},
      syncTick: () => {},
      updateFrame: () => {},
      updateBudgeted: (budget) => {
        // Подсистема ОБЯЗАНА узнать, что фаза была: узнав, она отложит работу
        // сама, а не сделает её целиком в покадровом обновлении (REND-44).
        seen.push(budget.hasTime());
      },
    };
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 1,
    })
      .register(greedy)
      .register(late);

    stage.frame(0.016, 0);

    expect(seen).toEqual([false]);
  });

  it('разрыв непрерывности доделывает отложенное синхронно', () => {
    const clock = fakeClock();
    const worker = new Worker('a', 5, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 1,
    }).register(worker);

    stage.frame(0.016, 0);
    expect(worker.left).toBeGreaterThan(0);

    // `snapAll` — перемотка, смена режима, первая доставка: размазывать её по
    // кадрам MUST NOT (REND-44, по образцу FOW-11).
    stage.publish({ name: 'test' }, { ...makeTickView([]), snapAll: true });
    expect(worker.left).toBe(0);
  });

  it('снос сцены доделывает отложенное: «отложено и потеряно» не бывает', () => {
    const clock = fakeClock();
    const worker = new Worker('a', 5, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 1,
    }).register(worker);

    stage.frame(0.016, 0);
    expect(worker.left).toBeGreaterThan(0);

    stage.dispose();
    expect(worker.left).toBe(0);
  });

  it('продюсер называет бюджет своего кадра: документный источник — без потолка', () => {
    const clock = fakeClock();
    const worker = new Worker('a', 5, clock.advance);
    const stage = new PresentationStage(makeRenderContext(), {
      clock: clock.now,
      frameBudgetMs: 1,
    }).register(worker);

    // Четвёртый аргумент — потолок ЭТОГО кадра (design D1): им документный
    // источник редактора работает без нарезки (ED-15).
    stage.frame(0.016, 0, 0.016, Number.POSITIVE_INFINITY);

    expect(worker.left).toBe(0);
  });
});

const STEP = 0.5;

/** Арена 8×8 в четырёх чанках 4×4: есть что откладывать и что выбирать. */
function arena() {
  return createTerrainGrid({
    width: 8,
    height: 8,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: 8 }, () => '00000000'),
    flags: Array.from({ length: 8 }, () => '........'),
  });
}

function terrainRig(options: { budgetMs?: number; camera?: THREE.Camera } = {}) {
  const clock = fakeClock();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: {} as RenderContext['assets'],
    config: { heightStep: STEP },
  };
  const terrain = new TerrainSubsystem(arena(), {
    chunkSize: 4,
    ...(options.camera === undefined ? {} : { camera: options.camera }),
  });
  const stage = new PresentationStage(ctx, {
    clock: clock.now,
    ...(options.budgetMs === undefined ? {} : { frameBudgetMs: options.budgetMs }),
  });
  return { clock, ctx, terrain, stage };
}

describe('REND-44: террейн под бюджетом кадра', () => {
  it('первая сборка арены синхронна даже при нулевом бюджете', () => {
    const rig = terrainRig({ budgetMs: 0 });
    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.stage.register(rig.terrain);
    });

    // Половина арены в первом кадре — дефект, а не отложенная работа (REND-44):
    // регистрация строит геометрию целиком, минуя бюджетную фазу.
    expect(cost.terrainChunksRebuilt).toBe(4);
    expect(cost.frameBudgetDeferrals).toBe(0);
    expect(rig.terrain.floorVertexCount).toBeGreaterThan(0);
  });

  it('малый бюджет режет пересборку по кадрам, и ни одна пометка не теряется', () => {
    const rig = terrainRig({ budgetMs: 0 });
    rig.stage.register(rig.terrain);
    // Четыре угловые клетки — по одной на чанк арены (TERR-6, REND-7).
    rig.terrain.syncTick(floorDelta([0, 7, 56, 63]));

    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.stage.frame(0.016, 0);
    });
    // Нулевой потолок не значит «ничего»: первая порция прохода начинается
    // всегда — иначе отложенное не доехало бы никогда (REND-44).
    expect(cost.terrainChunksRebuilt).toBe(1);
    expect(cost.frameBudgetDeferrals).toBe(1);

    withCostSink(cost, () => {
      for (let frame = 0; frame < 3; frame++) rig.stage.frame(0.016, 0);
    });
    // Все четыре пересобраны — по одному на кадр, и ни одной пометки не
    // потеряно; сумма работы та же, что у прогона без бюджета.
    expect(cost.terrainChunksRebuilt).toBe(4);

    const plain = terrainRig();
    plain.stage.register(plain.terrain);
    plain.terrain.syncTick(floorDelta([0, 7, 56, 63]));
    const whole = createCostCounters();
    withCostSink(whole, () => {
      plain.stage.frame(0.016, 0);
    });
    expect(whole.terrainChunksRebuilt).toBe(cost.terrainChunksRebuilt);
    expect(whole.frameBudgetDeferrals).toBe(0);
  });

  it('прямой драйв подсистемы бюджета не видит: кадр пересобирает всё', () => {
    // Подсистема без сцены (тесты, вьюпорт, сборка без бюджета) обязана
    // держать «не позже следующего кадра» (REND-7) сама.
    const rig = terrainRig();
    rig.terrain.init(rig.ctx);
    rig.terrain.syncTick(floorDelta([0, 7, 56, 63]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.terrain.updateFrame(0.016, 0);
    });
    expect(cost.terrainChunksRebuilt).toBe(4);
  });

  it('ближайший к камере чанк пересобирается первым (design D8)', () => {
    const camera = new THREE.PerspectiveCamera();
    // Камера у дальнего угла арены: ближайший к ней чанк — правый нижний.
    camera.position.set(8, 8, 4);
    const rig = terrainRig({ camera, budgetMs: 0 });
    rig.stage.register(rig.terrain);

    // Метим два чанка: дальний (0,0) и ближний к камере (7,7). Бюджет нулевой,
    // поэтому кадр пересоберёт ровно один — тот, что выбрал порядок.
    rig.terrain.syncTick(floorDelta([0, 63]));
    const order: number[] = [];
    const scene = rig.ctx.scene;
    // Пересборка меняет меши чанков; порядок читается по именам новых мешей.
    const before = new Set(scene.children.map((node) => node.uuid));
    rig.stage.frame(0.016, 0);
    for (const node of scene.children) {
      if (before.has(node.uuid)) continue;
      const match = /terrain:chunk:(\d),(\d)/.exec(node.name);
      if (match !== null) order.push(Number(match[1]) + Number(match[2]) * 2);
    }
    // Пересобран ровно один — ближний к камере: отложенный чанк за спиной
    // игрока не виден вовсе (design D8).
    expect(order).toEqual([3]);
  });
});

/** Доставка с мутацией пола названных клеток — вход пометки чанков (TERR-6). */
function floorDelta(cells: readonly number[] = [0]): TickView {
  const bits = new Uint8Array(64).fill(1);
  for (const cell of cells) bits[cell] = 0;
  return { ...makeTickView([]), floorBits: bits, floorChangedCells: [...cells] };
}

describe('REND-44: вода под бюджетом кадра', () => {
  it('полосы глубины досчитываются следующими кадрами, сумма текселей та же', () => {
    const grid = arena();
    // Секция минимального состава (REND-35): карта клеток тела и урез с цветами.
    const config = {
      cells: [
        '........',
        '.000000.',
        '.000000.',
        '.000000.',
        '.000000.',
        '.000000.',
        '.000000.',
        '........',
      ],
      bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
    };
    const rigOf = (budgetMs?: number) => {
      const clock = fakeClock();
      const ctx: RenderContext = {
        scene: new THREE.Scene(),
        assets: {} as RenderContext['assets'],
        config: { heightStep: STEP },
      };
      const water = new WaterSubsystem({
        grid,
        surface: new VisualSurfaceSource(grid),
        config,
        warn: () => {},
      });
      const stage = new PresentationStage(ctx, {
        clock: clock.now,
        ...(budgetMs === undefined ? {} : { frameBudgetMs: budgetMs }),
      }).register(water);
      return { clock, water, stage };
    };

    const sliced = rigOf(0);
    const whole = rigOf();
    const slicedCost = createCostCounters();
    const wholeCost = createCostCounters();
    withCostSink(slicedCost, () => {
      for (let frame = 0; frame < 12; frame++) sliced.stage.frame(0.016, 0);
    });
    withCostSink(wholeCost, () => {
      whole.stage.frame(0.016, 0);
    });

    // Нулевой бюджет не роняет работу: полосы досчитываются кадрами, и тексель
    // заполняется ровно один раз — сумма за прогон та же (design D9, PERF-3).
    expect(slicedCost.waterDepthTexels).toBe(wholeCost.waterDepthTexels);
    expect(slicedCost.frameBudgetDeferrals).toBeGreaterThan(0);
  });
});

describe('REND-44: две вписавшиеся подсистемы делят один бюджет', () => {
  it('нулевой потолок: за кадр продвигается одна, за пару кадров — обе', () => {
    const clock = fakeClock();
    const grid = arena();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: {} as RenderContext['assets'],
      config: { heightStep: STEP },
    };
    const terrain = new TerrainSubsystem(grid, { chunkSize: 4 });
    const water = new WaterSubsystem({
      grid,
      surface: new VisualSurfaceSource(grid),
      config: {
        cells: [
          '........',
          '.000000.',
          '.000000.',
          '.000000.',
          '.000000.',
          '.000000.',
          '.000000.',
          '........',
        ],
        bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
      },
      warn: () => {},
    });
    const stage = new PresentationStage(ctx, { clock: clock.now, frameBudgetMs: 0 })
      .register(terrain)
      .register(water);

    // Мутация пола метит чанки террейну и клетки воде — одной доставкой (TERR-6).
    const delta = floorDelta([0, 7, 56, 63]);
    terrain.syncTick(delta);
    water.syncTick(delta);

    const first = createCostCounters();
    withCostSink(first, () => {
      stage.frame(0.016, 0);
    });
    // Кадр продвинул РОВНО одну порцию: гарантия прогресса одна на проход, и
    // вторая подсистема свою работу отложила, а не сделала мимо бюджета.
    expect(first.terrainChunksRebuilt + (first.waterDepthTexels > 0 ? 1 : 0)).toBe(1);
    expect(first.frameBudgetDeferrals).toBeGreaterThan(0);

    const rest = createCostCounters();
    withCostSink(rest, () => {
      for (let frame = 0; frame < 20; frame++) stage.frame(0.016, 0);
    });
    // Сдвиг старта обхода довёл до конца обе: ни одна не осталась голодной.
    expect(first.terrainChunksRebuilt + rest.terrainChunksRebuilt).toBe(4);
    expect(rest.waterDepthTexels).toBeGreaterThan(0);
  });
});
