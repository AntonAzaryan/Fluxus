/**
 * Геометрия непроцедурных примитивов подсистемы эффектов (REND-23, REND-43):
 * наземные фигуры, лежащие НА визуальной поверхности, отрезок между двумя
 * точками и полоса по недавним позициям.
 *
 * Отдельным модулем по той же причине, по какой из подсистемы вынесены прогрев
 * и набор оболочек: «какие эффекты существуют» и «из каких вершин состоит
 * фигура» — разные вопросы. Здесь — только второй, и ни сцены, ни материалов,
 * ни записей манифеста в нём нет: вход — числа, выход — переписанный буфер.
 *
 * ## Одна топология на все фигуры
 *
 * И диск, и кольцо, и сектор, и полоса, и луч, и лента — это ПАРАМЕТРИЧЕСКАЯ
 * СЕТКА `rows × cols`: у радиальных фигур строка есть кольцо, столбец — угол; у
 * полосных строка есть кромка, столбец — шаг вдоль. Индексы у такой сетки одни
 * и те же, и строятся они один раз при создании узла. Кадр переписывает только
 * ПОЗИЦИИ в уже выделенный `Float32Array` (REND-26): радиус, ведомый статом,
 * топологию не двигает — он живёт в отображении, а не в числе вершин.
 *
 * ## Почему высота выбирается на каждую вершину
 *
 * Телеграф зоны обязан лежать на том же поле, по которому решает симуляция
 * (REND-9): круг, пересекающий обрыв, ступает вместе с ним. Проекция по буферу
 * глубины (design D1) дала бы то же дешевле по вершинам, но потребовала бы
 * прохода, читающего глубину сцены, и липла бы к ЛЮБОЙ поверхности кадра — к
 * юниту, стоящему в круге, тоже.
 */
import * as THREE from 'three';
import type { VisualSurface } from '../visualSurface.js';
import type { EffectTrail } from './effectTrail.js';
import { own } from '../footprint.js';

/** Владелец ресурсов фигур в учёте памяти (PERF-8) — тот же, что у подсистемы. */
const EFFECTS_OWNER = 'effects';

/**
 * Потолок шагов вдоль фигуры: телеграф во всю арену иначе стоил бы
 * «клетки × тесселяция» шагов по каждой оси. Потолок на ПРОИЗВОДНОЙ величине,
 * как у общего правила клетки (`surfaceCells.ts`).
 */
const MAX_GROUND_STEPS = 24;

/** Угловых сегментов на полный оборот: круглость на глаз не зависит от размера. */
const FULL_TURN_SEGMENTS = 48;

/** Минимум сегментов у сектора: узкий конус тоже обязан быть дугой, а не клином. */
const MIN_ARC_SEGMENTS = 6;

/**
 * Буфер параметрической сетки фигуры: своя геометрия узла плюс прямые ссылки на
 * массивы атрибутов. Массивы держатся здесь, а не берутся у геометрии каждый
 * кадр, чтобы кадровый путь не ходил через `getAttribute` и приведения типов.
 */
export interface ShapeBuffer {
  readonly geometry: THREE.BufferGeometry;
  /** Позиции вершин, `rows × cols × 3`; переписываются на месте. */
  readonly positions: Float32Array;
  /** Цвет вершин RGBA: альфа несёт мягкость кромки и гашение хвоста ленты. */
  readonly colors: Float32Array;
  readonly rows: number;
  readonly cols: number;
  /** Число вершин — вход счётчика стоимости (PERF-3). */
  readonly vertices: number;
}

/**
 * Сетка `rows × cols` с треугольниками между соседними строками и столбцами.
 * Индексы строятся один раз: топология узла постоянна всю его жизнь.
 */
export function createGridShape(rows: number, cols: number): ShapeBuffer {
  const vertices = rows * cols;
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 4);
  colors.fill(1);
  const quads = (rows - 1) * (cols - 1);
  const indices = new Uint16Array(quads * 6);
  let at = 0;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices[at++] = a;
      indices[at++] = d;
      indices[at++] = b;
      indices[at++] = b;
      indices[at++] = d;
      indices[at++] = e;
    }
  }
  const geometry = own('geometry', EFFECTS_OWNER, new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return { geometry, positions, colors, rows, cols, vertices };
}

/** Позиции переписаны — сказать это три; границы фигура не пересчитывает. */
function markPositions(shape: ShapeBuffer): void {
  shape.geometry.getAttribute('position').needsUpdate = true;
}

/** Цвета переписаны; зовётся на смене записи, а не на кадре. */
function markShapeColors(shape: ShapeBuffer): void {
  shape.geometry.getAttribute('color').needsUpdate = true;
}

/**
 * Шагов вдоль фигуры размера `extent` (REND-43, design D2).
 *
 * Считается ОДИН раз, при взятии узла, а не на кадре: `areaSubdivisions` общего
 * правила зависит от накрытых клеток, то есть от позиции, а топология обязана
 * быть постоянной. Поэтому вход — максимальный размер записи, а дробление
 * клетки берётся признаком `hasCurvature`: на плоской арене шаг равен клетке —
 * этого хватает, чтобы фигура ступала по обрывам, — а на арене с кривизной шаг
 * дробится тесселяцией конфига рендера (REND-9).
 */
export function groundSteps(
  surface: VisualSurface | null,
  tile: number,
  extent: number,
  tessellation: number,
): number {
  const cells = tile > 0 ? Math.ceil(extent / tile) : Math.ceil(extent);
  const perCell = surface?.hasCurvature === true ? Math.max(1, Math.floor(tessellation)) : 1;
  return Math.min(MAX_GROUND_STEPS, Math.max(1, cells * perCell));
}

/** Угловых сегментов на дугу раствора `span` радиан. */
export function arcSegments(span: number): number {
  const full = Math.abs(span) / (Math.PI * 2);
  return Math.max(MIN_ARC_SEGMENTS, Math.round(FULL_TURN_SEGMENTS * full));
}

/** Высота поля в точке; без поверхности — опорная высота уровня (REND-7). */
function fieldHeight(surface: VisualSurface | null, x: number, y: number, base: number): number {
  return surface === null ? base : surface.heightAt(x, y);
}

/**
 * Радиальная наземная фигура — диск (`inner = 0`), кольцо и сектор: строка есть
 * кольцо радиуса, столбец — угол. Высота КАЖДОЙ вершины — выборка поля
 * (REND-43): фигура ступает по обрывам и повторяет кривизну.
 */
export function writeRadialGround(
  shape: ShapeBuffer,
  surface: VisualSurface | null,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  angleFrom: number,
  angleTo: number,
  base: number,
  lift: number,
): void {
  const { positions, rows, cols } = shape;
  const rowSpan = rows > 1 ? rows - 1 : 1;
  const colSpan = cols > 1 ? cols - 1 : 1;
  let at = 0;
  for (let r = 0; r < rows; r++) {
    const radius = inner + (outer - inner) * (r / rowSpan);
    for (let c = 0; c < cols; c++) {
      const angle = angleFrom + (angleTo - angleFrom) * (c / colSpan);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      positions[at++] = x;
      positions[at++] = y;
      positions[at++] = fieldHeight(surface, x, y, base) + lift;
    }
  }
  markPositions(shape);
}

/**
 * Наземная полоса от `(x0, y0)` к `(x1, y1)` шириной `2 × halfWidth`: строка —
 * кромка, столбец — шаг вдоль. Высота вершин — то же поле (REND-43).
 *
 * Вырожденное направление (нулевая длина) даёт полосу вдоль оси X: рисовать
 * нечего, но и NaN в буфере быть не должно.
 */
export function writeLinearGround(
  shape: ShapeBuffer,
  surface: VisualSurface | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  halfWidth: number,
  base: number,
  lift: number,
): void {
  const { positions, rows, cols } = shape;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const ux = length > 0 ? dx / length : 1;
  const uy = length > 0 ? dy / length : 0;
  // Нормаль в плоскости пола: полоса широка поперёк направления, а не вверх.
  const nx = -uy * halfWidth;
  const ny = ux * halfWidth;
  const rowSpan = rows > 1 ? rows - 1 : 1;
  const colSpan = cols > 1 ? cols - 1 : 1;
  let at = 0;
  for (let r = 0; r < rows; r++) {
    const side = (r / rowSpan) * 2 - 1;
    for (let c = 0; c < cols; c++) {
      const t = c / colSpan;
      const x = x0 + dx * t + nx * side;
      const y = y0 + dy * t + ny * side;
      positions[at++] = x;
      positions[at++] = y;
      positions[at++] = fieldHeight(surface, x, y, base) + lift;
    }
  }
  markPositions(shape);
}

/**
 * Луч — отрезок между двумя точками на СВОЕЙ высоте (REND-23): поле под ним не
 * выбирается, потому что луч летит по воздуху, а не лежит на полу. Полоса
 * горизонтальна: на изометрической камере (CAM-1) она читается, а биллборд
 * потребовал бы позу камеры — входа, которого у подсистемы эффектов нет.
 */
export function writeBeam(
  shape: ShapeBuffer,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  halfWidth: number,
): void {
  const { positions, rows, cols } = shape;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const ux = length > 0 ? dx / length : 1;
  const uy = length > 0 ? dy / length : 0;
  const nx = -uy * halfWidth;
  const ny = ux * halfWidth;
  const rowSpan = rows > 1 ? rows - 1 : 1;
  const colSpan = cols > 1 ? cols - 1 : 1;
  let at = 0;
  for (let r = 0; r < rows; r++) {
    const side = (r / rowSpan) * 2 - 1;
    for (let c = 0; c < cols; c++) {
      const t = c / colSpan;
      positions[at++] = x0 + dx * t + nx * side;
      positions[at++] = y0 + dy * t + ny * side;
      positions[at++] = z0 + (z1 - z0) * t;
    }
  }
  markPositions(shape);
}

/**
 * Лента-след по истории поз (REND-23, design D6): столбец — выборка возраста,
 * строка — кромка полосы. Ширина и альфа гаснут к хвосту, поэтому альфа
 * ВЕРШИН здесь переписывается каждый кадр вместе с позициями — в отличие от
 * мягкости кромки, которая от кадра не зависит.
 *
 * Выборок меньше, чем столбцов (след только начался) — недостающие столбцы
 * садятся на самую старую позу: вырожденные треугольники нулевой площади не
 * рисуются, и полоса просто короче.
 */
export function writeTrailStrip(
  shape: ShapeBuffer,
  trail: EffectTrail,
  halfWidth: number,
  scratch: Float32Array,
): void {
  const { positions, colors, rows, cols } = shape;
  const filled = trail.filled;
  if (filled === 0) {
    positions.fill(0);
    markPositions(shape);
    return;
  }
  const rowSpan = rows > 1 ? rows - 1 : 1;
  const colSpan = cols > 1 ? cols - 1 : 1;
  // Направление берётся по СОСЕДНЕЙ выборке: полоса широка поперёк движения.
  let prevX = 0;
  let prevY = 0;
  for (let c = 0; c < cols; c++) {
    const age = c < filled ? c : filled - 1;
    trail.read(age, scratch, 0);
    const x = scratch[0]!;
    const y = scratch[1]!;
    const z = scratch[2]!;
    let ux = 1;
    let uy = 0;
    if (c > 0) {
      const dx = prevX - x;
      const dy = prevY - y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        ux = dx / length;
        uy = dy / length;
      }
    }
    prevX = x;
    prevY = y;
    const t = c / colSpan;
    // Хвост уже головы и прозрачнее её: след читается направлением.
    const width = halfWidth * (1 - t);
    const alpha = 1 - t;
    const nx = -uy * width;
    const ny = ux * width;
    for (let r = 0; r < rows; r++) {
      const side = (r / rowSpan) * 2 - 1;
      const at = (r * cols + c) * 3;
      positions[at] = x + nx * side;
      positions[at + 1] = y + ny * side;
      positions[at + 2] = z;
      colors[(r * cols + c) * 4 + 3] = alpha;
    }
  }
  markPositions(shape);
  markShapeColors(shape);
}

/**
 * Мягкость кромки альфой ВЕРШИН (design D4): альфа гаснет к внешнему кольцу, а
 * у фигуры с дыркой — и к внутреннему. Ноль мягкости — резкая кромка.
 *
 * Пишется на СМЕНЕ записи, а не на кадре: величина от позы не зависит, а
 * `opacity` материала умножается на альфу вершин самим three — фаза жизни,
 * порог цвета и мигание работают поверх кромки без единой правки здесь.
 */
export function writeRadialEdgeAlpha(shape: ShapeBuffer, softness: number, fadeInner: boolean): void {
  const { colors, rows, cols } = shape;
  const soft = softness <= 0 ? 0 : softness > 1 ? 1 : softness;
  const rowSpan = rows > 1 ? rows - 1 : 1;
  for (let r = 0; r < rows; r++) {
    const t = r / rowSpan;
    const alpha = soft === 0 ? 1 : Math.min(edgeRamp(1 - t, soft), fadeInner ? edgeRamp(t, soft) : 1);
    for (let c = 0; c < cols; c++) {
      colors[(r * cols + c) * 4 + 3] = alpha;
    }
  }
  markShapeColors(shape);
}

/** То же для полосы: гаснут ПРОДОЛЬНЫЕ кромки, а не концы отрезка. */
export function writeStripEdgeAlpha(shape: ShapeBuffer, softness: number): void {
  const { colors, rows, cols } = shape;
  const soft = softness <= 0 ? 0 : softness > 1 ? 1 : softness;
  const rowSpan = rows > 1 ? rows - 1 : 1;
  for (let r = 0; r < rows; r++) {
    // Кромки полосы — крайние строки; середина непрозрачна.
    const t = Math.abs((r / rowSpan) * 2 - 1);
    const alpha = soft === 0 ? 1 : edgeRamp(1 - t, soft);
    for (let c = 0; c < cols; c++) {
      colors[(r * cols + c) * 4 + 3] = alpha;
    }
  }
  markShapeColors(shape);
}

/** Линейный спад на последней доле `soft` пути к кромке; вне полосы — единица. */
function edgeRamp(distanceToEdge: number, soft: number): number {
  if (distanceToEdge >= soft) return 1;
  return distanceToEdge <= 0 ? 0 : distanceToEdge / soft;
}
