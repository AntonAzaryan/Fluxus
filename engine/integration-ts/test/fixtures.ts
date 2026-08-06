/**
 * Фикстуры интеграционной суиты (CLI-9): вертикаль «сервер → снапшот →
 * клиент → рендер-хост» собирается ЗАНОВО из публичных поверхностей пакетов —
 * без импорта чужих `test/`. Это одновременно требование CLI-9 и проверка
 * того, что публичного API достаточно для сборки цепочки.
 *
 * Сцена повторяет net-фикстуру дуэли (и golden-сценарий `input-drive` ядра):
 * поведение уже зафиксировано эталонами, поэтому расхождение в вертикали
 * указывает на шов, а не на сомнительную сцену.
 */
import * as THREE from 'three';
import {
  XorShift128Stream,
  contentPackHash,
  fixed,
  restoreSnapshot,
  seedStateFromName,
  type ChangeSet,
  type EntityId,
  type SceneDef,
  type Snapshot,
} from '@game-mvp/core';
import {
  ClientHost,
  LoopbackHub,
  MatchClient,
  MatchHost,
  MatchServer,
  buildMatchWorld,
  contentPack,
  type InputSample,
  type InputSource,
  type MatchConfig,
  type MatchWorld,
} from '@game-mvp/net';
import { AssetService } from '@game-mvp/assets';
import {
  RenderHost,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '@game-mvp/render';

export const BUILD_ID = 'integration-build-0001';
export const TICK_RATE = 60;

/** Один шаг вправо в Q16.16 — движение, заметное в снапшоте и в меше. */
export const STEP: number = fixed.fromInt(1);
/** Смещение за тик: `Movement` кладёт `Velocity = move × 5243`, физика интегрирует. */
export const TICK_DELTA: number = fixed.mul(STEP, 5243);

export function duelScene(): SceneDef {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
      {
        name: 'Collider',
        fields: {
          blockMask: 'i32',
          cliffRise: 'i32',
          halfX: 'fixed',
          halfY: 'fixed',
          hitMask: 'i32',
          layer: 'i32',
          radius: 'fixed',
          shape: 'i32',
        },
      },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
          Velocity: { x: 0, y: 0 },
          // Маски нулевые: в вертикали герои не блокируются ничем (PHYS-2),
          // как и до появления масок, когда тега блокировки на них не было.
          Collider: {
            blockMask: 0,
            cliffRise: 0,
            halfX: 19661,
            halfY: 19661,
            hitMask: 0,
            layer: 0,
            radius: 19661,
            shape: 0,
          },
        },
        tags: ['Hero'],
      },
    ],
    systems: [
      // Конвейер движения — как в `content/scenes/duel.scene.json`: система
      // сцены кладёт скорость, интегрирует её физика из конфига матча (NTR-14).
      {
        name: 'Movement',
        order: 10,
        query: { all: ['Velocity', 'Input'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Velocity',
              values: {
                x: { '*': [{ getComponent: [{ var: 'e' }, 'Input', 'moveX'] }, 5243] },
                y: { '*': [{ getComponent: [{ var: 'e' }, 'Input', 'moveY'] }, 5243] },
              },
            },
          },
        ],
      },
    ],
    capacity: 8,
  };
}

export function duelConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  const scene = overrides.scene ?? duelScene();
  return {
    version: { buildId: BUILD_ID, contentPackHash: contentPackHash(scene) },
    players: ['p1', 'p2'],
    seed: 424242,
    sceneRef: 'duel',
    scene,
    initial: [{ prefab: 'Hero' }, { prefab: 'Hero', overrides: { Player: { slot: 1 } } }],
    // Зависимость сборки мира (NTR-14): без физики Velocity никто не интегрирует.
    physics: {},
    tickRate: TICK_RATE,
    // Снапшот каждый тик: интерполяция рендера идёт между соседними тиками,
    // и её ожидание в тесте считается без поправки на прореживание.
    snapshotRate: TICK_RATE,
    inputDelay: 2,
    ...overrides,
  };
}

/** Доставка в loopback асинхронная (NTR-2), поэтому шаг цикла заканчивается тут. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface Clock {
  ms: number;
}

export interface ConnectedClient {
  readonly client: MatchClient;
  readonly host: ClientHost;
}

export function connectClient(
  hub: LoopbackHub,
  playerId: string,
  clock: Clock,
  scene: SceneDef,
  input?: InputSource,
): ConnectedClient {
  const pack = contentPack({ duel: scene });
  const client = new MatchClient({
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
  });
  const host = new ClientHost(client, hub.connect(), {
    now: () => clock.ms,
    ...(input !== undefined ? { input } : {}),
  });
  host.start();
  return { client, host };
}

export interface Harness {
  readonly hub: LoopbackHub;
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly clock: Clock;
  readonly config: MatchConfig;
}

export function harness(config: MatchConfig = duelConfig()): Harness {
  const hub = new LoopbackHub();
  const server = new MatchServer(config);
  return { hub, server, host: new MatchHost(server, hub), clock: { ms: 0 }, config };
}

// ------------------------------------------------------------- рендер-мост

const EMPTY_ENTITIES: ReadonlySet<EntityId> = new Set();

/**
 * Снапшот не несёт дельт dirty-tracking'а — мост честно объявляет «изменения
 * неизвестны». Для сцены без террейна `RenderHost` дельты и не читает.
 */
const NO_CHANGES: ChangeSet = {
  isEmpty: true,
  changedEntities: () => EMPTY_ENTITIES,
};

/**
 * Подсистема-потребитель вертикали: по объекту THREE на сущность, позиция —
 * интерполяция между двумя последними тиками (REND-2), snap — без неё.
 * Написана через публичный контракт `RenderSubsystem` — ровно так, как её
 * писал бы внешний потребитель рендера.
 */
export class PositionsSubsystem implements RenderSubsystem {
  readonly name = 'positions';
  readonly objects = new Map<EntityId, THREE.Object3D>();
  private ctx: RenderContext | null = null;
  private view: TickView | null = null;

  init(ctx: RenderContext): void {
    this.ctx = ctx;
  }

  syncTick(view: TickView): void {
    this.view = view;
    for (const id of view.entities.keys()) {
      if (this.objects.has(id)) continue;
      const object = new THREE.Object3D();
      this.ctx!.scene.add(object);
      this.objects.set(id, object);
    }
    for (const [id, object] of this.objects) {
      if (view.entities.has(id)) continue;
      this.ctx!.scene.remove(object);
      this.objects.delete(id);
    }
  }

  updateFrame(_dt: number, alpha: number): void {
    if (this.view === null) return;
    for (const [id, entity] of this.view.entities) {
      const object = this.objects.get(id);
      if (object === undefined) continue;
      const a = entity.snap || this.view.snapAll ? 1 : alpha;
      object.position.set(
        entity.prevX + (entity.currX - entity.prevX) * a,
        0,
        entity.prevY + (entity.currY - entity.prevY) * a,
      );
    }
  }
}

/**
 * Мост net → render: локальный мир, поднятый из того же контента, что у
 * сервера (buildMatchWorld — публичный путь клиента), принимает снапшоты
 * через `restoreSnapshot` и скармливает их `RenderHost.onTick` как TickResult.
 */
export class RenderBridge {
  readonly world: MatchWorld;
  readonly scene: THREE.Scene;
  readonly host: RenderHost;
  readonly positions: PositionsSubsystem;
  private lastTick = -1;

  constructor(sceneDef: SceneDef, config: MatchConfig, clock: Clock) {
    this.world = buildMatchWorld({
      scene: sceneDef,
      players: config.players,
      seed: config.seed,
      initial: config.initial,
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.locomotion !== undefined ? { locomotion: config.locomotion } : {}),
    });
    this.scene = new THREE.Scene();
    // Ассеты вертикали не нужны: подсистема позиций их не читает; источник —
    // заглушка, падающая при первом же обращении, чтобы это оставалось правдой.
    const assets = new AssetService({
      read: () => Promise.reject(new Error('интеграционная вертикаль не читает ассетов')),
    });
    const context: RenderContext = { scene: this.scene, assets, config: { heightStep: 1 } };
    this.host = new RenderHost(context, {
      tickSeconds: 1 / TICK_RATE,
      kindOf: () => 'hero',
      clock: () => clock.ms,
    });
    this.positions = new PositionsSubsystem();
    this.host.register(this.positions);
  }

  /** Применяет свежий снапшот; повторный тик игнорируется, как в NTR-10. */
  apply(snapshot: Snapshot): void {
    if (snapshot.tick === this.lastTick) return;
    restoreSnapshot(this.world.state, snapshot);
    this.host.onTick({
      state: this.world.state,
      tick: snapshot.tick,
      mode: this.world.state.mode,
      isReplay: false,
      events: this.world.state.events,
      changes: NO_CHANGES,
    });
    this.lastTick = snapshot.tick;
  }
}

/** Непрерывный шаг вправо до тика включительно — самый читаемый детерминированный ввод. */
export function walkRight(untilTick: number): InputSource {
  return (tick) =>
    tick <= untilTick ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined;
}

// ------------------------------------------------------------------- фазз

/**
 * Детерминированный поток ввода от seed: генератор — публичный xorshift ядра,
 * кадры предвычислены, поэтому повторный вызов на том же тике даёт тот же кадр.
 */
export function fuzzInput(worldSeed: number, streamName: string, ticks: number): InputSource {
  const rng = new XorShift128Stream(seedStateFromName(worldSeed, streamName));
  const frames: InputSample[] = [];
  for (let i = 0; i < ticks; i++) {
    frames.push({
      move: {
        x: (rng.nextBelow(3) - 1) * STEP,
        y: (rng.nextBelow(3) - 1) * STEP,
      },
      aimDir: 0,
      buttons: rng.nextBelow(8) === 0 ? 1 : 0,
    });
  }
  return (tick) => frames[tick];
}

export interface PlayedMatch extends Harness {
  readonly a: ConnectedClient;
  readonly b: ConnectedClient;
  readonly bridge: RenderBridge;
}

/**
 * Полный матч на N тиков: сервер, два клиента, мост рендера на стороне b.
 * Ручные шаги и loopback — без сокетов и таймеров (NTR-12).
 */
export async function playMatch(
  ticks: number,
  inputs: { a?: InputSource; b?: InputSource } = {},
  config: MatchConfig = duelConfig(),
): Promise<PlayedMatch> {
  const fixture = harness(config);
  const scene = config.scene;
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, inputs.a);
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, inputs.b);
  const bridge = new RenderBridge(scene, config, fixture.clock);
  await settle();

  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
    const latest = b.client.latest;
    if (latest !== undefined) bridge.apply(latest);
  }
  return { ...fixture, a, b, bridge };
}
