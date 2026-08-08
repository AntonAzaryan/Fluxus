/**
 * Кисти вьюпорта (ED-10, ED-11) и то, как область отдаёт им указатель (ED-25).
 *
 * Кадра в headless-прогоне нет, поэтому попадания раскладывает по экрану сам
 * тест: согласованность попадания с изображением — свойство рендера (REND-15), и
 * подделывать его здесь было бы враньём. Проверяется то, что принадлежит
 * редактору: во что попадание превращается — в правку документа операцией
 * (ED-29), в одну запись истории на мазок (ED-18) и в набор наложений (REND-16).
 */
import { createTerrainGrid, type TerrainDef } from '@game-mvp/core';
import { getAtPath, type EditorSession } from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { findAll, type UiNode } from '../src/dom/node.js';
import { SCENE_AREA_ID, sceneArea } from '../src/areas/scene.js';
import {
  BRUSH_OVERLAY_KEYS,
  createBrushTool,
  type BrushTool,
  type BrushToolInput,
} from '../src/areas/sceneBrush.js';
import { TERRAIN_ASSET } from '../src/areas/sceneProject.js';
import type { ScenePicker, StagePointer } from '../src/areas/sceneInteraction.js';
import {
  buildFrame,
  buildLoadedFrame,
  buttonByKey,
  press,
  type LoadedFrameFixture,
} from './support/frame.js';
import { PAINT_IDS, PAINT_SIDE, bytesOf, paintSession } from './support/paint.js';
import { FIXTURE_CURVATURE_ID, FIXTURE_IDS, cellHit, settle } from './support/project.js';

/**
 * Экран, разложенный на клетки: точка `(x, y)` — клетка `(x, y)`. Настоящий
 * picking считает по визуальной поверхности (REND-9, REND-15), и такой
 * раскладки у него нет; здесь она нужна ровно затем, чтобы мазок был выразим
 * последовательностью точек.
 */
function cellPicker(side: number): ScenePicker {
  const hit = (x: number, y: number) =>
    x < 0 || y < 0 || x >= side || y >= side ? null : cellHit(x, y, side);
  return { pick: hit, pickSurface: hit };
}

const at = (phase: StagePointer['phase'], x: number, y: number): StagePointer => ({
  phase,
  x,
  y,
  additive: false,
});

interface Painter {
  readonly session: EditorSession;
  readonly brush: BrushTool;
  readonly input: BrushToolInput;
}

function painter(curvature = true): Painter {
  const session = paintSession();
  const brush = createBrushTool({ session });
  const grid = { width: PAINT_SIDE, height: PAINT_SIDE };
  const input: BrushToolInput = {
    picker: cellPicker(PAINT_SIDE),
    terrain: { target: { document: PAINT_IDS.config, path: TERRAIN_ASSET }, grid },
    curvature: curvature ? { target: { document: PAINT_IDS.curvature, path: [] }, grid } : null,
  };
  brush.attach(input);
  return { session, brush, input };
}

const stroke = (brush: BrushTool, cells: readonly (readonly [number, number])[]): void => {
  const [first, ...rest] = cells;
  if (first === undefined) return;
  brush.pointer(at('down', first[0], first[1]));
  for (const [x, y] of rest) brush.pointer(at('move', x, y));
  brush.pointer(at('up', first[0], first[1]));
};

/** Двадцать клеток подряд: две с половиной строки сетки 8×8. */
const TWENTY: readonly (readonly [number, number])[] = Array.from(
  { length: 20 },
  (_unused, index) => [index % PAINT_SIDE, Math.floor(index / PAINT_SIDE)] as const,
);

const levelsOf = (session: EditorSession) =>
  createTerrainGrid(
    getAtPath(session.documentValue(PAINT_IDS.config), TERRAIN_ASSET) as unknown as TerrainDef,
  ).levels;

describe('ED-18: непрерывный мазок — одна операция', () => {
  it('мазок по двадцати клеткам отменяется одним шагом', () => {
    const { session, brush } = painter();
    const before = bytesOf(session, PAINT_IDS.config);
    brush.setLevel(3);

    stroke(brush, TWENTY);

    const levels = levelsOf(session);
    for (const [x, y] of TWENTY) expect(levels[y * PAINT_SIDE + x]).toBe(3);
    expect(session.history().undo).toHaveLength(1);
    expect(session.history().undo[0]?.operationId).toBe('scene.terrain.level');

    session.undo();
    // Все двадцать клеток вернулись к прежним уровням одним действием.
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    expect(session.canUndo()).toBe(false);
  });

  it('клик кистью по одной клетке — правка, а не выделение', () => {
    // Порога сдвига у кисти нет и быть не должно: нажатие ею и есть мазок.
    const { session, brush } = painter();
    brush.setLevel(2);
    brush.pointer(at('down', 1, 1));
    brush.pointer(at('up', 1, 1));
    expect(levelsOf(session)[1 * PAINT_SIDE + 1]).toBe(2);
    expect(session.history().undo).toHaveLength(1);
  });

  it('мазок по клетке, которая уже такая, записи не оставляет', () => {
    // Иначе undo после «покрасил тем же» не делал бы ничего, и автор нажал бы
    // второй раз, отменив не то.
    const { session, brush } = painter();
    brush.setLevel(0);
    stroke(brush, [
      [1, 1],
      [2, 1],
    ]);
    expect(session.history().undo).toEqual([]);
  });

  it('брошенный мазок возвращает карты и не оставляет записи', () => {
    // Отпускание, до вьюпорта не дошедшее (окно потеряло фокус, область снесена):
    // без закрытия взаимодействие осталось бы открытым, а пока оно открыто,
    // сессия не даёт ни следующей операции, ни undo.
    const { session, brush } = painter();
    const before = bytesOf(session, PAINT_IDS.config);
    brush.setLevel(5);
    brush.pointer(at('down', 0, 0));
    brush.pointer(at('move', 1, 0));
    expect(session.pending).toBe(true);

    brush.pointer(at('cancel', 0, 0));
    expect(session.pending).toBe(false);
    expect(brush.painting).toBe(false);
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    expect(session.history().undo).toEqual([]);
  });

  it('нажатие поверх незакрытого мазка закрывает прежний, а не забывает его', () => {
    const { session, brush } = painter();
    brush.setLevel(4);
    brush.pointer(at('down', 0, 0));
    brush.pointer(at('down', 3, 3));
    expect(session.pending).toBe(true);
    brush.pointer(at('up', 3, 3));
    expect(session.pending).toBe(false);
    // Первый мазок откачен, второй записан — записей ровно одна.
    expect(session.history().undo).toHaveLength(1);
    expect(levelsOf(session)[0]).toBe(0);
    expect(levelsOf(session)[3 * PAINT_SIDE + 3]).toBe(4);
  });

  it('смена инструмента посреди мазка закрывает его тем же путём', () => {
    const { session, brush } = painter();
    brush.setLevel(6);
    brush.pointer(at('down', 2, 2));
    expect(session.pending).toBe(true);
    brush.setLayer('curvature');
    expect(session.pending).toBe(false);
    expect(session.history().undo).toEqual([]);
  });

  it('отказ операции посреди мазка бросает его целиком, а не наполовину', () => {
    // Половина покрашенных клеток — состояние, которого не производит ни одна
    // операция целиком; `commit` записал бы его в историю как достижимое.
    const { session, brush } = painter();
    const before = bytesOf(session, PAINT_IDS.config);
    brush.setLevel(99);
    expect(() => {
      stroke(brush, TWENTY);
    }).not.toThrow();
    expect(session.pending).toBe(false);
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    expect(session.history().undo).toEqual([]);
  });
});

describe('ED-10: кисть террейна правит уровни, рампы и пол', () => {
  it('рампа и снятый пол уходят в карту флагов, а уровни остаются', () => {
    const { session, brush } = painter();
    const levels = levelsOf(session);
    brush.setMode('removeFloor');
    stroke(brush, [[2, 2]]);
    brush.setMode('ramp');
    stroke(brush, [
      [4, 4],
      [5, 4],
    ]);

    const flags = getAtPath(session.documentValue(PAINT_IDS.config), [
      ...TERRAIN_ASSET,
      'flags',
    ]) as readonly string[];
    expect(flags[2]?.[2]).toBe('_');
    expect(flags[4]?.slice(4, 6)).toBe('^^');
    expect(levelsOf(session)).toEqual(levels);
  });

  it('размер кисти красит квадрат клеток и обрезается по краю карты', () => {
    const { session, brush } = painter();
    brush.setSize(3);
    brush.setLevel(1);
    stroke(brush, [[0, 0]]);
    // Из девяти клеток квадрата на карте лежат четыре — остальные за краем.
    const levels = levelsOf(session);
    expect([levels[0], levels[1], levels[PAINT_SIDE], levels[PAINT_SIDE + 1]]).toEqual([1, 1, 1, 1]);
    expect(levels[2]).toBe(0);
    expect(session.history().undo).toHaveLength(1);
  });
});

describe('ED-11: кисть кривизны живёт в своём слое', () => {
  it('мазок кривизны не трогает конфиг сцены ни на байт', () => {
    const { session, brush } = painter();
    const before = bytesOf(session, PAINT_IDS.config);
    brush.setLayer('curvature');
    brush.setOffset(-3);
    stroke(brush, TWENTY);

    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    const rows = getAtPath(session.documentValue(PAINT_IDS.curvature), [
      'rows',
    ]) as readonly string[];
    // `c` — третья буква алфавита вогнутости (ASSET-7): −3/16 шага высоты.
    expect(rows[0]).toBe('cccccccc');
    expect(session.history().undo).toHaveLength(1);
  });

  it('без карты кривизны кисть недоступна и молча ничего не пишет', () => {
    const { session, brush } = painter(false);
    expect(brush.available('curvature')).toBe(false);
    expect(brush.available('terrain')).toBe(true);
    brush.setLayer('curvature');
    stroke(brush, [[1, 1]]);
    expect(session.history().undo).toEqual([]);
  });
});

describe('REND-16: превью кисти и сетка уходят набором наложений', () => {
  it('набор — функция состояния кисти, а не история вызовов', () => {
    const { brush } = painter();
    // До наведения кисть показывает только сетку: красить пока негде.
    expect(brush.overlays()).toEqual([{ kind: 'grid', key: BRUSH_OVERLAY_KEYS.grid }]);

    brush.setSize(3);
    brush.pointer(at('move', 4, 4));
    const overlays = brush.overlays();
    expect(overlays[0]).toEqual({ kind: 'grid', key: BRUSH_OVERLAY_KEYS.grid });
    const cells = overlays[1];
    expect(cells?.kind).toBe('cells');
    expect(cells?.kind === 'cells' ? cells.cells : []).toHaveLength(9);
    // Клетки названы индексами сетки — теми же, какими их называет picking.
    expect(cells?.kind === 'cells' ? cells.cells : []).toContain(4 * PAINT_SIDE + 4);

    brush.setShowGrid(false);
    expect(brush.overlays().map((item) => item.kind)).toEqual(['cells']);
  });

  it('курсор за ареной гасит превью, а не оставляет его на прежней клетке', () => {
    const { brush } = painter();
    brush.pointer(at('move', 2, 2));
    expect(brush.overlays()).toHaveLength(2);
    brush.pointer(at('move', PAINT_SIDE + 1, 2));
    expect(brush.overlays().map((item) => item.kind)).toEqual(['grid']);
  });
});

// --------------------------------------------------------------- область

const view = (fixture: LoadedFrameFixture): UiNode => fixture.frame.view();

/** Раскладывает кадр фикстуры (4×4) на клетки: точка `(x, y)` — клетка `(x, y)`. */
function withCells(fixture: LoadedFrameFixture): LoadedFrameFixture {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) fixture.stage.surfaceHits.set(`${x}:${y}`, cellHit(x, y, 4));
  }
  view(fixture);
  return fixture;
}

describe('ED-25: два инструмента делят один вьюпорт', () => {
  it('указатель уходит активному инструменту, а не обоим', async () => {
    const fixture = withCells(await buildLoadedFrame());
    const before = fixture.frame.selection.get(SCENE_AREA_ID);

    press(buttonByKey(view(fixture), 'ui.area.scene.toolTerrain'));
    fixture.state.brush.setLevel(2);
    fixture.pointer(at('down', 1, 1));
    fixture.pointer(at('up', 1, 1));

    const levels = getAtPath(fixture.session.documentValue(FIXTURE_IDS.config), [
      ...TERRAIN_ASSET,
      'levels',
    ]) as readonly string[];
    expect(levels[1]?.[1]).toBe('2');
    // Выделение при этом не тронуто: нажатие досталось кисти целиком.
    expect(fixture.frame.selection.get(SCENE_AREA_ID)).toEqual(before);
    expect(fixture.session.history().undo).toHaveLength(1);
  });

  it('наборы наложений складываются, а не вытесняют друг друга', async () => {
    const fixture = withCells(await buildLoadedFrame());
    const key = fixture.session.descriptors(FIXTURE_IDS.config, ['initial'])[0] ?? '';
    fixture.frame.selection.set(SCENE_AREA_ID, [key]);
    press(buttonByKey(view(fixture), 'ui.area.scene.toolTerrain'));
    fixture.pointer(at('move', 2, 2));
    view(fixture);

    const kinds = fixture.stage.overlays.map((item) => item.kind);
    expect(kinds).toContain('highlight');
    expect(kinds).toContain('grid');
    expect(kinds).toContain('cells');
  });

  it('возврат к указателю убирает наложения кисти и возвращает ей нажатия', async () => {
    const fixture = withCells(await buildLoadedFrame());
    press(buttonByKey(view(fixture), 'ui.area.scene.toolTerrain'));
    fixture.pointer(at('move', 2, 2));
    view(fixture);
    expect(fixture.stage.overlays.length).toBeGreaterThan(0);

    press(buttonByKey(view(fixture), 'ui.area.scene.toolPointer'));
    view(fixture);
    expect(fixture.stage.overlays).toEqual([]);
  });

  it('правка уровня кистью доходит до вьюпорта новыми обрывами (ED-15, TERR-5)', async () => {
    const fixture = withCells(await buildLoadedFrame());
    const before = fixture.stage.last?.grid?.cliffs.length ?? 0;
    press(buttonByKey(view(fixture), 'ui.area.scene.toolTerrain'));
    fixture.state.brush.setLevel(3);
    fixture.pointer(at('down', 1, 1));
    fixture.pointer(at('up', 1, 1));
    view(fixture);

    const cliffs = fixture.stage.last?.grid?.cliffs ?? [];
    expect(cliffs.length).toBeGreaterThan(before);
    // Обрывы вывело ядро: редактор отдал рендеру уже производную сетку (REND-14).
    expect(cliffs.some((edge) => edge.levelNeg === 3 || edge.levelPos === 3)).toBe(true);
  });
});

describe('ED-26: недоступное показано недоступным', () => {
  it('без открытого проекта кисти недоступны, а не молча не срабатывают', () => {
    const { frame } = buildFrame([sceneArea]);
    for (const key of ['ui.area.scene.toolTerrain', 'ui.area.scene.toolCurvature']) {
      expect(buttonByKey(frame.view(), key)?.attrs?.['aria-disabled'], key).toBe('true');
    }
  });

  it('с открытым проектом доступна та кисть, у которой есть карта', async () => {
    const fixture = await buildLoadedFrame();
    // У фикстуры карта кривизны есть — доступны обе кисти.
    for (const key of ['ui.area.scene.toolTerrain', 'ui.area.scene.toolCurvature']) {
      expect(buttonByKey(view(fixture), key)?.attrs?.['aria-disabled'], key).toBe('false');
    }
    // Настройки указателя гаснут, когда указатель не в руках.
    press(buttonByKey(view(fixture), 'ui.area.scene.toolTerrain'));
    expect(buttonByKey(view(fixture), 'ui.area.scene.toolSelect')?.attrs?.['aria-disabled']).toBe(
      'true',
    );
  });
});

describe('ED-11: несовпадение сеток видно сразу', () => {
  it('смена размеров террейна подсвечивает карту кривизны предупреждением', async () => {
    const fixture = await buildLoadedFrame();
    expect(fixture.state.draft?.mismatch).toBeNull();

    fixture.session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: [...TERRAIN_ASSET],
      value: {
        width: 3,
        height: 3,
        tileSize: 65536,
        levels: ['000', '000', '000'],
        flags: ['...', '...', '...'],
      },
    });
    await settle();

    // ASSET-7: рантайм переживает несовпадение игнором карты, поэтому это
    // предупреждение, а не ошибка, — но видно оно сразу (ED-11).
    expect(fixture.state.draft?.mismatch).toBe('4×4 ≠ 3×3');
    const marks = findAll(view(fixture), (node) => node.attrs?.['data-severity'] === 'warning');
    expect(marks).toHaveLength(1);
    // Карта не закрыта и не подменена: несовпадение — состояние, а не отказ.
    expect(fixture.session.isOpen(FIXTURE_CURVATURE_ID)).toBe(true);
  });
});
