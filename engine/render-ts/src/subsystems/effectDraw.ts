/**
 * Перевод ЗАПИСИ манифеста в параметры фигуры (REND-23, REND-43): какой
 * топологии узел нужен записи и какими числами кадр её переписывает.
 *
 * Между записью (`assets`) и буфером (`effectShapes.ts`) — ровно этот слой, и
 * он один: подсистема эффектов остаётся про источники и пул, буфер — про
 * вершины, а «что означают поля записи» живёт здесь. Перечень имён примитивов
 * принадлежит рендеру (REND-23), поэтому он тоже здесь, а не в валидации
 * манифеста: документ переживает код.
 */
import type { VisualEffect } from '@fluxus/assets';
import type { VisualSurface } from '../visualSurface.js';
import type { EffectTrail } from './effectTrail.js';
import {
  arcSegments,
  groundSteps,
  writeBeam,
  writeLinearGround,
  writeRadialEdgeAlpha,
  writeRadialGround,
  writeStripEdgeAlpha,
  writeTrailStrip,
  type ShapeBuffer,
} from './effectShapes.js';

/** Примитивы, которые умеет рисовать подсистема; перечень принадлежит рендеру. */
const PRIMITIVE_SPHERE = 'sphere';
const PRIMITIVE_DISC = 'disc';
const PRIMITIVE_RING = 'ring';
const PRIMITIVE_SECTOR = 'sector';
const PRIMITIVE_LINE = 'line';
export const PRIMITIVE_BEAM = 'beam';
export const PRIMITIVE_RIBBON = 'ribbon';

/** Наземные примитивы (REND-43): те, что садятся на визуальную поверхность. */
const GROUND_PRIMITIVES: readonly string[] = [
  PRIMITIVE_DISC,
  PRIMITIVE_RING,
  PRIMITIVE_SECTOR,
  PRIMITIVE_LINE,
];

/** Примитивы со СВОЕЙ геометрией: у сферы она разделяемая (REND-3). */
const SHAPE_PRIMITIVES: readonly string[] = [
  ...GROUND_PRIMITIVES,
  PRIMITIVE_BEAM,
  PRIMITIVE_RIBBON,
];

/**
 * Подъём наземной фигуры над полем по умолчанию, мировые единицы: совпадение с
 * полом даёт z-fighting, а не изображение (REND-43).
 */
const DEFAULT_GROUND_LIFT = 0.02;

/** Длина следа по умолчанию, выборок поз: короче — уже не читается направление. */
export const DEFAULT_TRAIL_SAMPLES = 16;

/** Место наземного эффекта среди прозрачных: ПОСЛЕ воды (design D3, REND-35). */
export const GROUND_EFFECT_RENDER_ORDER = 0;

export function isShapePrimitive(primitive: string): boolean {
  return SHAPE_PRIMITIVES.includes(primitive);
}

export function isGroundPrimitive(primitive: string): boolean {
  return GROUND_PRIMITIVES.includes(primitive);
}

export function isKnownPrimitive(primitive: string): boolean {
  return primitive === PRIMITIVE_SPHERE || isShapePrimitive(primitive);
}

/** Топология узла: строк × столбцов параметрической сетки (`effectShapes.ts`). */
export interface ShapePlan {
  readonly rows: number;
  readonly cols: number;
}

/**
 * Радиус записи; у нерадиального примитива (луч, лента) его нет вовсе, и нулём
 * он читается ровно затем, чтобы «размер» был одним числом на все примитивы.
 */
export function radiusOf(record: VisualEffect): number {
  return record.radius ?? 0;
}

/** Полураствор сектора в радианах; запись пишет градусы (presentation-данные). */
function halfAngleOf(record: VisualEffect): number {
  return ((record.halfAngleDeg ?? 0) * Math.PI) / 180;
}

/**
 * Наибольший размер, которого фигура достигнет: радиус записи под верхом окна
 * стата и под концом фазы жизни. По нему считается дробление — топология
 * фиксируется взятием узла и на кадре не пересчитывается (REND-26, design D2).
 */
function maxRadiusOf(record: VisualEffect): number {
  const own = radiusOf(record);
  const grown = Math.max(own, record.radiusTo ?? own);
  const range = record.radiusFromStat;
  const factor = range === undefined ? 1 : Math.max(range.from ?? 1, range.to, 1);
  return grown * factor;
}

/**
 * Топология под запись; null — примитив со своей геометрией не бывает (сфера,
 * неизвестное имя). Числа сетки одинаковы для всех записей одного примитива и
 * одного размера, поэтому пул делится по паре «примитив + топология».
 */
export function planShape(
  record: VisualEffect,
  surface: VisualSurface | null,
  tile: number,
  tessellation: number,
  detail: number,
): ShapePlan | null {
  const primitive = record.primitive;
  const steps = (extent: number): number =>
    groundSteps(surface, tile, extent, tessellation, detail);
  if (primitive === PRIMITIVE_DISC || primitive === PRIMITIVE_RING) {
    return { rows: steps(maxRadiusOf(record)) + 1, cols: arcSegments(Math.PI * 2) + 1 };
  }
  if (primitive === PRIMITIVE_SECTOR) {
    return { rows: steps(maxRadiusOf(record)) + 1, cols: arcSegments(2 * halfAngleOf(record)) + 1 };
  }
  if (primitive === PRIMITIVE_LINE) {
    return {
      rows: steps(record.width ?? 0) + 1,
      cols: steps(record.length ?? maxRadiusOf(record)) + 1,
    };
  }
  // Луч по воздуху поле не выбирает — ему хватает четырёх вершин; лента длинна
  // ровно своей историей поз.
  if (primitive === PRIMITIVE_BEAM) return { rows: 2, cols: 2 };
  if (primitive === PRIMITIVE_RIBBON) {
    return { rows: 2, cols: Math.max(2, Math.floor(record.trailSamples ?? DEFAULT_TRAIL_SAMPLES)) };
  }
  return null;
}

/**
 * Мягкость кромки записи в альфу вершин. Зовётся на СМЕНЕ записи, а не на
 * кадре: величина от позы не зависит (design D4). У ленты кромка своя — её
 * альфу переписывает каждый кадр сам след.
 */
export function applyShapeEdge(shape: ShapeBuffer, record: VisualEffect): void {
  const softness = record.edgeSoftness ?? 0;
  const primitive = record.primitive;
  if (primitive === PRIMITIVE_LINE || primitive === PRIMITIVE_BEAM) {
    writeStripEdgeAlpha(shape, softness);
    return;
  }
  if (primitive === PRIMITIVE_RIBBON) return;
  writeRadialEdgeAlpha(shape, softness, primitive === PRIMITIVE_RING);
}

/**
 * Наземная фигура записи в точке `(x, y)`, развёрнутая на `yaw` и увеличенная
 * множителем `scale` (стат записи × масштаб размещения). `base` — опорная
 * высота уровня для сборки без поверхности (REND-7).
 */
export function drawGround(
  shape: ShapeBuffer,
  record: VisualEffect,
  surface: VisualSurface | null,
  x: number,
  y: number,
  yaw: number,
  scale: number,
  base: number,
): void {
  const lift = record.lift ?? DEFAULT_GROUND_LIFT;
  if (record.primitive === PRIMITIVE_LINE) {
    const length = (record.length ?? 0) * scale;
    writeLinearGround(
      shape,
      surface,
      x,
      y,
      x + Math.cos(yaw) * length,
      y + Math.sin(yaw) * length,
      ((record.width ?? 0) / 2) * scale,
      base,
      lift,
    );
    return;
  }
  const outer = radiusOf(record) * scale;
  const inner = (record.innerRadius ?? 0) * scale;
  if (record.primitive === PRIMITIVE_SECTOR) {
    const half = halfAngleOf(record);
    writeRadialGround(shape, surface, x, y, inner, outer, yaw - half, yaw + half, base, lift);
    return;
  }
  writeRadialGround(shape, surface, x, y, inner, outer, 0, Math.PI * 2, base, lift);
}

/**
 * Наибольший поперечник наземной фигуры записи — консервативный радиус её
 * якоря при отсечении (REND-43). Луч и лента сюда не идут: их второй конец
 * решается позже позы, и радиуса у них до этого нет.
 */
export function groundExtentOf(record: VisualEffect): number {
  if (record.primitive === PRIMITIVE_LINE) {
    return Math.max(record.length ?? 0, (record.width ?? 0) / 2);
  }
  return maxRadiusOf(record);
}

/** Луч записи между двумя мировыми точками; ширина — поле записи. */
export function drawBeam(
  shape: ShapeBuffer,
  record: VisualEffect,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): void {
  writeBeam(shape, x0, y0, z0, x1, y1, z1, (record.width ?? 0) / 2);
}

/** Лента записи по истории поз; ширина — поле записи. */
export function drawTrail(
  shape: ShapeBuffer,
  record: VisualEffect,
  trail: EffectTrail,
  scratch: Float32Array,
): void {
  writeTrailStrip(shape, trail, (record.width ?? 0) / 2, scratch);
}
