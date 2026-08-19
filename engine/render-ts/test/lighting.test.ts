/**
 * Освещение сцены и режимы теней: конфигурация данными (секция `lighting`
 * парного документа, PRES-2, REND-27), подсистема-владелец источников (REND-8),
 * ярусы теневых кастеров (REND-28) и потолки пресета качества (QUAL-1, QUAL-3).
 *
 * Всё headless: источники, теневые камеры и флаги `castShadow`/`receiveShadow`
 * — данные, а не GPU-объекты, пока их некому нарисовать. Под тестом поэтому
 * ровно то, что решает подсистема: какие источники существуют, с какими
 * числами, чья теневая карта рисуется в этом кадре и кто в неё попадает. Сам
 * теневой проход three в прогоне не исполняется — это то же известное
 * ограничение, что у GLSL VAT-материала (`model/vatMaterial.ts`).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@game-mvp/core';
import type { PresentationLighting, VisualManifest } from '@game-mvp/assets';
import {
  DEFAULT_LIGHTING_CONFIG,
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  createCostCounters,
  minShadowMode,
  resolveLightingConfig,
  shadowModeRank,
  withCostSink,
  type EntityView,
  type PresentationProducer,
  type QualityPreset,
  type RenderContext,
} from '../src/index.js';
import { flatGrid, makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/rock.mdx';
const PRODUCER: PresentationProducer = { name: 'test' };

/**
 * Два вида на одной модели: неанимированный камень и анимированный факел.
 * Ярус кастера — производная данных, и различает их ровно наличие таблицы
 * анимаций записи (REND-4), а не имя ключа.
 */
function makeManifest(): VisualManifest {
  return {
    entities: {
      Rock: { model: MODEL_ID, scale: 1 },
      Torch: { model: MODEL_ID, scale: 1, animations: { states: { idle: 'Stand' } } },
    },
  };
}

interface Rig {
  readonly stage: PresentationStage;
  readonly lighting: LightingSubsystem;
  readonly models: ModelsSubsystem;
  readonly terrain: TerrainSubsystem;
  readonly scene: THREE.Scene;
}

/**
 * Сцена подсистем в порядке регистрации сборок (REND-8): свет, террейн, модели.
 * Модель разрешается сразу — батчевый ярус (REND-20) собирается той же
 * доставкой, и тестировать заглушку вместо него незачем.
 */
function makeRig(config?: PresentationLighting, preset?: QualityPreset): Rig {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const stage = new PresentationStage(ctx);
  const grid = flatGrid();
  const lighting = new LightingSubsystem({ grid, ...(config === undefined ? {} : { config }) });
  stage.register(lighting);
  const terrain = new TerrainSubsystem(grid, { shadows: lighting });
  stage.register(terrain);
  const models = new ModelsSubsystem(makeManifest(), { shadows: lighting, warn: () => {} });
  stage.register(models);
  if (preset !== undefined) new QualityController(stage, preset);
  assets.resolve('model', MODEL_ID, makeModel());
  return { stage, lighting, models, terrain, scene };
}

/** Набор decoration-инстансов в форме входа REND-18. */
function decorations(views: EntityView[]): ReadonlyMap<EntityId, EntityView> {
  return new Map(views.map((view) => [view.id, view]));
}

/** Меш чанка пола террейна — по нему видно флаги приёмника теней. */
function floorMesh(scene: THREE.Scene): THREE.Mesh {
  const found = scene.children.find((node) => node.name.startsWith('terrain:chunk:'));
  expect(found, 'чанк пола обязан быть в сцене').toBeDefined();
  return found as THREE.Mesh;
}

/** Направленные источники сцены — их число и есть наблюдаемая разница режимов. */
function directionalLights(scene: THREE.Scene): THREE.DirectionalLight[] {
  return scene.children.filter(
    (node) => (node as THREE.DirectionalLight).isDirectionalLight,
  ) as THREE.DirectionalLight[];
}

// ------------------------------------------------------------------ конфиг

describe('конфигурация освещения — данные секции `lighting` (PRES-2)', () => {
  it('умолчания воспроизводят снятый из потребителей хардкод: ambient 0.65, направленный 1.7', () => {
    // Числа списаны с удалённых строк демо и вьюпорта редактора один в один:
    // сцена без секции обязана рисоваться тем же кадром, что рисовалась.
    expect(DEFAULT_LIGHTING_CONFIG.ambientColor).toBe('#ffffff');
    expect(DEFAULT_LIGHTING_CONFIG.ambientIntensity).toBe(0.65);
    expect(DEFAULT_LIGHTING_CONFIG.directionalColor).toBe('#ffffff');
    expect(DEFAULT_LIGHTING_CONFIG.directionalIntensity).toBe(1.7);
    expect(DEFAULT_LIGHTING_CONFIG.directionX).toBe(8);
    expect(DEFAULT_LIGHTING_CONFIG.directionY).toBe(-12);
    expect(DEFAULT_LIGHTING_CONFIG.directionZ).toBe(18);
    // Тени по умолчанию выключены: сцена без секции за них не платит ничем.
    expect(DEFAULT_LIGHTING_CONFIG.shadowMode).toBe('none');
  });

  it('нет секции — ровно умолчания; частичная секция закрывает дыры умолчаниями', () => {
    expect(resolveLightingConfig()).toEqual(DEFAULT_LIGHTING_CONFIG);
    expect(resolveLightingConfig({})).toEqual(DEFAULT_LIGHTING_CONFIG);

    const partial = resolveLightingConfig({ ambient: { intensity: 0.2 } });
    expect(partial.ambientIntensity).toBe(0.2);
    // Не названное автором остаётся умолчанием — поле, а не секция целиком.
    expect(partial.ambientColor).toBe(DEFAULT_LIGHTING_CONFIG.ambientColor);
    expect(partial.directionalIntensity).toBe(DEFAULT_LIGHTING_CONFIG.directionalIntensity);
  });

  it('полная секция разбирается полем в поле', () => {
    const config = resolveLightingConfig({
      ambient: { color: '#101010', intensity: 0.1 },
      directional: { color: '#fff0d0', intensity: 2.5, direction: { x: 1, y: 2, z: 3 } },
      shadows: { mode: 'full', mapSize: 512, staticShare: 0.25 },
    });
    expect(config).toEqual({
      ambientColor: '#101010',
      ambientIntensity: 0.1,
      directionalColor: '#fff0d0',
      directionalIntensity: 2.5,
      directionX: 1,
      directionY: 2,
      directionZ: 3,
      shadowMode: 'full',
      shadowMapSize: 512,
      staticShare: 0.25,
    });
  });

  it('порядок режимов — по стоимости, и `min` над ним считается рангом', () => {
    expect(shadowModeRank('none')).toBeLessThan(shadowModeRank('hybrid'));
    expect(shadowModeRank('hybrid')).toBeLessThan(shadowModeRank('full'));
    expect(minShadowMode('full', 'hybrid')).toBe('hybrid');
    expect(minShadowMode('none', 'full')).toBe('none');
    expect(minShadowMode('hybrid', 'hybrid')).toBe('hybrid');
  });
});

// -------------------------------------------------------------- подсистема

describe('подсистема освещения — источники сцены (REND-8)', () => {
  it('сцена без секции освещена умолчаниями, и свет создаёт подсистема, а не сборка', () => {
    const rig = makeRig();
    const ambient = rig.scene.children.find(
      (node) => (node as THREE.AmbientLight).isAmbientLight,
    ) as THREE.AmbientLight;
    expect(ambient.intensity).toBe(0.65);
    expect(ambient.color.getHexString()).toBe('ffffff');

    const sun = directionalLights(rig.scene);
    // Источник ОДИН: пара S/D существует только в `hybrid`.
    expect(sun.length).toBe(1);
    expect(sun[0]!.intensity).toBe(1.7);
    // Направление — то же, что у снятого хардкода: позиция источника относительно
    // центра арены, нормированная и отодвинутая на радиус фрустума.
    const direction = sun[0]!.position.clone().sub(sun[0]!.target.position).normalize();
    expect(direction.x).toBeCloseTo(8 / Math.hypot(8, -12, 18), 6);
    expect(direction.y).toBeCloseTo(-12 / Math.hypot(8, -12, 18), 6);
    expect(direction.z).toBeCloseTo(18 / Math.hypot(8, -12, 18), 6);
    // Теней нет — источник их не несёт.
    expect(sun[0]!.castShadow).toBe(false);
  });

  it('правка секции применяется на живой подсистеме, без пересборки рендера (ED-15)', () => {
    const rig = makeRig();
    const before = directionalLights(rig.scene);

    rig.lighting.applyConfig({ ambient: { intensity: 0.1 }, directional: { intensity: 3 } });

    expect(rig.lighting.config.ambientIntensity).toBe(0.1);
    // Объекты те же: подсистема правит значения, а не пересоздаёт источники.
    expect(directionalLights(rig.scene)[0]).toBe(before[0]);
    expect(directionalLights(rig.scene)[0]!.intensity).toBe(3);
  });

  it('режим `hybrid` заводит второй источник и делит интенсивность между ними', () => {
    const rig = makeRig({
      directional: { intensity: 2 },
      shadows: { mode: 'hybrid', staticShare: 0.25 },
    });
    const lights = directionalLights(rig.scene);
    expect(lights.length).toBe(2);
    // Доля — данные конфига: тень каждой карты гасит вклад только своего
    // источника, и делится он ровно тем числом, что написал автор.
    expect(lights[0]!.intensity).toBeCloseTo(0.5, 6);
    expect(lights[1]!.intensity).toBeCloseTo(1.5, 6);
    expect(lights[0]!.castShadow).toBe(true);
    expect(lights[1]!.castShadow).toBe(true);
  });

  it('смена режима на `none` снимает второй источник из сцены', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    expect(directionalLights(rig.scene).length).toBe(2);

    rig.lighting.applyConfig({ shadows: { mode: 'none' } });

    expect(directionalLights(rig.scene).length).toBe(1);
    expect(directionalLights(rig.scene)[0]!.castShadow).toBe(false);
  });

  it('источник, переставший нести тени, отдаёт построенную карту', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const { sun, sunDynamic } = rig.lighting.lights;
    // Карту строит теневой проход three, которого в headless-прогоне нет:
    // подставляется готовая — предмет теста не её содержимое, а владение ею.
    for (const light of [sun, sunDynamic]) {
      const map = new THREE.WebGLRenderTarget(4, 4);
      map.depthTexture = new THREE.DepthTexture(4, 4);
      light.shadow.map = map;
    }

    rig.lighting.applyConfig({ shadows: { mode: 'none' } });

    // `none` — теневого прохода нет вовсе, и держать текстуру глубины незачем.
    expect(sun.shadow.map).toBeNull();
    expect(sunDynamic.shadow.map).toBeNull();
  });
});

// ------------------------------------------------------ ярусы кастеров

describe('ярус теневого кастера — производная данных (design D3)', () => {
  it('инстанс доставки динамичен, неанимированная декорация статична, террейн статичен', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    // Террейн зарегистрировал чанк пола статикой ещё при инициализации.
    expect(rig.lighting.casterCount('static')).toBe(1);

    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));

    // Батч сущности — динамический ярус, батч декорации — статический: у камня
    // анимаций нет, и в кадре он не двигается.
    expect(rig.lighting.casterCount('dynamic')).toBe(1);
    expect(rig.lighting.casterCount('static')).toBe(2);
  });

  it('анимированная декорация — динамический кастер: её поза меняется кадром', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Torch' })]));

    expect(rig.lighting.casterCount('dynamic')).toBe(1);
    // Статикой остался только чанк террейна.
    expect(rig.lighting.casterCount('static')).toBe(1);
  });

  it('батч однороден по ярусу: один вид с двойным происхождением даёт два батча', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));

    // `InstancedMesh` несёт один набор флагов теней на все записи: смешать
    // статику с динамикой в одном батче значило бы отдать их в одну карту.
    expect(rig.models.batchStats().batches).toBe(2);
  });

  it('другая арена: чанки прежней сетки уходят из реестра кастеров (REND-14)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    expect(rig.lighting.casterCount('static')).toBe(1);

    // Смена размеров арены пересобирает раскладку чанков целиком: прежние меши
    // сняты со сцены, и в реестре кастеров им делать нечего — иначе свет
    // считал бы тени по геометрии, которой в кадре давно нет.
    rig.terrain.applyGrid(flatGrid(16));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.casterCount('static')).toBe(1);
  });

  it('у вида появилась анимация — декорация переезжает в динамический ярус (REND-17)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    // Чанк террейна и батч неанимированного камня — оба статика.
    expect(rig.lighting.casterCount('static')).toBe(2);
    expect(rig.lighting.casterCount('dynamic')).toBe(0);

    // Правка манифеста в режиме правки (ED-15): автор дописал виду таблицу
    // анимаций (REND-4). Ярус — производная ЭТИХ данных, и переподача обязана
    // его пересчитать: иначе запись осталась бы в батче чужого яруса и её тень
    // запеклась бы в кэш статики в позе покоя.
    rig.models.applyManifest({
      entities: {
        Rock: { model: MODEL_ID, scale: 1, animations: { states: { idle: 'Stand' } } },
      },
    });

    expect(rig.lighting.casterCount('dynamic')).toBe(1);
    expect(rig.lighting.casterCount('static')).toBe(1);
    // Запись переехала в батч своего яруса целиком: прежний батч остался в
    // кэше пустым (REND-3), а записи в нём нет ни одной.
    expect(rig.models.batchStats().records).toBe(1);
  });
});

// -------------------------------------------------------- режимы теней

describe('режимы теней и кэш статики (design D2)', () => {
  it('`none`: теневых карт нет, флаги кастеров сняты', () => {
    const rig = makeRig();
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    expect(floorMesh(rig.scene).castShadow).toBe(false);
    expect(floorMesh(rig.scene).receiveShadow).toBe(false);
    expect(rig.models.batchMeshes()[0]!.castShadow).toBe(false);
  });

  it('`full`: одна карта, все кастеры каждым кадром, приёмники — террейн и модели', () => {
    const rig = makeRig({ shadows: { mode: 'full' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    const lights = directionalLights(rig.scene);
    expect(lights.length).toBe(1);
    expect(lights[0]!.shadow.needsUpdate).toBe(true);
    // Оба яруса подняты одновременно: карта одна, и делить их нечем.
    expect(floorMesh(rig.scene).castShadow).toBe(true);
    expect(floorMesh(rig.scene).receiveShadow).toBe(true);
    for (const mesh of rig.models.batchMeshes()) {
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
    }
  });

  it('`hybrid`: первый кадр печёт кэш статики, дальнейшие рисуют только динамику', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));

    rig.stage.frame(0.016, 0);
    const [sun, sunDynamic] = directionalLights(rig.scene);
    // Кадр запекания: перерисовывается карта статики, динамическая его пропускает.
    expect(rig.lighting.staticRebuilds).toBe(1);
    expect(sun!.shadow.needsUpdate).toBe(true);
    expect(sunDynamic!.shadow.needsUpdate).toBe(false);
    expect(floorMesh(rig.scene).castShadow).toBe(true);

    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    // Установившийся кадр: кэш не трогается, в карту идёт только динамика.
    expect(rig.lighting.staticRebuilds).toBe(1);
    expect(sun!.shadow.needsUpdate).toBe(false);
    expect(sunDynamic!.shadow.needsUpdate).toBe(true);
    expect(floorMesh(rig.scene).castShadow).toBe(false);
    // Приёмником террейн остаётся в обеих фазах: он ловит тени, а не отбрасывает.
    expect(floorMesh(rig.scene).receiveShadow).toBe(true);
  });

  it('автор двигает декорацию: кэш перерисован событием, а не кадром', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock', currX: 1 })]));
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Переподача набора декораций (REND-18) — тот же вход, которым правку
    // видит вьюпорт: статика могла переехать, и кэш устарел вместе с ней.
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock', currX: 5 })]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(2);
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(2);
  });

  it('смена значений света — событие перерисовки кэша, а не покадровый путь', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);

    rig.lighting.applyConfig({ directional: { intensity: 3 }, shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(2);
  });

  it('снятый инстанс статики устаревает кэш, снятый динамический — нет', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    const baked = rig.lighting.staticRebuilds;

    // Сущность ушла из доставки — динамический кастер, кэшу до него дела нет.
    rig.stage.publish(PRODUCER, makeTickView([]));
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(baked);

    // Декорация ушла — статика изменилась, и кэш обязан перерисоваться.
    rig.stage.publishDecorations(decorations([]));
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(baked + 1);
  });
});

// ------------------------------------------------------ глубина батча

describe('тень батчевого инстанса следует позе (design D4)', () => {
  it('инстанс-меши батча несут свой материал глубины', () => {
    const rig = makeRig({ shadows: { mode: 'full' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));

    const meshes = rig.models.batchMeshes();
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      const depth = mesh.customDepthMaterial as THREE.MeshDepthMaterial | undefined;
      expect(depth?.isMeshDepthMaterial).toBe(true);
    }
  });

  it('материал глубины считает ту же матрицу VAT, что боевой', () => {
    const rig = makeRig({ shadows: { mode: 'full' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    const depth = rig.models.batchMeshes()[0]!.customDepthMaterial as THREE.MeshDepthMaterial;

    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.depth.vertexShader,
      fragmentShader: THREE.ShaderLib.depth.fragmentShader,
    };
    depth.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    );

    // Тот же chunk, что у боевого материала: без него теневой проход считал бы
    // глубину по вершинам bind-позы, и тень застыла бы в позе покоя.
    expect(shader.vertexShader).toContain('mat4 vatSkinMatrix()');
    expect(shader.vertexShader).toContain('texelFetch( vatMap');
    expect(shader.vertexShader).toContain('mat4 vatSkin = vatSkinMatrix();');
    expect(shader.vertexShader).not.toContain('#include <skinning_vertex>');
    expect(shader.uniforms.vatMap?.value).toBeDefined();
    // Кадровых varying'ов у глубины нет: она пишет глубину, а не цвет.
    expect(shader.vertexShader).not.toContain('vInstanceFade');
  });
});

// -------------------------------------------------------- ручки качества

describe('ручки качества освещения (QUAL-1, QUAL-3)', () => {
  it('подсистема объявляет обе ручки потолками', () => {
    const knobs = new LightingSubsystem().quality().knobs;
    expect(knobs.map((knob) => knob.name)).toEqual([
      'lighting.shadowMode',
      'lighting.shadowMapSize',
    ]);
    for (const knob of knobs) expect(knob.semantics).toBe('ceiling');
    // Умолчание потолка — «не ограничивать»: самый дорогой режим и бесконечность.
    expect(knobs[0]!.default).toBe('full');
    expect(knobs[1]!.default).toBe(Number.POSITIVE_INFINITY);
  });

  it('производительный пресет поверх авторского `full`: действует `none`, документ цел', () => {
    const authored: PresentationLighting = { shadows: { mode: 'full', mapSize: 2048 } };
    const before = JSON.stringify(authored);
    const rig = makeRig(authored, { 'lighting.shadowMode': 'none' });

    expect(rig.lighting.config.shadowMode).toBe('none');
    // Пресет ограничивает ДЕЙСТВУЮЩЕЕ значение и авторскую секцию не трогает.
    expect(JSON.stringify(authored)).toBe(before);
    expect(resolveLightingConfig(authored).shadowMode).toBe('full');
  });

  it('потолок выше авторского значения его не поднимает', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } }, { 'lighting.shadowMode': 'full' });
    expect(rig.lighting.config.shadowMode).toBe('hybrid');
  });

  it('потолок стороны карты теней: действует min(авторское, потолок)', () => {
    const authored: PresentationLighting = { shadows: { mode: 'full', mapSize: 2048 } };
    expect(makeRig(authored, { 'lighting.shadowMapSize': 1024 }).lighting.config.shadowMapSize).toBe(
      1024,
    );
    // Потолок выше авторского значения оставляет авторское.
    expect(makeRig(authored, { 'lighting.shadowMapSize': 4096 }).lighting.config.shadowMapSize).toBe(
      2048,
    );
    // Без пресета действует сценное значение как написано.
    expect(makeRig(authored).lighting.config.shadowMapSize).toBe(2048);
  });

  it('действующая сторона карты доезжает до теневой камеры источника', () => {
    const rig = makeRig(
      { shadows: { mode: 'full', mapSize: 2048 } },
      { 'lighting.shadowMapSize': 512 },
    );
    expect(directionalLights(rig.scene)[0]!.shadow.mapSize.x).toBe(512);
  });
});

// ------------------------------------------------------- стоимость кадра

describe('счётчики стоимости теней (PERF-2, PERF-3)', () => {
  it('`none`: теневой проход бесплатен — все счётчики нулевые', () => {
    const rig = makeRig();
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.stage.frame(0.016, 0);
      rig.stage.frame(0.016, 0);
    });
    expect(cost.lightingStaticCasters).toBe(0);
    expect(cost.lightingDynamicCasters).toBe(0);
    expect(cost.lightingStaticRebuilds).toBe(0);
  });

  it('`hybrid`: статика платит перерисовками кэша, динамика — каждым кадром', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      // Кадр запекания плюс два установившихся.
      rig.stage.frame(0.016, 0);
      rig.stage.frame(0.016, 0);
      rig.stage.frame(0.016, 0);
    });
    expect(cost.lightingStaticRebuilds).toBe(1);
    // Статика — чанк террейна и батч декорации; посчитана один раз, на запекании.
    expect(cost.lightingStaticCasters).toBe(2);
    // Динамика — батч сущности, в двух установившихся кадрах.
    expect(cost.lightingDynamicCasters).toBe(2);
  });

  it('`full`: оба яруса платят каждым кадром — в этом и разница режимов', () => {
    const rig = makeRig({ shadows: { mode: 'full' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.stage.frame(0.016, 0);
      rig.stage.frame(0.016, 0);
    });
    expect(cost.lightingStaticCasters).toBe(4);
    expect(cost.lightingDynamicCasters).toBe(2);
    // Кэша статики в этом режиме нет вовсе, и перерисовывать нечего.
    expect(cost.lightingStaticRebuilds).toBe(0);
  });
});
