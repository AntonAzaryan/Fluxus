/**
 * Локальные источники света инстансов (REND-33) и блок `light` записи манифеста
 * (`assets` ASSET-16): жизненный цикл источника вместе с инстансом, отбор
 * активных под потолком ручки качества (QUAL-1), пересмотр на переподаче
 * манифеста (REND-17, `editor` ED-15) и счётчики стоимости кадра (PERF-2,
 * PERF-3).
 *
 * Всё headless, как и у остального освещения: источники и их числа — данные, а
 * не GPU-объекты. Под тестом ровно то, что решает подсистема, — какие источники
 * существуют, где стоят, какими числами горят и кто из носителей выбран.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { VisualLight, VisualManifest } from '@fluxus/assets';
import {
  DEFAULT_MAX_LOCAL_LIGHTS,
  LIGHTING_MAX_LOCAL_LIGHTS,
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  createCostCounters,
  withCostSink,
  type EntityView,
  type PresentationProducer,
  type QualityPreset,
  type RenderContext,
} from '../src/index.js';
import { flatGrid, makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/rock.mdx';
const PRODUCER: PresentationProducer = { name: 'test' };

/** Точечный источник факела: тёплый тон, смещение на высоту чаши (ASSET-16). */
const TORCH_LIGHT: VisualLight = {
  type: 'point',
  color: '#ffb066',
  intensity: 12,
  distance: 6,
  offset: { z: 1.5 },
};

/** Конус: половинный угол восьмушкой оборота, направление вперёд-вниз. */
const LAMP_LIGHT: VisualLight = {
  type: 'spot',
  color: '#66c0ff',
  intensity: 20,
  distance: 8,
  decay: 1,
  angle: 0.125,
  penumbra: 0.5,
  direction: { x: 1, y: 0, z: 0 },
};

/**
 * Виды арены: носитель точечного света, носитель конуса, ЭМИТТЕРНЫЙ носитель
 * (ASSET-14 — его рисуют частицы, а свет он несёт наравне с моделью) и вид без
 * блока вовсе.
 */
function makeManifest(torch: VisualLight = TORCH_LIGHT): VisualManifest {
  return {
    entities: { Spark: { model: MODEL_ID, scale: 1, light: torch } },
    decorations: {
      Torch: { model: MODEL_ID, scale: 1, light: torch },
      Lamp: { model: MODEL_ID, scale: 1, light: LAMP_LIGHT },
      Flame: { effect: 'visuals/effects/flame.effect.json', light: torch },
      Rock: { model: MODEL_ID, scale: 1 },
    },
  };
}

interface Rig {
  readonly stage: PresentationStage;
  readonly lighting: LightingSubsystem;
  readonly models: ModelsSubsystem;
  readonly scene: THREE.Scene;
}

/**
 * Сцена подсистем в порядке регистрации сборок (REND-8): свет первым — он
 * владеет портом, в который модели отдают и теневых кастеров, и носителей
 * света. Камеру подсистеме освещения передают опцией: без неё точкой взгляда
 * берётся центр арены (design D3).
 */
function makeRig(options: {
  manifest?: VisualManifest;
  preset?: QualityPreset;
  camera?: THREE.Camera;
} = {}): Rig {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const stage = new PresentationStage(ctx);
  const grid = flatGrid();
  const lighting = new LightingSubsystem({
    grid,
    ...(options.camera === undefined ? {} : { camera: options.camera }),
  });
  stage.register(lighting);
  stage.register(new TerrainSubsystem(grid, { shadows: lighting }));
  const models = new ModelsSubsystem(options.manifest ?? makeManifest(), {
    shadows: lighting,
    warn: () => {},
  });
  stage.register(models);
  if (options.preset !== undefined) new QualityController(stage, options.preset);
  assets.resolve('model', MODEL_ID, makeModel());
  return { stage, lighting, models, scene };
}

/**
 * Кадры стенда. Носитель светит позой, которую посчитал ПРЕДЫДУЩИЙ кадр:
 * подсистема освещения владеет портом и потому зарегистрирована раньше
 * владельца инстансов (REND-31), а кадры идут в порядке регистрации (REND-8).
 * Поэтому первый кадр после появления инстанса ещё не знает, где тот стоит, —
 * свет зажигается следующим («не позже следующего кадра», ED-15), и тесты
 * зовут ровно эту пару.
 */
function frames(rig: Rig, count = 2): void {
  for (let i = 0; i < count; i++) rig.stage.frame(0.016, 0);
}

/** Набор decoration-инстансов в форме входа REND-18. */
function decorations(views: EntityView[]): ReadonlyMap<EntityId, EntityView> {
  return new Map(views.map((view) => [view.id, view]));
}

/** Размещение носителя: вид, координаты и курс — как их пишет документ (PRES-2). */
function placed(id: EntityId, kind: string, x: number, y: number, yaw = 0): EntityView {
  return makeEntityView(id, { kind, prevX: x, currX: x, prevY: y, currY: y, facingYaw: yaw, snap: true });
}

/** Локальные источники сцены — их числа и есть наблюдаемый свет. */
function localLights(scene: THREE.Scene): (THREE.PointLight | THREE.SpotLight)[] {
  return scene.children.filter((node) =>
    node.name.startsWith('lighting:local-'),
  ) as (THREE.PointLight | THREE.SpotLight)[];
}

/** Горящие источники кадра: погашенный слот стоит с нулевой интенсивностью. */
function burning(scene: THREE.Scene): (THREE.PointLight | THREE.SpotLight)[] {
  return localLights(scene).filter((light) => light.intensity > 0);
}

// ---------------------------------------------------- жизненный цикл источника

describe('локальный источник живёт вместе с инстансом (REND-33)', () => {
  it('появление носителя зажигает источник в позе инстанса со смещением блока', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 3, 2)]));
    frames(rig);

    const lit = burning(rig.scene);
    expect(lit).toHaveLength(1);
    const light = lit[0]!;
    expect(light.intensity).toBe(TORCH_LIGHT.intensity);
    expect(light.distance).toBe(TORCH_LIGHT.distance);
    // Затухание не написано — физическое умолчание блока (ASSET-16).
    expect((light as THREE.PointLight).decay).toBe(2);
    expect(`#${light.color.getHexString()}`).toBe(TORCH_LIGHT.color);
    // Опора света — поза инстанса плюс смещение блока: чаша факела, а не
    // подножие. Высота инстанса на плоской арене нулевая.
    expect(light.position.x).toBeCloseTo(3, 6);
    expect(light.position.y).toBeCloseTo(2, 6);
    expect(light.position.z).toBeCloseTo(1.5, 6);
    expect(rig.lighting.localLights.carrierCount).toBe(1);
    expect(rig.lighting.localLights.activeCount).toBe(1);
  });

  it('исчезновение инстанса гасит его источник, прочие горят как горели', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 3, 2), placed(2, 'Torch', 5, 5)]));
    frames(rig);
    expect(burning(rig.scene)).toHaveLength(2);

    rig.stage.publishDecorations(decorations([placed(2, 'Torch', 5, 5)]));
    frames(rig);
    const lit = burning(rig.scene);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.position.x).toBeCloseTo(5, 6);
    expect(rig.lighting.localLights.carrierCount).toBe(1);
  });

  it('свет несут оба продюсера presentation-состояния и набор декораций (REND-11, REND-18)', () => {
    const rig = makeRig();
    // Сущность потока тиков и размещённая декорация — один и тот же путь.
    rig.stage.publish(PRODUCER, makeTickView([placed(7, 'Spark', 1, 1)]));
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 6, 6)]));
    frames(rig);
    expect(rig.lighting.localLights.carrierCount).toBe(2);
    expect(burning(rig.scene)).toHaveLength(2);
  });

  it('эмиттерный вид несёт свет наравне с модельным (ASSET-14, ASSET-16)', () => {
    // Факел арены рисуется частицами (REND-24), а свет — свойство ЗАПИСИ:
    // `resolveVisual` эмиттерный вид не отдаёт, и брать блок из него нельзя.
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Flame', 4, 4)]));
    frames(rig);
    expect(rig.lighting.localLights.carrierCount).toBe(1);
    expect(burning(rig.scene)).toHaveLength(1);
  });

  it('запись без блока света источника не заводит: сцена без света остаётся прежней', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Rock', 4, 4)]));
    frames(rig);
    expect(rig.lighting.localLights.carrierCount).toBe(0);
    // Ни одного источника в сцене: пул рода строится по первому носителю.
    expect(localLights(rig.scene)).toHaveLength(0);
  });

  it('конус берёт угол, полутень и направление блока в опоре инстанса', () => {
    const rig = makeRig();
    // Курс размещения — четверть оборота: направление блока едет вместе с ним.
    rig.stage.publishDecorations(decorations([placed(1, 'Lamp', 4, 4, Math.PI / 2)]));
    frames(rig);

    const lit = burning(rig.scene);
    expect(lit).toHaveLength(1);
    const spot = lit[0] as THREE.SpotLight;
    expect(spot.isSpotLight).toBe(true);
    expect(spot.angle).toBeCloseTo(Math.PI / 4, 12);
    expect(spot.penumbra).toBe(0.5);
    expect(spot.decay).toBe(1);
    // Направление `+X` записи, повёрнутое курсом инстанса, смотрит по `+Y`.
    const dir = spot.target.position.clone().sub(spot.position);
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(1, 6);
    expect(dir.z).toBeCloseTo(0, 6);
  });
});

// --------------------------------------------------------------- тени и снос

describe('локальный свет и тени (REND-33, REND-30)', () => {
  it('источник теней не отбрасывает и в реестр кастеров не входит', () => {
    const rig = makeRig();
    frames(rig);
    const before = rig.lighting.casterCount('static') + rig.lighting.casterCount('dynamic');
    // Чанки пола террейна в реестре уже есть — им и мерится «не прибавилось».
    expect(before).toBeGreaterThan(0);

    // Эмиттерный носитель (ASSET-14) нарисованного в этот пул не даёт вовсе:
    // всё, что он добавляет сцене, — локальный источник. Реестр кастеров от
    // него не растёт ни на один корень.
    rig.stage.publishDecorations(decorations([placed(1, 'Flame', 3, 3)]));
    frames(rig);
    expect(burning(rig.scene)).toHaveLength(1);
    expect(rig.lighting.casterCount('static') + rig.lighting.casterCount('dynamic')).toBe(before);
    for (const light of localLights(rig.scene)) expect(light.castShadow).toBe(false);
  });

  it('снос подсистемы отдаёт пул и реестр носителей (REND-31, design D6)', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 3, 3)]));
    frames(rig);
    expect(localLights(rig.scene).length).toBeGreaterThan(0);

    rig.lighting.dispose();
    expect(localLights(rig.scene)).toHaveLength(0);
    expect(rig.lighting.localLights.carrierCount).toBe(0);
    expect(rig.lighting.localLights.activeCount).toBe(0);
  });
});

// ------------------------------------------------------- отбор под потолком

describe('носителей больше потолка (REND-33, QUAL-1)', () => {
  /** Пять факелов в ряд: потолок пресета выберет из них ближайшие к взгляду. */
  const row: readonly EntityView[] = [
    placed(1, 'Torch', 0, 0),
    placed(2, 'Torch', 2, 0),
    placed(3, 'Torch', 4, 0),
    placed(4, 'Torch', 6, 0),
    placed(5, 'Torch', 8, 0),
  ];

  /** Позиции горящих источников по возрастанию — их и сравниваем между прогонами. */
  function litAt(rig: Rig): number[] {
    return burning(rig.scene)
      .map((light) => light.position.x)
      .sort((a, b) => a - b);
  }

  it('активны ровно столько, сколько разрешает потолок; носителей больше', () => {
    const rig = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    rig.stage.publishDecorations(decorations([...row]));
    frames(rig);

    expect(rig.lighting.localLights.carrierCount).toBe(5);
    expect(rig.lighting.localLights.activeCount).toBe(2);
    expect(burning(rig.scene)).toHaveLength(2);
    // Пул размера потолка: слотов ровно два, и лишний носитель не заводит
    // третьего источника — он просто не горит (design D2).
    expect(localLights(rig.scene)).toHaveLength(2);
  });

  it('повтор того же кадра отбирает те же источники, а порядок подачи на отбор не влияет', () => {
    const rig = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    rig.stage.publishDecorations(decorations([...row]));
    frames(rig);
    const first = litAt(rig);
    frames(rig, 1);
    expect(litAt(rig)).toEqual(first);

    // Тот же набор, поданный задом наперёд: отбор ведут ДАННЫЕ КАДРА — позы
    // носителей и границы их действия, — а не порядок, в котором инстансы
    // создавались и попали в реестр. Ключ носителя в этом наборе не участвует
    // вовсе: оценки у пяти факелов разные, и до тай-брейка дело не доходит.
    const mirrored = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    mirrored.stage.publishDecorations(decorations([...row].reverse()));
    frames(mirrored);
    expect(litAt(mirrored)).toEqual(first);
  });

  it('точка взгляда камеры двигает отбор: горят источники у того, куда смотрит игрок', () => {
    // Камера над правым краем ряда, смотрит вниз: ближайшие к её точке взгляда
    // факелы и есть активные (design D3).
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(8, 0, 10);
    camera.lookAt(8, 0, 0);
    const rig = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 }, camera });
    rig.stage.publishDecorations(decorations([...row]));
    frames(rig);
    expect(litAt(rig)).toEqual([6, 8]);

    // Та же сцена без камеры: точка взгляда — центр арены (4, 4), и отбор
    // остаётся определённым, просто другим.
    const still = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    still.stage.publishDecorations(decorations([...row]));
    frames(still);
    expect(litAt(still)).toEqual([2, 4]);
  });

  it('смена потолка пересоздаёт пул — событием, а не кадром', () => {
    const rig = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    const controller = new QualityController(rig.stage, { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 });
    rig.stage.publishDecorations(decorations([...row]));
    frames(rig);
    expect(localLights(rig.scene)).toHaveLength(2);

    controller.apply({ [LIGHTING_MAX_LOCAL_LIGHTS]: 4 });
    frames(rig);
    expect(localLights(rig.scene)).toHaveLength(4);
    expect(rig.lighting.localLights.activeCount).toBe(4);

    // Нулевой потолок — локального света нет вовсе: источники уходят из сцены,
    // и материалы перестают за них платить.
    controller.apply({ [LIGHTING_MAX_LOCAL_LIGHTS]: 0 });
    frames(rig);
    expect(localLights(rig.scene)).toHaveLength(0);
    expect(rig.lighting.localLights.activeCount).toBe(0);
    expect(rig.lighting.localLights.carrierCount).toBe(5);
  });

  it('умолчание ручки действует без документа пресета (QUAL-1)', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(
      decorations(Array.from({ length: 9 }, (_, i) => placed(i + 1, 'Torch', i, 0))),
    );
    frames(rig);
    expect(rig.lighting.localLights.activeCount).toBe(DEFAULT_MAX_LOCAL_LIGHTS);
  });
});

// ------------------------------------------------- переподача манифеста (ED-15)

describe('переподача манифеста пересматривает свет (REND-17, ED-15)', () => {
  it('появившийся блок зажигает свет уже стоящих инстансов', () => {
    const bare: VisualManifest = { entities: {}, decorations: { Torch: { model: MODEL_ID } } };
    const rig = makeRig({ manifest: bare });
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 3, 3)]));
    frames(rig);
    expect(rig.lighting.localLights.carrierCount).toBe(0);

    // Ровно ОДИН кадр после правки: инстанс уже стоит в позе, и лишнего кадра
    // на разгон ему не нужно — «не позже следующего кадра» (ED-15) и есть тот
    // срок, который здесь под тестом.
    rig.models.applyManifest(makeManifest());
    frames(rig, 1);
    expect(rig.lighting.localLights.carrierCount).toBe(1);
    expect(burning(rig.scene)).toHaveLength(1);
    // Инстанс тот же: переподача правит запись, а не размещённый объект.
    expect(rig.models.instanceFor(1, true)).not.toBeNull();
  });

  it('снятый блок гасит свет, а правленые числа доезжают на живом источнике', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Torch', 3, 3)]));
    frames(rig);
    expect(burning(rig.scene)[0]!.intensity).toBe(12);

    // Правка чисел блока: источник тот же, пересборки инстанса нет. Один кадр —
    // тот же срок ED-15, что и у появления блока.
    rig.models.applyManifest(makeManifest({ ...TORCH_LIGHT, intensity: 3, distance: 2 }));
    frames(rig, 1);
    const lit = burning(rig.scene);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.intensity).toBe(3);
    expect(lit[0]!.distance).toBe(2);

    // Блок снят целиком — свет гаснет не позже следующего кадра.
    rig.models.applyManifest({ entities: {}, decorations: { Torch: { model: MODEL_ID } } });
    frames(rig, 1);
    expect(rig.lighting.localLights.carrierCount).toBe(0);
    expect(burning(rig.scene)).toHaveLength(0);
  });
});

// ------------------------------------------------------- счётчики стоимости

describe('счётчики стоимости локального света (PERF-2, PERF-3)', () => {
  it('кадр считает и носителей, и зажжённые источники', () => {
    const rig = makeRig({ preset: { [LIGHTING_MAX_LOCAL_LIGHTS]: 2 } });
    rig.stage.publishDecorations(
      decorations([placed(1, 'Torch', 1, 1), placed(2, 'Torch', 2, 2), placed(3, 'Torch', 3, 3)]),
    );
    // Прогрев — до стока: первый кадр стенда поз инстансов ещё не знает, и
    // считать в нём нечего (см. `frames`).
    frames(rig);
    const cost = createCostCounters();
    withCostSink(cost, () => {
      frames(rig, 2);
    });
    // Два кадра по три носителя и по два активных источника: числа суммируются
    // по кадрам, как и прочие счётчики стадии.
    expect(cost.lightingLocalCarriers).toBe(6);
    expect(cost.lightingLocalActive).toBe(4);
  });

  it('сцена без локального света счётчиков не двигает', () => {
    const rig = makeRig();
    rig.stage.publishDecorations(decorations([placed(1, 'Rock', 3, 3)]));
    const cost = createCostCounters();
    withCostSink(cost, () => {
      frames(rig);
    });
    expect(cost.lightingLocalCarriers).toBe(0);
    expect(cost.lightingLocalActive).toBe(0);
  });
});
