/**
 * @contribution Тройка ED-19 «конфиг сцены + парный presentation-документ +
 * манифест визуалов» (ED-25: доменные имена редактируемого живут во вкладе, а
 * не в каркасе). Каркас сохранения знает только «группа документов» и «правило
 * согласованности»; что эти документы значат — знает этот файл.
 *
 * Что здесь проверяется и почему именно это:
 *
 * - **prefab ↔ запись манифеста.** ED-19 называет их одной сущностью авторинга,
 *   физически расщеплённой на два документа, и требует подсвечивать
 *   рассинхронизацию пары.
 * - **запись расстановки → существующий prefab.** Ядро отвергает такой конфиг
 *   сцены на загрузке (SER-8), и доводить его до диска незачем (ED-19).
 *
 * Один манифест обслуживает столько сцен, сколько с ним спарено, поэтому
 * обратное направление («запись без prefab'а») сверяется с объединением
 * префабов всех спаренных с ним сцен: иначе запись чужой сцены читалась бы как
 * расхождение.
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
import { isJsonArray, isJsonObject, type JsonValue } from '../document/json.js';
import type { DocumentId } from '../document/types.js';
import type { ConsistencyIssue, ConsistencyRule, DocumentGroup } from './consistency.js';

export interface ScenePairing {
  readonly scene: DocumentId;
  readonly manifest: DocumentId;
  /** Формата у него ещё нет — см. шапку модуля. */
  readonly presentation?: DocumentId;
}

export const SCENE_PAIR_RULE_ID = 'save.pairing.sceneManifest';

/** Имена префабов конфига сцены: `prefabs` — список записей с полем `name` (ECS-4, SER-7). */
function prefabNames(scene: JsonValue | undefined): string[] {
  if (!isJsonObject(scene)) return [];
  const declared = scene.prefabs;
  if (!isJsonArray(declared)) return [];
  const names: string[] = [];
  for (const prefab of declared) {
    if (isJsonObject(prefab) && typeof prefab.name === 'string') names.push(prefab.name);
  }
  return names;
}

/** Имена префабов, названные записями начальной расстановки (SER-8). */
function placedPrefabs(scene: JsonValue | undefined): { name: string; index: number }[] {
  if (!isJsonObject(scene)) return [];
  const initial = scene.initial;
  if (!isJsonArray(initial)) return [];
  const placed: { name: string; index: number }[] = [];
  initial.forEach((record, index) => {
    if (isJsonObject(record) && typeof record.prefab === 'string') {
      placed.push({ name: record.prefab, index });
    }
  });
  return placed;
}

/** Имена sim-сущностей, у которых есть запись манифеста визуалов (ASSET-6). */
function describedEntities(manifest: JsonValue | undefined): string[] {
  if (!isJsonObject(manifest)) return [];
  const entities = manifest.entities;
  return isJsonObject(entities) ? Object.keys(entities) : [];
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

export function createScenePairRule(pairings: readonly ScenePairing[]): ConsistencyRule {
  return {
    id: SCENE_PAIR_RULE_ID,
    check(view) {
      const issues: ConsistencyIssue[] = [];
      const knownByManifest = new Map<DocumentId, Set<string>>();
      for (const pairing of pairings) {
        let known = knownByManifest.get(pairing.manifest);
        if (known === undefined) {
          known = new Set<string>();
          knownByManifest.set(pairing.manifest, known);
        }
        for (const name of prefabNames(view.value(pairing.scene))) known.add(name);
      }

      for (const pairing of pairings) {
        const document = view.value(pairing.scene);
        const names = new Set(prefabNames(document));
        const described = new Set(describedEntities(view.value(pairing.manifest)));

        for (const name of names) {
          if (described.has(name)) continue;
          issues.push({
            ruleId: SCENE_PAIR_RULE_ID,
            messageKey: 'save.issue.prefabWithoutManifestRecord',
            documentId: pairing.scene,
            detail: { prefab: name, manifest: pairing.manifest },
          });
        }

        for (const { name, index } of placedPrefabs(document)) {
          if (names.has(name)) continue;
          issues.push({
            ruleId: SCENE_PAIR_RULE_ID,
            messageKey: 'save.issue.placementWithoutPrefab',
            documentId: pairing.scene,
            path: ['initial', index],
            detail: { prefab: name },
          });
        }
      }

      for (const [manifest, known] of knownByManifest) {
        for (const name of describedEntities(view.value(manifest))) {
          if (known.has(name)) continue;
          issues.push({
            ruleId: SCENE_PAIR_RULE_ID,
            messageKey: 'save.issue.manifestRecordWithoutPrefab',
            documentId: manifest,
            path: ['entities', name],
            detail: { prefab: name },
          });
        }
      }

      return issues;
    },
  };
}

/** Готовые аргументы сохранения для набора троек: группы записи и правило пары. */
export function scenePairingSave(pairings: readonly ScenePairing[]): {
  readonly groups: readonly DocumentGroup[];
  readonly rules: readonly ConsistencyRule[];
} {
  return {
    groups: pairings.map(pairingGroup),
    rules: pairings.length === 0 ? [] : [createScenePairRule(pairings)],
  };
}
