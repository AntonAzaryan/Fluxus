/**
 * Операции кистей (ED-10, ED-11) как слой операций авторинга (ED-29):
 * проверяется то, что уезжает в документ, и то, что ядро из него потом читает.
 *
 * Документ здесь — черновой проект в памяти, а не сцена репозитория: её карты
 * задают `worldInit`, и правка их тестом была бы правкой контента (CONT-1).
 *
 * Главные инварианты, которые здесь пиннятся:
 *
 * - записанное редактором ядро читает обратно тем же (TERR-3, ASSET-7): круг
 *   замыкают `createTerrainGrid` и `validateCurvatureMap`, а не сравнение двух
 *   таблиц алфавита на глаз;
 * - cliff-геометрия производна и отдельного слоя не имеет (TERR-5): она
 *   меняется от правки карты уровней, а операции, которая писала бы её, в
 *   наборе нет;
 * - карта кривизны и sim-ассет — разные слои (ED-11): мазок кривизны не
 *   меняет конфиг сцены ни на байт;
 * - непрерывный мазок — одна запись истории (ED-18).
 */
import { FIXED_ONE, createTerrainGrid, loadScene, type SceneDef, type TerrainDef } from '@game-mvp/core';
import { validateCurvatureMap } from '@game-mvp/assets';
import {
  getAtPath,
  runOperationRoundTrip,
  type EditorSession,
  type JsonValue,
} from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { sceneDraft } from '../src/areas/sceneDocuments.js';
import { TERRAIN_ASSET } from '../src/areas/sceneProject.js';
import {
  CURVATURE_OFFSETS,
  MAX_LEVEL,
  TERRAIN_AUTHORING_OPERATIONS,
  TERRAIN_OPERATIONS,
} from '../src/areas/sceneTerrain.js';
import { PAINT_IDS, PAINT_SIDE, bytesOf, paintSession } from './support/paint.js';

const terrainOf = (session: EditorSession): TerrainDef =>
  getAtPath(session.documentValue(PAINT_IDS.config), TERRAIN_ASSET) as unknown as TerrainDef;

const gridOf = (session: EditorSession) => createTerrainGrid(terrainOf(session));

const draftOf = (session: EditorSession) =>
  sceneDraft({
    config: session.documentValue(PAINT_IDS.config),
    curvature: session.documentValue(PAINT_IDS.curvature),
  });

const setLevel = (session: EditorSession, x: number, y: number, level: number): void => {
  session.applyOperation(TERRAIN_OPERATIONS.level, {
    document: PAINT_IDS.config,
    path: [...TERRAIN_ASSET],
    cellX: x,
    cellY: y,
    level,
  });
};

const setKind = (session: EditorSession, x: number, y: number, kind: string): void => {
  session.applyOperation(TERRAIN_OPERATIONS.cell, {
    document: PAINT_IDS.config,
    path: [...TERRAIN_ASSET],
    cellX: x,
    cellY: y,
    kind,
  });
};

const setOffset = (session: EditorSession, x: number, y: number, offset: number): void => {
  session.applyOperation(TERRAIN_OPERATIONS.curvature, {
    document: PAINT_IDS.curvature,
    cellX: x,
    cellY: y,
    offset,
  });
};

/** Центр клетки в мировых единицах: `tileSize` чернового проекта — единица. */
const centre = (cell: number): number => (cell + 0.5) * FIXED_ONE;

describe('ED-10, TERR-3: кисть уровня пишет валидный ассет террейна', () => {
  it('записанный уровень ядро читает обратно тем же — весь диапазон', () => {
    const session = paintSession();
    for (const level of Array.from({ length: MAX_LEVEL + 1 }, (_unused, value) => value)) {
      setLevel(session, 1, 1, level);
      // Круг замыкает ядро: разбор карты — его, и алфавит редактора проверяется
      // им, а не совпадением двух таблиц (ED-1).
      expect(gridOf(session).levels[1 * PAINT_SIDE + 1]).toBe(level);
    }
  });

  it('уровень вне диапазона отвергает запись, а не разбор записанного', () => {
    // TERR-3: «значение вне диапазона… MUST NOT возникать в результате
    // программной мутации» — то есть отказать обязана сама операция.
    const session = paintSession();
    const before = bytesOf(session, PAINT_IDS.config);
    expect(() => {
      setLevel(session, 0, 0, MAX_LEVEL + 1);
    }).toThrow(/TERR-3/);
    expect(() => {
      setLevel(session, 0, 0, -1);
    }).toThrow(/TERR-3/);
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
  });

  it('клетка вне карты отвергается, а карта не достраивается', () => {
    const session = paintSession();
    const before = bytesOf(session, PAINT_IDS.config);
    expect(() => {
      setLevel(session, PAINT_SIDE, 0, 1);
    }).toThrow(/клеток в ряду/);
    expect(() => {
      setLevel(session, 0, PAINT_SIDE, 1);
    }).toThrow(/рядов в карте/);
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
  });

  it('правка одной клетки трогает один ряд карты, а не всю карту', () => {
    // ED-21: правка одного значения меняет только связанные строки файла.
    const session = paintSession();
    const before = terrainOf(session).levels;
    setLevel(session, 3, 2, 4);
    const after = terrainOf(session).levels;
    expect(after[2]).toBe('00040000');
    for (let row = 0; row < PAINT_SIDE; row++) {
      if (row === 2) continue;
      expect(after[row], `ряд ${row}`).toBe(before[row]);
    }
  });
});

describe('ED-10: рампа и пол — вид клетки, а не второй слой', () => {
  it('снятый пол делает клетку клеткой без пола в начальном состоянии арены', () => {
    const session = paintSession();
    const levels = terrainOf(session).levels;
    setKind(session, 4, 4, 'noFloor');

    // Начальное состояние арены поднимает ядро (SER-7, TERR-6): пол живёт
    // компонентом на носителе террейна, и спрашивается он у ядра.
    const scene = loadScene(session.documentValue(PAINT_IDS.config) as unknown as SceneDef);
    expect(scene.terrain?.hasFloorAt({ x: centre(4), y: centre(4) })).toBe(false);
    expect(scene.terrain?.hasFloorAt({ x: centre(3), y: centre(4) })).toBe(true);
    // Уровни вокруг не изменились: карты уровней эта операция не касается.
    expect(terrainOf(session).levels).toEqual(levels);
  });

  it('пол возвращается той же операцией другим видом клетки', () => {
    const session = paintSession();
    setKind(session, 4, 4, 'noFloor');
    setKind(session, 4, 4, 'plain');
    const scene = loadScene(session.documentValue(PAINT_IDS.config) as unknown as SceneDef);
    expect(scene.terrain?.hasFloorAt({ x: centre(4), y: centre(4) })).toBe(true);
  });

  it('рампа в одну клетку подсвечивается сразу, а не при загрузке в ядро', () => {
    // ED-10, TERR-7. Проверяет это тот же вызов ядра, которым террейн поднимает
    // сцена: своей копии правила у редактора нет (ED-1).
    const session = paintSession();
    setKind(session, 2, 2, 'ramp');
    expect(draftOf(session).failure).toMatch(/TERR-7/);

    // Соседняя клетка того же уровня делает переход шире одной клетки.
    setKind(session, 3, 2, 'ramp');
    expect(draftOf(session).failure).toBeNull();
  });

  it('неизвестный вид клетки отвергается: набор флагов закрыт', () => {
    const session = paintSession();
    expect(() => {
      setKind(session, 0, 0, 'hole');
    }).toThrow(/TERR-3/);
  });
});

describe('TERR-5, ED-10: cliff-геометрия производна и напрямую не правится', () => {
  it('правка карты уровней даёт новые обрывы, и выводит их ядро', () => {
    const session = paintSession();
    expect(draftOf(session).grid?.cliffs).toEqual([]);

    setLevel(session, 4, 4, 1);
    const cliffs = draftOf(session).grid?.cliffs ?? [];
    // Четыре стороны поднятой клетки — четыре непроходимые границы, и каждая
    // несёт уровни обеих своих сторон (TERR-5).
    expect(cliffs).toHaveLength(4);
    expect(cliffs.every((edge) => Math.abs(edge.levelPos - edge.levelNeg) === 1)).toBe(true);
    // В документе обрывов нет и не появилось: их источник — карта уровней.
    expect(JSON.stringify(terrainOf(session))).not.toContain('cliff');
  });

  it('операции, которая писала бы обрыв, в наборе нет вовсе', () => {
    // Отсутствие такой операции — не пробел интерфейса, а выполнение ED-10:
    // в машинном каталоге (ED-30) её нет, значит нет и второго пути.
    expect(TERRAIN_AUTHORING_OPERATIONS.map((operation) => operation.id)).toEqual([
      TERRAIN_OPERATIONS.level,
      TERRAIN_OPERATIONS.cell,
      TERRAIN_OPERATIONS.curvature,
    ]);
    for (const operation of TERRAIN_AUTHORING_OPERATIONS) {
      expect(Object.keys(operation.params)).not.toContain('cliffs');
    }
  });
});

describe('ED-11, ASSET-7: карта кривизны — отдельный слой данных', () => {
  it('смещения round-trip через алфавит карты: их читает модуль ассетов', () => {
    const session = paintSession();
    for (const offset of CURVATURE_OFFSETS) {
      setOffset(session, 2, 3, offset);
      const checked = validateCurvatureMap(session.documentValue(PAINT_IDS.curvature));
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.map.offsets[3 * PAINT_SIDE + 2]).toBe(offset);
    }
  });

  it('смещение вне алфавита невыразимо и отвергается записью', () => {
    const session = paintSession();
    const before = bytesOf(session, PAINT_IDS.curvature);
    expect(() => {
      setOffset(session, 0, 0, 8);
    }).toThrow(/ASSET-7/);
    expect(bytesOf(session, PAINT_IDS.curvature)).toBe(before);
  });

  it('никакой путь не даёт операции кривизны попасть в карты террейна', () => {
    // ED-11 «MUST NOT затрагивать sim-ассет террейна» держится структурно, а не
    // дисциплиной: имя правимой карты в операции — литерал, и свободы у
    // вызывающего ровно две — документ и путь до ассета. Проверяется это на
    // конфиге сцены: карт с именем карты кривизны в нём нет ни по одному пути.
    const session = paintSession();
    const before = bytesOf(session, PAINT_IDS.config);
    for (const path of [[], ['terrain'], ['terrain', 'levels'], ['terrain', 'flags']]) {
      expect(() => {
        session.applyOperation(TERRAIN_OPERATIONS.curvature, {
          document: PAINT_IDS.config,
          path,
          cellX: 1,
          cellY: 1,
          offset: 3,
        });
      }, JSON.stringify(path)).toThrow();
    }
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);

    // И обратно: карте кривизны нечем стать картой уровней.
    const curvature = bytesOf(session, PAINT_IDS.curvature);
    expect(() => {
      setLevel(session, 1, 1, 1);
    }).not.toThrow();
    expect(() => {
      session.applyOperation(TERRAIN_OPERATIONS.level, {
        document: PAINT_IDS.curvature,
        cellX: 1,
        cellY: 1,
        level: 1,
      });
    }).toThrow();
    expect(bytesOf(session, PAINT_IDS.curvature)).toBe(curvature);
  });

  it('мазок кривизны не меняет sim-ассет террейна ни на байт', () => {
    const session = paintSession();
    // Клетки с рампой и обрывом — тот самый случай ED-11: кривизна поверх них
    // не двигает ни уровни, ни флаги, ни производные обрывы.
    setLevel(session, 5, 5, 1);
    setKind(session, 2, 2, 'ramp');
    setKind(session, 3, 2, 'ramp');
    const before = bytesOf(session, PAINT_IDS.config);
    const cliffs = draftOf(session).grid?.cliffs;

    const stroke = session.beginOperation(TERRAIN_OPERATIONS.curvature, {
      document: PAINT_IDS.curvature,
      cellX: 2,
      cellY: 2,
      offset: 3,
    });
    for (const cell of [5, 6, 7]) {
      stroke.extend({ document: PAINT_IDS.curvature, cellX: cell, cellY: 5, offset: 3 });
    }
    stroke.commit();

    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    // Cliff-геометрия не пересчитывалась — её и пересчитывать было не от чего.
    expect(draftOf(session).grid?.cliffs).toEqual(cliffs);
    expect(bytesOf(session, PAINT_IDS.curvature)).not.toBe(JSON.stringify({}));
  });
});

describe('ED-18: непрерывный мазок — одна запись истории', () => {
  it('мазок в двадцать клеток отменяется одним шагом', () => {
    const session = paintSession();
    const before = bytesOf(session, PAINT_IDS.config);
    const cells = Array.from({ length: 20 }, (_unused, index) => ({
      x: index % PAINT_SIDE,
      y: Math.floor(index / PAINT_SIDE),
    }));

    const first = cells[0]!;
    const stroke = session.beginOperation(TERRAIN_OPERATIONS.level, {
      document: PAINT_IDS.config,
      path: [...TERRAIN_ASSET],
      cellX: first.x,
      cellY: first.y,
      level: 2,
    });
    for (const cell of cells.slice(1)) {
      stroke.extend({
        document: PAINT_IDS.config,
        path: [...TERRAIN_ASSET],
        cellX: cell.x,
        cellY: cell.y,
        level: 2,
      });
    }
    stroke.commit();

    const grid = gridOf(session);
    for (const cell of cells) expect(grid.levels[cell.y * PAINT_SIDE + cell.x]).toBe(2);
    expect(session.history().undo).toHaveLength(1);

    session.undo();
    // Прежним считается состояние ДО нажатия, а не предпоследняя клетка мазка.
    expect(bytesOf(session, PAINT_IDS.config)).toBe(before);
    expect(session.canUndo()).toBe(false);
  });
});

describe('ED-29: каждая операция кисти обратима', () => {
  it.each([
    [TERRAIN_OPERATIONS.level, PAINT_IDS.config, { path: [...TERRAIN_ASSET], level: 3 }],
    [TERRAIN_OPERATIONS.cell, PAINT_IDS.config, { path: [...TERRAIN_ASSET], kind: 'noFloor' }],
    [TERRAIN_OPERATIONS.curvature, PAINT_IDS.curvature, { offset: -4 }],
  ])('«применить, отменить, сравнить» проходит для %s', (operationId, document, params) => {
    const session = paintSession();
    const result = runOperationRoundTrip(session, operationId, {
      document,
      cellX: 1,
      cellY: 1,
      ...(params as Record<string, JsonValue>),
    });
    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });
});
