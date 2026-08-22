/**
 * Освещение сцены и режимы теней: конфигурация данными (секция `lighting`
 * парного документа, PRES-2, REND-29), подсистема-владелец источников (REND-8),
 * ярусы теневых кастеров (REND-30) и потолки пресета качества (QUAL-1, QUAL-3).
 *
 * Всё headless: источники, теневые камеры и флаги `castShadow`/`receiveShadow`
 * — данные, а не GPU-объекты, пока их некому нарисовать. Под тестом поэтому
 * ровно то, что решает подсистема: какие источники существуют, с какими
 * числами, чья теневая карта рисуется в этом кадре и кто в неё попадает. Сам
 * теневой проход three в прогоне не исполняется — это то же известное
 * ограничение, что у GLSL VAT-материала (`model/vatMaterial.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@game-mvp/core';
import type {
  PresentationLighting,
  PresentationLightingPhase,
  VisualManifest,
} from '@game-mvp/assets';
import {
  DEFAULT_CYCLE_TRANSITION_SECONDS,
  DEFAULT_LIGHTING_CONFIG,
  DEFAULT_MAX_LOCAL_LIGHTS,
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  QualityController,
  RenderDebugLayer,
  TerrainSubsystem,
  createCostCounters,
  minShadowMode,
  resolveLightingConfig,
  resolveLightingCycle,
  shadowModeRank,
  withCostSink,
  type DebugDraw,
  type DebugFrameState,
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

/**
 * Свет кадра числами: тона, интенсивности и позиция направленного источника —
 * ровно то, что двигает цикл времени суток, и то, чего он двигать не должен.
 */
function lightSnapshot(rig: Rig): unknown {
  const { ambient, sun, sunDynamic } = rig.lighting.lights;
  return {
    ambient: [ambient.color.getHexString(), ambient.intensity],
    sun: [sun.color.getHexString(), sun.intensity, ...sun.position.toArray()],
    sunDynamic: [sunDynamic.color.getHexString(), sunDynamic.intensity],
  };
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

  it('нет подсекции цикла — нет и цикла: действует статическая часть (REND-32)', () => {
    expect(resolveLightingCycle()).toBeUndefined();
    expect(resolveLightingCycle({ ambient: { intensity: 0.2 } })).toBeUndefined();
  });

  it('дыры фазы закрывает статическая часть секции, а её дыры — умолчания', () => {
    const cycle = resolveLightingCycle({
      ambient: { color: '#101010', intensity: 0.1 },
      directional: { color: '#fff0d0', intensity: 2.5, direction: { x: 1, y: 2, z: 3 } },
      shadows: { mode: 'full' },
      cycle: {
        phases: [
          { name: 'ночь', seconds: 30, ambient: { intensity: 0 } },
          { seconds: 60, directional: { intensity: 4, direction: { z: 9 } } },
        ],
      },
    });
    expect(cycle?.phases[0]).toEqual({
      name: 'ночь',
      seconds: 30,
      // Названное фазой — от неё, остальное — из статической части секции.
      ambientIntensity: 0,
      ambientColor: '#101010',
      directionalColor: '#fff0d0',
      directionalIntensity: 2.5,
      directionX: 1,
      directionY: 2,
      directionZ: 3,
    });
    // Имени автор не дал — пусто: словаря имён у механизма нет.
    expect(cycle?.phases[1]?.name).toBe('');
    expect(cycle?.phases[1]?.directionalIntensity).toBe(4);
    // Дыра направления закрывается покомпонентно, а не тройкой целиком.
    expect(cycle?.phases[1]).toMatchObject({ directionX: 1, directionY: 2, directionZ: 9 });
  });

  it('длительность перехода — документированное умолчание (REND-32)', () => {
    const section: PresentationLighting = {
      cycle: { phases: [{ seconds: 120 }, { seconds: 120 }] },
    };
    expect(DEFAULT_CYCLE_TRANSITION_SECONDS).toBe(15);
    expect(resolveLightingCycle(section)?.transitionSeconds).toBe(
      DEFAULT_CYCLE_TRANSITION_SECONDS,
    );
    const authored = { cycle: { transitionSeconds: 2, phases: [{ seconds: 10 }, { seconds: 10 }] } };
    expect(resolveLightingCycle(authored)?.transitionSeconds).toBe(2);
  });

  it('умолчание перехода не съедает слот короткой фазы — оно ограничено его половиной', () => {
    // Авторское число на этой границе отвергает валидация формата (PRES-2), но
    // ненаписанное отвергать нечего: умолчание обязано быть безопасным для сцены
    // с любыми длительностями, иначе фаза короче пятнадцати секунд не держала бы
    // своего облика ни секунды — то есть цикл вырождался бы в дрейф (design D1).
    expect(resolveLightingCycle({ cycle: { phases: [{ seconds: 10 }, { seconds: 30 }] } })).toEqual(
      expect.objectContaining({ transitionSeconds: 5 }),
    );
    // Ограничение — по САМОЙ КОРОТКОЙ фазе: длина перехода одна на цикл.
    expect(
      resolveLightingCycle({ cycle: { phases: [{ seconds: 120 }, { seconds: 4 }] } })
        ?.transitionSeconds,
    ).toBe(2);
    // Там, где умолчание и так короче половины слота, оно действует как есть.
    expect(
      resolveLightingCycle({ cycle: { phases: [{ seconds: 120 }, { seconds: 40 }] } })
        ?.transitionSeconds,
    ).toBe(DEFAULT_CYCLE_TRANSITION_SECONDS);
    // Написанное автором число не правится: слишком длинное отвергнуто выше.
    expect(
      resolveLightingCycle({ cycle: { transitionSeconds: 9, phases: [{ seconds: 10 }, { seconds: 10 }] } })
        ?.transitionSeconds,
    ).toBe(9);
  });

  it('вырожденный цикл подсистеме не отдаётся: его дело — валидация формата', () => {
    // Такой документ отвергается валидацией адресно (PRES-2), и второго,
    // необъявленного прочтения этих данных здесь не заводится.
    expect(resolveLightingCycle({ cycle: { phases: [{ seconds: 10 }] } })).toBeUndefined();
    expect(
      resolveLightingCycle({ cycle: { phases: [{ seconds: 0 }, { seconds: 10 }] } }),
    ).toBeUndefined();
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

  it('непрерывная инвалидация кэша: фазы чередуются, динамика не голодает (REND-30)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    const [sun, sunDynamic] = directionalLights(rig.scene);

    // Поток событий инвалидации без затишья — та же нагрузка, что мутация пола
    // каждый тик (TERR-6) или перетаскивание декорации в редакторе (ED-15).
    const phases: ('static' | 'dynamic')[] = [];
    for (let frame = 0; frame < 8; frame++) {
      rig.lighting.invalidateStatic();
      rig.stage.frame(0.016, 0);
      phases.push(sun!.shadow.needsUpdate ? 'static' : 'dynamic');
    }

    // Ни одной пары статических кадров подряд: перерисовка кэша MUST NOT
    // голодить динамическую карту, и каждая отстаёт не более чем на кадр.
    expect(phases).toEqual([
      'static',
      'dynamic',
      'static',
      'dynamic',
      'static',
      'dynamic',
      'static',
      'dynamic',
    ]);
    // Динамическая карта в её кадры действительно рисуется — тени юнитов
    // следуют за ними, а не застывают на всё время мутаций.
    expect(sunDynamic!.shadow.needsUpdate).toBe(true);
    expect(rig.lighting.staticRebuilds).toBe(4);
  });

  it('без динамических кастеров чередование не нужно: статика перерисовывается подряд', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    // Реестр динамики пуст — голодать нечему, и ворота чередования не мешают
    // кэшу догонять поток событий каждым кадром.
    for (let frame = 0; frame < 4; frame++) {
      rig.lighting.invalidateStatic();
      rig.stage.frame(0.016, 0);
    }
    expect(rig.lighting.casterCount('dynamic')).toBe(0);
    expect(rig.lighting.staticRebuilds).toBe(4);
  });

  it('счётчики стоимости под непрерывной инвалидацией: динамика ненулевая (PERF-2)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      for (let frame = 0; frame < 8; frame++) {
        rig.lighting.invalidateStatic();
        rig.stage.frame(0.016, 0);
      }
    });
    // Ровно то, чем регрессия ловится в эталонах стоимости: число динамических
    // кастеров за окно ненулевое (REND-30).
    expect(cost.lightingDynamicCasters).toBe(4);
    expect(cost.lightingStaticRebuilds).toBe(4);
  });

  it('новый динамический кастер не заставляет обходить весь реестр (design D7)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0); // кадр запекания статики
    rig.stage.frame(0.016, 0); // установившийся кадр: фаза — динамика

    // Спай на обходе поддерева: `applyPhase` прошёлся бы по ВСЕМ корням
    // реестра, точечный путь — только по пришедшему (design D7).
    const roots = [...rig.scene.children];
    const traverse = vi.spyOn(THREE.Object3D.prototype, 'traverse');
    let calls = -1;
    try {
      const fresh = new THREE.Group();
      rig.lighting.setCaster(fresh, 'dynamic');
      calls = traverse.mock.calls.length;
    } finally {
      traverse.mockRestore();
    }
    // Ровно один обход — поддерева нового корня.
    expect(calls).toBe(1);
    expect(rig.lighting.casterCount('dynamic')).toBe(2);
    // Реестр при этом не потерялся: сцена та же, а флаги нового корня уже
    // стоят по текущей фазе — динамическую карту следующий кадр рисует с ним.
    expect([...rig.scene.children]).toEqual(roots);
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

// -------------------------------------------------- цикл времени суток

/**
 * Секция с циклом: две фазы по 10 секунд, кроссфейд — 2 секунды в ХВОСТЕ слота.
 * Отсюда раскладка круга: держание облика [0, 8), переход [8, 10), и круг длится
 * ровно 20 секунд — сумму длительностей фаз (REND-32).
 *
 * Значения выбраны так, чтобы доля перехода читалась глазом: интенсивности
 * 1 → 0, тон белый → чёрный. Направление у обеих фаз общее, если не сказано
 * иное: движется оно только там, где предмет теста — тени (design D3).
 */
const PHASES: readonly PresentationLightingPhase[] = [
  {
    name: 'день',
    seconds: 10,
    ambient: { color: '#ffffff', intensity: 1 },
    directional: { color: '#ffffff', intensity: 2, direction: { x: 0, y: 0, z: 10 } },
  },
  {
    name: 'ночь',
    seconds: 10,
    ambient: { color: '#000000', intensity: 0 },
    directional: { color: '#000000', intensity: 0, direction: { x: 0, y: 0, z: 10 } },
  },
];

function cycleSection(overrides: Partial<PresentationLighting> = {}): PresentationLighting {
  return {
    ambient: { color: '#808080', intensity: 0.5 },
    directional: { color: '#808080', intensity: 0.5, direction: { x: 0, y: 0, z: 10 } },
    cycle: { transitionSeconds: 2, phases: PHASES },
    ...overrides,
  };
}

/** Подставные часы кадра: presentation-время идёт ровно на столько (design D2). */
function advance(rig: Rig, seconds: number): void {
  rig.stage.frame(1 / 60, 0, seconds);
}

describe('цикл времени суток — исполнение подсистемой (REND-32)', () => {
  it('сцена без цикла: кадры свет не двигают и кэш статики не трогают', () => {
    const rig = makeRig({ ambient: { intensity: 0.4 }, shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);
    const before = lightSnapshot(rig);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Час presentation-времени: покадровой работы у цикла нет вовсе, потому что
    // самого цикла нет — кадр байт-в-байт тот же, что до появления REND-32.
    for (let frame = 0; frame < 60; frame++) advance(rig, 60);

    expect(lightSnapshot(rig)).toEqual(before);
    expect(rig.lighting.staticRebuilds).toBe(1);
  });

  it('применение секции ставит первую фазу сразу, а не первым кадром (ED-15)', () => {
    const rig = makeRig(cycleSection());
    // Ни одного кадра ещё не было, а арена уже освещена первой фазой: иначе
    // сцена с циклом показала бы кадр статической частью секции.
    expect(rig.lighting.lights.ambient.intensity).toBe(1);
    expect(rig.lighting.lights.sun.intensity).toBe(2);
    expect(rig.lighting.lights.ambient.color.getHexString()).toBe('ffffff');
  });

  it('установившаяся фаза держит свой облик, кроссфейд идёт в хвосте слота', () => {
    const rig = makeRig(cycleSection());
    advance(rig, 7);
    // Семь секунд из десяти — облик первой фазы неподвижен.
    expect(rig.lighting.lights.ambient.intensity).toBe(1);

    // Половина перехода: значения ровно посередине между фазами.
    advance(rig, 2);
    expect(rig.lighting.lights.ambient.intensity).toBeCloseTo(0.5, 6);
    expect(rig.lighting.lights.sun.intensity).toBeCloseTo(1, 6);
    expect(rig.lighting.lights.ambient.color.getHexString()).not.toBe('ffffff');

    // Граница слота: вторая фаза встала точно, без остатка кроссфейда.
    advance(rig, 1);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);
    expect(rig.lighting.lights.sun.intensity).toBe(0);
    expect(rig.lighting.lights.ambient.color.getHexString()).toBe('000000');
  });

  it('круг замыкается на сумме длительностей фаз и возвращается к первой без скачка', () => {
    const rig = makeRig(cycleSection());
    const first = lightSnapshot(rig);

    // Двадцать секунд — полный круг: две фазы по десять.
    advance(rig, 20);
    expect(lightSnapshot(rig)).toEqual(first);

    // И круг именно круг, а не единичный проход: следующая его точка — та же,
    // что в первом обороте.
    advance(rig, 9);
    const mid = lightSnapshot(rig);
    advance(rig, 20);
    expect(lightSnapshot(rig)).toEqual(mid);
  });

  it('долгая пауза кадровых часов не обходит фазы по одной и садится в ту же точку', () => {
    const rig = makeRig(cycleSection());
    advance(rig, 9);
    const mid = lightSnapshot(rig);
    // Скрытая вкладка на полсуток: круг периодичен, и остаток даёт ту же точку.
    advance(rig, 20 * 1000);
    expect(lightSnapshot(rig)).toEqual(mid);
  });

  it('кадр без хода времени цикл не двигает и назад не отматывает', () => {
    const rig = makeRig(cycleSection());
    advance(rig, 9);
    const mid = lightSnapshot(rig);
    advance(rig, 0);
    advance(rig, -5);
    advance(rig, Number.NaN);
    expect(lightSnapshot(rig)).toEqual(mid);
  });

  it('переход длиной в слот укорачивается до него: круг идёт, скачка нет', () => {
    // Документ с таким переходом валидация отвергает адресно (PRES-2), а
    // умолчание до такой длины не дорастает — сюда он попадает только руками.
    // Подсистеме тогда положено вести себя предсказуемо: фаза целиком под
    // кроссфейдом, фазы сменяются по кругу, на границе слота — точные значения.
    const rig = makeRig(cycleSection({ cycle: { transitionSeconds: 30, phases: PHASES } }));
    expect(rig.lighting.lights.ambient.intensity).toBe(1);

    // Слот 10 с целиком под кроссфейдом: половина пути пройдена к пятой секунде.
    advance(rig, 5);
    expect(rig.lighting.lights.ambient.intensity).toBeCloseTo(0.5, 6);
    // Граница слота — вторая фаза точно, без остатка кроссфейда и без зависания.
    advance(rig, 5);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);
    advance(rig, 10);
    expect(rig.lighting.lights.ambient.intensity).toBe(1);
  });

  it('правка секции перезапускает круг с начала первой фазы (ED-15, REND-32)', () => {
    const rig = makeRig(cycleSection());
    advance(rig, 12);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);

    // Автор правит фазу — облик воспроизводим: круг идёт с начала.
    rig.lighting.applyConfig(cycleSection());
    expect(rig.lighting.lights.ambient.intensity).toBe(1);

    // Тем же швом идут потолок пресета и смена сетки арены (design D2).
    advance(rig, 12);
    rig.lighting.applyQuality(new Map([['lighting.shadowMode', 'none']]));
    expect(rig.lighting.lights.ambient.intensity).toBe(1);
    advance(rig, 12);
    rig.lighting.applyGrid(flatGrid(16));
    expect(rig.lighting.lights.ambient.intensity).toBe(1);
  });

  it('снятая подсекция возвращает статический свет секции', () => {
    const rig = makeRig(cycleSection());
    expect(rig.lighting.lights.ambient.intensity).toBe(1);

    rig.lighting.applyConfig({ ambient: { intensity: 0.4 } });
    advance(rig, 30);
    expect(rig.lighting.lights.ambient.intensity).toBe(0.4);
  });

  it('пара ярусов `hybrid` светит как один источник на любом кадре перехода', () => {
    const rig = makeRig(
      cycleSection({ shadows: { mode: 'hybrid', staticShare: 0.25 } }),
    );
    advance(rig, 9);
    const { sun, sunDynamic } = rig.lighting.lights;
    // Доля применяется к УЖЕ слерпленной сумме: половина пути от 2 к 0 — это 1.
    expect(sun.intensity + sunDynamic.intensity).toBeCloseTo(1, 6);
    expect(sun.intensity).toBeCloseTo(0.25, 6);
  });

  it('потолок пресета фаз не касается — ограничивать ему в них нечего (QUAL-1)', () => {
    const rig = makeRig(cycleSection({ shadows: { mode: 'full' } }), {
      'lighting.shadowMode': 'none',
    });
    // Тени сняты пресетом, а значения фазы — авторские: теневых полей в фазе нет.
    expect(rig.lighting.config.shadowMode).toBe('none');
    expect(rig.lighting.lights.ambient.intensity).toBe(1);
    advance(rig, 10);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);
  });
});

describe('тени на переходе фаз (design D3, REND-32)', () => {
  /** Тот же цикл, но солнце едет: у фаз разные направления. */
  function movingSun(): PresentationLighting {
    const section = cycleSection({ shadows: { mode: 'hybrid' } });
    const phases = section.cycle?.phases ?? [];
    return {
      ...section,
      cycle: {
        transitionSeconds: 2,
        phases: [
          { ...phases[0]!, directional: { ...phases[0]!.directional, direction: { x: 0, y: 0, z: 10 } } },
          { ...phases[1]!, directional: { ...phases[1]!.directional, direction: { x: 10, y: 0, z: 4 } } },
        ],
      },
    };
  }

  it('равные направления соседних фаз: кэш статики не трогается вовсе', () => {
    const rig = makeRig(cycleSection({ shadows: { mode: 'hybrid' } }));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    advance(rig, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Полтора круга по секунде на кадр: свет уехал, а карта глубины от тона не
    // зависит — переход бесплатен для теней при любой длине.
    for (let frame = 0; frame < 30; frame++) advance(rig, 1);
    expect(rig.lighting.staticRebuilds).toBe(1);
    expect(rig.lighting.lights.sun.intensity).not.toBe(2);
  });

  it('движется направление — кэш статики перерисовывается кадрами перехода', () => {
    const rig = makeRig(movingSun());
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    advance(rig, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Семь секунд установившейся фазы: кэш событиен, как без цикла (REND-30).
    for (let frame = 0; frame < 7; frame++) advance(rig, 1);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Оба кадра перехода (8-я и 9-я секунды) устаревают кэш, и оба его
    // перерисовывают: динамики в этой сцене нет вовсе, поэтому ворота
    // чередования REND-30 статику не придерживают. Третий — кадр установившейся
    // фазы, добивающий кэш её точным направлением.
    const before = rig.lighting.lights.sun.position.x;
    for (let frame = 0; frame < 3; frame++) advance(rig, 1);
    expect(rig.lighting.staticRebuilds).toBe(4);
    expect(rig.lighting.lights.sun.position.x).not.toBe(before);

    // Вторая фаза установилась — кэш снова событиен.
    for (let frame = 0; frame < 5; frame++) advance(rig, 1);
    expect(rig.lighting.staticRebuilds).toBe(4);
  });

  it('покадровая карта динамики на переходе не застывает', () => {
    const rig = makeRig(movingSun());
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    advance(rig, 0);
    const { sun, sunDynamic } = rig.lighting.lights;

    // Переход из тридцати кадров: цикл устаревает кэш КАЖДЫМ кадром, карта у
    // источника одна на кадр, и делят они кадры воротами чередования REND-30 —
    // теми же, что под потоком инвалидаций пола. Без чередования тени бойцов
    // застыли бы на всю длину перехода (REND-32).
    let staticFrames = 0;
    let dynamicFrames = 0;
    advance(rig, 8);
    for (let frame = 0; frame < 30; frame++) {
      advance(rig, 2 / 30);
      if (sun.shadow.needsUpdate) staticFrames++;
      if (sunDynamic.shadow.needsUpdate) dynamicFrames++;
    }
    expect(staticFrames).toBeGreaterThan(10);
    expect(dynamicFrames).toBeGreaterThan(10);
    // И ровно один источник за кадр — правило кадра не сломано.
    expect(staticFrames + dynamicFrames).toBe(30);
  });

  it('кроссфейд без движения источника не удорожает кадр под потоком событий (PERF-3)', () => {
    /**
     * Два прогона одной и той же работы: установившаяся фаза и кроссфейд с
     * РАВНЫМИ направлениями соседних фаз, оба под непрерывным потоком событий
     * инвалидации — мутацией пола каждым тиком (TERR-6, сценарий REND-30
     * «Непрерывная мутация пола»). Чередование ярусов в обоих случаях создаёт
     * поток событий, а не цикл: направление стоит, и для теней такой переход
     * бесплатен при любой длине (design D3).
     */
    const run = (fading: boolean): Record<string, number> => {
      const rig = makeRig(cycleSection({ shadows: { mode: 'hybrid' } }));
      rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
      rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
      // Кадр запекания кэша — до замера; у второго прогона он же вводит цикл в
      // окно кроссфейда [8, 10), чтобы измеряемые кадры отличались только им.
      advance(rig, fading ? 8 : 0);
      const cost = createCostCounters();
      withCostSink(cost, () => {
        for (let frame = 0; frame < 24; frame++) {
          rig.lighting.invalidateStatic();
          advance(rig, 1 / 60);
        }
      });
      return { ...cost };
    };
    const settled = run(false);
    const crossfade = run(true);

    // Работа кадров одна и та же — и счётчики обязаны совпасть: записывать на
    // цикл работу потока событий значило бы удваивать эталон ни на чём.
    expect(crossfade.lightingStaticCasters).toBe(settled.lightingStaticCasters);
    expect(crossfade.lightingDynamicCasters).toBe(settled.lightingDynamicCasters);
    expect(crossfade.lightingStaticRebuilds).toBe(settled.lightingStaticRebuilds);
    // И проверялось не отсутствие работы: под потоком событий ярусы чередуются,
    // и обе карты рисуются (REND-30).
    expect(settled.lightingStaticRebuilds).toBeGreaterThan(0);
    expect(settled.lightingDynamicCasters).toBeGreaterThan(0);
  });

  it('стоимость перехода видна счётчиками, а не спрятана от них (PERF-3)', () => {
    const rig = makeRig(movingSun());
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      advance(rig, 0);
      for (let frame = 0; frame < 10; frame++) advance(rig, 1);
    });
    // Кадр запекания, кадр перехода и добивающий кадр установившейся фазы.
    expect(cost.lightingStaticRebuilds).toBe(3);
    // Статика — чанк террейна и батч декорации — по паре корней на кадр:
    // запекание, кадр перехода, рисующий её карту, добивающий кадр фазы —
    // и ЧЕТВЁРТЫМ кадр перехода, который её карту не рисовал, но переставил ей
    // флаги, меняя ярусы местами (`applyPhase`). Эта четвёртая пара и есть
    // покадровая работа цикла, которую declaration объявляет вслух (QUAL-3).
    expect(cost.lightingStaticCasters).toBe(8);
    // Динамика — батч сущности: семь установившихся кадров первой фазы, кадр
    // перехода со своей картой и ДВА кадра, на которых ей переставили флаги под
    // сдвинувшимся источником (кадр перерисовки кэша и добивающий кадр фазы).
    expect(cost.lightingDynamicCasters).toBe(10);
  });

  it('переход не трогает фрустум теневой камеры, сторону карты и смещения выборки', () => {
    const rig = makeRig(movingSun());
    advance(rig, 0);
    const { sun } = rig.lighting.lights;
    const before = {
      right: sun.shadow.camera.right,
      far: sun.shadow.camera.far,
      map: sun.shadow.mapSize.x,
      normalBias: sun.shadow.normalBias,
      bias: sun.shadow.bias,
    };

    for (let frame = 0; frame < 10; frame++) advance(rig, 1);

    // Фрустум обтянут по арене и от направления света не зависит (design D6):
    // пересчитывать его кадром значило бы платить событием за картинку.
    expect(sun.shadow.camera.right).toBe(before.right);
    expect(sun.shadow.camera.far).toBe(before.far);
    expect(sun.shadow.mapSize.x).toBe(before.map);
    expect(sun.shadow.normalBias).toBe(before.normalBias);
    expect(sun.shadow.bias).toBe(before.bias);
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
  it('подсистема объявляет теневые ручки потолками, ручку локального света — значением', () => {
    const knobs = new LightingSubsystem().quality().knobs;
    expect(knobs.map((knob) => knob.name)).toEqual([
      'lighting.shadowMode',
      'lighting.shadowMapSize',
      'lighting.maxLocalLights',
    ]);
    for (const knob of knobs.slice(0, 2)) expect(knob.semantics).toBe('ceiling');
    // Умолчание потолка — «не ограничивать»: самый дорогой режим и бесконечность.
    expect(knobs[0]!.default).toBe('full');
    expect(knobs[1]!.default).toBe(Number.POSITIVE_INFINITY);
    // Потолок числа активных локальных источников (REND-33) — прямое значение:
    // авторского числа активных источников не существует, спорить пресету не с
    // чем, и умолчание у ручки своё, кодовое (QUAL-1).
    expect(knobs[2]!.semantics).toBe('value');
    expect(knobs[2]!.default).toBe(DEFAULT_MAX_LOCAL_LIGHTS);
  });

  it('цикл ручки не заводит: рычаг у его работы — потолок режима теней (QUAL-3, REND-32)', () => {
    // Работа цикла двухчастная, и константна только первая часть: интерполяция
    // значений — фиксированного размера, а вот кадр перехода в `hybrid` меняет
    // ярусы местами и переставляет флаги обоим реестрам кастеров, то есть платит
    // по числу корней сцены (design У3). Своей ручки этой работе не нужно:
    // `lighting.shadowMode` снимает её целиком — `none` теней не рисует, `full`
    // держит одну карту, и делить кадры между ярусами там не с чем.
    const cycled = new LightingSubsystem({ config: cycleSection() }).quality().knobs;
    expect(cycled.map((knob) => knob.name)).toEqual([
      'lighting.shadowMode',
      'lighting.shadowMapSize',
      'lighting.maxLocalLights',
    ]);
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

// ------------------ RDBG-1: отладочный источник освещения (REND-27, RDBG-2..8)

/** Секция дампа этого источника: читается ровно то, что кладёт проба. */
interface LightingSection {
  readonly units: string;
  readonly authoredSection: boolean;
  readonly lightCount: number;
  readonly ambientLights: number;
  readonly directionalLights: number;
  readonly ambientColor: string;
  readonly ambientIntensity: number;
  readonly directionalColor: string;
  readonly directionalIntensity: number;
  readonly sunIntensity: number;
  readonly sunDynamicIntensity: number;
  readonly lightWorldX: number;
  readonly lightWorldY: number;
  readonly lightWorldZ: number;
  readonly targetWorldX: number;
  readonly targetWorldY: number;
  readonly targetWorldZ: number;
  readonly arenaRadiusWorldUnits: number;
  readonly shadowFrustumHalfWorldUnits: number;
  readonly shadowMode: string;
  readonly authoredShadowMode: string;
  readonly ceilingShadowMode: string;
  readonly shadowMapTexels: number;
  readonly authoredShadowMapTexels: number;
  readonly ceilingShadowMapTexels: number | null;
  readonly staticShare: number;
  readonly shadowPhase: string;
  readonly staticCasterRoots: number;
  readonly dynamicCasterRoots: number;
  readonly staticRebuilds: number;
  readonly staticStale: boolean;
  readonly builtShadowMaps: number;
  readonly cyclePhases: number;
  readonly cyclePhaseIndex: number;
  readonly cyclePhaseName: string;
  readonly cyclePhaseAmbientColor: string;
  readonly cyclePhaseDirectionalColor: string;
  readonly cyclePhaseSeconds: number;
  readonly cycleTransition: boolean;
  readonly cycleTransitionSeconds: number;
  readonly noData?: string;
}

const LIGHTING_SOURCE = 'lighting.scene';

const IDLE_FRAME: DebugFrameState = { view: null, alpha: 0, dtSeconds: 0, realDtSeconds: 0 };

function section(layer: RenderDebugLayer): LightingSection {
  return layer.dump().sections[LIGHTING_SOURCE] as LightingSection;
}

/**
 * Записывающий словарь примитивов (RDBG-3): что источник нарисовал и чем.
 * Сцены он не видит и узлов не создаёт — вот весь его словарь и весь протокол.
 */
function capture(): {
  readonly points: number[][];
  readonly segments: number[][];
  readonly others: string[];
  readonly out: DebugDraw;
} {
  const points: number[][] = [];
  const segments: number[][] = [];
  const others: string[] = [];
  return {
    points,
    segments,
    others,
    out: {
      point: (x, y, z) => {
        points.push([x, y, z]);
      },
      segment: (x1, y1, z1, x2, y2, z2) => {
        segments.push([x1, y1, z1, x2, y2, z2]);
      },
      polyline: () => others.push('polyline'),
      circle: () => others.push('circle'),
      disc: () => others.push('disc'),
      box: () => others.push('box'),
      polygon: () => others.push('polygon'),
      raster: () => others.push('raster'),
    },
  };
}

describe('Отладочный источник освещения (render-debug RDBG-1, REND-27)', () => {
  it('источник объявлен подсистемой в точке её регистрации', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    const declared = layer.sources.find((source) => source.id === LIGHTING_SOURCE);
    expect(declared).toBeDefined();
    expect(declared?.owner).toBe('lighting');
    // Рисовальщик есть: позиция источника света в кадре не видна ничем.
    expect(declared?.drawable).toBe(true);
  });

  it('выключенный источник секции в дампе не имеет, и слой не работает вовсе', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    // «Выключено» — это ОТСУТСТВИЕ секции, а не секция «данных нет» (RDBG-7).
    expect(layer.dump().sections).toEqual({});
    expect(layer.frameCount).toBe(0);
  });

  it('включённый источник называет свет кадра, режим теней и ярусы кастеров', () => {
    const rig = makeRig({
      directional: { intensity: 2 },
      shadows: { mode: 'hybrid', mapSize: 512, staticShare: 0.25 },
    });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    const dumped = section(layer);
    expect(dumped.noData).toBeUndefined();
    // Секция документа была: «умолчания» и «автор написал ровно умолчания» —
    // разные ответы на вопрос, где эти числа искать (PRES-2).
    expect(dumped.authoredSection).toBe(true);
    // Пара направленных источников режима `hybrid` плюс рассеянный (REND-30).
    expect(dumped.ambientLights).toBe(1);
    expect(dumped.directionalLights).toBe(2);
    expect(dumped.lightCount).toBe(3);
    expect(dumped.ambientIntensity).toBe(DEFAULT_LIGHTING_CONFIG.ambientIntensity);
    expect(dumped.ambientColor).toBe('#ffffff');
    // Сумма — та, что написал автор; доля делит её между картами ярусов.
    expect(dumped.directionalIntensity).toBeCloseTo(2, 6);
    expect(dumped.sunIntensity).toBeCloseTo(0.5, 6);
    expect(dumped.sunDynamicIntensity).toBeCloseTo(1.5, 6);
    expect(dumped.staticShare).toBe(0.25);
    expect(dumped.shadowMode).toBe('hybrid');
    expect(dumped.shadowMapTexels).toBe(512);
    // Ярусы: статика — чанк террейна и батч декорации, динамика — батч сущности.
    expect(dumped.staticCasterRoots).toBe(rig.lighting.casterCount('static'));
    expect(dumped.dynamicCasterRoots).toBe(rig.lighting.casterCount('dynamic'));
    expect(dumped.staticCasterRoots).toBe(2);
    expect(dumped.dynamicCasterRoots).toBe(1);
    expect(dumped.staticRebuilds).toBe(rig.lighting.staticRebuilds);
    expect(dumped.staticStale).toBe(false);
    // Дамп описывает ТОТ ЖЕ кадр: позиция источника — та, что стоит в сцене.
    const sun = directionalLights(rig.scene)[0]!;
    expect(dumped.lightWorldX).toBeCloseTo(sun.position.x, 6);
    expect(dumped.lightWorldY).toBeCloseTo(sun.position.y, 6);
    expect(dumped.lightWorldZ).toBeCloseTo(sun.position.z, 6);
    // Цель — центр ровной арены 8×8 по клетке в мировую единицу.
    expect(dumped.targetWorldX).toBeCloseTo(4, 6);
    expect(dumped.targetWorldY).toBeCloseTo(4, 6);
    expect(dumped.arenaRadiusWorldUnits).toBeCloseTo(Math.hypot(8, 8) / 2, 6);
    expect(dumped.shadowFrustumHalfWorldUnits).toBeCloseTo(sun.shadow.camera.right, 6);
    // Теневого прохода в headless-прогоне не было: карту строит three, а не мы.
    expect(dumped.builtShadowMaps).toBe(0);
    // Единицы величин названы прозой — читатель дампа исходника не открывает.
    expect(dumped.units).toMatch(/мировые единицы/);
    expect(dumped.units).toMatch(/текселях/);
  });

  it('сцена без секции `lighting` — умолчания, и дамп называет это отдельным полем', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);

    const dumped = section(layer);
    expect(dumped.authoredSection).toBe(false);
    expect(dumped.directionalLights).toBe(1);
    expect(dumped.sunDynamicIntensity).toBe(0);
    expect(dumped.directionalIntensity).toBeCloseTo(
      DEFAULT_LIGHTING_CONFIG.directionalIntensity,
      6,
    );
    expect(dumped.shadowMode).toBe('none');
    expect(dumped.shadowPhase).toBe('none');
  });

  it('действующий режим стоит рядом с авторским и потолком пресета (QUAL-1)', () => {
    const authored: PresentationLighting = { shadows: { mode: 'full', mapSize: 2048 } };
    const rig = makeRig(authored, { 'lighting.shadowMode': 'none', 'lighting.shadowMapSize': 1024 });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);

    const dumped = section(layer);
    // Ровно то, ради чего авторское значение и потолок стоят рядом: сцена просит
    // `full`, а теней нет — и виноват пресет, а не потерянное поле документа.
    expect(dumped.shadowMode).toBe('none');
    expect(dumped.authoredShadowMode).toBe('full');
    expect(dumped.ceilingShadowMode).toBe('none');
    expect(dumped.shadowMapTexels).toBe(1024);
    expect(dumped.authoredShadowMapTexels).toBe(2048);
    expect(dumped.ceilingShadowMapTexels).toBe(1024);
  });

  it('пресета нет — потолок стороны карты выражен null, а не бесконечностью', () => {
    const rig = makeRig({ shadows: { mode: 'full' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);

    const dumped = section(layer);
    // Бесконечность числом дампа не бывает, и читатель принял бы её за
    // разрешение; потолок режима при этом честно равен `full` — потолка нет.
    expect(dumped.ceilingShadowMapTexels).toBeNull();
    expect(dumped.ceilingShadowMode).toBe('full');
  });

  it('фаза теневого прохода: кадр запекания кэша, а следом — установившийся', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));

    rig.stage.frame(0.016, 0);
    // Ответ на «почему тень декорации кадром старше»: этим кадром рисуется
    // карта статики, и динамическая его пропускает (REND-30).
    expect(section(layer).shadowPhase).toBe('static');
    expect(section(layer).staticRebuilds).toBe(1);

    rig.stage.frame(0.016, 0);
    expect(section(layer).shadowPhase).toBe('dynamic');
    expect(section(layer).staticRebuilds).toBe(1);
  });

  it('устаревший кэш и построенные карты теней видны в дампе, а не только в коде', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    expect(section(layer).staticStale).toBe(false);

    // Правка света — событие перерисовки кэша (REND-30): до ближайшего кадра он
    // устарел, и дамп обязан сказать это, а не показать вчерашнюю картину.
    rig.lighting.applyConfig({ directional: { intensity: 3 }, shadows: { mode: 'hybrid' } });
    expect(section(layer).staticStale).toBe(true);

    // Карту строит теневой проход three, которого в headless-прогоне нет:
    // подставляется готовая — предмет проверки не её содержимое, а то, что
    // «тени настроены, но прохода ещё не было» отличимо от «карты построены».
    const { sun, sunDynamic } = rig.lighting.lights;
    for (const light of [sun, sunDynamic]) {
      const map = new THREE.WebGLRenderTarget(4, 4);
      map.depthTexture = new THREE.DepthTexture(4, 4);
      light.shadow.map = map;
    }
    expect(section(layer).builtShadowMaps).toBe(2);
  });

  it('отметка стоит в позиции направленного источника, луч указывает на центр арены', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const source = rig.lighting.debugSources()[0]!;
    const drawn = capture();
    source.draw?.(source.probe(IDLE_FRAME), drawn.out);

    const sun = directionalLights(rig.scene)[0]!;
    // Отметка ОДНА и в `hybrid`: пара источников стоит в одной точке.
    expect(drawn.points).toHaveLength(1);
    expect(drawn.points[0]![0]).toBeCloseTo(sun.position.x, 6);
    expect(drawn.points[0]![1]).toBeCloseTo(sun.position.y, 6);
    expect(drawn.points[0]![2]).toBeCloseTo(sun.position.z, 6);
    // Луч на цель: направление света в кадре иначе не читается ничем.
    expect(drawn.segments).toHaveLength(1);
    expect(drawn.segments[0]!.slice(3)).toEqual([4, 4, 0]);
    // Рассеянный источник позиции не имеет и живёт только в дампе, а прочих
    // примитивов словаря источник не просит вовсе.
    expect(drawn.others).toEqual([]);
  });

  it('наложение рисует отладочный слой, и выключение убирает его из кадра целиком', () => {
    const overlay = new THREE.Scene();
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage, { scene: overlay });
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);
    // Отметка и луч: одна вершина точки плюс две концов отрезка (RDBG-3).
    expect(layer.vertexCount).toBe(3);
    expect(overlay.children.length).toBeGreaterThan(0);

    layer.setEnabled(LIGHTING_SOURCE, false);
    expect(layer.vertexCount).toBe(0);
    expect(overlay.children).toHaveLength(0);
  });

  it('снятая секция дампа не меняется от следующего кадра', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.frame(0.016, 0);
    const before = section(layer);
    const snapshot = JSON.stringify(before);

    // Проба ПЕРЕИСПОЛЬЗУЕТСЯ между кадрами (RDBG-2), и дамп, державший её
    // ссылкой, менялся бы задним числом от следующей правки света.
    rig.lighting.applyConfig({ directional: { intensity: 3 }, shadows: { mode: 'full' } });
    rig.stage.frame(0.016, 0);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(section(layer).shadowMode).toBe('full');
    expect(section(layer).directionalIntensity).toBeCloseTo(3, 6);
  });

  it('цикл в дампе: номер и имя фазы, длительности, флаг перехода (RDBG-2)', () => {
    const rig = makeRig(cycleSection({ shadows: { mode: 'hybrid' } }));
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    advance(rig, 0);

    const first = section(layer);
    expect(first.cyclePhases).toBe(2);
    expect(first.cyclePhaseIndex).toBe(0);
    // Имя — авторская строка документа, а не словарь механизма (REND-32).
    expect(first.cyclePhaseName).toBe('день');
    expect(first.cyclePhaseSeconds).toBe(10);
    expect(first.cycleTransitionSeconds).toBe(2);
    expect(first.cycleTransition).toBe(false);
    // Тон фазы едет СВОИМ полем и не подменяет собой тон действующей
    // конфигурации: на переходе источники покрашены смесью двух фаз, и выдай
    // дамп авторский тон одной из них за тон кадра — он говорил бы неправду.
    expect(first.cyclePhaseAmbientColor).toBe('#ffffff');
    expect(first.cyclePhaseDirectionalColor).toBe('#ffffff');
    expect(first.ambientColor).toBe('#808080');
    expect(first.directionalColor).toBe('#808080');

    advance(rig, 9);
    const fading = section(layer);
    expect(fading.cycleTransition).toBe(true);
    expect(fading.cyclePhaseIndex).toBe(0);
    // Идёт кроссфейд от «дня» — тон фазы всё ещё его, а доля смеси названа
    // часовой величиной в секции clock.
    expect(fading.cyclePhaseAmbientColor).toBe('#ffffff');

    advance(rig, 1);
    const night = section(layer);
    expect(night.cyclePhaseIndex).toBe(1);
    expect(night.cyclePhaseName).toBe('ночь');
    expect(night.cyclePhaseAmbientColor).toBe('#000000');
    expect(night.cycleTransition).toBe(false);
  });

  it('доли прожитого фазой и переходом — часовые величины, и они в секции clock (RDBG-7)', () => {
    const rig = makeRig(cycleSection());
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    advance(rig, 9);

    const dumped = layer.dump();
    // Выведенное из кадровых часов названо отдельно: смешанное с остальным, оно
    // превратило бы всякий дифф дампа в шум.
    expect(dumped.clock[`${LIGHTING_SOURCE}.cyclePhaseProgress`]).toBeCloseTo(0.9, 6);
    expect(dumped.clock[`${LIGHTING_SOURCE}.cycleTransitionProgress`]).toBeCloseTo(0.5, 6);
    // В секцию источника они не попадают вовсе.
    expect(section(layer)).not.toHaveProperty('cyclePhaseProgress');
  });

  it('сцена без цикла: фазы нет, и часовых величин у источника нет ни одной', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    advance(rig, 1);

    const dumped = section(layer);
    expect(dumped.cyclePhases).toBe(0);
    // «Цикла нет» и «идёт первая фаза» — разные ответы (HUD-8, RDBG-7).
    expect(dumped.cyclePhaseIndex).toBe(-1);
    expect(dumped.cyclePhaseName).toBe('');
    expect(dumped.cyclePhaseAmbientColor).toBe('');
    expect(
      Object.keys(layer.dump().clock).some((key) => key.startsWith(`${LIGHTING_SOURCE}.`)),
    ).toBe(false);
  });

  it('два дампа на одном доставленном состоянии совпадают: часовых величин у источника нет', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(LIGHTING_SOURCE, true);
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    const first = layer.dump();
    const second = layer.dump();
    expect(second.sections).toEqual(first.sections);
    // Свет не зависит ни от тика, ни от часов главного потока (RDBG-7).
    expect(Object.keys(first.clock).some((key) => key.startsWith(`${LIGHTING_SOURCE}.`))).toBe(
      false,
    );
  });

  it('счётчики кадра с включённым источником и без него совпадают побитово (RDBG-8)', () => {
    const run = (debug: boolean): Record<string, number> => {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        const rig = makeRig({ shadows: { mode: 'hybrid' } });
        const layer = new RenderDebugLayer(rig.stage);
        if (debug) layer.setEnabled(LIGHTING_SOURCE, true);
        rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
        for (let tick = 1; tick <= 8; tick += 1) {
          rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })], { tick }));
          rig.stage.frame(1 / 60, 0.5, 1 / 60);
        }
      });
      return { ...counters };
    };
    const withDebug = run(true);
    const without = run(false);
    expect(withDebug).toEqual(without);
    // И проверялось не отсутствие работы: счётчики теней непустые.
    expect(without.lightingStaticCasters).toBeGreaterThan(0);
    expect(without.lightingDynamicCasters).toBeGreaterThan(0);
  });

  it('подсистему в сцену не отдали — источник говорит «нет данных» (RDBG-6)', () => {
    // Сцена без освещения вовсе: подсистема создана, но `init` ей не звали, и
    // источников света в кадре нет. Показывать тогда нечего, и молчать об этом
    // источник не вправе — выдуманный свет был бы хуже пустоты.
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const stage = new PresentationStage(ctx);
    const layer = new RenderDebugLayer(stage);
    layer.register(new LightingSubsystem().debugSources()[0]!);
    layer.setEnabled(LIGHTING_SOURCE, true);
    stage.frame(0.016, 0);

    expect(section(layer).noData).toMatch(/не отдана сцене/);
    // Наложения у источника без данных нет: рисовальщика слой не зовёт вовсе.
    expect(layer.vertexCount).toBe(0);
  });
});
