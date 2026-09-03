/**
 * Общее хозяйство носителей яруса (REND-20): узел записи в сцене и
 * анимационный контроллер. Оба нужны ДВУМ носителям и ни одному в
 * одиночку — держатель делят заглушка и детальное поддерево, контроллер
 * одинаков у обоих ярусов и различается только бэкендом воспроизведения
 * (REND-4).
 */
import * as THREE from 'three';
import { AnimationController } from '../../../model/animation.js';
import type { CarrierDeps, InstanceRecord } from '../instanceRecord.js';

/** Опции контроллера от сборки (REND-4): имена событий и длительность кроссфейда. */
export interface ControllerOptions {
  readonly crossfade?: number;
  readonly deathEvent?: string;
  readonly reviveEvent?: string;
}

/**
 * Узел записи в сцене: носитель заглушки и корень детального яруса. Заводится
 * ЛЕНИВО и снимается, как только оба исчезли: у батчевой записи узла в сцене
 * нет (REND-20), и пустой `Group` на каждую значил бы обход сцены за то,
 * чего в ней не рисуется.
 */
export function ensureHolder(record: InstanceRecord, deps: CarrierDeps): THREE.Group {
  if (record.holder !== null) return record.holder;
  const holder = new THREE.Group();
  holder.name = `${record.decoration ? 'decoration' : 'entity'}:${record.entity}`;
  holder.position.copy(record.pos);
  holder.quaternion.copy(record.quat);
  holder.scale.setScalar(record.scale);
  deps.scene.add(holder);
  record.holder = holder;
  deps.markCaster(record);
  return holder;
}

export function releaseHolder(record: InstanceRecord, deps: CarrierDeps): void {
  if (record.holder === null || record.model !== null || record.placeholder !== null) return;
  deps.dropCaster(record.holder);
  record.holder.removeFromParent();
  record.holder = null;
}

/**
 * Видимое преобразование кадра — в узел записи. Общее у заглушки и детального
 * поддерева: у обоих нарисованное висит на держателе.
 */
export function applyHolderPose(record: InstanceRecord, drawScale: number): void {
  const holder = record.holder;
  if (holder === null) return;
  holder.position.copy(record.pos);
  holder.quaternion.copy(record.quat);
  holder.scale.setScalar(drawScale);
}

/**
 * Неразрешённая запись анимации диагностируется в тот же сток, что и
 * отсутствующая кость (REND-4, REND-5): у подсистемы один адресат жалоб.
 */
export function makeController(
  record: InstanceRecord,
  backend: ConstructorParameters<typeof AnimationController>[0],
  options: ControllerOptions,
  warn: (message: string) => void,
): AnimationController {
  const controller = new AnimationController(backend, record.visual?.animations ?? {}, {
    ...options,
    warn,
  });
  // Запись знает, что сущность мертва (REND-4), а контроллера у инстанса до
  // сих пор не было либо он сменился: модель — разделяемый ассет и вправе
  // ехать сколько угодно (`assets` ASSET-4), ярус переключает пресет
  // (REND-20), а переподача манифеста пересобирает инстанс (REND-17).
  // Фиксация ставится ровно тому контроллеру, который в итоге появился, —
  // иначе труп встал бы живым в тот самый момент, когда его наконец есть чем
  // нарисовать, или в тот, когда сменился его носитель.
  if (record.deathLock) controller.enterDeath();
  return controller;
}
