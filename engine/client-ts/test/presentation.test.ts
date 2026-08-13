/**
 * Продюсеры presentation-состояния в воркер-сборке (REND-11 поверх SHELL-1..7).
 *
 * `RemoteHost` — main-сторона потока тиков, то есть ровно то, чем редактор
 * прогоняет превью (`editor` ED-9). Подсистемы у вьюпорта и у превью общие,
 * поэтому сцена подсистем передаётся хосту снаружи, а разводит продюсеров
 * `PresentationStage` — та же общая часть, что у однопоточного `RenderHost`.
 *
 * Подсистема здесь настоящая (`ModelsSubsystem`): проверяется связка
 * «продюсер → presentation-состояние → инстансы в сцене», а не внутренности
 * хоста. Ассеты — стаб, вечно `loading`: инстансы остаются заглушками, но
 * запрос модели по записи манифеста виден, а он и отличает пересозданный
 * инстанс от молча переиспользованного.
 *
 * Игровая сборка сцену не передаёт: второго продюсера в ней нет, хост заводит
 * свою — и ведёт себя ровно как до появления параметра.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tick, type EntityId } from '@game-mvp/core';
import type { AssetService, VisualManifest } from '@game-mvp/assets';
import {
  DocumentSource,
  ModelsSubsystem,
  PresentationStage,
  ViewBuffer,
  type DocumentInstance,
  type RenderContext,
  type RenderSubsystem,
} from '@game-mvp/render';
import { RemoteHost, WorkerShell, type ShellPort } from '../src/index.js';
import {
  PLAYER_ID,
  TICK_SECONDS,
  makeExtractor,
  makeRig,
  syncPortPair,
} from './fixtures.js';

const HERO_MODEL = 'models/hero.mdx';
const DOC_MODEL = 'models/doc.mdx';

/** Манифест: у документного типа и у типа из снапшота модели разные (ASSET-6). */
function makeManifest(): VisualManifest {
  return {
    entities: {
      Hero: { model: HERO_MODEL },
      Doc: { model: DOC_MODEL },
    },
  };
}

/** Стаб AssetService: всё вечно `loading`, запросы копятся как `kind:id`. */
function makeAssetsStub(): { readonly service: AssetService; readonly requests: string[] } {
  const requests: string[] = [];
  const service = {
    registerLoader(): void {},
    request(kind: string, id: string) {
      requests.push(`${kind}:${id}`);
      return { kind, id };
    },
    state() {
      return { status: 'loading' };
    },
    subscribe(_handle: unknown, cb: (state: { status: string }) => void) {
      cb({ status: 'loading' });
      return () => {};
    },
    retry(): void {},
  } as unknown as AssetService;
  return { service, requests };
}

/** Подсистема-зонд: считает вызовы, чтобы видеть, кто ведёт кадр и тик. */
function probe(): { subsystem: RenderSubsystem; ticks: number; frames: number } {
  const counters = { ticks: 0, frames: 0 };
  return {
    get ticks() {
      return counters.ticks;
    },
    get frames() {
      return counters.frames;
    },
    subsystem: {
      name: 'probe',
      init: () => {},
      syncTick: () => {
        counters.ticks++;
      },
      updateFrame: () => {
        counters.frames++;
      },
    },
  };
}

/**
 * ID героя в presentation-состоянии — на отдельном прогоне той же фикстуры:
 * нумерация сущностей мира детерминирована, и знать её надо ДО того, как
 * документный набор займёт те же числа (в этом весь смысл сценария).
 */
function heroEntityId(): EntityId {
  const rig = makeRig();
  const buffer = new ViewBuffer({ tickSeconds: TICK_SECONDS, clock: () => 0 });
  buffer.apply(makeExtractor(rig).extract(tick(rig.sim, rig.state)));
  const first = [...buffer.view.entities.keys()][0];
  if (first === undefined) throw new Error('фикстура: в presentation-состоянии нет сущностей');
  return first;
}

interface Harness {
  readonly scene: THREE.Scene;
  readonly stage: PresentationStage;
  readonly models: ModelsSubsystem;
  readonly remote: RemoteHost;
  readonly requests: string[];
  /** Типы сообщений, ушедших из главного потока в воркер (SHELL-6). */
  readonly posted: string[];
  /** Тик воркера с немедленной синхронной доставкой в главный поток. */
  step(): void;
}

/**
 * Воркер-сборка на синхронных портах. `shared` — сцена подсистем заведена
 * снаружи, как её заводит редактор (подсистемы регистрируются в ней, а не в
 * хосте); иначе хост заводит свою, а подсистемы приходят по handshake, как в
 * демо игрового клиента.
 */
function makeHarness(options: { shared?: boolean } = {}): Harness {
  const rig = makeRig();
  const assets = makeAssetsStub();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 1 } };
  const models = new ModelsSubsystem(makeManifest(), { warn: () => {} });
  const stage = options.shared === true ? new PresentationStage(ctx).register(models) : undefined;

  const [workerPort, rawMainPort] = syncPortPair();
  const posted: string[] = [];
  const mainPort: ShellPort = {
    post(message, transfer) {
      posted.push((message as { t: string }).t);
      rawMainPort.post(message, transfer);
    },
    onMessage(handler) {
      rawMainPort.onMessage(handler);
    },
  };

  const remote = new RemoteHost(ctx, {
    clock: () => 0,
    ...(stage !== undefined ? { stage } : {}),
    // Своя сцена наполняется как в демо — регистрацией по handshake (SHELL-5).
    ...(stage === undefined ? { onReady: () => remote.register(models) } : {}),
  }).connect(mainPort);

  const shell = new WorkerShell({
    mode: 'local',
    port: workerPort,
    sim: rig.sim,
    state: rig.state,
    tickSeconds: TICK_SECONDS,
    extractor: makeExtractor(rig),
    playerId: PLAYER_ID,
    clock: () => 0,
  });
  shell.start();
  shell.stop();

  return {
    scene,
    stage: remote.stage,
    models,
    remote,
    requests: assets.requests,
    posted,
    step: () => { shell.stepTick(); },
  };
}

/** Набор документа: `count` инстансов, ID которых источник раздаёт по порядку. */
function documentSet(count: number): DocumentInstance[] {
  const instances: DocumentInstance[] = [];
  for (let i = 0; i < count; i++) instances.push({ key: `d${i}`, kind: 'Doc', x: i, y: 0 });
  return instances;
}

describe('превью над сценой редактора: продюсеры взаимоисключающи (REND-11, ED-9)', () => {
  it('вход в превью гасит документные инстансы, выход — снапшотные; удвоения нет', () => {
    const hero = heroEntityId();
    // Сцену подсистем заводит редактор и регистрирует подсистемы в ней, а не в
    // хосте: превью и вьюпорт кормят одни и те же подсистемы.
    const rig = makeHarness({ shared: true });
    const stage = rig.stage;
    const source = new DocumentSource(stage, { clock: () => 0 });

    // Режим правки. Нумерация набора — собственная, от 1, и с ID сущностей
    // мира она пересекается: ID героя занят документным инстансом, а
    // остальные документные ID сущностям мира не соответствуют вовсе.
    const documents = documentSet(hero + 2);
    source.apply(documents);
    expect(stage.activeProducer).toBe(source);
    expect(rig.scene.children).toHaveLength(documents.length);
    const documentKeys = documents.map((doc) => source.entityOf(doc.key)!);
    const collidingInstance = rig.models.instanceFor(hero)!;
    expect(rig.requests).toContain(`model:${DOC_MODEL}`);
    expect(rig.requests).not.toContain(`model:${HERO_MODEL}`);

    // Запуск превью: доставка тика — публикация потоком тиков.
    rig.step();
    expect(stage.activeProducer).toBe(rig.remote);
    // В кадре одна сущность мира, а не она же плюс набор документа.
    expect(rig.scene.children).toHaveLength(1);
    // Инстансы набора убраны штатным правилом REND-3: подсистема их больше не
    // знает — узла сцены для проверки контракт не отдаёт (REND-3). ID героя из
    // проверки исключён: его занимает сущность мира, и он проверяется ниже.
    for (const entity of documentKeys) {
      if (entity === hero) continue;
      expect(rig.models.instanceFor(entity)).toBeNull();
    }

    // Сущность мира с ID документного инстанса — другая запись манифеста, и
    // инстанс собран заново: без гашения набора инстанс документа достался бы
    // сущности мира молча, и в кадре под ней стояла бы документная модель.
    const heroInstance = rig.models.instanceFor(hero)!;
    expect(heroInstance).not.toBe(collidingInstance);
    expect(rig.requests).toContain(`model:${HERO_MODEL}`);

    // Выход из превью: набор документа снова наполняет presentation-состояние.
    source.apply(documents);
    expect(stage.activeProducer).toBe(source);
    expect(rig.scene.children).toHaveLength(documents.length);
    // Инстанс сущности мира убран, а на его номере снова документный — другой.
    expect(rig.models.instanceFor(hero)).not.toBe(heroInstance);

    // Смена продюсера и кадры обратного канала не трогают (SHELL-6, ED-13):
    // из главного потока в воркер за весь сценарий ушёл только возврат буфера.
    expect(new Set(rig.posted)).toEqual(new Set(['ret']));
  });

  it('кадр рисует активный продюсер: цикл кадров превью молчит в режиме правки', () => {
    const rig = makeHarness({ shared: true });
    const stage = rig.stage;
    const counters = probe();
    stage.register(counters.subsystem);
    const source = new DocumentSource(stage, { clock: () => 0 });

    // Поток тиков ведёт и тик, и кадр.
    rig.step();
    rig.remote.frame(100);
    expect(counters.ticks).toBe(1);
    expect(counters.frames).toBe(1);

    // Состояние забрал документный источник: оставшийся цикл кадров превью
    // подсистем не трогает — иначе dt сглаживаний удваивался бы.
    source.apply([{ key: 'a', kind: 'Doc', x: 0, y: 0 }]);
    expect(counters.ticks).toBe(3); // гашение набора превью + публикация набора
    rig.remote.frame(200);
    expect(counters.frames).toBe(1);

    // Возврат в превью — обычная доставка тика.
    rig.step();
    rig.remote.frame(300);
    expect(counters.frames).toBe(2);
  });

  it('detach превью гасит его инстансы: вьюпорту остаётся ничья сцена', () => {
    const rig = makeHarness({ shared: true });
    const stage = rig.stage;

    rig.step();
    expect(rig.scene.children).toHaveLength(1);

    // Runner превью остановлен, документы ещё не опубликованы: инстансы
    // снапшота убраны штатным правилом REND-3, сцена ничья.
    stage.detach(rig.remote);
    expect(stage.activeProducer).toBeNull();
    expect(rig.scene.children).toHaveLength(0);
    rig.remote.frame(100);
    expect(stage.activeProducer).toBeNull();
  });
});

describe('игровая сборка без сцены редактора ведёт себя как прежде (SHELL-2)', () => {
  it('подсистемы регистрируются в хосте, получают тик и кадр', () => {
    const rig = makeHarness();
    const counters = probe();
    rig.remote.register(counters.subsystem);

    rig.step();
    expect(counters.ticks).toBe(1);
    expect(rig.remote.view!.tick).toBe(1);
    // Кадр рисуется: единственный продюсер своей сцены — сам хост.
    rig.remote.frame(100);
    expect(counters.frames).toBe(1);

    rig.step();
    rig.remote.frame(200);
    expect(counters.ticks).toBe(2);
    expect(counters.frames).toBe(2);
    // Инстансы моделей — из снапшота и только из них.
    expect(rig.scene.children).toHaveLength(1);
  });

  it('до первой доставки кадр молчит, как и раньше', () => {
    const rig = makeHarness();
    const counters = probe();
    rig.remote.register(counters.subsystem);

    rig.remote.frame(100);
    expect(counters.frames).toBe(0);
  });

  it('чужой документный источник на своей сцене игровому хосту не мешает', () => {
    const rig = makeHarness();
    const counters = probe();
    rig.remote.register(counters.subsystem);
    // Сцена хоста — его собственная: продюсер другой сцены её не занимает.
    const otherStage = new PresentationStage({} as RenderContext);
    const other = new DocumentSource(otherStage, { clock: () => 0 });
    other.apply([{ key: 'a', kind: 'Doc', x: 0, y: 0 }]);

    rig.step();
    rig.remote.frame(100);
    expect(rig.remote.stage).not.toBe(otherStage);
    expect(counters.ticks).toBe(1);
    expect(counters.frames).toBe(1);
  });
});
