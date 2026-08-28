/**
 * Чтение accessor'ов glTF: типы компонент, их читатели и разбор accessor'а в
 * плоский массив чисел. Отдельный модуль потому, что это самостоятельный
 * вопрос формата — как достать числа из буфера, — общий у геометрии, скелета и
 * анимаций.
 */
import type { GltfDocument } from './gltfDocument.js';

const COMPONENT_SIZE: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};
const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

/** Один читатель компоненты accessor'а по смещению в байтах от начала буфера. */
function componentReader(view: DataView, componentType: number): (byteOffset: number) => number {
  switch (componentType) {
    case 5120:
      return (o) => view.getInt8(o);
    case 5121:
      return (o) => view.getUint8(o);
    case 5122:
      return (o) => view.getInt16(o, true);
    case 5123:
      return (o) => view.getUint16(o, true);
    case 5125:
      return (o) => view.getUint32(o, true);
    case 5126:
      return (o) => view.getFloat32(o, true);
    default:
      throw new Error(`glTF: неизвестный componentType ${componentType}`);
  }
}

/**
 * Разбор accessor'а в плоский массив «числа как есть» (`count * itemSize`).
 * Нормализованные целые (ASSET-5: явно из формата) приводятся к [0..1]/[-1..1]
 * по правилу спецификации; JOINTS_0 читается тем же путём, но БЕЗ нормализации
 * (индексы, не веса) — вызывающий код это учитывает отдельно.
 */
export function readAccessor(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  accessorIndex: number,
  normalize: boolean,
): { readonly values: Float64Array; readonly count: number; readonly itemSize: number } {
  const acc = doc.accessors[accessorIndex];
  if (acc == null) throw new Error(`glTF: accessor ${accessorIndex} не существует`);
  if (acc.sparse != null) throw new Error(`glTF: sparse-accessor (${accessorIndex}) не поддержан`);
  const itemSize = TYPE_COMPONENTS[acc.type];
  if (itemSize == null) throw new Error(`glTF: неизвестный тип accessor'а "${acc.type}"`);
  const compSize = COMPONENT_SIZE[acc.componentType];
  if (compSize == null) throw new Error(`glTF: неизвестный componentType ${acc.componentType}`);

  const out = new Float64Array(acc.count * itemSize);
  if (acc.bufferView == null) return { values: out, count: acc.count, itemSize }; // все нули — валидно для glTF

  const bv = doc.bufferViews[acc.bufferView];
  if (bv == null) throw new Error(`glTF: bufferView ${acc.bufferView} не существует`);
  const buffer = buffers[bv.buffer];
  if (buffer == null) throw new Error(`glTF: buffer ${bv.buffer} не загружен`);

  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? compSize * itemSize;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = componentReader(view, acc.componentType);

  for (let i = 0; i < acc.count; i++) {
    const itemOffset = base + i * stride;
    for (let c = 0; c < itemSize; c++) {
      const raw = read(itemOffset + c * compSize);
      out[i * itemSize + c] = normalize ? normalizedComponent(raw, acc.componentType) : raw;
    }
  }
  return { values: out, count: acc.count, itemSize };
}

/** Целое → [0..1]/[-1..1] по правилу normalized-accessor'ов спецификации glTF. */
function normalizedComponent(raw: number, componentType: number): number {
  switch (componentType) {
    case 5121: // UNSIGNED_BYTE
      return raw / 255;
    case 5123: // UNSIGNED_SHORT
      return raw / 65535;
    case 5120: // BYTE
      return Math.max(raw / 127, -1);
    case 5122: // SHORT
      return Math.max(raw / 32767, -1);
    default: // 5126 FLOAT — уже нормировано форматом
      return raw;
  }
}
