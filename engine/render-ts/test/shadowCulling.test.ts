/**
 * Отсечение и тени (REND-21, REND-30): гашение инстанса за краем кадра НЕ
 * должно снимать его тень с видимой области.
 *
 * Механизм гашения — `visible = false` у держателя и пропуск слота в
 * компактации батча, а three пропускает невидимое и в теневом проходе. Значит
 * решение о видимости обязано спрашивать обе пирамиды: камеры кадра и теневой
 * камеры текущей фазы. Пирамиду отдаёт подсистема освещения своим портом
 * (`ShadowCasterSink.shadowFrustum`), и её же реализация проверяется здесь: у
 * сцены без теней ответа нет вовсе, и отсечение идёт как до появления порта.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VisualManifest } from '@fluxus/assets';
import type { PresentationLighting } from '@fluxus/assets';
import {
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  type LightingSink,
  type RenderContext,
  type ShadowCasterTier,
} from '../src/index.js';
import {
  flatGrid,
  makeAssets,
  makeEntityView,
  makeModel,
  makeTickView,
  type AssetsStub,
} from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

function makeManifest(): VisualManifest {
  return { entities: { Runner: { model: MODEL_ID, scale: 1 } } };
}

/** Камера кадра: ортографическая коробка ±2 вокруг начала координат. */
function makeCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** Теневая камера арены: та же ось, но обтянута по всей арене (`aimShadowLight`). */
function makeShadowFrustum(halfWidth: number): THREE.Frustum {
  const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfWidth, -halfWidth, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly assets: AssetsStub;
  /** Пирамида теней этого кадра; null — теней нет (фаза `none`). */
  shadow: THREE.Frustum | null;
  visible(entity: number): boolean;
}

function makeRig(): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const state = { shadow: null as THREE.Frustum | null };
  const shadows: LightingSink = {
    setCaster: (_root: THREE.Object3D, _tier: ShadowCasterTier) => {},
    dropCaster: () => {},
    invalidateStatic: () => {},
    shadowFrustum: () => state.shadow,
  };
  const subsystem = new ModelsSubsystem(makeManifest(), {
    camera: makeCamera(),
    // Запас консервативности выключен: тест меряет пирамиды, а не запас.
    cullMargin: 0,
    shadows,
    warn: () => {},
  });
  subsystem.init(ctx);
  return {
    subsystem,
    assets,
    get shadow(): THREE.Frustum | null { return state.shadow; },
    set shadow(next: THREE.Frustum | null) { state.shadow = next; },
    visible: (entity) => subsystem.instanceFor(entity)!.visible,
  };
}

describe('отсечение не снимает теневого кастера (REND-21 → REND-30)', () => {
  /** 1 — в кадре, 2 — за краем кадра, но на арене, 3 — вне арены вовсе. */
  function place(rig: Rig): void {
    rig.subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { prevX: 0, currX: 0 }),
        makeEntityView(2, { prevX: 8, currX: 8 }),
        makeEntityView(3, { prevX: 400, currX: 400 }),
      ]),
    );
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.subsystem.updateFrame(1 / 60, 1);
  }

  it('инстанс за краем кадра, но в теневой пирамиде, остаётся нарисованным', () => {
    const rig = makeRig();
    rig.shadow = makeShadowFrustum(50);
    place(rig);

    expect(rig.visible(1)).toBe(true);
    // Его тень падает внутрь экрана: погаси мы инстанс — тень исчезла бы вместе
    // с ним, а других наблюдаемых последствий у отсечения быть не должно.
    expect(rig.visible(2)).toBe(true);
    // Вне обеих пирамид — отсекается, как и прежде: он не виден и не светит.
    expect(rig.visible(3)).toBe(false);
  });

  it('без теней в кадре отсечение идёт одной пирамидой камеры', () => {
    const rig = makeRig();
    rig.shadow = null; // фаза `none` либо пресет теней `none` (REND-30)
    place(rig);

    expect(rig.visible(1)).toBe(true);
    expect(rig.visible(2)).toBe(false);
    expect(rig.visible(3)).toBe(false);
  });

  it('погасшие тени возвращают отсечению его экономию тем же кадром', () => {
    const rig = makeRig();
    rig.shadow = makeShadowFrustum(50);
    place(rig);
    expect(rig.visible(2)).toBe(true);

    // Пресет выключил тени: следующий же кадр гасит инстанс за краем.
    rig.shadow = null;
    rig.subsystem.updateFrame(1 / 60, 1);
    expect(rig.visible(2)).toBe(false);
  });
});

describe('LightingSubsystem.shadowFrustum (REND-30)', () => {
  function makeLightingRig(config?: PresentationLighting): LightingSubsystem {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const stage = new PresentationStage(ctx);
    const lighting = new LightingSubsystem({
      grid: flatGrid(),
      ...(config === undefined ? {} : { config }),
    });
    stage.register(lighting);
    return lighting;
  }

  it('сцена без теней пирамиды не даёт вовсе', () => {
    const lighting = makeLightingRig();
    lighting.updateFrame(1 / 60, 1, 1 / 60);
    expect(lighting.shadowFrustum()).toBeNull();
  });

  it('со включёнными тенями пирамида обтянута по арене', () => {
    const lighting = makeLightingRig({ shadows: { mode: 'full' } });
    lighting.updateFrame(1 / 60, 1, 1 / 60);
    const frustum = lighting.shadowFrustum();
    expect(frustum).not.toBeNull();
    // Арена целиком внутри: теневая камера обтянута по её границам
    // (`aimShadowLight`), и инстанс на дальнем её краю обязан попадать.
    expect(frustum!.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(frustum!.containsPoint(new THREE.Vector3(1000, 1000, 0))).toBe(false);
  });
});
