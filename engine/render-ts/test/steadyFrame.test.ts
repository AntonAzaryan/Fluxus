/**
 * Аллокационная дисциплина кадрового пути (задача 5.2 изменения
 * `render-quality-presets`): в УСТАНОВИВШЕМСЯ кадре — состав инстансов не
 * менялся, доставки не было — путь `frame`/`updateFrame` подсистем не
 * аллоцирует пропорционально числу инстансов и объёму контента.
 *
 * Счётчика аллокаций в vitest нет, и мерить давление на GC напрямую нечем.
 * Поэтому проверяется наблюдаемое, и двумя способами сразу:
 *
 * - **счётчиками стоимости** (`performance-budget` PERF-2, PERF-3): за N кадров
 *   стадия кадра растёт ровно на N вызовов, покадровая работа ПОБИТОВО одна и
 *   та же во всех кадрах, а стадия доставки не двигается вовсе — «кадр не
 *   делает работы доставки»;
 * - **идентичностью объектов** на швах, где API отдаёт их наружу: инстанс-буфер
 *   батча и его запись диапазона заливки, публичный вид инстанса и его поза,
 *   поза камеры, офсет стека эффектов, экземпляр эмиттера. Один и тот же объект
 *   во всех кадрах — значит кадр его не заводил.
 *
 * Там, где объект наружу не виден вовсе (раскладка таблицы ролей
 * bone-контроля), берётся сильнейший доступный заменитель — спай на самой
 * раскладке; об этом сказано на месте.
 *
 * Стенд — настоящие подсистемы за настоящей `PresentationStage`: террейн,
 * модели (батчевый ярус с отсечением по камере), транзиентные эффекты, частицы
 * и туман. WebGL здесь нет и не нужно: проверяется путь ДАННЫХ.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ParticleEffectDocument, VisualManifest } from '@game-mvp/assets';
import {
  BoneControlState,
  CameraRig,
  EffectStack,
  EffectsSubsystem,
  FogSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PresentationStage,
  TerrainSubsystem,
  VisualSurfaceSource,
  createCameraInput,
  createCostCounters,
  withCostSink,
  type CameraEffect,
  type CameraPose,
  type EntityView,
  type PoseOffset,
  type PresentationProducer,
  type RenderContext,
  type RenderCostCounters,
} from '../src/index.js';
import { flatGrid, makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

// ------------------------------------------------------------------- стенд

const MODEL_ID = 'models/runner.mdx';
const TORCH = 'vfx/torch.effect.json';
const STATS = { visionRadius: 'vision', team: 'team' } as const;
const PRODUCER: PresentationProducer = { name: 'steady' };

/** Сколько подсистем зарегистрировано на стенде — знаменатель счётчиков PERF-2. */
const SUBSYSTEMS = 5;
/** Сколько сущностей приносит единственная доставка стенда. */
const ENTITIES = 3;
/** Сколько кадров крутится установившаяся сцена. */
const FRAMES = 8;
const DT = 1 / 60;
const ALPHA = 0.5;
/**
 * Кадры сложения сцены: перестройка маски тумана под бюджетом (design D1) и
 * рассеивание (design D5). Шаг заведомо длиннее `dissolveSeconds`, поэтому
 * сходимость доигрывается первым же таким кадром, а запас взят на перестройку.
 */
const SETTLE_FRAMES = 8;
const SETTLE_DT = 1;

function torchDocument(): ParticleEffectDocument {
  const path = fileURLToPath(new URL('./fixtures/torch.effect.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

/**
 * Один тип на все три подсистемы-потребителя: модель (батчевый ярус, REND-20),
 * оболочка-примитив (REND-23) и эмиттер (REND-24). Так один кадр стенда идёт
 * сразу по трём покадровым путям, а не по одному.
 */
function manifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        animations: { states: { idle: 'Stand', move: 'Walk' } },
      },
    },
    effects: {
      byKind: {
        Runner: { primitive: 'sphere', color: '#4aa3ff', radius: 0.5, alpha: 0.4, height: 0.9 },
      },
    },
    particles: { byKind: { Runner: { effect: TORCH } } },
  };
}

/** Движущаяся сущность со статами наблюдателя: кадр интерполирует, туман строит маску. */
function entity(id: number): EntityView {
  return makeEntityView(id, {
    kind: 'Runner',
    prevX: id,
    currX: id + 0.25,
    prevY: 2,
    currY: 2.5,
    moving: true,
    stats: new Map([
      [STATS.team, 0],
      [STATS.visionRadius, 3],
    ]),
  });
}

interface Stand {
  readonly stage: PresentationStage;
  readonly models: ModelsSubsystem;
  readonly particles: ParticlesSubsystem;
  readonly scene: THREE.Scene;
}

/**
 * Сцена, чей состав сложился ОДНОЙ доставкой и дальше не меняется. Первый кадр
 * прокручивается здесь же и в замер не входит: на нём террейн собирает чанки,
 * а инстансы впервые получают позу — это событие сложения сцены, а не
 * установившийся кадр.
 */
function steadyStand(): Stand {
  const assets = makeAssets();
  assets.resolve('particle-effect', TORCH, torchDocument());
  const grid = flatGrid(16);
  const scene = new THREE.Scene();
  const ctx: RenderContext = {
    scene,
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const surface = new VisualSurfaceSource(grid);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(2, -12, 9);
  camera.lookAt(2, 2, 0);
  camera.updateMatrixWorld(true);

  const document = manifest();
  const models = new ModelsSubsystem(document, { surface, camera, warn: () => {} });
  const particles = new ParticlesSubsystem(document, { warn: () => {} });
  const stage = new PresentationStage(ctx)
    .register(new TerrainSubsystem(grid, { surface }))
    .register(models)
    .register(new EffectsSubsystem(document, { warn: () => {} }))
    .register(particles)
    .register(new FogSubsystem({ grid, stats: STATS, hero: () => 1 }));

  stage.publish(PRODUCER, makeTickView([entity(1), entity(2), entity(3)]));
  // Модель доезжает после доставки — как в матче (ASSET-4): заглушки уступают
  // место записям батча, и только с ними состав сцены окончателен.
  assets.resolve('model', MODEL_ID, makeModel());
  stage.frame(DT, ALPHA);
  // Маска тумана строится порциями кадра и рассеивается кадрами (change
  // `fog-mask-budgeted-rebuild`, design D1, D5) — это тоже сложение сцены, а не
  // установившийся кадр: большой шаг доигрывает рассеивание разом, и дальше
  // окно пусто. Установившаяся сцена за туман не платит ничего — это и
  // проверяется ниже нулями его счётчиков.
  for (let i = 0; i < SETTLE_FRAMES; i++) stage.frame(SETTLE_DT, ALPHA);

  return { stage, models, particles, scene };
}

/** Счётчики РОВНО одного кадра — по одному свежему стоку на кадр. */
function perFrameCost(stand: Stand, count: number): RenderCostCounters[] {
  const shots: RenderCostCounters[] = [];
  for (let i = 0; i < count; i++) {
    const counters = createCostCounters();
    withCostSink(counters, () => {
      stand.stage.frame(DT, ALPHA);
    });
    shots.push(counters);
  }
  return shots;
}

// ----------------------------------------- стадия кадра против стадии доставки

describe('установившаяся сцена: работа кадра постоянна', () => {
  it('N кадров без доставок: стадия кадра растёт ровно на N, стадия доставки — ноль', () => {
    const stand = steadyStand();
    const counters = createCostCounters();
    withCostSink(counters, () => {
      for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);
    });

    expect(counters.frameCalls).toBe(FRAMES);
    expect(counters.frameSubsystems).toBe(FRAMES * SUBSYSTEMS);
    // Инстансы кадра растут ЛИНЕЙНО числом кадров: на кадр их столько же,
    // сколько принесла единственная доставка (PERF-2).
    expect(counters.frameInstances).toBe(FRAMES * ENTITIES * SUBSYSTEMS);

    // Доставки в этих кадрах не было — вся стадия доставки осталась нулевой.
    expect(counters.syncTickDeliveries).toBe(0);
    expect(counters.syncTickSubsystems).toBe(0);
    expect(counters.syncTickInstances).toBe(0);
    expect(counters.syncTickDecorationInstances).toBe(0);
    // Туман устоявшейся сцены не стоит кадру НИЧЕГО: доставок не было, значит
    // перестраивать нечего, а окно рассеивания пусто — ни прохода схождения, ни
    // загрузки текстуры, ни блита миникарты (design D5). Иначе стоимость кадра
    // росла бы квадратом разрешения на пустом месте.
    expect(counters.fogMaskClearTexels).toBe(0);
    expect(counters.fogMaskSmoothTexels).toBe(0);
    expect(counters.fogMaskUploadBytes).toBe(0);
    expect(counters.fogMinimapTexels).toBe(0);
    expect(counters.fogDissolveTexels).toBe(0);
    expect(counters.fogEntitiesScanned).toBe(0);
  });

  it('покадровая работа побитово одна и та же — кадр к кадру не растёт', () => {
    const stand = steadyStand();
    const shots = perFrameCost(stand, FRAMES);
    const first = shots[0]!;

    expect(first.frameCalls).toBe(1);
    expect(first.frameSubsystems).toBe(SUBSYSTEMS);
    expect(first.frameInstances).toBe(ENTITIES * SUBSYSTEMS);
    // Ни один счётчик не отличается от первого кадра ни на единицу: работа
    // установившегося кадра — величина, а не тренд.
    for (const shot of shots) expect(shot).toEqual(first);
  });

  it('состав сцены за кадры не меняется: ни узлов, ни записей батча не прибавляется', () => {
    const stand = steadyStand();
    const nodes = stand.scene.children.length;
    const batches = stand.models.batchStats();
    const emitters = stand.particles.activeCount;
    const pooled = stand.particles.pooledCount;

    for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);

    expect(stand.scene.children.length).toBe(nodes);
    expect(stand.models.batchStats()).toEqual(batches);
    expect(stand.particles.activeCount).toBe(emitters);
    // Пул экземпляров эффекта не растёт: кадр `clone()` не делает (REND-24).
    expect(stand.particles.pooledCount).toBe(pooled);
  });
});

// ------------------------------------------- переиспользуемые буферы на швах

describe('кадровые буферы переиспользуются между кадрами', () => {
  it('батч: инстанс-атрибуты и запись диапазона заливки — те же объекты (REND-20)', () => {
    const stand = steadyStand();
    const mesh = stand.models.batchMeshes()[0]!;
    const matrix = mesh.instanceMatrix;
    const pose = mesh.geometry.getAttribute('instancePose') as THREE.InstancedBufferAttribute;
    const matrixArray = matrix.array;
    const poseArray = pose.array;
    // Диапазон заливки снимается ПОСЛЕ первого кадра стенда: компактация уже
    // прошла, и запись в `updateRanges` лежит.
    const matrixRange = matrix.updateRanges[0]!;
    const poseRange = pose.updateRanges[0]!;

    for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);

    // Ёмкость не росла — атрибуты и их типизированные массивы прежние.
    expect(mesh.instanceMatrix).toBe(matrix);
    expect(mesh.geometry.getAttribute('instancePose')).toBe(pose);
    expect(matrix.array).toBe(matrixArray);
    expect(pose.array).toBe(poseArray);
    // Диапазон заливки — ОДНА долгоживущая запись на атрибут: `addUpdateRange`
    // three заводит новый `{ start, count }` на каждый вызов, то есть по два
    // объекта на набор буферов каждого уровня КАЖДЫЙ кадр. Проверяется
    // ИДЕНТИЧНОСТЬ записи, а не её число: длина 1 сошлась бы и у кадра,
    // который очищает список и кладёт в него свежий объект.
    expect(matrix.updateRanges).toHaveLength(1);
    expect(matrix.updateRanges[0]).toBe(matrixRange);
    expect(pose.updateRanges).toHaveLength(1);
    expect(pose.updateRanges[0]).toBe(poseRange);
  });

  it('модели: доигравшие fade снимаются обходом значений, а не пар (FOW-8)', () => {
    const stand = steadyStand();
    stand.stage.frame(DT, ALPHA);

    // Обход набора инстансов с деструктуризацией пары завёл бы массив на КАЖДЫЙ
    // инстанс каждого кадра. Наружу этот обход не виден, и берётся тот же приём,
    // что у спая раскладки таблицы ролей ниже: спай на самом источнике пар.
    // `Map.prototype.entries` внутри окна взяться может только из кадрового кода
    // рендера — сторонних библиотек на этом пути нет.
    const entries = vi.spyOn(Map.prototype, 'entries');
    let calls = -1;
    try {
      for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);
      calls = entries.mock.calls.length;
    } finally {
      entries.mockRestore();
    }
    // Счёт снимается ДО снятия спая, а сверяется после: сам `expect` не должен
    // попасть в окно наблюдения.
    expect(calls).toBe(0);
  });

  it('метрика экранного размера камеры пишется в долгоживущую запись (REND-22)', () => {
    // Запись `ScreenScale` наружу не видна вовсе: `screenScaleOf` пишет в
    // приватное поле подсистемы и возвращает его же, а публичного шва у метрики
    // нет. Наблюдаемого заменителя тоже нет — счётчика аллокаций у прогона не
    // существует, а спай сюда не дотягивается (литерал объекта ничего из
    // прототипов не зовёт). Контортить ради теста публичный API подсистемы
    // дороже, чем стеречь это место ревью, поэтому здесь проверяется соседнее
    // наблюдаемое: кадр не пересоздаёт то, что от метрики зависит, — уровень
    // детализации инстансов установившейся сцены не дёргается.
    const stand = steadyStand();
    const levels = (): number[] =>
      [1, 2, 3].map((id) => stand.models.instanceFor(id)?.lodLevel ?? -1);
    const first = levels();

    for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);

    expect(levels()).toEqual(first);
  });

  it('модели: публичный вид инстанса и его поза — те же объекты (REND-3, REND-17)', () => {
    const stand = steadyStand();
    const view = stand.models.instanceFor(1)!;
    const pose = view.pose;

    for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);

    expect(stand.models.instanceFor(1)).toBe(view);
    expect(stand.models.instanceFor(1)!.pose).toBe(pose);
    // Поза — геттеры поверх записи, а не копия полей: кадр её двигает, объект
    // остаётся тем же.
    expect(Number.isFinite(pose.x)).toBe(true);
  });

  it('частицы: оболочка и её экземпляр между кадрами — те же объекты (REND-24)', () => {
    const stand = steadyStand();
    const object = stand.particles.emitterFor(1)!.object;
    const batches = stand.particles.batchCount;

    for (let i = 0; i < FRAMES; i++) stand.stage.frame(DT, ALPHA);

    // Замыкание, которое поза оболочки передаёт резолву сокета, наружу не
    // видно, а счётчика аллокаций у прогона нет — здесь проверяется сильнейшее
    // наблюдаемое: набор оболочек, их экземпляры и батчи отрисовки кадр не
    // пересоздаёт.
    expect(stand.particles.emitterFor(1)!.object).toBe(object);
    expect(stand.particles.batchCount).toBe(batches);
  });
});

// ---------------------------------------------------- камера: поза и эффекты

describe('камера отдаёт кадру одни и те же объекты (CAM-1, CAM-6)', () => {
  const logical: CameraPose = {
    posX: 0,
    posY: 0,
    posZ: 10,
    yaw: 0,
    pitch: 0.5,
    roll: 0,
    fovDeg: 45,
  };

  it('rig возвращает ту же позу во всех кадрах', () => {
    const rig = new CameraRig();
    const input = createCameraInput();
    const first = rig.update(input, DT, null);
    for (let i = 0; i < FRAMES; i++) expect(rig.update(input, DT, null)).toBe(first);
  });

  it('стек эффектов: офсет и финальная поза — по одному объекту на стек', () => {
    const stack = new EffectStack();
    const offsets = new Set<PoseOffset>();
    stack.add({
      update: (_dt, out): boolean => {
        offsets.add(out);
        return true;
      },
    });

    const pose = stack.apply(logical, DT);
    for (let i = 0; i < FRAMES; i++) expect(stack.apply(logical, DT)).toBe(pose);
    // Офсет — один на стек: жильцы всех кадров складывались в него же.
    expect(offsets.size).toBe(1);
  });

  it('кадр не пересобирает список жильцов: `filter` на этом пути не зовётся', () => {
    const stack = new EffectStack();
    stack.add({ update: (): boolean => true });
    stack.apply(logical, DT);

    // Тот же приём, что у спая раскладки таблицы ролей: наружу массив жильцов
    // не виден, а новый массив (и новое замыкание к нему) на этом пути могли бы
    // взяться только из `filter`. Внутри окна спая исполняется исключительно
    // код стека и жилец-заглушка.
    const filter = vi.spyOn(Array.prototype, 'filter');
    let calls = -1;
    try {
      for (let i = 0; i < FRAMES; i++) stack.apply(logical, DT);
      calls = filter.mock.calls.length;
    } finally {
      filter.mockRestore();
    }
    expect(calls).toBe(0);
  });

  it('отживший эффект снимается компактацией: соседи остаются, порядок прежний', () => {
    const stack = new EffectStack();
    const calls: string[] = [];
    let firstAlive = true;
    const effect = (id: string, alive: () => boolean): CameraEffect => ({
      update: (): boolean => {
        calls.push(id);
        return alive();
      },
    });
    stack.add(effect('a', () => firstAlive));
    stack.add(effect('b', () => true));
    stack.add(effect('c', () => true));

    stack.apply(logical, DT);
    expect(calls).toEqual(['a', 'b', 'c']);

    // Кадр, на котором первый жилец объявляет себя отжившим: его вклад в этом
    // кадре ещё считается, со стека он уходит по его концу.
    calls.length = 0;
    firstAlive = false;
    stack.apply(logical, DT);
    expect(calls).toEqual(['a', 'b', 'c']);

    calls.length = 0;
    stack.apply(logical, DT);
    expect(calls).toEqual(['b', 'c']);
  });
});

// ------------------------------------------------ bone-контроль: спай раскладки

describe('таблица ролей bone-контроля раскладывается не в кадре (REND-5)', () => {
  function lookup(): { readonly bonesByName: ReadonlyMap<string, THREE.Bone> } {
    return { bonesByName: new Map([['Bone_Chest', new THREE.Bone()]]) };
  }

  const controls = { torso: { bone: 'Bone_Chest', maxYawDeg: 60, smoothing: 12 } };

  it('в кадре `Object.entries` не зовётся вовсе', () => {
    const state = new BoneControlState(controls);
    const bones = lookup();
    state.apply(bones, 0.3, 0, DT); // первый кадр заводит роль

    // Прямого счётчика аллокаций у прогона нет; сильнейший доступный
    // заменитель — спай на самой раскладке: массив пар на инстанс на кадр
    // взяться может только отсюда, а внутри спая исполняется исключительно
    // код рендера — сторонних библиотек на этом пути нет.
    const entries = vi.spyOn(Object, 'entries');
    let calls = -1;
    try {
      for (let i = 0; i < FRAMES; i++) state.apply(bones, 0.3, 0, DT);
      calls = entries.mock.calls.length;
    } finally {
      entries.mockRestore();
    }
    // Счёт снимается ДО снятия спая, а сверяется после: сам `expect` не должен
    // попасть в окно наблюдения и приписать себе чужие вызовы.
    expect(calls).toBe(0);
  });

  it('переподача таблицы раскладывает её один раз — это событие, а не кадр (REND-17)', () => {
    const state = new BoneControlState(controls);
    const entries = vi.spyOn(Object, 'entries');
    let calls = -1;
    try {
      state.setControls({ torso: { bone: 'Bone_Chest', maxYawDeg: 30, smoothing: 12 } });
      calls = entries.mock.calls.length;
    } finally {
      entries.mockRestore();
    }
    expect(calls).toBe(1);
  });

  it('доворот кадра тот же, каким он был с раскладкой в кадре', () => {
    const state = new BoneControlState(controls);
    const bones = lookup();
    for (let i = 0; i < FRAMES; i++) state.apply(bones, Math.PI / 4, 0, DT);
    // Роль довернула кость к цели — раскладка вынесена из кадра, поведение то же.
    const bone = bones.bonesByName.get('Bone_Chest')!;
    expect(bone.quaternion.z).toBeGreaterThan(0);
  });
});
