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
import * as THREE from 'three';
import type { EntityId } from '@game-mvp/core';
import type { EffectInstance } from '../particleEffects.js';
import { resolveSocketNode, type SocketSource } from '../particleSockets.js';
import type { EntityView } from '../types.js';
import type { VisualSurface } from '../visualSurface.js';
import { poseShell, type ShellPose } from './shellSupport.js';

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

// Переиспользуемые между кадрами объекты — аллокаций на эмиттер на кадр нет.
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();

/**
 * Поза эмиттера-оболочки в кадре. Привязанный к сокету следует МИРОВОЙ позе
 * своего узла (REND-24), прочие — интерполированной позиции сущности плюс
 * опорная высота поверхности, ровно как оболочки эффектов (REND-2, REND-9).
 * `warnOnce` приходит готовой функцией, а не обёрткой: обёртка была бы
 * замыканием на каждую оболочку каждого кадра — в установившемся кадре путь
 * не аллоцирует пропорционально числу эмиттеров.
 */
export function poseEmitterShell(
  shell: Shell,
  alpha: number,
  heightStep: number,
  surface: VisualSurface | null,
  sockets: SocketSource | undefined,
  warnOnce: (key: string, message: string) => void,
  pose: ShellPose,
): void {
  const object = shell.instance.object;
  // Масштаб — множитель ЗАПИСИ (ASSET-14) поверх множителя размещения
  // (REND-11, REND-18), и от сокета он не зависит: нормализация модели по
  // высоте — свойство инстанса, а размер эффекта назначает автор эффекта.
  object.scale.setScalar(shell.scale * (shell.view.scale ?? 1));
  const node = resolveSocketNode(shell, shell.view.id, sockets, warnOnce);
  if (node !== null) {
    // Мировая поза узла инстанса — каждый кадр: инстанс уже поставлен
    // подсистемой моделей, а мировая матрица узла обновляется по цепочке
    // родителей, не обходом сцены.
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
    object.position.copy(SCRATCH_POSITION);
    object.quaternion.copy(SCRATCH_QUATERNION);
    return;
  }
  // Горизонталь — интерполяция двух доставленных тиков (REND-2), высота —
  // опорная высота визуальной поверхности либо ступень уровня (REND-7): то же
  // общее правило оболочек, что у эффектов (`shellSupport.ts`).
  poseShell(shell.view, alpha, heightStep, surface, pose);
  object.position.set(pose.x, pose.y, pose.base);
}
