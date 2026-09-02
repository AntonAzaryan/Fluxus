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
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  FogSubsystem,
  ModelsSubsystem,
  PresentationStage,
  RenderDebugLayer,
  TerrainSubsystem,
  VisualSurfaceSource,
  costSink,
  createCostCounters,
  deliveryDebugSource,
  costCountersDebugSource,
  memoryDebugSource,
  programsDebugSource,
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

  it('имена статов приезжают в пробу копией, а не ссылкой на массив доставки', () => {
    const source = deliveryDebugSource();
    const first = makeTickView([], { tick: 1, statNames: ['hp', 'vision'] });
    const probe = source.probe(frameState(first));
    // Массив доставки живёт в буфере вида и переживает кадр: удержанная ссылка
    // открыла бы чтение состояния за пределами окна его валидности (RDBG-2).
    expect(probe.statNames).not.toBe(first.statNames);
    expect(probe.statNames).toEqual(['hp', 'vision']);
    // И это не свежий массив на кадр: структура пробы переиспользуется (REND-26).
    const names = probe.statNames;
    const again = source.probe(frameState(makeTickView([], { tick: 2, statNames: ['hp'] })));
    expect(again.statNames).toBe(names);
    expect(again.statNames).toEqual(['hp']);
  });

  it('дамп отвергает пробу со ссылкой на живую структуру — адресно, с путём поля', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(stubSource('x.leak', { entities: new Map([[1, { hp: 3 }]]) }));
    layer.setEnabled('x.leak', true);
    // Кадры идут — и молча: дамп собирается ПО ЗАПРОСУ, а не каждый кадр
    // (RDBG-7). Собирайся он покадрово, отказ пришёл бы уже здесь.
    for (let i = 0; i < 5; i += 1) layer.frame(frameState(null));
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

  it('выключенная отладка не строит даже состояния кадра: до слоя дело не доходит', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    layer.register(stubSource('x.any'));
    const frames = vi.spyOn(layer, 'frame');
    const view = makeTickView([makeEntityView(1)]);
    stage.publish({ name: 'test' }, view);
    for (let i = 0; i < 5; i += 1) stage.frame(1 / 60, 0.5, 1 / 60);
    // Своя точка у сцены (REND-27) зовётся каждый кадр, и объектный литерал
    // состояния был бы аллокацией на кадр (RDBG-4, REND-26) — при выключенной
    // отладке слой до него не доходит вовсе.
    expect(frames).not.toHaveBeenCalled();
    layer.setEnabled('x.any', true);
    stage.frame(1 / 60, 0.5, 1 / 60);
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it('состояние кадра — переиспользуемая структура, а не свежий объект на кадр', () => {
    const stage = new PresentationStage(makeRenderContext());
    const layer = new RenderDebugLayer(stage);
    const seen: DebugFrameState[] = [];
    layer.register({
      id: 'x.state',
      probe: (state) => {
        seen.push(state);
        return {};
      },
    });
    layer.setEnabled('x.state', true);
    stage.publish({ name: 'test' }, makeTickView([]));
    stage.frame(1 / 60, 0.25, 1 / 60);
    stage.frame(1 / 60, 0.75, 1 / 60);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    // Объект тот же, значения — этого кадра: переписываются поля, а не ссылка.
    expect(seen[1]?.alpha).toBe(0.75);
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

/** Все имена, до которых источник дотягивается от полученного рисовальщика. */
function reachableNames(value: object): string[] {
  const names = new Set<string>();
  for (
    let level: object | null = value;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(level)) names.add(name);
  }
  return [...names].sort();
}

/** Закрытый словарь примитивов рисования (RDBG-3) — ровно он, и ничего сверх. */
const PRIMITIVES = ['box', 'circle', 'disc', 'point', 'polygon', 'polyline', 'raster', 'segment'];

describe('RDBG-3: рисует рендер, источник приносит примитивы', () => {
  it('источнику достаётся закрытый словарь примитивов — ни сцены, ни жизненного цикла набора', () => {
    const scene = new THREE.Scene();
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), { scene });
    let surface: string[] = [];
    layer.register<DebugProbe>({
      id: 'x.surface',
      probe: () => ({}),
      draw: (_probe, out) => {
        // Всё, до чего источник дотягивается: сам объект и его прототипы. Ни
        // сцены, ни материалов, ни `clear()` слоя здесь быть не должно —
        // «прямого доступа к сцене, её объектам и материалам у источника MUST
        // NOT быть» (RDBG-3).
        surface = reachableNames(out);
      },
    });
    layer.setEnabled('x.surface', true);
    layer.frame(frameState(null));
    expect(surface).toEqual(PRIMITIVES);
  });

  it('единственный вход пробы — состояние кадра: сцены в нём нет', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), {
      scene: new THREE.Scene(),
    });
    let fields: string[] = [];
    layer.register<DebugProbe>({
      id: 'x.state',
      probe: (state) => {
        fields = reachableNames(state);
        return {};
      },
    });
    layer.setEnabled('x.state', true);
    layer.frame(frameState(null));
    expect(fields).toEqual(['alpha', 'dtSeconds', 'realDtSeconds', 'view']);
  });

  it('источник сцены не видит: наложение появляется объектами слоя', () => {
    const scene = new THREE.Scene();
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()), { scene });
    layer.register<DebugProbe>({
      id: 'x.primitives',
      probe: () => ({}),
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
    // Не только ТОТ ЖЕ материал, но и с теми же настройками: подмена ловится
    // тождеством, а правка на месте — снимком свойств, которыми материал красит
    // кадр (RDBG-5).
    const describeMaterial = (child: THREE.Object3D): string => {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (material === undefined) return 'нет материала';
      return JSON.stringify({
        color: material.color.getHex(),
        opacity: material.opacity,
        transparent: material.transparent,
        visible: material.visible,
        depthTest: material.depthTest,
        depthWrite: material.depthWrite,
        wireframe: material.wireframe,
      });
    };
    const before = scene.children.map((child) => ({
      uuid: child.uuid,
      material: (child as THREE.Mesh).material,
      look: describeMaterial(child),
      visible: child.visible,
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
      expect(describeMaterial(still!)).toBe(child.look);
      expect(still!.visible).toBe(child.visible);
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

  it('выключение посреди чужого замера не отбирает у него сток и не оставляет своего', () => {
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(costCountersDebugSource());
    // Источник включён ВНЕ замера: сток его собственный.
    layer.setEnabled('cost.counters', true);
    const own = costSink();
    expect(own).toBeDefined();

    const measured = createCostCounters();
    withCostSink(measured, () => {
      expect(costSink()).toBe(measured);
      // Галочку сняли посреди измерения: сток замера обязан остаться на месте —
      // отобранный, он оставил бы замер без счётчиков на полпути.
      layer.setEnabled('cost.counters', false);
      expect(costSink()).toBe(measured);
      measured.frameCalls += 3;
    });
    // Замер кончился — и ничего отладочного не осталось подключённым: сток, от
    // которого владелец отказался, обратно не встаёт (RDBG-4, RDBG-8).
    expect(costSink()).toBeUndefined();
    expect(measured.frameCalls).toBe(3);

    // Реестр после этого в рабочем состоянии: включение снова берёт пустое
    // место, выключение снова его отпускает.
    layer.setEnabled('cost.counters', true);
    expect(costSink()).toBeDefined();
    layer.setEnabled('cost.counters', false);
    expect(costSink()).toBeUndefined();
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

// ------------------------------------- render.programs: число живых программ

describe('render.programs: число живых шейдерных программ (RDBG-1, RDBG-7)', () => {
  /** Рендерер стендом: живой WebGL источнику не нужен — он читает готовый набор. */
  function fakeRenderer(): { info: { programs: { name: string }[] | null } } {
    return { info: { programs: [] } };
  }

  /** Число живых программ из дампа; undefined — секции нет (источник выключен). */
  function liveCount(layer: RenderDebugLayer): number | undefined {
    const section = layer.dump().sections['render.programs'] as
      | { liveProgramCount: number }
      | undefined;
    return section?.liveProgramCount;
  }

  it('включённый источник называет число живых программ, выключенного в дампе нет', () => {
    const renderer = fakeRenderer();
    renderer.info.programs!.push({ name: 'terrain' }, { name: 'models' });
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(programsDebugSource(renderer));

    // Выключенный источник секции не имеет вовсе — «выключено» и «данных нет»
    // различаются (RDBG-7).
    expect(layer.dump().sections['render.programs']).toBeUndefined();

    layer.setEnabled('render.programs', true);
    expect(liveCount(layer)).toBe(2);
  });

  it('компиляция с новым ключом кэша видна приращением — так ловится пересборка на каждом появлении', () => {
    const renderer = fakeRenderer();
    renderer.info.programs!.push({ name: 'terrain' });
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(programsDebugSource(renderer));
    layer.setEnabled('render.programs', true);
    const before = liveCount(layer)!;

    // Открылась видимость, нарисовался новый материал — драйвер собрал программу,
    // и прежняя осталась живой: набор вырос.
    renderer.info.programs!.push({ name: 'fogMaskedModels' });

    expect(before).toBe(1);
    expect(liveCount(layer)! - before).toBe(1);
  });

  it('это размер ЖИВОГО набора: освобождение уменьшает число, а пара «освободили+собрали» даёт ноль', () => {
    // Граница метода, из-за которой отчёт печатает оговорку: `releaseProgram`
    // вынимает запись из того же набора (three 0.185), поэтому компиляция,
    // уравновешенная освобождением, между двумя пробами неотличима от «ничего
    // не происходило». Счётчиком компиляций эта величина не является.
    const renderer = fakeRenderer();
    renderer.info.programs!.push({ name: 'terrain' }, { name: 'models' });
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(programsDebugSource(renderer));
    layer.setEnabled('render.programs', true);
    const before = liveCount(layer)!;

    // Последний пользователь материала ушёл — программа освобождена.
    renderer.info.programs!.pop();
    expect(liveCount(layer)).toBe(before - 1);

    // И собрана заново на следующем появлении: набор той же длины, что до пары.
    renderer.info.programs!.push({ name: 'models' });
    expect(liveCount(layer)).toBe(before);
  });

  it('рендерер без набора живых программ говорит это вслух, а не показывает ноль', () => {
    const renderer = fakeRenderer();
    renderer.info.programs = null;
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(programsDebugSource(renderer));
    layer.setEnabled('render.programs', true);

    const section = layer.dump().sections['render.programs'] as { noData?: string };
    // Причина едет наружу дословно: потребитель (бенч) печатает её как есть, а
    // не подменяет собственной догадкой «источник не зарегистрирован».
    expect(section.noData).toMatch(/не ведёт набора живых программ/);
  });

  it('проба ничего у рендерера не заказывает: читается только готовый набор (RDBG-8)', () => {
    // Инструментированной работы источник не просит — весь его вход это одно
    // чтение уже существующего поля. Сток счётчиков он не трогает вовсе.
    const reads: number[] = [];
    const renderer: { info: { programs: { length: number } } } = {
      info: {
        get programs(): { length: number } {
          reads.push(1);
          return { length: 3 };
        },
      },
    };
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(programsDebugSource(renderer));
    layer.setEnabled('render.programs', true);
    const counters = createCostCounters();

    withCostSink(counters, () => {
      layer.frame(frameState(null));
      layer.dump();
    });

    expect(reads.length).toBe(2);
    expect({ ...counters }).toEqual({ ...createCostCounters() });
  });
});

// ------------------------------ render.memory: живые геометрии и текстуры

describe('render.memory: живые ресурсы рендерера (RDBG-1, RDBG-7)', () => {
  /** Рендерер стендом: живой WebGL источнику не нужен — он читает готовый набор. */
  function fakeRenderer(): {
    info: { memory: { geometries: number; textures: number } | null };
  } {
    return { info: { memory: { geometries: 0, textures: 0 } } };
  }

  /** Проба из дампа; undefined — секции нет (источник выключен). */
  function probeOf(
    layer: RenderDebugLayer,
  ): { liveGeometries: number; liveTextures: number; noData?: string } | undefined {
    return layer.dump().sections['render.memory'] as
      | { liveGeometries: number; liveTextures: number; noData?: string }
      | undefined;
  }

  it('включённый источник называет живой набор, выключенного в дампе нет', () => {
    const renderer = fakeRenderer();
    renderer.info.memory = { geometries: 7, textures: 3 };
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(memoryDebugSource(renderer));

    // Выключенный источник секции не имеет вовсе — «выключено» и «данных нет»
    // различаются (RDBG-7).
    expect(probeOf(layer)).toBeUndefined();

    layer.setEnabled('render.memory', true);
    expect(probeOf(layer)).toMatchObject({ liveGeometries: 7, liveTextures: 3 });
  });

  it('оборот виден приращением: созданное и не отданное растит набор', () => {
    const renderer = fakeRenderer();
    renderer.info.memory = { geometries: 2, textures: 2 };
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(memoryDebugSource(renderer));
    layer.setEnabled('render.memory', true);
    const before = probeOf(layer)!.liveTextures;

    // Сущность появилась из тумана, завела текстуру и не отдала её (PERF-7).
    renderer.info.memory = { geometries: 2, textures: 5 };
    expect(probeOf(layer)!.liveTextures - before).toBe(3);
  });

  it('рендерер без набора говорит ПРИЧИНУ, а не нулевой набор', () => {
    const renderer = fakeRenderer();
    renderer.info.memory = null;
    const layer = new RenderDebugLayer(new PresentationStage(makeRenderContext()));
    layer.register(memoryDebugSource(renderer));
    layer.setEnabled('render.memory', true);
    // «Не измерено» и «ноль живых» — разные утверждения: нулём числа набора
    // читались бы как отсутствие ресурсов (RDBG-7).
    expect(probeOf(layer)?.noData).toContain('renderer.info.memory');
  });
});
