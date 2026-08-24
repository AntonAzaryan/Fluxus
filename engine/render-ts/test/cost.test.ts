/**
 * Счётчики стоимости рендера (`performance-budget` PERF-3, задачи 1.1–1.3):
 * инертность выключенного учёта, пропорциональность счётчиков тумана осям
 * стоимости (разрешение маски, наблюдатели, сегменты укрытий), снятие инстансов
 * на общем шве презентационного тракта (PERF-2) и счётчики подсистем моделей,
 * частиц и террейна на их собственных осях — числе инстансов, уровне
 * детализации, числе эмиттеров, площади арены и потолке разбиения.
 *
 * WebGL и DOM здесь нет: рендерер — структурный спай стенда (`RendererSpy`),
 * канвас слоя миникарты — стаб. Вызовы рендерера считает спай, а подсистема
 * считает их же своим счётчиком — тест сверяет обе бухгалтерии.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, createTerrainGrid, type EntityId } from '@fluxus/core';
import {
  validateCurvatureMap,
  type NormalizedMesh,
  type NormalizedModel,
  type ParticleEffectDocument,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@fluxus/assets';
import {
  COST_COUNTER_STAGES,
  FogSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PresentationStage,
  TerrainSubsystem,
  VisibilityMask,
  VisualSurfaceSource,
  attachCostSink,
  costSink,
  createCostCounters,
  fogRectOf,
  fogSegmentsOf,
  releaseCostSink,
  withCostSink,
  type EntityView,
  type PresentationProducer,
  type RenderContext,
  type RenderCostCounters,
  type RenderSubsystem,
  type TickView,
} from '../src/index.js';
import {
  RendererSpy,
  buildFogMask,
  flatGrid,
  fogCanvasFactory,
  makeAssets,
  makeEntityView,
  makeModel,
  makeRenderContext,
  makeTickView,
  pillarGrid,
} from './fixtures.js';

// ------------------------------------------------------------------- стенд

const STATS = { visionRadius: 'vision', team: 'team' } as const;

/**
 * Наблюдатель доставки на НУЛЕВОМ уровне (`makeEntityView` кладёт его сам): для
 * возвышенных клеток стенда (уровень 1) он снизу, и их рёбра тень отбрасывают
 * (`segmentCasts`, FOW-9, PHYS-13). С наблюдателем на плато теневой путь стоял
 * бы мёртвым, и ось «сегменты укрытий» мерила бы пустоту.
 */
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

/**
 * Одна доставка стенда и кадры её перестройки под снятым замером — счётчики
 * ОДНОЙ перестройки маски. Кадры считаются вместе с доставкой намеренно: растр
 * строят порции кадра (change `fog-mask-budgeted-rebuild`, design D1), и объём
 * работы перестройки — это доставка плюс её кадры, а не одна доставка. Кадры
 * идут с нулевым `dt`: рассеивание тогда стоит, и в замер попадает ровно
 * перестройка.
 */
function rebuildCost(options: Parameters<typeof fogStand>[0]): RenderCostCounters {
  const counters = createCostCounters();
  withCostSink(counters, () => {
    const stand = fogStand(options);
    stand.fog.syncTick(stand.view);
    buildFogMask(stand.fog);
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
    buildFogMask(plain.fog);
    expect(idle).toEqual(createCostCounters());
    expect(costSink()).toBeUndefined();

    // Тот же прогон со стоком: работа посчитана, а растр маски побитово тот же —
    // учёт на измеряемое не влияет.
    const measured = rebuildCost({});
    expect(measured.fogMaskTexels).toBeGreaterThan(0);
    const stand = fogStand({});
    withCostSink(createCostCounters(), () => {
      stand.fog.syncTick(stand.view);
      buildFogMask(stand.fog);
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

  it('отпущенный долгоживущий сток не воскресает восстановлением чужого замера', () => {
    const longLived = createCostCounters();
    attachCostSink(longLived);
    const measured = createCostCounters();
    withCostSink(measured, () => {
      // Владелец отказался от своего стока посреди чужого замера: отбирать сток
      // у замера нельзя — он считает.
      releaseCostSink(longLived);
      expect(costSink()).toBe(measured);
    });
    // А по концу замера на его место встаёт пустота, а не отпущенный сток.
    expect(costSink()).toBeUndefined();
  });

  it('отпуск своего стока, пока он подключён, снимает его сразу', () => {
    const longLived = createCostCounters();
    attachCostSink(longLived);
    expect(costSink()).toBe(longLived);
    releaseCostSink(longLived);
    expect(costSink()).toBeUndefined();
    // Пометки на нём после этого не осталось: следующий замер живёт как обычно.
    const measured = createCostCounters();
    attachCostSink(longLived);
    withCostSink(measured, () => {
      expect(costSink()).toBe(measured);
    });
    expect(costSink()).toBe(longLived);
    releaseCostSink(longLived);
  });

  it('одна и та же нагрузка даёт побитово те же счётчики (PERF-3)', () => {
    const first = rebuildCost({ resolution: 8, pillarStep: 3, observers: [[2, 2], [6, 6]] });
    const second = rebuildCost({ resolution: 8, pillarStep: 3, observers: [[2, 2], [6, 6]] });
    expect(second).toEqual(first);
  });
});

// ------------------------------------- 1.2: счётчики маски по осям стоимости

describe('PERF-3, PERF-6: счётчики тумана растут по осям стоимости', () => {
  it('разрешение 4 → 8: полномасочные счётчики ровно вчетверо, просмотр — около того', () => {
    const low = rebuildCost({ resolution: 4 });
    const high = rebuildCost({ resolution: 8 });

    // Обнуление, блюр кромки, загрузка в текстуру и блит миникарты идут по
    // всему растру: удвоение разрешения — ровно четырёхкратное удорожание
    // (FOW-10). Блюр — два прохода, поэтому вдвое длиннее самого растра.
    expect(low.fogMaskClearTexels).toBe(32 * 32);
    expect(low.fogMaskSmoothTexels).toBe(2 * 32 * 32);
    expect(high.fogMaskClearTexels).toBe(4 * low.fogMaskClearTexels);
    expect(high.fogMaskSmoothTexels).toBe(4 * low.fogMaskSmoothTexels);
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
    const one = rebuildCost({ observers: [[2, 2]] });
    const four = rebuildCost({ observers: [[2, 2], [2, 6], [6, 2], [6, 6]] });

    expect(one.fogRevealCalls).toBe(1);
    expect(four.fogRevealCalls).toBe(4);
    expect(four.fogEntitiesScanned).toBe(4);
    // Круги одного радиуса и не задеты краем маски — прямоугольники равны.
    expect(four.fogMaskTexels).toBe(4 * one.fogMaskTexels);
    // Полномасочная работа от числа наблюдателей не зависит вовсе.
    expect(four.fogMaskClearTexels).toBe(one.fogMaskClearTexels);
    expect(four.fogMaskUploadBytes).toBe(one.fogMaskUploadBytes);
  });

  it('загрузка в текстуру — только когда меняется показанная маска', () => {
    const counters = createCostCounters();
    const stand = withCostSink(counters, () => {
      // Стенд строится ПОД замером: создание текстуры своего трафика не имеет.
      // Три грузит растр по ВЕРСИИ, и флаг, поднятый при создании, сливается с
      // флагом ближайшей публикации в одну-единственную загрузку — второй счёт
      // приписал бы байты, которых по шине не было.
      const created = fogStand({ resolution: 4 });
      expect(counters.fogMaskUploadBytes).toBe(0);
      created.fog.syncTick(created.view);
      // Доставка растра не трогает вовсе (design D1): ни байта в текстуру, ни
      // блита — их сделает публикация построенного кадром растра.
      expect(counters.fogMaskUploadBytes).toBe(0);
      expect(counters.fogMinimapTexels).toBe(0);
      buildFogMask(created.fog);
      return created;
    });
    // Первая публикация: текстура и слой миникарты обязаны существовать с неё
    // (design D6) — единственная загрузка стартового растра считается тут, и
    // блит идёт по всему растру.
    expect(counters.fogMaskUploadBytes).toBe(32 * 32);
    expect(counters.fogMinimapTexels).toBe(32 * 32);

    // Кадр рассеивания: растр уезжает в текстуру ЦЕЛИКОМ (частичной загрузки в
    // этой итерации нет), а блит идёт по грязным блокам окна (design D5).
    const dissolving = createCostCounters();
    withCostSink(dissolving, () => {
      stand.fog.updateFrame(10, 0.5);
    });
    expect(dissolving.fogMaskUploadBytes).toBe(32 * 32);
    expect(dissolving.fogMinimapTexels).toBeGreaterThan(0);
    expect(dissolving.fogMinimapTexels).toBeLessThanOrEqual(32 * 32);

    // Та же доставка на устоявшейся сцене: сигнатура входов совпала (design
    // D4), окно рассеивания пусто (design D5) — по шине не ушло ни байта.
    const settled = createCostCounters();
    withCostSink(settled, () => {
      stand.fog.syncTick(stand.view);
      stand.fog.updateFrame(1 / 60, 0.5);
    });
    expect(settled.fogMaskUploadBytes).toBe(0);
    expect(settled.fogMinimapTexels).toBe(0);
    expect(settled.fogDissolveTexels).toBe(0);

    // Снап (REND-2): показанная маска стала целевой прямо на доставке — растр
    // уезжает в текстуру здесь, и блит идёт по всему растру.
    const snap = createCostCounters();
    withCostSink(snap, () => {
      stand.fog.syncTick(makeTickView([observerView(1, 3, 5, 1.5)], { snapAll: true }));
    });
    expect(snap.fogMaskUploadBytes).toBe(32 * 32);
    expect(snap.fogMinimapTexels).toBe(32 * 32);
  });

  it('число сегментов укрытий: отбор и тесты лучей полярного растра растут вместе с ним', () => {
    // Наблюдатель стоит в свободной клетке, а не в узле решётки: стоя ровно на
    // линии ребра, он перекрыт целиком (`rasterizeOnLine`, FOW-9), и ось мерила
    // бы вырожденную ветку вместо обычной растеризации теней.
    const bare = rebuildCost({ vision: 4, observers: [[3.5, 3.5]] });
    const few = rebuildCost({ vision: 4, observers: [[3.5, 3.5]], pillarStep: 4 });
    const many = rebuildCost({ vision: 4, observers: [[3.5, 3.5]], pillarStep: 2 });

    const bareSegments = fogSegmentsOf(flatGrid(8)).length;
    const fewSegments = fogSegmentsOf(pillarGrid(8, 4)).length;
    const manySegments = fogSegmentsOf(pillarGrid(8, 2)).length;
    expect(bareSegments).toBe(0);
    expect(manySegments).toBeGreaterThan(fewSegments);

    // Отбор укрытий в радиус — проход по всем сегментам сетки на наблюдателя.
    expect(bare.fogSegmentRangeTests).toBe(0);
    expect(few.fogSegmentRangeTests).toBe(fewSegments);
    expect(many.fogSegmentRangeTests).toBe(manySegments);

    // Без укрытий теневой путь не исполняется вовсе; с ними тесты лучей
    // полярной растеризации растут вместе с числом отобранных отрезков (FOW-9,
    // design D3): каждый отрезок платит своей дугой бинов, а тексель — O(1).
    expect(bare.fogShadowRayTests).toBe(0);
    expect(few.fogShadowRayTests).toBeGreaterThan(0);
    expect(many.fogNearSegments).toBeGreaterThan(few.fogNearSegments);
    expect(many.fogShadowRayTests).toBeGreaterThan(few.fogShadowRayTests);
  });

  it('весь растр маски — работа стадии кадра, а не доставки (FOW-7, PERF-2)', () => {
    const stand = fogStand({ resolution: 4 });
    const delivery = createCostCounters();
    withCostSink(delivery, () => {
      stand.fog.syncTick(stand.view);
    });
    // Доставка только просмотрела состояние и положила отложенный вход: ни
    // обнуления, ни reveal, ни блюра, ни рассеивания (design D1, D4).
    expect(delivery.fogEntitiesScanned).toBe(1);
    expect(delivery.fogMaskClearTexels).toBe(0);
    expect(delivery.fogMaskSmoothTexels).toBe(0);
    expect(delivery.fogRevealCalls).toBe(0);
    expect(delivery.fogDissolveTexels).toBe(0);

    // Кадры перестройки: весь растр — здесь, а рассеивание пока стоит (dt = 0).
    const build = createCostCounters();
    withCostSink(build, () => {
      buildFogMask(stand.fog);
    });
    expect(build.fogMaskClearTexels).toBe(32 * 32);
    expect(build.fogMaskSmoothTexels).toBe(2 * 32 * 32);
    expect(build.fogRevealCalls).toBe(1);
    expect(build.fogEntitiesScanned).toBe(0);

    // Кадр рассеивания: окно обходится по грязным блокам, и это НЕ длина растра
    // (design D5) — работа пропорциональна неустоявшейся области.
    const frame = createCostCounters();
    withCostSink(frame, () => {
      stand.fog.updateFrame(1 / 60, 0.5);
    });
    expect(frame.fogDissolveTexels).toBeGreaterThan(0);
    expect(frame.fogDissolveTexels).toBeLessThanOrEqual(32 * 32);
    expect(frame.fogMaskClearTexels).toBe(0);

    // Сошлась показанная маска с целевой — кадры перестают платить (design D5).
    stand.fog.updateFrame(10, 0.5);
    const settled = createCostCounters();
    withCostSink(settled, () => {
      stand.fog.updateFrame(1 / 60, 0.5);
    });
    expect(settled.fogDissolveTexels).toBe(0);
    expect(settled.fogMaskUploadBytes).toBe(0);
    expect(settled.fogMinimapTexels).toBe(0);
  });

  it('маска вне подсистемы считается так же — счётчик у растра, а не у обвязки', () => {
    const grid = pillarGrid(8, 3);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      const mask = new VisibilityMask(fogRectOf(grid), 4);
      mask.clear();
      // Уровень 0 — ниже возвышенных клеток решётки: их рёбра тень отбрасывают.
      mask.reveal({ x: 3.5, y: 3.5, radius: 3, level: 0 }, 0.5, fogSegmentsOf(grid));
      mask.smooth();
    });
    expect(counters.fogMaskClearTexels).toBe(32 * 32);
    expect(counters.fogRevealCalls).toBe(1);
    expect(counters.fogShadowRayTests).toBeGreaterThan(0);
    // Блюр кромки — два прохода по всему растру (FOW-7).
    expect(counters.fogMaskSmoothTexels).toBe(2 * 32 * 32);
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
      buildFogMask(stand.fog);
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

// ------------------------------ 1.1–1.3: счётчики подсистем по осям стоимости

const MODEL_ID = 'models/runner.mdx';
const OTHER_MODEL_ID = 'models/statue.mdx';
const TORCH = 'vfx/torch.effect.json';
const FRAME_DT = 1 / 60;
/** Имена ручек — те же строки, которыми подсистемы их объявляют (QUAL-1). */
const LOD_SCALE_KNOB = 'models.lodThresholdScale';
const DEFAULT_TIER_KNOB = 'models.defaultTier';
const DENSITY_KNOB = 'particles.density';
const TESSELLATION_KNOB = 'terrain.curvatureTessellation';
/** Треугольников в базовом уровне фикстуры; в уровнях цепочки — по одному. */
const BASE_TRIANGLES = 4;

/** Счётчики РОВНО одного действия — свежий сток на замер. */
function measure(body: () => void): RenderCostCounters {
  const counters = createCostCounters();
  withCostSink(counters, body);
  return counters;
}

// ------------------------------------------------------------------- модели

/**
 * Меш ровно из `triangles` треугольников — ось геометрии батчевого яруса
 * (REND-20). Треугольники одинаковые и лежат друг на друге: картинку здесь
 * никто не смотрит, а счётчик считает именно их число.
 */
function meshOf(triangles: number): NormalizedMesh {
  const positions = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
  const indices = new Uint16Array(triangles * 3);
  const skinIndices = new Uint16Array(triangles * 12);
  const skinWeights = new Float32Array(triangles * 12);
  for (let triangle = 0; triangle < triangles; triangle++) {
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], triangle * 9);
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = triangle * 3 + vertex;
      indices[at] = at;
      skinWeights[at * 4] = 1; // вся вершина на корневой кости
    }
  }
  return {
    partId: 0,
    positions,
    normals: null,
    uvs,
    indices,
    skinIndices,
    skinWeights,
    materialIndex: 0,
  };
}

/**
 * Модель с цепочкой уровней (ASSET-12, REND-22): четыре треугольника в базе и по
 * одному в каждом уровне цепочки. На таком контрасте выбор уровня виден одним
 * счётчиком `modelsBatchTriangles` — без картинки и без чтения внутренностей.
 */
function chainedModel(): NormalizedModel {
  const base = makeModel();
  return { ...base, meshes: [meshOf(BASE_TRIANGLES)], lodMeshes: [[meshOf(1)], [meshOf(1)]] };
}

function modelsManifest(model: string = MODEL_ID): VisualManifest {
  return {
    entities: {
      Runner: {
        model,
        scale: 1,
        animations: { states: { idle: 'Stand', move: 'Walk' } },
        lodThresholds: [0.2, 0.05],
      },
    },
  };
}

interface ModelsStand {
  readonly models: ModelsSubsystem;
  readonly stage: PresentationStage;
  readonly entities: EntityView[];
  /** Ставит камеру на дистанцию и рисует кадр; `away` — камера смотрит прочь. */
  look(distance: number, away?: boolean): void;
}

/**
 * Стенд подсистемы моделей: батчевый ярус с камерой, `count` инстансов у начала
 * координат и модель, доехавшая ПОСЛЕ доставки — как в матче (ASSET-4).
 */
function modelsStand(count: number, lodScale?: number): ModelsStand {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  const models = new ModelsSubsystem(modelsManifest(), { warn: () => {}, camera });
  const stage = new PresentationStage(ctx).register(models);
  // Множитель порогов ставится ДО кадров: гистерезис (REND-22) делает выбор
  // зависимым от истории, и переключать множитель на ходу означало бы мерить
  // ещё и её.
  if (lodScale !== undefined) models.applyQuality(new Map([[LOD_SCALE_KNOB, lodScale]]));
  const entities = Array.from({ length: count }, (_, index) =>
    makeEntityView(index + 1, { currY: index * 0.2, prevY: index * 0.2 }),
  );
  stage.publish(PRODUCER_A, makeTickView(entities));
  assets.resolve('model', MODEL_ID, chainedModel());
  return {
    models,
    stage,
    entities,
    look(distance: number, away = false): void {
      camera.position.set(-distance, 0, 0);
      camera.lookAt(away ? -distance * 2 : 0, 0, 0);
      camera.updateMatrixWorld(true);
      stage.frame(FRAME_DT, 1);
    },
  };
}

/**
 * Дистанция, на которой инстанс впервые уходит с нулевого уровня при множителе
 * порогов 1 (REND-22). Дистанции в тестах берутся ОТ НЕЁ, а не числом: пороги —
 * данные записи, а экранный размер считается от консервативных границ модели, и
 * прибитое число разъехалось бы с фикстурой молча.
 */
function lodEdge(): number {
  const probe = modelsStand(1);
  for (let distance = 1; distance < 40000; distance *= 1.05) {
    probe.look(distance);
    if ((probe.models.instanceFor(1)?.lodLevel ?? 0) >= 1) return distance;
  }
  throw new Error('переключение уровня не достигнуто');
}

describe('PERF-3: подсистема моделей — доставка, кадр и ярусы (REND-3, REND-20)', () => {
  it('доставка считает просмотренные и созданные инстансы; повторная — только просмотр', () => {
    for (const count of [2, 6]) {
      const assets = makeAssets();
      const ctx: RenderContext = {
        scene: new THREE.Scene(),
        assets: assets.service,
        config: { heightStep: 0.5 },
      };
      const models = new ModelsSubsystem(modelsManifest(), { warn: () => {} });
      const stage = new PresentationStage(ctx).register(models);
      const entities = Array.from({ length: count }, (_, index) => makeEntityView(index + 1));

      const first = measure(() => { stage.publish(PRODUCER_A, makeTickView(entities)); });
      expect(first.modelsInstancesSynced).toBe(count);
      expect(first.modelsInstancesCreated).toBe(count);

      // Тот же состав второй доставкой: просмотр тот же, создавать нечего —
      // инстанс живёт, пока сущность в доставленном состоянии (REND-3).
      const again = measure(() => { stage.publish(PRODUCER_A, makeTickView(entities)); });
      expect(again.modelsInstancesSynced).toBe(count);
      expect(again.modelsInstancesCreated).toBe(0);
      expect(again.modelsRebuilds).toBe(0);
    }
  });

  it('декорации — та же работа подсистемы, хотя шов их сущностями не считает (REND-18)', () => {
    const stand = modelsStand(3);
    const counters = measure(() => {
      stand.stage.publishDecorations(
        new Map([[101, makeEntityView(101)], [102, makeEntityView(102)]]),
      );
    });

    // Пул декораций сводится тем же кодом и стоит того же (REND-18)…
    expect(counters.modelsInstancesSynced).toBe(2);
    expect(counters.modelsInstancesCreated).toBe(2);
    // …а шов сцены считает их своим полем: `syncTickInstances` — про доставку
    // presentation-состояния, и набор декораций в неё не входит (PERF-2).
    expect(counters.syncTickInstances).toBe(0);
    expect(counters.syncTickDecorationInstances).toBe(2);
  });

  it('кадр: поза, тест отсечения, запись батча и треугольники — по числу инстансов', () => {
    const small = modelsStand(2);
    const large = modelsStand(6);
    small.look(3);
    large.look(3);
    const two = measure(() => { small.look(3); });
    const six = measure(() => { large.look(3); });

    expect(two.modelsPoseWrites).toBe(2);
    expect(two.modelsCullTests).toBe(2);
    expect(two.modelsLodSelections).toBe(2);
    expect(two.modelsBatchRecords).toBe(2);
    expect(two.modelsBatchTriangles).toBe(2 * BASE_TRIANGLES);
    // Втрое больше инстансов — втрое больше работы кадра во всех четырёх осях:
    // зависимость линейная, без порогов и скидок (PERF-3).
    expect(six.modelsPoseWrites).toBe(3 * two.modelsPoseWrites);
    expect(six.modelsCullTests).toBe(3 * two.modelsCullTests);
    expect(six.modelsLodSelections).toBe(3 * two.modelsLodSelections);
    expect(six.modelsBatchRecords).toBe(3 * two.modelsBatchRecords);
    expect(six.modelsBatchTriangles).toBe(3 * two.modelsBatchTriangles);
    // Доставки в этих кадрах не было — стадия доставки нулевая (PERF-2).
    expect(six.modelsInstancesSynced).toBe(0);
    expect(six.modelsCulled).toBe(0);
  });

  it('невидимые инстансы: тесты остаются, компактация и треугольники — нет (REND-21)', () => {
    const stand = modelsStand(3);
    stand.look(200, true);
    const counters = measure(() => { stand.look(200, true); });

    expect(counters.modelsCullTests).toBe(3);
    expect(counters.modelsCulled).toBe(3);
    // Ровно то, за что кадр не заплатил: записи вне пирамиды не компактуются, а
    // уровень им не выбирается вовсе — выбор идёт только для видимых.
    expect(counters.modelsBatchRecords).toBe(0);
    expect(counters.modelsBatchTriangles).toBe(0);
    expect(counters.modelsLodSelections).toBe(0);
    // Поза считается всем: она — вход отсечения, а не его следствие.
    expect(counters.modelsPoseWrites).toBe(3);
  });

  it('множитель порогов LOD двигает треугольники, а не число выборов (REND-22, QUAL-1)', () => {
    // Половина дистанции переключения: при множителе 1 уровень ещё нулевой,
    // при восьмикратном — пороги читаются заметно раньше.
    const distance = lodEdge() / 2;
    const baseline = modelsStand(3);
    const cheaper = modelsStand(3, 8);
    baseline.look(distance);
    cheaper.look(distance);
    const full = measure(() => { baseline.look(distance); });
    const coarse = measure(() => { cheaper.look(distance); });

    expect(full.modelsBatchTriangles).toBe(3 * BASE_TRIANGLES);
    // Пресет удешевил кадр ровно геометрией: записей столько же, выборов
    // столько же — работа выбора инстанс-пропорциональна и от множителя не
    // зависит, а вот его ИСХОД зависит (REND-22).
    expect(coarse.modelsBatchTriangles).toBeLessThan(full.modelsBatchTriangles);
    expect(coarse.modelsBatchRecords).toBe(full.modelsBatchRecords);
    expect(coarse.modelsLodSelections).toBe(full.modelsLodSelections);
    expect(cheaper.models.instanceFor(1)!.lodLevel).toBeGreaterThan(
      baseline.models.instanceFor(1)!.lodLevel,
    );
  });

  it('пересборки — цена смены яруса и переподачи манифеста (REND-17, QUAL-1)', () => {
    const stand = modelsStand(3);
    stand.look(3);

    // Ярус по умолчанию сменился — пересобраны все записи, ярус не назвавшие.
    const tier = measure(() => {
      stand.models.applyQuality(new Map([[DEFAULT_TIER_KNOB, 'detailed']]));
    });
    expect(tier.modelsRebuilds).toBe(3);
    // И кадр после этого батчевой работы не несёт вовсе: у детального яруса
    // инстанс-буферов нет (REND-20).
    const detailed = measure(() => { stand.look(3); });
    expect(detailed.modelsBatchRecords).toBe(0);
    expect(detailed.modelsBatchTriangles).toBe(0);
    expect(detailed.modelsPoseWrites).toBe(3);

    // Переподача манифеста с ДРУГОЙ моделью пересобирает те же три инстанса…
    const changed = measure(() => { stand.models.applyManifest(modelsManifest(OTHER_MODEL_ID)); });
    expect(changed.modelsRebuilds).toBe(3);
    // …а переподача того же по значению документа — ни одного (REND-17).
    const same = measure(() => { stand.models.applyManifest(modelsManifest(OTHER_MODEL_ID)); });
    expect(same.modelsRebuilds).toBe(0);
  });
});

// ------------------------------------------------------------------ частицы

function torchDocument(): ParticleEffectDocument {
  const path = fileURLToPath(new URL('./fixtures/torch.effect.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

/**
 * Тот же факел с ДВУМЯ эмиттерами: ось «систем в документе эффекта». Работа
 * подсистемы растёт не только числом оболочек, но и тем, из скольких систем
 * каждая состоит, — и считается это по НАШИМ объектам (design D3).
 */
function twinTorch(): ParticleEffectDocument {
  const doc = torchDocument() as unknown as { object: { children: Record<string, unknown>[] } };
  const twin = JSON.parse(JSON.stringify(doc.object.children[0])) as Record<string, unknown>;
  twin.uuid = 'aaaaaaaa-0000-4000-8000-000000000001';
  doc.object.children.push(twin);
  return doc as unknown as ParticleEffectDocument;
}

interface ParticlesStand {
  readonly particles: ParticlesSubsystem;
  readonly stage: PresentationStage;
  readonly entities: EntityView[];
}

function particlesStand(count: number, doc: ParticleEffectDocument = torchDocument()): ParticlesStand {
  const assets = makeAssets();
  assets.resolve('particle-effect', TORCH, doc);
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const manifest: VisualManifest = {
    entities: {},
    particles: { byKind: { Runner: { effect: TORCH } }, byEvent: { Boom: { effect: TORCH } } },
  };
  const particles = new ParticlesSubsystem(manifest, { warn: () => {} });
  const stage = new PresentationStage(ctx).register(particles);
  const entities = Array.from({ length: count }, (_, index) => makeEntityView(index + 1));
  stage.publish(PRODUCER_A, makeTickView(entities));
  return { particles, stage, entities };
}

describe('PERF-3: подсистема частиц считает СВОЮ работу, а не частицы (REND-24, design D3)', () => {
  it('доставка: сведения оболочек и взятия экземпляров по числу эмиттерных сущностей', () => {
    for (const count of [1, 3]) {
      const stand = particlesStand(count);
      const again = measure(() => {
        stand.stage.publish(PRODUCER_A, makeTickView(stand.entities));
      });
      // Оболочки сводятся каждой доставкой…
      expect(again.particlesShellsSynced).toBe(count);
      // …а экземпляр берётся один раз: живая оболочка играет прежним (REND-17).
      expect(again.particlesInstancesAcquired).toBe(0);

      const fresh = particlesStand(count);
      const created = measure(() => {
        fresh.stage.publish(PRODUCER_A, makeTickView([...fresh.entities, makeEntityView(99)]));
      });
      expect(created.particlesInstancesAcquired).toBe(1);
    }
  });

  it('кадр: оболочки и системы; систем — по документу эффекта, а не по частицам', () => {
    const single = particlesStand(3);
    const twin = particlesStand(3, twinTorch());
    single.stage.frame(FRAME_DT, 1);
    twin.stage.frame(FRAME_DT, 1);
    const one = measure(() => { single.stage.frame(FRAME_DT, 1); });
    const two = measure(() => { twin.stage.frame(FRAME_DT, 1); });

    expect(one.particlesShellsPosed).toBe(3);
    expect(one.particlesSystemsStepped).toBe(3);
    // Оболочек столько же, а систем вдвое больше: документ из двух эмиттеров
    // стоит вдвое, и это видно ровно вторым счётчиком.
    expect(two.particlesShellsPosed).toBe(3);
    expect(two.particlesSystemsStepped).toBe(6);
  });

  it('выстрел по событию берёт экземпляр на доставке и шагает кадрами', () => {
    const stand = particlesStand(0);
    const spawn = measure(() => {
      stand.stage.publish(
        PRODUCER_A,
        makeTickView([], { freshEvents: true, events: [{ type: 'Boom', data: { x: 0, y: 0 } }] }),
      );
    });
    expect(spawn.particlesInstancesAcquired).toBe(1);
    // Оболочек событие не заводит: выстрел живёт своим списком (REND-24).
    expect(spawn.particlesShellsSynced).toBe(0);

    const frame = measure(() => { stand.stage.frame(FRAME_DT, 1); });
    expect(frame.particlesShotsStepped).toBe(1);
    expect(frame.particlesSystemsStepped).toBe(1);
  });

  it('множитель плотности НАШЕЙ работы не двигает — за ним стохастика (design D3)', () => {
    const stand = particlesStand(3);
    stand.stage.frame(FRAME_DT, 1);
    const full = measure(() => { stand.stage.frame(FRAME_DT, 1); });

    stand.particles.applyQuality(new Map([[DENSITY_KNOB, 0.5]]));
    const halved = measure(() => { stand.stage.frame(FRAME_DT, 1); });

    // Множитель правит эмиссию ВНУТРИ систем, а не число оболочек и систем:
    // счётчики стоят на месте, и это не пробел учёта, а его граница (D3).
    // Считать живые частицы значило бы посадить в эталон рандом эмиссии
    // three.quarks и потерять машинную независимость (PERF-3); поэтому цену
    // плотности стережёт не голден, а замер кадра (PERF-5, PERF-7).
    expect(halved.particlesShellsPosed).toBe(full.particlesShellsPosed);
    expect(halved.particlesSystemsStepped).toBe(full.particlesSystemsStepped);
  });
});

// ------------------------------------------------------------------ террейн

const CURVED_SIZE = 4;

function terrainRows(fill: string, size = CURVED_SIZE): string[] {
  return Array.from({ length: size }, () => fill.repeat(size));
}

/** Карта кривизны с приподнятыми внутренними узлами (REND-9, ASSET-7). */
function curvatureMap(): TerrainCurvatureMap {
  const rows = Array.from({ length: CURVED_SIZE + 1 }, () =>
    new Array<number>(CURVED_SIZE + 1).fill(0),
  );
  for (const y of [1, 2]) for (const x of [1, 2]) rows[y]![x] = 14;
  const result = validateCurvatureMap({ width: CURVED_SIZE, height: CURVED_SIZE, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

interface TerrainStand {
  readonly terrain: TerrainSubsystem;
  readonly stage: PresentationStage;
}

function terrainStand(options: { curved?: boolean; chunkSize?: number } = {}): TerrainStand {
  const grid = createTerrainGrid({
    width: CURVED_SIZE,
    height: CURVED_SIZE,
    tileSize: FIXED_ONE,
    levels: terrainRows('0'),
    flags: terrainRows('.'),
  });
  const surface = new VisualSurfaceSource(grid);
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: makeAssets().service,
    config: { heightStep: 0.5 },
  };
  const terrain = new TerrainSubsystem(grid, {
    surface,
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
  });
  const stage = new PresentationStage(ctx).register(terrain);
  if (options.curved === true) {
    surface.setCurvature(curvatureMap());
    stage.frame(FRAME_DT, 1);
  }
  return { terrain, stage };
}

describe('PERF-3: подсистема террейна — площадь, обрывы и разбиение (REND-7, REND-9)', () => {
  it('полная сборка: квады пола по клеткам арены, стенки — по отрезкам обрывов', () => {
    const build = (grid: ReturnType<typeof flatGrid>): RenderCostCounters =>
      measure(() => {
        new PresentationStage(makeRenderContext()).register(new TerrainSubsystem(grid));
      });

    const small = build(flatGrid(8));
    const large = build(flatGrid(16));
    const cliffs = build(pillarGrid(8, 2));

    // Клетка без кривизны — один квад, и площадь арены входит линейно.
    expect(small.terrainFloorQuads).toBe(8 * 8);
    expect(large.terrainFloorQuads).toBe(16 * 16);
    // Ровная арена стенок не даёт вовсе: считается работа, а не её возможность.
    expect(small.terrainWallQuads).toBe(0);
    // Решётка возвышенных клеток даёт cliff-отрезки (TERR-5) — и стенки по ним.
    expect(cliffs.terrainFloorQuads).toBe(8 * 8);
    expect(cliffs.terrainWallQuads).toBeGreaterThan(0);
    // Сборка идёт через пометку и сброс: чанков помечено столько же, сколько
    // пересобрано (PERF-2).
    expect(small.terrainChunksMarked).toBe(small.terrainChunksRebuilt);
  });

  it('потолок разбиения квадратичен: клетка с кривизной даёт N×N подклеток (QUAL-1)', () => {
    const stand = terrainStand({ curved: true });
    // Потолок применяется дважды подряд — 2, затем 4: каждая смена пересобирает
    // всю арену (QUAL-1), и оба замера описывают ОДНУ И ТУ ЖЕ геометрию под
    // разным разбиением.
    const two = measure(() => {
      stand.terrain.applyQuality(new Map([[TESSELLATION_KNOB, 2]]));
    });
    const four = measure(() => {
      stand.terrain.applyQuality(new Map([[TESSELLATION_KNOB, 4]]));
    });

    // Квадов = плоские клетки + клетки с кривизной × N². Отсюда обе величины
    // восстанавливаются из двух замеров — и обязаны сойтись с числом клеток
    // арены: это и есть проверка КВАДРАТИЧНОСТИ, а не «стало больше».
    const curved = (four.terrainFloorQuads - two.terrainFloorQuads) / (16 - 4);
    const plain = two.terrainFloorQuads - curved * 4;
    expect(Number.isInteger(curved)).toBe(true);
    expect(curved).toBeGreaterThan(0);
    expect(curved + plain).toBe(CURVED_SIZE * CURVED_SIZE);
    // Пересобрана вся арена, а не часть её: пометка полная (QUAL-1).
    expect(four.terrainChunksRebuilt).toBe(two.terrainChunksRebuilt);
  });

  it('мутация пола: пометки на доставке, пересборка в кадре, стоящая сцена бесплатна', () => {
    // Чанк 2×2 клетки: правки в разных чанках пересобирают разные чанки.
    const stand = terrainStand({ chunkSize: 2 });
    const floorBits = new Uint8Array(CURVED_SIZE * CURVED_SIZE).fill(1);
    floorBits[0] = 0;
    floorBits[15] = 0;

    const delivery = measure(() => {
      stand.stage.publish(
        PRODUCER_A,
        makeTickView([], { floorBits, floorChangedCells: [0, 15] }),
      );
    });
    // Доставка ТОЛЬКО метит: геометрию она не строит (PERF-2, TERR-6).
    expect(delivery.terrainChunksMarked).toBe(2);
    expect(delivery.terrainChunksRebuilt).toBe(0);
    expect(delivery.terrainFloorQuads).toBe(0);

    const frame = measure(() => { stand.stage.frame(FRAME_DT, 1); });
    expect(frame.terrainChunksRebuilt).toBe(2);
    // Две клетки пола выбиты — в пересобранных чанках их квадов больше нет.
    expect(frame.terrainFloorQuads).toBe(2 * 2 * 2 - 2);

    // Следующий кадр пометок не находит: стоящая сцена за террейн не платит.
    const idle = measure(() => { stand.stage.frame(FRAME_DT, 1); });
    expect(idle.terrainChunksRebuilt).toBe(0);
    expect(idle.terrainFloorQuads).toBe(0);
    expect(idle.terrainWallQuads).toBe(0);
  });
});

// ---------------------------------------- машинная независимость и детерминизм

describe('PERF-3: счётчики подсистем машинно-независимы', () => {
  /** Одна и та же нагрузка: доставка, два кадра и смена пресета — под замером. */
  function run(): RenderCostCounters {
    return measure(() => {
      const models = modelsStand(4);
      models.look(12);
      models.look(12);
      models.models.applyQuality(new Map([[LOD_SCALE_KNOB, 4]]));
      models.look(12);

      const particles = particlesStand(3, twinTorch());
      particles.stage.frame(FRAME_DT, 1);
      particles.stage.frame(FRAME_DT, 1);

      const terrain = terrainStand({ curved: true, chunkSize: 2 });
      terrain.stage.frame(FRAME_DT, 1);
      terrain.terrain.applyQuality(new Map([[TESSELLATION_KNOB, 2]]));
    });
  }

  it('два одинаковых прогона дают побитово те же счётчики', () => {
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // Прогон не вырожден: считались все три подсистемы.
    expect(first.modelsBatchTriangles).toBeGreaterThan(0);
    expect(first.particlesSystemsStepped).toBeGreaterThan(0);
    expect(first.terrainFloorQuads).toBeGreaterThan(0);
  });

  it('все счётчики — целые неотрицательные числа', () => {
    for (const [name, value] of Object.entries(run())) {
      expect(Number.isInteger(value), name).toBe(true);
      expect(value, name).toBeGreaterThanOrEqual(0);
    }
  });
});
