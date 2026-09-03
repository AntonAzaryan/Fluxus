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
import { FIXED_ONE, createTerrainGrid, type EntityId, type TerrainGrid } from '@fluxus/core';
import type {
  PresentationLighting,
  PresentationLightingPhase,
  VisualManifest,
} from '@fluxus/assets';
import {
  DEFAULT_CYCLE_TRANSITION_SECONDS,
  DEFAULT_HEMISPHERE,
  DEFAULT_LIGHTING_CONFIG,
  DEFAULT_MAX_LOCAL_LIGHTS,
  DEFAULT_RIM,
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
  type ShadowRendererLike,
} from '../src/index.js';
import { OptionalLights } from '../src/lighting/optionalLights.js';
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
  /** Порт теневых проходов стенда; `null` — сборка его не дала (REND-30). */
  readonly renderer: ShadowRendererLike | null;
}

/**
 * Сцена подсистем в порядке регистрации сборок (REND-8): свет, террейн, модели.
 * Модель разрешается сразу — батчевый ярус (REND-20) собирается той же
 * доставкой, и тестировать заглушку вместо него незачем.
 */
/**
 * Рендерер глазами теневых проходов (REND-30): записывает, чью глубину заказала
 * подсистема и куда написан композит, и повторяет ЕДИНСТВЕННОЕ наблюдаемое
 * следствие настоящего прохода three — снятый флаг `needsUpdate` у источника,
 * чью карту он нарисовал. Живого WebGL для этого не нужно: под тестом решения
 * подсистемы, а не содержимое карт (то же ограничение, что у GLSL-материалов).
 */
class ShadowRendererSpy implements ShadowRendererLike {
  /** Цели теневых проходов в порядке заказа: по ним видно чередование ярусов. */
  readonly depthPasses: (THREE.RenderTarget | null)[] = [];
  /** Сцены полноэкранных проходов — сведения (REND-30). */
  readonly rendered: THREE.Object3D[] = [];
  readonly targets: (THREE.WebGLRenderTarget | null)[] = [];
  /**
   * Рисует ли проход на самом деле. `false` — та самая ситуация, ради которой
   * подсистема подтверждает перерисовку фактом, а не решением: тени у
   * потребителя выключены либо контекст потерян, и `needsUpdate` остаётся
   * поднятым (REND-30).
   */
  drawing = true;
  readonly shadowMap = {
    enabled: true,
    render: (lights: readonly THREE.Light[]): void => {
      for (const light of lights) {
        const shadow = (light as THREE.DirectionalLight).shadow;
        this.depthPasses.push(shadow.map);
        // Проход three снимает флаг, отрисовав карту, — и ровно по нему
        // подсистема подтверждает состоявшуюся перерисовку (REND-30).
        if (this.drawing) shadow.needsUpdate = false;
      }
    },
  };

  render(scene: THREE.Object3D): void {
    this.rendered.push(scene);
  }

  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.targets.push(target);
  }
}

function makeRig(
  config?: PresentationLighting,
  preset?: QualityPreset,
  options: { readonly fadeSeconds?: number; readonly renderer?: ShadowRendererLike | null } = {},
): Rig {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const stage = new PresentationStage(ctx);
  const grid = flatGrid();
  // Порт рендерера у стенда есть по умолчанию: без него режим `hybrid`
  // исполняется как `full` (сведение вести нечем), и тесты чередования ярусов
  // проверяли бы не тот режим. Сборка без порта — свой тест, `null` здесь.
  const renderer = options.renderer === undefined ? new ShadowRendererSpy() : options.renderer;
  const lighting = new LightingSubsystem({
    grid,
    ...(config === undefined ? {} : { config }),
    ...(renderer === null ? {} : { renderer }),
  });
  stage.register(lighting);
  const terrain = new TerrainSubsystem(grid, { shadows: lighting });
  stage.register(terrain);
  const models = new ModelsSubsystem(makeManifest(), {
    shadows: lighting,
    warn: () => {},
    ...(options.fadeSeconds === undefined ? {} : { fadeSeconds: options.fadeSeconds }),
  });
  stage.register(models);
  if (preset !== undefined) new QualityController(stage, preset);
  assets.resolve('model', MODEL_ID, makeModel());
  return { stage, lighting, models, terrain, scene, renderer };
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
  const { ambient, sun } = rig.lighting.lights;
  return {
    ambient: [ambient.color.getHexString(), ambient.intensity],
    sun: [sun.color.getHexString(), sun.intensity, ...sun.position.toArray()],
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
      shadows: { mode: 'full', mapSize: 512 },
    });
    expect(config).toEqual({
      ambientColor: '#101010',
      ambientIntensity: 0.1,
      directionalColor: '#fff0d0',
      directionalIntensity: 2.5,
      directionX: 1,
      directionY: 2,
      directionZ: 3,
      hemisphere: undefined,
      rim: undefined,
      shadowMode: 'full',
      shadowMapSize: 512,
    });
  });

  it('REND-29: нет подсекции — нет источника, а не источник с умолчаниями', () => {
    // Второго способа записать «выключено» у формата нет: `undefined` здесь —
    // единственное прочтение отсутствия, и на нём держится «байт-в-байт».
    expect(DEFAULT_LIGHTING_CONFIG.hemisphere).toBeUndefined();
    expect(DEFAULT_LIGHTING_CONFIG.rim).toBeUndefined();
    expect(resolveLightingConfig({}).hemisphere).toBeUndefined();
    expect(resolveLightingConfig({}).rim).toBeUndefined();
  });

  it('REND-29: написанная подсекция заводит источник, дыры полей — умолчания', () => {
    const empty = resolveLightingConfig({ hemisphere: {}, rim: {} });
    expect(empty.hemisphere).toEqual(DEFAULT_HEMISPHERE);
    expect(empty.rim).toEqual(DEFAULT_RIM);

    const authored = resolveLightingConfig({
      hemisphere: { skyColor: '#88aaff', intensity: 0.25 },
      rim: { color: '#ffe8c0', direction: { x: -1, z: 5 } },
    });
    expect(authored.hemisphere).toEqual({
      skyColor: '#88aaff',
      groundColor: DEFAULT_HEMISPHERE.groundColor,
      intensity: 0.25,
    });
    expect(authored.rim).toEqual({
      color: '#ffe8c0',
      intensity: DEFAULT_RIM.intensity,
      directionX: -1,
      directionY: DEFAULT_RIM.directionY,
      directionZ: 5,
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

  it('режим `hybrid` НЕ заводит второго источника и не делит интенсивность', () => {
    // Прежняя пара источников гасила по половине вклада каждая, и тень от
    // одного лишь здания выходила вдвое светлее, чем в `full`. Ярусы теперь
    // живут в целях глубины, а не в источниках (REND-30): источник один, и
    // интенсивность у него авторская целиком.
    const rig = makeRig({ directional: { intensity: 2 }, shadows: { mode: 'hybrid' } });

    const lights = directionalLights(rig.scene);
    expect(lights.length).toBe(1);
    expect(lights[0]!.intensity).toBeCloseTo(2, 6);
    expect(lights[0]!.castShadow).toBe(true);
  });

  it('затенение `hybrid` равно `full`: тот же источник и та же его сила', () => {
    // Тень темна ровно настолько, насколько гасится вклад источника, а гасит её
    // одна карта на оба яруса — значит, тень от статики так же темна, как от
    // динамики, и обе — как в `full` (REND-30).
    const hybrid = makeRig({ directional: { intensity: 1.7 }, shadows: { mode: 'hybrid' } });
    const full = makeRig({ directional: { intensity: 1.7 }, shadows: { mode: 'full' } });

    const hybridLights = directionalLights(hybrid.scene);
    const fullLights = directionalLights(full.scene);
    expect(hybridLights.length).toBe(fullLights.length);
    expect(hybridLights[0]!.intensity).toBe(fullLights[0]!.intensity);
    expect(hybrid.lighting.lights.sun.castShadow).toBe(full.lighting.lights.sun.castShadow);
  });

  it('смена режима на `none` снимает тени с единственного источника', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    expect(directionalLights(rig.scene).length).toBe(1);

    rig.lighting.applyConfig({ shadows: { mode: 'none' } });

    expect(directionalLights(rig.scene).length).toBe(1);
    expect(directionalLights(rig.scene)[0]!.castShadow).toBe(false);
  });

  it('источник, переставший нести тени, отдаёт построенную карту', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const { sun } = rig.lighting.lights;
    // Карту строит теневой проход three, которого в headless-прогоне нет:
    // подставляется готовая — предмет теста не её содержимое, а владение ею.
    const map = new THREE.WebGLRenderTarget(4, 4);
    map.depthTexture = new THREE.DepthTexture(4, 4);
    sun.shadow.map = map;

    rig.lighting.applyConfig({ shadows: { mode: 'none' } });

    // `none` — теневого прохода нет вовсе, и держать текстуру глубины незачем.
    expect(sun.shadow.map).toBeNull();
  });
});

// ------------------------------ полусферная подсветка и контровой источник

/** Полусферные подсветки сцены — их число и есть наблюдаемое «есть/нет». */
function hemisphereLights(scene: THREE.Scene): THREE.HemisphereLight[] {
  return scene.children.filter(
    (node) => (node as THREE.HemisphereLight).isHemisphereLight,
  ) as THREE.HemisphereLight[];
}

describe('полусферная подсветка и контровой источник (REND-29)', () => {
  it('сцена без подсекций: сцена-граф ровно тот же, что до появления возможности', () => {
    const rig = makeRig();
    // «Нет подсекции — нет источника»: ни полусферной подсветки, ни контрового
    // источника в сцене не заводится, и число направленных остаётся прежним —
    // одно солнце. Держись в сцене нулевой источник, он всё равно занимал бы
    // место в униформах материалов, и кадр перестал бы совпадать байт-в-байт.
    expect(hemisphereLights(rig.scene)).toEqual([]);
    expect(directionalLights(rig.scene).length).toBe(1);
    expect(rig.lighting.config.hemisphere).toBeUndefined();
    expect(rig.lighting.config.rim).toBeUndefined();
  });

  it('подсекция заводит источник с авторскими числами; тонов у подсветки два', () => {
    const rig = makeRig({
      hemisphere: { skyColor: '#88aaff', groundColor: '#6b5a3a', intensity: 0.5 },
    });

    const [light] = hemisphereLights(rig.scene);
    expect(light).toBeDefined();
    expect(light!.color.getHexString()).toBe('88aaff');
    expect(light!.groundColor.getHexString()).toBe('6b5a3a');
    expect(light!.intensity).toBe(0.5);
    // Тени подсветка не создаёт вовсе: карт у неё нет и быть не может.
    expect(directionalLights(rig.scene).length).toBe(1);
  });

  it('ось «небо → земля» подсветки смотрит по вертикали сцены, а не по +Y three', () => {
    // Направления у полусферного источника нет отдельным полем: three берёт ось
    // из его МИРОВОЙ ПОЗИЦИИ (`WebGLLights`). Конструктор ставит туда
    // `DEFAULT_UP` = (0, 1, 0), а сцена Z-up (REND-1) — на умолчании three
    // «небом» красились бы стены, обращённые к +Y, а пол получал бы смесь
    // тонов поровну, то есть ровно обратное сценарию REND-29.
    const rig = makeRig({ hemisphere: { skyColor: '#88aaff', groundColor: '#6b5a3a' } });
    rig.scene.updateMatrixWorld(true);

    const axis = new THREE.Vector3();
    hemisphereLights(rig.scene)[0]!.getWorldPosition(axis).normalize();

    expect(axis.x).toBeCloseTo(0, 6);
    expect(axis.y).toBeCloseTo(0, 6);
    expect(axis.z).toBeCloseTo(1, 6);
  });

  it('контровой источник — второй направленный, теней не отбрасывает и вне реестра кастеров', () => {
    const rig = makeRig({
      rim: { color: '#ffe8c0', intensity: 0.8, direction: { x: -6, y: 10, z: 4 } },
      shadows: { mode: 'full' },
    });

    const lights = directionalLights(rig.scene);
    // Солнце плюс контровой; пары ярусов у `full` нет — карта одна.
    expect(lights.length).toBe(2);
    const rim = rig.lighting.lights.rim;
    expect(rim.castShadow).toBe(false);
    expect(rim.intensity).toBe(0.8);
    expect(rim.color.getHexString()).toBe('ffe8c0');
    // Направление — та же семантика, что у солнца: смещение позиции от цели.
    const direction = rim.position.clone().sub(rim.target.position).normalize();
    expect(direction.x).toBeCloseTo(-6 / Math.hypot(-6, 10, 4), 6);
    expect(direction.z).toBeCloseTo(4 / Math.hypot(-6, 10, 4), 6);
    // В реестре кастеров источника нет: тени принадлежат солнцу (REND-30).
    expect(rig.lighting.casterCount('static') + rig.lighting.casterCount('dynamic')).toBeGreaterThan(
      0,
    );
    expect(rig.lighting.lights.sun.castShadow).toBe(true);
  });

  it('правка секции в рантайме заводит и снимает источники без пересборки (ED-15)', () => {
    const rig = makeRig();

    rig.lighting.applyConfig({ hemisphere: { intensity: 0.4 }, rim: { intensity: 0.7 } });

    const hemisphere = hemisphereLights(rig.scene);
    expect(hemisphere.length).toBe(1);
    expect(hemisphere[0]!.intensity).toBe(0.4);
    expect(directionalLights(rig.scene).length).toBe(2);

    // Правка чисел — на ЖИВОМ источнике: объект тот же, пересоздания нет.
    rig.lighting.applyConfig({ hemisphere: { intensity: 0.1 }, rim: { intensity: 0.7 } });
    expect(hemisphereLights(rig.scene)[0]).toBe(hemisphere[0]);
    expect(hemisphereLights(rig.scene)[0]!.intensity).toBe(0.1);

    // Снятая подсекция снимает источник — вместе с целью контрового света.
    rig.lighting.applyConfig({});
    expect(hemisphereLights(rig.scene)).toEqual([]);
    expect(directionalLights(rig.scene).length).toBe(1);
    expect(rig.lighting.lights.rim.target.parent).toBeNull();
  });

  it('запись кадра без значений источника его НЕ трогает (REND-32)', () => {
    // Флаги записи и присутствие источника в сцене — разные вопросы: первый про
    // «есть ли что ставить на этом кадре», второй про «есть ли куда». Сегодня
    // они совпадают по построению конфигурации, но контракт записи держится
    // флагом, и запись без значений обязана оставить живой источник как есть —
    // иначе на него легли бы нули незаполненной записи.
    const optional = new OptionalLights();
    const scene = new THREE.Scene();
    const extent = { centerX: 0, centerY: 0, radius: 10, sizeX: 14, sizeY: 14, minZ: 0, maxZ: 4 };
    optional.apply(scene, extent, { skyColor: '#ffffff', groundColor: '#ffffff', intensity: 1 }, {
      color: '#ffffff',
      intensity: 1,
      directionX: 0,
      directionY: 0,
      directionZ: 1,
    });

    optional.applySample(
      {
        hasHemisphere: false,
        hasRim: false,
        hemisphereSkyColor: new THREE.Color('#000000'),
        hemisphereGroundColor: new THREE.Color('#000000'),
        hemisphereIntensity: 0,
        rimColor: new THREE.Color('#000000'),
        rimIntensity: 0,
        rimDirectionX: 0,
        rimDirectionY: 0,
        rimDirectionZ: 0,
      },
      extent,
    );

    expect(optional.hemisphere.intensity).toBe(1);
    expect(optional.hemisphere.color.getHexString()).toBe('ffffff');
    expect(optional.rim.intensity).toBe(1);
    expect(optional.rim.color.getHexString()).toBe('ffffff');
  });

  it('снос подсистемы снимает оба источника со сцены (REND-31)', () => {
    const rig = makeRig({ hemisphere: {}, rim: {} });
    expect(hemisphereLights(rig.scene).length).toBe(1);

    rig.lighting.dispose();

    expect(hemisphereLights(rig.scene)).toEqual([]);
    expect(directionalLights(rig.scene)).toEqual([]);
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

// ------------------------------------------------- контактные пятна (blob)

describe('режим теней `blob` — контактные пятна вместо карт (REND-30)', () => {
  it('порядок стоимости: `none` < `blob` < `hybrid` < `full`', () => {
    expect(shadowModeRank('none')).toBeLessThan(shadowModeRank('blob'));
    expect(shadowModeRank('blob')).toBeLessThan(shadowModeRank('hybrid'));
    // Потолок пресета считается тем же рангом — второго определения порядка нет.
    expect(minShadowMode('hybrid', 'blob')).toBe('blob');
    expect(minShadowMode('blob', 'full')).toBe('blob');
    expect(minShadowMode('none', 'blob')).toBe('none');
  });

  it('карт теней не строится, статика теней не отбрасывает', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    // Источник карты не несёт: теневого прохода в режиме нет вовсе.
    expect(rig.lighting.lights.sun.castShadow).toBe(false);
    expect(directionalLights(rig.scene).length).toBe(1);
    // Статические кастеры теней не отбрасывают и не принимают.
    expect(floorMesh(rig.scene).castShadow).toBe(false);
    expect(floorMesh(rig.scene).receiveShadow).toBe(false);
    for (const mesh of rig.models.batchMeshes()) expect(mesh.castShadow).toBe(false);
  });

  it('под динамикой пятна, и следуют они позиции инстанса кадр в кадр', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock', prevX: 2, currX: 2, prevY: 3, currY: 3 })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    const mesh = rig.lighting.blobShadows;
    expect(mesh).not.toBeNull();
    // Носитель ровно один — динамический инстанс; статичная декорация пятна не
    // получает: в этом режиме статика теней не отбрасывает вовсе.
    expect(rig.lighting.blobCasterCount).toBe(1);
    expect(mesh!.count).toBe(1);
    expect(mesh!.parent).toBe(rig.scene);

    const matrix = new THREE.Matrix4();
    mesh!.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(2, 6);
    expect(position.y).toBeCloseTo(3, 6);
    // Размер — производная габарита вида, а не константа кода: у фикстурной
    // модели след ненулевой, и диаметр пятна ему пропорционален.
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    expect(scale.x).toBeGreaterThan(0);
    expect(scale.x).toBeCloseTo(scale.y, 6);

    // Юнит переехал — пятно за ним.
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock', prevX: 5, currX: 5, prevY: -1, currY: -1 })]));
    rig.stage.frame(0.016, 0);
    mesh!.getMatrixAt(0, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(5, 6);
    expect(position.y).toBeCloseTo(-1, 6);
  });

  it('пятно исчезает вместе с инстансом', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.blobShadows?.count).toBe(1);

    rig.stage.publish(PRODUCER, makeTickView([]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.blobCasterCount).toBe(0);
    expect(rig.lighting.blobShadows?.count).toBe(0);
  });

  /** Кадры до конца рампы проявления (FOW-8): её длина — доля от `fadeSeconds`. */
  function settleFade(rig: Rig): void {
    for (let frame = 0; frame < 30; frame++) rig.stage.frame(1 / 60, 0);
  }

  it('пятно уходит вместе с инстансом, а не переживает его угасание (FOW-8)', () => {
    // Инстанс, ушедший в туман, ДОИГРЫВАЕТ угасание: его поддерево растворяется
    // до нулевой непрозрачности. Непрозрачности у пятна нет вовсе, и переживи
    // оно угасание — последние кадры показывали бы чёрный круг под пустотой.
    // REND-30: пятно — часть представления инстанса и исчезает вместе с ним.
    const rig = makeRig({ shadows: { mode: 'blob' } }, undefined, { fadeSeconds: 0.4 });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    settleFade(rig);
    expect(rig.lighting.blobShadows?.count).toBe(1);

    // Сущность ушла из доставки без события смерти — это и есть «ушла в туман».
    rig.stage.publish(PRODUCER, makeTickView([]));
    rig.stage.frame(1 / 60, 0);

    // Инстанс ещё жив и доигрывает угасание, а пятна под ним уже нет.
    expect(rig.models.instanceFor(1)).not.toBeNull();
    expect(rig.lighting.blobShadows?.count).toBe(0);
    // Носитель при этом из реестра не выпал: он снимается вместе с инстансом,
    // а до конца угасания просто не отдаёт позы.
    expect(rig.lighting.blobCasterCount).toBe(1);
  });

  it('пятно не опережает инстанс на ПРОЯВЛЕНИИ — та же рампа с другой стороны (FOW-8)', () => {
    // Зеркало предыдущего случая: вернувшийся из тумана инстанс начинает с
    // нулевой проявленности и набирает её за долю `fadeSeconds`. Нарисуй мы
    // пятно сразу — под всё ещё невидимой моделью лежал бы сплошной чёрный круг,
    // ровно тот дефект, ради которого закрыто угасание.
    const rig = makeRig({ shadows: { mode: 'blob' } }, undefined, { fadeSeconds: 0.4 });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));

    rig.stage.frame(1 / 60, 0);

    // Носитель объявлен сразу — он свойство яруса кастера, — а позы не отдаёт.
    expect(rig.lighting.blobCasterCount).toBe(1);
    expect(rig.lighting.blobShadows?.count).toBe(0);

    // Проявление доиграно — пятно на месте.
    settleFade(rig);
    expect(rig.lighting.blobShadows?.count).toBe(1);
  });

  it('правленый масштаб размещения двигает и размер пятна (REND-17, ED-15)', () => {
    // Радиус пятна — производная габарита вида И масштаба инстанса (REND-30).
    // Правка масштаба идёт на ЖИВОМ инстансе (пересборки нет), и след обязан
    // поехать тем же кадром, каким едут картинка и walkable-вклад.
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Torch' })]));
    rig.stage.frame(0.016, 0);
    const mesh = rig.lighting.blobShadows!;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const before = new THREE.Vector3().setFromMatrixScale(matrix).x;
    expect(before).toBeGreaterThan(0);

    rig.stage.publishDecorations(
      decorations([makeEntityView(2, { kind: 'Torch', scale: 2 })]),
    );
    rig.stage.frame(0.016, 0);

    mesh.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixScale(matrix).x).toBeCloseTo(before * 2, 5);
  });

  it('пятно рисуется В СЦЕНЕ, то есть до маски тумана (FOW-7, QUAL-2)', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);

    const mesh = rig.lighting.blobShadows!;
    // Меш пятен — узел ОСНОВНОЙ сцены: маска тумана ложится финальным проходом
    // поверх всего кадра (FOW-7), поэтому пятно затемнено наравне с самим
    // инстансом, и позицию скрытого юнита по нему не прочитать.
    expect(mesh.parent).toBe(rig.scene);
    // Собственной картой теней пятно не является и в теневой проход не входит.
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
  });

  it('смена режима гасит пятна, а возврат зажигает их тем же мешем (ED-15)', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    const mesh = rig.lighting.blobShadows;
    expect(mesh?.count).toBe(1);

    rig.lighting.applyConfig({ shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);
    expect(mesh!.count).toBe(0);
    expect(mesh!.visible).toBe(false);
    // Реестр носителей режимом не управляется: он свойство яруса кастера, и
    // правка секции обязана показать пятна ближайшим кадром.
    expect(rig.lighting.blobCasterCount).toBe(1);

    rig.lighting.applyConfig({ shadows: { mode: 'blob' } });
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.blobShadows).toBe(mesh);
    expect(mesh!.count).toBe(1);
    expect(mesh!.visible).toBe(true);
  });

  it('потолок пресета режет авторский hybrid до blob по рангу (QUAL-1)', () => {
    const authored: PresentationLighting = { shadows: { mode: 'hybrid', mapSize: 2048 } };
    const before = JSON.stringify(authored);
    const rig = makeRig(authored, { 'lighting.shadowMode': 'blob' });

    expect(rig.lighting.config.shadowMode).toBe('blob');
    // Карты теней не строятся: потолок снял именно их, а не пятна.
    expect(rig.lighting.lights.sun.castShadow).toBe(false);
    // Документ сцены пресет не трогает ни байтом.
    expect(JSON.stringify(authored)).toBe(before);
  });

  it('потолок ВЫШЕ авторского режима не поднимает: `min` работает в одну сторону', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } }, { 'lighting.shadowMode': 'full' });
    expect(rig.lighting.config.shadowMode).toBe('blob');
  });

  it('снос подсистемы отдаёт меш пятен и чистит реестр носителей (REND-31)', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    const mesh = rig.lighting.blobShadows!;

    rig.lighting.dispose();

    expect(rig.lighting.blobShadows).toBeNull();
    expect(rig.lighting.blobCasterCount).toBe(0);
    expect(mesh.parent).toBeNull();
  });

  it('снос отдаёт цели сведения и снимает карту с источника (REND-31)', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    const composite = rig.lighting.shadowComposite;
    const map = composite.map!;
    const tier = composite.tiers.static!;
    const disposed: string[] = [];
    map.addEventListener('dispose', () => disposed.push('map'));
    tier.addEventListener('dispose', () => disposed.push('tier'));

    rig.lighting.dispose();

    expect(disposed).toEqual(expect.arrayContaining(['map', 'tier']));
    expect(composite.map).toBeNull();
    // Ссылку на снесённую карту источник держать не вправе: материалы сцены
    // читают её текстуру глубины, а той больше нет.
    expect(rig.lighting.lights.sun.shadow.map).toBeNull();
  });

  it('смена режима на `full` отдаёт цели сведения: три карты глубины ни к чему', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.shadowComposite.map).not.toBeNull();

    rig.lighting.applyConfig({ shadows: { mode: 'full' } });

    expect(rig.lighting.shadowComposite.map).toBeNull();
    expect(rig.lighting.lights.sun.shadow.map).toBeNull();
    // В `full` карту заводит теневой проход three: она одна, и наша ей не нужна.
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.lights.sun.shadow.needsUpdate).toBe(true);
  });
});

describe('счётчик контактных пятен (PERF-2, PERF-3)', () => {
  it('число пятен за кадр детерминировано и растёт составом доставки', () => {
    const rig = makeRig({ shadows: { mode: 'blob' } });
    rig.stage.publish(
      PRODUCER,
      makeTickView([
        makeEntityView(1, { kind: 'Rock' }),
        makeEntityView(2, { kind: 'Rock', prevX: 4, currX: 4 }),
      ]),
    );

    const first = createCostCounters();
    withCostSink(first, () => {
      rig.stage.frame(0.016, 0);
    });
    const second = createCostCounters();
    withCostSink(second, () => {
      rig.stage.frame(0.016, 0);
    });

    // Тот же кадр — то же число: ни времени, ни состояния GPU в счётчике нет.
    expect(first.lightingBlobDecals).toBe(2);
    expect(second.lightingBlobDecals).toBe(2);
    // Карт теней в режиме нет — ярусные счётчики нулевые.
    expect(first.lightingStaticCasters).toBe(0);
    expect(first.lightingDynamicCasters).toBe(0);
  });

  it('вне режима `blob` счётчик нулевой: пятен там нет вовсе', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));

    const cost = createCostCounters();
    withCostSink(cost, () => {
      rig.stage.frame(0.016, 0);
    });

    expect(cost.lightingBlobDecals).toBe(0);
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
    const composite = rig.lighting.shadowComposite;
    // Кадр запекания: рисуется глубина статики. Динамику этот кадр тоже рисует
    // ровно один раз — в цели ярусов до первого прохода лежит мусор драйвера, и
    // свести её было бы нечем; дальше динамика идёт своим чередом.
    expect(rig.lighting.staticRebuilds).toBe(1);
    expect(composite.draws.static).toBe(1);
    expect(floorMesh(rig.scene).castShadow).toBe(true);
    const primed = { ...composite.draws };

    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    // Установившийся кадр: кэш не трогается, рисуется только глубина динамики.
    expect(rig.lighting.staticRebuilds).toBe(1);
    expect(composite.draws.static).toBe(primed.static);
    expect(composite.draws.dynamic).toBe(primed.dynamic + 2);
    expect(floorMesh(rig.scene).castShadow).toBe(false);
    // Приёмником террейн остаётся в обеих фазах: он ловит тени, а не отбрасывает.
    expect(floorMesh(rig.scene).receiveShadow).toBe(true);
    // Карту материалам отдаёт СВЕДЕНИЕ, и оно идёт каждым кадром: в ней всегда
    // оба яруса, а не тот, чья глубина рисовалась последней (REND-30).
    expect(rig.lighting.lights.sun.shadow.map).toBe(composite.map);
    expect(composite.compositeCount).toBe(3);
  });

  it('карта сведения несёт ОБА яруса: тень статики не гаснет в кадры динамики', () => {
    // Прежняя пара источников держала ярусы в РАЗНЫХ картах, и каждая гасила
    // только свою долю интенсивности. Теперь ярус — цель глубины, а карта
    // источника собирается из обеих поэлементным минимумом: тень от одного лишь
    // здания так же темна, как в `full` (REND-30).
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);

    const composite = rig.lighting.shadowComposite;
    const spy = rig.renderer as ShadowRendererSpy;
    // Цели ярусов — разные, карта — третья, и рисуют в неё сведением.
    expect(composite.tiers.static).not.toBe(composite.tiers.dynamic);
    expect(composite.map).not.toBe(composite.tiers.static);
    expect(spy.targets.at(-2)).toBe(composite.map);
    // Проход читает ОБЕ глубины и пишет минимум — вход материалов сцены.
    const pass = composite.pass!;
    expect(pass.uniforms.tStatic?.value).toBe(composite.tiers.static?.depthTexture);
    expect(pass.uniforms.tDynamic?.value).toBe(composite.tiers.dynamic?.depthTexture);
    expect(pass.fragmentShader).toContain('gl_FragDepth = min(staticDepth, dynamicDepth)');
    // Карта, которую читают материалы, — с аппаратным сравнением; цели ярусов
    // читает наш проход обычной выборкой, и сравнения у них нет.
    expect(composite.map?.depthTexture?.compareFunction).toBe(THREE.LessEqualCompare);
    expect(composite.tiers.static?.depthTexture?.compareFunction).toBeNull();
  });

  it('без порта рендерера `hybrid` исполняется как `full`: картинка та же, кэша нет', () => {
    // Сведение ведёт подсистема, и вести его нечем, если сборка не дала
    // рендерера. Тогда карта одна и в неё идут ОБА яруса каждым кадром — то
    // есть ровно `full`: тень не темнее и не светлее, просто дороже.
    const rig = makeRig({ shadows: { mode: 'hybrid' } }, undefined, { renderer: null });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));

    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.shadowComposite.map).toBeNull();
    expect(rig.lighting.lights.sun.shadow.needsUpdate).toBe(true);
    // Оба яруса подняты одновременно, как в `full`.
    expect(floorMesh(rig.scene).castShadow).toBe(true);
    for (const mesh of rig.models.batchMeshes()) expect(mesh.castShadow).toBe(true);
    // Кэша статики нет вовсе: перерисовывать нечего, счётчик стоит.
    expect(rig.lighting.staticRebuilds).toBe(0);
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

    // Поток событий инвалидации без затишья — та же нагрузка, что мутация пола
    // каждый тик (TERR-6) или перетаскивание декорации в редакторе (ED-15).
    const composite = rig.lighting.shadowComposite;
    const phases: ('static' | 'dynamic')[] = [];
    let seen = { ...composite.draws };
    for (let frame = 0; frame < 8; frame++) {
      rig.lighting.invalidateStatic();
      rig.stage.frame(0.016, 0);
      const now = { ...composite.draws };
      phases.push(now.static > seen.static ? 'static' : 'dynamic');
      seen = now;
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
    // Глубина динамики в её кадры действительно рисуется — тени юнитов
    // следуют за ними, а не застывают на всё время мутаций.
    expect(composite.draws.dynamic).toBeGreaterThanOrEqual(4);
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

// ------------------- подтверждение перерисовки кэша статики (REND-30)

describe('перерисовка кэша статики подтверждается кадром, а не решением', () => {
  /**
   * Теневой проход three глазами подсистемы: карту строит он сам первым
   * проходом, и он же снимает `needsUpdate` у источника, чью карту нарисовал.
   * Ровно это подсистема и читает обратно — другого признака «кадр состоялся»
   * у неё нет.
   */
  function drawShadows(rig: Rig): void {
    const light = rig.lighting.lights.sun;
    if (!light.castShadow) return;
    light.shadow.map ??= new THREE.WebGLRenderTarget(1, 1);
    light.shadow.needsUpdate = false;
  }

  /** Сцена `hybrid` с обоими ярусами: чередование карт тут наблюдаемо. */
  function hybridRig(): Rig {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    return rig;
  }

  it('нарисованный кадр перерисовку подтверждает: заказ не повторяется', () => {
    const rig = hybridRig();
    rig.stage.frame(0.016, 0);
    drawShadows(rig);
    const baked = rig.lighting.staticRebuilds;
    expect(baked).toBe(1);

    for (let frame = 0; frame < 6; frame++) {
      rig.stage.frame(0.016, 0);
      drawShadows(rig);
    }

    // Кэш событиен: событий не было — перерисовок тоже (REND-30).
    expect(rig.lighting.staticRebuilds).toBe(baked);
  });

  it('НЕСОСТОЯВШИЙСЯ теневой проход перерисовку не подтверждает (drawFailure)', () => {
    // Теневая машинерия потребителя бывает выключена (`shadowMap.enabled`), а
    // контекст — потерян: заказанный проход тогда не рисует ничего и флага
    // `needsUpdate` не снимает. Считай подсистема заказ исполненным, кэш
    // статики остался бы устаревшим молча — до следующего события инвалидации,
    // которого может не быть вовсе.
    const rig = hybridRig();
    rig.stage.frame(0.016, 0);
    const baked = rig.lighting.staticRebuilds;
    expect(baked).toBe(1);

    // Проход перестал состояться: рендерер флага не снимает.
    const spy = rig.renderer as ShadowRendererSpy;
    spy.drawing = false;
    rig.lighting.invalidateStatic();
    for (let frame = 0; frame < 4; frame++) rig.stage.frame(0.016, 0);

    // Ни одной подтверждённой перерисовки — и кэш по-прежнему объявлен старым.
    expect(rig.lighting.staticRebuilds).toBe(baked);

    // Проход снова состоится — заказ исполняется ближайшим своим кадром.
    spy.drawing = true;
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(baked + 1);
  });

  it('заказ на кадр отдаётся только один раз: карту рисует наш проход, не кадр сцены', () => {
    // После нашего прохода флаг обязан быть снят при любом исходе: кадр
    // отрисовки сцены потребителем (`renderer.render`) иначе перерисовал бы
    // карту сведения одним ярусом — тем, чьи флаги стоят на кастерах.
    const rig = hybridRig();
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.lights.sun.shadow.needsUpdate).toBe(false);

    const spy = rig.renderer as ShadowRendererSpy;
    spy.drawing = false;
    rig.lighting.invalidateStatic();
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.lights.sun.shadow.needsUpdate).toBe(false);
  });
});

// ------------------------------- идемпотентность применения (ED-15, REND-32)

describe('применение, ничего не изменившее, не делает ничего (ED-15)', () => {
  /** Сцена с кэшем статики: по перерисовкам и видно лишнее применение. */
  function bakedRig(config: PresentationLighting): Rig {
    const rig = makeRig(config);
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    return rig;
  }

  it('`applyConfig` той же секцией кэш статики не устаревает', () => {
    // Путь редактора: `applyDraft` зовёт `applyConfig(next.lighting)` после
    // КАЖДОГО `submit()` любого документа — правка имени сущности или числа
    // в чужой секции доходит сюда неизменной секцией света. Перезапекать кэш
    // статики на ней значит платить теневым проходом за каждое нажатие клавиши.
    const rig = bakedRig({ shadows: { mode: 'hybrid' } });
    const baked = rig.lighting.staticRebuilds;

    // Другой объект с теми же значениями — сравнивается значение, а не ссылка.
    rig.lighting.applyConfig({ shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(baked);
  });

  it('секция, записанная умолчаниями, тоже «та же»: сравнивается разобранная форма', () => {
    // Автор дописал поле его же умолчанием — кадр от этого не меняется, и
    // применение обязано увидеть это, а не сравнивать тексты документов.
    const rig = bakedRig({ shadows: { mode: 'hybrid' } });
    const baked = rig.lighting.staticRebuilds;

    rig.lighting.applyConfig({
      ambient: { color: DEFAULT_LIGHTING_CONFIG.ambientColor },
      shadows: { mode: 'hybrid', mapSize: DEFAULT_LIGHTING_CONFIG.shadowMapSize },
    });
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(baked);
  });

  it('ПРАВКА секции кэш устаревает — идемпотентность не глушит настоящую правку', () => {
    const rig = bakedRig({ shadows: { mode: 'hybrid' } });
    const baked = rig.lighting.staticRebuilds;

    rig.lighting.applyConfig({ ambient: { intensity: 0.1 }, shadows: { mode: 'hybrid' } });
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(baked + 1);
  });

  it('`applyQuality` теми же значениями кэш статики не устаревает (QUAL-1)', () => {
    // Смена пресета в матче — событие, но повторная раздача ТЕХ ЖЕ значений
    // (поздняя регистрация подсистемы, повтор документа) событием не является.
    const rig = bakedRig({ shadows: { mode: 'hybrid' } });
    const values = new Map<string, string | number>([
      ['lighting.shadowMode', 'hybrid'],
      ['lighting.shadowMapSize', 1024],
    ]);
    rig.lighting.applyQuality(values);
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    const baked = rig.lighting.staticRebuilds;

    rig.lighting.applyQuality(values);
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(baked);
    // Потолок при этом действует: идемпотентность — про повтор, а не про отмену.
    expect(rig.lighting.config.shadowMapSize).toBe(1024);
  });

  it('потолок, изменивший действующую конфигурацию, применяется как обычно', () => {
    const rig = bakedRig({ shadows: { mode: 'hybrid' } });
    const baked = rig.lighting.staticRebuilds;

    rig.lighting.applyQuality(new Map([['lighting.shadowMapSize', 512]]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.config.shadowMapSize).toBe(512);
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

  it('REND-32: фазы ведут hemisphere и rim наравне с рассеянным и направленным', () => {
    const rig = makeRig(
      cycleSection({
        hemisphere: { skyColor: '#ffffff', groundColor: '#ffffff', intensity: 1 },
        rim: { color: '#ffffff', intensity: 1, direction: { x: 0, y: 0, z: 10 } },
        cycle: {
          transitionSeconds: 2,
          phases: [
            { ...PHASES[0]!, hemisphere: { intensity: 1 }, rim: { intensity: 1 } },
            {
              ...PHASES[1]!,
              hemisphere: { skyColor: '#000000', intensity: 0 },
              rim: { intensity: 0 },
            },
          ],
        },
      }),
    );
    const { hemisphere, rim } = rig.lighting.lights;
    // Первая фаза стоит сразу: поле, которого фаза не назвала, держит значение
    // статической части — тон «земли» остаётся белым.
    expect(hemisphere.intensity).toBe(1);
    expect(hemisphere.groundColor.getHexString()).toBe('ffffff');
    expect(rim.intensity).toBe(1);

    // Половина перехода: тона и интенсивности — ровно посередине.
    advance(rig, 9);
    expect(hemisphere.intensity).toBeCloseTo(0.5, 6);
    expect(hemisphere.color.getHexString()).not.toBe('ffffff');
    expect(hemisphere.groundColor.getHexString()).toBe('ffffff');
    expect(rim.intensity).toBeCloseTo(0.5, 6);

    // Граница слота — вторая фаза точно.
    advance(rig, 1);
    expect(hemisphere.intensity).toBe(0);
    expect(hemisphere.color.getHexString()).toBe('000000');
    expect(rim.intensity).toBe(0);
  });

  it('REND-32: нет источника у статики — фаза его не заводит', () => {
    // Валидация такой документ отвергает адресно (PRES-2); подсистеме, собранной
    // руками, положено то же прочтение: наличие — свойство секции, не фазы.
    const rig = makeRig(
      cycleSection({
        cycle: {
          transitionSeconds: 2,
          phases: [
            { ...PHASES[0]!, hemisphere: { intensity: 1 } },
            { ...PHASES[1]!, hemisphere: { intensity: 0 } },
          ],
        },
      }),
    );

    expect(hemisphereLights(rig.scene)).toEqual([]);
    advance(rig, 9);
    expect(hemisphereLights(rig.scene)).toEqual([]);
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

  it('ПРАВКА секции перезапускает круг с начала первой фазы (ED-15, REND-32)', () => {
    const rig = makeRig(cycleSection());
    advance(rig, 12);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);

    // Автор правит фазу — облик воспроизводим: круг идёт с начала.
    rig.lighting.applyConfig(
      cycleSection({
        cycle: {
          transitionSeconds: 2,
          phases: [PHASES[0]!, { ...PHASES[1]!, seconds: 12 }],
        },
      }),
    );

    expect(rig.lighting.lights.ambient.intensity).toBe(1);
  });

  it('ТА ЖЕ секция круга не трогает: часы идут дальше, статика не перепекается', () => {
    // В редакторе `applyConfig` зовётся после КАЖДОГО `submit()` любого
    // документа (ED-15): перезапускай применение круг — на сцене с циклом
    // каждое нажатие клавиши возвращало бы «утро», а в `hybrid` форсировало бы
    // перезапекание кэша статики. Правкой это не является: секция та же.
    const rig = makeRig(cycleSection({ shadows: { mode: 'hybrid' } }));
    advance(rig, 12);
    const rebuilds = rig.lighting.staticRebuilds;
    const intensity = rig.lighting.lights.ambient.intensity;
    expect(intensity).toBe(0); // круг дошёл до второй фазы

    // Та же секция ДРУГИМ объектом: сравнивается значение, а не ссылка.
    rig.lighting.applyConfig(cycleSection({ shadows: { mode: 'hybrid' } }));
    advance(rig, 0);

    expect(rig.lighting.lights.ambient.intensity).toBe(intensity);
    expect(rig.lighting.staticRebuilds).toBe(rebuilds);
  });

  it('потолок пресета и смена сетки круга не перезапускают (QUAL-1, REND-14)', () => {
    // Ни то, ни другое не является применением СЕКЦИИ: пресет документа не
    // трогает ни байтом (QUAL-1), а сетка — вход другой подсистемы. Часы суток
    // от них идти заново не обязаны, а значения идущей фазы обязаны остаться на
    // источниках: статическая часть секции их не подменяет.
    const rig = makeRig(cycleSection());
    advance(rig, 12);
    expect(rig.lighting.lights.ambient.intensity).toBe(0);

    rig.lighting.applyQuality(new Map([['lighting.shadowMode', 'none']]));
    expect(rig.lighting.lights.ambient.intensity).toBe(0);

    rig.lighting.applyGrid(flatGrid(16));
    expect(rig.lighting.lights.ambient.intensity).toBe(0);
    // Наводка при этом пересчитана по новым границам арены: солнце стоит от
    // центра другой сетки, а не от прежнего.
    expect(rig.lighting.lights.sun.target.position.x).toBeCloseTo(8, 6);
  });

  it('снятая подсекция возвращает статический свет секции', () => {
    const rig = makeRig(cycleSection());
    expect(rig.lighting.lights.ambient.intensity).toBe(1);

    rig.lighting.applyConfig({ ambient: { intensity: 0.4 } });
    advance(rig, 30);
    expect(rig.lighting.lights.ambient.intensity).toBe(0.4);
  });

  it('интенсивность перехода — целиком на единственном источнике (REND-30)', () => {
    const rig = makeRig(cycleSection({ shadows: { mode: 'hybrid' } }));
    advance(rig, 9);
    // Половина пути от 2 к 0 — это 1, и всю единицу несёт один источник: делить
    // её между ярусами больше нечем, карта одна.
    expect(directionalLights(rig.scene).length).toBe(1);
    expect(rig.lighting.lights.sun.intensity).toBeCloseTo(1, 6);
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

  it('покадровая глубина динамики на переходе не застывает', () => {
    const rig = makeRig(movingSun());
    rig.stage.publish(PRODUCER, makeTickView([makeEntityView(1, { kind: 'Rock' })]));
    rig.stage.publishDecorations(decorations([makeEntityView(2, { kind: 'Rock' })]));
    advance(rig, 0);

    // Переход из тридцати кадров: цикл устаревает кэш КАЖДЫМ кадром, глубина за
    // кадр рисуется одна, и делят кадры ворота чередования REND-30 — те же, что
    // под потоком инвалидаций пола. Без чередования тени бойцов застыли бы на
    // всю длину перехода (REND-32).
    advance(rig, 8);
    const before = { ...rig.lighting.shadowComposite.draws };
    for (let frame = 0; frame < 30; frame++) advance(rig, 2 / 30);

    const draws = rig.lighting.shadowComposite.draws;
    const staticFrames = draws.static - before.static;
    const dynamicFrames = draws.dynamic - before.dynamic;
    expect(staticFrames).toBeGreaterThan(10);
    expect(dynamicFrames).toBeGreaterThan(10);
    // И ровно один ярус за кадр — правило кадра не сломано.
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

  it('переход переобтягивает фрустум по новому направлению, а сторону карты не трогает', () => {
    // Фрустум обтянут по коробке арены В ПРОСТРАНСТВЕ СВЕТА (design D6, L-9):
    // от направления он зависит, и поехавшее направление обязано его
    // переобтянуть — иначе кастеры у края арены ушли бы за его границу. Сторона
    // карты при этом не поле фазы (REND-32), и цикл её не трогает.
    const rig = makeRig(movingSun());
    advance(rig, 0);
    const { sun } = rig.lighting.lights;
    const before = {
      width: sun.shadow.camera.right - sun.shadow.camera.left,
      map: sun.shadow.mapSize.x,
      normalBias: sun.shadow.normalBias,
    };

    for (let frame = 0; frame < 10; frame++) advance(rig, 1);

    expect(sun.shadow.camera.right - sun.shadow.camera.left).not.toBe(before.width);
    expect(sun.shadow.mapSize.x).toBe(before.map);
    // Смещение выборки — производная ТЕКСЕЛЯ переобтянутого фрустума (два
    // текселя худшей оси), и считается оно из него же, а не из прежнего.
    const texel = Math.max(
      (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x,
      (sun.shadow.camera.top - sun.shadow.camera.bottom) / sun.shadow.mapSize.y,
    );
    expect(sun.shadow.normalBias).toBeCloseTo(texel * 2, 9);
  });

  it('установившаяся фаза фрустум не трогает: он функция направления, а не кадра', () => {
    const rig = makeRig(movingSun());
    // Круг доигран до установившейся второй фазы: направление стоит.
    for (let frame = 0; frame < 12; frame++) advance(rig, 1);
    const { sun } = rig.lighting.lights;
    const settled = {
      left: sun.shadow.camera.left,
      right: sun.shadow.camera.right,
      top: sun.shadow.camera.top,
      bottom: sun.shadow.camera.bottom,
    };

    for (let frame = 0; frame < 5; frame++) advance(rig, 0.1);

    expect(sun.shadow.camera.left).toBe(settled.left);
    expect(sun.shadow.camera.right).toBe(settled.right);
    expect(sun.shadow.camera.top).toBe(settled.top);
    expect(sun.shadow.camera.bottom).toBe(settled.bottom);
  });
});

// ------------------------- фрустум теневой камеры (design D6, L-9)

describe('фрустум теневой камеры обтянут по коробке арены в пространстве света', () => {
  /** Арена размером с дуэльную: 48×48 клеток по мировой единице. */
  function duelGrid(): TerrainGrid {
    return createTerrainGrid({
      width: 48,
      height: 48,
      tileSize: FIXED_ONE,
      levels: Array.from({ length: 48 }, () => '0'.repeat(48)),
      flags: Array.from({ length: 48 }, () => '.'.repeat(48)),
    });
  }

  /** Подсистема на своей сетке — без стенда: под тестом одна наводка. */
  function aimed(grid: TerrainGrid, config: PresentationLighting): LightingSubsystem {
    const lighting = new LightingSubsystem({ grid, config });
    lighting.init({
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: 0.6 },
    });
    return lighting;
  }

  /** Восемь углов коробки арены в мировых координатах. */
  function boxCorners(grid: TerrainGrid, heightStep: number, top: number): THREE.Vector3[] {
    const size = grid.width * (grid.tileSize / FIXED_ONE);
    const corners: THREE.Vector3[] = [];
    for (let index = 0; index < 8; index++) {
      corners.push(
        new THREE.Vector3(
          (index & 1) === 0 ? 0 : size,
          (index & 2) === 0 ? 0 : size,
          (index & 4) === 0 ? 0 : top * heightStep,
        ),
      );
    }
    return corners;
  }

  /** Точка внутри ортографического объёма камеры (с допуском на арифметику). */
  function insideFrustum(camera: THREE.OrthographicCamera, point: THREE.Vector3): boolean {
    const view = point.clone().applyMatrix4(camera.matrixWorldInverse);
    const eps = 1e-6;
    return (
      view.x >= camera.left - eps &&
      view.x <= camera.right + eps &&
      view.y >= camera.bottom - eps &&
      view.y <= camera.top + eps &&
      -view.z >= camera.near - eps &&
      -view.z <= camera.far + eps
    );
  }

  it('все восемь углов арены — внутри фрустума при косом и низком солнце', () => {
    // Косое солнце — тот случай, ради которого подгонка и делается: квадрат по
    // диагонали сетки покрывал арену при любом направлении, но ценой вчетверо
    // большей площади, а обтянутый по коробке фрустум обязан покрывать её ТОЧНО
    // — иначе тень у края арены обрежется.
    const grid = duelGrid();
    for (const direction of [
      { x: 8, y: -12, z: 18 },
      { x: 30, y: 4, z: 6 },
      { x: -25, y: -25, z: 5 },
      { x: 0, y: 0, z: 10 },
    ]) {
      const lighting = aimed(grid, { shadows: { mode: 'full' }, directional: { direction } });
      const sun = lighting.lights.sun;
      sun.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      const camera = sun.shadow.camera;
      for (const corner of boxCorners(grid, 0.6, 0)) {
        expect(
          insideFrustum(camera, corner),
          `направление ${JSON.stringify(direction)}, угол ${corner.toArray().join(',')}`,
        ).toBe(true);
      }
      lighting.dispose();
    }
  });

  it('верхний ярус кастеров тоже внутри: коробка знает высоту, а не только план', () => {
    // Уровни террейна и то, что на них стоит, — часть коробки (REND-7): без
    // запаса по высоте статуя на верхнем ярусе рисовала бы тень мимо карты.
    const grid = createTerrainGrid({
      width: 16,
      height: 16,
      tileSize: FIXED_ONE,
      // Дальний угол поднят на третий уровень — коробка обязана его вместить.
      levels: Array.from({ length: 16 }, (_, y) =>
        Array.from({ length: 16 }, (_, x) => (x > 12 && y > 12 ? '3' : '0')).join(''),
      ),
      flags: Array.from({ length: 16 }, () => '.'.repeat(16)),
    });
    const lighting = aimed(grid, {
      shadows: { mode: 'full' },
      directional: { direction: { x: 20, y: 6, z: 8 } },
    });
    const sun = lighting.lights.sun;
    sun.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);

    for (const corner of boxCorners(grid, 0.6, 3)) {
      expect(insideFrustum(sun.shadow.camera, corner), corner.toArray().join(',')).toBe(true);
    }
    lighting.dispose();
  });

  it('плотность текселей на дуэльной арене выросла не меньше чем в 1.4 раза', () => {
    // Прежний фрустум — квадрат со стороной 1.25 · hypot(w, h): для 48×48 это
    // 84.9 мировой единицы на сторону карты. Подгонка по коробке даёт для
    // направления демо прямоугольник заметно меньше, и линейная плотность
    // текселей растёт ровно во столько же раз — бесплатно.
    const grid = duelGrid();
    const lighting = aimed(grid, {
      shadows: { mode: 'full', mapSize: 2048 },
      directional: { direction: { x: 8, y: -12, z: 18 } },
    });
    const camera = lighting.lights.sun.shadow.camera;

    const previousSide = 1.25 * Math.hypot(48, 48);
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    expect(previousSide / Math.max(width, height)).toBeGreaterThanOrEqual(1.4);
    // И фрустум ПРЯМОУГОЛЬНЫЙ: квадратом коробка проецируется только при свете
    // строго сверху, а любое косое направление даёт разные стороны.
    expect(Math.abs(width - height)).toBeGreaterThan(0.5);
    lighting.dispose();
  });

  it('пирамида теневой камеры отдаётся владельцу инстансов портом (REND-21)', () => {
    // Отсечённый по камере кадра инстанс перестаёт рисоваться и в теневой
    // проход: его тень исчезает из видимой области, хотя сам он всего лишь за
    // краем экрана. Чтобы владелец инстансов мог этого не делать, ему нужна
    // пирамида теневой камеры — и знает её только подсистема освещения.
    const rig = makeRig({ shadows: { mode: 'full' } });
    const frustum = rig.lighting.shadowFrustum();

    expect(frustum).not.toBeNull();
    // Центр арены освещён и, значит, лежит внутри пирамиды.
    expect(frustum!.containsPoint(new THREE.Vector3(4, 4, 0))).toBe(true);
    // Точка далеко за границей коробки — снаружи.
    expect(frustum!.containsPoint(new THREE.Vector3(400, 400, 0))).toBe(false);
  });

  it('в режимах без карт теней пирамиды нет вовсе (`none`, `blob`)', () => {
    // Отсекать по ней нечего: карты нет, и владелец инстансов остаётся с одной
    // камерой кадра, как и до появления порта.
    expect(makeRig({ shadows: { mode: 'none' } }).lighting.shadowFrustum()).toBeNull();
    expect(makeRig({ shadows: { mode: 'blob' } }).lighting.shadowFrustum()).toBeNull();
    expect(makeRig({ shadows: { mode: 'hybrid' } }).lighting.shadowFrustum()).not.toBeNull();
  });

  it('пирамида следует направлению света и переиспользуется (REND-26)', () => {
    const rig = makeRig({
      shadows: { mode: 'full' },
      directional: { direction: { x: 0, y: 0, z: 10 } },
    });
    const first = rig.lighting.shadowFrustum()!;
    const plane = first.planes[0]!.normal.clone();

    rig.lighting.applyConfig({
      shadows: { mode: 'full' },
      directional: { direction: { x: 20, y: 5, z: 4 } },
    });
    const second = rig.lighting.shadowFrustum()!;

    // Тот же объект — своих аллокаций порт на вызов не делает…
    expect(second).toBe(first);
    // …а числа в нём — уже нового направления.
    expect(second.planes[0]!.normal.equals(plane)).toBe(false);
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
  readonly lightWorldX: number;
  readonly lightWorldY: number;
  readonly lightWorldZ: number;
  readonly targetWorldX: number;
  readonly targetWorldY: number;
  readonly targetWorldZ: number;
  readonly arenaRadiusWorldUnits: number;
  readonly shadowFrustumWidthWorldUnits: number;
  readonly shadowFrustumHeightWorldUnits: number;
  readonly shadowMode: string;
  readonly authoredShadowMode: string;
  readonly ceilingShadowMode: string;
  readonly shadowMapTexels: number;
  readonly authoredShadowMapTexels: number;
  readonly ceilingShadowMapTexels: number | null;
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
      shadows: { mode: 'hybrid', mapSize: 512 },
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
    // Направленный источник ОДИН во всех режимах (REND-30) плюс рассеянный.
    expect(dumped.ambientLights).toBe(1);
    expect(dumped.directionalLights).toBe(1);
    expect(dumped.lightCount).toBe(2);
    expect(dumped.ambientIntensity).toBe(DEFAULT_LIGHTING_CONFIG.ambientIntensity);
    expect(dumped.ambientColor).toBe('#ffffff');
    // Интенсивность — авторская целиком: делить её между ярусами нечем.
    expect(dumped.directionalIntensity).toBeCloseTo(2, 6);
    expect(dumped.sunIntensity).toBeCloseTo(2, 6);
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
    // Стороны фрустума, а не полусторона: он обтянут по коробке арены в
    // пространстве света и несимметричен (REND-30, design D6).
    expect(dumped.shadowFrustumWidthWorldUnits).toBeCloseTo(
      sun.shadow.camera.right - sun.shadow.camera.left,
      6,
    );
    expect(dumped.shadowFrustumHeightWorldUnits).toBeCloseTo(
      sun.shadow.camera.top - sun.shadow.camera.bottom,
      6,
    );
    // Карт три: две цели ярусов и карта сведения (REND-30). Настоящего теневого
    // прохода в headless-прогоне нет — цели заводит подсистема, а не three.
    expect(dumped.builtShadowMaps).toBe(3);
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

    // Цели сведения подсистема заводит сама (REND-30), и дамп называет их все:
    // две цели ярусов плюс карта, которую читают материалы сцены.
    expect(section(layer).builtShadowMaps).toBe(3);
  });

  it('отметка стоит в позиции направленного источника, луч указывает на центр арены', () => {
    const rig = makeRig({ shadows: { mode: 'hybrid' } });
    const source = rig.lighting.debugSources()[0]!;
    const drawn = capture();
    source.draw?.(source.probe(IDLE_FRAME), drawn.out);

    const sun = directionalLights(rig.scene)[0]!;
    // Отметка одна: направленный источник сцены один во всех режимах (REND-30).
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
