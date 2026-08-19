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
import { createTerrainGrid, type EntityId, type TerrainGrid } from '@game-mvp/core';
import {
  PresentationStage,
  RenderDebugLayer,
  type DebugFrameState,
  type EntityView,
  type RenderContext,
  type TickView,
} from '@game-mvp/render';
import * as THREE from 'three';
import type { AssetService } from '@game-mvp/assets';
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
      expect(collider.maxX).toBeLessThanOrEqual(4);
      expect(collider.maxY).toBeLessThanOrEqual(4);
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
    expect(probe.colliders.items[0]?.x).toBe(2);
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
