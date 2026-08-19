/**
 * Отладочный режим рендера (`render-debug` RDBG-1..8) — механизм: реестр
 * источников рядом со списком подсистем (REND-27), закрытый словарь примитивов,
 * инертность выключенного режима, границы дампа и невидимость отладки для
 * счётчиков стоимости.
 *
 * Проверяется наблюдаемое: что видно в реестре, что попадает в сцену, что
 * приезжает в дампе и что остаётся в счётчиках. Внутреннего устройства слоя
 * тесты не знают — как не знает его и источник.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FogSubsystem,
  ModelsSubsystem,
  PresentationStage,
  RenderDebugLayer,
  TerrainSubsystem,
  VisualSurfaceSource,
  createCostCounters,
  deliveryDebugSource,
  costCountersDebugSource,
  withCostSink,
  type DebugDraw,
  type DebugFrameState,
  type DebugProbe,
  type DebugSource,
  type RenderSubsystem,
  type TickView,
} from '../src/index.js';
import {
  flatGrid,
  makeEntityView,
  makeRenderContext,
  makeTickView,
  pillarGrid,
} from './fixtures.js';

// ------------------------------------------------------------------ стенд

function frameState(view: TickView | null, alpha = 0.5): DebugFrameState {
  return { view, alpha, dtSeconds: 1 / 60, realDtSeconds: 1 / 60 };
}

/** Подсистема-пустышка: её присутствие в списке и есть предмет проверки REND-27. */
function nullSubsystem(name: string, sources?: readonly DebugSource[]): RenderSubsystem {
  const subsystem: RenderSubsystem = {
    name,
    init: () => {},
    syncTick: () => {},
    updateFrame: () => {},
  };
  if (sources === undefined) return subsystem;
  return { ...subsystem, debugSources: () => sources };
}

/** Источник-пустышка с настраиваемой пробой: механизм не знает, что она значит. */
function stubSource(id: string, probe: DebugProbe = { value: 1 }): DebugSource {
  return { id, title: `источник ${id}`, probe: () => probe };
}

// ---------------------------------------------------------- RDBG-1: реестр

describe('RDBG-1: реестр отладочных источников', () => {
  it('новая ось наблюдения — это регистрация источника, а не правка слоя', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(stubSource('game.colliders'));
    expect(layer.sources.map((source) => source.id)).toEqual(['game.colliders']);
    expect(layer.sources[0]?.owner).toBe('game');
  });

  it('источник встраивающей сборки становится наравне с источниками подсистем', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    stage.register(nullSubsystem('fake', [stubSource('fake.mask')]));
    layer.register(stubSource('game.camera'));
    expect(layer.sources.map((source) => source.id)).toEqual(['fake.mask', 'game.camera']);
  });

  it('повторный id отвергается адресно, а прежний источник остаётся нетронутым', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    const first = stubSource('fog.mask', { marker: 'первый' });
    layer.register(first);
    expect(() => layer.register(stubSource('fog.mask'))).toThrow(/fog\.mask.*уже зарегистрирован/s);
    expect(layer.sources).toHaveLength(1);
    layer.setEnabled('fog.mask', true);
    expect((layer.dump().sections['fog.mask'] as { marker: string }).marker).toBe('первый');
  });

  it('источник вне неймспейса владельца не регистрируется', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    expect(() => layer.register(stubSource('colliders'))).toThrow(/неймспейс/);
  });

  it('подсистема, объявившая источник вне своего неймспейса, отвергается по имени', () => {
    const stage = new PresentationStage(makeRenderContext());
    new RenderDebugLayer(stage);
    expect(() => stage.register(nullSubsystem('fog', [stubSource('models.bounds')]))).toThrow(
      /подсистема "fog".*models\.bounds/s,
    );
  });

  it('переключатели по источнику: включён один — остальные не считают проб', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    const probed: string[] = [];
    for (const id of ['a.one', 'a.two', 'b.three']) {
      layer.register({
        id,
        probe: () => {
          probed.push(id);
          return {};
        },
      });
    }
    layer.setEnabled('a.two', true);
    layer.frame(frameState(null));
    expect(probed).toEqual(['a.two']);
    expect(layer.enabled).toEqual(['a.two']);
  });

  it('незнакомый id переключается молча — сохранённый выбор не роняет страницу', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    expect(layer.setEnabled('никто.ничей', true)).toBe(false);
    expect(layer.has('никто.ничей')).toBe(false);
    expect(layer.enabled).toEqual([]);
  });
});

// ------------------------------------------- REND-27: точка подключения слоя

describe('REND-27: слой крепится рядом со списком подсистем, а не внутри него', () => {
  it('состав и порядок списка подсистем со слоем и без него одинаковы', () => {
    const build = (withLayer: boolean): string[] => {
      const stage = new PresentationStage(makeRenderContext());
      if (withLayer) new RenderDebugLayer(stage);
      const seen: string[] = [];
      for (const name of ['terrain', 'models', 'fog']) {
        stage.register({
          name,
          init: () => {},
          syncTick: () => {
            seen.push(name);
          },
          updateFrame: () => {},
        });
      }
      stage.publish({ name: 'test' }, makeTickView([]));
      return seen;
    };
    expect(build(true)).toEqual(build(false));
  });

  it('счётные величины доставки и кадра от подключения слоя не отличаются ни на единицу', () => {
    const run = (withLayer: boolean): Record<string, number> => {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        const stage = new PresentationStage(makeRenderContext());
        const layer = withLayer ? new RenderDebugLayer(stage) : null;
        stage.register(nullSubsystem('one'));
        stage.register(nullSubsystem('two'));
        if (layer !== null) {
          layer.register(stubSource('game.any'));
          layer.setEnabled('game.any', true);
        }
        const view = makeTickView([makeEntityView(1), makeEntityView(2)]);
        stage.publish({ name: 'test' }, view);
        stage.frame(1 / 60, 0.5, 1 / 60);
        layer?.frame(frameState(view));
      });
      return { ...counters };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('подсистема без объявления источников дефектом не является', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    stage.register(nullSubsystem('quiet'));
    expect(layer.sources).toEqual([]);
  });

  it('поздняя подписка слоя видит уже зарегистрированные подсистемы', () => {
    const stage = new PresentationStage(makeRenderContext());
    stage.register(nullSubsystem('fake', [stubSource('fake.one')]));
    const layer = new RenderDebugLayer(stage);
    expect(layer.sources.map((source) => source.id)).toEqual(['fake.one']);
  });
});

// ----------------------------------------------- RDBG-2: одна проба — две грани

describe('RDBG-2: одна проба — две грани', () => {
  it('рисовальщик получает ровно ту пробу, которую сериализует дамп', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    const seen: unknown[] = [];
    const probe = { count: 0 };
    layer.register<DebugProbe>({
      id: 'x.counter',
      probe: () => {
        probe.count += 1;
        return probe;
      },
      draw: (value) => {
        seen.push(value);
      },
    });
    layer.setEnabled('x.counter', true);
    layer.frame(frameState(null));
    expect(seen).toEqual([probe]);
    expect(layer.dump().sections['x.counter']).toEqual({ count: probe.count });
  });

  it('дамп собирается и в сборке без сцены: рисовальщик — потребитель пробы, а не её условие', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(stubSource('x.headless', { value: 42 }));
    layer.setEnabled('x.headless', true);
    layer.frame(frameState(null));
    expect(layer.objectCount).toBe(0);
    expect(layer.dump().sections['x.headless']).toEqual({ value: 42 });
  });

  it('снятая секция дампа не меняется от следующей доставки', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    layer.register(deliveryDebugSource());
    layer.setEnabled('net.delivery', true);
    const entity = makeEntityView(1, { prevX: 0, currX: 2 });
    layer.frame(frameState(makeTickView([entity], { tick: 7 })));
    const before = layer.dump().sections['net.delivery'];
    const snapshot = JSON.stringify(before);
    // Доставка N+1 переписывает ту же живую запись сущности (ViewBuffer).
    entity.prevX = 2;
    entity.currX = 9;
    layer.frame(frameState(makeTickView([entity], { tick: 8 })));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('структура пробы переиспользуется между кадрами, а не создаётся заново', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    const source = deliveryDebugSource();
    layer.register(source);
    layer.setEnabled('net.delivery', true);
    const entities = Array.from({ length: 16 }, (_, i) => makeEntityView(i + 1));
    const first = source.probe(frameState(makeTickView(entities, { tick: 1 })));
    const items = first.entities.items;
    const second = source.probe(frameState(makeTickView(entities, { tick: 2 })));
    // Тот же объект пробы, тот же массив перечня и те же записи в нём: свежие
    // на кадр были бы аллокацией пропорционально числу сущностей (RDBG-2).
    expect(second).toBe(first);
    expect(second.entities.items).toBe(items);
    expect(second.entities.items[0]).toBe(items[0]);
  });

  it('дамп отвергает пробу со ссылкой на живую структуру — адресно, с путём поля', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(stubSource('x.leak', { entities: new Map([[1, { hp: 3 }]]) }));
    layer.setEnabled('x.leak', true);
    expect(() => layer.dump()).toThrow(/x\.leak\.entities.*Map/s);
  });
});

// --------------------------------------------- RDBG-4: выключенное бесплатно

describe('RDBG-4: выключенный режим бесплатен и неотличим', () => {
  it('без включённого источника проб не считается и сценовых объектов нет', () => {
    const scene = new THREE.Scene();
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), { scene });
    let probes = 0;
    layer.register({
      id: 'x.any',
      probe: () => {
        probes += 1;
        return {};
      },
      draw: (_probe, out) => {
        out.point(0, 0, 0, 0xffffff);
      },
    });
    for (let i = 0; i < 5; i += 1) layer.frame(frameState(null));
    expect(probes).toBe(0);
    expect(layer.frameCount).toBe(0);
    expect(scene.children).toHaveLength(0);
    expect(layer.dump().sections).toEqual({});
  });

  it('включение действует со следующего кадра, выключение убирает наложение целиком', () => {
    const scene = new THREE.Scene();
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), { scene });
    layer.register<DebugProbe>({
      id: 'x.box',
      probe: () => ({}),
      draw: (_probe, out: DebugDraw) => {
        out.segment(0, 0, 0, 1, 1, 1, 0x00ff00);
      },
    });
    layer.setEnabled('x.box', true);
    layer.frame(frameState(null));
    expect(scene.children.length).toBeGreaterThan(0);
    expect(layer.vertexCount).toBe(2);

    layer.setEnabled('x.box', false);
    expect(layer.vertexCount).toBe(0);
    expect(scene.children).toHaveLength(0);
    layer.frame(frameState(null));
    expect(scene.children).toHaveLength(0);
  });
});

// ---------------------------------------------------- RDBG-7: границы дампа

describe('RDBG-7: дамп кадра', () => {
  it('несёт версию, тик, режим мира и секции включённых источников', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(stubSource('a.one', { value: 1 }));
    layer.register(stubSource('b.two', { value: 2 }));
    layer.setEnabled('a.one', true);
    layer.frame(frameState(makeTickView([], { tick: 12, mode: 'Rewinding' })));
    const dump = layer.dump();
    expect(dump.version).toBe(1);
    expect(dump.tick).toBe(12);
    expect(dump.mode).toBe('Rewinding');
    expect(dump.enabled).toEqual(['a.one']);
    // Секции выключенного источника НЕТ, а не пустая: «выключено» и «данных
    // нет» обязаны различаться (HUD-8).
    expect(Object.keys(dump.sections)).toEqual(['a.one']);
  });

  it('«данных нет» — это секция с причиной, а не отсутствие секции', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(deliveryDebugSource());
    layer.setEnabled('net.delivery', true);
    const section = layer.dump().sections['net.delivery'] as { noData?: string };
    expect(section.noData).toMatch(/доставок ещё не было/);
  });

  it('два дампа на одном доставленном состоянии совпадают, часовые величины названы отдельно', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(deliveryDebugSource());
    layer.setEnabled('net.delivery', true);
    layer.frame(frameState(makeTickView([makeEntityView(1)], { tick: 3 })));
    const first = layer.dump();
    const second = layer.dump();
    expect(second.sections).toEqual(first.sections);
    expect(Object.keys(first.clock)).toContain('frame.alphaTickFraction');
    expect(Object.keys(first.clock)).toContain('net.delivery.deliverySpanTicks');
    // Каденс — часовая величина, и в теле секции его быть не должно.
    expect(JSON.stringify(first.sections)).not.toContain('deliverySpanTicks');
  });

  it('перечень усекается потолком и помечает усечение', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(deliveryDebugSource({ cap: 3 }));
    layer.setEnabled('net.delivery', true);
    const entities = Array.from({ length: 10 }, (_, i) => makeEntityView(i + 1));
    layer.frame(frameState(makeTickView(entities)));
    const section = layer.dump().sections['net.delivery'] as {
      entities: { items: unknown[]; total: number; truncated: boolean };
      entityCount: number;
    };
    expect(section.entities.items).toHaveLength(3);
    expect(section.entities.total).toBe(10);
    expect(section.entities.truncated).toBe(true);
    // Агрегат считается по ВСЕМ, а не по показанным.
    expect(section.entityCount).toBe(10);
  });

  it('маска в дамп растром не едет: разрешение, прямоугольник и число текселей', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    const grid = pillarGrid(8, 4);
    const fog = new FogSubsystem({
      grid,
      stats: { visionRadius: 'vision', team: 'team' },
      hero: () => 1,
      config: { resolution: 4 },
    });
    stage.register(fog);
    layer.setEnabled('fog.mask', true);
    // Наблюдатель — на ровной клетке, а не на возвышении решётки: рёбра
    // собственной клетки выше него закрыли бы обзор со всех сторон (FOW-9).
    const hero = makeEntityView(1, {
      currX: 2.5,
      currY: 2.5,
      stats: new Map([
        ['team', 0],
        ['vision', 3],
      ]),
    });
    // Разрыв непрерывности мира — показанная маска сразу целевая (FOW-7):
    // иначе доля вскрытого мерила бы незавершённое рассеивание.
    const view = makeTickView([hero], { statNames: ['team', 'vision'], snapAll: true });
    stage.publish({ name: 'test' }, view);
    layer.frame(frameState(view));
    const section = layer.dump().sections['fog.mask'] as {
      widthTexels: number;
      resolutionTexelsPerUnit: number;
      observerCount: number;
      revealedFraction: number;
      mask: { texelsOmitted: number; texels?: unknown };
    };
    expect(section.resolutionTexelsPerUnit).toBe(4);
    expect(section.observerCount).toBe(1);
    expect(section.revealedFraction).toBeGreaterThan(0);
    expect(section.mask.texelsOmitted).toBe(section.widthTexels * section.widthTexels);
    expect(section.mask.texels).toBeUndefined();
    expect(JSON.stringify(section).length).toBeLessThan(1000);
  });
});

// ------------------------------------------- RDBG-3/RDBG-5: рисует рендер

describe('RDBG-3: рисует рендер, источник приносит примитивы', () => {
  it('источник сцены не видит: наложение появляется объектами слоя', () => {
    const scene = new THREE.Scene();
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), { scene });
    let sceneSeen = false;
    layer.register<DebugProbe>({
      id: 'x.primitives',
      probe: (state) => {
        // Единственный вход источника — состояние кадра; сцены в нём нет.
        sceneSeen = 'scene' in (state as unknown as Record<string, unknown>);
        return {};
      },
      draw: (_probe, out) => {
        out.box(
          {
            posX: 1, posY: 2, posZ: 3,
            quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
            scaleX: 1, scaleY: 1, scaleZ: 1,
            minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2,
          },
          0xff00ff,
        );
        out.circle(0, 0, 1, 0x00ffff);
        out.disc(2, 2, 0.5, 0x00ffff);
        out.polygon([0, 0, 1, 0, 1, 1], 0xffffff);
        out.point(5, 5, 5, 0xffffff);
        out.polyline([0, 0, 0, 1, 0, 0, 1, 1, 0], 0xffffff, true);
      },
    });
    layer.setEnabled('x.primitives', true);
    layer.frame(frameState(null));
    expect(sceneSeen).toBe(false);
    // Коробка — 12 рёбер по два конца.
    expect(layer.vertexCount).toBeGreaterThan(24);
    expect(scene.children).toHaveLength(1);
  });

  it('кадр под наложением не окрашен: чужих материалов и объектов слой не трогает', () => {
    const scene = new THREE.Scene();
    const context = { ...makeRenderContext(), scene };
    const stage = new PresentationStage(context);
    const grid = flatGrid(4);
    const surface = new VisualSurfaceSource(grid);
    stage.register(new TerrainSubsystem(grid, { surface }));
    const before = scene.children.map((child) => ({
      uuid: child.uuid,
      material: (child as THREE.Mesh).material,
    }));
    const layer = new RenderDebugLayer(stage, { scene, surface });
    layer.setEnabled('terrain.surface', true);
    stage.publish({ name: 'test' }, makeTickView([]));
    stage.frame(1 / 60, 0.5, 1 / 60);
    layer.frame(frameState(makeTickView([])));
    // Объекты террейна те же и с теми же материалами; слой добавил СВОЙ.
    for (const child of before) {
      const still = scene.getObjectByProperty('uuid', child.uuid);
      expect(still).toBeDefined();
      expect((still as THREE.Mesh).material).toBe(child.material);
    }
    expect(scene.children.length).toBe(before.length + 1);
  });
});

// ---------------------------------------- RDBG-6: информационная граница

describe('RDBG-6: информационная граница отладки', () => {
  it('вырезанной фильтром снапшота сущности нет ни в наложении, ни в дампе', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(deliveryDebugSource());
    layer.setEnabled('net.delivery', true);
    // Персональный снапшот принёс одну сущность из двух существующих в мире
    // (NET-12): второй у клиента нет вовсе, и взять её отладке неоткуда.
    const view = makeTickView([makeEntityView(1)]);
    layer.frame(frameState(view));
    const section = layer.dump().sections['net.delivery'] as {
      entityCount: number;
      entities: { items: { entity: number }[] };
    };
    expect(section.entityCount).toBe(1);
    expect(section.entities.items.map((row) => row.entity)).toEqual([1]);
  });

  it('включённый источник не правит документ, из которого читает (RDBG-5)', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    // Замороженная секция `fog` парного presentation-документа (PRES-2): любая
    // попытка её переписать была бы исключением, а не молчаливой правкой.
    const section = Object.freeze({ resolution: 4, strength: 0.8 });
    const grid = pillarGrid(8, 4);
    stage.register(
      new FogSubsystem({
        grid,
        stats: { visionRadius: 'vision', team: 'team' },
        hero: () => 1,
        config: section,
      }),
    );
    layer.setEnabled('fog.mask', true);
    const hero = makeEntityView(1, {
      currX: 2.5,
      currY: 2.5,
      stats: new Map([
        ['team', 0],
        ['vision', 3],
      ]),
    });
    const view = makeTickView([hero], { statNames: ['team', 'vision'], snapAll: true });
    stage.publish({ name: 'test' }, view);
    layer.frame(frameState(view));
    layer.dump();
    expect(section).toEqual({ resolution: 4, strength: 0.8 });
  });

  it('источник без данных говорит это вслух, а не показывает выдуманное', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    const grid = flatGrid(4);
    stage.register(
      new FogSubsystem({ grid, stats: { visionRadius: 'vision', team: 'team' }, hero: () => null }),
    );
    layer.setEnabled('fog.mask', true);
    const section = layer.dump().sections['fog.mask'] as { noData?: string };
    expect(section.noData).toMatch(/маска ещё не построена/);
  });
});

// --------------------------------------- RDBG-8: невидимость счётчикам

describe('RDBG-8: отладка невидима счётчикам стоимости', () => {
  it('источник счётчиков рядом с чужим замером его не подменяет', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(costCountersDebugSource());
    const counters = createCostCounters();
    withCostSink(counters, () => {
      layer.setEnabled('cost.counters', true);
      counters.frameCalls += 7;
      layer.frame(frameState(null));
      const section = layer.dump().sections['cost.counters'] as {
        sink: string;
        frame: { frameCalls: number };
      };
      // Читатель чужого стока: значения те же, что снял бы замер без него.
      expect(section.sink).toBe('foreign');
      expect(section.frame.frameCalls).toBe(7);
    });
    expect(counters.frameCalls).toBe(7);
  });

  it('вне замера источник подключает свой сток и отпускает его при выключении', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(costCountersDebugSource());
    layer.setEnabled('cost.counters', true);
    layer.frame(frameState(null));
    expect((layer.dump().sections['cost.counters'] as { sink: string }).sink).toBe('own');
    layer.setEnabled('cost.counters', false);
    layer.setEnabled('cost.counters', true);
    layer.frame(frameState(null));
    const section = layer.dump().sections['cost.counters'] as { sink: string; noData?: string };
    expect(section.noData).toBeUndefined();
    expect(section.sink).toBe('own');
    layer.setEnabled('cost.counters', false);
  });

  it('счётчики матча с включёнными источниками и без них совпадают побитово', () => {
    const run = (debug: boolean): Record<string, number> => {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        const scene = new THREE.Scene();
        const context = { ...makeRenderContext(), scene };
        const stage = new PresentationStage(context);
        const grid = pillarGrid(8, 4);
        const surface = new VisualSurfaceSource(grid);
        const layer = new RenderDebugLayer(stage, { scene, surface });
        stage.register(new TerrainSubsystem(grid, { surface }));
        stage.register(
          new ModelsSubsystem(
            { entities: {}, effects: {}, terrain: {} },
            { surface, warn: () => {} },
          ),
        );
        if (debug) for (const source of layer.sources) layer.setEnabled(source.id, true);
        for (let tick = 1; tick <= 8; tick += 1) {
          const view = makeTickView([makeEntityView(1, { currX: tick / 4 })], { tick });
          stage.publish({ name: 'test' }, view);
          stage.frame(1 / 60, 0.5, 1 / 60);
          layer.frame(frameState(view));
        }
      });
      return { ...counters };
    };
    const withDebug = run(true);
    const without = run(false);
    expect(withDebug).toEqual(without);
    // И проверялось не отсутствие работы: счётчики непустые.
    expect(without.syncTickSubsystems).toBeGreaterThan(0);
  });
});
