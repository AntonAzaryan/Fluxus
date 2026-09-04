/**
 * Общее для тестов конвейера: чтение закоммиченных фикстур экспорта и
 * минимальная цель импорта.
 *
 * Blender здесь не вызывается ни в какой форме (BLND-7): фикстуры `.gltf`
 * написаны руками, `.glb` собирается из фикстуры прямо в тесте. Цель импорта —
 * схемы и prefabs, объявленные ЗДЕСЬ, а не прочитанные из `content/`: контент
 * правит геймдизайнер, и тест конвейера не должен краснеть от перетюненного
 * числа (CONT-4).
 */
import { readFileSync } from 'node:fs';
import type { ComponentSchema, PrefabDef } from '@fluxus/core';
import type { VisualManifest } from '@fluxus/assets';
import { parseGltf, type GltfDocument } from '../src/gltf.js';
import { normalizeDocument, type SourceObject } from '../src/normalize.js';
import type { SpatialLayerContext } from '../src/layer.js';

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function fixture(name: string): GltfDocument {
  return parseGltf(fixtureBytes(name));
}

export function objectsOf(name: string): readonly SourceObject[] {
  return normalizeDocument(fixture(name));
}

export function objectNamed(objects: readonly SourceObject[], name: string): SourceObject {
  const found = objects.find((object) => object.name === name);
  if (found === undefined) throw new Error(`фикстура не содержит объекта "${name}"`);
  return found;
}

export const COMPONENTS: readonly ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Facing', fields: { turns: 'fixed' } },
  { name: 'Player', fields: { slot: 'i32' } },
  { name: 'Locomotion', fields: { maxSpeed: 'fixed' } },
];

const PREFABS: readonly PrefabDef[] = [
  {
    name: 'Hero',
    components: {
      Position: { x: 0, y: 0 },
      Facing: { turns: 0 },
      Player: { slot: 0 },
      Locomotion: { maxSpeed: 0 },
    },
  },
  { name: 'Rock', components: { Position: { x: 0, y: 0 } } },
  /** Prefab без компонента позиции: цель проверки «компонент вне состава» (CMD-6). */
  { name: 'Marker', components: { Player: { slot: 0 } } },
];

/**
 * Манифест визуалов цели (ASSET-9). Запись есть у каждого prefab'а: пара
 * «prefab — запись манифеста» проверяется валидацией на общих основаниях
 * (ED-19), и цель импорта обязана быть согласованной ДО импорта — иначе тест
 * проверял бы, что чужое нарушение не мешает записи, а не то, что мешает своё.
 */
export const MANIFEST: VisualManifest = {
  entities: {
    Hero: { model: 'visuals/models/hero.gltf' },
    Rock: { model: 'visuals/models/rock.gltf' },
    Marker: { model: 'visuals/models/marker.gltf' },
  },
  decorations: {
    Statue: { model: 'visuals/models/statue.gltf' },
    // Вид настила моста: цель walkable-фикстур (BLND-3, PRES-2).
    Bridge: { model: 'visuals/models/bridge.gltf' },
  },
  // Адреса производных карт называет манифест (ASSET-7, ASSET-15): своей
  // конвенции имени у них нет, и импорт их не выдумывает (BLND-10, BLND-14).
  terrain: {
    curvatureMap: 'visuals/arena-curvature.json',
    paintMap: 'visuals/arena-paint.json',
  },
};

export function context(overrides: Partial<SpatialLayerContext> = {}): SpatialLayerContext {
  return {
    components: COMPONENTS,
    prefabs: PREFABS,
    visuals: MANIFEST,
    // Сетку цели подаёт тест, которому она нужна: сцена без ассета террейна —
    // законное состояние, и клеточные слои на ней отказывают (BLND-9).
    terrain: null,
    curvatureMap: MANIFEST.terrain?.curvatureMap ?? null,
    paintMap: MANIFEST.terrain?.paintMap ?? null,
    ...overrides,
  };
}

/** Сетка цели значением — то, что `contextOfValues` вынимает из конфига сцены. */
export const TARGET_TERRAIN = { width: 4, height: 4, tileSize: 65536 } as const;

/* Цель импорта: дерево контента из тех же схем и prefab'ов, что и контекст выше. */

export const SCENE_ID = 'scenes/duel.scene.json';
export const PRESENTATION_ID = 'scenes/duel.presentation.json';
export const SOURCE_ID = 'scenes/duel.gltf';
export const MANIFEST_ID = 'visuals/manifest.json';
export const CURVATURE_ID = 'visuals/arena-curvature.json';
export const PAINT_ID = 'visuals/arena-paint.json';

/**
 * Ассет террейна цели (TERR-2, TERR-3): сетка 4×4 по клетке в мировую единицу.
 * Карты — «до импорта»: плоский нулевой уровень без рамп и провалов, чтобы
 * приехавшие из источника карты были видны в диффе целиком.
 */
export const TERRAIN_ASSET: Record<string, unknown> = {
  width: 4,
  height: 4,
  tileSize: 65536,
  levels: ['0000', '0000', '0000', '0000'],
  flags: ['....', '....', '....', '....'],
};

/**
 * Конфиг сцены цели. Полей сверх производных здесь нарочно много: BLND-2
 * требует, чтобы импорт не тронул ни одного из них, и проверять это на
 * документе из одного `initial` было бы нечем.
 *
 * Ассет террейна — необязательный: сцена без него законна (TERR-4), и именно на
 * ней проверяется «источник без terrain-объекта ассета не трогает» (BLND-2).
 */
export function sceneDocument(
  initial: readonly unknown[] = [],
  terrain: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    capacity: 64,
    ...(terrain === null ? {} : { terrain: structuredClone(terrain) }),
    components: COMPONENTS.map((schema) => ({ name: schema.name, fields: { ...schema.fields } })),
    prefabs: PREFABS.map((def) => ({ name: def.name, components: structuredClone(def.components) })),
    systems: [
      {
        name: 'Drift',
        order: 10,
        query: { all: ['Position', 'Locomotion'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: { x: { getComponent: [{ var: 'e' }, 'Position', 'x'] } },
            },
          },
        ],
      },
    ],
    initial: [...initial],
  };
}

/** Парный presentation-документ цели (PRES-1, PRES-2). */
export function presentationDocument(decorations: readonly unknown[] = []): Record<string, unknown> {
  return { decorations: [...decorations] };
}

/** Манифест визуалов дерева (ASSET-9) — тот же, что подаётся контекстом. */
export function manifestDocument(): Record<string, unknown> {
  return structuredClone(MANIFEST) as unknown as Record<string, unknown>;
}

/** Документ карты кривизны (ASSET-7) — «до импорта»: сетка та же, смещений нет. */
export function curvatureDocument(
  rows: readonly (readonly number[])[] = ZERO_CURVATURE_ROWS,
): Record<string, unknown> {
  return { width: 4, height: 4, rows: rows.map((row) => [...row]) };
}

/** Узловые ряды без смещений для сетки 4×4: узлов 5×5. */
export const ZERO_CURVATURE_ROWS: readonly (readonly number[])[] = Object.freeze(
  Array.from({ length: 5 }, () => Object.freeze(new Array<number>(5).fill(0))),
);

/**
 * Дерево контента цели: сцена, парный документ, манифест и экспорт источника.
 * Источник — имя закоммиченной фикстуры либо готовые байты (grid-сетки строятся
 * в памяти, см. `gridGltf`).
 */
export function contentFiles(
  source: string | Uint8Array = 'placements.gltf',
  scene: Record<string, unknown> = sceneDocument(),
  presentation: Record<string, unknown> = presentationDocument(),
  extra: Record<string, string | Uint8Array> = {},
): Record<string, string | Uint8Array> {
  return {
    [SCENE_ID]: JSON.stringify(scene, null, 2),
    [PRESENTATION_ID]: JSON.stringify(presentation, null, 2),
    [MANIFEST_ID]: JSON.stringify(manifestDocument(), null, 2),
    [SOURCE_ID]: typeof source === 'string' ? fixtureBytes(source) : source,
    ...extra,
  };
}

/**
 * Контейнер `.glb` из фикстуры `.gltf` — так же, как его собрал бы экспортёр:
 * заголовок, JSON-чанк, бинарный чанк. Собирается в памяти, а не лежит в
 * дереве: бинарная фикстура нечитаема в ревью, а разбор контейнера пиннится и
 * так (постоянная фикстура `.glb` — задача 10.1).
 */
export function packGlb(json: unknown, binary?: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binaryBytes = binary ?? new Uint8Array(0);
  const binaryPadding = (4 - (binaryBytes.byteLength % 4)) % 4;
  const jsonChunk = jsonBytes.byteLength + jsonPadding;
  const binaryChunk = binaryBytes.byteLength + binaryPadding;
  const total = 12 + 8 + jsonChunk + (binary === undefined ? 0 : 8 + binaryChunk);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // Дополнение JSON-чанка — пробелы, бинарного — нули (правило формата).
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonChunk);
  if (binary !== undefined) {
    const at = 20 + jsonChunk;
    view.setUint32(at, binaryChunk, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(binaryBytes, at + 8);
  }
  return out;
}

/* -------------------------------------------------- grid-фикстуры (BLND-9, BLND-10) */

/**
 * Сетка клеточных данных так, как её экспортирует Blender: отдельный
 * четырёхугольник на клетку (`grids.py` аддона), триангулированный экспортёром,
 * с целочисленными каналами `_RAMP`/`_NOFLOOR` на вершинах.
 *
 * Строится в памяти из ЧИТАЕМЫХ карт — рядов алфавитов TERR-3 и ASSET-7, — а не
 * лежит закоммиченным блобом: base64 бинарного чанка в ревью нечитаем, и
 * фикстура из него доказывала бы меньше, чем строка `'0011'` рядом с
 * ожиданием. Тот же довод, по которому `.glb` собирается `packGlb`.
 *
 * Пространство координат — glTF после экспорта «+Y Up»: клетка `(x, y)` лежит в
 * `[x·cell, (x+1)·cell] × [y·cell, (y+1)·cell]` мировых координат, то есть в
 * glTF `z` от `−y·cell` до `−(y+1)·cell`, а высота уезжает в glTF `+y`.
 */
export interface GridObjectSpec {
  /** Имя объекта Blender — адрес в находках (BLND-6). */
  readonly name: string;
  readonly semantic: 'terrain' | 'curvature';
  /**
   * Высоты в мировых единицах. У terrain-объекта — по клеткам (грань плоская,
   * BLND-9); у curvature-объекта — по УЗЛАМ, рядов `height+1` длины `width+1`:
   * скульпт свободен, значение несёт вершина (BLND-10).
   */
  readonly heights: readonly (readonly number[])[];
  /** Значения канала `_RAMP` по клеткам; нет — канала в экспорте нет вовсе. */
  readonly ramp?: readonly (readonly number[])[];
  readonly noFloor?: readonly (readonly number[])[];
  /** Размер клетки в мировых единицах; нет — единица (`tileSize` 65536). */
  readonly cellSize?: number;
  /** Разрез квада по второй диагонали — экспортёр вправе выбрать любую. */
  readonly flipDiagonal?: boolean;
  /** Слоты раскраски по клеткам (BLND-14); нет — канала `_PAINT` в экспорте нет. */
  readonly paint?: readonly (readonly number[])[];
}

/** Карта уровней (TERR-3) → высоты клеток: один уровень — одна мировая единица. */
export function levelHeights(rows: readonly string[]): number[][] {
  return rows.map((row) => Array.from(row, (char) => parseInt(char, 16)));
}

/** Ряды карты раскраски (ASSET-15) → значения канала: цифра — индекс слота. */
export function paintCells(rows: readonly string[]): number[][] {
  return rows.map((row) => Array.from(row, (cell) => Number.parseInt(cell, 10)));
}

/** Ряды карты флагов (TERR-3) → значения канала: символ совпал — единица. */
export function flagCells(rows: readonly string[], char: string): number[][] {
  return rows.map((row) => Array.from(row, (cell) => (cell === char ? 1 : 0)));
}

/** Узловые ряды карты кривизны (ASSET-7) → высоты узлов: множитель 1/32 шага. */
export function curvatureHeights(rows: readonly (readonly number[])[]): number[][] {
  return rows.map((row) => row.map((offset) => offset / 32));
}

interface Chunk {
  readonly bytes: Uint8Array;
  readonly accessor: Record<string, unknown>;
  readonly view: Record<string, unknown>;
}

function floatChunk(values: readonly number[], components: number): Chunk {
  const array = Float32Array.from(values);
  return {
    bytes: new Uint8Array(array.buffer),
    accessor: { componentType: 5126, count: values.length / components, type: components === 3 ? 'VEC3' : 'SCALAR' },
    view: { byteLength: array.byteLength },
  };
}

function indexChunk(values: readonly number[]): Chunk {
  const array = Uint32Array.from(values);
  return {
    bytes: new Uint8Array(array.buffer),
    accessor: { componentType: 5125, count: values.length, type: 'SCALAR' },
    view: { byteLength: array.byteLength },
  };
}

/** Документ glTF с grid-объектами и их бинарным чанком. */
export function gridSource(specs: readonly GridObjectSpec[]): {
  json: Record<string, unknown>;
  binary: Uint8Array;
} {
  const nodes: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const views: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (chunk: Chunk): number => {
    views.push({ buffer: 0, byteOffset: offset, ...chunk.view });
    accessors.push({ bufferView: views.length - 1, ...chunk.accessor });
    chunks.push(chunk.bytes);
    // Выравнивание по четырём байтам — требование формата к смещениям вида.
    offset += chunk.bytes.byteLength + ((4 - (chunk.bytes.byteLength % 4)) % 4);
    return accessors.length - 1;
  };

  for (const spec of specs) {
    const cell = spec.cellSize ?? 1;
    // Curvature-объект задан узлами: клеток на ряд меньше на одну (BLND-10).
    const byNodes = spec.semantic === 'curvature';
    const height = byNodes ? spec.heights.length - 1 : spec.heights.length;
    const width = byNodes ? (spec.heights[0]?.length ?? 1) - 1 : (spec.heights[0]?.length ?? 0);
    const positions: number[] = [];
    const indices: number[] = [];
    const ramp: number[] = [];
    const noFloor: number[] = [];
    const paint: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const z = spec.heights[y]![x]!;
        const z00 = byNodes ? spec.heights[y]![x]! : z;
        const z10 = byNodes ? spec.heights[y]![x + 1]! : z;
        const z11 = byNodes ? spec.heights[y + 1]![x + 1]! : z;
        const z01 = byNodes ? spec.heights[y + 1]![x]! : z;
        const x0 = x * cell;
        const x1 = (x + 1) * cell;
        const y0 = -y * cell;
        const y1 = -(y + 1) * cell;
        const base = positions.length / 3;
        // Четыре угла клетки в порядке аддона; вертикаль мира — glTF `+y`.
        positions.push(x0, z00, y0, x1, z10, y0, x1, z11, y1, x0, z01, y1);
        indices.push(
          ...(spec.flipDiagonal === true
            ? [base, base + 1, base + 3, base + 1, base + 2, base + 3]
            : [base, base + 1, base + 2, base, base + 2, base + 3]),
        );
        for (let corner = 0; corner < 4; corner++) {
          ramp.push(spec.ramp?.[y]?.[x] ?? 0);
          noFloor.push(spec.noFloor?.[y]?.[x] ?? 0);
          paint.push(spec.paint?.[y]?.[x] ?? 0);
        }
      }
    }

    const attributes: Record<string, number> = { POSITION: push(floatChunk(positions, 3)) };
    if (spec.ramp !== undefined) attributes._RAMP = push(floatChunk(ramp, 1));
    if (spec.noFloor !== undefined) attributes._NOFLOOR = push(floatChunk(noFloor, 1));
    if (spec.paint !== undefined) attributes._PAINT = push(floatChunk(paint, 1));
    const primitive = { attributes, indices: push(indexChunk(indices)), mode: 4 };
    meshes.push({ name: `${spec.name}-mesh`, primitives: [primitive] });
    nodes.push({ name: spec.name, mesh: meshes.length - 1, extras: { [spec.semantic]: 1 } });
  }

  const binary = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    binary.set(chunk, at);
    at += chunk.byteLength + ((4 - (chunk.byteLength % 4)) % 4);
  }
  return {
    json: {
      asset: { version: '2.0', generator: 'фикстура конвейера, собранная тестом (BLND-7)' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, index) => index) }],
      nodes,
      meshes,
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: binary.byteLength }],
    },
    binary,
  };
}

/** Контейнер `.glb`: клеточные данные приезжают бинарным чанком (задача 4.2). */
export function gridGlb(specs: readonly GridObjectSpec[]): Uint8Array {
  const source = gridSource(specs);
  return packGlb(source.json, source.binary);
}

/** Текстовая форма того же источника: буфер уезжает `data:`-URI. */
export function gridGltf(specs: readonly GridObjectSpec[]): Uint8Array {
  const source = gridSource(specs);
  const base64 = Buffer.from(source.binary).toString('base64');
  const json = {
    ...source.json,
    buffers: [{ byteLength: source.binary.byteLength, uri: `data:application/octet-stream;base64,${base64}` }],
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

/** Карты, которые даёт `TERRAIN_GRID`: плато с рампой и провалом в углу. */
export const TERRAIN_LEVELS: readonly string[] = ['0000', '0000', '1111', '1111'];
export const TERRAIN_FLAGS: readonly string[] = ['_...', '_^^.', '....', '....'];

/** Grid-объект террейна, дающий карты выше. */
export const TERRAIN_GRID: GridObjectSpec = {
  name: 'terrain',
  semantic: 'terrain',
  heights: levelHeights(TERRAIN_LEVELS),
  ramp: flagCells(TERRAIN_FLAGS, '^'),
  noFloor: flagCells(TERRAIN_FLAGS, '_'),
};

/** Узловые ряды, которые даёт `CURVATURE_GRID`: амплитуда и сверх шага (40 > 32). */
export const CURVATURE_ROWS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 40],
  [-1, -2, -3, 0, 0],
  [14, -14, 0, 0, 0],
  [0, 0, 0, 0, -33],
  [0, 0, 0, 0, 0],
];

export const CURVATURE_GRID: GridObjectSpec = {
  name: 'curvature',
  semantic: 'curvature',
  heights: curvatureHeights(CURVATURE_ROWS),
};

/* -------------------------------------------------- sculpt-фикстуры (BLND-13, BLND-14) */

/** Треугольник в мировых величинах: [x, y, elevation] на вершину. */
export type WorldTriangle = readonly (readonly [number, number, number])[];

/** Значения канала раскраски у трёх вершин одной грани. */
type FacePaint = readonly [number, number, number];

export interface SculptNodeSpec {
  /** Имя объекта Blender — адрес находок (BLND-6) и порядок сборки (BLND-4). */
  readonly name: string;
  readonly triangles: readonly WorldTriangle[];
  /**
   * Канал раскраски объекта (BLND-14). Число — один слот всем вершинам всех
   * граней: это модель «объект — слот», которой красит кисть аддона. Список
   * троек — значения ВЕРШИН каждой грани по порядку: ими пишется расхождение,
   * которого мазком кисти не получить. Свойства нет — канала в экспорте нет
   * вовсе, и раскраски объект не несёт.
   */
  readonly paint?: number | readonly FacePaint[];
  readonly extras?: Record<string, unknown>;
}

/** Горизонтальная пластина [x0..x1]×[y0..y1] на высоте `h` — два треугольника. */
export function plate(x0: number, y0: number, x1: number, y1: number, h: number): WorldTriangle[] {
  return [
    [
      [x0, y0, h],
      [x1, y0, h],
      [x1, y1, h],
    ],
    [
      [x0, y0, h],
      [x1, y1, h],
      [x0, y1, h],
    ],
  ];
}

/** Блок: крышка на `top`, дно на `bottom` и четыре вертикальные стенки. */
export function box(x0: number, y0: number, x1: number, y1: number, bottom: number, top: number): WorldTriangle[] {
  const wall = (ax: number, ay: number, bx: number, by: number): WorldTriangle[] => [
    [
      [ax, ay, bottom],
      [bx, by, bottom],
      [bx, by, top],
    ],
    [
      [ax, ay, bottom],
      [bx, by, top],
      [ax, ay, top],
    ],
  ];
  return [
    ...plate(x0, y0, x1, y1, top),
    ...plate(x0, y0, x1, y1, bottom),
    ...wall(x0, y0, x1, y0),
    ...wall(x1, y0, x1, y1),
    ...wall(x1, y1, x0, y1),
    ...wall(x0, y1, x0, y0),
  ];
}

/** Наклонная пластина: высота — линейная функция `h(x, y) = base + gx·x + gy·y`. */
export function slope(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  base: number,
  gx: number,
  gy: number,
): WorldTriangle[] {
  const at = (x: number, y: number): readonly [number, number, number] => [x, y, base + gx * x + gy * y];
  return [
    [at(x0, y0), at(x1, y0), at(x1, y1)],
    [at(x0, y0), at(x1, y1), at(x0, y1)],
  ];
}

/** Плита `size × size` клеток с вырезанной клеткой — дыра как инструмент (BLND-13). */
export function plateauWithHole(size: number, height: number, holeX: number, holeY: number): WorldTriangle[] {
  const cells: WorldTriangle[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === holeX && y === holeY) continue;
      cells.push(...plate(x, y, x + 1, y + 1, height));
    }
  }
  return cells;
}

/** Значения канала по вершинам объекта: по три на грань в порядке треугольников. */
function paintValuesOf(spec: SculptNodeSpec): number[] | null {
  const paint = spec.paint;
  if (paint === undefined) return null;
  const values: number[] = [];
  for (let face = 0; face < spec.triangles.length; face++) {
    const triple = typeof paint === 'number' ? ([paint, paint, paint] as FacePaint) : paint[face];
    if (triple === undefined) throw new Error(`фикстура: у грани ${face} объекта "${spec.name}" нет значений канала`);
    values.push(triple[0], triple[1], triple[2]);
  }
  return values;
}

/**
 * `.glb` из sculpt-объектов: мировые `(x, y, elevation)` пакуются в glTF как
 * `(x, elevation, −y)` — то же соответствие осей, что читает `worldPoint`.
 *
 * Вершины не сварены (по три на грань), поэтому значение канала раскраски
 * принадлежит ГРАНИ — так же, как у клеточной сетки аддона оно принадлежит
 * клетке; расхождение вершин задаётся тройкой явно.
 */
export function sculptGlb(nodes: readonly SculptNodeSpec[]): Uint8Array {
  const buffers: Uint8Array[] = [];
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const meshes: unknown[] = [];
  const gltfNodes: unknown[] = [];
  let byteOffset = 0;

  const pushBuffer = (bytes: Uint8Array): number => {
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength });
    byteOffset += bytes.byteLength;
    buffers.push(bytes);
    return bufferViews.length - 1;
  };

  for (const node of nodes) {
    if (node.triangles.length === 0) {
      // Узел без геометрии — empty Blender с семантикой (цель проверки BLND-13).
      gltfNodes.push({ name: node.name, extras: node.extras ?? { sculpt: 1 } });
      continue;
    }
    const positions: number[] = [];
    const indices: number[] = [];
    for (const triangle of node.triangles) {
      for (const [x, y, elevation] of triangle) {
        indices.push(positions.length / 3);
        positions.push(x, elevation, -y);
      }
    }
    const positionView = pushBuffer(new Uint8Array(Float32Array.from(positions).buffer));
    const indexView = pushBuffer(new Uint8Array(Uint32Array.from(indices).buffer));
    const attributes: Record<string, number> = { POSITION: accessors.length };
    accessors.push({ bufferView: positionView, componentType: 5126, count: positions.length / 3, type: 'VEC3' });
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, componentType: 5125, count: indices.length, type: 'SCALAR' });
    const paint = paintValuesOf(node);
    if (paint !== null) {
      const paintView = pushBuffer(new Uint8Array(Float32Array.from(paint).buffer));
      attributes._PAINT = accessors.length;
      accessors.push({ bufferView: paintView, componentType: 5126, count: paint.length, type: 'SCALAR' });
    }
    const mesh = meshes.length;
    meshes.push({ primitives: [{ attributes, indices: indexAccessor, mode: 4 }] });
    gltfNodes.push({ name: node.name, mesh, extras: node.extras ?? { sculpt: 1 } });
  }

  const binary = new Uint8Array(byteOffset);
  let cursor = 0;
  for (const bytes of buffers) {
    binary.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  const json = {
    asset: { version: '2.0', generator: 'фикстура конвейера, собранная перечнем (BLND-7)' },
    scene: 0,
    scenes: [{ nodes: gltfNodes.map((_, index) => index) }],
    nodes: gltfNodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  return packGlb(json, binary);
}
