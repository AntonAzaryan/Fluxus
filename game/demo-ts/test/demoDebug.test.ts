/**
 * Отладочный режим демо (`render-debug` RDBG-1, RDBG-6, RDBG-7) — ПОЛИТИКА
 * сборки, которой у движка нет: какие источники существуют, что они считают из
 * доставленного, как строится панель и как забирается дамп.
 *
 * Механизм проверен в `render-ts` (реестр, инертность, границы дампа); здесь —
 * что демо им пользуется правильно: реконструкция статики названа реконструкцией,
 * необъявленный стат даёт «нет данных», панель строится из реестра и группируется
 * по владельцу, выбор переживает перезагрузку, а незнакомый сохранённый `id`
 * игнорируется молча.
 *
 * DOM здесь — мини-заглушка на ту поверхность, которую панель зовёт: браузера в
 * прогоне нет, а панель — обычный DOM приложения (design D10).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTerrainGrid,
  withDiagnostics,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type EntityId,
  type TerrainGrid,
} from '@fluxus/core';
import {
  PresentationStage,
  RenderDebugLayer,
  applyCameraPose,
  type CameraPose,
  type CameraRig,
  type DebugDraw,
  type DebugFrameState,
  type EntityView,
  type RenderContext,
  type TickView,
} from '@fluxus/render';
import * as THREE from 'three';
import type { AssetService } from '@fluxus/assets';
import {
  DEBUG_GLOBAL_KEY,
  DEBUG_STORAGE_KEY,
  attachDebugGlobal,
  createDebugPanel,
  describeDump,
  rememberDebugSources,
  restoreDebugSources,
  storedDebugSources,
  type DebugGlobalHost,
} from '../app/debugPanel.js';
import {
  cameraDebugSource,
  dynamicCollidersDebugSource,
  inspectorDebugSource,
  navPathsDebugSource,
  staticCollidersDebugSource,
} from '../app/debugSources.js';
import { STATS } from '../app/sim.js';
import type { QualityStorage } from '../app/quality.js';

// ------------------------------------------------------------ мини-DOM и стенд

/** Ровно та поверхность DOM, которую зовёт панель, — и ни строчкой больше. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  textContent = '';
  className = '';
  title = '';
  type = '';
  checked = false;

  constructor(readonly tag: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(): void {
    this.children.length = 0;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Щелчок по галочке: тест меняет состояние и зовёт обработчик, как браузер. */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** Все элементы поддерева — по ним тест ищет строки панели. */
  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };

function withFakeDom<T>(body: () => T): T {
  const host = globalThis as { document?: unknown };
  const previous = host.document;
  host.document = fakeDocument;
  try {
    return body();
  } finally {
    if (previous === undefined) delete host.document;
    else host.document = previous;
  }
}

/** Хранилище выбора в памяти — тот же контракт, что у localStorage демо. */
function memoryStorage(initial: Record<string, string> = {}): QualityStorage & {
  readonly data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function renderContext(): RenderContext {
  return { scene: new THREE.Scene(), assets: {} as AssetService, config: { heightStep: 0.6 } };
}

/** Арена с перепадом уровней: у неё есть cliff-отрезки — вход статики (TERR-5). */
function cliffGrid(): TerrainGrid {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: 65536,
    levels: ['0000', '0110', '0110', '0000'],
    flags: ['....', '....', '....', '....'],
  });
}

function entityView(id: EntityId, stats?: Map<string, number>): EntityView {
  return {
    id,
    kind: 'Hero',
    prevX: 1,
    prevY: 1,
    currX: 3,
    currY: 1,
    prevLevel: 0,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: true,
    levelOverride: false,
    facingYaw: 0,
    aimYaw: null,
    states: 0,
    motion: 0,
    prevMotion: 0,
    prevMotionPhase: Number.NaN,
    currMotionPhase: Number.NaN,
    flightPhase: Number.NaN,
    timeScale: 1,
    ...(stats !== undefined ? { stats } : {}),
  };
}

function tickView(entities: EntityView[], statNames: readonly string[]): TickView {
  return {
    tick: 5,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: false,
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    statNames,
    events: [],
    floorBits: null,
    floorChangedCells: [],
  };
}

function state(view: TickView | null): DebugFrameState {
  return { view, alpha: 0.5, dtSeconds: 1 / 60, realDtSeconds: 1 / 60 };
}

/** Словарь примитивов-пустышек: тест подменяет ровно тот, который смотрит. */
const NO_DRAW: DebugDraw = {
  point: () => {},
  segment: () => {},
  polyline: () => {},
  circle: () => {},
  disc: () => {},
  box: () => {},
  polygon: () => {},
  raster: () => {},
};

// ------------------------------------------------ 4.1 статика из handshake

describe('RDBG-6/PHYS-10: статика выводится из сетки handshake и названа реконструкцией', () => {
  it('отрезки обрывов приезжают из cliffs, а сетка broad-phase — из конфигурации сборки', () => {
    const source = staticCollidersDebugSource(() => cliffGrid());
    const probe = source.probe(state(null));
    expect(probe.reconstruction).toBe(true);
    expect(probe.cliffSegments).toBe(cliffGrid().cliffs.length);
    expect(probe.cliffSegments).toBeGreaterThan(0);
    expect(probe.colliders.items.length).toBe(probe.cliffSegments);
    // Мировые единицы, а не Q16.16: конверсия осталась на входной границе (REND-1).
    for (const collider of probe.colliders.items) {
      expect(collider.maxWorldX).toBeLessThanOrEqual(4);
      expect(collider.maxWorldY).toBeLessThanOrEqual(4);
    }
    expect(probe.broadPhaseCellWorldUnits).toBe(4);
    expect(probe.broadPhaseCellsX).toBe(1);
  });

  it('без handshake источник говорит «нет данных», а не показывает пустую арену', () => {
    const source = staticCollidersDebugSource(() => null);
    expect(source.probe(state(null)).noData).toMatch(/handshake/);
  });
});

// --------------------------------------- 4.2 динамические коллайдеры статом

describe('RDBG-6: круги коллайдеров — только по объявленному стату', () => {
  it('стат объявлен — рисуется доставленный радиус', () => {
    const source = dynamicCollidersDebugSource(STATS.colliderRadius);
    const stats = new Map([[STATS.colliderRadius, 0.35]]);
    const probe = source.probe(state(tickView([entityView(1, stats)], [STATS.colliderRadius])));
    expect(probe.noData).toBeUndefined();
    expect(probe.withRadius).toBe(1);
    expect(probe.colliders.items[0]?.radiusWorldUnits).toBe(0.35);
    // Позиция кадра — интерполяция двух доставленных тиков (REND-2).
    expect(probe.colliders.items[0]?.frameWorldX).toBe(2);
  });

  it('стат не объявлен — «нет данных», и выдуманного радиуса нигде нет', () => {
    const source = dynamicCollidersDebugSource(STATS.colliderRadius);
    const probe = source.probe(state(tickView([entityView(1)], ['hp'])));
    expect(probe.noData).toMatch(/не объявлен/);
    expect(probe.colliders.items).toEqual([]);
  });

  it('стат объявлен сборкой, но у сущности его нет — она считается отдельно', () => {
    const source = dynamicCollidersDebugSource(STATS.colliderRadius);
    const probe = source.probe(state(tickView([entityView(1)], [STATS.colliderRadius])));
    expect(probe.noData).toBeUndefined();
    expect(probe.withRadius).toBe(0);
    expect(probe.withoutRadius).toBe(1);
  });
});

// ------------------------------------------------- 4.3/4.4 инспектор и камера

describe('RDBG-1: инспектор и камера — источники сборки', () => {
  it('инспектор без picking и позы говорит «нет данных»', () => {
    const source = inspectorDebugSource({
      picking: () => null,
      pose: () => null,
      point: () => null,
    });
    expect(source.probe(state(null)).noData).toMatch(/курсор/);
  });

  it('камера без rig говорит «нет данных»', () => {
    const source = cameraDebugSource({
      rig: () => null,
      pose: () => null,
      bounds: () => null,
      viewport: () => null,
    });
    expect(source.probe(state(null)).noData).toMatch(/камера/);
  });

  /**
   * Пирамида рисуется ПОЗОЙ КАДРА, включая её крен: ненулевой крен приезжает от
   * эффектов камеры (тряска, отдача), и наложение без него показывало бы не тот
   * кадр, который нарисован, — оставаясь при этом внутренне непротиворечивым.
   * Проверяется против самой камеры кадра: лучи по углам считаются её матрицей.
   */
  it('пирамида по углам кадра совпадает с камерой кадра и при ненулевом крене (CAM-1)', () => {
    const viewport = { width: 800, height: 600 };
    const pose: CameraPose = {
      posX: 3,
      posY: -2,
      posZ: 12,
      yaw: 0.9,
      pitch: 0.75,
      roll: 0.21,
      fovDeg: 45,
    };
    const rig = {
      mode: 'free',
      focusX: 3,
      focusY: -2,
      groundZ: 0,
      config: { edgeMarginPx: 24 },
    } as unknown as CameraRig;
    const source = cameraDebugSource({
      rig: () => rig,
      pose: () => pose,
      bounds: () => ({ minX: 0, minY: 0, maxX: 8, maxY: 8 }),
      viewport: () => viewport,
    });
    const probe = source.probe(state(null));
    expect(probe.noData).toBeUndefined();
    expect(probe.rollRadians).toBe(pose.roll);

    const rays: number[][] = [];
    source.draw!(probe, {
      ...NO_DRAW,
      segment: (x1, y1, z1, x2, y2, z2) => {
        rays.push([x2 - x1, y2 - y1, z2 - z1]);
      },
    });
    expect(rays).toHaveLength(4);

    const camera = new THREE.PerspectiveCamera(
      pose.fovDeg,
      viewport.width / viewport.height,
      0.1,
      300,
    );
    camera.up.set(0, 0, 1);
    applyCameraPose(camera, pose);
    camera.updateMatrixWorld(true);
    const corner = new THREE.Vector3();
    // Порядок обхода источника: sx во внешнем цикле, sy во внутреннем.
    const ndc: readonly (readonly [number, number])[] = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    ndc.forEach(([ndcX, ndcY], index) => {
      corner.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
      const drawn = new THREE.Vector3(...(rays[index] as [number, number, number])).normalize();
      expect(drawn.x).toBeCloseTo(corner.x, 6);
      expect(drawn.y).toBeCloseTo(corner.y, 6);
      expect(drawn.z).toBeCloseTo(corner.z, 6);
    });
  });
});

// ------------------------------------------------------ 7.1/7.2 нити пути NPC

/** Арена с дырой посреди: путь к держимой точке обязан её обогнуть (NAV-7). */
function navGrid(): TerrainGrid {
  return createTerrainGrid({
    width: 5,
    height: 5,
    tileSize: 65536,
    levels: ['00000', '00000', '00000', '00000', '00000'],
    flags: ['.....', '.....', '.._..', '.....', '.....'],
  });
}

const NAV_STATS = {
  x: STATS.navPathX,
  y: STATS.navPathY,
  valid: STATS.navPathValid,
  radius: STATS.colliderRadius,
  target: STATS.navTarget,
};

/** Агент с держимой точкой: позиция доставленного тика и точка — статами. */
function navAgent(id: EntityId, hold: [number, number] | null, target?: EntityId): EntityView {
  const stats = new Map<string, number>();
  if (hold === null) stats.set(STATS.navPathValid, 0);
  else {
    stats.set(STATS.navPathValid, 1);
    stats.set(STATS.navPathX, hold[0]);
    stats.set(STATS.navPathY, hold[1]);
  }
  if (target !== undefined) stats.set(STATS.navTarget, target);
  return { ...entityView(id), currX: 0.5, currY: 0.5, prevX: 0.5, prevY: 0.5, stats };
}

/** Цель движения агента — обычная доставленная сущность в назначенной клетке. */
function navGoal(id: EntityId, x: number, y: number): EntityView {
  return { ...entityView(id), currX: x, currY: y, prevX: x, prevY: y };
}

const NAV_STAT_NAMES = [STATS.navPathValid, STATS.navPathX, STATS.navPathY, STATS.navTarget];

describe('RDBG-6/NAV-1: нити пути NPC — из доставленных статов и пересчёта', () => {
  it('агент с держимой точкой даёт нить и пересчитанный путь', () => {
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const probe = source.probe(state(tickView([navAgent(1, [4.5, 4.5])], NAV_STAT_NAMES)));
    expect(probe.noData).toBeUndefined();
    expect(probe.agentsWithPath).toBe(1);
    expect(probe.agentsWithoutPath).toBe(0);
    const row = probe.agents.items[0]!;
    expect(row.entity).toBe(1);
    expect([row.holdWorldX, row.holdWorldY]).toEqual([4.5, 4.5]);
    // Пересчёт — тем же `findPath` ядра над сеткой handshake (NAV-2): путь
    // найден и начинается с позиции доставленного тика. Цель движения агенту
    // не доставлена, поэтому ведётся он до держимой точки, и проба говорит об
    // этом прямо, а не выдаёт ближайший шаг за весь путь.
    expect(row.status).toBe('found');
    expect(row.goal).toBe('hold');
    expect(row.goalEntity).toBe(0);
    expect(row.pathWorldPoints.slice(0, 3)).toEqual([0.5, 0.5, 0]);
    expect(row.pathWorldPoints.length).toBeGreaterThanOrEqual(6);
    // Нить и путь рисуются ломаными закрытого словаря примитивов (RDBG-3).
    const lines: number[][] = [];
    source.draw!(probe, { ...NO_DRAW, polyline: (points) => void lines.push([...points]) });
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual([0.5, 0.5, 0, 4.5, 4.5, 0]);
  });

  it('агент без держимой точки нити не даёт: он идёт прямым seek (NPC-6)', () => {
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const probe = source.probe(state(tickView([navAgent(1, null)], NAV_STAT_NAMES)));
    expect(probe.agentsWithPath).toBe(0);
    expect(probe.agentsWithoutPath).toBe(1);
    expect(probe.agents.items).toEqual([]);
    const lines: number[][] = [];
    source.draw!(probe, { ...NO_DRAW, polyline: (points) => void lines.push([...points]) });
    expect(lines).toEqual([]);
  });

  it('доставленная цель движения даёт ПОЛНЫЙ путь, огибающий препятствие', () => {
    // Цель за дырой в центре арены: прямой отрезок сквозь неё не проходит, и
    // пересчёт обязан вернуть ломаную с изломом, а не отрезок до держимой точки.
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const agent = navAgent(1, [1.5, 1.5], 2);
    const goal = navGoal(2, 4.5, 4.5);
    const probe = source.probe(state(tickView([agent, goal], NAV_STAT_NAMES)));
    const row = probe.agents.items[0]!;
    expect(row.goal).toBe('target');
    expect(row.goalEntity).toBe(2);
    expect([row.goalWorldX, row.goalWorldY]).toEqual([4.5, 4.5]);
    expect(row.status).toBe('found');
    // Путь ведёт ДО ЦЕЛИ, а не до держимой точки в соседней клетке.
    expect(row.pathWorldPoints.slice(-3)).toEqual([4.5, 4.5, 0]);
    expect(row.pathWorldPoints.length).toBeGreaterThan(6);
  });

  it('цель не доставлена — пересчёт честно ведётся до держимой точки (NET-12)', () => {
    // Номер цели у агента есть, а самой цели в доставке нет: восстанавливать её
    // отладке нечем и не из чего (RDBG-6).
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const probe = source.probe(state(tickView([navAgent(1, [1.5, 1.5], 7)], NAV_STAT_NAMES)));
    const row = probe.agents.items[0]!;
    expect(row.goal).toBe('hold');
    expect(row.goalEntity).toBe(0);
    expect([row.goalWorldX, row.goalWorldY]).toEqual([1.5, 1.5]);
  });

  it('стат держимой точки не объявлен — «нет данных», а не выдуманная нить', () => {
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const probe = source.probe(state(tickView([entityView(1)], ['hp'])));
    expect(probe.noData).toMatch(/не объявлен/);
    expect(probe.agents.items).toEqual([]);
  });

  it('без сетки handshake источник молчит, а не строит навигацию из ничего', () => {
    const source = navPathsDebugSource(NAV_STATS, () => null);
    expect(source.probe(state(tickView([navAgent(1, [1.5, 1.5])], NAV_STAT_NAMES))).noData).toMatch(
      /сетка террейна/,
    );
  });

  it('дамп несёт ТУ ЖЕ пробу, что и наложение (RDBG-2, RDBG-7)', () => {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    layer.register(source);
    layer.setEnabled('demo.navPaths', true);
    layer.frame(state(tickView([navAgent(1, [4.5, 4.5])], NAV_STAT_NAMES)));
    const section = layer.dump().sections['demo.navPaths'] as Record<string, unknown>;
    expect(section.agentsWithPath).toBe(1);
    const agents = section.agents as { items: { holdWorldX: number }[] };
    expect(agents.items[0]?.holdWorldX).toBe(4.5);
  });

  it('выключенный источник пробы не считает и кадра не трогает (RDBG-4)', () => {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    let probes = 0;
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    layer.register({
      ...source,
      probe: (frame) => {
        probes += 1;
        return source.probe(frame);
      },
    });
    const frame = state(tickView([navAgent(1, [4.5, 4.5])], NAV_STAT_NAMES));
    layer.frame(frame);
    expect(probes).toBe(0);
    layer.setEnabled('demo.navPaths', true);
    layer.frame(frame);
    expect(probes).toBe(1);
  });

  it('пересчёт пути в пробе не двигает счётчики стоимости (RDBG-8)', () => {
    // Проба снимается ВНУТРИ подключённого стока диагностики — то есть в самых
    // невыгодных для источника условиях: сток ядра живёт переменной модуля
    // (DIAG-1), и работа, посчитанная здесь, ушла бы в сводку игрового кадра.
    // Ноль в `navNodes` держится не моментом вызова, а сборкой навигации
    // отладочного слоя: она объявлена вне оплачиваемого пути (`cost: false`).
    const entries: DiagnosticRecord[] = [];
    const sink: DiagnosticsSink = { trace: 'systems', record: (entry) => void entries.push(entry) };
    const source = navPathsDebugSource(NAV_STATS, () => navGrid());
    const agent = navAgent(1, [1.5, 1.5], 2);
    const frame = state(tickView([agent, navGoal(2, 4.5, 4.5)], NAV_STAT_NAMES));
    let probed = 0;
    withDiagnostics(sink, 1, () => {
      const probe = source.probe(frame);
      probed = probe.agents.items.length;
    });
    // Работа была: путь пересчитан, ломаная есть.
    expect(probed).toBe(1);
    const cost = entries.filter((entry) => entry.code === 'TICK_COST');
    expect(cost).toHaveLength(1);
    expect(cost[0]?.data?.navNodes).toBe(0);
  });
});

// ------------------------------------------------------- 5.1/5.2 панель и выбор

describe('RDBG-1: панель строится из реестра (задачи 5.1, 5.2)', () => {
  afterEach(() => {
    delete (globalThis as DebugGlobalHost)[DEBUG_GLOBAL_KEY];
  });

  it('строки панели — источники реестра, сгруппированные по владельцу id', () => {
    withFakeDom(() => {
      const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
      layer.register({ id: 'net.delivery', title: 'доставка', probe: () => ({}) });
      layer.register({ id: 'physics.statics', title: 'статика', probe: () => ({}) });
      layer.register({ id: 'physics.dynamics', title: 'динамика', probe: () => ({}) });
      const container = new FakeElement('div');
      createDebugPanel({
        layer,
        container: container as unknown as HTMLElement,
        storage: memoryStorage(),
      });
      const texts = [...container.walk()]
        .filter((element) => element.className === 'debug-panel__owner')
        .map((element) => element.textContent);
      expect(texts).toEqual(['net', 'physics']);
      const boxes = [...container.walk()].filter((element) => element.type === 'checkbox');
      expect(boxes).toHaveLength(3);
      expect(boxes.every((box) => !box.checked)).toBe(true);
    });
  });

  it('галочка включает источник и запоминает выбор', () => {
    withFakeDom(() => {
      const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
      layer.register({ id: 'physics.statics', probe: () => ({}) });
      const storage = memoryStorage();
      const container = new FakeElement('div');
      createDebugPanel({ layer, container: container as unknown as HTMLElement, storage });
      const box = [...container.walk()].find((element) => element.type === 'checkbox')!;
      box.checked = true;
      box.fire('change');
      expect(layer.isEnabled('physics.statics')).toBe(true);
      expect(storage.data[DEBUG_STORAGE_KEY]).toBe('["physics.statics"]');
    });
  });

  it('сохранённый выбор восстанавливается, а незнакомый id игнорируется молча', () => {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    layer.register({ id: 'physics.statics', probe: () => ({}) });
    const storage = memoryStorage({
      [DEBUG_STORAGE_KEY]: '["physics.statics","ушедший.источник"]',
    });
    const stored = storedDebugSources(storage);
    expect(stored).toEqual(['physics.statics', 'ушедший.источник']);
    expect(() => {
      restoreDebugSources(layer, stored);
    }).not.toThrow();
    expect(layer.enabled).toEqual(['physics.statics']);
  });

  it('битая запись хранилища — пустой выбор, а не отказ страницы', () => {
    expect(storedDebugSources(memoryStorage({ [DEBUG_STORAGE_KEY]: 'не json' }))).toEqual([]);
    expect(storedDebugSources(memoryStorage({ [DEBUG_STORAGE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(storedDebugSources(undefined)).toEqual([]);
    expect(() => {
      rememberDebugSources(undefined, ['a.b']);
    }).not.toThrow();
  });
});

// ------------------------------- 5.1 панель не работает покадрово (RDBG-7)

describe('RDBG-7/RDBG-4: панель не собирает дамп каждым кадром', () => {
  /** Слой с одним источником и панель над ним — стенд обеих проверок ниже. */
  function panelRig(): {
    layer: RenderDebugLayer;
    panel: ReturnType<typeof createDebugPanel>;
    container: FakeElement;
    dumps: () => number;
  } {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    layer.register({ id: 'physics.statics', title: 'статика', probe: () => ({ segments: 4 }) });
    const container = new FakeElement('div');
    let dumps = 0;
    const real = layer.dump.bind(layer);
    layer.dump = (): ReturnType<typeof real> => {
      dumps += 1;
      return real();
    };
    const panel = createDebugPanel({
      layer,
      container: container as unknown as HTMLElement,
      storage: memoryStorage(),
      textIntervalMs: 250,
    });
    return { layer, panel, container, dumps: () => dumps };
  }

  it('с включённым источником дамп снимается по таймеру, а не каждым кадром', () => {
    withFakeDom(() => {
      const { layer, panel, dumps } = panelRig();
      layer.setEnabled('physics.statics', true);
      // Секунда кадров при 60 fps: покадровая сборка дала бы 60 дампов —
      // «дамп MUST NOT собираться каждый кадр» (RDBG-7).
      for (let frame = 0; frame <= 60; frame += 1) panel.update(frame * (1000 / 60));
      expect(dumps()).toBeLessThanOrEqual(5);
      expect(dumps()).toBeGreaterThan(0);
    });
  });

  it('щелчок галочки виден сразу, не дожидаясь таймера', () => {
    withFakeDom(() => {
      const { panel, container, dumps } = panelRig();
      panel.update(0);
      const before = dumps();
      const box = [...container.walk()].find((element) => element.type === 'checkbox')!;
      box.checked = true;
      box.fire('change');
      panel.update(1);
      expect(dumps()).toBe(before + 1);
      const text = [...container.walk()].find((element) => element.tag === 'pre')!;
      expect(text.textContent).toContain('physics.statics: segments=4');
    });
  });

  it('без единого включённого источника кадр панели не делает ничего', () => {
    withFakeDom(() => {
      const { panel, container, dumps } = panelRig();
      const box = [...container.walk()].find((element) => element.type === 'checkbox')!;
      for (let frame = 0; frame < 120; frame += 1) panel.update(frame * (1000 / 60));
      expect(dumps()).toBe(0);
      const text = [...container.walk()].find((element) => element.tag === 'pre')!;
      expect(text.textContent).toBe('');
      // Галочки покадрово не переписываются: их состояние — дело обработчика
      // события и `refresh()` (RDBG-4).
      box.checked = true;
      panel.update(5000);
      expect(box.checked).toBe(true);
    });
  });

  it('выбор, сделанный мимо панели, приезжает в галочки на refresh', () => {
    withFakeDom(() => {
      const { layer, panel, container } = panelRig();
      const box = [...container.walk()].find((element) => element.type === 'checkbox')!;
      // Ручка `__renderDebug` и восстановление запомненного включают источник
      // мимо DOM: панель узнаёт об этом перестроением, а не опросом каждый кадр.
      layer.setEnabled('physics.statics', true);
      expect(box.checked).toBe(false);
      panel.refresh();
      expect(box.checked).toBe(true);
    });
  });
});

// ------------------------------------------------------------ 5.3/5.4 ручка

describe('RDBG-7: ручка дампа и текстовая часть панели', () => {
  afterEach(() => {
    delete (globalThis as DebugGlobalHost)[DEBUG_GLOBAL_KEY];
  });

  it('версионированная ручка на globalThis отдаёт реестр и дамп', () => {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    layer.register({ id: 'physics.statics', title: 'статика', probe: () => ({ segments: 4 }) });
    const host: DebugGlobalHost = {};
    attachDebugGlobal(host, layer);
    const handle = host[DEBUG_GLOBAL_KEY]!;
    expect(handle.version).toBe(1);
    expect(handle.sources().map((source) => source.id)).toEqual(['physics.statics']);
    expect(handle.setEnabled('нет.такого', true)).toBe(false);
    expect(handle.setEnabled('physics.statics', true)).toBe(true);
    const dump = handle.dump();
    expect(dump.version).toBe(1);
    expect(dump.sections['physics.statics']).toEqual({ segments: 4 });
  });

  it('текст панели печатается ИЗ ДАМПА: имена и числа живут в DOM, а не в кадре', () => {
    const layer = new RenderDebugLayer(new PresentationStage(renderContext()));
    layer.register({
      id: 'game.inspector',
      probe: () => ({ hit: 'entity', entity: 7, stats: { hp: 12 } }),
    });
    layer.register({ id: 'physics.dynamics', probe: () => ({ noData: 'стат не объявлен' }) });
    layer.setEnabled('game.inspector', true);
    layer.setEnabled('physics.dynamics', true);
    const text = describeDump(layer.dump());
    expect(text).toContain('game.inspector: hit=entity entity=7');
    expect(text).toContain('physics.dynamics: стат не объявлен');
    expect(text).toContain('тик -1');
  });
});
