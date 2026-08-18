/**
 * Счётчики стоимости рендера (`performance-budget` PERF-3, задачи 1.1–1.3):
 * инертность выключенного учёта, пропорциональность счётчиков тумана осям
 * стоимости (разрешение маски, наблюдатели, сегменты укрытий) и снятие
 * инстансов на общем шве презентационного тракта (PERF-2).
 *
 * WebGL и DOM здесь нет: рендерер — структурный спай стенда (`RendererSpy`),
 * канвас слоя миникарты — стаб. Вызовы рендерера считает спай, а подсистема
 * считает их же своим счётчиком — тест сверяет обе бухгалтерии.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@game-mvp/core';
import {
  COST_COUNTER_STAGES,
  FogSubsystem,
  PresentationStage,
  VisibilityMask,
  attachCostSink,
  costSink,
  createCostCounters,
  fogRectOf,
  fogSegmentsOf,
  withCostSink,
  type EntityView,
  type PresentationProducer,
  type RenderCostCounters,
  type RenderSubsystem,
  type TickView,
} from '../src/index.js';
import {
  RendererSpy,
  flatGrid,
  fogCanvasFactory,
  makeEntityView,
  makeRenderContext,
  makeTickView,
  pillarGrid,
} from './fixtures.js';

// ------------------------------------------------------------------- стенд

const STATS = { visionRadius: 'vision', team: 'team' } as const;

function observerView(id: number, x: number, y: number, vision: number): EntityView {
  return makeEntityView(id, {
    currX: x,
    currY: y,
    prevX: x,
    prevY: y,
    stats: new Map([
      [STATS.team, 0],
      [STATS.visionRadius, vision],
    ]),
  });
}

interface FogStand {
  readonly fog: FogSubsystem;
  readonly view: TickView;
}

/** Подсистема тумана и одна доставка: ось задаётся разрешением, наблюдателями и сеткой. */
function fogStand(options: {
  resolution?: number;
  observers?: readonly (readonly [number, number])[];
  pillarStep?: number;
  vision?: number;
}): FogStand {
  const observers = options.observers ?? [[4, 4]];
  const vision = options.vision ?? 1.5;
  const fog = new FogSubsystem({
    grid: options.pillarStep === undefined ? flatGrid(8) : pillarGrid(8, options.pillarStep),
    stats: STATS,
    hero: () => 1,
    config: { resolution: options.resolution ?? 4 },
    createCanvas: fogCanvasFactory(),
  });
  fog.init(makeRenderContext());
  const view = makeTickView(
    observers.map(([x, y], index) => observerView(index + 1, x, y, vision)),
  );
  return { fog, view };
}

/** Одна доставка стенда под снятым замером — счётчики одной перестройки маски. */
function deliverCost(options: Parameters<typeof fogStand>[0]): RenderCostCounters {
  const counters = createCostCounters();
  withCostSink(counters, () => {
    const stand = fogStand(options);
    stand.fog.syncTick(stand.view);
  });
  return counters;
}

/** Подсистема-пустышка: считает свои вызовы, сцены не трогает. Декораций не знает. */
class CountingSubsystem implements RenderSubsystem {
  readonly name: string;
  syncs = 0;
  frames = 0;
  decorations = 0;
  constructor(name: string) {
    this.name = name;
  }
  init(): void {}
  syncTick(): void {
    this.syncs++;
  }
  updateFrame(): void {
    this.frames++;
  }
}

/** Та же пустышка, но владеющая decoration-инстансами (REND-18). */
class DecoratedSubsystem extends CountingSubsystem {
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    this.decorations += entities.size;
  }
}

const PRODUCER_A: PresentationProducer = { name: 'A' };
const PRODUCER_B: PresentationProducer = { name: 'B' };

// ------------------------------------------- 1.1: инертность выключенного учёта

describe('PERF-3: сток счётчиков стоимости — инертность и форма', () => {
  it('без подключённого стока учёт не исполняется, а картинка та же', () => {
    // Прогон без стока: счётчики, созданные рядом, остаться обязаны нулевыми.
    const idle = createCostCounters();
    const plain = fogStand({});
    plain.fog.syncTick(plain.view);
    expect(idle).toEqual(createCostCounters());
    expect(costSink()).toBeUndefined();

    // Тот же прогон со стоком: работа посчитана, а растр маски побитово тот же —
    // учёт на измеряемое не влияет.
    const measured = deliverCost({});
    expect(measured.fogMaskTexels).toBeGreaterThan(0);
    const stand = fogStand({});
    withCostSink(createCostCounters(), () => {
      stand.fog.syncTick(stand.view);
    });
    expect(stand.fog.visibility.data).toEqual(plain.fog.visibility.data);
  });

  it('счётчики трогает только подключённый сток — ни одной записи мимо него', () => {
    const written: string[] = [];
    const watched = new Proxy(createCostCounters(), {
      set(target, key, value: number): boolean {
        written.push(String(key));
        return Reflect.set(target, key, value);
      },
    });

    const stand = fogStand({});
    withCostSink(watched, () => {
      stand.fog.syncTick(stand.view);
    });
    expect(written.length).toBeGreaterThan(0);

    // Сток снят — тот же путь не пишет вообще никуда.
    written.length = 0;
    stand.fog.syncTick(stand.view);
    expect(written).toEqual([]);
  });

  it('структура стока плоская: одни целые числа, объектных литералов на пути нет', () => {
    const counters = createCostCounters();
    const stand = fogStand({});
    withCostSink(counters, () => {
      // Сток отдаётся горячему пути тем же объектом, без обёртки: инкремент —
      // единственное, что делает инструментирование (PERF-3).
      expect(costSink()).toBe(counters);
      stand.fog.syncTick(stand.view);
    });
    for (const value of Object.values(counters)) {
      expect(typeof value).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('у каждого счётчика объявлена стадия конвейера (PERF-2)', () => {
    expect(Object.keys(COST_COUNTER_STAGES).sort()).toEqual(Object.keys(createCostCounters()).sort());
    for (const stage of Object.values(COST_COUNTER_STAGES)) {
      expect(['syncTick', 'frame']).toContain(stage);
    }
  });

  it('сток снимается после замера — и при обрыве тела исключением', () => {
    const counters = createCostCounters();
    withCostSink(counters, () => {
      expect(costSink()).toBe(counters);
    });
    expect(costSink()).toBeUndefined();

    expect(() =>
      withCostSink(counters, () => {
        throw new Error('обрыв замера');
      }),
    ).toThrow('обрыв замера');
    expect(costSink()).toBeUndefined();
  });

  it('ручное подключение возвращает предыдущий сток', () => {
    const counters = createCostCounters();
    const previous = attachCostSink(counters);
    expect(previous).toBeUndefined();
    expect(costSink()).toBe(counters);
    expect(attachCostSink(previous)).toBe(counters);
    expect(costSink()).toBeUndefined();
  });

  it('одна и та же нагрузка даёт побитово те же счётчики (PERF-3)', () => {
    const first = deliverCost({ resolution: 8, pillarStep: 3, observers: [[2, 2], [6, 6]] });
    const second = deliverCost({ resolution: 8, pillarStep: 3, observers: [[2, 2], [6, 6]] });
    expect(second).toEqual(first);
  });
});

// ------------------------------------- 1.2: счётчики маски по осям стоимости

describe('PERF-3, PERF-6: счётчики тумана растут по осям стоимости', () => {
  it('разрешение 4 → 8: полномасочные счётчики ровно вчетверо, просмотр — около того', () => {
    const low = deliverCost({ resolution: 4 });
    const high = deliverCost({ resolution: 8 });

    // Обнуление, загрузка в текстуру и блит миникарты идут по всему растру:
    // удвоение разрешения — ровно четырёхкратное удорожание (FOW-10).
    expect(low.fogMaskClearTexels).toBe(32 * 32);
    expect(high.fogMaskClearTexels).toBe(4 * low.fogMaskClearTexels);
    expect(high.fogMaskUploadBytes).toBe(4 * low.fogMaskUploadBytes);
    expect(high.fogMinimapTexels).toBe(4 * low.fogMinimapTexels);

    // Просмотр reveal-цикла — прямоугольник наблюдателя: вчетверо с точностью
    // до округления границ, а не ровно.
    const ratio = high.fogMaskTexels / low.fogMaskTexels;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
    expect(high.fogMaskTexelsWritten).toBeGreaterThan(3 * low.fogMaskTexelsWritten);
  });

  it('число наблюдателей: reveal-полигоны и просмотренные тексели кратны ему', () => {
    const one = deliverCost({ observers: [[2, 2]] });
    const four = deliverCost({ observers: [[2, 2], [2, 6], [6, 2], [6, 6]] });

    expect(one.fogRevealCalls).toBe(1);
    expect(four.fogRevealCalls).toBe(4);
    expect(four.fogEntitiesScanned).toBe(4);
    // Круги одного радиуса и не задеты краем маски — прямоугольники равны.
    expect(four.fogMaskTexels).toBe(4 * one.fogMaskTexels);
    // Полномасочная работа от числа наблюдателей не зависит вовсе.
    expect(four.fogMaskClearTexels).toBe(one.fogMaskClearTexels);
    expect(four.fogMaskUploadBytes).toBe(one.fogMaskUploadBytes);
  });

  it('загрузка в текстуру считается ровно один раз на доставку', () => {
    const counters = createCostCounters();
    const stand = withCostSink(counters, () => {
      // Стенд строится ПОД замером: создание текстуры своего трафика не имеет.
      // Три грузит растр по ВЕРСИИ, и флаг, поднятый при создании, сливается с
      // флагом ближайшей доставки в одну-единственную загрузку — второй счёт
      // приписал бы байты, которых по шине не было.
      const created = fogStand({ resolution: 4 });
      expect(counters.fogMaskUploadBytes).toBe(0);
      created.fog.syncTick(created.view);
      return created;
    });
    expect(counters.fogMaskUploadBytes).toBe(32 * 32);

    // Вторая доставка — второй растр той же длины, ни больше ни меньше.
    withCostSink(counters, () => {
      stand.fog.syncTick(stand.view);
    });
    expect(counters.fogMaskUploadBytes).toBe(2 * 32 * 32);
  });

  it('число сегментов укрытий: отбор и тесты субсэмплов растут вместе с ним', () => {
    const bare = deliverCost({ vision: 4, observers: [[4, 4]] });
    const few = deliverCost({ vision: 4, observers: [[4, 4]], pillarStep: 4 });
    const many = deliverCost({ vision: 4, observers: [[4, 4]], pillarStep: 2 });

    const bareSegments = fogSegmentsOf(flatGrid(8)).length;
    const fewSegments = fogSegmentsOf(pillarGrid(8, 4)).length;
    const manySegments = fogSegmentsOf(pillarGrid(8, 2)).length;
    expect(bareSegments).toBe(0);
    expect(manySegments).toBeGreaterThan(fewSegments);

    // Отбор укрытий в радиус — проход по всем сегментам сетки на наблюдателя.
    expect(bare.fogSegmentRangeTests).toBe(0);
    expect(few.fogSegmentRangeTests).toBe(fewSegments);
    expect(many.fogSegmentRangeTests).toBe(manySegments);

    // Без укрытий теневой путь не исполняется вовсе; с ними тесты субсэмплов
    // растут вместе с числом отобранных отрезков (FOW-9).
    expect(bare.fogSubsampleTests).toBe(0);
    expect(few.fogSubsampleTests).toBeGreaterThan(0);
    expect(many.fogNearSegments).toBeGreaterThan(few.fogNearSegments);
    expect(many.fogSubsampleTests).toBeGreaterThan(few.fogSubsampleTests);
  });

  it('маска вне подсистемы считается так же — счётчик у растра, а не у обвязки', () => {
    const grid = pillarGrid(8, 3);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      const mask = new VisibilityMask(fogRectOf(grid), 4);
      mask.clear();
      mask.reveal({ x: 4, y: 4, radius: 3 }, 0.5, fogSegmentsOf(grid));
    });
    expect(counters.fogMaskClearTexels).toBe(32 * 32);
    expect(counters.fogRevealCalls).toBe(1);
    expect(counters.fogSubsampleTests).toBeGreaterThan(0);
    // Ни текстуры, ни миникарты у голого растра нет — стадия не выдумывается.
    expect(counters.fogMaskUploadBytes).toBe(0);
    expect(counters.fogMinimapTexels).toBe(0);
  });
});

// --------------------------------- 1.3: презентационный тракт и вызовы рендерера

describe('PERF-2: инстансы стадий syncTick и frame на шве PresentationStage', () => {
  function stageWith(count: number): { stage: PresentationStage; subsystems: CountingSubsystem[] } {
    const subsystems = Array.from({ length: count }, (_, i) => new CountingSubsystem(`s${i}`));
    const stage = new PresentationStage(makeRenderContext());
    for (const subsystem of subsystems) stage.register(subsystem);
    return { stage, subsystems };
  }

  const threeEntities = (): TickView =>
    makeTickView([makeEntityView(1), makeEntityView(2), makeEntityView(3)]);

  it('доставка считает инстансы как «сущности × подсистемы»', () => {
    const { stage, subsystems } = stageWith(2);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      stage.publish(PRODUCER_A, threeEntities());
    });

    expect(counters.syncTickDeliveries).toBe(1);
    expect(counters.syncTickSubsystems).toBe(2);
    expect(counters.syncTickInstances).toBe(6);
    expect(subsystems[0]?.syncs).toBe(1);
    // Стадия кадра пока не тронута — атрибуция по стадиям не размывается.
    expect(counters.frameCalls).toBe(0);
    expect(counters.frameInstances).toBe(0);
  });

  it('кадр считает инстансы последней доставки, а не выдумывает свои', () => {
    const { stage, subsystems } = stageWith(2);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      stage.publish(PRODUCER_A, threeEntities());
      stage.frame(1 / 60, 0.5);
      stage.frame(1 / 60, 0.5);
    });

    expect(counters.frameCalls).toBe(2);
    expect(counters.frameSubsystems).toBe(4);
    expect(counters.frameInstances).toBe(12);
    expect(subsystems[1]?.frames).toBe(2);
  });

  it('смена продюсера считается как доставка гашения (REND-11)', () => {
    const { stage } = stageWith(2);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      stage.publish(PRODUCER_A, threeEntities());
      stage.publish(PRODUCER_B, makeTickView([makeEntityView(7)]));
    });

    // Публикация A, гашение её набора пустым состоянием, публикация B.
    expect(counters.syncTickDeliveries).toBe(3);
    expect(counters.syncTickSubsystems).toBe(6);
    // Гашение несёт ноль сущностей: 3×2 + 0×2 + 1×2.
    expect(counters.syncTickInstances).toBe(8);
  });

  it('декорации считаются отдельно и только у подсистем, которым принадлежат', () => {
    const owner = new DecoratedSubsystem('owner');
    const stranger = new CountingSubsystem('stranger');
    const stage = new PresentationStage(makeRenderContext()).register(owner).register(stranger);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      stage.publishDecorations(new Map([[1, makeEntityView(1)], [2, makeEntityView(2)]]));
    });

    expect(counters.syncTickDecorationInstances).toBe(2);
    expect(owner.decorations).toBe(2);
    expect(stranger.decorations).toBe(0);
  });

  it('проходы рендерера: счётчик подсистемы и структурный спай сходятся', () => {
    const stand = fogStand({});
    const idle = new FogSubsystem({ grid: flatGrid(8), stats: STATS, hero: () => null });
    idle.init(makeRenderContext());
    const camera = new THREE.PerspectiveCamera();
    const active = new RendererSpy();
    const direct = new RendererSpy();

    const counters = createCostCounters();
    withCostSink(counters, () => {
      stand.fog.syncTick(stand.view);
      stand.fog.render(active, camera);
      stand.fog.render(active, camera);
      // Маска не построена — ровно прямой рендер, один проход (design D2).
      idle.render(direct, camera);
    });

    expect(active.rendered).toHaveLength(4);
    expect(direct.rendered).toHaveLength(1);
    expect(counters.fogRenderPasses).toBe(active.rendered.length + direct.rendered.length);
  });
});
