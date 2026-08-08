/**
 * Решение W4-1 о контексте рендера, закреплённое тестом: модуль ассетов один на
 * редактор (ASSET-2), контекст рендера — на кадр, и состояние области переживает
 * переключение (ED-23).
 *
 * Проверяется без WebGL и без DOM. Настоящий контекст здесь не собрать — его
 * держит `WebGLRenderer`, — но решение выражено раньше и наблюдаемо: оба кадра
 * объявляют СВОИ настройки (`sceneStageOptions`, `assetStageOptions`), и в них
 * видно и общее, и раздельное. Собери редактор один контекст на двоих —
 * настройки перестали бы различаться узлом страницы, потому что узел был бы
 * один.
 */
import { describe, expect, it } from 'vitest';
import { createAssetModule } from '../src/areas/assetModule.js';
import {
  ASSETS_VIEWPORT_ID,
  assetStageOptions,
  createAssetArea,
  type AssetAreaState,
} from '../src/areas/assets.js';
import {
  SCENE_AREA_ID,
  SCENE_VIEWPORT_ID,
  createSceneArea,
  sceneStageOptions,
  type SceneAreaState,
} from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';
import { buildFrame } from './support/frame.js';
import { FIXTURE_IDS, fakeStage, fixtureHost, settle } from './support/project.js';
import { ASSET_IDS, assetHost } from './support/assets.js';

const MANIFEST = { entities: {} };

describe('ASSET-2: модуль ассетов один на редактор', () => {
  it('оба кадра собираются на одном модуле', () => {
    const assets = createAssetModule(assetHost());
    const scene = sceneStageOptions(assets, MANIFEST, {
      announce: () => undefined,
      pointer: () => undefined,
    });
    const preview = assetStageOptions(assets, { announce: () => undefined });
    // Один и тот же объект, а не два равных: кэш ассета ключуется его ID
    // (ASSET-2), и два сервиса дали бы два ответа на вопрос «загрузился ли он».
    expect(scene.assets).toBe(assets);
    expect(preview.assets).toBe(assets);
    expect(preview.assets).toBe(scene.assets);
  });

  it('а контекст рендера у каждого кадра свой — у них разные узлы страницы', () => {
    const assets = createAssetModule(assetHost());
    const scene = sceneStageOptions(assets, MANIFEST, {
      announce: () => undefined,
      pointer: () => undefined,
    });
    const preview = assetStageOptions(assets, { announce: () => undefined });
    expect(scene.hostId).toBe(SCENE_VIEWPORT_ID);
    expect(preview.hostId).toBe(ASSETS_VIEWPORT_ID);
    expect(scene.hostId).not.toBe(preview.hostId);
    // Вырожденный случай REND-11 остаётся вырожденным: у кадра просмотрщика
    // террейна нет и не будет, у кадра сцены он есть.
    expect(preview.terrain).toBe(false);
    expect(scene.terrain).toBeUndefined();
  });
});

describe('ED-23: состояние области переживает переключение, кадр у каждой свой', () => {
  it('запись состояния та же при возврате, а вьюпорты — разные объекты', async () => {
    const sceneStages = [fakeStage(), fakeStage()];
    const previewStages = [fakeStage(), fakeStage()];
    const area = createSceneArea({
      host: fixtureHost(),
      ids: FIXTURE_IDS,
      stage: () => sceneStages.shift() ?? null,
    });
    const viewer = createAssetArea({
      host: assetHost(),
      visuals: ASSET_IDS.visuals,
      stage: () => previewStages.shift() ?? null,
    });
    const { frame } = buildFrame([area, systemsArea, viewer]);

    const sceneState = frame.stateOf(area.id) as SceneAreaState;
    const viewerState = frame.stateOf(viewer.id) as AssetAreaState;
    await settle();

    // Два кадра — два объекта: контекст рендера не общий, и это видно уже по
    // тому, что каждая область держит свой вьюпорт в своей записи.
    expect(sceneState.stage).not.toBeNull();
    expect(viewerState.stage).not.toBeNull();
    expect(sceneState.stage).not.toBe(viewerState.stage);

    // Уход в соседнюю область и возврат: запись та же самая, а не равная ей, —
    // вместе с ней на месте и вьюпорт со своей позой камеры (ED-23).
    frame.activate(viewer.id);
    frame.activate(systemsArea.id);
    frame.activate(SCENE_AREA_ID);
    expect(frame.stateOf(area.id)).toBe(sceneState);
    expect(frame.stateOf(viewer.id)).toBe(viewerState);
    expect((frame.stateOf(area.id) as SceneAreaState).stage).toBe(sceneState.stage);
    // Ни одна из областей не собрала второго кадра: переключение — не
    // пересборка вьюпорта.
    expect(sceneStages).toHaveLength(1);
    expect(previewStages).toHaveLength(1);
  });
});
