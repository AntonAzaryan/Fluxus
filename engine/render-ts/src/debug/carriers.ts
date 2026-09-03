/**
 * Носители отладочных наложений (`render-debug` RDBG-3): три переиспользуемых
 * объекта сцены — отрезки, точки и треугольники — поверх растущих буферов
 * вершин с цветом.
 *
 * Отдельно от словаря примитивов (`painter.ts`), потому что это ЕГО МЕХАНИЗМ, а
 * не словарь: набор наложений перестраивается каждым кадром включённого
 * источника, и сцена, пересобираемая узлами, стоила бы аллокаций
 * пропорционально числу примитивов (REND-26). Здесь — как эти три носителя
 * растут, заливаются и отдаются; что именно в них рисуется, решает painter.
 */
import * as THREE from 'three';
import type { DebugColor } from './contract.js';
import { own } from '../footprint.js';

/** Стартовая ёмкость буферов в вершинах; растёт удвоением, не на кадр. */
const INITIAL_VERTICES = 256;

/** Растущий буфер вершин с цветом: позиции и цвета в паре, длина — в вершинах. */
class VertexBuffer {
  positions: Float32Array = new Float32Array(INITIAL_VERTICES * 3);
  colors: Float32Array = new Float32Array(INITIAL_VERTICES * 3);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, color: DebugColor): void {
    if ((this.count + 1) * 3 > this.positions.length) this.grow();
    const at = this.count * 3;
    this.positions[at] = x;
    this.positions[at + 1] = y;
    this.positions[at + 2] = z;
    this.colors[at] = ((color >> 16) & 0xff) / 255;
    this.colors[at + 1] = ((color >> 8) & 0xff) / 255;
    this.colors[at + 2] = (color & 0xff) / 255;
    this.count += 1;
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Float32Array(this.colors.length * 2);
    colors.set(this.colors);
    this.colors = colors;
  }
}

/** Один носитель: геометрия, её атрибуты, материал и объект сцены. */
export interface Carrier {
  readonly buffer: VertexBuffer;
  /** Пересоздаётся при росте буфера — прежняя отдаётся вместе со своими VBO. */
  geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly object: THREE.Mesh | THREE.Points | THREE.LineSegments;
  /** Ёмкость атрибутов в вершинах — по ней видно, что буфер перерос их. */
  capacity: number;
}

/**
 * Носитель: буфер вершин, геометрия поверх его массивов, материал вызывающего и
 * объект сцены, который он же и строит. Материал приходит УЖЕ учтённым (`own`) —
 * его вид знает painter, а не этот модуль.
 */
export function carrier(
  material: THREE.Material,
  build: (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) => THREE.Mesh | THREE.Points | THREE.LineSegments,
): Carrier {
  const geometry = carrierGeometry(new Float32Array(INITIAL_VERTICES * 3), new Float32Array(INITIAL_VERTICES * 3));
  const object = build(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 3;
  return { buffer: new VertexBuffer(), geometry, material, object, capacity: INITIAL_VERTICES };
}

/** Геометрия носителя поверх готовых массивов — одна точка учёта (PERF-8). */
function carrierGeometry(positions: Float32Array, colors: Float32Array): THREE.BufferGeometry {
  const geometry = own('geometry', 'debug', new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Атрибуты носителя из буфера. Пока ёмкость достаточна — одна запись в
 * существующий массив и сдвиг диапазона отрисовки; переросший буфер заводит
 * геометрию ЗАНОВО, и это редкость, а не кадровая работа.
 *
 * Заново геометрию, а не только её атрибуты: подмена атрибута оставляет прежние
 * VBO жить до потери контекста — освобождает их `geometry.dispose()`, и только
 * по своим ТЕКУЩИМ атрибутам. Прежняя геометрия поэтому отдаётся целиком, а
 * новая проходит учёт (PERF-8) как всякий ресурс.
 */
export function upload(one: Carrier): void {
  const buffer = one.buffer;
  if (buffer.count > one.capacity) {
    one.capacity = buffer.positions.length / 3;
    one.geometry.dispose();
    one.geometry = carrierGeometry(buffer.positions, buffer.colors);
    one.object.geometry = one.geometry;
  } else {
    const position = one.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = one.geometry.getAttribute('color') as THREE.BufferAttribute;
    (position.array as Float32Array).set(buffer.positions.subarray(0, buffer.count * 3));
    (color.array as Float32Array).set(buffer.colors.subarray(0, buffer.count * 3));
    position.needsUpdate = true;
    color.needsUpdate = true;
  }
  one.geometry.setDrawRange(0, buffer.count);
  one.object.visible = buffer.count > 0;
}
