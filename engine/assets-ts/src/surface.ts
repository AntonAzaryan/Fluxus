/**
 * Выборка поверхности канонической модели (ASSET-11): пересечение луча с
 * треугольниками геометрии модели в её КАНОНИЧЕСКИХ осях (ASSET-5) — точка,
 * расстояние по лучу и нормаль треугольника в точке пересечения. Вертикальная
 * выборка «верхняя поверхность под точкой» — тот же запрос лучом (0, 0, -1)
 * из-за верха bbox: ближайшее пересечение и есть верх. Потребители — единое
 * поле высот рендера с walkable-поверхностями (`rendering` REND-9) и его
 * picking (REND-15); своего пересечения с мешом они не заводят — обе ветви
 * зовут этот модуль (ASSET-11).
 *
 * Модуль о размещениях, трансформах и сценах не знает (ASSET-1, ASSET-5):
 * перевод мирового луча в канонические оси инстанса обратной матрицей его
 * трансформа — забота вызывающего; `t` при этом остаётся в единицах длины
 * `direction`, и при единичном направлении в мировых осях мировым и приезжает.
 * Статус загрузки запрос не трогает: на вход идёт уже готовая модель — handle
 * не `ready` спрашивать нечего (ASSET-4).
 *
 * Ускоряющая структура — BVH по треугольникам. Строится лениво по первому
 * запросу и кэшируется НА АССЕТЕ — WeakMap по объекту модели, поэтому индекс
 * разделяется всеми потребителями ассета и умирает вместе с ним. Геометрия не
 * копируется ни на инстанс, ни на запрос (ASSET-11): листья дерева ссылаются
 * на исходные `positions`/`indices` мешей, свои у индекса — только границы
 * узлов и порядок треугольников. Правка трансформа записи decoration индекс
 * не инвалидирует никогда — меняется лишь матрица, которой вызывающий
 * переводит луч (design walkable-decorations, §2).
 *
 * Выборка идёт по позе покоя: скининг и клипы запросу не видны — walkable-
 * декорации статичны, а анимированная поверхность была бы второй
 * интерпретацией меша. Пересечение двустороннее: winding авторских мешей не
 * нормируется, поэтому нормаль отдаётся ориентированной навстречу лучу —
 * вертикаль сверху получает нормаль верха, как того ждут посадка и наклон
 * (`rendering` REND-10).
 *
 * Математика — обычный double: модуль presentation-стороны, запрет float
 * действует на симуляцию, в которую отсюда хода нет (ASSET-1).
 */
import type { NormalizedMesh, NormalizedModel } from './model.js';

/**
 * Результат выборки. Объект НАМЕРЕННО мутабелен: горячие пути поля высот и
 * наведения переиспользуют его через параметр `out`, не аллоцируя на запрос.
 */
export interface ModelSurfaceHit {
  /** Расстояние вдоль луча в единицах длины `direction` (не обязана быть 1). */
  t: number;
  /** Точка пересечения в канонических осях модели (ASSET-5). */
  point: [number, number, number];
  /** Единичная нормаль треугольника, ориентированная навстречу лучу. */
  normal: [number, number, number];
}

/** AABB треугольной геометрии в канонических осях — например, для bbox → клетки у поля высот (REND-9). */
export interface ModelSurfaceBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Разделяемый индекс поверхности одного ассета (ASSET-11). Один на модель:
 * `modelSurfaceIndex` для одного и того же объекта модели возвращает ОДИН И
 * ТОТ ЖЕ индекс — этим и наблюдаемо разделение структуры потребителями.
 */
export interface ModelSurfaceIndex {
  /** Сколько треугольников видит запрос; 0 — модель без треугольной геометрии. */
  readonly triangleCount: number;
  /** Границы геометрии; null — треугольников нет. */
  readonly bounds: ModelSurfaceBounds | null;
  /**
   * Ближайшее пересечение луча `origin + t * direction`, `t >= 0`, с
   * треугольниками модели; null — луч геометрию не задел (модель без
   * треугольников — тоже «нет пересечения», не ошибка, ASSET-11).
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    out?: ModelSurfaceHit,
  ): ModelSurfaceHit | null;
  /**
   * Верхняя поверхность под точкой `(x, y)`: тот же запрос лучом (0, 0, -1)
   * из-за верха bbox. `point[2]` результата — высота верха в канонических
   * осях; `t` отсчитан от служебного старта над bbox и потребителю обычно
   * не нужен.
   */
  topAt(x: number, y: number, out?: ModelSurfaceHit): ModelSurfaceHit | null;
}

/** Порог листа BVH: дальнейшее деление четвёрки треугольников дороже перебора. */
const LEAF_SIZE = 4;
/** Порог параллельности луча и плоскости треугольника (детерминант Мёллера — Трумбора). */
const PARALLEL_EPS = 1e-12;
/** Допуск барицентрических координат: луч по общему ребру двух треугольников не должен провалиться между ними. */
const BARY_EPS = 1e-9;

/** Треугольники модели плоским списком: индекс меша и смещение первой вершины в его `indices`. */
interface TriangleSoup {
  readonly count: number;
  readonly triMesh: Uint32Array;
  readonly triBase: Uint32Array;
}

function collectTriangles(model: NormalizedModel, hidden: ReadonlySet<number> | null): TriangleSoup {
  let count = 0;
  // Неполный хвост `indices` молча отбрасывается — так же его игнорирует рендер.
  // Скрытые части (`hiddenParts` записи манифеста) отсеиваются тем же критерием,
  // что у инстанса и его bbox — по `partId` меша: поверхность обязана совпадать
  // с нарисованным набором частей (REND-9, REND-15).
  for (const mesh of model.meshes) {
    if (hidden?.has(mesh.partId) === true) continue;
    count += Math.floor(mesh.indices.length / 3);
  }
  const triMesh = new Uint32Array(count);
  const triBase = new Uint32Array(count);
  let tri = 0;
  for (let m = 0; m < model.meshes.length; m++) {
    if (hidden?.has(model.meshes[m]!.partId) === true) continue;
    const triangles = Math.floor(model.meshes[m]!.indices.length / 3);
    for (let k = 0; k < triangles; k++) {
      triMesh[tri] = m;
      triBase[tri] = k * 3;
      tri++;
    }
  }
  return { count, triMesh, triBase };
}

/** Дерево на время построения; в индекс укладывается плоскими массивами. */
interface BuildNode {
  readonly bounds: Float64Array;
  readonly left: BuildNode | null;
  readonly right: BuildNode | null;
  readonly start: number;
  readonly count: number;
}

/** Центроиды треугольников — ключ разбиения; живут только на время построения. */
function centroids(model: NormalizedModel, soup: TriangleSoup): Float64Array {
  const out = new Float64Array(soup.count * 3);
  for (let i = 0; i < soup.count; i++) {
    const mesh = model.meshes[soup.triMesh[i]!]!;
    const base = soup.triBase[i]!;
    for (let axis = 0; axis < 3; axis++) {
      out[i * 3 + axis] =
        (mesh.positions[mesh.indices[base]! * 3 + axis]! +
          mesh.positions[mesh.indices[base + 1]! * 3 + axis]! +
          mesh.positions[mesh.indices[base + 2]! * 3 + axis]!) /
        3;
    }
  }
  return out;
}

/** AABB вершин треугольников `order[start .. start+count)`: [minX..minZ, maxX..maxZ]. */
function rangeBounds(
  model: NormalizedModel,
  soup: TriangleSoup,
  order: Uint32Array,
  start: number,
  count: number,
): Float64Array {
  const b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = start; i < start + count; i++) {
    const tri = order[i]!;
    const mesh = model.meshes[soup.triMesh[tri]!]!;
    const base = soup.triBase[tri]!;
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.indices[base + corner]! * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[v + axis]!;
        if (value < b[axis]!) b[axis] = value;
        if (value > b[3 + axis]!) b[3 + axis] = value;
      }
    }
  }
  return b;
}

/**
 * Рекурсивное построение: медианное разбиение по самой длинной оси разброса
 * центроидов. Медиана гарантирует сбалансированность и завершение (обе
 * половины непусты); совпавшие центроиды дают лист любого размера.
 */
function buildTree(
  model: NormalizedModel,
  soup: TriangleSoup,
  cent: Float64Array,
  order: Uint32Array,
  start: number,
  count: number,
): BuildNode {
  const bounds = rangeBounds(model, soup, order, start, count);
  if (count <= LEAF_SIZE) return { bounds, left: null, right: null, start, count };

  let axis = 0;
  let extent = -Infinity;
  for (let a = 0; a < 3; a++) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < start + count; i++) {
      const c = cent[order[i]! * 3 + a]!;
      if (c < min) min = c;
      if (c > max) max = c;
    }
    if (max - min > extent) {
      extent = max - min;
      axis = a;
    }
  }
  if (extent <= 0) return { bounds, left: null, right: null, start, count };

  // Сортировка подотрезка через обычный массив — аллокация построения, не запроса.
  const sub = Array.from(order.subarray(start, start + count));
  sub.sort((a, b) => cent[a * 3 + axis]! - cent[b * 3 + axis]!);
  order.set(sub, start);

  const half = count >> 1;
  return {
    bounds,
    left: buildTree(model, soup, cent, order, start, half),
    right: buildTree(model, soup, cent, order, start + half, count - half),
    start,
    count: 0,
  };
}

/** Плоское дерево depth-first: левый ребёнок — следующий узел, правый — по индексу. */
interface FlatTree {
  readonly nodeBounds: Float64Array;
  readonly nodeRight: Int32Array;
  readonly nodeStart: Int32Array;
  readonly nodeCount: Int32Array;
}

function flattenTree(root: BuildNode): FlatTree {
  const bounds: number[] = [];
  const right: number[] = [];
  const startList: number[] = [];
  const countList: number[] = [];
  const emit = (node: BuildNode): number => {
    const index = right.length;
    for (let k = 0; k < 6; k++) bounds.push(node.bounds[k]!);
    right.push(-1);
    startList.push(node.start);
    countList.push(node.count);
    if (node.left !== null && node.right !== null) {
      emit(node.left);
      right[index] = emit(node.right);
    }
    return index;
  };
  emit(root);
  return {
    nodeBounds: Float64Array.from(bounds),
    nodeRight: Int32Array.from(right),
    nodeStart: Int32Array.from(startList),
    nodeCount: Int32Array.from(countList),
  };
}

class SurfaceIndex implements ModelSurfaceIndex {
  readonly triangleCount: number;
  readonly bounds: ModelSurfaceBounds | null;

  private readonly meshes: readonly NormalizedMesh[];
  /** Треугольники в порядке листьев дерева; ссылки в разделяемые буферы мешей, не копии (ASSET-11). */
  private readonly triMesh: Uint32Array;
  private readonly triBase: Uint32Array;
  private readonly tree: FlatTree;

  // Переиспользуемое состояние запроса: стек обхода, луч, лучший кандидат.
  // Аллокаций на запрос нет; обход не реентерабелен, как и весь кадр рендера.
  private stack = new Int32Array(64);
  private readonly rayO = new Float64Array(3);
  private readonly rayD = new Float64Array(3);
  private bestT = Infinity;
  private bestTri = -1;

  constructor(model: NormalizedModel, hidden: ReadonlySet<number> | null) {
    this.meshes = model.meshes;
    const soup = collectTriangles(model, hidden);
    this.triangleCount = soup.count;
    if (soup.count === 0) {
      // Модель без треугольной геометрии — валидный ассет: любой запрос ответит
      // «нет пересечения», не ошибкой (ASSET-11).
      this.bounds = null;
      this.triMesh = soup.triMesh;
      this.triBase = soup.triBase;
      this.tree = {
        nodeBounds: new Float64Array(0),
        nodeRight: new Int32Array(0),
        nodeStart: new Int32Array(0),
        nodeCount: new Int32Array(0),
      };
      return;
    }
    const order = new Uint32Array(soup.count);
    for (let i = 0; i < soup.count; i++) order[i] = i;
    const root = buildTree(model, soup, centroids(model, soup), order, 0, soup.count);
    this.tree = flattenTree(root);
    // Порядок листьев запекается в сами массивы треугольников — на запросе
    // косвенности `order[i]` уже нет.
    this.triMesh = new Uint32Array(soup.count);
    this.triBase = new Uint32Array(soup.count);
    for (let i = 0; i < soup.count; i++) {
      this.triMesh[i] = soup.triMesh[order[i]!]!;
      this.triBase[i] = soup.triBase[order[i]!]!;
    }
    const b = root.bounds;
    this.bounds = Object.freeze({
      min: Object.freeze([b[0]!, b[1]!, b[2]!] as const),
      max: Object.freeze([b[3]!, b[4]!, b[5]!] as const),
    });
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    out?: ModelSurfaceHit,
  ): ModelSurfaceHit | null {
    if (this.triangleCount === 0) return null;
    this.rayO[0] = ox;
    this.rayO[1] = oy;
    this.rayO[2] = oz;
    this.rayD[0] = dx;
    this.rayD[1] = dy;
    this.rayD[2] = dz;
    this.bestT = Infinity;
    this.bestTri = -1;

    let sp = 0;
    this.stack[sp++] = 0;
    while (sp > 0) {
      const node = this.stack[--sp]!;
      if (!this.nodeIntersects(node)) continue;
      if (this.tree.nodeCount[node]! > 0) {
        this.intersectLeaf(node);
      } else {
        if (sp + 2 > this.stack.length) this.growStack();
        this.stack[sp++] = this.tree.nodeRight[node]!;
        this.stack[sp++] = node + 1;
      }
    }
    if (this.bestTri < 0) return null;
    return this.fillHit(out);
  }

  topAt(x: number, y: number, out?: ModelSurfaceHit): ModelSurfaceHit | null {
    const b = this.bounds;
    if (b == null) return null;
    // Вертикаль вне XY-границ геометрии не заденет ничего — ранний отказ
    // оставляет клетки вне bbox бесплатными (design walkable-decorations, §1).
    if (x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1]) return null;
    return this.raycast(x, y, b.max[2] + 1, 0, 0, -1, out);
  }

  /** Пересечение луча с AABB узла (слэбы); ветвь `d === 0` вместо деления на ноль. */
  private nodeIntersects(node: number): boolean {
    const b = this.tree.nodeBounds;
    const base = node * 6;
    let tmin = 0;
    let tmax = this.bestT;
    for (let axis = 0; axis < 3; axis++) {
      const o = this.rayO[axis]!;
      const d = this.rayD[axis]!;
      const min = b[base + axis]!;
      const max = b[base + 3 + axis]!;
      if (d === 0) {
        if (o < min || o > max) return false;
        continue;
      }
      const inv = 1 / d;
      let t1 = (min - o) * inv;
      let t2 = (max - o) * inv;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    return true;
  }

  private intersectLeaf(node: number): void {
    const start = this.tree.nodeStart[node]!;
    const end = start + this.tree.nodeCount[node]!;
    for (let tri = start; tri < end; tri++) this.intersectTriangle(tri);
  }

  /** Мёллер — Трумбор, двусторонний; вырожденный треугольник отсеивает детерминант. */
  private intersectTriangle(tri: number): void {
    const mesh = this.meshes[this.triMesh[tri]!]!;
    const idx = mesh.indices;
    const pos = mesh.positions;
    const base = this.triBase[tri]!;
    const ia = idx[base]! * 3;
    const ib = idx[base + 1]! * 3;
    const ic = idx[base + 2]! * 3;
    const ax = pos[ia]!;
    const ay = pos[ia + 1]!;
    const az = pos[ia + 2]!;
    const e1x = pos[ib]! - ax;
    const e1y = pos[ib + 1]! - ay;
    const e1z = pos[ib + 2]! - az;
    const e2x = pos[ic]! - ax;
    const e2y = pos[ic + 1]! - ay;
    const e2z = pos[ic + 2]! - az;
    const dxv = this.rayD[0]!;
    const dyv = this.rayD[1]!;
    const dzv = this.rayD[2]!;

    const px = dyv * e2z - dzv * e2y;
    const py = dzv * e2x - dxv * e2z;
    const pz = dxv * e2y - dyv * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -PARALLEL_EPS && det < PARALLEL_EPS) return;
    const inv = 1 / det;

    const sx = this.rayO[0]! - ax;
    const sy = this.rayO[1]! - ay;
    const sz = this.rayO[2]! - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -BARY_EPS || u > 1 + BARY_EPS) return;

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dxv * qx + dyv * qy + dzv * qz) * inv;
    if (v < -BARY_EPS || u + v > 1 + BARY_EPS) return;

    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 0 || t >= this.bestT) return;
    this.bestT = t;
    this.bestTri = tri;
  }

  /** Точка — из `t`, нормаль — геометрическая нормаль лучшего треугольника навстречу лучу. */
  private fillHit(out?: ModelSurfaceHit): ModelSurfaceHit {
    const mesh = this.meshes[this.triMesh[this.bestTri]!]!;
    const idx = mesh.indices;
    const pos = mesh.positions;
    const base = this.triBase[this.bestTri]!;
    const ia = idx[base]! * 3;
    const ib = idx[base + 1]! * 3;
    const ic = idx[base + 2]! * 3;
    const e1x = pos[ib]! - pos[ia]!;
    const e1y = pos[ib + 1]! - pos[ia + 1]!;
    const e1z = pos[ib + 2]! - pos[ia + 2]!;
    const e2x = pos[ic]! - pos[ia]!;
    const e2y = pos[ic + 1]! - pos[ia + 1]!;
    const e2z = pos[ic + 2]! - pos[ia + 2]!;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // Детерминант лучшего пересечения ненулевой, значит и нормаль ненулевая.
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;
    if (nx * this.rayD[0]! + ny * this.rayD[1]! + nz * this.rayD[2]! > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const hit = out ?? { t: 0, point: [0, 0, 0], normal: [0, 0, 0] };
    hit.t = this.bestT;
    hit.point[0] = this.rayO[0]! + this.bestT * this.rayD[0]!;
    hit.point[1] = this.rayO[1]! + this.bestT * this.rayD[1]!;
    hit.point[2] = this.rayO[2]! + this.bestT * this.rayD[2]!;
    hit.normal[0] = nx;
    hit.normal[1] = ny;
    hit.normal[2] = nz;
    return hit;
  }

  private growStack(): void {
    const next = new Int32Array(this.stack.length * 2);
    next.set(this.stack);
    this.stack = next;
  }
}

/**
 * Кэш индексов НА АССЕТЕ: внешний ключ — объект модели, поэтому все потребители
 * одного ассета делят индексы, а с уходом ассета из кэша сервиса уходят и они.
 * Внутренний ключ — каноническая подпись набора скрытых частей: у записи с
 * `hiddenParts` свой индекс (поверхность = картинка, REND-9), но все инстансы
 * одной записи — десять мостов одного набора частей — делят один (ASSET-11).
 */
const indexCache = new WeakMap<NormalizedModel, Map<string, SurfaceIndex>>();

/** Каноническая подпись набора скрытых частей: отсортированные уникальные id; '' — скрытых нет. */
function hiddenSignature(hiddenParts: readonly number[] | undefined): string {
  if (hiddenParts === undefined || hiddenParts.length === 0) return '';
  return [...new Set(hiddenParts)].sort((a, b) => a - b).join(',');
}

/**
 * Индекс поверхности модели (ASSET-11): строится лениво при первом обращении
 * и разделяется — повторный вызов для того же объекта модели и того же НАБОРА
 * скрытых частей возвращает тот же индекс (порядок и дубли в `hiddenParts` —
 * не различия). Скрытые части записи манифеста в индекс не попадают — так же,
 * как их не рисует инстанс и не считает его bbox (REND-9, REND-15); без
 * `hiddenParts` поведение прежнее — индекс по всей геометрии. Модель обязана
 * быть канонической и неизменной (ASSET-5): байты буферов после построения
 * индекса трогать нельзя — та же дисциплина, что у остальных потребителей
 * ассета.
 */
export function modelSurfaceIndex(
  model: NormalizedModel,
  hiddenParts?: readonly number[],
): ModelSurfaceIndex {
  let byHidden = indexCache.get(model);
  if (byHidden === undefined) {
    byHidden = new Map();
    indexCache.set(model, byHidden);
  }
  const signature = hiddenSignature(hiddenParts);
  let index = byHidden.get(signature);
  if (index === undefined) {
    index = new SurfaceIndex(model, signature === '' ? null : new Set(hiddenParts));
    byHidden.set(signature, index);
  }
  return index;
}
