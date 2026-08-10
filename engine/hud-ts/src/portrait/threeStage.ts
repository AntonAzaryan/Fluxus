/**
 * THREE-реализация стенда портрета (HUD-7, design Decision 8): второй
 * `WebGLRenderer` со своим canvas и своим циклом кадра — по образцу
 * просмотрщика ассетов редактора (`editor/ui-ts/src/areas/assetModule.ts`,
 * ED-20). Отдельный здесь только инстанс: движок один — `render-ts`
 * (сборка модели `buildSharedModel`/`createModelInstance`, клипы
 * `AnimationController`, скины `applySkin`), второй реализации рендера не
 * появляется.
 *
 * Стенд — изолированная мини-сцена: своя `THREE.Scene` с ровно одной моделью,
 * своя камера, свой свет. Сцены арены здесь нет и появиться не может —
 * конструктор не принимает ничего, кроме asset-сервиса (см. `stage.ts`).
 *
 * Цикл кадра рисует ТОЛЬКО пока есть и canvas, и модель (по образцу
 * невидимой области редактора, `sceneStage.ts`: кадр без узла не рисует
 * ничего); `dispose` останавливает цикл и освобождает ресурсы.
 *
 * Разделяемое и своё. Разделяемый кэш ASSET-2 — это `AssetService`: байты и
 * разобранная `NormalizedModel` у арены и портрета общие, тем же handle.
 * THREE-сборка (геометрия, материалы) — своя на КОНТЕКСТ рендера, как у
 * каждого кадра редактора: WebGL-ресурсы принадлежат контексту, и стенд
 * владеет своими, поэтому и dispose'ит их сам — в отличие от
 * `ModelsSubsystem`, чей кэш разделяемых данных живёт дольше инстанса
 * (REND-3).
 *
 * Тестами этот файл не покрыт намеренно: ему нужен настоящий WebGL-контекст,
 * которого нет ни в Node, ни в jsdom. Вся логика виджета вынесена за шов
 * `PortraitStage` и покрыта тестами со стендом-заглушкой; здесь остаётся
 * тонкая THREE-часть, проверяемая typecheck'ом и глазами.
 */
import * as THREE from 'three';
import {
  AnimationController,
  applySkin,
  buildSharedModel,
  createModelInstance,
  skinTextureSources,
  type ModelInstance,
  type SharedModelData,
  type SkinApplication,
} from '@game-mvp/render';
import type { EntityVisual, NormalizedModel } from '@game-mvp/assets';
import type { PortraitStage, PortraitStageOptions } from './stage.js';

/**
 * Состояние локомоции стенда — закрытый словарь состояний рендера (REND-4):
 * на стенде сущность всегда стоит, поэтому 'idle'; клип на него кладёт
 * таблица `animations.states` записи манифеста, а не код (сценарий
 * «Портрет героя» — idle-анимация).
 */
const STAND_STATE = 'idle';
/** Кадр стенда мягче кадра арены: маленькая поверхность, обзорный свет. */
const CAMERA_FOV_DEG = 35;
/** Запас кадрирования вокруг габаритов модели. */
const FRAMING_MARGIN = 1.35;

export function createThreePortraitStage(options: PortraitStageOptions): PortraitStage {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.05, 100);
  // Вертикаль мира — Z, как у вьюпортов рендера (`sceneStage.ts`).
  camera.up.set(0, 0, 1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(3, -2, 4);
  scene.add(key);

  let renderer: THREE.WebGLRenderer | null = null;
  let model: ModelInstance | null = null;
  /** THREE-сборка текущей модели — стенд владеет ею и dispose'ит сам. */
  let shared: SharedModelData | null = null;
  let controller: AnimationController | null = null;
  let skinApp: SkinApplication | null = null;
  let raf = 0;
  let lastFrameAt: number | null = null;
  let disposed = false;

  const frame = (now: number): void => {
    raf = 0;
    // Рисуем только пока есть и поверхность, и модель (HUD-7): пустой стенд
    // не жжёт кадры — как невидимая область редактора.
    if (disposed || renderer === null || model === null) {
      lastFrameAt = null;
      return;
    }
    raf = requestAnimationFrame(frame);
    const dt = lastFrameAt === null ? 0 : Math.min((now - lastFrameAt) / 1000, 0.25);
    lastFrameAt = now;
    controller?.update(dt);
    renderer.render(scene, camera);
  };

  const ensureLoop = (): void => {
    if (raf !== 0 || disposed || renderer === null || model === null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    raf = requestAnimationFrame(frame);
  };

  const stopLoop = (): void => {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    lastFrameAt = null;
  };

  /**
   * Фиксированное кадрирование по габаритам инстанса: камера в три четверти
   * со стороны +X (лицо MDX-модели по умолчанию смотрит вдоль +X, REND-13),
   * цель — центр объёма. Просто и без слежения: портрет — стенд, а не
   * вьюпорт, орбит и зума у него нет.
   */
  const frameModel = (instance: ModelInstance): void => {
    const b = instance.bounds;
    const cz = (b.minZ + b.maxZ) / 2;
    const radius =
      Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 0.1) / 2;
    const distance =
      (radius * FRAMING_MARGIN) / Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);
    camera.position.set(distance, -distance * 0.3, cz + radius * 0.4);
    camera.lookAt(0, 0, cz);
  };

  const clearModel = (): void => {
    stopLoop();
    skinApp?.dispose();
    skinApp = null;
    controller = null;
    if (model !== null) {
      model.root.removeFromParent();
      model.dispose();
      model = null;
    }
    // Геометрия THREE-сборки принадлежит стенду (см. шапку) — освобождаем.
    if (shared !== null) {
      for (const mesh of shared.meshes) mesh.geometry.dispose();
      shared = null;
    }
  };

  return {
    attach(canvas: HTMLCanvasElement): void {
      if (disposed || renderer !== null) return;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      // Размер поверхности задаёт разметка виджета атрибутами canvas;
      // третий аргумент false — стиль элемента остаётся за разметкой.
      renderer.setSize(canvas.width || 1, canvas.height || 1, false);
      camera.aspect = (canvas.width || 1) / (canvas.height || 1);
      camera.updateProjectionMatrix();
      ensureLoop();
    },

    showModel(data: NormalizedModel, visual: EntityVisual): void {
      if (disposed) return;
      clearModel();
      // Тот же путь сборки, что у арены (design Decision 8): render-ts один.
      shared = buildSharedModel(data);
      const instanceOptions: { scale?: number; hiddenParts?: readonly number[] } = {};
      if (visual.scale !== undefined) instanceOptions.scale = visual.scale;
      if (visual.hiddenParts !== undefined) instanceOptions.hiddenParts = visual.hiddenParts;
      const instance = createModelInstance(shared, instanceOptions);
      scene.add(instance.root);
      model = instance;
      // Текстуры скина — через ОБЩИЙ asset-сервис (ASSET-2): уже загруженное
      // ареной приходит из общего кэша тем же handle, повторной загрузки нет.
      skinApp = applySkin(
        instance.textureTargets,
        skinTextureSources(data, visual, visual.defaultSkin),
        options.assets,
      );
      // Idle-клип — из таблицы манифеста, тем же контроллером, что у арены
      // (REND-4): запись без 'idle' оставляет позу покоя, без предупреждений.
      controller = new AnimationController(instance.mixer, shared.clips, visual.animations ?? {});
      controller.setState(STAND_STATE);
      frameModel(instance);
      ensureLoop();
    },

    clearModel,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearModel();
      renderer?.dispose();
      renderer = null;
    },
  };
}
