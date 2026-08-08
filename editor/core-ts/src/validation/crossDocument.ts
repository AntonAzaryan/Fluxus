/**
 * @contribution Правила, у которых нет источника в движке (ED-19, ED-11).
 *
 * Всё остальное в слое валидации — вызов чужого валидатора (ED-1). Эти пять
 * правил — исключение, и оно объясняется, а не подразумевается: проверяемое
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
 * - «ссылка decoration не разрешается в запись манифеста» (`presentation-scene`
 *   PRES-2). Загрузчик парного документа манифеста не имеет, а загрузчик
 *   манифеста не знает о парном документе: ссылку не видит ни один из них.
 *   PRES-2 требует подсветить её адресно и сразу — в рантайме та же запись
 *   рисуется заглушкой с предупреждением (ASSET-6), поэтому и здесь это
 *   предупреждение, а не отказ сохранять.
 *
 * Общее правило для всех междокументных: если противоположной стороны в сессии
 * нет ни одного документа, правило молчит. Незагруженный манифест — не
 * рассинхронизация пары, а незагруженный манифест; помечать по нему весь
 * список prefabs значило бы кричать о состоянии редактора, а не о документах.
 *
 * ## Раскладку документов правило не знает
 *
 * Где лежит вторая сторона — вид документа И путь внутри него — правило
 * получает параметром (`DocumentSite`), а не выводит из вида. Правило,
 * знающее раскладку, годно ровно для одного проекта: у реального проекта
 * ассет террейна (TERR-2) лежит полем конфига сцены (SER-7), а не отдельным
 * документом, и правило, читавшее размеры «у документа вида terrain», не
 * срабатывало на нём никогда — а потребитель дописывал сравнение у себя, то
 * есть заводил вторую реализацию правила (ED-1, ED-30). Раскладку знает тот,
 * кто собирает редактор (ED-25); правило знает только отношение.
 */
import { ARENA_PREFAB, TERRAIN_PREFAB } from '@game-mvp/core';
import {
  getAtPath,
  isJsonArray,
  isJsonObject,
  type DocumentId,
  type DocumentKind,
  type DocumentPathRef,
  type EditorDocument,
  type JsonPath,
  type JsonValue,
} from '../document/index.js';
import { compareIds } from '../registry/index.js';
import { ruleDescriptionKey } from './reasons.js';
import type { ValidationRule, ValidationRun } from './types.js';

/**
 * Виды документов, на которых стоят парные правила. Только виды: где внутри
 * документа лежит проверяемое, говорят адреса (`DocumentSite`).
 */
export interface PairKinds {
  readonly scene: DocumentKind;
  readonly manifest: DocumentKind;
  readonly curvature: DocumentKind;
  /** Парный presentation-документ сцены (`presentation-scene` PRES-1). */
  readonly presentation: DocumentKind;
}

export const DEFAULT_PAIR_KINDS: PairKinds = Object.freeze({
  scene: 'scene',
  manifest: 'manifest',
  curvature: 'curvature',
  presentation: 'presentation',
});

/**
 * Адрес места в документе: вид документа и путь внутри него. Форма одна на все
 * правила, которым нужна вторая сторона, — см. «Раскладку документов правило не
 * знает» в шапке файла.
 */
export interface DocumentSite {
  readonly kind: DocumentKind;
  readonly path: JsonPath;
}

/** Где лежит список расстановки (SER-8). */
export type PlacementSite = DocumentSite;

/** Где лежит ассет террейна (TERR-2). */
export type TerrainSite = DocumentSite;

export const DEFAULT_PLACEMENT_SITES: readonly PlacementSite[] = Object.freeze([
  Object.freeze({ kind: 'scene', path: Object.freeze(['initial']) }),
]);

/**
 * Умолчание — террейн отдельным документом, путь пустой: сам документ и есть
 * ассет. Проект, у которого ассет лежит полем конфига сцены (SER-7), подаёт
 * свой адрес: это его раскладка, а не знание правила.
 */
export const DEFAULT_TERRAIN_SITES: readonly TerrainSite[] = Object.freeze([
  Object.freeze({ kind: 'terrain', path: Object.freeze([]) }),
]);

export const PREFABS_PATH: JsonPath = Object.freeze(['prefabs']);
export const ENTITIES_PATH: JsonPath = Object.freeze(['entities']);
/** Раздел decoration-видов манифеста (`assets` ASSET-9). */
export const MANIFEST_DECORATIONS_PATH: JsonPath = Object.freeze(['decorations']);

/**
 * Где в парном документе лежит список размещений (PRES-2). Умолчание, а не
 * знание правила: адрес приносит собирающий редактор — тем же `DocumentSite`,
 * которым он приносит адрес расстановки.
 */
export const DEFAULT_DECORATION_SITES: readonly DocumentSite[] = Object.freeze([
  Object.freeze({ kind: 'presentation', path: Object.freeze(['decorations']) }),
]);

export const VISUAL_FOR_PREFAB_RULE = 'editor.visualForPrefab';
export const PREFAB_FOR_VISUAL_RULE = 'editor.prefabForVisual';
export const PLACEMENT_PREFAB_RULE = 'editor.placementPrefab';
export const CURVATURE_GRID_RULE = 'editor.curvatureGrid';
export const DECORATION_VISUAL_RULE = 'editor.decorationVisual';

/**
 * Коды причин: константами, а не литералами в двух местах. Один и тот же код
 * объявляется правилом (`reasonCodes`) и сообщается находкой, а из пары
 * «правило + код» выводится ключ строки (`reasons.ts`) — набранный дважды, он
 * разошёлся бы ровно так, как расходится запрещённая ED-28 таблица.
 *
 * `MISSING_PREFAB` — один на два правила: «названного prefab'а нет» — одно и то
 * же нарушение, и различает их правило, а не код. Тем же способом `MISSING_VISUAL`
 * делят «prefab без записи манифеста» (ED-19) и «ссылка decoration в никуда»
 * (`presentation-scene` PRES-2): нарушение одно — названной записи манифеста не
 * существует.
 */
const MISSING_VISUAL = 'missingVisual';
const MISSING_PREFAB = 'missingPrefab';
const GRID_MISMATCH = 'gridMismatch';

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
    reasonCodes: [MISSING_VISUAL],
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
          code: MISSING_VISUAL,
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
    reasonCodes: [MISSING_PREFAB],
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
          code: MISSING_PREFAB,
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
    reasonCodes: [MISSING_PREFAB],
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
            code: MISSING_PREFAB,
            params: { name },
          });
        });
      }
    },
  };
}

/**
 * Визуальные ключи манифеста — оба раздела в одном пространстве (ASSET-9).
 * Читаются они здесь путями, а не `visualKeys` модуля ассетов, по той же
 * причине, по какой prefab'ы читаются `prefabNamesOf`: документ в сессии —
 * произвольный JSON, который автор правит прямо сейчас и который может быть
 * поломан, а валидатор ассетов работает по разобранному манифесту и на
 * поломанном отказывает целиком. Правило обязано подсветить ссылку и тогда.
 */
function visualKeysOf(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return [];
  const names: string[] = [];
  for (const path of [ENTITIES_PATH, MANIFEST_DECORATIONS_PATH]) {
    const section = getAtPath(value, path);
    if (isJsonObject(section)) names.push(...Object.keys(section));
  }
  return names;
}

/**
 * PRES-2: `visual` записи decoration, не разрешающийся в запись манифеста
 * визуалов. Ищется он в ОБОИХ разделах (ASSET-9): вид, нужный и prop'у, и
 * декорации, описан один раз, и требовать копии в разделе decoration-видов
 * значило бы чинить норму реализацией.
 *
 * Важность — предупреждение: в рантайме такая запись рисуется заглушкой с
 * предупреждением, а остальная сцена рисуется как обычно (ASSET-6), и делать
 * редактор строже нормы здесь незачем.
 */
export function decorationVisualRule(
  kinds: PairKinds = DEFAULT_PAIR_KINDS,
  sites: readonly DocumentSite[] = DEFAULT_DECORATION_SITES,
): ValidationRule {
  const appliesTo = [...new Set(sites.map((site) => site.kind))].sort(compareIds);
  return {
    id: DECORATION_VISUAL_RULE,
    descriptionKey: ruleDescriptionKey(DECORATION_VISUAL_RULE),
    reasonCodes: [MISSING_VISUAL],
    appliesTo,
    severity: 'warning',
    check(run) {
      // Незагруженный манифест — не оборванная ссылка, а незагруженный
      // манифест: помечать по нему весь список значило бы кричать о состоянии
      // редактора, а не о документах.
      const manifests = run.documentsOfKind(kinds.manifest);
      if (manifests.length === 0) return;
      const known = collect(manifests, ENTITIES_PATH, visualKeysOf, run);
      for (const site of sites) {
        if (site.kind !== run.document.kind) continue;
        const list = getAtPath(run.document.value, site.path);
        if (!isJsonArray(list)) continue;
        list.forEach((entry, index) => {
          if (!isJsonObject(entry)) return;
          const name = entry['visual'];
          // Форму записи проверяет формат (PRES-2): не-строка — его нарушение,
          // а не отсутствующая ссылка, и второго сообщения о ней здесь нет.
          if (typeof name !== 'string' || known.names.has(name)) return;
          run.report({
            path: [...site.path, index, 'visual'],
            expected: { kind: 'reference', targets: known.targets, known: known.sorted },
            code: MISSING_VISUAL,
            params: { name },
          });
        });
      }
    },
  };
}

/** Найденная сетка террейна: где лежит и что там. */
interface FoundGrid {
  readonly documentId: DocumentId;
  readonly value: JsonValue;
}

/**
 * Сетки террейна по адресам. Место, которого в документе нет (сцена без
 * террейна), молчит наравне с незагруженным документом: отсутствие второй
 * стороны — не несовпадение.
 */
function terrainGrids(run: ValidationRun, sites: readonly TerrainSite[]): readonly FoundGrid[] {
  const found: FoundGrid[] = [];
  for (const site of sites) {
    for (const holder of run.documentsOfKind(site.kind)) {
      const value = run.valueOf(holder.id);
      if (value === undefined) continue;
      const grid = getAtPath(value, site.path);
      if (!isJsonObject(grid)) continue;
      found.push({ documentId: holder.id, value: grid });
    }
  }
  return found;
}

/** ED-11: сетка карты кривизны обязана совпасть с сеткой террейна. */
export function curvatureGridRule(
  kinds: PairKinds = DEFAULT_PAIR_KINDS,
  sites: readonly TerrainSite[] = DEFAULT_TERRAIN_SITES,
): ValidationRule {
  return {
    id: CURVATURE_GRID_RULE,
    descriptionKey: ruleDescriptionKey(CURVATURE_GRID_RULE),
    reasonCodes: [GRID_MISMATCH],
    appliesTo: [kinds.curvature],
    // Рантайм переживает несовпадение игнором (ASSET-7) — в редакторе это
    // видимое состояние, а не запрет на сохранение.
    severity: 'warning',
    check(run) {
      const grids = terrainGrids(run, sites);
      if (grids.length === 0) return;
      for (const axis of ['width', 'height'] as const) {
        const mine = getAtPath(run.document.value, [axis]);
        if (typeof mine !== 'number') continue;
        for (const grid of grids) {
          const theirs = getAtPath(grid.value, [axis]);
          if (typeof theirs !== 'number' || theirs === mine) continue;
          run.report({
            path: [axis],
            expected: { kind: 'oneOf', values: [theirs] },
            code: GRID_MISMATCH,
            // `against` — документ-носитель сетки: с чем именно не совпало,
            // автор узнаёт по документу, а не по пути внутри него.
            params: { axis, expected: theirs, against: grid.documentId },
          });
        }
      }
    },
  };
}

/**
 * Междокументные правила одним набором: виды документов проекта и адреса мест,
 * которые правила читают. Оба набора адресов — параметры одной природы, и оба
 * приносит тот, кто собирает редактор.
 */
export function crossDocumentRules(
  kinds: PairKinds = DEFAULT_PAIR_KINDS,
  sites: readonly PlacementSite[] = DEFAULT_PLACEMENT_SITES,
  terrainSites: readonly TerrainSite[] = DEFAULT_TERRAIN_SITES,
  decorationSites: readonly DocumentSite[] = DEFAULT_DECORATION_SITES,
): readonly ValidationRule[] {
  return Object.freeze([
    visualForPrefabRule(kinds),
    prefabForVisualRule(kinds),
    placementPrefabRule(kinds, sites),
    curvatureGridRule(kinds, terrainSites),
    decorationVisualRule(kinds, decorationSites),
  ]);
}
