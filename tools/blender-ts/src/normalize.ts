/**
 * Нормализация разобранного glTF в объекты источника: трансформ приводится к
 * мировым величинам конвейера, `extras` — к типам, с которыми работает
 * генерация слоя.
 *
 * ## Соответствие координат
 *
 * Конвенции зафиксированы в `CONVENTIONS.md` и в фикстурном тесте (design,
 * решение 5): экспорт «+Y Up», 1 юнит Blender = 1 мировая единица, мировые
 * `(x, y)` — это glTF `(x, −z)`, вертикаль мира — glTF `+y`. У размещений
 * вертикаль отбрасывается: симуляция двумерна, а `decorations` вертикали не
 * знают вовсе (PRES-2). Смена любого знака здесь — смена формата конвейера
 * (BLND-3), поэтому знаки живут одним выражением и пиннятся тестом.
 *
 * `yaw` — поворот вокруг мировой вертикали в долях оборота, в единице ЯДРА
 * (`fixed.sin` принимает долю оборота) и документа (PRES-2), а не в радианах.
 * Берётся он из направления локальной оси X объекта: `atan2(−m₂, m₀)` по первому
 * столбцу мировой матрицы. Через столбец, а не через компоненты кватерниона,
 * потому что трансформ приходит двумя формами, и матрица — общий знаменатель
 * обеих.
 *
 * ## Почему считается мировой трансформ, а не локальный
 *
 * Конвенция требует применённых трансформов (`CONVENTIONS.md`), но родительство
 * объектов Blender сохраняет и экспортирует деревом узлов. Узел, лежащий под
 * родителем, обязан дать ту же позицию, что и без родителя, — иначе группировка
 * объектов в аутлайнере молча двигала бы записи. Поэтому матрицы узлов на пути
 * от корня перемножаются.
 *
 * ## Коэрция `extras`
 *
 * Custom properties Blender приезжают разными типами JSON: целое, дробное,
 * строка, булево, а массивы свойств — списком из одного элемента. Модуль
 * приводит это к скаляру и не решает, законно ли значение: «строка там, где
 * нужно число» — вопрос генерации слоя, которая знает схему компонента и умеет
 * назвать объект в отказе (BLND-6).
 */
import {
  nodesOf,
  rootNodesOf,
  type GltfDocument,
  type GltfJsonValue,
  type GltfNode,
} from './gltf.js';

/**
 * Семантика объекта источника (BLND-3). Задаётся custom property, а не именем
 * объекта: имя — ключ порядка записей (BLND-4), и нагружать его вторым смыслом
 * значило бы связать порядок с семантикой.
 */
export const SEMANTIC_KEYS = ['prefab', 'visual', 'terrain', 'curvature'] as const;

export type SemanticKind = (typeof SEMANTIC_KEYS)[number];

/** Custom property скина decoration (PRES-2). Семантикой объекта не является. */
export const SKIN_KEY = 'skin';

/** Полный оборот в радианах: `yaw` конвейера — доля оборота, `atan2` — радианы. */
const TURN_RADIANS = Math.PI * 2;

/**
 * Порог, ниже которого разница масштабов по осям считается шумом float'а
 * экспорта. Совпадает с шагом квантования presentation-величин (PRES-3): всё,
 * что мельче шага, в документ всё равно не попадёт, и предупреждать о нём
 * значило бы шуметь на каждом объекте.
 */
const SCALE_TOLERANCE = 1e-3;

/** Объект источника — узел glTF, приведённый к величинам конвейера. */
export interface SourceObject {
  /** Имя объекта Blender: адрес в отказах (BLND-6) и ключ порядка записей (BLND-4). */
  readonly name: string;
  /** Индекс узла в документе — адрес на случай узла без имени. */
  readonly node: number;
  /** Найденная семантика; пусто — вспомогательный объект, две и более — отказ (BLND-3). */
  readonly semantics: readonly SemanticKind[];
  /** Значение семантического свойства: имя prefab'а либо ключ манифеста. */
  readonly semanticValue: string;
  /** Позиция в мировых единицах. */
  readonly x: number;
  readonly y: number;
  /** Вертикаль мира (glTF `+y`). Размещения её отбрасывают, террейн — читает. */
  readonly elevation: number;
  /** Курс долей оборота в `[0, 1)`. */
  readonly yaw: number;
  /** Множитель масштаба; при неравных осях — по оси X. */
  readonly scale: number;
  /** Равны ли масштабы по осям с точностью до шага PRES-3. */
  readonly uniformScale: boolean;
  /** Зеркален ли трансформ (отрицательный определитель); формат зеркала не знает. */
  readonly mirrored: boolean;
  /** Скалярные custom properties объекта после коэрции; несвёрнутое отброшено. */
  readonly extras: Readonly<Record<string, string | number | boolean>>;
  /** Меш узла — сырьё клеточных данных (BLND-9, BLND-10); `null` — узел без геометрии. */
  readonly mesh: number | null;
  /**
   * Мировая матрица узла 4×4 по столбцам. Разложение (`x`, `yaw`, …) отвечает
   * на вопрос о САМОМ объекте, а клеточным данным нужны его ВЕРШИНЫ (BLND-9,
   * BLND-10) — их и переводит в мир эта матрица через `worldPoint`.
   */
  readonly world: readonly number[];
}

/** Точка в величинах конвейера: те же оси, что у разложения трансформа. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
  /** Вертикаль мира (glTF `+y`): высота клетки террейна и смещение кривизны. */
  readonly elevation: number;
}

/**
 * Точка меша в мировых величинах. Знаки соответствия осей — те же и отсюда же,
 * что у `decompose`: второе их написание в модуле клеточных данных разошлось бы
 * с первым при первой же правке конвенции (BLND-3).
 */
export function worldPoint(matrix: readonly number[], point: readonly number[]): WorldPoint {
  const px = point[0] ?? 0;
  const py = point[1] ?? 0;
  const pz = point[2] ?? 0;
  const gx = (matrix[0] ?? 0) * px + (matrix[4] ?? 0) * py + (matrix[8] ?? 0) * pz + (matrix[12] ?? 0);
  const gy = (matrix[1] ?? 0) * px + (matrix[5] ?? 0) * py + (matrix[9] ?? 0) * pz + (matrix[13] ?? 0);
  const gz = (matrix[2] ?? 0) * px + (matrix[6] ?? 0) * py + (matrix[10] ?? 0) * pz + (matrix[14] ?? 0);
  return { x: gx, y: -gz, elevation: gy };
}

/** Единичная матрица 4×4 по столбцам — нейтраль умножения мировых трансформов. */
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Произведение матриц 4×4, заданных по столбцам (как их пишет glTF). */
export function multiplyMatrices(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Локальная матрица узла. Форма `matrix` берётся как есть, форма TRS
 * собирается в том же порядке, что задаёт glTF: масштаб, затем поворот, затем
 * перенос.
 */
export function localMatrixOf(node: GltfNode): number[] {
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
  if (node.matrix !== undefined && node.matrix.length === 16) return [...node.matrix];
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** Длина столбца матрицы — масштаб по соответствующей оси. */
function columnLength(matrix: readonly number[], column: number): number {
  const x = matrix[column * 4] ?? 0;
  const y = matrix[column * 4 + 1] ?? 0;
  const z = matrix[column * 4 + 2] ?? 0;
  return Math.hypot(x, y, z);
}

/**
 * Определитель линейной части матрицы. Знак — единственное, ради чего он
 * считается: отрицательный означает зеркальный трансформ. Соответствие осей
 * конвейера — поворот (определитель `+1`), поэтому знак в мировом пространстве
 * тот же, что в пространстве glTF.
 */
function linearDeterminant(m: readonly number[]): number {
  const [m0 = 0, m1 = 0, m2 = 0] = [m[0], m[1], m[2]];
  const [m4 = 0, m5 = 0, m6 = 0] = [m[4], m[5], m[6]];
  const [m8 = 0, m9 = 0, m10 = 0] = [m[8], m[9], m[10]];
  return m0 * (m5 * m10 - m6 * m9) + m1 * (m6 * m8 - m4 * m10) + m2 * (m4 * m9 - m5 * m8);
}

/**
 * Разложение мировой матрицы в величины конвейера. Единственное место, где
 * живут знаки соответствия осей (design, решение 5).
 */
export function decompose(matrix: readonly number[]): {
  x: number;
  y: number;
  elevation: number;
  yaw: number;
  scale: number;
  uniformScale: boolean;
  mirrored: boolean;
} {
  const tx = matrix[12] ?? 0;
  const ty = matrix[13] ?? 0;
  const tz = matrix[14] ?? 0;
  const sx = columnLength(matrix, 0);
  const sy = columnLength(matrix, 1);
  const sz = columnLength(matrix, 2);
  // Направление локальной оси X в мире: первый столбец, спроецированный тем же
  // соответствием, что и позиция.
  const axisX = matrix[0] ?? 0;
  const axisY = -(matrix[2] ?? 0);
  const angle = Math.atan2(axisY, axisX);
  const turns = angle / TURN_RADIANS;
  return {
    x: tx,
    y: -tz,
    elevation: ty,
    // `[0, 1)`: отрицательный курс и курс «полтора оборота» — одно и то же
    // направление, и документ обязан получить одно и то же число.
    yaw: turns < 0 ? turns + 1 : turns >= 1 ? turns - 1 : turns,
    scale: sx,
    uniformScale: Math.abs(sx - sy) <= SCALE_TOLERANCE && Math.abs(sx - sz) <= SCALE_TOLERANCE,
    // Длины столбцов знака не несут, поэтому зеркало ими не ловится: у объекта
    // с масштабом −1 по оси разложение даёт положительный масштаб и курс,
    // отличающийся на пол-оборота. Ни PRES-2, ни SER-8 зеркала не выражают, и
    // назвать эту потерю обязан импортёр (BLND-6), а не автор по кадру.
    mirrored: linearDeterminant(matrix) < 0,
  };
}

/**
 * Скаляр из значения custom property. Массив из одного элемента — форма, в
 * которой Blender отдаёт свойства-массивы длины 1; `null`, объекты и массивы
 * длиннее одного отбрасываются: скаляром они не являются, а придумывать им
 * значение импортёр не вправе.
 */
export function coerceExtra(value: GltfJsonValue): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.length === 1) return coerceExtra(value[0] as GltfJsonValue);
  return null;
}

function coerceExtras(
  extras: Readonly<Record<string, GltfJsonValue>> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (extras === undefined) return out;
  for (const key of Object.keys(extras)) {
    const value = coerceExtra(extras[key] as GltfJsonValue);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** Строковое значение семантического свойства; число и булево строкой не считаются. */
function semanticValueOf(extras: Readonly<Record<string, string | number | boolean>>, kind: SemanticKind): string {
  const value = extras[kind];
  return typeof value === 'string' ? value : '';
}

/**
 * Объекты источника в порядке обхода дерева узлов. Порядок здесь ничего не
 * решает — записи упорядочивает генерация слоя лексикографически по имени
 * (BLND-4), — но обход детерминирован, чтобы детерминированы были и сообщения.
 */
export function normalizeDocument(document: GltfDocument): readonly SourceObject[] {
  const nodes = nodesOf(document);
  const out: SourceObject[] = [];
  const visited = new Set<number>();

  const walk = (index: number, parent: readonly number[]): void => {
    const node = nodes[index];
    if (node === undefined || visited.has(index)) return;
    visited.add(index);
    const world = multiplyMatrices(parent, localMatrixOf(node));
    const extras = coerceExtras(node.extras);
    const semantics = SEMANTIC_KEYS.filter((key) => extras[key] !== undefined);
    const kind = semantics[0];
    const transform = decompose(world);
    out.push({
      name: node.name ?? `#${index}`,
      node: index,
      semantics,
      semanticValue: kind === undefined ? '' : semanticValueOf(extras, kind),
      x: transform.x,
      y: transform.y,
      elevation: transform.elevation,
      yaw: transform.yaw,
      scale: transform.scale,
      uniformScale: transform.uniformScale,
      mirrored: transform.mirrored,
      extras,
      mesh: node.mesh ?? null,
      world,
    });
    for (const child of node.children ?? []) walk(child, world);
  };

  for (const root of rootNodesOf(document)) walk(root, IDENTITY);
  // Узлы, до которых обход не дошёл (документ без сцен и с циклом ссылок),
  // разбираются как корневые: потерять объект молча хуже, чем разобрать его.
  for (let i = 0; i < nodes.length; i++) walk(i, IDENTITY);
  return out;
}
