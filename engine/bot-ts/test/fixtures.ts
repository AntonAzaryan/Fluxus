/**
 * Фикстуры тестов бота: матч на внутрипроцессном транспорте (NTR-2) с
 * произвольной смесью людей и ботов.
 *
 * Сцена собрана здесь же и повторяет дуэль сетевых тестов: поведение движения
 * уже зафиксировано эталонами, поэтому расхождение в тесте бота указывает на
 * бота, а не на сомнительную сцену. Контентом эти фикстуры не являются (CONT-4)
 * и в `content/` не переезжают.
 */
import {
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_SLOT_COMPONENT,
  NO_PHASE,
  contentPackHash,
  fixed,
  type SceneDef,
} from '@fluxus/core';
import {
  ClientHost,
  LoopbackHub,
  MatchClient,
  MatchHost,
  MatchServer,
  contentPack,
  type ClientStep,
  type ConnectionRole,
  type InputSource,
  type MatchConfig,
  type Transport,
} from '@fluxus/net';
import type { FillSchedule } from '../src/fill.js';
import { BotHost, type BotSeat } from '../src/host.js';
import {
  BOT_BEHAVIOR_SCHEMA,
  type BotBehaviorDocument,
  type BotConsideration,
  type BotCurve,
} from '../src/behavior.js';
import type { BotBrainFactory } from '../src/brain.js';
import { BOT_PROFILE_SCHEMA, type BotProfile } from '../src/profile.js';
import { botTerrain, type BotTerrain } from '../src/terrainView.js';

export const BUILD_ID = 'bot-build-0001';
export const TICK_RATE = 60;
export const STEP: number = fixed.fromInt(1);

/** Арена сцены (ARENA-1): центр живёт в ассете, а не в компоненте. */
export interface ArenaSpec {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}

const DEFAULT_ARENA: ArenaSpec = { centerX: 0, centerY: 0, radius: 20 };

export function duelScene(arena: ArenaSpec = DEFAULT_ARENA): SceneDef {
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
          // Маски нулевые: в фикстуре никто никого не блокирует (PHYS-2) —
          // предмет тестов бот, а не разрешение столкновений.
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
      {
        // Снаряд: летит сам (физика интегрирует `Velocity`), слота игрока не
        // имеет — для восприятия бота это угроза, которую он экстраполирует.
        name: 'Bolt',
        components: {
          Position: { x: 0, y: 0 },
          Velocity: { x: 0, y: 0 },
          Collider: {
            blockMask: 0,
            cliffRise: 0,
            halfX: 6553,
            halfY: 6553,
            hitMask: 0,
            layer: 0,
            radius: 6553,
            shape: 0,
          },
        },
        tags: ['Bolt'],
      },
    ],
    systems: [
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
    arena: {
      center: { x: fixed.fromInt(arena.centerX), y: fixed.fromInt(arena.centerY) },
      radius: fixed.fromInt(arena.radius),
    },
    capacity: 16,
  };
}

/**
 * Дуэль с туманом войны: радиус обзора мал намеренно — ушедший в сторону
 * противник покидает персональный снапшот за десяток тиков, и «враг в тумане»
 * (BOT-3) наблюдается внутри короткого матча.
 */
function fogScene(visionRadius = 1): SceneDef {
  const scene = duelScene();
  const hero = scene.prefabs![0]!;
  return {
    ...scene,
    prefabs: [
      {
        ...hero,
        components: {
          ...hero.components,
          Vision: { radius: fixed.fromInt(visionRadius) },
          Visibility: { visibleTo: 0 },
          Team: { id: 0 },
          Stealth: { active: 0 },
        },
      },
    ],
    fog: true,
    terrain: {
      width: 8,
      height: 8,
      tileSize: fixed.fromInt(1),
      levels: Array.from({ length: 8 }, () => '00000000'),
      flags: Array.from({ length: 8 }, () => '........'),
    },
  };
}

export function duelConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  const scene = overrides.scene ?? duelScene();
  const players = overrides.players ?? ['p1', 'bot-1'];
  return {
    version: { buildId: BUILD_ID, contentPackHash: contentPackHash(scene) },
    players,
    seed: 424242,
    sceneRef: 'duel',
    scene,
    initial: players.map((_, slot) => ({ prefab: 'Hero', overrides: { Player: { slot } } })),
    physics: {},
    visibility: {},
    tickRate: TICK_RATE,
    snapshotRate: TICK_RATE,
    inputDelay: 2,
    ...overrides,
  };
}

/** Конфиг с туманом: командам розданы разные `Team.id` — фильтр FoW работает по ним. */
export function fogConfig(overrides: Partial<MatchConfig> = {}, visionRadius = 1): MatchConfig {
  return duelConfig({
    scene: fogScene(visionRadius),
    initial: [
      { prefab: 'Hero', overrides: { Player: { slot: 0 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: {
          Player: { slot: 1 },
          Team: { id: 1 },
          Position: { x: fixed.fromInt(3), y: 0 },
        },
      },
    ],
    ...overrides,
  });
}

/**
 * Сцена со СЛОТАМИ СПОСОБНОСТЕЙ (ABIL-1): компоненты платформы объявлены
 * сценой, а сущности-слоты спавнит `initial` — фикстуре не нужны ни определения
 * способностей, ни их автомат, ей нужен слот с кулдауном в снапшоте.
 *
 * Имена компонентов берутся константами ядра, а не строками: переименование в
 * платформе обязано ронять эту фикстуру, а не тихо оставлять `view.slots`
 * пустым.
 */
function slotScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    components: [
      ...scene.components,
      {
        name: ABILITY_SLOT_COMPONENT,
        fields: { owner: 'entity', slotIndex: 'i32', phase: 'i32', staged: 'i32' },
      },
      { name: ABILITY_COOLDOWN_COMPONENT, fields: { remaining: 'i32', total: 'i32' } },
    ],
    prefabs: [
      ...(scene.prefabs ?? []),
      {
        name: 'Slot',
        components: {
          [ABILITY_SLOT_COMPONENT]: { owner: 0, slotIndex: 0, phase: NO_PHASE, staged: 0 },
          [ABILITY_COOLDOWN_COMPONENT]: { remaining: 0, total: 0 },
        },
      },
      {
        // Слот БЕЗ компонента кулдауна: «кулдауна нет» — законное состояние, и
        // читаться оно обязано нулём, а не отсутствием слота.
        name: 'BareSlot',
        components: {
          [ABILITY_SLOT_COMPONENT]: { owner: 0, slotIndex: 0, phase: NO_PHASE, staged: 0 },
        },
      },
    ],
  };
}

/**
 * Кулдауны слотов фикстуры по индексу: половина, взведённый до упора и слот без
 * компонента вовсе. Те же числа даются ОБОИМ героям — так проверка не зависит
 * от того, какая сущность досталась боту, а лишний набор чужих слотов заодно
 * пиннит фильтр по владельцу (BOT-3).
 */
export const SLOT_COOLDOWNS = [
  { slotIndex: 0, remaining: 30, total: 60, cooldown: 0.5 },
  { slotIndex: 1, remaining: 90, total: 60, cooldown: 1 },
  { slotIndex: 2, remaining: 0, total: 0, cooldown: 0 },
] as const;

/**
 * Сущности героев фикстуры: `worldInit` детерминирован, и в этой сцене перед
 * `initial` спавнится носитель арены — поэтому герои получают id 1 и 2, а не 0
 * и 1. Числа тут неизбежны: владельца слота называет документ сцены, а
 * `initial` ссылаться на «сущность, которую заспавнит соседняя запись» не умеет.
 * Тест утверждает принадлежность своей сущности этому набору — смена порядка
 * спавна обязана ронять его, а не оставлять слоты пустыми.
 */
export const SLOT_OWNERS = [1, 2] as const;

/** Матч на сцене со слотами: по три слота каждому герою (ABIL-1, ABIL-7). */
export function slotConfig(): MatchConfig {
  const scene = slotScene();
  const players = ['p1', 'bot-1'];
  const heroes = players.map((_, slot) => ({
    prefab: 'Hero',
    overrides: { Player: { slot } },
  }));
  const slots = SLOT_OWNERS.flatMap((owner) =>
    SLOT_COOLDOWNS.map((entry) => ({
      prefab: entry.total === 0 ? 'BareSlot' : 'Slot',
      overrides: {
        [ABILITY_SLOT_COMPONENT]: { owner, slotIndex: entry.slotIndex },
        ...(entry.total === 0
          ? {}
          : { [ABILITY_COOLDOWN_COMPONENT]: { remaining: entry.remaining, total: entry.total } }),
      },
    })),
  );
  return duelConfig({ scene, players, initial: [...heroes, ...slots] });
}

/**
 * Конфиг со снарядом, летящим в сторону слота бота: `Bolt` без слота игрока —
 * то, что восприятие бота обязано увидеть угрозой и экстраполировать.
 */
export function boltConfig(velocityX = 0.1): MatchConfig {
  const config = duelConfig();
  return duelConfig({
    initial: [
      ...(config.initial ?? []),
      {
        prefab: 'Bolt',
        overrides: {
          Position: { x: fixed.fromInt(-4), y: 0 },
          Velocity: { x: fixed.fromFloat(velocityX), y: 0 },
        },
      },
    ],
  });
}

/** Доставка в loopback асинхронная (NTR-2) — шаг цикла заканчивается тут. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Ручной планировщик пауз: дедлайн заполнителя (BOT-7) и пауза до посадки
 * заместителя (BOT-14) наступают вызовом теста, а не течением времени. Один на
 * обе политики — они и приняли его одним типом (`FillSchedule`).
 */
export function manualSchedule(): {
  schedule: FillSchedule;
  run: () => void;
  pending: () => boolean;
} {
  let queued: (() => void) | null = null;
  return {
    schedule: (run) => {
      queued = run;
      return 1;
    },
    run: () => {
      const task = queued;
      queued = null;
      task?.();
    },
    pending: () => queued !== null,
  };
}

interface Clock {
  ms: number;
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

export interface ConnectedHuman {
  readonly client: MatchClient;
  readonly host: ClientHost;
}

/** Клиент человека — тот же код, что у бота, но источник ввода из сценария (INP-1). */
export function connectHuman(
  fixture: Harness,
  playerId: string,
  input?: InputSource,
  transport?: Transport,
): ConnectedHuman {
  const pack = contentPack({ duel: fixture.config.scene });
  const client = new MatchClient({
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    physics: {},
    visibility: {},
  });
  const host = new ClientHost(client, transport ?? fixture.hub.connect(), {
    now: () => fixture.clock.ms,
    ...(input !== undefined ? { input } : {}),
  });
  host.start();
  return { client, host };
}

export interface BotOptions {
  readonly playerId: string;
  readonly brain: BotBrainFactory;
  readonly profile: BotProfile;
  readonly transport?: Transport;
  /** Роль соединения (`netcode-transport` NTR-18); отсутствие — владелец слота. */
  readonly role?: ConnectionRole;
}

/**
 * Бот в матче — та же сборка для любого мозга (D6): различие исчерпывается
 * фабрикой, переданной сюда.
 */
export function connectBot(fixture: Harness, host: BotHost, options: BotOptions): BotSeat {
  const pack = contentPack({ duel: fixture.config.scene });
  const seat = host.add({
    playerId: options.playerId,
    transport: options.transport ?? fixture.hub.connect(),
    ...(options.role !== undefined ? { role: options.role } : {}),
    brain: options.brain,
    profile: options.profile,
    content: pack,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    physics: {},
    visibility: {},
    now: () => fixture.clock.ms,
  });
  seat.start();
  return seat;
}

/** Один шаг матча: клиенты, доставка, тик сервера, доставка. */
export async function stepMatch(
  fixture: Harness,
  clients: readonly { step(): unknown }[],
): Promise<void> {
  fixture.clock.ms += 1000 / TICK_RATE;
  for (const client of clients) client.step();
  await settle();
  fixture.host.step();
  await settle();
}

export interface RecordedMatch {
  /** Шаги клиента бота — ровно то, что видел бы его мозг (BOT-3). */
  readonly steps: ClientStep[];
  readonly slot: number;
  readonly fixture: Harness;
}

/**
 * Прогон матча с записью шагов клиента бота: даёт слоям мозга настоящий поток
 * наблюдений вместо синтетического снапшота, собранного руками.
 */
export async function recordSteps(
  config: MatchConfig,
  ticks: number,
  humanInput?: InputSource,
): Promise<RecordedMatch> {
  const fixture = harness(config);
  const steps: ClientStep[] = [];
  const human = connectHuman(fixture, config.players[0]!, humanInput);
  const bots = new BotHost();
  const seat = connectBot(fixture, bots, {
    playerId: config.players[1]!,
    profile: testProfile(),
    brain: () => ({
      observe: (step) => { steps.push(step); },
      sample: () => undefined,
    }),
  });
  await settle();
  for (let i = 0; i < ticks; i++) await stepMatch(fixture, [human.host, seat]);
  const slot = seat.client.slot ?? -1;
  bots.dispose();
  return { steps, slot, fixture };
}

/**
 * Профиль для тестов: человечность выключена (нулевая задержка, нулевой шум,
 * нулевой стрейф), чтобы поведение читалось глазами. Способность одна и
 * простейшая — тап по видимому врагу; тесты, которым нужен состав побогаче,
 * передают свой список.
 *
 * Путь документа поведения (BOT-8) здесь чистая формальность формы: документ
 * тестов приезжает мозгу опцией (`testBehavior`), а резолвить путь в дереве
 * контента движку нечем и незачем (CONT-4).
 */
export function testProfile(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    schema: BOT_PROFILE_SCHEMA,
    name: 'test',
    reaction: { delayTicks: 0, jitterTicks: 0, memoryTicks: 120 },
    aim: { noiseDegrees: 0, noisePeriodTicks: 10 },
    decision: { intervalTicks: 1, jitterTicks: 0 },
    movement: {
      maxSpeed: 1,
      arriveTolerance: 0.25,
      edgeMargin: 2,
      engageRange: 8,
      strafe: 0,
      strafePeriodTicks: 30,
    },
    abilities: [
      { name: 'cast', button: 0, target: 'enemy', range: 8, holdTicks: 1, cooldownTicks: 30, weight: 1 },
    ],
    behavior: 'bots/behaviors/test.json',
    seed: 7,
    ...overrides,
  };
}

/**
 * Документ поведения для тестов (BOT-8): те же четыре формулы, что у профиля
 * тестов, — «давить тем сильнее, чем дальше враг», «кайтить тем сильнее, чем он
 * ближе», «отступать у края», «уклоняться от сближающегося снаряда».
 *
 * Фикстура ДВИЖКА, а не контент (CONT-4): эталон движка обязан краснеть от
 * правки движка, а не от ретюна числа геймдизайнером, поэтому документ живёт
 * здесь, а не в `content/bots/`.
 */
export function testBehavior(overrides: Partial<BotBehaviorDocument> = {}): BotBehaviorDocument {
  return {
    schema: BOT_BEHAVIOR_SCHEMA,
    name: 'test',
    actions: [
      {
        executor: 'pressure',
        considerations: [
          KNOWN_ENEMY,
          { input: 'enemyDistance', curve: RISING, weight: 0.6 },
        ],
      },
      {
        executor: 'kite',
        considerations: [
          KNOWN_ENEMY,
          // Наклон −2: вход нормирован ДВУМЯ дистанциями боя, поэтому единицу
          // кривая отдаёт вплотную, а ноль — ровно на дистанции боя.
          { input: 'enemyDistance', curve: { type: 'linear', slope: -2, intercept: 1 }, weight: 0.2 },
        ],
      },
      { executor: 'retreat', considerations: [{ input: 'edgeProximity', curve: RISING, weight: 1 }] },
      {
        executor: 'dodge',
        considerations: [
          { input: 'threatClosing', curve: RISING, weight: 1 },
          { input: 'threatDistance', curve: FALLING, weight: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

/** Тождественная кривая: оценка равна входу. */
const RISING: BotCurve = { type: 'linear', slope: 1, intercept: 0 };

/** Убывающая: единица при нуле входа, ноль при единице. */
const FALLING: BotCurve = { type: 'linear', slope: -1, intercept: 1 };

/** Ворота «врага видно вообще»: без них давить и кайтить не на кого. */
const KNOWN_ENEMY: BotConsideration = { input: 'enemyKnown', curve: RISING, weight: 1 };

/**
 * Рельеф с уступом: слева уровень 0, справа от `edgeX` — уровень 1, и всё это с
 * полом. То, на чём проверяется запрыгивание (LOC-5, PHYS-11).
 */
export function ledgeTerrain(edgeX = 4, size = 8): BotTerrain {
  const row = Array.from({ length: size }, (_, x) => (x >= edgeX ? '1' : '0')).join('');
  return botTerrain({
    components: [],
    terrain: {
      width: size,
      height: size,
      tileSize: fixed.fromInt(1),
      levels: Array.from({ length: size }, () => row),
      flags: Array.from({ length: size }, () => '.'.repeat(size)),
    },
  })!;
}

/** Рельеф с дырой в столбце `holeX`: пола нет, за ней снова пол. */
export function holeTerrain(holeX = 4, size = 8): BotTerrain {
  const row = Array.from({ length: size }, (_, x) => (x === holeX ? '_' : '.')).join('');
  return botTerrain({
    components: [],
    terrain: {
      width: size,
      height: size,
      tileSize: fixed.fromInt(1),
      levels: Array.from({ length: size }, () => '0'.repeat(size)),
      flags: Array.from({ length: size }, () => row),
    },
  })!;
}
