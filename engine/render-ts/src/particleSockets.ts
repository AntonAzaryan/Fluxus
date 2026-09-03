/**
 * Привязка эмиттера к узлу-сокету инстанса (REND-24) — внутренность подсистемы
 * частиц, вынесенная отдельно от её источников по той же причине, что и пул
 * экземпляров (`particleEffects.ts`): «какие эмиттеры существуют» и «за каким
 * узлом эмиттер следует» — разные вопросы.
 *
 * Вопрос к источнику здесь ОДИН — «где в мире стоит названный узел инстанса», —
 * и отвечает на него подсистема моделей на ОБОИХ ярусах (REND-20): у батчевого
 * дерева узлов не существует вовсе, кости живут в VAT-текстуре, а поза узла
 * считается одинаково. Обхода дерева инстанса и кэша найденного узла здесь
 * поэтому больше нет — вместе с ними ушло и «сокет требует детального яруса»:
 * ярус на сокеты не влияет.
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { WarnOnce } from './warnOnce.js';

/**
 * Мировая поза узла-сокета: позиция и ориентация, записанные в переиспользуемую
 * запись. Аллокаций на эмиттер на кадр нет — объект принадлежит вызывающему.
 */
export interface SocketPose {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
}

/**
 * Поза узла в форме источника — семь чисел, а не объекты three: так её отдаёт
 * подсистема моделей на обоих ярусах (REND-20), и сюда она ложится без импорта
 * — подсистемы друг о друге не знают (REND-8). Переписывается в `SocketPose`
 * одной переиспользуемой записью на модуль.
 */
export interface SocketNodePose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

const NODE_POSE_SCRATCH: SocketNodePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

/**
 * Инстансы моделей глазами подсистемы частиц (REND-24) — источник поз узлов.
 * Подсистема моделей удовлетворяет этому интерфейсу по форме, а импорта её сюда
 * нет: подсистемы друг о друге не знают (REND-8), и знать нужно ровно одно —
 * где в мире стоит названный узел инстанса.
 *
 * Метод необязателен: источник, не умеющий позы узла, — законный источник без
 * сокетов, и записи с сокетом играют в позиции сущности с предупреждением.
 */
export interface SocketSource {
  /**
   * Мировая поза названного узла в кадре; `false` — узла нет (инстанс ещё
   * строится, вид без такого узла). Пишет в `out` и ничего не аллоцирует.
   */
  nodePose?(entity: EntityId, node: string, out: SocketNodePose, decoration?: boolean): boolean;
}

/**
 * Состояние привязки, которое оболочка эмиттера несёт на себе. Кэша найденного
 * узла в нём больше нет: поза спрашивается у источника каждый кадр, и держаться
 * ему не за что.
 */
export interface SocketBinding {
  /** Имя узла из записи манифеста (ASSET-14); не названо — позиция сущности. */
  readonly socketName: string | undefined;
  /** Из какого набора сущность: нумерация у двух пулов своя (REND-18). */
  readonly decoration: boolean;
}

/**
 * Поза узла-сокета привязки в кадре; `false` — эмиттер играет в позиции
 * сущности (REND-24).
 *
 * Узла нет по двум разным поводам — инстанс ещё строится (ASSET-4) либо вид
 * такого узла не несёт, — и различить их источнику нечем: оба он отдаёт одним
 * `false`. Ответ на оба один: предупреждение ОДИН раз на имя и позиция
 * сущности; молчание выдало бы отсутствие узла за незаконченную загрузку, а
 * предупреждение на кадр залило бы вывод.
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
  if (sockets?.nodePose === undefined) {
    warnOnce(
      'socket-source',
      `render: запись эмиттера называет сокет "${name}", но источник поз узлов подсистеме не передан — эмиттер играет в позиции сущности (REND-24)`,
    );
    return false;
  }
  if (sockets.nodePose(entity, name, NODE_POSE_SCRATCH, binding.decoration)) {
    const pose = NODE_POSE_SCRATCH;
    out.position.set(pose.x, pose.y, pose.z);
    out.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    return true;
  }
  warnOnce(
    `socket:${name}`,
    `render: узла-сокета "${name}" в инстансе нет — эмиттер играет в позиции сущности (REND-24)`,
  );
  return false;
}
