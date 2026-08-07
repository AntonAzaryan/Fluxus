/**
 * @contribution Правила, у которых нет источника в движке (ED-19, ED-11).
 *
 * Всё остальное в слое валидации — вызов чужого валидатора (ED-1). Эти четыре
 * правила — исключение, и оно объясняется, а не подразумевается: проверяемое
 * ими отношение живёт МЕЖДУ документами, а функции движка каждая видит один
 * документ и про парный не знает.
 *
 * - «prefab без записи манифеста» и «запись манифеста без prefab'а». Ссылки
 *   направлены из манифеста в sim-идентификаторы и только туда (ASSET-6):
 *   загрузчик манифеста не имеет конфига сцены, а `loadScene` не имеет
 *   манифеста. Пары не видит ни один из них, а ED-19 требует подсвечивать её
 *   рассинхронизацию — потому что для автора юнит один, хотя документа два.
 * - «запись расстановки на несуществующий prefab». Ядро это отвергает
 *   (`applyPlacement` → `spawn`, SER-8), но отвергает на загрузке всей сцены,
 *   первым нарушением и без адреса записи; а расстановка по SER-8 — общий
 *   формат трёх документов, и в сценарии или конфиге матча prefabs лежат уже в
 *   другом документе, где ядро её вовсе не проверяет. Правило существует ради
 *   этих двух вещей — адреса записи и междокументного случая, — а не ради
 *   второй копии самой проверки: сцена, поднятая целиком, проверяется вызовом
 *   `loadScene` в `engineRules.ts`, и оба сообщения на одной сцене не
 *   противоречат друг другу, а называют одно нарушение с разной точностью.
 * - «сетка кривизны не совпала с сеткой террейна» (ED-11). Обе стороны знают
 *   только свою сетку; проверка совпадения по ASSET-7 лежит на потребителе,
 *   который держит обе, и в рантайме это предупреждение с игнором — поэтому
 *   важность здесь тоже предупреждение, а не ошибка.
 *
 * Общее правило для всех междокументных: если противоположной стороны в сессии
 * нет ни одного документа, правило молчит. Незагруженный манифест — не
 * рассинхронизация пары, а незагруженный манифест; помечать по нему весь
 * список prefabs значило бы кричать о состоянии редактора, а не о документах.
 */
import { ARENA_PREFAB, TERRAIN_PREFAB } from '@game-mvp/core';
import {
  getAtPath,
  isJsonArray,
  isJsonObject,
  type DocumentKind,
  type DocumentPathRef,
  type EditorDocument,
  type JsonPath,
  type JsonValue,
} from '../document/index.js';
import { compareIds } from '../registry/index.js';
import { ruleDescriptionKey } from './reasons.js';
import type { ValidationRule, ValidationRun } from './types.js';

/** Виды документов и адреса внутри них, на которых стоят парные правила. */
export interface PairKinds {
  readonly scene: DocumentKind;
  readonly manifest: DocumentKind;
  readonly terrain: DocumentKind;
  readonly curvature: DocumentKind;
}

export const DEFAULT_PAIR_KINDS: PairKinds = Object.freeze({
  scene: 'scene',
  manifest: 'manifest',
  terrain: 'terrain',
  curvature: 'curvature',
});

/** Где в документе лежит список расстановки (SER-8). */
export interface PlacementSite {
  readonly kind: DocumentKind;
  readonly path: JsonPath;
}

export const DEFAULT_PLACEMENT_SITES: readonly PlacementSite[] = Object.freeze([
  Object.freeze({ kind: 'scene', path: Object.freeze(['initial']) }),
]);

export const PREFABS_PATH: JsonPath = Object.freeze(['prefabs']);
export const ENTITIES_PATH: JsonPath = Object.freeze(['entities']);

export const VISUAL_FOR_PREFAB_RULE = 'editor.visualForPrefab';
export const PREFAB_FOR_VISUAL_RULE = 'editor.prefabForVisual';
export const PLACEMENT_PREFAB_RULE = 'editor.placementPrefab';
export const CURVATURE_GRID_RULE = 'editor.curvatureGrid';

/**
 * Prefabs, которые сцена поднимет, не объявляя их в документе: носители
 * террейна и арены синтезирует сам загрузчик. Имена берутся константами ядра,
 * а не строками: имя, набранное здесь заново, разъехалось бы с ядром молча.
 */
const SYNTHETIC_PREFABS: readonly string[] = Object.freeze([TERRAIN_PREFAB, ARENA_PREFAB]);

function prefabNamesOf(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return [];
  const list = getAtPath(value, PREFABS_PATH);
  if (!isJsonArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    if (isJsonObject(entry) && typeof entry['name'] === 'string') names.push(entry['name']);
  }
  return names;
}

function entityKeysOf(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return [];
  const entities = getAtPath(value, ENTITIES_PATH);
  return isJsonObject(entities) ? Object.keys(entities) : [];
}

/** Объединение известного по всем документам стороны — плюс сами адреса этих мест. */
interface Known {
  readonly names: ReadonlySet<string>;
  readonly sorted: readonly string[];
  readonly targets: readonly DocumentPathRef[];
}

function collect(
  documents: readonly EditorDocument[],
  path: JsonPath,
  namesOf: (value: JsonValue | undefined) => readonly string[],
  run: ValidationRun,
  extra: readonly string[] = [],
): Known {
  const names = new Set<string>(extra);
  const targets: DocumentPathRef[] = [];
  for (const document of documents) {
    for (const name of namesOf(run.valueOf(document.id))) names.add(name);
    targets.push({ documentId: document.id, path });
  }
  return { names, sorted: [...names].sort(compareIds), targets: Object.freeze(targets) };
}

/** ED-19: prefab, у которого нет записи манифеста, — половина пары. */
export function visualForPrefabRule(kinds: PairKinds = DEFAULT_PAIR_KINDS): ValidationRule {
  return {
    id: VISUAL_FOR_PREFAB_RULE,
    descriptionKey: ruleDescriptionKey(VISUAL_FOR_PREFAB_RULE),
    appliesTo: [kinds.scene],
    check(run) {
      const manifests = run.documentsOfKind(kinds.manifest);
      if (manifests.length === 0) return;
      const known = collect(manifests, ENTITIES_PATH, entityKeysOf, run);
      const list = getAtPath(run.document.value, PREFABS_PATH);
      if (!isJsonArray(list)) return;
      list.forEach((entry, index) => {
        if (!isJsonObject(entry)) return;
        const name = entry['name'];
        if (typeof name !== 'string' || known.names.has(name)) return;
        run.report({
          path: [...PREFABS_PATH, index, 'name'],
          expected: { kind: 'reference', targets: known.targets, known: known.sorted },
          code: 'missingVisual',
          params: { name },
        });
      });
    },
  };
}

/** ED-19: запись манифеста, за которой нет prefab'а, — вторая половина пары. */
export function prefabForVisualRule(kinds: PairKinds = DEFAULT_PAIR_KINDS): ValidationRule {
  return {
    id: PREFAB_FOR_VISUAL_RULE,
    descriptionKey: ruleDescriptionKey(PREFAB_FOR_VISUAL_RULE),
    appliesTo: [kinds.manifest],
    check(run) {
      const scenes = run.documentsOfKind(kinds.scene);
      if (scenes.length === 0) return;
      const known = collect(scenes, PREFABS_PATH, prefabNamesOf, run, SYNTHETIC_PREFABS);
      for (const name of entityKeysOf(run.document.value)) {
        if (known.names.has(name)) continue;
        run.report({
          path: [...ENTITIES_PATH, name],
          expected: { kind: 'reference', targets: known.targets, known: known.sorted },
          code: 'missingPrefab',
          params: { name },
        });
      }
    },
  };
}

/**
 * ED-19: запись расстановки на несуществующий prefab. Адресуется сама запись —
 * ради этого правило и написано (см. шапку файла).
 */
export function placementPrefabRule(
  kinds: PairKinds = DEFAULT_PAIR_KINDS,
  sites: readonly PlacementSite[] = DEFAULT_PLACEMENT_SITES,
): ValidationRule {
  const appliesTo = [...new Set(sites.map((site) => site.kind))].sort(compareIds);
  return {
    id: PLACEMENT_PREFAB_RULE,
    descriptionKey: ruleDescriptionKey(PLACEMENT_PREFAB_RULE),
    appliesTo,
    check(run) {
      const scenes = run.documentsOfKind(kinds.scene);
      if (scenes.length === 0) return;
      const known = collect(scenes, PREFABS_PATH, prefabNamesOf, run, SYNTHETIC_PREFABS);
      for (const site of sites) {
        if (site.kind !== run.document.kind) continue;
        const list = getAtPath(run.document.value, site.path);
        if (!isJsonArray(list)) continue;
        list.forEach((entry, index) => {
          if (!isJsonObject(entry)) return;
          const name = entry['prefab'];
          // Форму записи проверяет ядро (SER-8): не-строка — его нарушение, а
          // не отсутствующая ссылка, и второго сообщения о ней здесь не будет.
          if (typeof name !== 'string' || known.names.has(name)) return;
          run.report({
            path: [...site.path, index, 'prefab'],
            expected: { kind: 'reference', targets: known.targets, known: known.sorted },
            code: 'missingPrefab',
            params: { name },
          });
        });
      }
    },
  };
}

/** ED-11: сетка карты кривизны обязана совпасть с сеткой террейна. */
export function curvatureGridRule(kinds: PairKinds = DEFAULT_PAIR_KINDS): ValidationRule {
  return {
    id: CURVATURE_GRID_RULE,
    descriptionKey: ruleDescriptionKey(CURVATURE_GRID_RULE),
    appliesTo: [kinds.curvature],
    // Рантайм переживает несовпадение игнором (ASSET-7) — в редакторе это
    // видимое состояние, а не запрет на сохранение.
    severity: 'warning',
    check(run) {
      const grids = run.documentsOfKind(kinds.terrain);
      if (grids.length === 0) return;
      for (const axis of ['width', 'height'] as const) {
        const mine = getAtPath(run.document.value, [axis]);
        if (typeof mine !== 'number') continue;
        for (const grid of grids) {
          const value = run.valueOf(grid.id);
          const theirs = value === undefined ? undefined : getAtPath(value, [axis]);
          if (typeof theirs !== 'number' || theirs === mine) continue;
          run.report({
            path: [axis],
            expected: { kind: 'oneOf', values: [theirs] },
            code: 'gridMismatch',
            params: { axis, expected: theirs, against: grid.id },
          });
        }
      }
    },
  };
}

/** Междокументные правила одним набором. */
export function crossDocumentRules(
  kinds: PairKinds = DEFAULT_PAIR_KINDS,
  sites: readonly PlacementSite[] = DEFAULT_PLACEMENT_SITES,
): readonly ValidationRule[] {
  return Object.freeze([
    visualForPrefabRule(kinds),
    prefabForVisualRule(kinds),
    placementPrefabRule(kinds, sites),
    curvatureGridRule(kinds),
  ]);
}
