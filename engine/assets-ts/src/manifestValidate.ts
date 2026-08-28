/**
 * Валидация документа манифеста визуалов (ASSET-6, ASSET-8): состав записи вида
 * (ASSET-9, ASSET-14) и корень документа.
 *
 * Живёт отдельно от `manifest.ts` потому, что это два разных вопроса к одному
 * формату: там — ЧТО манифест значит для потребителя (состав записи и её
 * разрешение), здесь — какой документ формат принимает. Читаются и правятся они
 * по отдельности, а связаны одним набором типов.
 *
 * Самостоятельные форматы внутри документа валидируются своими модулями: секции
 * камеры (ASSET-8, ASSET-10) — `cameraEffects.ts`, секции эффектов и частиц
 * (REND-23, REND-24) — `visualSections.ts`, блок света записи (ASSET-16) —
 * `visualLight.ts`, а поля, общие у разных записей, — `manifestFields.ts`.
 */
import { validateCameraConfig, validateCameraEffects } from './cameraEffects.js';
import type { CameraConfigDescription, CameraEffectsDescription } from './cameraEffects.js';
import {
  VISUAL_TIERS,
  validateLodThresholds,
  validateStringMap,
  validateSurfaceAlign,
  validateVerticalOffset,
} from './manifestFields.js';
import type { VisualManifest, VisualTier } from './manifest.js';
import { validateEffects, validateParticles } from './visualSections.js';
import { validateVisualLight } from './visualLight.js';
import { closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

/**
 * Изображение вида: модель либо (у decoration-вида) эмиттерный ассет
 * (ASSET-14). Ровно одно из двух — запись, называющая оба, оставила бы вопрос
 * «кто её рисует» без ответа: эмиттерные виды рисует подсистема частиц, а не
 * подсистема моделей (`rendering` REND-24), и молчаливое предпочтение одного
 * поля другому спрятало бы ошибку автора.
 */
function validateVisualImage(
  entity: Record<string, unknown>,
  path: string,
  errors: string[],
  allowEmitter: boolean,
): void {
  const hasEffect = 'effect' in entity;
  if (hasEffect && !allowEmitter) {
    errors.push(
      `${path}.effect: эмиттерным вправе быть только decoration-вид; эмиттер сущности — запись секции particles (ASSET-14)`,
    );
    return;
  }
  if (hasEffect) {
    if (typeof entity.effect !== 'string' || entity.effect.length === 0) {
      errors.push(
        `${path}.effect: ожидался asset id эмиттерного ассета (непустая строка), получено ${typeName(entity.effect)}`,
      );
    }
    if ('model' in entity) {
      errors.push(
        `${path}: вид рисуется либо моделью, либо частицами — model и effect в одной записи взаимоисключающи (ASSET-14)`,
      );
    }
    return;
  }
  if (typeof entity.model !== 'string' || entity.model.length === 0) {
    errors.push(`${path}.model: обязательное поле — непустая строка (asset id модели)`);
  }
}

/** Поля записи вида (ASSET-6, ASSET-9, ASSET-14) — они же перечень допустимых ключей. */
const ENTITY_VISUAL_FIELDS: readonly string[] = [
  'model',
  'effect',
  'scale',
  'facingDeg',
  'defaultSkin',
  'skins',
  'animations',
  'boneControls',
  'hiddenParts',
  'surfaceAlign',
  'verticalOffset',
  'tier',
  'lodThresholds',
  'light',
];

/**
 * Запись вида. `allowEmitter` — раздел ли это decoration-видов: эмиттерным
 * (ASSET-14) вправе быть только он, потому что `entities` ключуется
 * sim-идентификатором, а эмиттер СУЩНОСТИ — запись секции `particles`
 * (`rendering` REND-24), а не подмена её модели.
 */
function validateEntity(
  entity: unknown,
  path: string,
  errors: string[],
  allowEmitter = false,
): void {
  if (!isRecord(entity)) {
    errors.push(`${path}: ожидался объект визуала, получено ${typeName(entity)}`);
    return;
  }
  closedKeys(entity, path, ENTITY_VISUAL_FIELDS, errors);
  validateEntityBlocks(entity, path, errors);
  validateVisualImage(entity, path, errors, allowEmitter);
  validateEntityNumbers(entity, path, errors);
  validateSkins(entity, path, errors);
  validateAnimations(entity, path, errors);
  validateBoneControls(entity, path, errors);
  validateHiddenParts(entity, path, errors);
}

/** Блоки записи, у каждого из которых свой формат: наклон, свет, ярус, LOD, смещение. */
function validateEntityBlocks(
  entity: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if ('surfaceAlign' in entity) {
    validateSurfaceAlign(entity.surfaceAlign, `${path}.surfaceAlign`, errors);
  }
  // Блок локального источника (ASSET-16) — на обоих разделах и обоих родах
  // записи: свет несёт ИНСТАНС записи (REND-33), а чем он нарисован — моделью
  // или частицами (ASSET-14), — блока не касается.
  if ('light' in entity) {
    validateVisualLight(entity.light, `${path}.light`, errors);
  }
  // Параметры батчевой отрисовки (ASSET-13): действуют одинаково на оба
  // раздела манифеста — запись decoration задаёт их так же, как запись
  // сущности, и валидируются они тем же проходом.
  if ('tier' in entity && !VISUAL_TIERS.includes(entity.tier as VisualTier)) {
    errors.push(
      `${path}.tier: ожидался ярус представления (${VISUAL_TIERS.join(' | ')}), получено ${typeName(entity.tier)}`,
    );
  }
  if ('lodThresholds' in entity) {
    validateLodThresholds(entity.lodThresholds, `${path}.lodThresholds`, errors);
  }
  if ('verticalOffset' in entity) {
    validateVerticalOffset(entity.verticalOffset, `${path}.verticalOffset`, errors);
  }
}

/** Числа самой записи: мировая высота и угол переда модели (REND-13). */
function validateEntityNumbers(
  entity: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if ('scale' in entity && (!isFiniteNumber(entity.scale) || entity.scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное число, получено ${typeName(entity.scale)}`);
  }
  // Диапазон не ограничиваем: угол заворачивается, и «-90» и «270» одинаково
  // законны — требовать канонической записи значило бы придираться к автору.
  if ('facingDeg' in entity && !isFiniteNumber(entity.facingDeg)) {
    errors.push(
      `${path}.facingDeg: ожидался угол переда модели в градусах (число), получено ${typeName(entity.facingDeg)}`,
    );
  }
}

/** Ключ подмены слота — номер `textureSlot` (REND-6), значение — asset id текстуры. */
function validateSkinSlots(
  slots: Record<string, unknown>,
  skinPath: string,
  errors: string[],
): void {
  for (const [slot, tex] of Object.entries(slots)) {
    if (!/^\d+$/.test(slot)) {
      errors.push(`${skinPath}: ключ "${slot}" не является номером textureSlot`);
    }
    if (typeof tex !== 'string' || tex.length === 0) {
      errors.push(`${skinPath}.${slot}: ожидался asset id текстуры (непустая строка), получено ${typeName(tex)}`);
    }
  }
}

/** Скины записи и её скин по умолчанию: последний обязан быть среди описанных. */
function validateSkins(entity: Record<string, unknown>, path: string, errors: string[]): void {
  const skins = entity.skins;
  if ('skins' in entity) {
    if (!isRecord(skins)) {
      errors.push(`${path}.skins: ожидался объект «имя скина → подмены слотов», получено ${typeName(skins)}`);
    } else {
      for (const [skinName, slots] of Object.entries(skins)) {
        const skinPath = `${path}.skins.${skinName}`;
        if (isRecord(slots)) validateSkinSlots(slots, skinPath, errors);
        else {
          errors.push(`${skinPath}: ожидался объект «номер textureSlot → asset id текстуры», получено ${typeName(slots)}`);
        }
      }
    }
  }
  if (!('defaultSkin' in entity)) return;
  if (typeof entity.defaultSkin !== 'string' || entity.defaultSkin.length === 0) {
    errors.push(`${path}.defaultSkin: ожидалась непустая строка, получено ${typeName(entity.defaultSkin)}`);
  } else if (!isRecord(skins) || !(entity.defaultSkin in skins)) {
    errors.push(`${path}.defaultSkin: скин "${entity.defaultSkin}" не описан в ${path}.skins`);
  }
}

/** Таблицы клипов записи (REND-4): состояние → подстрока имени, событие → подстрока имени. */
function validateAnimations(entity: Record<string, unknown>, path: string, errors: string[]): void {
  if (!('animations' in entity)) return;
  const anims = entity.animations;
  if (!isRecord(anims)) {
    errors.push(`${path}.animations: ожидался объект, получено ${typeName(anims)}`);
    return;
  }
  closedKeys(anims, `${path}.animations`, ['states', 'events'], errors);
  if ('states' in anims) {
    validateStringMap(anims.states, `${path}.animations.states`, 'состояние → подстрока имени клипа', errors);
  }
  if ('events' in anims) {
    validateStringMap(anims.events, `${path}.animations.events`, 'событие → подстрока имени клипа', errors);
  }
}

/** Параметры одной роли процедурного контроля кости (REND-5). */
function validateBoneControl(
  control: unknown,
  rolePath: string,
  errors: string[],
): void {
  if (!isRecord(control)) {
    errors.push(`${rolePath}: ожидался объект { bone, maxYawDeg, smoothing }, получено ${typeName(control)}`);
    return;
  }
  closedKeys(control, rolePath, ['bone', 'maxYawDeg', 'smoothing'], errors);
  if (typeof control.bone !== 'string' || control.bone.length === 0) {
    errors.push(`${rolePath}.bone: обязательное поле — имя кости (непустая строка)`);
  }
  if (!isFiniteNumber(control.maxYawDeg) || control.maxYawDeg < 0) {
    errors.push(`${rolePath}.maxYawDeg: ожидалось неотрицательное число градусов`);
  }
  if (!isFiniteNumber(control.smoothing) || control.smoothing < 0) {
    errors.push(`${rolePath}.smoothing: ожидалось неотрицательное число`);
  }
}

/** Таблица «роль → параметры кости» записи (REND-5). */
function validateBoneControls(
  entity: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!('boneControls' in entity)) return;
  const controls = entity.boneControls;
  if (!isRecord(controls)) {
    errors.push(`${path}.boneControls: ожидался объект «роль → параметры», получено ${typeName(controls)}`);
    return;
  }
  for (const [role, control] of Object.entries(controls)) {
    validateBoneControl(control, `${path}.boneControls.${role}`, errors);
  }
}

/** Индексы частей модели, исключаемых из рендера: целые и неотрицательные. */
function validateHiddenParts(
  entity: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!('hiddenParts' in entity)) return;
  const hidden = entity.hiddenParts;
  if (!Array.isArray(hidden)) {
    errors.push(`${path}.hiddenParts: ожидался массив индексов частей модели, получено ${typeName(hidden)}`);
    return;
  }
  hidden.forEach((g: unknown, i: number) => {
    if (!Number.isInteger(g) || (g as number) < 0) {
      errors.push(`${path}.hiddenParts[${i}]: ожидался целый индекс части модели >= 0, получено ${typeName(g)}`);
    }
  });
}

/** Разделы и секции документа — они же перечень допустимых ключей корня. */
const MANIFEST_FIELDS: readonly string[] = [
  'entities',
  'decorations',
  'surfaceAlign',
  'terrain',
  'effects',
  'particles',
  'cameraEffects',
  'cameraConfig',
];

/** Что валидация знает сверх самого документа. */
export interface ValidateManifestOptions {
  /**
   * Машинное описание типов эффектов камеры (`camera` CAM-9). Без него секция
   * эффектов проверяется только структурно: перечня типов у модуля ассетов нет
   * (ASSET-8).
   */
  readonly cameraEffects?: CameraEffectsDescription;
  /**
   * Машинное описание конфига камеры (`camera` CAM-1). Без него секция конфига
   * проверяется только структурно: перечня параметров у модуля ассетов нет
   * (ASSET-10).
   */
  readonly cameraConfig?: CameraConfigDescription;
}

/** Результат валидации: находки двух последствий (ASSET-8). */
export type ManifestValidation =
  | { ok: true; manifest: VisualManifest; warnings: readonly string[] }
  | { ok: false; errors: string[]; warnings: readonly string[] };

/**
 * Валидация документа манифеста (ASSET-6, ASSET-8). Ошибки собираются все
 * разом (не fail-fast), каждая — с путём до поля, чтобы правка JSON не
 * превращалась в угадывание. Успех возвращает документ, типизированный как
 * VisualManifest.
 *
 * Предупреждения — вторая половина ответа и приходят в обеих ветках: «нарушение
 * есть, но документ валиден» иначе не выразить, а нужно это обеим сторонам —
 * загрузчик их логирует и продолжает, редактор превращает в находки важности
 * `warning` (ASSET-8, ED-3).
 */
export function validateManifest(doc: unknown, options: ValidateManifestOptions = {}): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`манифест: ожидался объект, получено ${typeName(doc)}`], warnings };
  }
  closedKeys(doc, 'манифест', MANIFEST_FIELDS, errors);
  validateEntitiesSection(doc, errors);
  validateDecorationsSection(doc, errors);
  if ('effects' in doc) validateEffects(doc.effects, errors);
  if ('particles' in doc) validateParticles(doc.particles, errors);
  if ('cameraEffects' in doc) {
    validateCameraEffects(doc.cameraEffects, errors, warnings, options.cameraEffects);
  }
  if ('cameraConfig' in doc) {
    validateCameraConfig(doc.cameraConfig, errors, warnings, options.cameraConfig);
  }
  if ('surfaceAlign' in doc) validateSurfaceAlign(doc.surfaceAlign, 'surfaceAlign', errors);
  if ('terrain' in doc) validateTerrainSection(doc.terrain, errors);
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, manifest: doc as unknown as VisualManifest, warnings };
}

/** Раздел записей сущностей (ASSET-6): ключуется sim-идентификатором и обязателен. */
function validateEntitiesSection(doc: Record<string, unknown>, errors: string[]): void {
  if (!isRecord(doc.entities)) {
    errors.push(`entities: обязательное поле — объект «prefab → визуал», получено ${typeName(doc.entities)}`);
    return;
  }
  for (const [name, entity] of Object.entries(doc.entities)) {
    validateEntity(entity, `entities.${name}`, errors);
  }
}

/**
 * Раздел decoration-видов (ASSET-9): состав записи тот же, что у сущности, —
 * валидируется тем же проходом. Неприменимые к decoration части записи
 * (таблицы клипов, кости, дуга прыжка) ошибкой не считаются: запись одного
 * состава на оба раздела дешевле, чем два состава, — смысла им просто не
 * придаётся (REND-18).
 */
function validateDecorationsSection(doc: Record<string, unknown>, errors: string[]): void {
  if (!('decorations' in doc)) return;
  const decorations = doc.decorations;
  if (!isRecord(decorations)) {
    errors.push(`decorations: ожидался объект «ключ вида → визуал», получено ${typeName(decorations)}`);
    return;
  }
  for (const [name, entry] of Object.entries(decorations)) {
    // Эмиттерный вид законен только здесь (ASSET-14): decoration-ключ ничем
    // в симуляции не обеспечен, и «факел» — такой же вид, как «камень».
    validateEntity(entry, `decorations.${name}`, errors, true);
  }
  checkKeySpaceCollision(doc.entities, decorations, errors);
}

/**
 * Пространство визуальных ключей одно (ASSET-9): имя, занятое в обоих разделах,
 * сделало бы разрешение ключа зависящим от порядка просмотра.
 */
function checkKeySpaceCollision(
  entities: unknown,
  decorations: Record<string, unknown>,
  errors: string[],
): void {
  if (!isRecord(entities)) return;
  for (const name of Object.keys(decorations)) {
    if (name in entities) {
      errors.push(
        `decorations.${name}: имя занято записью сущности — ключи разделов лежат в одном пространстве (ASSET-9)`,
      );
    }
  }
}

/** Presentation-данные террейна арены: ссылка на карту кривизны (ASSET-7). */
function validateTerrainSection(terrain: unknown, errors: string[]): void {
  if (!isRecord(terrain)) {
    errors.push(`terrain: ожидался объект, получено ${typeName(terrain)}`);
    return;
  }
  closedKeys(terrain, 'terrain', ['curvatureMap'], errors);
  if (
    'curvatureMap' in terrain &&
    (typeof terrain.curvatureMap !== 'string' || terrain.curvatureMap.length === 0)
  ) {
    errors.push(
      `terrain.curvatureMap: ожидался asset id карты кривизны (непустая строка), получено ${typeName(terrain.curvatureMap)}`,
    );
  }
}
