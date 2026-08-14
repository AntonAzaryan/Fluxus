/**
 * Виджет миникарты (задача 4.3, HUD-6, HUD-2): canvas-2D на доставленных
 * данных — фон из зеркала пола с перерисовкой по дельтам, маркеры по таблице
 * данных, клик — presentation-действие камеры без сообщений воркеру.
 *
 * Без браузера: DOM — фейковый (`support/fakeDom.ts`), 2D-контексты —
 * записывающие заглушки, навешенные на материализованные canvas-элементы
 * (виджет берёт контекст лениво, при первой отрисовке).
 */
import { describe, expect, it } from 'vitest';
import { HudActionsFacade } from '../src/actions.js';
import type { HudParams } from '../src/composition.js';
import type { HudDeliveredState, HudEntityView } from '../src/delivery.js';
import { HudOverlayHost } from '../src/host.js';
import { HudRegistry } from '../src/registry.js';
import { HudRuntime } from '../src/runtime.js';
import type { MinimapContext2D, MinimapMarkerTable, MinimapRendererRegistry } from '../src/minimap/markers.js';
import {
  minimapEntitiesSelector,
  minimapFloorSelector,
  minimapWidgetKind,
  type MinimapTerrainGrid,
} from '../src/minimap/widget.js';
import { asElement, fakeDom, walkElements, type FakeElement } from './support/fakeDom.js';
import { CameraSpy, makeView } from './support/hud.js';

// ------------------------------------------------------------------- стенд

interface RecordedCall {
  op: string;
  args: readonly number[];
  fillStyle: unknown;
}

/** Записывающая заглушка 2D-контекста — тест утверждает по вызовам отрисовки. */
class RecordingContext implements MinimapContext2D {
  fillStyle: unknown = '';
  readonly calls: RecordedCall[] = [];

  ops(op: string): RecordedCall[] {
    return this.calls.filter((call) => call.op === op);
  }

  private push(op: string, args: readonly number[]): void {
    this.calls.push({ op, args, fillStyle: this.fillStyle });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.push('fillRect', [x, y, width, height]);
  }
  clearRect(x: number, y: number, width: number, height: number): void {
    this.push('clearRect', [x, y, width, height]);
  }
  beginPath(): void {
    this.push('beginPath', []);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.push('arc', [x, y, radius, startAngle, endAngle]);
  }
  moveTo(x: number, y: number): void {
    this.push('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.push('lineTo', [x, y]);
  }
  closePath(): void {
    this.push('closePath', []);
  }
  fill(): void {
    this.push('fill', []);
  }
}

/** Заглушка контекста навешивается на материализованный canvas фейкового DOM. */
function attachContext(canvas: FakeElement, ctx: RecordingContext): void {
  (canvas as unknown as { getContext: (id: string) => RecordingContext }).getContext = () => ctx;
}

const baseTable: MinimapMarkerTable = {
  markers: {
    hero: {
      renderer: 'dot',
      color: { mode: 'team', byTeam: { '0': '#3af', '1': '#f43' }, fallback: '#ccc' },
      size: 6,
      priority: 10,
    },
    creep: { renderer: 'dot', color: { mode: 'fixed', color: '#8f8' }, size: 3, priority: 1 },
  },
  unknownKind: { policy: 'skip' },
};

/** Сетка 8×8, клетка 1 мировая единица (tileSize — Q16.16), канвас 64×64 → масштаб 8. */
const squareGrid: MinimapTerrainGrid = { width: 8, height: 8, tileSize: 65536 };

interface BenchOptions {
  readonly table?: MinimapMarkerTable;
  readonly renderers?: MinimapRendererRegistry;
  readonly terrain?: MinimapTerrainGrid | null;
}

function bench(options: BenchOptions = {}) {
  const registry = new HudRegistry();
  const terrainSource: { terrain: MinimapTerrainGrid | null } = {
    terrain: options.terrain !== undefined ? options.terrain : squareGrid,
  };
  registry.registerWidget(
    minimapWidgetKind({
      terrain: terrainSource,
      ...(options.renderers !== undefined ? { renderers: options.renderers } : {}),
    }),
  );
  registry.registerSelector('minimap.entities', minimapEntitiesSelector);
  registry.registerSelector('minimap.floor', minimapFloorSelector);
  registry.registerAction('minimapPan', {
    target: 'presentation',
    run: (camera, payload) => {
      camera.panTo(payload?.x ?? 0, payload?.y ?? 0);
    },
  });

  const dom = fakeDom();
  const host = new HudOverlayHost(asElement(dom.container));
  const camera = new CameraSpy();
  const controlCalls: [string, number | undefined][] = [];
  const facade = new HudActionsFacade({
    actions: registry,
    camera,
    control: { control: (action, tick) => controlCalls.push([action, tick]) },
  });
  // Фасад «в сэмплере»: любой фронт мирового ввода был бы виден здесь.
  const pressed: string[] = [];
  facade.start((action) => pressed.push(action));
  const runtime = new HudRuntime({ registry, host, actions: facade });

  const params: HudParams = { width: 64, height: 64, markers: options.table ?? baseTable };
  runtime.apply({
    entries: [
      {
        widget: 'minimap',
        zone: 'bottom-left',
        params,
        bindings: { entities: 'minimap.entities', floor: 'minimap.floor' },
        actions: { pan: 'minimapPan' },
      },
    ],
  });

  const canvases = [...walkElements(dom.container)].filter((element) => element.tag === 'canvas');
  const floorCanvas = canvases.find((c) => (c.getAttribute('class') ?? '').includes('hud-minimap-floor'))!;
  const markerCanvas = canvases.find((c) =>
    (c.getAttribute('class') ?? '').includes('hud-minimap-markers'),
  )!;
  const floorCtx = new RecordingContext();
  const markerCtx = new RecordingContext();
  attachContext(floorCanvas, floorCtx);
  attachContext(markerCanvas, markerCtx);

  return { runtime, camera, controlCalls, pressed, floorCtx, markerCtx, floorCanvas, markerCanvas, terrainSource };
}

function entity(id: number, kind: string | null, x: number, y: number, team?: number): HudEntityView {
  const view = {
    id,
    kind,
    currX: x,
    currY: y,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: false,
    ...(team !== undefined ? { team } : {}),
  };
  return view;
}

function viewWith(entities: readonly HudEntityView[], partial: Partial<HudDeliveredState> = {}): HudDeliveredState {
  return makeView({ entities: new Map(entities.map((e) => [e.id, e])), ...partial });
}

// ------------------------------------------------------------------- тесты

describe('маркеры по таблице данных (HUD-6)', () => {
  it('маркер рисуется по записи: аффинное мир → px и командная окраска', () => {
    const { runtime, markerCtx } = bench();
    // Герой команды 0 в мировой точке (2, 3): масштаб 8, смещения нет → px (16, 24).
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 3, 0)]));
    const arcs = markerCtx.ops('arc');
    expect(arcs).toHaveLength(1);
    // Вертикаль перевёрнута (HUD-6): мировая y = 3 на арене 8×8 — это 40 px
    // сверху, а не 24; «вверх мира» и «вверх canvas» совпадают.
    expect(arcs[0]!.args).toEqual([16, 40, 3, 0, Math.PI * 2]);
    expect(arcs[0]!.fillStyle).toBe('#3af');
  });

  it('новый тип сущности — запись таблицы, а не правка кода (сценарий HUD-6)', () => {
    // Ничего не регистрируем: тот же вид виджета, тот же реестр отрисовщиков.
    // Меняется только значение таблицы — данные композиции.
    const extended: MinimapMarkerTable = {
      ...baseTable,
      markers: {
        ...baseTable.markers,
        tower: { renderer: 'square', color: { mode: 'fixed', color: '#ff0' }, size: 4, priority: 5 },
      },
    };
    const { runtime, markerCtx } = bench({ table: extended });
    runtime.subsystem.syncTick(viewWith([entity(1, 'tower', 4, 4)]));
    const rects = markerCtx.ops('fillRect');
    expect(rects).toHaveLength(1);
    // Центр (32, 32), размер 4 → квадрат от (30, 30).
    expect(rects[0]!.args).toEqual([30, 30, 4, 4]);
    expect(rects[0]!.fillStyle).toBe('#ff0');
  });

  it('тип без записи: политика skip — пропуск без ошибки (сценарий HUD-6)', () => {
    const { runtime, markerCtx } = bench();
    runtime.subsystem.syncTick(viewWith([entity(1, 'mystery', 1, 1), entity(2, 'creep', 2, 2)]));
    // mystery пропущен, creep нарисован; отрисовка не сломалась.
    expect(markerCtx.ops('arc')).toHaveLength(1);
    expect(markerCtx.ops('arc')[0]!.fillStyle).toBe('#8f8');
  });

  it('тип без записи: политика default — маркер по умолчанию (сценарий HUD-6)', () => {
    const withDefault: MinimapMarkerTable = {
      markers: baseTable.markers,
      unknownKind: {
        policy: 'default',
        marker: { renderer: 'square', color: { mode: 'fixed', color: '#999' }, size: 2, priority: 0 },
      },
    };
    const { runtime, markerCtx } = bench({ table: withDefault });
    runtime.subsystem.syncTick(viewWith([entity(1, 'mystery', 1, 1)]));
    const rects = markerCtx.ops('fillRect');
    expect(rects).toHaveLength(1);
    expect(rects[0]!.fillStyle).toBe('#999');
  });

  it('kind === null — сущность не рисуется, как и в основном виде', () => {
    const { runtime, markerCtx } = bench();
    runtime.subsystem.syncTick(viewWith([entity(1, null, 1, 1)]));
    expect(markerCtx.ops('arc')).toHaveLength(0);
    expect(markerCtx.ops('fillRect')).toHaveLength(0);
  });

  it('скрытая туманом сущность отсутствует в доставленном состоянии — и на миникарте (сценарий HUD-6)', () => {
    const { runtime, markerCtx } = bench();
    // Враг виден: доставлены обе сущности.
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 3, 0), entity(2, 'hero', 5, 5, 1)]));
    expect(markerCtx.ops('arc')).toHaveLength(2);

    // Враг скрылся: снапшот отфильтрован в симуляции (HUD-1, NET-12) — в
    // доставке его просто нет. Виджету нечего фильтровать: слой маркеров
    // очищается и рисуется только доставленное.
    markerCtx.calls.length = 0;
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 3, 0)], { tick: 1 }));
    expect(markerCtx.ops('clearRect')).toHaveLength(1);
    expect(markerCtx.ops('arc')).toHaveLength(1);
    expect(markerCtx.ops('arc')[0]!.args.slice(0, 2)).toEqual([16, 40]);
  });

  it('порядок отрисовки детерминирован: приоритет возрастанием, при равенстве — id', () => {
    const layered: MinimapMarkerTable = {
      markers: {
        low: { renderer: 'square', color: { mode: 'fixed', color: '#111' }, size: 2, priority: 1 },
        mid: { renderer: 'square', color: { mode: 'fixed', color: '#222' }, size: 2, priority: 3 },
        high: { renderer: 'square', color: { mode: 'fixed', color: '#333' }, size: 2, priority: 5 },
      },
      unknownKind: { policy: 'skip' },
    };
    const { runtime, markerCtx } = bench({ table: layered });
    // Порядок в Map нарочно перемешан относительно приоритетов и id.
    runtime.subsystem.syncTick(
      viewWith([entity(9, 'low', 1, 1), entity(1, 'high', 2, 2), entity(5, 'mid', 3, 3), entity(2, 'low', 4, 4)]),
    );
    // Больший приоритет рисуется позже (поверх); равные приоритеты — по id.
    expect(markerCtx.ops('fillRect').map((call) => call.fillStyle)).toEqual([
      '#111', // low, id 2
      '#111', // low, id 9
      '#222', // mid
      '#333', // high
    ]);
    const lows = markerCtx.ops('fillRect').slice(0, 2);
    expect(lows[0]!.args.slice(0, 2)).toEqual([31, 31]); // id 2 в (4,4) → центр 32 − 1
    expect(lows[1]!.args.slice(0, 2)).toEqual([7, 55]); // id 9 в (1,1) → центр (8, 56) − 1
  });
});

describe('фон из зеркала пола (HUD-6)', () => {
  it('дельты пола перерисовывают только изменившиеся клетки; полная перерисовка — по снапу', () => {
    const { runtime, floorCtx } = bench();
    const bits = new Uint8Array(64).fill(1);

    // Первая доставка: этот массив ещё не рисовали — фон целиком (64 клетки).
    runtime.subsystem.syncTick(viewWith([], { floorBits: bits }));
    expect(floorCtx.ops('clearRect')).toHaveLength(1);
    expect(floorCtx.ops('fillRect')).toHaveLength(64);

    // Пол снят в клетке 10 (cx=2, cy=1): перерисована ровно она, цветом дыры.
    floorCtx.calls.length = 0;
    bits[10] = 0;
    runtime.subsystem.syncTick(viewWith([], { tick: 1, floorBits: bits, floorChangedCells: [10] }));
    expect(floorCtx.ops('clearRect')).toHaveLength(0);
    const delta = floorCtx.ops('fillRect');
    expect(delta).toHaveLength(1);
    // Клетка (2,1) занимает мир [1..2] по y → верхний край на 48 px (HUD-6).
    expect(delta[0]!.args).toEqual([16, 48, 8, 8]);
    expect(delta[0]!.fillStyle).toBe('#14161a');

    // Дельт нет — фон не трогается вовсе.
    floorCtx.calls.length = 0;
    runtime.subsystem.syncTick(viewWith([], { tick: 2, floorBits: bits }));
    expect(floorCtx.ops('fillRect')).toHaveLength(0);

    // Разрыв непрерывности (SHELL-7): снап — полная перерисовка, не доигрывание.
    runtime.subsystem.syncTick(viewWith([], { tick: 3, floorBits: bits, snapAll: true }));
    expect(floorCtx.ops('clearRect')).toHaveLength(1);
    expect(floorCtx.ops('fillRect')).toHaveLength(64);
  });

  it('сцена без террейна: floorBits null и terrain null — виджет молчит, не падает', () => {
    const { runtime, floorCtx, markerCtx } = bench({ terrain: null });
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 3, 0)]));
    expect(floorCtx.calls).toHaveLength(0);
    expect(markerCtx.calls).toHaveLength(0);
  });
});

describe('клик миникарты — presentation-действие камеры (HUD-2)', () => {
  it('клик переводит px → мир обратным аффинным и зовёт камеру; воркеру не уходит ничего', () => {
    const { runtime, camera, controlCalls, pressed, markerCanvas } = bench();
    runtime.subsystem.syncTick(viewWith([]));

    // px (16, 40) → мир (2, 3): обратное преобразование ТОГО ЖЕ отображения,
    // которым нарисован маркер, — точка под отметкой и точка камеры совпадают.
    markerCanvas.dispatch('click', { offsetX: 16, offsetY: 40 });
    expect(camera.panned).toEqual([[2, 3]]);
    // Камера двигается локально в главном потоке (сценарий «клик миникарты
    // двигает камеру»): ни фронтов мирового ввода, ни команд обратного канала.
    expect(pressed).toEqual([]);
    expect(controlCalls).toEqual([]);
  });

  it('прямоугольная арена: центрирование учитывается, клик в поля прижимается к краю', () => {
    // Сетка 8×4 на канвасе 64×64: масштаб 8, полоса по вертикали → offsetY 16.
    const { runtime, camera, markerCanvas } = bench({ terrain: { width: 8, height: 4, tileSize: 65536 } });
    runtime.subsystem.syncTick(viewWith([]));

    markerCanvas.dispatch('click', { offsetX: 40, offsetY: 32 });
    expect(camera.panned).toEqual([[5, 2]]);

    // Клик выше арены (в поле центрирования) — прижат к дальнему краю: при
    // перевёрнутой вертикали «выше» значит «дальше по +Y», а не «до нуля».
    markerCanvas.dispatch('click', { offsetX: 10, offsetY: 4 });
    expect(camera.panned).toEqual([
      [5, 2],
      [1.25, 4],
    ]);
  });

  it('движение на экране и на миникарте совпадают, клик обратен отрисовке (HUD-6)', () => {
    const { runtime, camera, markerCtx, markerCanvas } = bench();
    // Сущность идёт на «север» основного вида — в сторону растущей мировой y.
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 1, 0)]));
    const first = markerCtx.ops('arc')[0]!.args[1]!;
    markerCtx.calls.length = 0;
    runtime.subsystem.syncTick(viewWith([entity(1, 'hero', 2, 5, 0)], { tick: 1 }));
    const second = markerCtx.ops('arc')[0]!.args[1]!;
    // «Вверх экрана» на миникарте — меньшая координата canvas: маркер поехал
    // вверх, а не вниз, как было до переворота.
    expect(second).toBeLessThan(first);

    // Клик по отметке возвращает ровно ту точку мира, над которой она стоит.
    const px = markerCtx.ops('arc')[0]!.args[0]!;
    markerCanvas.dispatch('click', { offsetX: px, offsetY: second });
    expect(camera.panned).toEqual([[2, 5]]);
  });

  it('клик до первой доставки — no-op: преобразования ещё нет', () => {
    const { camera, markerCanvas } = bench();
    markerCanvas.dispatch('click', { offsetX: 16, offsetY: 24 });
    expect(camera.panned).toEqual([]);
  });
});
