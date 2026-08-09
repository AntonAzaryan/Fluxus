/**
 * @contribution Тройка ED-19 «конфиг сцены + парный presentation-документ +
 * манифест визуалов» как единица записи (ED-25: доменные имена редактируемого
 * живут во вкладе, а не в каркасе). Каркас сохранения знает только «группа
 * документов»; что эти документы значат — знает этот файл.
 *
 * Проверок содержимого здесь нет и не должно быть. Рассинхронизацию пары
 * «prefab — запись манифеста», запись расстановки на несуществующий prefab и
 * ссылку decoration на отсутствующий вид проверяют правила-вклады слоя
 * валидации (`validation/crossDocument.ts`, ED-19, `presentation-scene` PRES-2),
 * и сохранение прогоняет ровно их по состоянию дерева после записи: второе
 * описание того же нарушения — рядом с первым и расходящееся с ним — запрещает
 * ED-30.
 *
 * Парного документа у сцены может не быть вовсе, и это законное состояние —
 * сцена без декораций (PRES-1): группа тогда состоит из двух членов, а не из
 * трёх. Создавать документ ради пустого слоя MUST NOT — сохранение затрагивает
 * только документы с правками (ED-21), и отсутствие члена в группе означает
 * ровно это.
 */
import type { DocumentId } from '../document/types.js';
import type { DocumentGroup } from './save.js';

export interface ScenePairing {
  readonly scene: DocumentId;
  readonly manifest: DocumentId;
  /**
   * Парный presentation-документ сцены (`presentation-scene` PRES-1): лежит
   * рядом с конфигом и находится по правилу имени (`presentationPathOf`), а не
   * по ссылке — ссылок между документами пары нет ни в одну сторону.
   * `undefined` — сцена без декораций.
   */
  readonly presentation?: DocumentId;
}

/** Все документы тройки — та группа, которую сохранение обязано держать вместе. */
export function pairingMembers(pairing: ScenePairing): readonly DocumentId[] {
  return pairing.presentation === undefined
    ? [pairing.scene, pairing.manifest]
    : [pairing.scene, pairing.manifest, pairing.presentation];
}

export function pairingGroup(pairing: ScenePairing): DocumentGroup {
  return { id: pairing.scene, members: pairingMembers(pairing) };
}

/** Группы записи для набора троек — то, что уезжает в `groups` сохранения. */
export function pairingGroups(pairings: readonly ScenePairing[]): readonly DocumentGroup[] {
  return pairings.map(pairingGroup);
}
