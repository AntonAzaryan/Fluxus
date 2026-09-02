/**
 * Качество картинки вьюпорта редактора (`render-quality` QUAL-1, design D4):
 * вьюпорт подключает тот же контроллер, что игра, но с зашитой «ультрой» —
 * автору важна его собственная картинка, а не бюджет слабого устройства.
 *
 * Проверяется применимость документа и его содержание: он обязан проходить
 * валидацию против реестра, который собирает СЦЕНА РЕДАКТОРА (набор подсистем
 * у неё свой — тумана в кадре правки нет), и не обязан ничего ограничивать.
 * Собрать сам вьюпорт headless нельзя (`canRender`: WebGL), а вот его НАБОР
 * подсистем — можно: его поднимает `registerViewportSubsystems`, та же функция,
 * которой пользуется `createSceneStage`. Своей копии набора здесь больше нет:
 * копия и была тем, из-за чего пропуск подсистемы эффектов (REND-23) прожил
 * незамеченным — она повторяла его слово в слово.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import type { AssetService, VisualManifest } from '@fluxus/assets';
import {
  PresentationStage,
  QualityController,
  validateQualityPreset,
  type QualityValue,
  type RenderContext,
} from '@fluxus/render';
import {
  EDITOR_QUALITY_PRESET,
  registerViewportSubsystems,
} from '../src/areas/sceneStage.js';

const SIZE = 4;

function flatGrid(): TerrainGrid {
  return createTerrainGrid({
    width: SIZE,
    height: SIZE,
    tileSize: 65536,
    levels: Array.from({ length: SIZE }, () => '0'.repeat(SIZE)),
    flags: Array.from({ length: SIZE }, () => '.'.repeat(SIZE)),
  });
}

/**
 * Сцена вьюпорта без WebGL: подсистемы поднимает ТА ЖЕ функция, что и в
 * `createSceneStage` (REND-8). Манифест пустой — реестр ручек собирается из
 * деклараций подсистем и от данных манифеста не зависит.
 */
function viewportStage(): PresentationStage {
  const visuals: VisualManifest = { entities: {} };
  const context: RenderContext = {
    scene: new THREE.Scene(),
    assets: {} as unknown as AssetService,
    config: { heightStep: 0.6 },
  };
  const stage = new PresentationStage(context);
  registerViewportSubsystems(stage, {
    grid: flatGrid(),
    camera: new THREE.PerspectiveCamera(),
    visuals,
  });
  return stage;
}

/** Действующие значения ручек как обычный объект — так их удобно сравнивать. */
function effectiveOf(controller: QualityController): Record<string, QualityValue> {
  return Object.fromEntries(controller.effective());
}

describe('вьюпорт редактора живёт на «ультре» (QUAL-1, design D4)', () => {
  it('зашитый документ проходит валидацию против реестра сцены редактора', () => {
    const controller = new QualityController(viewportStage());

    const result = validateQualityPreset(EDITOR_QUALITY_PRESET, controller.knobs);

    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('реестр кадра правки — ручки его подсистем; тумана в нём нет (REND-16)', () => {
    const controller = new QualityController(viewportStage());

    expect(controller.knobs.map((knob) => knob.name).sort()).toEqual([
      // Потолок локальных источников (`rendering` REND-33) приходит вьюпорту
      // сам собой — вместе с подсистемой освещения: зашитый документ его не
      // называет, и действует кодовое умолчание ручки (QUAL-1). Правок кода
      // редактора локальный свет не потребовал ни одной (ED-22).
      'lighting.maxLocalLights',
      'lighting.shadowMapSize',
      'lighting.shadowMode',
      'models.defaultTier',
      'models.lodThresholdScale',
      'particles.density',
      // Ручки пост-обработки (REND-34) приходят вьюпорту тем же порядком:
      // зашитый документ их не называет, и действуют кодовые умолчания —
      // «потолка нет», то есть авторская секция сцены как написана (QUAL-1).
      'postprocess.bloom',
      'postprocess.bloomResolution',
      'postprocess.lut',
      'terrain.curvatureTessellation',
      // Ручки воды (REND-35) — тем же порядком: подсистему поднимает сетка
      // террейна, и её ручки в реестре вьюпорта есть, хотя зашитый документ их
      // не называет. Прежняя копия набора их не знала вовсе — ровно тот сорт
      // расхождения, ради которого набор теперь общий (см. шапку).
      'water.depthTexelsPerCell',
      'water.detailLayers',
      'water.rippleSources',
    ]);
  });

  it('потолков нет ни одного: конфиг рендера действует как написан', () => {
    const controller = new QualityController(viewportStage(), EDITOR_QUALITY_PRESET);

    // Потолок «нет потолка» — бесконечность (QUAL-1): назвать её документ не
    // может, и не называет, — плотность разбиения террейна остаётся авторской.
    expect(effectiveOf(controller)['terrain.curvatureTessellation']).toBe(
      Number.POSITIVE_INFINITY,
    );
    // Теней это касается наравне: авторский режим сцены во вьюпорте действует
    // как написан, и потолок его не опускает.
    expect(effectiveOf(controller)['lighting.shadowMode']).toBe('full');
    expect(effectiveOf(controller)['lighting.shadowMapSize']).toBe(Number.POSITIVE_INFINITY);
    // Свечение сцены во вьюпорте горит как написано автором, и разрешение его
    // пирамиды производно от кадра, а не от потолка (REND-34).
    expect(effectiveOf(controller)['postprocess.bloom']).toBe(true);
    expect(effectiveOf(controller)['postprocess.bloomResolution']).toBe(Number.POSITIVE_INFINITY);
    // Цветокоррекция — тем же порядком: потолка нет, и таблица сцены действует
    // как написана (REND-34).
    expect(effectiveOf(controller)['postprocess.lut']).toBe(true);
  });

  it('картинка та же, что без контроллера вовсе: документ повторяет умолчания', () => {
    const authored = effectiveOf(new QualityController(viewportStage()));

    expect(effectiveOf(new QualityController(viewportStage(), EDITOR_QUALITY_PRESET))).toEqual(
      authored,
    );
    expect(authored['models.lodThresholdScale']).toBe(1);
    expect(authored['models.defaultTier']).toBe('batched');
    expect(authored['particles.density']).toBe(1);
  });
});
