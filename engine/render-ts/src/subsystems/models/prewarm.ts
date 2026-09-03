/**
 * Прогрев подсистемы моделей до первого кадра (`fog-of-war` FOW-8, REND-31).
 *
 * Первое появление вида в матче с туманом — это ВСПЛЕСК ОТКРЫТИЯ ОБЗОРА: пачка
 * инстансов одной модели за одну доставку. Всё, что этот кадр иначе построил бы
 * сам, — разделяемая часть ассета, запечённые производные (ASSET-12), батчи с
 * их материалами и VAT-текстурами, образцы детальных видов и якоря шейдерных
 * программ — строится здесь, во время загрузки, где платить за это некому.
 *
 * Наблюдаемого состояния прогрев не меняет и счётчиков стоимости не двигает
 * (PERF-3 меряет доставку и кадр): не доехавшая модель прогрев не держит — её
 * вид смонтируется прежним ленивым путём с заглушкой (ASSET-4).
 */
import * as THREE from 'three';
import {
  resolveVisual,
  type BakedDerivatives,
  type DecodedImage,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
  type VisualTier,
} from '@fluxus/assets';
import type { RenderContext, ShadowCasterTier } from '../../types.js';
import { createModelInstance, type ModelInstance, type SharedModelData, type TextureTarget } from '../../model/build.js';
import { applySkin, skinTextureSources, type SkinTextureSource } from '../../model/skins.js';
import { own } from '../../footprint.js';
import { BatchCache, batchKey, visualKinds } from './batchCache.js';
import { SharedModelCache } from './sharedModels.js';
import {
  animatedVisual,
  declaredTier,
  type BatchEntry,
  type SharedEntry,
  type WarmAnchors,
  type WarmVariant,
} from './instanceRecord.js';

/**
 * Результат прогрева подсистемы моделей (`prewarm`): паркуемые корни для
 * компиляции программ тёплой сценой и текстуры для заливки на GPU до первого
 * кадра. `finish()` возвращает прогретое: образцы сносятся, батч-группы
 * отпускаются из тёплой сцены (и, если за время прогрева к батчу успела
 * привязаться живая запись, встают в настоящую); якоря программ остаются жить
 * с ассетом.
 *
 * Ступени ДВЕ, и разделены они по входу, а не по вкусу: `roots` строятся из
 * одних моделей, `anchoredRoots()` — ещё и из текстур скина (REND-6). Ассет
 * вправе стоять в `loading` неограниченно (ASSET-4), и одна застрявшая текстура
 * не должна отменять прогрев батчей, VAT-текстур и образцов, которым она не
 * нужна вовсе.
 */
export interface ModelsPrewarm {
  /**
   * Первая ступень: корни вне сцены — батч-группы и образцы детальных видов.
   * Ждут только своих МОДЕЛЕЙ. Рисовать их нельзя.
   */
  readonly roots: readonly THREE.Object3D[];
  /** Текстуры прогретых батчей (VAT) — вход `WebGLRenderer.initTexture`. */
  readonly textures: readonly THREE.Texture[];
  /**
   * Вторая ступень: образцы детальных видов под ЯКОРЯМИ программ (FOW-8) —
   * материалами с текстурами записи, теми же, какими рисует матч. Обещание
   * разрешается, когда доедут текстуры скина, и собирающий вправе не дожидаться
   * его вовсе: прогрев тогда сделает меньше, но сделает.
   *
   * Каждый вид даёт непрозрачный образец, а вид СУЩНОСТИ — ещё и прозрачный:
   * угасание (FOW-8) есть только у неё, decoration не угасает никогда (REND-18).
   * Корни первой ступени сюда не попадают — они уже отданы `roots`.
   */
  anchoredRoots(): Promise<readonly THREE.Object3D[]>;
  finish(): void;
}

/** Хозяйство подсистемы, без которого прогрев не построит ни батча, ни образца. */
export interface PrewarmDeps {
  readonly ctx: () => RenderContext;
  readonly manifest: () => VisualManifest;
  readonly shared: SharedModelCache;
  readonly batches: BatchCache;
  /** Ярус записей, ярус не назвавших (QUAL-1): прогревается действующий. */
  readonly defaultTier: () => VisualTier;
}

/**
 * Детальный вид, ждущий второй ступени прогрева (FOW-8): что построить, когда
 * доедут его текстуры скина. Источники слотов посчитаны один раз — ими же
 * ключуется набор якорей и по ним же спрашиваются ожидания.
 */
interface AnchorPlan {
  readonly entry: SharedEntry;
  readonly data: SharedModelData;
  readonly options: { scale?: number; hiddenParts?: readonly number[] };
  /** Вид пришёл из раздела decoration манифеста (ASSET-9, REND-18). */
  readonly decoration: boolean;
  readonly sources: ReadonlyMap<number, SkinTextureSource>;
}

/**
 * Накопитель обхода видов манифеста при прогреве: пять списков, которые обход
 * заполняет, — одной записью, чтобы шаг вида не тянул их пятью аргументами.
 */
interface WarmCollect {
  readonly roots: THREE.Object3D[];
  readonly textures: THREE.Texture[];
  readonly warmBatches: BatchEntry[];
  readonly warmDetailed: ModelInstance[];
  readonly plan: AnchorPlan[];
}

/**
 * Ключ набора якорей прогрева (FOW-8) — слоты, которые запись действительно
 * ЗАНИМАЕТ: те, у которых есть источник и есть место употребления в материалах
 * модели. Именно занятость входит в ключ программы three (`mapUv` и соседи), а
 * какая текстура в слоте — нет: две записи с разными скинами одних и тех же
 * слотов делят якоря, а запись, чей скин занял слот, пустой у модели, получает
 * свои (REND-6).
 */
function warmAnchorKey(
  sources: ReadonlyMap<number, SkinTextureSource>,
  data: SharedModelData,
): string {
  const occupied: number[] = [];
  for (const slot of sources.keys()) {
    if ((data.textureTargets.get(slot)?.length ?? 0) > 0) occupied.push(slot);
  }
  occupied.sort((a, b) => a - b);
  return occupied.join(',');
}

/**
 * Материалы образца прогрева — якорями своего варианта (FOW-8): компилируется
 * ровно то, чем рисует матч. Меш, материала которого среди якорей нет (модель
 * без материалов рисуется своей заглушкой, `createModelInstance`), остаётся как
 * был — прогревать у него нечего.
 */
function applyWarmAnchors(
  instance: ModelInstance,
  anchors: ReadonlyMap<THREE.Material, THREE.MeshStandardMaterial>,
): void {
  for (const mesh of instance.meshes) {
    const current = mesh.material;
    if (Array.isArray(current)) continue;
    const anchor = anchors.get(current);
    if (anchor !== undefined) mesh.material = anchor;
  }
}

/** Прогреватель одной подсистемы: живёт с ней, зовётся сборкой до первого кадра. */
export class Prewarmer {
  private readonly deps: PrewarmDeps;

  constructor(deps: PrewarmDeps) {
    this.deps = deps;
  }

  prewarm(): Promise<ModelsPrewarm> {
    const ctx = this.deps.ctx();
    const waits: Promise<void>[] = [];
    for (const kind of visualKinds(this.deps.manifest())) {
      const visual = resolveVisual(this.deps.manifest(), kind);
      if (visual === undefined) continue;
      const entry = this.deps.shared.ensure(visual.model);
      if (entry.data !== null || entry.failed !== null) continue;
      // Ожидание исхода загрузки: подписка приносит текущее состояние
      // немедленно (ASSET-4), поэтому уже решённый ассет промиса не задержит.
      const handle = ctx.assets.request<NormalizedModel>('model', visual.model);
      waits.push(
        new Promise<void>((resolve) => {
          ctx.assets.subscribe(handle, (state) => {
            if (state.status !== 'loading') resolve();
          });
        }),
      );
    }
    return Promise.all(waits).then(() => this.collectWarm());
  }

  /**
   * Ожидание текстур, которыми будут нарисованы якоря прогрева (FOW-8, REND-6):
   * слоты модели плюс подмены скина записи, по одному ожиданию на путь. Ждать
   * их обязан прогрев, а не матч: слот, занятый текстурой, и слот пустой — это
   * РАЗНЫЕ программы, и прогретая «пустая» матчу не пригодится.
   *
   * Спрашиваются ровно те виды, что попали в план якорей, — детальные (у
   * батчевого угасание идёт пер-инстансным атрибутом альфы в разделяемом
   * VAT-материале, прозрачном всегда, и якорей ему не нужно). Первая ступень
   * прогрева этих ожиданий не видит вовсе.
   */
  private warmSkinWaits(plan: readonly AnchorPlan[]): Promise<void>[] {
    const ctx = this.deps.ctx();
    const waits: Promise<void>[] = [];
    const requested = new Set<string>();
    for (const item of plan) {
      for (const source of item.sources.values()) {
        if (source.kind !== 'path' || requested.has(source.path)) continue;
        requested.add(source.path);
        const handle = ctx.assets.request<DecodedImage>('texture', source.path);
        waits.push(
          new Promise<void>((resolve) => {
            ctx.assets.subscribe(handle, (state) => {
              if (state.status !== 'loading') resolve();
            });
          }),
        );
      }
    }
    return waits;
  }

  /**
   * Якоря прогретых программ модели (FOW-8) со скином записи поверх. Набор общий
   * у записей с одинаковой ЗАНЯТОСТЬЮ СЛОТОВ, а не у всех записей модели: какая
   * именно текстура стоит в слоте, ключа программы не меняет — меняет его лишь
   * то, занят слот или пуст, а подмена скина вправе занять слот, пустой у самой
   * модели (REND-6, `skinTextureSources`).
   *
   * Прозрачный вариант строится, только когда о нём спросили (`withFaded`):
   * угасание есть у видов сущностей, а decoration не угасает никогда (REND-18),
   * и модели, которую рисуют одни декорации, прозрачные якоря с их текстурами
   * достались бы мёртвым грузом. Спрошенный позже — достраивается к тому же
   * набору, а не рядом с ним.
   *
   * Якоря не рисуются ни одного кадра и живут до сноса ассета: пока материал
   * жив, `usedTimes` его программы не падает до нуля, и three её не удаляет.
   * Это и есть страховка прогрева — эпизод угасания, чья копия почему-либо
   * освободилась, всё равно найдёт программу в кэше three, а не соберёт её.
   */
  private ensureWarmAnchors(item: AnchorPlan, withFaded: boolean): WarmAnchors | null {
    const data = item.entry.data;
    if (data === null) return null;
    const key = warmAnchorKey(item.sources, data);
    const anchors = item.entry.warmAnchors.get(key)
      ?? { opaque: this.buildWarmVariant(item.entry, data, item.sources, false), faded: null };
    if (withFaded && anchors.faded === null) {
      anchors.faded = this.buildWarmVariant(item.entry, data, item.sources, true);
    }
    item.entry.warmAnchors.set(key, anchors);
    return anchors;
  }

  /** Один вариант якорей: копии материалов модели со скином записи (FOW-8). */
  private buildWarmVariant(
    entry: SharedEntry,
    data: SharedModelData,
    sources: ReadonlyMap<number, SkinTextureSource>,
    transparent: boolean,
  ): WarmVariant {
    const materials = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    for (const material of data.materials) {
      // Якорь прогрева — копия материала ассета, живущая в записи `warmAnchors`
      // и отдаваемая `releaseShared` (FOW-8, REND-31): в учёт (PERF-8) она
      // входит наравне с прочими материалами подсистемы.
      const anchor = own('material', 'models', material.clone());
      // Только вверх: непрозрачный вариант оставляет `transparent` записи
      // ассета (`materialFromAsset` берёт его из `alphaMode`), прозрачный —
      // поднимает, и ровно это и есть бит `opaque` ключа программы.
      if (transparent) anchor.transparent = true;
      materials.set(material, anchor);
    }
    // Места употребления слота те же, что у ассета (`collectTextureTargets`),
    // только материалы другие.
    const targets = new Map<number, TextureTarget[]>();
    for (const [slot, places] of data.textureTargets) {
      const remapped: TextureTarget[] = [];
      for (const place of places) {
        const anchor = materials.get(place.material);
        if (anchor !== undefined) remapped.push({ material: anchor, map: place.map });
      }
      targets.set(slot, remapped);
    }
    // Текстуры якорей — те же, что у живых инстансов (REND-6): якорь держит
    // ссылку в кэше ассета, а не свою копию тех же пикселей.
    return { materials, skin: applySkin(targets, sources, this.deps.ctx().assets, entry.skinCache) };
  }

  /**
   * Прогрев одного вида манифеста. Ярус решается тем же объявлением, что и у
   * живой записи (REND-20): батчевый греется группой батча, детальный —
   * образцом инстанса.
   */
  private warmKind(kind: string, out: WarmCollect): void {
    const visual = resolveVisual(this.deps.manifest(), kind);
    if (visual === undefined) return;
    const entry = this.deps.shared.get(visual.model);
    const data = entry?.data ?? null;
    if (entry === undefined || data === null) return;
    // Происхождение вида нужно ОБОИМ ярусам: батчевому — как ярус кастера,
    // детальному — как ответ на вопрос, бывает ли у вида угасание вообще.
    const decoration = this.deps.manifest().entities[kind] === undefined;
    const derivatives = entry.derivatives;
    if (declaredTier(visual, this.deps.defaultTier()) === 'batched' && derivatives !== null) {
      this.warmBatchedKind(visual, kind, data, entry, derivatives, decoration, out);
      return;
    }
    this.warmDetailedKind(visual, data, entry, decoration, out);
  }

  /** Батчевый ярус вида: группа батча и его VAT-текстура (REND-20). */
  private warmBatchedKind(
    visual: EntityVisual,
    kind: string,
    data: SharedModelData,
    entry: SharedEntry,
    derivatives: BakedDerivatives,
    decoration: boolean,
    out: WarmCollect,
  ): void {
    // Ярус кастера — та же производная данных, что у живой записи
    // (`casterTierOf`): вид сущности динамичен всегда, decoration статичен,
    // пока запись не объявила анимаций.
    const tier: ShadowCasterTier = decoration && !animatedVisual(visual) ? 'static' : 'dynamic';
    const key = batchKey(visual, kind, tier);
    const batchEntry =
      this.deps.batches.ensureByKey(visual, key, data, derivatives);
    if (entry.vatTexture !== null) out.textures.push(entry.vatTexture);
    if (batchEntry.batch.group.parent === null) {
      out.roots.push(batchEntry.batch.group);
      out.warmBatches.push(batchEntry);
    }
  }

  /**
   * Детальный ярус строится на инстанс — прогревается образец: скелет,
   * SkinnedMesh-биндинги и программы его материалов, плюс кэш границ.
   */
  private warmDetailedKind(
    visual: EntityVisual,
    data: SharedModelData,
    entry: SharedEntry,
    decoration: boolean,
    out: WarmCollect,
  ): void {
    const options: { scale?: number; hiddenParts?: readonly number[] } = {};
    if (visual.scale !== undefined) options.scale = visual.scale;
    if (visual.hiddenParts !== undefined) options.hiddenParts = visual.hiddenParts;
    const instance = createModelInstance(data, options);
    out.roots.push(instance.root);
    out.warmDetailed.push(instance);
    // Якорям нужны ещё и текстуры скина — они уходят во ВТОРУЮ ступень
    // (`anchoredRoots`), чтобы застрявшая текстура не отменила эту.
    out.plan.push({
      entry,
      data,
      options,
      decoration,
      sources: skinTextureSources(data.model, visual, visual.defaultSkin),
    });
  }

  /** Тёплые корни по доехавшим моделям — низ `prewarm`, после ожидания моделей. */
  private collectWarm(): ModelsPrewarm {
    const roots: THREE.Object3D[] = [];
    const textures: THREE.Texture[] = [];
    const warmBatches: BatchEntry[] = [];
    const warmDetailed: ModelInstance[] = [];
    const plan: AnchorPlan[] = [];
    const collect: WarmCollect = { roots, textures, warmBatches, warmDetailed, plan };
    for (const kind of visualKinds(this.deps.manifest())) {
      this.warmKind(kind, collect);
    }
    let finished = false;
    return {
      roots,
      textures,
      anchoredRoots: async () => {
        await Promise.all(this.warmSkinWaits(plan));
        // Пока ждали текстуры, прогрев мог быть уже свёрнут: строить образцы
        // теперь некому и незачем — сносить их было бы уже нечем.
        if (finished) return [];
        const anchored: THREE.Object3D[] = [];
        for (const item of plan) {
          const anchors = this.ensureWarmAnchors(item, !item.decoration);
          if (anchors === null) continue;
          anchored.push(this.warmAnchoredSample(item, anchors.opaque, warmDetailed));
          // Прозрачный образец — только виду СУЩНОСТИ (FOW-8): угасание есть у
          // неё, а decoration не угасает никогда (REND-18) — ни `syncPool`, ни
          // `poseAll` не дают его записи долю меньше единицы. Прогревать
          // вариант, которого не нарисует ни один кадр, значит платить за него
          // компиляцией во время загрузки и держать его материалы всю сессию.
          if (anchors.faded === null) continue;
          anchored.push(this.warmAnchoredSample(item, anchors.faded, warmDetailed));
        }
        return anchored;
      },
      finish: () => {
        finished = true;
        // Образцы сносятся, ЯКОРЯ остаются (FOW-8): своих материалов у образца
        // нет — скин ставился в якоря, а не через copy-on-write инстанса, — и
        // `dispose` их не трогает. Тем они программы и держат: освободи прогрев
        // свои материалы здесь, three удалила бы программы вместе с ними, и
        // компиляция вернулась бы в первый же кадр, которому они нужны.
        for (const instance of warmDetailed) {
          instance.root.removeFromParent();
          instance.dispose();
        }
        warmDetailed.length = 0;
        for (const batchEntry of warmBatches) {
          const group = batchEntry.batch.group;
          group.removeFromParent();
          // Запись, привязавшаяся ЗА ВРЕМЯ прогрева, свою точку входа в сцену
          // уже пропустила (`attachBatched` видел родителем тёплую сцену):
          // батч с живыми записями возвращается в сцену здесь.
          if (batchEntry.batch.count > 0) this.deps.ctx().scene.add(group);
        }
      },
    };
  }

  /** Образец второй ступени под якорями варианта; сносится общим `finish`. */
  private warmAnchoredSample(
    item: AnchorPlan,
    variant: WarmVariant,
    warmDetailed: ModelInstance[],
  ): THREE.Object3D {
    const instance = createModelInstance(item.data, item.options);
    applyWarmAnchors(instance, variant.materials);
    warmDetailed.push(instance);
    return instance.root;
  }
}
