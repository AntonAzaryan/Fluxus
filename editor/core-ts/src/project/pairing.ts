/**
 * @contribution Тройка ED-19 «конфиг сцены + парный presentation-документ +
 * манифест визуалов» как единица записи (ED-25: доменные имена редактируемого
 * живут во вкладе, а не в каркасе). Каркас сохранения знает только «группа
 * документов»; что эти документы значат — знает этот файл.
 *
 * Проверок содержимого здесь нет и не должно быть. Рассинхронизацию пары
 * «prefab — запись манифеста» и запись расстановки на несуществующий prefab
 * проверяют правила-вклады слоя валидации (`validation/crossDocument.ts`,
 * ED-19), и сохранение прогоняет ровно их по состоянию дерева после записи:
 * второе описание того же нарушения — рядом с первым и расходящееся с ним —
 * запрещает ED-30.
 *
 * ## Шов третьего документа
 *
 * `ScenePairing.presentation` — парный presentation-документ сцены. Его
 * нормативного формата не существует: capability `presentation-scene-layer` —
 * стаб. Поэтому о его содержимом здесь не проверяется ничего; выдумать формат
 * ради проверки значило бы нормировать его реализацией. Всё, что о нём известно
 * сегодня и чего требует ED-21, — он член тройки, и его правки уходят на диск
 * вместе с правками остальных её членов. Это выражено включением его в
 * `DocumentGroup` и от формата не зависит.
 */
import type { DocumentId } from '../document/types.js';
import type { DocumentGroup } from './save.js';

export interface ScenePairing {
  readonly scene: DocumentId;
  readonly manifest: DocumentId;
  /** Формата у него ещё нет — см. шапку модуля. */
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
