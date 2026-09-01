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
  type GameEvent,
  type SceneDef,
} from '@fluxus/core';
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
  type PresentedState,
  type Transport,
} from '@fluxus/net';
import { AssetService } from '@fluxus/assets';
import {
  RenderHost,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '@fluxus/render';

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

/**
 * Та же сцена с расстановкой в конфиге (SER-7, SER-8): реквизит стоит на арене
 * в каждом её прогоне и занимает первые ID, герои приходят расстановкой конфига
 * матча и встают за ним. Записанный на ней матч и держит парность пролога
 * `buildMatchWorld` с прологом ядра (NTR-8, CLI-10).
 */
export function propScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    prefabs: [...(scene.prefabs ?? []), { name: 'Prop', components: { Position: { x: 0, y: 0 } } }],
    initial: [
      { prefab: 'Prop', overrides: { Position: { x: fixed.fromInt(2), y: 0 } } },
      { prefab: 'Prop', overrides: { Position: { x: 0, y: fixed.fromInt(3) } } },
    ],
  };
}

/**
 * Сцена дуэли, на которой проверяется выразимость BUFF-7: пассивка, аура, DoT и
 * зона с эффектом — четырьмя записями таблиц определений и одной системой сцены,
 * без единого нового механизма платформы.
 *
 * Живёт здесь, а не в `core-ts/test`, потому что предмет проверки — не
 * поведение одной системы, а то, что четыре разных игровых понятия собираются
 * из уже существующих частей: способность с триггером `always`, эффект с
 * длительностью, периодика и статовая правка в списке источников таймскейла.
 *
 * `capacity` поднята под сущности платформы: слоты, инстансы и зоны — обычные
 * сущности мира, и место им нужно наравне с героями (BUFF-1, ABIL-1).
 */
export function buffScene(): SceneDef {
  const scene = duelScene();
  const hero = scene.prefabs![0]!;
  const buffed = { ...hero.components, TimeScale: {}, TimeScaleModifiers: {} };
  return {
    ...scene,
    components: [...scene.components, { name: 'Drift', fields: { step: 'fixed' } }],
    prefabs: [
      { ...hero, components: buffed },
      // Тот же герой, но уходящий сам: движение в этом стенде задаёт система
      // сцены, а не физика — зависимость сборки сюда не приезжает (DI-3).
      { ...hero, name: 'Walker', components: { ...buffed, Drift: { step: 0 } } },
      // Слот, инстанс и зона выдаются спавном (ABIL-1, BUFF-1): ни новых схем,
      // ни правки существующих для этого не требуется.
      { name: 'Slot', components: { AbilitySlot: {}, AbilityCooldown: { remaining: 0, total: 0 } } },
      { name: 'Buff', components: { BuffInstance: {} } },
      { name: 'Dome', components: { Position: { x: 0, y: 0 }, AbilityDuration: {} } },
    ],
    timeScale: true,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Drift',
        order: 20,
        query: { all: ['Drift', 'Position'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: {
                x: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                    { getComponent: [{ var: 'e' }, 'Drift', 'step'] },
                  ],
                },
              },
            },
          },
        ],
      },
      // Зона накладывает бафф на вошедших — обычная система сцены над обычным
      // запросом (BUFF-7): о «зонах» платформе знать нечего.
      {
        name: 'DomeSlow',
        order: 130,
        query: { all: ['AbilityDuration'] },
        as: 'z',
        do: [
          {
            forEach: {
              query: {
                all: ['Player'],
                withinRadius: { center: positionOf('z'), radius: fixed.fromInt(2) },
              },
              as: 'e',
              do: [spawnBuff('e', 'z', CHILLED)],
            },
          },
        ],
      },
    ],
    // Аура: триггер `always`, короткий `refresh`-бафф на сущности в круге.
    // Вышедшая из круга сущность перестаёт получать продление, и бафф гаснет
    // сам — системы «следить за выходом» не появляется (BUFF-7).
    abilities: [
      {
        id: 'aura',
        trigger: { always: true },
        effects: [
          {
            forEach: {
              query: {
                all: ['Player'],
                withinRadius: { center: positionOf('owner'), radius: fixed.fromInt(1) },
              },
              as: 'e',
              do: [spawnBuff('e', 'self', AURAD)],
            },
          },
        ],
      },
    ],
    abilityRuntime: { teamField: ['Player', 'slot'] },
    buffs: [
      // Пассивка: постоянный бафф со статовой правкой. Длительности нет вовсе.
      {
        id: 'passive',
        class: 'positive',
        statMods: [{ component: 'TimeScaleModifiers', value: fixed.fromFloat(1.5) }],
      },
      // Аурный бафф: `refresh` с длительностью в пару тиков.
      { id: 'aurad', class: 'positive', durationTicks: 2, stacking: 'refresh' },
      // DoT: отрицательный бафф с периодикой. «Урон» целиком принадлежит
      // контенту — платформа исполняет список действий, и только.
      {
        id: 'burn',
        class: 'negative',
        durationTicks: 9,
        stacking: 'refresh',
        periodic: {
          everyTicks: 3,
          do: [{ emitEvent: { type: 'Burn', data: { target: { var: 'target' } } } }],
        },
      },
      // Дебафф купола: замедление статовой правкой в списке таймскейла — ровно
      // то, ради чего писался TIME-7.
      {
        id: 'chilled',
        class: 'negative',
        durationTicks: 2,
        stacking: 'refresh',
        statMods: [{ component: 'TimeScaleModifiers', value: fixed.fromFloat(0.5) }],
      },
    ],
    capacity: 64,
  };
}

/** Индексы определений баффов сцены: из мира определение адресуется индексом (BUFF-1). */
export const PASSIVE = 0;
export const AURAD = 1;
export const BURN = 2;
export const CHILLED = 3;

const positionOf = (name: string): Record<string, unknown> => ({
  vec: [
    { getComponent: [{ var: name }, 'Position', 'x'] },
    { getComponent: [{ var: name }, 'Position', 'y'] },
  ],
});

const spawnBuff = (target: string, source: string, buffId: number): Record<string, unknown> => ({
  spawnEntity: {
    prefab: 'Buff',
    overrides: { BuffInstance: { target: { var: target }, source: { var: source }, buffId } },
  },
});

/**
 * Сцена дуэли с туманом войны, носителем карты пола (TERR-6) и носителем арены
 * (ARENA-1). Компоненты FoW дописывает загрузчик по флагу `fog` (SER-7), а
 * `Vision` герою выдаёт prefab: маску считает нативная `VisibilitySystem`, которую
 * объявляет конфиг матча (NTR-14) — вертикаль обязана проверять настоящую FoW, а
 * не расставленные руками биты.
 *
 * Радиус обзора мал намеренно: шаг за тик — `TICK_DELTA` (≈0.08), поэтому
 * уходящий вправо герой покидает обзор противника за десяток тиков, и «ушёл в
 * туман» наблюдается внутри короткого матча.
 */
function fogScene(): SceneDef {
  const scene = duelScene();
  const hero = scene.prefabs![0]!;
  return {
    ...scene,
    prefabs: [
      {
        ...hero,
        components: {
          ...hero.components,
          Vision: { radius: fixed.fromInt(1) },
          Visibility: { visibleTo: 0 },
          Team: { id: 0 },
          StealthSources: {},
        },
      },
    ],
    fog: true,
    // Ровная площадка без обрывов: укрытий и разницы уровней в проверке нет —
    // предмет её в том, что носители остаются в персональном снапшоте.
    terrain: {
      width: 8,
      height: 8,
      tileSize: fixed.fromInt(1),
      levels: Array.from({ length: 8 }, () => '00000000'),
      flags: Array.from({ length: 8 }, () => '........'),
    },
    arena: { center: { x: 0, y: 0 }, radius: fixed.fromInt(20) },
  };
}

/**
 * Та же сцена с туманом плюс платформа способностей и баффов — стенд изоляции
 * спутников в персональном снапшоте (NET-12).
 *
 * Устроена так, чтобы на одном тике наблюдались все три величины требования:
 * сущность-спутник, которую противник не вправе видеть НИКОГДА (слот
 * способности), сущность-спутник, видимость которой наследуется у цели (инстанс
 * баффа), и обычная сущность мира, заспавненная кастом, — её противник видит на
 * общих основаниях, потому что она часть мира, а не состояние чужого слота.
 *
 * Способность бесконечна намеренно: фаза длится дольше матча, поэтому каст идёт
 * всё время наблюдения, а спавнов после первого тика не случается — `capacity`
 * от длины прогона не зависит. Слоты выдаёт обычная система сцены (design
 * Decision 14), а не расстановка: `owner` заранее неизвестен.
 */
function abilityFogScene(): SceneDef {
  const scene = fogScene();
  const ownerField = (component: string, field: string): Record<string, unknown> => ({
    getComponent: [{ var: 'owner' }, component, field],
  });
  return {
    ...scene,
    components: [
      ...scene.components,
      // Маркер «слот уже выдан»: без него система выдачи спавнила бы слот каждый тик.
      { name: 'Granted', fields: { at: 'i32' } },
      // Полезная нагрузка сущности каста: чей это след.
      { name: 'Trace', fields: { by: 'i32' } },
    ],
    prefabs: [
      ...(scene.prefabs ?? []),
      { name: 'Slot', components: { AbilitySlot: {} } },
      { name: 'Buff', components: { BuffInstance: {} } },
      { name: 'Flare', components: { Position: { x: 0, y: 0 }, Visibility: { visibleTo: 0 }, Trace: { by: 0 } } },
    ],
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'GrantSlots',
        order: 5,
        query: { all: ['Player'], not: ['Granted'] },
        as: 'e',
        do: [
          {
            spawnEntity: {
              prefab: 'Slot',
              overrides: { AbilitySlot: { owner: { var: 'e' }, abilityId: 0, slotIndex: 0 } },
            },
          },
          { addComponent: { entity: { var: 'e' }, component: 'Granted' } },
        ],
      },
    ],
    abilities: [
      {
        id: 'flare',
        trigger: { always: true },
        phases: [
          {
            id: 'cast',
            trigger: 'auto',
            durationTicks: 10000,
            onEnter: [
              {
                spawnEntity: {
                  prefab: 'Flare',
                  overrides: {
                    Position: { x: ownerField('Position', 'x'), y: ownerField('Position', 'y') },
                    Trace: { by: ownerField('Player', 'slot') },
                  },
                },
              },
              {
                spawnEntity: {
                  prefab: 'Buff',
                  overrides: {
                    BuffInstance: { target: { var: 'owner' }, source: { var: 'self' }, buffId: 0 },
                  },
                },
              },
            ],
          },
        ],
        effects: [],
      },
    ],
    abilityRuntime: { teamField: ['Player', 'slot'] },
    buffs: [{ id: 'aura', class: 'positive', durationTicks: 10000 }],
    capacity: 64,
  };
}

/** Конфиг матча на сцене с туманом: пересчёт видимости объявлен, как требует NTR-14. */
export function fogConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return duelConfig({
    scene: fogScene(),
    initial: [
      { prefab: 'Hero', overrides: { Team: { id: 0 } } },
      { prefab: 'Hero', overrides: { Player: { slot: 1 }, Team: { id: 1 } } },
    ],
    ...overrides,
  });
}

/** Конфиг матча на сцене с туманом и платформой способностей (NET-12). */
export function abilityFogConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return fogConfig({ scene: abilityFogScene(), ...overrides });
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
    // Зависимости сборки мира (NTR-14): без физики Velocity никто не интегрирует,
    // а без объявленного пересчёта видимости фильтрация по `Visibility.visibleTo`
    // (NET-12) шла бы по маскам, которые никто не считает. Записанные матчи
    // (CLI-10) объявляют пересчёт наравне с физикой, и на сцене без флага `fog`
    // он ровно ничего не считает — компонентов тумана в ней нет.
    physics: {},
    visibility: {},
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

/**
 * Источник клиентского конца канала. `LoopbackHub` его и есть; отдельный тип
 * нужен обёртке над транспортом (NTR-2): «канал теряет и переставляет
 * сообщения» — свойство реализации транспорта, и подменяется она, а не сервер с
 * клиентом.
 */
export interface ClientLink {
  connect(): Transport;
}

/**
 * Клиент вертикали. Зависимости сборки мира он получает из ТОГО ЖЕ описания
 * матча, что сервер (NTR-14): обе стороны поднимают мир общим путём
 * `buildMatchWorld`, и состав систем у них обязан совпасть — это предпосылка
 * предсказания (NTR-10) и условие входа на сцене с туманом войны.
 */
export function connectClient(
  hub: ClientLink,
  playerId: string,
  clock: Clock,
  scene: SceneDef,
  input?: InputSource,
  build: Pick<MatchConfig, 'physics' | 'visibility'> & { holdButton?: number } = {},
): ConnectedClient {
  const pack = contentPack({ duel: scene });
  const client = new MatchClient({
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    // Тот же номер бита, которым настроен сервер матча: в замороженном мире
    // наружу уезжает только он (NET-11), и сборка, забывшая его назвать,
    // ведения скраба лишается — что и проверяется в тесте ульты.
    ...(build.holdButton !== undefined ? { holdButton: build.holdButton } : {}),
    ...(build.physics !== undefined ? { physics: build.physics } : {}),
    ...(build.visibility !== undefined ? { visibility: build.visibility } : {}),
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

/** Шина, с которой мост восстанавливает мир: пустая — факты едут потоком (NTR-15). */
const NO_EVENTS: readonly GameEvent[] = [];

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
  private lastEpoch = 0;

  constructor(sceneDef: SceneDef, config: MatchConfig, clock: Clock) {
    // Каждая необязательная зависимость сборки передаётся ПО НАЛИЧИЮ, а не
    // значением: `buildMatchWorld` различает «поля нет» и «поле есть» (NTR-14
    // отказывает сцене с туманом без объявленного пересчёта видимости), и
    // ключ со значением `undefined` был бы объявлением, которого не делали.
    this.world = buildMatchWorld({
      scene: sceneDef,
      players: config.players,
      seed: config.seed,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.locomotion !== undefined ? { locomotion: config.locomotion } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
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

  /**
   * Применяет свежий снапшот. «Свежий» — по ПАРЕ `(эпоха, тик)` лексикографически
   * (NTR-10, NTR-16), а не по одному номеру тика: при перемотке номера идут
   * назад и повторяются, и дедуп по тику погасил бы ровно то состояние, которое
   * NET-11 велит показать. Эпоха приезжает аргументом от `MatchClient.epoch` —
   * сам `Snapshot` её не несёт и нести не должен (NTR-16: в мир она не входит).
   *
   * `discontinuity` — признак разрыва непрерывности от клиента (SHELL-7), тот
   * же, что рендер получает в сэмпле. Он и едет в `isReplay` `TickResult`'а:
   * для рендера «состояние другой ветви истории» и «реплеевый тик» — один
   * случай, разрыв (REND-2), и extractor выводит из него `snapAll`. Тем же
   * флагом он гасит `freshEvents` — и это осознанно: события перемотанного
   * состояния уже показывались в стёртой ветви, играть их второй раз незачем.
   */
  apply(snapshot: PresentedState, epoch: number, discontinuity: boolean): void {
    if (epoch < this.lastEpoch || (epoch === this.lastEpoch && snapshot.tick <= this.lastTick)) {
      return;
    }
    // Состояние приезжает презентационной проекцией — без шины (NTR-15, «Шина
    // внутри снапшота»): единственный источник фактов для представления —
    // поток `Events` (`MatchClient.takeEvents`). Мир моста поэтому
    // восстанавливается с ПУСТОЙ шиной, а не с шиной кадра: возьми мост её
    // отсюда — события тиков рассылки проигрались бы дважды, из состояния и из
    // потока.
    restoreSnapshot(this.world.state, { ...snapshot, events: NO_EVENTS });
    this.host.onTick({
      state: this.world.state,
      tick: snapshot.tick,
      mode: this.world.state.mode,
      isReplay: discontinuity,
      events: this.world.state.events,
      changes: NO_CHANGES,
    });
    this.lastTick = snapshot.tick;
    this.lastEpoch = epoch;
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
  const build = {
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, inputs.a, build);
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, inputs.b, build);
  const bridge = new RenderBridge(scene, config, fixture.clock);
  await settle();

  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
    // Признак снимается КАЖДУЮ итерацию, а не только вместе с состоянием: он
    // гасится чтением (SHELL-7), и пропущенная итерация донесла бы его до
    // следующего снапшота — то есть рендер нарисовал бы snap на состоянии, к
    // которому разрыв не относится.
    const discontinuity = b.client.takeDiscontinuity();
    const latest = b.client.latest;
    if (latest !== undefined) bridge.apply(latest, b.client.epoch, discontinuity);
  }
  return { ...fixture, a, b, bridge };
}
