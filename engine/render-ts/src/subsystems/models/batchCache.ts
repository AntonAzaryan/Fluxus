/**
 * Кэш батчей подсистемы моделей (REND-20, REND-31): по батчу на КЛЮЧ ЗАПИСИ
 * манифеста, а не на инстанс и не на модель. Ключ — модель, набор скрытых
 * частей, вид и ярус теневого кастера: скины и `hiddenParts` — свойства записи
 * (REND-6), а `InstancedMesh` несёт один набор флагов теней на все свои записи
 * (design D3).
 *
 * Кэш переживает опустевший батч намеренно: рисовать ему нечего (`count`
 * нулевой — draw call'а нет), а следующий инстанс той же записи не собирает его
 * заново. Единственная точка, где ключи устаревают, — переподача манифеста, и
 * она же их пересматривает (`retire`).
 */
import * as THREE from 'three';
import {
  resolveLodThresholds,
  resolveVisual,
  type BakedDerivatives,
  type BakedSkinSet,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
} from '@fluxus/assets';
import type { AssetService } from '@fluxus/assets';
import type { RenderCostCounters } from '../../cost.js';
import { ModelBatch, batchLevels } from '../../model/batch.js';
import { BatchSkinLoader, skinArrayTexture } from '../../model/batchSkins.js';
import {
  VAT_MAP_KINDS,
  createSkinPlaceholder,
  createVatDepthMaterial,
  createVatMaterial,
  materialMapKinds,
  type VatMapKind,
  type VatMaterial,
} from '../../model/vatMaterial.js';
import { cachedModelBounds, normalizedScale, type SharedModelData } from '../../model/build.js';
import { own } from '../../footprint.js';
import type { ShadowCasterTier } from '../../types.js';
import {
  boundsFromBaked,
  casterTierOf,
  emptyBounds,
  sameSkinTables,
  scaleBounds,
  tintMaskToken,
  type BatchEntry,
  type InstanceRecord,
} from './instanceRecord.js';

/** Заглушка массива вариантов скина — одна на процесс по тем же основаниям. */
let skinPlaceholder: THREE.DataArrayTexture | null = null;

/**
 * Ключ батча (REND-20): модель, набор скрытых частей, сама запись манифеста и
 * ярус теневого кастера. Запись входит в ключ потому, что скины батча — её
 * свойство (REND-6): две записи на одну модель делят геометрию, но не массив
 * вариантов. Ярус — потому, что `InstancedMesh` несёт ОДИН набор флагов теней
 * на все свои записи: батч обязан быть однороден по ярусу, иначе статика и
 * динамика попадали бы в одну карту (design D3). Расщепляются на практике
 * только статичные модели с двойным происхождением инстансов — ящик, который и
 * decoration, и prop; цена — +1 draw call на такую модель.
 */
function batchKeyOf(record: InstanceRecord): string {
  return batchKey(record.visual, record.kind ?? '', casterTierOf(record));
}

/**
 * Ключ батча из его слагаемых. Отдельной функцией потому, что то же множество
 * ключей считается и НЕ ПО ЗАПИСЯМ: пересмотр кэша на переподаче (REND-31)
 * спрашивает у манифеста, порождает ли он такой ключ, — и вторая сборка ключа
 * для этого разошлась бы с первой при первой же правке состава ключа.
 */
export function batchKey(
  visual: EntityVisual | undefined,
  kind: string,
  tier: ShadowCasterTier,
): string {
  if (visual === undefined) return buildBatchKey(undefined, kind, tier);
  let cache = batchKeys.get(visual);
  if (cache === undefined) {
    cache = { static: new Map(), dynamic: new Map() };
    batchKeys.set(visual, cache);
  }
  const byKind = tier === 'static' ? cache.static : cache.dynamic;
  let key = byKind.get(kind);
  if (key === undefined) {
    key = buildBatchKey(visual, kind, tier);
    byKind.set(kind, key);
  }
  return key;
}

/** Ключи одной записи манифеста по виду — по таблице на ярус кастера. */
interface BatchKeyCache {
  readonly static: Map<string, string>;
  readonly dynamic: Map<string, string>;
}

/**
 * Ключи батчей по ЗАПИСИ манифеста (REND-20). Сборка ключа — сортировка набора
 * скрытых частей и `JSON.stringify`, а спрашивают его на каждом монтировании
 * инстанса: всплеск открытия обзора (FOW-8) — это по сборке ключа на инстанс.
 * Запись манифеста между переподачами неизменна (REND-17), поэтому ключ — её
 * функция, и кэш ключуется самой записью: правленый документ приносит новые
 * объекты записей (REND-17), а прежние уходят вместе со своими таблицами —
 * слабая ссылка не держит ни одной из них.
 */
const batchKeys = new WeakMap<EntityVisual, BatchKeyCache>();

/** Собственно сборка ключа — вход кэша и единственное место, где она написана. */
function buildBatchKey(
  visual: EntityVisual | undefined,
  kind: string,
  tier: ShadowCasterTier,
): string {
  const hidden = [...(visual?.hiddenParts ?? [])].sort((a, b) => a - b).join(',');
  // Маска тинта (REND-40, ASSET-18) в ключе потому, что она СКОМПИЛИРОВАНА в
  // материалы батча: два вида одной модели с разными масками рисуются разными
  // программами, и делить батч им нельзя.
  return JSON.stringify([visual?.model ?? '', hidden, kind, tier, tintMaskToken(visual)]);
}

/** Ключи обоих разделов манифеста (ASSET-9): пространство имён у них одно. */
export function visualKinds(manifest: VisualManifest): readonly string[] {
  const entities = Object.keys(manifest.entities);
  const decorations = manifest.decorations;
  return decorations === undefined ? entities : [...entities, ...Object.keys(decorations)];
}

/**
 * Слушатель готовых слоёв батча: набор приезжает асинхронно (ASSET-4) и может
 * приехать ПОВТОРНО — после переподачи манифеста, правившей таблицу скинов
 * записи (REND-17). Прежние массивы текстур освобождаются здесь: они
 * принадлежат батчу, а не ассету (REND-3).
 */
function batchSkinListener(
  model: NormalizedModel,
  materials: readonly VatMaterial[],
  textures: THREE.DataArrayTexture[],
): (set: BakedSkinSet) => void {
  return (set) => {
    for (const texture of textures) texture.dispose();
    textures.length = 0;
    applySkinArrays(model, materials, set, textures);
  };
}

/**
 * Готовые слои вариантов — в материалы батча (REND-6). Массив текстур один на
 * пару «слот × вид карты»: цветовое пространство у карты нормалей своё, и
 * делить с ней текстуру базового цвета нельзя. Созданные массивы собираются в
 * `created`: освобождать их — дело того, кто их поставил.
 */

function applySkinArrays(
  model: NormalizedModel,
  materials: readonly VatMaterial[],
  set: BakedSkinSet,
  created: THREE.DataArrayTexture[],
): void {
  const cache = new Map<string, THREE.DataArrayTexture | null>();
  model.materials.forEach((source, index) => {
    const material = materials[index];
    if (material !== undefined) applySkinMaps(source, material, set, cache, created);
  });
}

/** Карты одного материала: слот записи → массивная текстура скина, через кэш. */
function applySkinMaps(
  source: NormalizedModel['materials'][number],
  material: VatMaterial,
  set: BakedSkinSet,
  cache: Map<string, THREE.DataArrayTexture | null>,
  created: THREE.DataArrayTexture[],
): void {
  for (const kind of VAT_MAP_KINDS) {
    if (!material.maps.has(kind)) continue;
    const slot = slotOfMap(source, kind);
    if (slot === null) continue;
    const cacheKey = `${slot}:${kind}`;
    let texture = cache.get(cacheKey);
    if (texture === undefined) {
      texture = skinArrayTexture(set, slot, kind);
      cache.set(cacheKey, texture);
      if (texture !== null) created.push(texture);
    }
    if (texture === null) continue;
    setSkinMap(material, kind, texture);
  }
}

/** Слот текстуры записи материала под вид карты; null — карты у записи нет. */
function slotOfMap(
  source: NormalizedModel['materials'][number],
  kind: VatMapKind,
): number | null {
  if (kind === 'base') return source.baseColorTexture;
  if (kind === 'normal') return source.normalTexture;
  return source.emissiveTexture;
}

/** Массивная текстура скина — в тот униформ материала, которому она адресована. */
function setSkinMap(
  material: VatMaterial,
  kind: VatMapKind,
  texture: THREE.DataArrayTexture,
): void {
  if (kind === 'base') material.uniforms.vatSkinBase.value = texture;
  else if (kind === 'normal') material.uniforms.vatSkinNormal.value = texture;
  else material.uniforms.vatSkinEmissive.value = texture;
}

/**
 * Живой кэш батчей одной подсистемы. VAT-текстура приходит колбэком: она
 * принадлежит АССЕТУ и общая всем его батчам (REND-3), а держит её кэш
 * разделяемых данных.
 */
export class BatchCache {
  /**
   * Батчи по ключу записи (REND-20). Живут в кэше наравне с разделяемыми
   * данными ассета: опустевший батч не рисует ничего (`count` нулевой — draw
   * call'а нет), а следующий инстанс той же записи не собирает его заново.
   */
  private readonly entries = new Map<string, BatchEntry>();

  /**
   * Сервис ассетов приходит ФУНКЦИЕЙ: кэш живёт с подсистемой, а контекст
   * рендера — только с `init` (REND-8), и связывать их конструктором значило бы
   * заводить кэш позже подсистемы.
   */
  private readonly assets: () => AssetService;
  private readonly vatTexture: (modelId: string, derivatives: BakedDerivatives) => THREE.DataTexture;
  private readonly onSkinsRebuilt: (entry: BatchEntry) => void;

  constructor(
    assets: () => AssetService,
    vatTexture: (modelId: string, derivatives: BakedDerivatives) => THREE.DataTexture,
    onSkinsRebuilt: (entry: BatchEntry) => void,
  ) {
    this.assets = assets;
    this.vatTexture = vatTexture;
    this.onSkinsRebuilt = onSkinsRebuilt;
  }

  /** Батчей в кэше — граница, которую нормирует REND-31. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Батч по КЛЮЧУ, а не по записи инстанса: у прогрева (FOW-8) записи ещё нет,
   * а батч с материалами и VAT ему уже нужен — иначе их сборку и компиляцию
   * программ оплатил бы кадр первого появления вида.
   */
  ensureByKey(
    visual: EntityVisual | undefined,
    key: string,
    shared: SharedModelData,
    derivatives: BakedDerivatives,
  ): BatchEntry {
    return this.entries.get(key) ?? this.build(visual, key, shared, derivatives);
  }

  /**
   * Компактация видимых записей во всех батчах — последним делом кадра
   * (REND-21): до неё батч не знает ни позы кадра, ни видимости.
   */
  flush(cost: RenderCostCounters | undefined): void {
    for (const entry of this.entries.values()) entry.batch.flush(cost);
  }

  /**
   * Батч записи: `InstancedMesh` на часть каждого уровня, материалы с
   * VAT-патчем, набор вариантов скина. Ключ — модель, набор скрытых частей и
   * сама запись: скины и `hiddenParts` — свойства ЗАПИСИ, и делить между
   * записями их нельзя. Число батчей растёт с числом записей манифеста, а не с
   * числом инстансов — этого REND-20 и требует.
   */
  ensure(
    record: InstanceRecord,
    shared: SharedModelData,
    derivatives: BakedDerivatives,
  ): BatchEntry {
    const visual = record.visual;
    const key = batchKeyOf(record);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // Батч из кэша мог опустеть ЕЩЁ ДО правки скинов записи — например,
      // когда все инстансы вида ушли из доставки, а следом приехала переподача,
      // правившая таблицу скинов этой записи: ключ она не меняет, батч из кэша
      // не уходит (REND-31), а `syncBatchEntry` идёт по ЖИВЫМ записям и пустого
      // батча не видит вовсе. Поэтому набор вариантов сводится с записью здесь
      // же — иначе первый же респавн рисовался бы прежними слоями (REND-17).
      this.syncSkins(existing, visual);
      return existing;
    }
    return this.build(visual, key, shared, derivatives);
  }

  /**
   * Сборка нового батча по слагаемым ключа — общий низ `ensureBatch` и
   * прогрева (`prewarm`): у прогрева записи-инстанса ещё нет, а батч, VAT и
   * материалы уже нужны — иначе их создание и компиляцию программ оплатил бы
   * кадр первого появления вида (FOW-8).
   */
  private build(
    visual: EntityVisual | undefined,
    key: string,
    shared: SharedModelData,
    derivatives: BakedDerivatives,
  ): BatchEntry {
    skinPlaceholder ??= createSkinPlaceholder();
    const placeholder = skinPlaceholder;
    const vatTexture = this.vatTexture(visual?.model ?? '', derivatives);
    // Маска команд-цвета — индексы материалов записи (ASSET-18, REND-40):
    // читает канал только материал внутри маски, и это его свойство, а не
    // свойство инстанса, — поэтому оно компилируется в материал батча.
    const tintMask = visual?.tint === undefined ? null : (visual.tint.materials ?? 'all');
    const materials = shared.model.materials.map((source, index) =>
      createVatMaterial(
        shared.materials[index] ?? own('material', 'models', new THREE.MeshStandardMaterial()),
        vatTexture,
        materialMapKinds(source),
        placeholder,
        tintMask === 'all' || tintMask?.includes(index) === true,
      ),
    );

    // Уровни приходят вместе с владением (REND-31): геометрии цепочки LOD
    // построены для этого батча и отдаются его сносом, части модели — нет.
    const { levels, owned } = batchLevels(shared.meshes, derivatives.lod, visual?.hiddenParts);
    const batch = new ModelBatch({
      materials,
      partVisibility: derivatives.partVisibility,
      levels,
      ownedGeometries: owned,
      // Глубина теневого прохода — тем же вершинным преобразованием VAT, что
      // кадр: иначе тень записи застыла бы в позе покоя (design D4).
      depthMaterial: createVatDepthMaterial(vatTexture),
    });

    const canonical = cachedModelBounds(shared.model, visual?.hiddenParts);
    const canonicalCull = boundsFromBaked(derivatives);
    const normalized = normalizedScale(visual?.scale, shared.model);
    const skinTextures: THREE.DataArrayTexture[] = [];
    const entry: BatchEntry = {
      key,
      batch,
      materials,
      skins: new BatchSkinLoader(
        shared.model,
        visual,
        this.assets(),
        batchSkinListener(shared.model, materials, skinTextures),
      ),
      skinTable: visual?.skins,
      skinTextures,
      model: shared.model,
      canonical,
      canonicalCull,
      normalized,
      bounds: scaleBounds(canonical, normalized, emptyBounds()),
      cullBounds: scaleBounds(canonicalCull, normalized, emptyBounds()),
      thresholds: resolveLodThresholds(visual),
    };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Параметры записи на живом батче (REND-17): масштаб и пороги LOD правятся
   * на месте — они не строятся из разделяемых данных ассета, и пересобирать
   * ради них записи батча незачем.
   */
  syncEntry(entry: BatchEntry, visual: EntityVisual | undefined): void {
    entry.thresholds = resolveLodThresholds(visual);
    this.syncSkins(entry, visual);
    const normalized = normalizedScale(visual?.scale, entry.model);
    if (normalized === entry.normalized) return;
    entry.normalized = normalized;
    scaleBounds(entry.canonical, normalized, entry.bounds);
    scaleBounds(entry.canonicalCull, normalized, entry.cullBounds);
  }

  /**
   * Набор вариантов скина батча после переподачи (REND-17, REND-6). Варианты —
   * свойство ЗАПИСИ, а не инстанса: новый вариант в таблице сдвигает сквозные
   * индексы, а правленый путь существующего меняет пиксели слоя, — и то и
   * другое пересобирает массив слоёв целиком, потому что собран он один раз на
   * батч (ASSET-12).
   *
   * Пересобирается РОВНО набор: позы записей батча, фазы их клипов и сглаженные
   * наклоны остаются на месте — пересборки инстансов здесь нет (REND-11).
   * Запись, чья таблица скинов не изменилась, не получает и этого: таблицы
   * сравниваются по значению, как и всё прочее в переподаче (REND-17).
   */
  private syncSkins(entry: BatchEntry, visual: EntityVisual | undefined): void {
    if (sameSkinTables(entry.skinTable, visual?.skins)) return;
    entry.skinTable = visual?.skins;
    entry.skins.dispose();
    entry.skins = new BatchSkinLoader(
      entry.model,
      visual,
      this.assets(),
      batchSkinListener(entry.model, entry.materials, entry.skinTextures),
    );
    // Сквозные индексы вариантов поехали — каждой записи батча заново (REND-6).
    // Записи знает владелец пулов, а не кэш: он и переставит индексы, получив
    // этот сигнал. Записям, чей скин переподача ещё будет менять, индекс
    // перепишет их собственный `assignSkin` — он идёт после и по тому же набору.
    this.onSkinsRebuilt(entry);
  }

  /**
   * Пересмотр кэша батчей на переподаче манифеста (REND-31): освобождается
   * батч, ключ которого ТЕКУЩИЙ манифест больше не порождает и в котором не
   * нарисовано ни одной записи. Ключ производен от авторских данных (модель ×
   * скрытые части × вид × ярус кастера), и без этого прохода каждая правка
   * модели или набора рисуемых частей записи оставляла бы за собой буферы
   * `InstancedMesh` навсегда.
   *
   * Достижимое множество считается ПО МАНИФЕСТУ, а не по живым записям: батч
   * вида, все инстансы которого сейчас сняты, остаётся в кэше — иначе правило
   * «опустевший батч переживает последнего пользователя» (REND-20) отменялось
   * бы с другой стороны. Оба яруса кастера берутся без разбора: ярус декорации
   * производен от наличия анимаций (REND-4), и второго места, где живёт то же
   * правило, заводить незачем — надмножество ошибается в безопасную сторону,
   * оставляя лишнее, а не освобождая нужное.
   */
  retire(manifest: VisualManifest): void {
    if (this.entries.size === 0) return;
    const reachable = new Set<string>();
    for (const kind of visualKinds(manifest)) {
      const visual = resolveVisual(manifest, kind);
      reachable.add(batchKey(visual, kind, 'static'));
      reachable.add(batchKey(visual, kind, 'dynamic'));
    }
    for (const [key, entry] of this.entries) {
      // Проверка на непустой батч — страховка вглубь, а не ветка со своим
      // случаем: сочетание «ключ недостижим, а записи в батче есть» не
      // построить — всё, из чего сложен ключ, переводит запись в другой батч
      // через `rebuildsInstance`, а запись, чей вид исчез из манифеста, из
      // батча уходит вовсе. Проверка стоит потому, что цена ошибки в множестве
      // достижимых ключей — погашенное нарисованное, а цена страховки — одно
      // сравнение на запись кэша.
      if (reachable.has(key) || entry.batch.count > 0) continue;
      this.release(entry);
      this.entries.delete(key);
    }
  }

  /**
   * Освобождает запись кэша батчей (REND-31): живой набор вариантов скина,
   * массивы текстур слоёв, которые он поставил в материалы, и сам батч с его
   * геометриями и материалами. Массивы принадлежат БАТЧУ, а не ассету (REND-3),
   * поэтому уходят вместе с ним; разделяемые буферы модели не трогаются —
   * их снимает `ModelBatch.dispose` со своей геометрии и отдаёт кэшу ассетов.
   */
  release(entry: BatchEntry): void {
    entry.skins.dispose();
    for (const texture of entry.skinTextures) texture.dispose();
    entry.skinTextures.length = 0;
    entry.batch.dispose();
  }

  /**
   * Диагностика батчевого яруса (REND-20): сколько батчей заведено, сколько
   * инстанс-мешей рисуется в этом кадре и сколько записей в них живёт. По ней и
   * видно главное свойство яруса — число draw calls растёт с числом ЗАПИСЕЙ
   * манифеста, а не с числом инстансов.
   */
  stats(): { readonly batches: number; readonly drawnMeshes: number; readonly records: number } {
    let drawnMeshes = 0;
    let records = 0;
    for (const entry of this.entries.values()) {
      drawnMeshes += entry.batch.drawnMeshes;
      records += entry.batch.count;
    }
    return { batches: this.entries.size, drawnMeshes, records };
  }

  /** Инстанс-меши всех батчей — вход теста компактации (`count` на меш). */
  meshes(): readonly THREE.InstancedMesh[] {
    return [...this.entries.values()].flatMap((entry) => entry.batch.meshes);
  }

  /** Снос подсистемы (REND-31): кэш отдаёт всё, чем владеет. */
  dispose(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }
}
