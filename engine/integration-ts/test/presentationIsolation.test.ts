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
  loadScene,
  runScenario,
  runScenarioBytes,
  type SceneDef,
} from '@game-mvp/core';
import { contentPack } from '@game-mvp/net';
import {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_CONFIG_PARAMS,
  CameraRig,
  DecorationSet,
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  cameraConfigFromManifest,
  createCameraInput,
  type DecorationInstance,
  type RenderContext,
} from '@game-mvp/render';
import {
  presentationPathOf,
  resolveVisual,
  resolveVisualEmitter,
  validateManifest,
  validateParticleEffect,
  validatePresentationScene,
  type PresentationLighting,
  type PresentationScene,
} from '@game-mvp/assets';
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

    const still = runBeside(STILL);
    const cycled = runBeside(CYCLED);

    // Цикл действительно шёл: свет за круг менял и тон, и интенсивность.
    expect(new Set(cycled.light).size).toBeGreaterThan(1);
    // Сцена без подсекции стоит на месте — «никакой новой покадровой работы».
    expect(new Set(still.light).size).toBe(1);
    // А симуляция обоих прогонов побитово одна: сравниваются БАЙТЫ документа
    // прогона, а не разобранные снапшоты (SER-6).
    expect(Buffer.from(cycled.bytes).equals(Buffer.from(still.bytes))).toBe(true);
    expect(runScenario(scenario(scene)).worldInitHash).toBe(before.init);
    expect(contentPackHash(scene)).toBe(before.pack);
  });

  it('любая точка круга даёт тот же прогон: входа в симуляцию у цикла нет', () => {
    const scene = duelScene();
    const bare = runScenarioBytes(scenario(scene));
    const parsed = validatePresentationScene({ decorations: [], lighting: CYCLED });
    expect(parsed.ok ? '' : parsed.errors.join('; ')).toBe('');
    if (!parsed.ok) return;

    const lighting = new LightingSubsystem({ config: parsed.scene.lighting });
    lighting.init({
      scene: new THREE.Scene(),
      assets: {} as unknown as RenderContext['assets'],
      config: { heightStep: 0.5 },
    });
    // Установившаяся фаза, кадр перехода, следующая фаза — прогон снимается в
    // каждой из этих точек круга.
    for (const seconds of [4, 5, 6]) {
      lighting.updateFrame(1 / 60, 0, seconds);
      expect(Buffer.from(runScenarioBytes(scenario(scene))).equals(Buffer.from(bare))).toBe(true);
    }
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

    // У клиентов разные слои: один украсил арену, второй — нет.
    const mine = new DecorationSet(decoratedStage());
    const theirs = new DecorationSet(decoratedStage());
    mine.apply(instancesOf(FIXTURE_LAYER));
    theirs.apply([]);
    expect(mine.size).not.toBe(theirs.size);

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
    const { particles, decorations } = manifest.manifest;
    const referenced = [
      ...Object.values(particles?.byKind ?? {}).map((r) => r.effect),
      ...Object.values(particles?.byState ?? {}).map((r) => r.effect),
      ...Object.values(particles?.byEvent ?? {}).map((r) => r.effect),
      ...Object.keys(decorations ?? {})
        .map((key) => resolveVisualEmitter(manifest.manifest, key)?.effect)
        .filter((id): id is string => id !== undefined),
    ];
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
function decoratedStage(): PresentationStage {
  const context = {
    scene: { add: () => undefined, remove: () => undefined },
    assets: {
      request: (kind: string, id: string) => ({ kind, id }),
      state: () => ({ status: 'loading' }),
      subscribe: () => () => undefined,
    },
    config: { heightStep: 0.5 },
  } as unknown as RenderContext;
  return new PresentationStage(context).register(
    new ModelsSubsystem({ entities: {} }, { warn: () => undefined }),
  );
}
