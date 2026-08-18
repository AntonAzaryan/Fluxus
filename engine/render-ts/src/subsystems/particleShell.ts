/**
 * Оболочка эмиттера (REND-24) — запись «эмиттер, привязанный к сущности
 * доставленного состояния либо к размещённой декорации», её ключ и её публичный
 * вид.
 *
 * Вынесена из подсистемы частиц по той же причине, по какой из неё вынесены пул
 * экземпляров (`particleEffects.ts`) и привязка к узлу-сокету
 * (`particleSockets.ts`): «что такое оболочка» и «какие оболочки существуют» —
 * разные вопросы. Первый — данные и два коротких перевода между ними, второй —
 * сведение с доставленным состоянием, и оно остаётся в подсистеме целиком.
 *
 * Записи манифеста оболочка не держит — только разобранные поля: сравнивать по
 * ссылке нечего, редактор отдаёт документ разобранным заново после каждой
 * правки (REND-17).
 */
import type * as THREE from 'three';
import type { EntityId } from '@game-mvp/core';
import type { EffectInstance } from '../particleEffects.js';
import type { EntityView } from '../types.js';

/**
 * Что подсистеме нужно от записи любого рода: ссылка на эффект, необязательный
 * сокет и множитель масштаба. Записи двух родов — эмиттер секции `particles`
 * (`assets` ASSET-14) и эмиттерный decoration-вид (ASSET-9) — подходят сюда
 * обе, и сведение оболочек оттого одно на оба набора.
 */
export interface EmitterRecord {
  readonly effect: string;
  readonly socket?: string;
  readonly scale?: number;
}

/** Оболочка: экземпляр эффекта плюс то, за чем он следует и чем он был задан. */
export interface Shell {
  instance: EffectInstance;
  /** Ассет эффекта, которым оболочка играет сейчас. */
  effect: string;
  socketName: string | undefined;
  scale: number;
  /** Кэш найденного узла-сокета и корня, из которого он взят (`particleSockets.ts`). */
  socket: THREE.Object3D | null;
  socketRoot: THREE.Object3D | null;
  view: EntityView;
  readonly decoration: boolean;
}

/** Ключ оболочки: сущность плюс имя источника (тип или состояние). */
export function shellKey(entity: EntityId, source: string): string {
  return `${String(entity)}|${source}`;
}

/** Публичный вид оболочки — эффект и его узел; null, если оболочки нет. */
export function publicShell(
  shell: Shell | undefined,
): { readonly effect: string; readonly object: THREE.Object3D } | null {
  return shell === undefined ? null : { effect: shell.effect, object: shell.instance.object };
}
