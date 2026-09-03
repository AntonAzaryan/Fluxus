/**
 * Привязка эмиттера к узлу-сокету инстанса (REND-24) — внутренность подсистемы
 * частиц, вынесенная отдельно от её источников по той же причине, что и пул
 * экземпляров (`particleEffects.ts`): «какие эмиттеры существуют» и «за каким
 * узлом эмиттер следует» — разные вопросы.
 *
 * Дорогая часть здесь одна — поиск узла по имени в дереве инстанса, — и она
 * КЭШИРУЕТСЯ вместе с корнем, из которого узел взят. Каждый кадр сверяется
 * только идентичность корня: так кэш переживает обычный кадр и не переживает
 * пересборку инстанса (REND-17, REND-20), после которой прежнее поддерево
 * отцеплено от сцены и узел из него заморозил бы эмиттер в позе момента
 * пересборки.
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { VisualTier } from '@fluxus/assets';
import type { WarnOnce } from './warnOnce.js';

/**
 * Инстанс глазами подсистемы частиц (REND-24): ярус, которым он нарисован, и
 * корень его дерева узлов. Оба поля нужны, чтобы отличить ДВА состояния, в
 * которых корня нет, — а они требуют разного:
 *
 * - инстанс ещё строится (модель едет, ASSET-4) — узел появится, и поиск
 *   повторяется следующим кадром молча;
 * - инстанс нарисован БАТЧЕВЫМ ярусом (REND-20) — дерева узлов у него не
 *   существует вовсе, и ждать нечего: сокет требует детального яруса, а запись
 *   получает предупреждение один раз и позицию сущности.
 */
interface SocketInstance {
  readonly tier: VisualTier;
  readonly model: { readonly root: THREE.Object3D } | null;
}

/**
 * Мировая поза узла-сокета: позиция и ориентация, записанные в переиспользуемую
 * запись. Аллокаций на эмиттер на кадр нет — объект принадлежит вызывающему.
 */
export interface SocketPose {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
}

/**
 * Инстансы моделей глазами подсистемы частиц — источник узлов-сокетов (REND-24).
 * Подсистема моделей удовлетворяет этому интерфейсу по форме, а импорта её сюда
 * нет: подсистемы друг о друге не знают (REND-8), и знать нужно ровно одно —
 * где в мире стоит названный узел инстанса.
 *
 * Ответов на это ДВА, и первый из них — временный. `instanceFor` отдаёт корень
 * дерева узлов, в котором сокет ищется обходом: так умеет только ДЕТАЛЬНЫЙ ярус
 * (REND-20) — у батчевого дерева узлов не существует вовсе, кости живут в
 * VAT-текстуре, и записи с сокетом на нём играют в позиции сущности с
 * предупреждением. `nodePose` — прямой ответ «где узел», который подсистема
 * моделей вправе дать на ОБОИХ ярусах; появится он у неё — резолв переключается
 * на него одной веткой ниже, и дерево узлов подсистеме частиц больше не нужно.
 *
 * Оба необязательны: источник, не умеющий ни того ни другого, — законный
 * источник без сокетов, и записи с сокетом играют в позиции сущности.
 */
export interface SocketSource {
  instanceFor?(entity: EntityId, decoration?: boolean): SocketInstance | null;
  /**
   * Мировая поза названного узла в кадре; `false` — узла нет (инстанс ещё
   * строится, вид без такого узла). Пишет в `out` и ничего не аллоцирует.
   */
  nodePose?(entity: EntityId, node: string, out: SocketPose, decoration?: boolean): boolean;
}

/** Состояние привязки, которое оболочка эмиттера несёт на себе. */
export interface SocketBinding {
  /** Имя узла из записи манифеста (ASSET-14); не названо — позиция сущности. */
  readonly socketName: string | undefined;
  /** Найденный узел; null — играем в позиции сущности. */
  socket: THREE.Object3D | null;
  /** Корень, в котором узел найден, — по нему и видно, что кэш протух. */
  socketRoot: THREE.Object3D | null;
  /** Из какого набора сущность: нумерация у двух пулов своя (REND-18). */
  readonly decoration: boolean;
}

/** Кэш привязки — заново: узел будет искаться в следующем кадре. */
export function dropSocketCache(binding: SocketBinding): void {
  binding.socket = null;
  binding.socketRoot = null;
}

/**
 * Узел-сокет привязки; null — эмиттер играет в позиции сущности (REND-24).
 *
 * Корня нет по двум разным причинам, и ответы у них разные: инстанса ещё нет
 * либо его модель едет (ASSET-4) — поиск молча повторяется следующим кадром,
 * иначе эмиттер навсегда оставался бы у ног сущности из-за того, что ассет ещё
 * ехал; инстанс нарисован батчевым ярусом (REND-20) — дерева узлов у него нет
 * вовсе, и ждать нечего: предупреждение один раз и позиция сущности. Инстанс
 * есть, а узла в нём нет — то же самое, что у эффектов (REND-23).
 */
export function resolveSocketPose(
  binding: SocketBinding,
  entity: EntityId,
  sockets: SocketSource | undefined,
  warnOnce: WarnOnce,
  out: SocketPose,
): boolean {
  const name = binding.socketName;
  if (name === undefined) return false;
  if (sockets === undefined) {
    warnOnce(
      'socket-source',
      `render: запись эмиттера называет сокет "${name}", но источник инстансов подсистеме не передан — эмиттер играет в позиции сущности (REND-24)`,
    );
    return false;
  }
  // Прямой ответ источника — там, где он есть: он работает на ОБОИХ ярусах
  // (REND-20), и дерева узлов ему не нужно. Ветка одна, и переключение на неё —
  // появление метода у подсистемы моделей, а не правка здесь.
  if (sockets.nodePose !== undefined) {
    dropSocketCache(binding);
    if (sockets.nodePose(entity, name, out, binding.decoration)) return true;
    warnOnce(
      `socket:${name}`,
      `render: узла-сокета "${name}" в инстансе нет — эмиттер играет в позиции сущности (REND-24)`,
    );
    return false;
  }
  const node = resolveSocketNode(binding, entity, sockets, warnOnce);
  if (node === null) return false;
  // Мировая поза узла инстанса — каждый кадр: инстанс уже поставлен подсистемой
  // моделей, а мировая матрица узла обновляется по цепочке родителей, не
  // обходом сцены.
  node.updateWorldMatrix(true, false);
  node.matrixWorld.decompose(out.position, out.quaternion, SCRATCH_SCALE);
  return true;
}

/** Переиспользуемый приёмник масштаба: разложение матрицы требует все три. */
const SCRATCH_SCALE = new THREE.Vector3();

/**
 * Узел-сокет по ДЕРЕВУ инстанса — детальный ярус (REND-20). Кэшируется вместе с
 * корнем: каждый кадр сверяется только идентичность корня.
 */
function resolveSocketNode(
  binding: SocketBinding,
  entity: EntityId,
  sockets: SocketSource,
  warnOnce: WarnOnce,
): THREE.Object3D | null {
  const name = binding.socketName!;
  if (sockets.instanceFor === undefined) {
    warnOnce(
      'socket-source',
      `render: запись эмиттера называет сокет "${name}", но источник инстансов не умеет ни дерева узлов, ни позы узла — эмиттер играет в позиции сущности (REND-24)`,
    );
    return null;
  }
  const instance = sockets.instanceFor(entity, binding.decoration);
  const root = instance?.model?.root ?? null;
  if (root === null) {
    dropSocketCache(binding);
    // Батчевый ярус — не «ещё грузится», а «дерева узлов не будет»: молчать
    // здесь значило бы выдавать отсутствие сокета за незаконченную загрузку.
    if (instance !== null && instance.tier === 'batched') {
      warnOnce(
        `socket-tier:${name}`,
        `render: сокет "${name}" требует детального яруса — эмиттер играет в позиции сущности (REND-24, REND-20)`,
      );
    }
    return null;
  }
  if (root !== binding.socketRoot) {
    binding.socketRoot = root;
    binding.socket = root.getObjectByName(name) ?? null;
    if (binding.socket === null) {
      warnOnce(
        `socket:${name}`,
        `render: узла-сокета "${name}" в инстансе нет — эмиттер играет в позиции сущности (REND-24)`,
      );
    }
  }
  return binding.socket;
}
