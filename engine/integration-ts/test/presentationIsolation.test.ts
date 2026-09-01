/**
 * Изоляция presentation-слоя от симуляции (`presentation-scene` PRES-4).
 *
 * Инвариант «правка парного документа не меняет ни байта симуляции» нормирован
 * проверяемым МЕХАНИЧЕСКИ, а не декларацией: «прогон сцены с декорациями и
 * прогон той же сцены без парного документа SHALL давать побитово совпадающие
 * эталоны» (PRES-4, `cli-testing` CLI-6, CLI-8). Здесь он и проверяется — тем
 * же `runScenarioBytes`, которым CLI печатает документ прогона.
 *
 * Тест живёт в кросс-слойной сюите (CLI-9), потому что утверждение
 * межпакетное: документ грузит модуль ассетов, набор инстансов строит рендер, а
 * побитовое равенство касается ядра, и ни один пакет по отдельности этого
 * утверждения не видит.
 *
 * Слово «побитово» здесь буквально: сравниваются БАЙТЫ документа прогона, а не
 * разобранные снапшоты. Разбор скрыл бы ровно те расхождения, ради которых
 * инвариант и заведён, — порядок ключей и представление чисел (SER-6).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  contentPackHash,
  createTerrainGrid,
  fixed,
  loadScene,
  runScenario,
  runScenarioBytes,
  type SceneDef,
  type TerrainGrid,
} from '@fluxus/core';
import { contentPack } from '@fluxus/net';
import {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_CONFIG_PARAMS,
  CameraRig,
  DecorationSet,
  LightingSubsystem,
  ModelsSubsystem,
  PostprocessSubsystem,
  PresentationStage,
  WaterSubsystem,
  cameraConfigFromManifest,
  createCameraInput,
  type DecorationInstance,
  type PostRendererLike,
  type RenderContext,
} from '@fluxus/render';
import {
  manifestAssetRefs,
  presentationPathOf,
  resolveVisual,
  resolveVisualEmitter,
  validateManifest,
  validateParticleEffect,
  validatePresentationScene,
  type PresentationLighting,
  type PresentationPostprocess,
  type PresentationScene,
  type PresentationWater,
  type VisualLight,
  type VisualManifest,
} from '@fluxus/assets';
import { BUILD_ID, duelConfig, duelScene, playMatch, walkRight } from './fixtures.js';

const CONTENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../content');

/**
 * Парный документ фикстуры — НЕ контент (CONT-4): он пинает движок, а не
 * описывает игру, и в дерево контента ему не место. Демонстрационный слой
 * реальной сцены проверяется отдельно, ниже.
 */
const FIXTURE_LAYER: PresentationScene = {
  decorations: [
    { visual: 'Statue', x: 3.25, y: -1.5 },
    { visual: 'Statue', x: -4, y: 7.125, yaw: 0.25, scale: 1.5, skin: 'mossy' },
    { visual: 'Rubble', x: 0.001, y: 0.001 },
  ],
};

/**
 * Секция `water` слоя ОДНОГО из клиентов (PRES-2, `rendering` REND-35). Тоже не
 * контент: она пинает инвариант, а не описывает игру. Карта — по сетке
 * `WATER_GRID` ниже; урез ниже пола нулевого уровня, чтобы тело действительно
 * собралось, а не оказалось пустым регионом.
 */
const WATER_SECTION: PresentationWater = {
  cells: ['....', '.00.', '.00.', '....'],
  bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
};

/** Сетка, на которой стоит карта воды: клетки её адресует секция (REND-35). */
function waterGrid(): TerrainGrid {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: fixed.fromInt(1),
    levels: Array.from({ length: 4 }, () => '0000'),
    flags: Array.from({ length: 4 }, () => '....'),
  });
}

/** Сценарий прогона: та же сцена, тот же ввод, те же тики. */
function scenario(scene: SceneDef): Parameters<typeof runScenarioBytes>[0] {
  return { name: 'presentation-isolation', scene, ticks: 12, seed: 424242 };
}

/** Набор decoration-инстансов из документа — то, что уезжает в рендер (REND-18). */
function instancesOf(layer: PresentationScene): readonly DecorationInstance[] {
  return layer.decorations.map((record, index) => ({
    key: `deco-${index}`,
    kind: record.visual,
    x: record.x,
    y: record.y,
    ...(record.yaw === undefined ? {} : { yaw: record.yaw * Math.PI * 2 }),
    ...(record.scale === undefined ? {} : { scale: record.scale }),
    ...(record.skin === undefined ? {} : { skin: record.skin }),
  }));
}

describe('PRES-4: прогон с декорациями и без совпадает побитово', () => {
  it('парный документ не меняет ни байта документа прогона (CLI-6, CLI-8)', () => {
    const scene = duelScene();
    // Прогон «без слоя»: парного документа рядом нет вовсе.
    const bare = runScenarioBytes(scenario(scene));

    // Прогон «со слоем»: документ разобран, набор инстансов построен и отдан
    // рендеру — то есть слой действительно поднят, а не просто лежит на диске.
    const parsed = validatePresentationScene(FIXTURE_LAYER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const set = new DecorationSet(decoratedStage());
    set.apply(instancesOf(parsed.scene));
    expect(set.size).toBe(3);

    const decorated = runScenarioBytes(scenario(scene));
    // Побитово — сравниваются байты, а не разобранные снапшоты.
    expect(Buffer.from(decorated).equals(Buffer.from(bare))).toBe(true);
  });

  it('hash `worldInit` и канонический контент-пак матча слоя не видят (DET-1, NET-17)', () => {
    const scene = duelScene();
    // Хеш `worldInit` берётся у самого прогона (CLI-3): второй его реализации
    // тест не заводит — считает его ядро тем же способом, что и CLI.
    const before = {
      init: runScenario(scenario(scene)).worldInitHash,
      pack: contentPackHash(scene),
    };

    // Слой правится: записи добавляются, двигаются, исчезают.
    const edited: PresentationScene = {
      decorations: [
        ...FIXTURE_LAYER.decorations.slice(1),
        { visual: 'Statue', x: 99.999, y: -99.999, yaw: 0.5 },
      ],
    };
    const set = new DecorationSet(decoratedStage());
    set.apply(instancesOf(edited));

    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
    // Канал влияния отсутствует по построению: конфиг сцены о парном документе
    // не знает, и поля-ссылки на него в нём нет (PRES-1).
    expect(JSON.stringify(scene)).not.toContain('presentation');
    expect(JSON.stringify(scene)).not.toContain('decoration');
  });

  it('повреждённый парный документ прогону безразличен (ASSET-4)', () => {
    const scene = duelScene();
    const bare = runScenarioBytes(scenario(scene));
    // Handle слоя перешёл бы в `failed`: сцена рисуется без декораций, а матч
    // идёт, и прогон его побитово тот же.
    const broken = validatePresentationScene({ decorations: [{ x: 1 }] });
    expect(broken.ok).toBe(false);
    expect(Buffer.from(runScenarioBytes(scenario(scene))).equals(Buffer.from(bare))).toBe(true);
  });
});

/**
 * Цикл времени суток (`rendering` REND-32) — presentation-механизм целиком: круг
 * идёт по кадровым часам рендера, а тик, снапшоты и доставленная клиенту
 * информация от его хода не зависят (PRES-4). Утверждение межпакетное — цикл
 * крутит подсистема рендера, документ разбирает модуль ассетов, а «ни байтом»
 * касается ядра, — и поэтому живёт здесь, а не в тестах рендера.
 */
describe('PRES-4/REND-32: цикл времени суток симуляции не виден', () => {
  /** Статическая секция и та же секция с циклом — разница ровно в подсекции. */
  const STILL: PresentationLighting = {
    ambient: { color: '#ffffff', intensity: 0.65 },
    directional: { color: '#ffffff', intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
    shadows: { mode: 'hybrid' },
  };
  const CYCLED: PresentationLighting = {
    ...STILL,
    cycle: {
      transitionSeconds: 2,
      phases: [
        {
          name: 'утро',
          seconds: 10,
          ambient: { color: '#ffe8d0', intensity: 0.55 },
          directional: { color: '#ffd9b3', intensity: 1.5, direction: { x: -18, y: -8, z: 7 } },
        },
        {
          name: 'ночь',
          seconds: 10,
          ambient: { color: '#2a3a5c', intensity: 0.3 },
          directional: { color: '#5a7bb5', intensity: 0.5, direction: { x: 4, y: 10, z: 16 } },
        },
      ],
    },
  };

  /**
   * Прогон матча, пока рядом живёт подсистема освещения: полный круг суток
   * прокручивается кадровыми часами, а прогон сценария снимается байтами.
   * Возвращаются и байты, и след света — иначе тест утверждал бы про изоляцию
   * цикла, которого не подняли.
   */
  function runBeside(section: PresentationLighting): { bytes: Uint8Array; light: string[] } {
    const lighting = new LightingSubsystem({ config: section });
    lighting.init({
      scene: new THREE.Scene(),
      assets: {} as unknown as RenderContext['assets'],
      config: { heightStep: 0.5 },
    });
    const light: string[] = [];
    // Двадцать секунд presentation-времени — полный круг обеих фаз с обоими
    // переходами, по полсекунды на кадр.
    for (let frame = 0; frame < 40; frame++) {
      lighting.updateFrame(1 / 60, 0, 0.5);
      const { ambient, sun } = lighting.lights;
      light.push(`${ambient.color.getHexString()}:${sun.intensity.toFixed(4)}`);
    }
    return { bytes: runScenarioBytes(scenario(duelScene())), light };
  }

  it('worldInit и снапшоты сцены с циклом и без не отличаются ни байтом', () => {
    const scene = duelScene();
    const before = { init: runScenario(scenario(scene)).worldInitHash, pack: contentPackHash(scene) };

    // Документ с циклом — тот же документ формата: он проходит валидацию и
    // доезжает до подсистемы разбором, а не подставлен ей мимо загрузчика.
    const parsed = validatePresentationScene({ decorations: [], lighting: CYCLED });
    expect(parsed.ok ? '' : parsed.errors.join('; ')).toBe('');
    const authored = parsed.ok ? parsed.scene.lighting : undefined;
    expect(authored?.cycle?.phases).toHaveLength(2);
    if (authored === undefined) return;
    const still = runBeside(STILL);
    const cycled = runBeside(authored);

    // Цикл действительно шёл, и прошёл ВЕСЬ круг: установившееся утро, кадр
    // кроссфейда и установившаяся ночь — три РАЗНЫХ облика арены, а последний
    // кадр круга снова равен первому: возврат к первой фазе без скачка.
    expect(cycled.light).toHaveLength(40);
    const morning = cycled.light[0];
    const fading = cycled.light[18];
    const night = cycled.light[24];
    expect(new Set([morning, fading, night]).size).toBe(3);
    expect(cycled.light[39]).toBe(morning);
    // Сцена без подсекции стоит на месте — «никакой новой покадровой работы».
    expect(new Set(still.light).size).toBe(1);
    // А симуляция обоих прогонов побитово одна: сравниваются БАЙТЫ документа
    // прогона, а не разобранные снапшоты (SER-6).
    expect(Buffer.from(cycled.bytes).equals(Buffer.from(still.bytes))).toBe(true);
    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
  });
});

/**
 * Локальные источники света инстансов (`rendering` REND-33) — presentation-
 * механизм целиком: блок `light` живёт в записи манифеста визуалов (`assets`
 * ASSET-16), источники создаёт подсистема освещения, а симуляция о них не знает
 * ни байта (ASSET-1, PRES-4). Утверждение межпакетное — документ разбирает
 * модуль ассетов, свет зажигает рендер, а «ни байтом» касается ядра, — и
 * поэтому живёт здесь, а не в тестах рендера.
 */
describe('PRES-4/ASSET-16: локальный свет инстансов симуляции не виден', () => {
  const TORCH: VisualLight = {
    type: 'point',
    color: '#ffb066',
    intensity: 12,
    distance: 6,
    offset: { z: 1.5 },
  };

  /** Один и тот же вид арены — с блоком света и без него; прочее совпадает. */
  function manifestOf(light: boolean): VisualManifest {
    return {
      entities: {},
      decorations: {
        Torch: {
          effect: 'visuals/effects/torch.effect.json',
          ...(light ? { light: TORCH } : {}),
        },
      },
    };
  }

  /**
   * Сцена подсистем с настоящим светом и настоящим набором декораций (REND-18):
   * два факела на арене. Возвращает число ГОРЯЩИХ локальных источников — иначе
   * тест утверждал бы про изоляцию света, которого не подняли.
   *
   * Кадров два: подсистема освещения владеет портом носителей и потому
   * зарегистрирована раньше владельца инстансов (REND-31), а позу носителя
   * берёт ту, что посчитал предыдущий кадр.
   */
  function litStand(manifest: VisualManifest): number {
    const context = {
      scene: new THREE.Scene(),
      assets: {
        request: (kind: string, id: string) => ({ kind, id }),
        state: () => ({ status: 'loading' }),
        subscribe: () => () => undefined,
      },
      config: { heightStep: 0.5 },
    } as unknown as RenderContext;
    const stage = new PresentationStage(context);
    const lighting = new LightingSubsystem();
    stage.register(lighting);
    stage.register(new ModelsSubsystem(manifest, { shadows: lighting, warn: () => undefined }));
    new DecorationSet(stage).apply([
      { key: 'torch-a', kind: 'Torch', x: 2, y: 3 },
      { key: 'torch-b', kind: 'Torch', x: -4, y: 1 },
    ]);
    stage.frame(1 / 60, 0, 1 / 60);
    stage.frame(1 / 60, 0, 1 / 60);
    return lighting.localLights.lights.filter((light) => light.intensity > 0).length;
  }

  it('манифест с блоками света и без: прогон совпадает побитово', () => {
    const scene = duelScene();
    const before = {
      init: runScenario(scenario(scene)).worldInitHash,
      pack: contentPackHash(scene),
    };

    // Оба манифеста — документы формата: блок проходит валидацию и доезжает до
    // рендера разбором, а не подставлен подсистеме мимо загрузчика.
    for (const light of [false, true]) {
      const parsed = validateManifest(manifestOf(light));
      expect(parsed.ok ? '' : parsed.errors.join('; ')).toBe('');
    }
    const dark = { lights: litStand(manifestOf(false)), bytes: runScenarioBytes(scenario(scene)) };
    const lit = { lights: litStand(manifestOf(true)), bytes: runScenarioBytes(scenario(scene)) };

    // Свет действительно зажёгся — и ровно у той сцены, чья запись несёт блок.
    expect(dark.lights).toBe(0);
    expect(lit.lights).toBe(2);
    // А симуляция обоих прогонов побитово одна: сравниваются БАЙТЫ документа
    // прогона, а не разобранные снапшоты (SER-6).
    expect(Buffer.from(lit.bytes).equals(Buffer.from(dark.bytes))).toBe(true);
    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
  });
});

/**
 * Пост-обработка кадра (`rendering` REND-34) — presentation-механизм целиком:
 * секция `postprocess` парного документа (PRES-2) заводит цели и полноэкранные
 * проходы рендера, а тик, снапшоты и доставленная клиенту информация от неё не
 * зависят ни байтом (PRES-4). Утверждение межпакетное — секцию разбирает модуль
 * ассетов, проходы ведёт рендер, а «ни байтом» касается ядра, — и поэтому живёт
 * здесь, а не в тестах рендера.
 */
describe('PRES-4/REND-34: пост-обработка кадра симуляции не видна', () => {
  /** Секция с оператором и свечением — та же форма, что у сцены демо. */
  const POSTPROCESS: PresentationPostprocess = {
    toneMapping: { operator: 'aces', exposure: 1 },
    bloom: { enabled: true, strength: 0.35, threshold: 1, radius: 0.5 },
  };

  /**
   * Рендерер полноэкранных проходов без WebGL: цепочке нужен структурный
   * минимум, а тесту — число заказанных проходов.
   */
  function passRecorder(): { renderer: PostRendererLike; passes: number } {
    const record = {
      passes: 0,
      renderer: {
        render: (): void => {
          record.passes++;
        },
        setRenderTarget: (): void => undefined,
        getDrawingBufferSize: (target: THREE.Vector2): THREE.Vector2 => target.set(64, 48),
      },
    };
    return record;
  }

  /**
   * Прогон матча, пока рядом живёт подсистема пост-обработки. Возвращает и
   * байты прогона, и число проходов кадра — иначе тест утверждал бы про
   * изоляцию цепочки, которую не подняли.
   */
  function runBeside(section?: PresentationPostprocess): { bytes: Uint8Array; passes: number } {
    const post = new PostprocessSubsystem(section === undefined ? {} : { config: section });
    post.init({
      scene: new THREE.Scene(),
      assets: {} as unknown as RenderContext['assets'],
      config: { heightStep: 0.5 },
    });
    const stand = passRecorder();
    post.render(stand.renderer, new THREE.PerspectiveCamera());
    return { bytes: runScenarioBytes(scenario(duelScene())), passes: stand.passes };
  }

  it('worldInit и снапшоты сцены с секцией и без не отличаются ни байтом', () => {
    const scene = duelScene();
    const before = { init: runScenario(scenario(scene)).worldInitHash, pack: contentPackHash(scene) };

    // Секция — документ формата: она проходит валидацию и доезжает до
    // подсистемы разбором, а не подставлена ей мимо загрузчика.
    const parsed = validatePresentationScene({ decorations: [], postprocess: POSTPROCESS });
    expect(parsed.ok ? '' : parsed.errors.join('; ')).toBe('');
    const authored = parsed.ok ? parsed.scene.postprocess : undefined;
    // Разобранная секция утверждается ДО раннего возврата: иначе перестань
    // валидация выпускать `postprocess` наружу — и тест прошёл бы молча, ничего
    // не проверив (тот же порядок, что у теста цикла времени суток выше).
    expect(authored?.toneMapping?.operator).toBe('aces');
    expect(authored?.bloom?.enabled).toBe(true);
    if (authored === undefined) return;
    const bare = runBeside(undefined);
    const post = runBeside(authored);

    // Цепочка действительно шла: кадр сцены с секцией — отрисовка сцены и
    // полноэкранные проходы, кадр без неё — ровно прямая отрисовка (REND-34).
    expect(bare.passes).toBe(1);
    expect(post.passes).toBeGreaterThan(1);
    // А симуляция обоих прогонов побитово одна: сравниваются БАЙТЫ документа
    // прогона, а не разобранные снапшоты (SER-6).
    expect(Buffer.from(post.bytes).equals(Buffer.from(bare.bytes))).toBe(true);
    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
  });
});

/**
 * Машинный адрес единого конфига камеры (`camera` CAM-1) — секция манифеста
 * визуалов (`assets` ASSET-10). Утверждение межпакетное: документ лежит в
 * дереве контента, читает его модуль ассетов, перечень параметров объявляет
 * камера в рендере, а «не меняет ни байта симуляции» касается ядра.
 */
describe('ASSET-10: секция конфига камеры — presentation-данные', () => {
  const contentManifest = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(CONTENT_ROOT, 'visuals/manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  it('секция манифеста контента разбирается конфигом камеры без предупреждений', () => {
    const result = validateManifest(contentManifest(), {
      cameraConfig: CAMERA_CONFIG_DESCRIPTION,
    });
    expect(result.ok ? '' : result.errors.join('; ')).toBe('');
    // Ни одного параметра, которого код камеры не знает: адрес секции указывает
    // на существующие числа конфига, а не на выдуманные.
    expect(result.warnings).toEqual([]);
    if (!result.ok) return;
    const config = cameraConfigFromManifest(result.manifest.cameraConfig, {
      warn: (message) => expect.unreachable(message),
    });
    expect(Object.keys(config)).toEqual(CAMERA_CONFIG_PARAMS);
  });

  it('правка секции меняет кадр, но не хеш `worldInit` и не байты прогона (DET-1)', () => {
    const scene = duelScene();
    const before = {
      init: runScenario(scenario(scene)).worldInitHash,
      pack: contentPackHash(scene),
      bytes: runScenarioBytes(scenario(scene)),
    };

    // Дизайнер правит наклон и дистанцию (сценарий ASSET-10).
    const doc = contentManifest();
    const edited = {
      ...doc,
      cameraConfig: { ...(doc.cameraConfig as Record<string, number>), pitch: 0.6, distance: 24 },
    };
    const result = validateManifest(edited, { cameraConfig: CAMERA_CONFIG_DESCRIPTION });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rig = new CameraRig({ config: cameraConfigFromManifest(result.manifest.cameraConfig) });
    // Кадр действительно построен по правке — слой поднят, а не лежит на диске.
    expect(rig.update(createCameraInput(), 1 / 60, { x: 10, y: 10, snap: true }).pitch).toBe(0.6);
    expect(rig.config.distance).toBe(24);

    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
    expect(Buffer.from(runScenarioBytes(scenario(scene))).equals(Buffer.from(before.bytes))).toBe(
      true,
    );
  });
});

/**
 * Побитовое равенство прогонов выше — свойство НЕОБХОДИМОЕ, но само по себе
 * тавтологичное: парный документ в прогон и не подаётся, потому что подать его
 * туда нечем. Здесь пиннится то, на чём это «нечем» держится, — раздельность
 * загрузчиков (PRES-1): каждый из двух документов пары отвергается загрузчиком
 * второго, и перепутать их местами не выйдет даже вызовом руками.
 */
describe('PRES-4: канала влияния нет по построению — загрузчики раздельны', () => {
  it('конфиг сцены загрузчиком парного документа отвергается адресно', () => {
    const rejected = validatePresentationScene(duelScene());
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    // Состав документа закрыт (PRES-2), и поля сим-документа названы поимённо,
    // а не проглочены молча.
    expect(rejected.errors.join('\n')).toMatch(/components: неизвестное поле/);
  });

  it('парный документ загрузчиком конфига сцены не принимается', () => {
    const paired = JSON.parse(
      readFileSync(join(CONTENT_ROOT, presentationPathOf('scenes/duel.scene.json')), 'utf8'),
    ) as unknown;
    // Отказ здесь не оформленный — конфигом сцены этот документ не является ни
    // одним полем, и разбор об этом спотыкается сразу. Пиннится сам факт: путь
    // «парный документ доехал до `worldInit`» не проходим (DET-1, PRES-4).
    expect(() => loadScene(paired as SceneDef)).toThrow();
  });
});

describe('PRES-4: разные парные документы у клиентов одного матча', () => {
  it('хеши входа совпадают, и оба входят в матч (NTR-5)', async () => {
    const scene = duelScene();
    // Пара клиентов ставит контент-пак из ОДНОЙ сцены: парного документа в
    // паке нет вовсе — он не sim-документ, и в канонический контент матча не
    // входит (NET-17, PRES-4).
    const packA = contentPack({ duel: scene });
    const packB = contentPack({ duel: scene });
    expect(packA.hash).toBe(packB.hash);
    expect(packA.hash).toBe(duelConfig({ scene }).version.contentPackHash);

    // У клиентов разные слои: один украсил арену и налил воду, второй — нет.
    const mine = new DecorationSet(decoratedStage());
    const theirs = new DecorationSet(decoratedStage());
    mine.apply(instancesOf(FIXTURE_LAYER));
    theirs.apply([]);
    expect(mine.size).not.toBe(theirs.size);

    // Вода первого клиента ДЕЙСТВИТЕЛЬНО поднята, а не просто лежит в JSON:
    // подсистема собрала тело на сетке (REND-35). У второго клиента секции нет
    // вовсе — и его подсистема не создаёт ничего.
    const withWater = new WaterSubsystem({ grid: waterGrid(), config: WATER_SECTION });
    withWater.init(headlessContext());
    const without = new WaterSubsystem({ grid: waterGrid() });
    without.init(headlessContext());
    expect(withWater.drawnBodies).toHaveLength(1);
    expect(without.drawnBodies).toHaveLength(0);

    const match = await playMatch(16, { a: walkRight(1000) });
    expect(match.a.client.phase).toBe('playing');
    expect(match.b.client.phase).toBe('playing');
    // Симуляция у обоих идентична: мир моста поднят публичным путём клиента и
    // сошёлся с сервером — рассинхронизации от расхождения слоёв нет.
    expect(match.bridge.world.worldInitHash).toBe(match.server.worldInitHash);
    expect(match.config.version.buildId).toBe(BUILD_ID);
    expect(match.bridge.host.view.tick).toBe(match.b.client.latest!.tick);
  });
});

describe('CONT-1: демонстрационный слой лежит в дереве контента и разбирается', () => {
  const scenePath = 'scenes/duel.scene.json';

  it('парный документ дуэли найден правилом имени и валиден (PRES-1, PRES-2)', () => {
    const paired = presentationPathOf(scenePath);
    expect(paired).toBe('scenes/duel.presentation.json');
    const parsed = validatePresentationScene(
      JSON.parse(readFileSync(join(CONTENT_ROOT, paired), 'utf8')),
    );
    expect(parsed.ok ? '' : parsed.errors.join('; ')).toBe('');
  });

  it('каждая его ссылка разрешается в запись манифеста (PRES-2, ASSET-9)', () => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(CONTENT_ROOT, 'visuals/manifest.json'), 'utf8')),
    );
    expect(manifest.ok ? '' : manifest.errors.join('; ')).toBe('');
    const parsed = validatePresentationScene(
      JSON.parse(readFileSync(join(CONTENT_ROOT, presentationPathOf(scenePath)), 'utf8')),
    );
    if (!manifest.ok || !parsed.ok) return;
    for (const record of parsed.scene.decorations) {
      // Пространство визуальных ключей одно, а родов записи два (ASSET-9,
      // ASSET-14): модельный вид рисует подсистема моделей, эмиттерный —
      // подсистема частиц (`rendering` REND-24). Размещение ссылается на оба
      // одним и тем же полем `visual`, поэтому «ссылка разрешается» здесь
      // значит «разрешается хоть одним из двух», а не «моделью».
      const visual =
        resolveVisual(manifest.manifest, record.visual) ??
        resolveVisualEmitter(manifest.manifest, record.visual);
      expect(visual, record.visual).toBeDefined();
    }
  });

  it('каждая ссылка на эмиттерный ассет разрешается в документ эффекта (ASSET-14)', () => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(CONTENT_ROOT, 'visuals/manifest.json'), 'utf8')),
    );
    expect(manifest.ok ? '' : manifest.errors.join('; ')).toBe('');
    if (!manifest.ok) return;
    // Где в манифесте лежат ссылки на ассеты, знает сам манифест (ASSET-6):
    // перечень мест спрашивается у него (`manifestAssetRefs`), а не набирается
    // здесь заново — второй список разошёлся бы с форматом при первом же новом
    // поле, и проверка молча перестала бы видеть часть ссылок. Отбирается вид,
    // который эта проверка умеет разобрать: документ эффекта частиц (ASSET-3).
    const referenced = manifestAssetRefs(manifest.manifest)
      .filter((ref) => ref.kind === 'particle-effect')
      .map((ref) => ref.asset);
    // Демо-контент частиц заведён (задача 3.2): пустой список означал бы, что
    // проверка сторожит несуществующее.
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      const parsed = validateParticleEffect(
        JSON.parse(readFileSync(join(CONTENT_ROOT, id), 'utf8')),
      );
      expect(parsed.ok ? '' : parsed.errors.join('; '), id).toBe('');
    }
  });

  it('конфиг сцены на парный документ не ссылается (PRES-1)', () => {
    const raw = readFileSync(join(CONTENT_ROOT, scenePath), 'utf8');
    expect(raw).not.toContain('presentation');
  });
});

/**
 * Сцена подсистем без графики. Подсистема моделей настоящая и зарегистрирована:
 * набор декораций обязан доехать до неё тем же путём, что в игровом кадре
 * (REND-18) — иначе тест утверждал бы про изоляцию слоя, которого не подняли.
 * Рисовать в headless-прогоне нечем, поэтому контекст — дубль.
 */
function headlessContext(): RenderContext {
  return {
    scene: new THREE.Scene(),
    assets: {
      request: (kind: string, id: string) => ({ kind, id }),
      state: () => ({ status: 'loading' }),
      subscribe: () => () => undefined,
    },
    config: { heightStep: 0.5 },
  } as unknown as RenderContext;
}

function decoratedStage(): PresentationStage {
  return new PresentationStage(headlessContext()).register(
    new ModelsSubsystem({ entities: {} }, { warn: () => undefined }),
  );
}
