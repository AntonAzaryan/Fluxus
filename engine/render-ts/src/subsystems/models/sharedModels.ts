/**
 * Кэш РАЗДЕЛЯЕМОЙ части ассетов моделей (REND-3, ASSET-2): построенные из
 * нормализованной модели буферы, материалы и клипы, её запечённые производные
 * (ASSET-12), VAT-текстура, текстуры её скинов и якоря прогретых программ —
 * всё это строится один раз на ассет и живёт, пока живёт подсистема.
 *
 * Кэш ничего не рисует и о носителях яруса не знает: инстансы, ждавшие
 * готовности модели, он отдаёт владельцу пулов колбэком (`onReady`). Разобранный
 * ассет при этом остаётся в модуле ассетов — он не наш, и следующая сцена
 * читает его оттуда, а не грузит заново.
 */
import * as THREE from 'three';
import {
  modelDerivatives,
  type AssetService,
  type AssetState,
  type BakedDerivatives,
  type NormalizedModel,
} from '@fluxus/assets';
import { buildSharedModel, type SharedModelData } from '../../model/build.js';
import { applySkin, createSkinTextureCache, skinTextureSources } from '../../model/skins.js';
import { createVatTexture } from '../../model/vatMaterial.js';
import type { InstanceRecord, SharedEntry } from './instanceRecord.js';

/** Живой кэш одной подсистемы: запись на ассет модели по его адресу (ASSET-2). */
export class SharedModelCache {
    private readonly entries = new Map<string, SharedEntry>();

  private readonly assets: () => AssetService;
  private readonly warn: (message: string) => void;
  /** Модель доехала — ждавшие её инстансы монтирует владелец пулов. */
  private readonly onReady: (record: InstanceRecord, data: SharedModelData) => void;
  /** Fade-копии материалов ассета уходят вместе с ним (FOW-8). */
  private readonly disposeFadeClones: (originals: Iterable<THREE.Material>) => void;

  constructor(
    assets: () => AssetService,
    warn: (message: string) => void,
    onReady: (record: InstanceRecord, data: SharedModelData) => void,
    disposeFadeClones: (originals: Iterable<THREE.Material>) => void,
  ) {
    this.assets = assets;
    this.warn = warn;
    this.onReady = onReady;
    this.disposeFadeClones = disposeFadeClones;
  }

  /** Запись ассета, если он уже спрошен; undefined — о нём ещё не спрашивали. */
  get(modelId: string): SharedEntry | undefined {
    return this.entries.get(modelId);
  }

  ensure(modelId: string): SharedEntry {
    const existing = this.entries.get(modelId);
    if (existing !== undefined) return existing;
    const entry: SharedEntry = {
      data: null,
      failed: null,
      baseSkin: null,
      skinCache: createSkinTextureCache(),
      derivatives: null,
      vatTexture: null,
      warnedDerivatives: false,
      boneIndex: null,
      boneBinds: null,
      warmAnchors: new Map(),
      waiting: new Set(),
    };
    this.entries.set(modelId, entry);

    const handle = this.assets().request<NormalizedModel>('model', modelId);
    const onState = (state: AssetState<NormalizedModel>): void => {
      if (entry.data !== null) return;
      if (state.status === 'ready') {
        // Разделяемая часть строится один раз на ассет (REND-3), запечённые
        // производные — тоже (ASSET-12): десять инстансов не запекают ничего
        // по десять раз, кэш живёт в модуле ассетов по идентичности модели.
        const data = buildSharedModel(state.data);
        entry.data = data;
        entry.failed = null;
        const baked = modelDerivatives(state.data);
        if (baked.ok) {
          entry.derivatives = baked.derivatives;
        } else if (!entry.warnedDerivatives) {
          entry.warnedDerivatives = true;
          this.warn(
            `render: у модели "${modelId}" нет запечённых производных (${baked.reason}) — детальный ярус (REND-20)`,
          );
        }
        // Ждавшие инстансы монтируются владельцем пулов: кэш их не рисует и
        // о носителях яруса не знает (REND-20).
        for (const record of entry.waiting) {
          record.waitingOn = null;
          this.onReady(record, data);
        }
        entry.waiting.clear();
      } else if (state.status === 'failed' && entry.failed !== state.reason) {
        entry.failed = state.reason;
        this.warn(`render: модель "${modelId}" не загрузилась: ${state.reason} — остаётся заглушка (ASSET-4)`);
      }
    };
    onState(this.assets().state(handle));
    this.assets().subscribe(handle, onState);
    return entry;
  }

  /** VAT-текстура модели — одна на ассет и общая для всех её батчей (REND-3). */
  vatTexture(modelId: string, derivatives: BakedDerivatives): THREE.DataTexture {
    const shared = this.entries.get(modelId);
    if (shared?.vatTexture != null) return shared.vatTexture;
    const texture = createVatTexture(derivatives.vat.width, derivatives.vat.height, derivatives.vat.data);
    if (shared !== undefined) shared.vatTexture = texture;
    return texture;
  }

  /**
   * Текстуры САМОЙ модели на её разделяемых материалах — один раз на ассет
   * (REND-3). Лениво, по первому инстансу, которому скин ничего не подменяет:
   * модель, все записи которой перекрывают её слоты, своих текстур не грузит
   * вовсе — они бы никогда не были видны.
   */
  ensureBaseSkin(entry: SharedEntry): void {
    if (entry.baseSkin !== null || entry.data === null) return;
    entry.baseSkin = applySkin(
      entry.data.textureTargets,
      skinTextureSources(entry.data.model, undefined, undefined),
      this.assets(),
      entry.skinCache,
    );
  }

  /**
   * Освобождает разделяемые данные ассета модели (REND-3): буферы геометрии её
   * частей, материалы ассета и VAT-текстуру, общую всем его батчам. Разобранный
   * ассет при этом остаётся в кэше модуля ассетов (ASSET-2) — он не наш, и
   * следующая сцена читает его оттуда, а не грузит заново.
   */
  private release(entry: SharedEntry): void {
    entry.baseSkin?.dispose();
    entry.baseSkin = null;
    entry.vatTexture?.dispose();
    entry.vatTexture = null;
    // Якоря прогрева (FOW-8) — производные тех же материалов и живут с ними:
    // сперва применение скина (оно владеет их текстурами), затем сами якоря.
    for (const anchors of entry.warmAnchors.values()) {
      for (const variant of [anchors.opaque, anchors.faded]) {
        if (variant === null) continue;
        variant.skin.dispose();
        for (const anchor of variant.materials.values()) anchor.dispose();
      }
    }
    entry.warmAnchors.clear();
    // Кэш текстур скинов — после применений, которые их держат: последняя
    // отпущенная ссылка освобождает текстуру сама, а `dispose` кэша добирает
    // то, что осталось за применениями, пережившими ассет (REND-31).
    entry.skinCache.dispose();
    for (const mesh of entry.data?.meshes ?? []) mesh.geometry.dispose();
    // Fade-копии материалов ассета уходят вместе с ними (FOW-8): пул ключуется
    // оригиналом, и без оригинала его записи уже никто не найдёт.
    this.disposeFadeClones(entry.data?.materials ?? []);
    for (const material of entry.data?.materials ?? []) material.dispose();
    entry.waiting.clear();
    entry.data = null;
  }

  /** Снос подсистемы (REND-31): отдаётся всё, что построено из ассетов. */
  dispose(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }
}
