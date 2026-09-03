/**
 * Документы эмиттерных ассетов подсистемы частиц (ASSET-14, REND-24) и
 * отключение луча свежим батчам (REND-15) — две служебные заботы, вынесенные из
 * подсистемы по той же причине, что пул экземпляров и набор оболочек: «какие
 * эмиттеры существуют» и «откуда берётся документ» — разные вопросы.
 *
 * Собственного состояния сверх кэша документов здесь нет: сервис ассетов
 * спрашивается в момент обращения, а не запоминается, — редактор выбрасывает
 * его целиком, когда дерево контента изменилось (ED-15), и снимок означал бы
 * второй ответ на вопрос «загрузился ли этот ассет» (ASSET-2).
 */
import type { AssetService, AssetState, ParticleEffectDocument } from '@fluxus/assets';
import type { BatchedRenderer } from 'three.quarks';
import { ownBatchMaterials } from '../particleEffects.js';
import type { WarnOnce } from '../warnOnce.js';

/** Вид эмиттерного ассета в реестре загрузчиков (ASSET-14). */
export const EFFECT_ASSET_KIND = 'particle-effect';

/** Документ эффекта: `null` — ещё грузится либо недоступен (ASSET-4). */
interface EffectAsset {
  doc: ParticleEffectDocument | null;
}

/** Кэш документов эффектов по asset id: один запрос на ссылку (ASSET-2). */
export class EffectDocuments {
  private readonly warnOnce: WarnOnce;
  private readonly assets = new Map<string, EffectAsset>();

  constructor(warnOnce: WarnOnce) {
    this.warnOnce = warnOnce;
  }

  /**
   * Документ эффекта по asset id (ASSET-3): запрашивается один раз на ссылку и
   * доезжает подпиской — тем же входом, которым подсистема моделей получает
   * модели (ASSET-6). null — ещё грузится либо недоступен: запись пропускается
   * молча до отказа и с предупреждением один раз после него (REND-24).
   */
  get(service: AssetService, id: string): ParticleEffectDocument | null {
    const known = this.assets.get(id);
    if (known !== undefined) return known.doc;
    const asset: EffectAsset = { doc: null };
    this.assets.set(id, asset);
    // Сам ЗАПРОС тоже способен отказать синхронно — например, когда тот же
    // адрес уже загружен под другим видом ассета (ASSET-3: ключ реестра — пара
    // «вид + формат», и модель по адресу эффекта — конфликт видов). Для
    // подсистемы это такая же негодная ссылка, как отказ загрузки, и ответ на
    // неё тот же: предупреждение один раз и пропуск записи, а не отказ кадра
    // (REND-24, ASSET-6) — исключение отсюда роняло бы весь кадровый цикл.
    try {
      const handle = service.request<ParticleEffectDocument>(EFFECT_ASSET_KIND, id);
      service.subscribe(handle, (state: AssetState<ParticleEffectDocument>) => {
        if (state.status === 'ready') {
          asset.doc = state.data;
        } else if (state.status === 'failed') {
          this.warnOnce(
            `effect:${id}`,
            `render: эмиттерный ассет "${id}" недоступен (${state.reason}) — запись пропущена (REND-24)`,
          );
        }
      });
    } catch (e) {
      this.warnOnce(
        `effect:${id}`,
        `render: эмиттерный ассет "${id}" не запрашивается (${e instanceof Error ? e.message : String(e)}) — запись пропущена (REND-24)`,
      );
    }
    // Подписка приносит текущее состояние немедленно (ASSET-4): уже загруженный
    // документ доступен на первом же обращении, а не со следующего кадра.
    return asset.doc;
  }

  /** Документ, уже доехавший по этой ссылке; запроса не заводит. */
  known(id: string): ParticleEffectDocument | null {
    return this.assets.get(id)?.doc ?? null;
  }

  /**
   * Забыть все документы вместе с подписками (ED-15): следующее обращение
   * запросит ассет у нового сервиса, а прежний кэш редактор уже выбросил.
   */
  clear(): void {
    this.assets.clear();
  }
}

/**
 * Луч сцены частиц не видит (REND-15): частица — изображение, а не сущность.
 * Батчи заводятся по мере появления новых конвейеров отрисовки, поэтому обход
 * идёт с НОВЫХ батчей, а не со всех: отключение луча идемпотентно, а
 * регистрация материалов в учёте (PERF-8) — нет, и повторная считала бы один и
 * тот же материал дважды. Возвращает новое число обработанных батчей.
 */
export function shieldBatches(batchRenderer: BatchedRenderer, shielded: number): number {
  const batches = batchRenderer.batches;
  if (batches.length === shielded) return shielded;
  for (let i = shielded; i < batches.length; i++) {
    const batch = batches[i]!;
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
    batch.raycast = () => {};
    // Два материала батча строит библиотека, и учёт получает их здесь — по
    // факту появления батча, как ресурсы разобранного графа (REND-31, PERF-8).
    ownBatchMaterials(batch);
  }
  return batches.length;
}
