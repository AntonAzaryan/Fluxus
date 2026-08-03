/**
 * Битовые маски принадлежности компонентов (замена строкового Map.get на горячем пути Query).
 *
 * Каждой сущности соответствует `wordsPerEntity` слов Uint32Array, индексируемых raw-индексом
 * сущности. Компонент — это просто числовой id: бит `id % 32` в слове `floor(id / 32)`.
 * Структура — только Uint32Array и числа, без Map/Set/замыканий, чтобы её можно было
 * тривиально положить в снапшот мира и склонировать.
 */

import { DEBUG, assert } from '../debug.js';

export interface ComponentMasks {
  readonly capacity: number; // сколько сущностей
  readonly wordsPerEntity: number; // ceil(componentCount / 32), минимум 1
  words: Uint32Array; // длина capacity * wordsPerEntity
}

function bitPos(componentId: number): { word: number; bit: number } {
  return { word: componentId >>> 5, bit: componentId & 31 };
}

export function createMasks(capacity: number, componentCount: number): ComponentMasks {
  const wordsPerEntity = Math.max(1, Math.ceil(componentCount / 32));
  return {
    capacity,
    wordsPerEntity,
    words: new Uint32Array(capacity * wordsPerEntity),
  };
}

/** Мягкая диагностика (FP-4): вызывающий код зовёт её безусловно, проверка — только под DEBUG. */
function checkBounds(masks: ComponentMasks, index: number, componentId?: number): void {
  if (!DEBUG) return;
  assert(index >= 0 && index < masks.capacity, `entity index ${index} вне capacity ${masks.capacity}`);
  if (componentId !== undefined) {
    assert(
      componentId >= 0 && componentId < masks.wordsPerEntity * 32,
      `componentId ${componentId} вне диапазона (wordsPerEntity=${masks.wordsPerEntity})`,
    );
  }
}

export function setComponent(masks: ComponentMasks, index: number, componentId: number): void {
  checkBounds(masks, index, componentId);
  const { word, bit } = bitPos(componentId);
  const slot = index * masks.wordsPerEntity + word;
  // `>>> 0`: `1 << bit` при bit === 31 даёт отрицательное число (знаковый int32) —
  // без нормализации к u32 бит 31 портил бы дальнейшие побитовые сравнения.
  masks.words[slot] = ((masks.words[slot] as number) | (1 << bit)) >>> 0;
}

export function clearComponent(masks: ComponentMasks, index: number, componentId: number): void {
  checkBounds(masks, index, componentId);
  const { word, bit } = bitPos(componentId);
  const slot = index * masks.wordsPerEntity + word;
  masks.words[slot] = ((masks.words[slot] as number) & ~(1 << bit)) >>> 0;
}

export function hasComponent(masks: ComponentMasks, index: number, componentId: number): boolean {
  checkBounds(masks, index, componentId);
  const { word, bit } = bitPos(componentId);
  const slot = index * masks.wordsPerEntity + word;
  return (((masks.words[slot] as number) >>> bit) & 1) !== 0;
}

export function clearEntity(masks: ComponentMasks, index: number): void {
  checkBounds(masks, index);
  const base = index * masks.wordsPerEntity;
  for (let w = 0; w < masks.wordsPerEntity; w++) {
    masks.words[base + w] = 0;
  }
}

/** Маска-фильтр (длина wordsPerEntity) для проверки набора компонентов запроса. */
export function buildQueryMask(masks: ComponentMasks, componentIds: readonly number[]): Uint32Array {
  const mask = new Uint32Array(masks.wordsPerEntity);
  for (const id of componentIds) {
    checkBounds(masks, 0, id);
    const { word, bit } = bitPos(id);
    mask[word] = ((mask[word] as number) | (1 << bit)) >>> 0;
  }
  return mask;
}

export function isEmptyMask(queryMask: Uint32Array): boolean {
  for (let w = 0; w < queryMask.length; w++) {
    if (queryMask[w] !== 0) return false;
  }
  return true;
}

/**
 * Все биты queryMask присутствуют у сущности. Пустой queryMask (пустой `all`) матчит всё:
 * нет требуемых битов — условие вакуумно истинно.
 */
export function matchesAll(masks: ComponentMasks, index: number, queryMask: Uint32Array): boolean {
  checkBounds(masks, index);
  const base = index * masks.wordsPerEntity;
  for (let w = 0; w < queryMask.length; w++) {
    const q = queryMask[w] as number;
    if ((((masks.words[base + w] as number) & q) >>> 0) !== q) return false;
  }
  return true;
}

/**
 * Хотя бы один бит queryMask присутствует у сущности. Пустой queryMask (пустой `any`) матчит
 * всё: `any` — это необязательный дополнительный фильтр, и отсутствие ограничения не должно
 * отсеивать сущности (симметрично с пустым `all`/`not`, которые тоже не сужают выборку).
 */
export function matchesAny(masks: ComponentMasks, index: number, queryMask: Uint32Array): boolean {
  if (isEmptyMask(queryMask)) return true;
  checkBounds(masks, index);
  const base = index * masks.wordsPerEntity;
  for (let w = 0; w < queryMask.length; w++) {
    if ((((masks.words[base + w] as number) & (queryMask[w] as number)) >>> 0) !== 0) return true;
  }
  return false;
}

/** Ни один бит queryMask не присутствует у сущности. Пустой queryMask (пустой `not`) матчит всё. */
export function matchesNone(masks: ComponentMasks, index: number, queryMask: Uint32Array): boolean {
  checkBounds(masks, index);
  const base = index * masks.wordsPerEntity;
  for (let w = 0; w < queryMask.length; w++) {
    if ((((masks.words[base + w] as number) & (queryMask[w] as number)) >>> 0) !== 0) return false;
  }
  return true;
}

export function cloneMasks(masks: ComponentMasks): ComponentMasks {
  return {
    capacity: masks.capacity,
    wordsPerEntity: masks.wordsPerEntity,
    words: masks.words.slice(),
  };
}
