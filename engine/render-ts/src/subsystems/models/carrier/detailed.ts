/**
 * ДЕТАЛЬНЫЙ носитель инстанса (REND-20): пер-инстансное поддерево со своим
 * скелетом, микшером и — после первой подмены скина — своими материалами.
 * Ярус записей с процедурным контролем костей (REND-5) и одиночных крупных
 * инстансов, где батч не окупается.
 */
import type { ModelBounds, ModelInstance, SharedModelData } from '../../../model/build.js';
import { createModelInstance, normalizedScale } from '../../../model/build.js';
import { MixerAnimationBackend } from '../../../model/animation.js';
import { BoneControlState } from '../../../model/boneControl.js';
import { applySkin, skinTextureSources } from '../../../model/skins.js';
import {
  applyAnimation,
  boundsFromBaked,
  scaleBounds,
  type CarrierDeps,
  type InstanceCarrier,
  type InstanceRecord,
} from '../instanceRecord.js';
import { paintDetailed } from '../instanceTint.js';
import { disposePlaceholder } from './placeholder.js';
import { applyHolderPose, ensureHolder, makeController, type ControllerOptions } from './support.js';

/** Детальный ярус: пер-инстансное поддерево со скелетом и микшером (REND-20). */
export function attachDetailed(
  record: InstanceRecord,
  deps: CarrierDeps,
  shared: SharedModelData,
  options: ControllerOptions,
): void {
  // Запечённые границы есть и у детальной записи, когда модель их даёт: они
  // производны от МОДЕЛИ, а не от яруса, и отсечение по ним точнее запаса
  // (REND-21). Батчевый ярус тут ни при чём — деградировавшая запись тоже их
  // получает.
  const baked = deps.sharedOf(record)?.derivatives ?? null;
  record.cullBounds = baked === null ? null : boundsFromBaked(baked);
  rescaleCull(record, deps, shared);
  const instanceOptions: { scale?: number; hiddenParts?: readonly number[] } = {};
  if (record.visual?.scale !== undefined) instanceOptions.scale = record.visual.scale;
  if (record.visual?.hiddenParts !== undefined) {
    instanceOptions.hiddenParts = record.visual.hiddenParts;
  }
  const model = createModelInstance(shared, instanceOptions);
  ensureHolder(record, deps).add(model.root);
  disposePlaceholder(record);
  record.model = model;
  record.carrier = DETAILED_CARRIER;
  record.controller = makeController(
    record,
    new MixerAnimationBackend(model.mixer, shared.clips),
    options,
    deps.warn,
  );
  applyAnimation(record);

  // Контроля костей у decoration нет (REND-5, REND-18): доворачивать нечего.
  const controls = record.decoration ? undefined : record.visual?.boneControls;
  record.boneControl = controls === undefined ? null : new BoneControlState(controls);

  applyInstanceSkin(record, deps, model);
}

/**
 * Границы отсечения детальной записи под масштабом записи манифеста: тот же
 * множитель нормализации, каким отмасштабирован сам инстанс (REND-17).
 */
export function rescaleCull(
  record: InstanceRecord,
  deps: CarrierDeps,
  shared: SharedModelData | null,
): void {
  if (record.cullBounds === null) return;
  const model = shared?.model ?? deps.sharedOf(record)?.data?.model;
  const baked = deps.sharedOf(record)?.derivatives;
  if (model === undefined || baked == null) return;
  const normalized = normalizedScale(record.visual?.scale, model);
  scaleBounds(boundsFromBaked(baked), normalized, record.cullBounds);
}

/**
 * Скин на ДЕТАЛЬНОМ инстансе (REND-6). Пока выбранный скин ничего не
 * подменяет, инстанс рисуется РАЗДЕЛЯЕМЫМИ материалами ассета с его же
 * текстурами: своей копии ему незачем — от ассета он не отличается ничем.
 * Первая же подмена переводит материалы в собственные (copy-on-write) и
 * ставит в них полный набор «слот → источник»: соседние инстансы и
 * разделяемые данные не затронуты.
 *
 * Обратного пути нет намеренно: инстанс, однажды получивший свои материалы,
 * их и оставляет — снятие скина применяется к ним же полным набором, а
 * возврат к разделяемым сэкономил бы один материал ценой ветки, которой не
 * видно из кадра.
 */
function applyInstanceSkin(
  record: InstanceRecord,
  deps: CarrierDeps,
  model: ModelInstance,
): void {
  const entry = deps.sharedOf(record);
  if (entry?.data === undefined || entry.data === null) return;
  const overrides = record.skin === undefined ? undefined : record.visual?.skins?.[record.skin];
  if (!model.ownsMaterials && (overrides === undefined || Object.keys(overrides).length === 0)) {
    record.skinApp?.dispose();
    record.skinApp = null;
    deps.ensureBaseSkin(entry);
    return;
  }
  record.skinApp?.dispose();
  record.skinApp = applySkin(
    model.ownTextureTargets(),
    skinTextureSources(entry.data.model, record.visual, record.skin),
    deps.assets,
    entry.skinCache,
  );
}

/** Поведение детальной записи в кадре и на снятии. */
const DETAILED_CARRIER: InstanceCarrier = {
  tier: 'detailed',
  applyPose: (record, drawScale, settle, warn) => {
    applyHolderPose(record, drawScale);
    // Тинт (REND-40) — в СВОИ материалы инстанса; батчевый ярус тот же
    // множитель везёт пер-инстансным атрибутом. Маска команд-цвета выбирает
    // материалы по индексу (ASSET-18) — тому же, каким она выбирает материалы
    // батча, и потому оба яруса красят одно и то же.
    if (record.model !== null) paintDetailed(record.model, record.tint, record.tintMask);
    // Bone-контроль строго после mixer.update и до отрисовки (REND-5).
    if (record.model !== null && record.boneControl !== null) {
      record.boneControl.apply(
        record.model,
        record.view.aimYaw,
        record.yaw - record.facingOffset,
        settle,
        warn,
      );
    }
  },
  setVisible: (record, visible) => {
    if (record.holder !== null) record.holder.visible = visible;
  },
  selectLod: () => {
    // Детальный инстанс рисуется уровнем 0 на любой дистанции — оговорка
    // REND-22: цену его кадра держат скелет и материалы, а не геометрия уровня.
  },
  bounds: (record): ModelBounds | null => record.model?.bounds ?? null,
  cullBounds: (record): ModelBounds | null => record.cullBounds,
  applySkin: (record, deps) => {
    if (record.model !== null) applyInstanceSkin(record, deps, record.model);
  },
  detach: (record, deps) => {
    record.skinApp?.dispose();
    record.skinApp = null;
    record.controller = null;
    record.boneControl = null;
    record.cullBounds = null;
    disposePlaceholder(record);
    const model = record.model;
    if (model === null) return;
    model.root.removeFromParent();
    // Материалы, принадлежащие инстансу (свои копии скина REND-6 и заглушка
    // модели без материалов), уходят вместе с ним — и их fade-копии тоже
    // (FOW-8): пул ключуется оригиналом, а оригинала сейчас не станет.
    // Спрашивается ровно тот список, который инстанс и освободит: `dispose`
    // идёт по нему же. Разделяемых материалов ассета в нём нет — их пулы
    // живут с ассетом (REND-3).
    deps.disposeFadeClones(model.ownedMaterials);
    model.dispose();
    record.model = null;
  },
};
