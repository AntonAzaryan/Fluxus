/**
 * Документный источник инстансов (REND-11): сведение полного набора с текущим,
 * устойчивость ключа к правке полей, взаимоисключающесть с потоком тиков,
 * отсутствие интерполяции и вырожденный случай превью ассета (`editor` ED-20).
 *
 * Подсистема здесь настоящая: проверяется ровно то, что REND-11 требует от
 * связки «источник → presentation-состояние → подсистема», а не внутренности
 * источника. Продюсеры разводит `PresentationStage` — общая сцена подсистем.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_ONE,
  dispatch,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type Scene,
  type Simulation,
  type System,
} from '@game-mvp/core';
import type { VisualManifest } from '@game-mvp/assets';
import {
  DocumentSource,
  ModelsSubsystem,
  PresentationStage,
  RenderHost,
  kindByTags,
  type DocumentInstance,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeModel, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

function makeManifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        defaultSkin: 'red',
        skins: {
          red: { '0': 'tex/red.png' },
          blue: { '0': 'tex/blue.png' },
        },
        animations: {
          states: { idle: 'Stand', move: 'Walk' },
          events: { EntityDied: 'Death' },
        },
      },
      Tower: { model: 'models/tower.mdx' },
    },
  };
}

interface Rig {
  readonly stage: PresentationStage;
  readonly models: ModelsSubsystem;
  readonly source: DocumentSource;
  readonly ctx: RenderContext;
  readonly assets: AssetsStub;
  /** Кадр документного режима на заданной отметке часов. */
  frame(atMs: number): void;
}

function makeRig(manifest: VisualManifest = makeManifest()): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const models = new ModelsSubsystem(manifest, { warn: () => {} });
  const stage = new PresentationStage(ctx).register(models);
  let now = 0;
  const source = new DocumentSource(stage, { clock: () => now });
  return {
    stage,
    models,
    source,
    ctx,
    assets,
    frame: (atMs) => {
      now = atMs;
      source.frame();
    },
  };
}

/** Инстанс набора: обязательные поля один раз, остальное — правкой. */
function placed(key: string, partial: Partial<DocumentInstance> = {}): DocumentInstance {
  return { key, kind: 'Runner', x: 0, y: 0, ...partial };
}

/** Инстанс подсистемы по ключу документа — путь, которым пользуется picking (ED-17). */
function instanceOf(rig: Rig, key: string): ReturnType<ModelsSubsystem['instanceFor']> {
  const entity = rig.source.entityOf(key);
  return entity === undefined ? null : rig.models.instanceFor(entity);
}

// ------------------------------------------------------- сведение набора

describe('декларативное сведение набора (REND-11)', () => {
  it('новый ключ создаёт инстанс, исчезнувший — убирает, сохранившийся — обновляет', () => {
    const rig = makeRig();

    rig.source.apply([placed('a', { x: 1 }), placed('b', { x: 2 })]);
    expect(rig.ctx.scene.children.length).toBe(2);
    expect(instanceOf(rig, 'a')).not.toBeNull();
    expect(instanceOf(rig, 'b')).not.toBeNull();

    // Полный набор без ключа `b` — и это всё, что потребитель сообщает: вызовов
    // «создай инстанс» и «удали инстанс» у источника нет по построению.
    rig.source.apply([placed('a', { x: 3 }), placed('c', { x: 4 })]);
    expect(rig.ctx.scene.children.length).toBe(2);
    expect(rig.source.entityOf('b')).toBeUndefined();
    expect(instanceOf(rig, 'c')).not.toBeNull();

    rig.frame(16);
    expect(instanceOf(rig, 'a')!.holder.position.x).toBeCloseTo(3, 6);
    expect(instanceOf(rig, 'c')!.holder.position.x).toBeCloseTo(4, 6);
  });

  it('повторное появление ключа создаёт инстанс заново (REND-3 через REND-11)', () => {
    const rig = makeRig();
    rig.source.apply([placed('a')]);
    const first = instanceOf(rig, 'a')!.holder;

    rig.source.apply([]); // удаление либо откат операции авторинга (ED-18)
    expect(rig.source.entityOf('a')).toBeUndefined();
    expect(rig.ctx.scene.children.length).toBe(0);

    rig.source.apply([placed('a')]);
    expect(instanceOf(rig, 'a')!.holder).not.toBe(first);
    expect(rig.ctx.scene.children.length).toBe(1);
  });

  it('пустой набор гасит все инстансы, разделяемый ассет остаётся в кэше (REND-3)', () => {
    const rig = makeRig();
    rig.source.apply([placed('a'), placed('b')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const requestsBefore = rig.assets.requests.filter((r) => r.kind === 'model').length;

    rig.source.clear();
    expect(rig.ctx.scene.children.length).toBe(0);

    rig.source.apply([placed('a')]);
    // Модель не перезапрашивается: кэш разделяемых данных подсистемы жив.
    expect(rig.assets.requests.filter((r) => r.kind === 'model').length).toBe(requestsBefore);
    expect(instanceOf(rig, 'a')!.model).not.toBeNull();
  });

  it('повторяющийся ключ в наборе — ошибка, а не тихая победа последнего (REND-11)', () => {
    const rig = makeRig();
    expect(() => { rig.source.apply([placed('a'), placed('a', { x: 5 })]); }).toThrow(/дважды/);
  });
});

// ------------------------------------- ключ устойчив к правке полей

describe('ключ — идентичность размещённого, а не его поля (REND-11)', () => {
  it('правка позиции, поворота и масштаба обновляет тот же инстанс', () => {
    const rig = makeRig();
    rig.source.apply([placed('a', { x: 1, y: 1 })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());

    const entity = rig.source.entityOf('a');
    const before = rig.models.instanceFor(entity!)!;
    rig.frame(16);

    rig.source.apply([placed('a', { x: 4, y: 5, yaw: Math.PI / 2, scale: 2 })]);
    rig.frame(32);

    const after = rig.models.instanceFor(entity!)!;
    // Тот же ID, тот же holder, тот же инстанс модели: подсистемное состояние
    // (материалы скина REND-6, фаза анимации, сглаженный наклон REND-10) цело.
    expect(rig.source.entityOf('a')).toBe(entity);
    expect(after.holder).toBe(before.holder);
    expect(after.model).toBe(before.model);
    expect(after.controller).toBe(before.controller);
    expect(after.holder.position.x).toBeCloseTo(4, 6);
    expect(after.holder.position.y).toBeCloseTo(5, 6);
    expect(after.holder.scale.x).toBeCloseTo(2, 6);
    expect(rig.ctx.scene.children.length).toBe(1);
  });

  it('смена скина меняет текстуры того же инстанса и не пересоздаёт его (REND-6)', () => {
    const rig = makeRig();
    rig.source.apply([placed('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const before = instanceOf(rig, 'a')!;
    expect(rig.assets.requests).toContainEqual({ kind: 'texture', id: 'tex/red.png' });

    rig.source.apply([placed('a', { skin: 'blue' })]);
    expect(rig.assets.requests).toContainEqual({ kind: 'texture', id: 'tex/blue.png' });
    expect(instanceOf(rig, 'a')!.model).toBe(before.model);

    // Снятие поля возвращает скин записи манифеста, инстанс по-прежнему тот же.
    rig.source.apply([placed('a')]);
    expect(instanceOf(rig, 'a')!.model).toBe(before.model);
  });

  it('смена визуального типа — другая запись манифеста, инстанс строится заново', () => {
    const rig = makeRig();
    rig.source.apply([placed('a')]);
    const before = instanceOf(rig, 'a')!.holder;

    rig.source.apply([placed('a', { kind: 'Tower' })]);
    expect(instanceOf(rig, 'a')!.holder).not.toBe(before);
    // Ключ остался ключом того же размещённого объекта.
    expect(rig.source.entityOf('a')).not.toBeUndefined();
    expect(rig.ctx.scene.children.length).toBe(1);
  });
});

// ------------------------------------------------------------- клип

describe('клип задаётся набором с умолчанием на клип покоя (REND-11)', () => {
  it('без поля играет клип состояния покоя из манифеста', () => {
    const rig = makeRig();
    rig.source.apply([placed('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    expect(instanceOf(rig, 'a')!.controller!.currentClipName).toBe('Stand - 1');
  });

  it('названный клип играет вместо клипа состояния, снятие поля возвращает покой', () => {
    const rig = makeRig();
    rig.source.apply([placed('a', { clip: 'Roll' })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    expect(instanceOf(rig, 'a')!.controller!.currentClipName).toBe('Roll');

    rig.source.apply([placed('a', { clip: 'Jump Loop' })]);
    expect(instanceOf(rig, 'a')!.controller!.currentClipName).toBe('Jump Loop');

    rig.source.apply([placed('a')]);
    expect(instanceOf(rig, 'a')!.controller!.currentClipName).toBe('Stand - 1');
  });
});

// ------------------------------------------- чего в документном режиме нет

describe('производного от TickResult в документном режиме нет (REND-11)', () => {
  it('поза ровно документная: интерполяции между обновлениями нет (REND-2 не применяется)', () => {
    const rig = makeRig();
    rig.source.apply([placed('a', { x: 0 })]);
    rig.frame(16);
    expect(instanceOf(rig, 'a')!.holder.position.x).toBeCloseTo(0, 6);

    rig.source.apply([placed('a', { x: 10, yaw: 1 })]);
    // Первый же кадр после правки — в новой позе целиком, без «доезжания».
    rig.frame(32);
    const holder = instanceOf(rig, 'a')!.holder;
    expect(holder.position.x).toBeCloseTo(10, 6);
    expect(holder.rotation.z).toBeCloseTo(1, 6);
  });

  it('в наборе нет событий тика: one-shot клипы и цель доворота костей отсутствуют', () => {
    const rig = makeRig();
    rig.source.apply([placed('a')]);
    expect(rig.source.view.events.length).toBe(0);
    expect(rig.source.view.freshEvents).toBe(false);
    const view = rig.source.view.entities.get(rig.source.entityOf('a')!)!;
    expect(view.aimYaw).toBeNull();
    expect(view.snap).toBe(true);
  });
});

// ----------------------------------------- взаимоисключающесть продюсеров

describe('продюсеры взаимоисключающи (REND-11)', () => {
  function makeSim(): { scene: Scene; sim: Simulation } {
    const scene = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [{ name: 'Runner', components: { Position: {} }, tags: ['Runner'] }],
      terrain: { width: 2, height: 2, tileSize: FIXED_ONE, levels: ['00', '00'], flags: ['..', '..'] },
    });
    const idle: System = { name: 'Idle', order: 10, run: () => {} };
    scene.systems.register(idle);
    return {
      scene,
      sim: {
        systems: scene.systems,
        worldSeed: 7,
        math: mathApi,
        ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
      },
    };
  }

  it('вход в превью убирает документные инстансы, выход — снапшотные; удвоения нет (ED-9)', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const models = new ModelsSubsystem(makeManifest(), { warn: () => {} });
    const stage = new PresentationStage(ctx).register(models);

    const { scene, sim } = makeSim();
    worldInitSpawn(scene.world, 'Runner', {
      Position: { x: fixed.fromFloat(0.5), y: fixed.fromFloat(0.5) },
    });
    const state = initialState(scene.world, 7);
    const now = 0;
    const host = new RenderHost(ctx, {
      tickSeconds: 0.05,
      kindOf: kindByTags(['Runner']),
      stage,
      clock: () => now,
    });
    const source = new DocumentSource(stage, { clock: () => now });

    // Режим правки: в кадре один объект — документный.
    source.apply([placed('a', { x: 0.5, y: 0.5 })]);
    expect(stage.activeProducer).toBe(source);
    expect(ctx.scene.children.length).toBe(1);
    const documentHolder = ctx.scene.children[0]!;

    // Запуск превью над той же сценой: тот же объект приезжает снапшотом.
    dispatch(tick(sim, state), [host]);
    expect(stage.activeProducer).toBe(host);
    // Один инстанс, а не два: набор документа погашен входом потока тиков.
    expect(ctx.scene.children.length).toBe(1);
    expect(documentHolder.parent).toBeNull();
    const snapshotHolder = ctx.scene.children[0]!;
    expect(snapshotHolder).not.toBe(documentHolder);

    // Выход из превью: набор документа снова наполняет presentation-состояние.
    source.apply([placed('a', { x: 0.5, y: 0.5 })]);
    expect(stage.activeProducer).toBe(source);
    expect(ctx.scene.children.length).toBe(1);
    expect(snapshotHolder.parent).toBeNull();
    expect(ctx.scene.children[0]).not.toBe(snapshotHolder);
  });

  it('кадр рисует только активный продюсер: оставшийся цикл неактивного молчит', () => {
    const rig = makeRig();
    const frames: number[] = [];
    rig.stage.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (_dt, alpha) => frames.push(alpha),
    });

    rig.source.apply([placed('a')]);
    rig.frame(16);
    expect(frames.length).toBe(1);
    // Альфа документного режима — всегда 1: интерполировать нечего.
    expect(frames[0]).toBe(1);

    // Другой продюсер забрал состояние — кадры документного источника молчат.
    const other = new DocumentSource(rig.stage);
    other.apply([placed('b')]);
    rig.frame(32);
    expect(frames.length).toBe(1);
  });

  it('detach гасит набор, и ничью сцену не рисует никто', () => {
    const rig = makeRig();
    const frames: number[] = [];
    rig.stage.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: () => frames.push(1),
    });

    rig.source.apply([placed('a')]);
    rig.frame(16);
    expect(frames.length).toBe(1);
    expect(rig.ctx.scene.children.length).toBe(1);

    // Продюсер ушёл, не передав состояние: инстансы убраны штатным правилом
    // REND-3, сцена ничья.
    rig.stage.detach(rig.source);
    expect(rig.stage.activeProducer).toBeNull();
    expect(rig.ctx.scene.children.length).toBe(0);

    // Оставшийся цикл кадров ушедшего подсистем не трогает: иначе на ничьей
    // сцене два продюсера гнали бы `updateFrame` по разу каждый.
    rig.frame(32);
    expect(frames.length).toBe(1);

    // Возврат — обычный publish.
    rig.source.apply([placed('a')]);
    rig.frame(48);
    expect(frames.length).toBe(2);
    expect(rig.ctx.scene.children.length).toBe(1);
  });
});

// ------------------------------------------------ превью ассета (ED-20)

describe('превью ассета — вырожденный набор из одного инстанса (REND-11, ED-20)', () => {
  it('рисуется тем же путём, без сцены и террейна', () => {
    const rig = makeRig();

    rig.source.apply([placed('only', { clip: 'Walk Fast' })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());

    expect(rig.source.size).toBe(1);
    // В сцене один holder: ни террейна, ни чего-либо ещё документный режим не
    // добавляет — подсистема террейна тут просто не зарегистрирована.
    expect(rig.ctx.scene.children.length).toBe(1);
    const instance = instanceOf(rig, 'only')!;
    expect(instance.model).not.toBeNull();
    expect(instance.controller!.currentClipName).toBe('Walk Fast');

    rig.frame(16);
    expect(instance.holder.position.x).toBeCloseTo(0, 6);

    // Смена клипа в просмотрщике — та же правка набора, инстанс тот же.
    rig.source.apply([placed('only', { clip: 'Roll' })]);
    expect(instanceOf(rig, 'only')!.model).toBe(instance.model);
    expect(instance.controller!.currentClipName).toBe('Roll');
  });
});
