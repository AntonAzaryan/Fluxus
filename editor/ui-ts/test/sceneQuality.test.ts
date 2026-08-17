/**
 * Качество картинки вьюпорта редактора (`render-quality` QUAL-1, design D4):
 * вьюпорт подключает тот же контроллер, что игра, но с зашитой «ультрой» —
 * автору важна его собственная картинка, а не бюджет слабого устройства.
 *
 * Проверяется применимость документа и его содержание: он обязан проходить
 * валидацию против реестра, который собирает СЦЕНА РЕДАКТОРА (набор подсистем
 * у неё свой — тумана в кадре правки нет), и не обязан ничего ограничивать.
 * Собрать сам вьюпорт headless нельзя (`canRender`: WebGL), поэтому подсистемы
 * поднимаются здесь тем же набором и в том же порядке, что `createSceneStage`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type TerrainGrid } from '@game-mvp/core';
import type { AssetService, VisualManifest } from '@game-mvp/assets';
import {
  ModelsSubsystem,
  OverlaySubsystem,
  ParticlesSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  validateQualityPreset,
  type QualityValue,
  type RenderContext,
} from '@game-mvp/render';
import { EDITOR_QUALITY_PRESET } from '../src/areas/sceneStage.js';

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
 * Сцена вьюпорта без WebGL: те же подсистемы и тот же порядок регистрации, что
 * поднимает первая сетка документа (REND-8). Манифест пустой — реестр ручек
 * собирается из деклараций подсистем и от данных манифеста не зависит.
 */
function viewportStage(): PresentationStage {
  const visuals: VisualManifest = { entities: {} };
  const context: RenderContext = {
    scene: new THREE.Scene(),
    assets: {} as unknown as AssetService,
    config: { heightStep: 0.6 },
  };
  const stage = new PresentationStage(context);
  stage.register(new TerrainSubsystem(flatGrid()));
  stage.register(new ModelsSubsystem(visuals, { warn: () => {} }));
  stage.register(new ParticlesSubsystem(visuals, { warn: () => {} }));
  stage.register(new OverlaySubsystem());
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
      'models.defaultTier',
      'models.lodThresholdScale',
      'particles.density',
      'terrain.curvatureTessellation',
    ]);
  });

  it('потолков нет ни одного: конфиг рендера действует как написан', () => {
    const controller = new QualityController(viewportStage(), EDITOR_QUALITY_PRESET);

    // Потолок «нет потолка» — бесконечность (QUAL-1): назвать её документ не
    // может, и не называет, — плотность разбиения террейна остаётся авторской.
    expect(effectiveOf(controller)['terrain.curvatureTessellation']).toBe(
      Number.POSITIVE_INFINITY,
    );
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
