/**
 * Поток событий тиков на границе (NTR-15): настоящий матч на внутрипроцессном
 * транспорте — тот же сервер, тот же клиент, тот же кодек (NTR-12).
 *
 * Почему это здесь, а не в `net-ts`. Правила каждой из сторон уже проверены
 * поштучно: серверное накопление и объявленный диапазон — `events.test.ts`,
 * курсор пары и счётчики получателя — `eventStream.test.ts`. Обе половины там
 * проверяются в одиночку и намеренно: в первой сообщения читает тест, во второй
 * их подаёт тест. Здесь не повторяется ни одна из них — здесь проверяется
 * СОГЛАСИЕ сторон на живом канале (решение 7 дизайна: «проверка — на границе, а
 * не на моке»), то есть ровно те регрессы, которые не краснеют ни в одной
 * половине по отдельности: факт тика без рассылки доехал, факт про невидимого
 * не доехал ни с какой задержкой, потеря чинится повтором, а не догадкой.
 *
 * Потеря и переупорядочивание ставятся ОБЁРТКОЙ НАД ТРАНСПОРТОМ (NTR-2): это
 * свойство реализации канала, и подменяется именно она, а не сервер с клиентом.
 * Случайности в обёртке нет — вердикт выносится по номеру сообщения своего типа,
 * поэтому прогон повторяем (DET-1 для теста ровно так же обязателен).
 */
import { describe, expect, it } from 'vitest';
import {
  query,
  world as coreWorld,
  TEAM_SCHEMA,
  VISIBILITY_SCHEMA,
  type Action,
  type SceneDef,
  type SystemDef,
} from '@game-mvp/core';
import {
  ClientHost,
  DEFAULT_SERIALIZER,
  LoopbackHub,
  MatchClient,
  MatchHost,
  MatchServer,
  clientCodec,
  type Codec,
  type ClientMessage,
  type DeliveredEvents,
  type EventsMessage,
  type MatchConfig,
  type PresentedState,
  type ServerMessage,
  type SnapshotMessage,
  type Transport,
} from '@game-mvp/net';
import {
  TICK_RATE,
  connectClient,
  duelConfig,
  duelScene,
  settle,
  type ClientLink,
  type Clock,
} from './fixtures.js';

// ------------------------------------------------------------------- сцена

const TEAM_A = 0;
const TEAM_B = 1;
/** Маска «видно обеим командам». */
const BOTH = 0b11;
/** Маска «видно только команде врага» — то есть клиенту A не видно вовсе. */
const ONLY_B = 0b10;

/** Публикация события помеченной сущностью на конкретном тике. */
interface Emit {
  readonly mark: number;
  readonly tick: number;
  readonly type: string;
}

/** Смена маски видимости помеченной сущности начиная с тика. */
interface Flip {
  readonly mark: number;
  readonly fromTick: number;
  readonly mask: number;
}

/** Уничтожение помеченной сущности начиная с тика. */
interface Reap {
  readonly mark: number;
  readonly tick: number;
}

interface MarkSpec {
  readonly id: number;
  readonly visibleTo: number;
}

interface SceneSpec {
  readonly marks?: readonly MarkSpec[];
  readonly emits?: readonly Emit[];
  readonly flips?: readonly Flip[];
  readonly reaps?: readonly Reap[];
}

const markIs = (id: number): Action => ({
  '==': [{ getComponent: [{ var: 'e' }, 'Mark', 'id'] }, id],
});
const tickIs = (tick: number): Action => ({ '==': [{ tick: [] }, tick] });
const tickFrom = (tick: number): Action => ({ '>=': [{ tick: [] }, tick] });

/**
 * Сцена дуэли плюс помеченные сущности, чьё поведение задано расписанием тиков.
 *
 * Расписание, а не ввод игрока, намеренно: предмет проверки — доставка факта, а
 * не путь ввода до симуляции (он покрыт вертикалью). Номер тика публикации —
 * величина, вокруг которой написан весь NTR-15, и брать её из ввода значило бы
 * поставить каждую проверку в зависимость от оценки серверного тика клиентом.
 *
 * Носителем события сделана сущность БЕЗ `Player`: политика видимости событий по
 * умолчанию (NET-13) отбирает событие по видимости упомянутой сущности, а
 * уничтожать сущность игрока нельзя вовсе — `InputSystem` не отбрасывает фрейм
 * без сущности (TICK-5) и матч бы упал.
 */
function markedScene(spec: SceneSpec): SceneDef {
  const base = duelScene();
  const systems: SystemDef[] = [...(base.systems ?? [])];
  const emits = spec.emits ?? [];
  const flips = spec.flips ?? [];
  const reaps = spec.reaps ?? [];

  if (emits.length > 0) {
    systems.push({
      name: 'Script',
      order: 20,
      query: { all: ['Mark'] },
      as: 'e',
      do: emits.map((emit) => ({
        if: {
          cond: { and: [markIs(emit.mark), tickIs(emit.tick)] },
          then: [{ emitEvent: { type: emit.type, data: { entity: { var: 'e' } } } }],
        },
      })),
    });
  }
  if (flips.length > 0) {
    systems.push({
      name: 'Flip',
      order: 30,
      query: { all: ['Mark', 'Visibility'] },
      as: 'e',
      do: flips.map((flip) => ({
        if: {
          cond: { and: [markIs(flip.mark), tickFrom(flip.fromTick)] },
          then: [
            {
              modifyComponent: {
                entity: { var: 'e' },
                component: 'Visibility',
                values: { visibleTo: flip.mask },
              },
            },
          ],
        },
      })),
    });
  }
  if (reaps.length > 0) {
    systems.push({
      name: 'Reap',
      order: 40,
      query: { all: ['Mark'] },
      as: 'e',
      do: reaps.map((reap) => ({
        if: {
          cond: { and: [markIs(reap.mark), tickFrom(reap.tick)] },
          then: [{ destroyEntity: { entity: { var: 'e' } } }],
        },
      })),
    });
  }

  return {
    ...base,
    // Компоненты видимости объявлены СЦЕНОЙ РУКАМИ, а не флагом `fog` (SER-7), и
    // это осознанно: флаг обязывал бы конфиг матча объявить пересчёт видимости
    // (NTR-14), а нативная `VisibilitySystem` (order 900) переписала бы
    // авторскую маску битом собственной команды сущности (FOW-3) — то есть
    // отняла бы у теста его предмет. Отказ NTR-14 привязан именно к флагу,
    // ровно тому признаку, по которому загрузчик решает, дописывать ли
    // компоненты тумана (решение 5 дизайна `filter-ownership`).
    components: [
      ...base.components,
      { name: 'Mark', fields: { id: 'i32' } },
      VISIBILITY_SCHEMA,
      TEAM_SCHEMA,
    ],
    prefabs: [
      // Маски проставляются расстановкой и переставляются системой сцены, а не
      // считаются `VisibilitySystem`: предмет проверки — момент отбора, а не
      // расчёт видимости (он покрыт FOW-тестами ядра).
      ...(base.prefabs ?? []).map((prefab) =>
        prefab.name === 'Hero'
          ? {
              ...prefab,
              components: {
                ...prefab.components,
                Visibility: { visibleTo: BOTH },
                Team: { id: TEAM_A },
              },
            }
          : prefab,
      ),
      {
        name: 'Marked',
        components: {
          Position: { x: 0, y: 0 },
          Visibility: { visibleTo: BOTH },
          Team: { id: TEAM_B },
          Mark: { id: 0 },
        },
      },
    ],
    systems,
    initial: (spec.marks ?? []).map((mark) => ({
      prefab: 'Marked',
      overrides: { Mark: { id: mark.id }, Visibility: { visibleTo: mark.visibleTo } },
    })),
  };
}

/** Рассылка на каждом втором тике: большинство тиков ею не сопровождается (NTR-7). */
const BROADCAST_RATE = 30;

function eventConfig(spec: SceneSpec, overrides: Partial<MatchConfig> = {}): MatchConfig {
  return duelConfig({
    scene: markedScene(spec),
    snapshotRate: BROADCAST_RATE,
    eventRepeat: 0,
    // Пересчёта видимости этот матч не объявляет намеренно: маску авторит сама
    // сцена (см. `markedScene`), и требовать его сцена без флага `fog` не может
    // (NTR-14). Явное `undefined` стоит здесь потому, что общая фикстура
    // `duelConfig` пересчёт объявляет, как это делают записанные матчи.
    visibility: undefined,
    ...overrides,
  });
}

// -------------------------------------------------------- обёртка транспорта

/**
 * Вердикт канала о сообщении: доставить, уронить, задержать до `release()` либо
 * доставить дважды. Все четыре — свойства ненадёжного канала (NTR-2), которые
 * протокол обязан переживать: потеря, переупорядочивание и дубль.
 */
type Verdict = 'pass' | 'drop' | 'hold' | 'twice';

/** Вердикт по сообщению и его порядковому номеру СРЕДИ СООБЩЕНИЙ СВОЕГО ТИПА. */
type Policy = (message: ServerMessage, nth: number) => Verdict;

const PASS: Policy = () => 'pass';

function verdictOn(type: ServerMessage['type'], nths: readonly number[], verdict: Verdict): Policy {
  return (message, nth) => (message.type === type && nths.includes(nth) ? verdict : 'pass');
}

/**
 * Канал-обёртка (NTR-2). Подменяется ИМЕННО транспорт: сервер и клиент под ним
 * те же, что играют, и о существовании обёртки не знают — иначе проверялась бы
 * тестовая сборка, а не протокол.
 *
 * Разбор здесь только для вердикта и для записи: наружу уходят те же байты, что
 * пришли, и `wire` — это в точности кадры, дошедшие до клиента.
 */
class Tap implements Transport {
  /** Кадры, дошедшие до клиента, в порядке доставки. */
  readonly wire: ServerMessage[] = [];
  /** Кадры, которые канал увидел, включая уроненные и задержанные. */
  readonly seen: ServerMessage[] = [];

  private readonly inner: Transport;
  private readonly policy: Policy;
  private readonly codec: Codec<ClientMessage, ServerMessage> = clientCodec(DEFAULT_SERIALIZER);
  private readonly held: Uint8Array[] = [];
  private readonly counts = new Map<string, number>();
  private handler: ((bytes: Uint8Array) => void) | undefined;
  private closeHandler: ((reason?: string) => void) | undefined;

  constructor(inner: Transport, policy: Policy) {
    this.inner = inner;
    this.policy = policy;
    inner.onMessage((bytes) => { this.intake(bytes); });
    inner.onClose((reason) => this.closeHandler?.(reason));
  }

  get isClosed(): boolean {
    return this.inner.isClosed;
  }

  send(bytes: Uint8Array): void {
    this.inner.send(bytes);
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  /** Отпустить задержанное: сообщение приезжает ПОСЛЕ более поздних — переупорядочивание. */
  release(): void {
    for (const bytes of this.held.splice(0, this.held.length)) this.deliver(bytes);
  }

  private intake(bytes: Uint8Array): void {
    const message = this.codec.decode(bytes);
    const nth = this.counts.get(message.type) ?? 0;
    this.counts.set(message.type, nth + 1);
    this.seen.push(message);
    switch (this.policy(message, nth)) {
      case 'drop':
        return;
      case 'hold':
        this.held.push(bytes);
        return;
      case 'twice':
        this.deliver(bytes);
        this.deliver(bytes);
        return;
      default:
        this.deliver(bytes);
    }
  }

  private deliver(bytes: Uint8Array): void {
    if (this.inner.isClosed) return;
    this.wire.push(this.codec.decode(bytes));
    this.handler?.(bytes);
  }
}

class TapLink implements ClientLink {
  readonly taps: Tap[] = [];
  private readonly hub: LoopbackHub;
  private readonly policy: Policy;

  constructor(hub: LoopbackHub, policy: Policy) {
    this.hub = hub;
    this.policy = policy;
  }

  connect(): Transport {
    const tap = new Tap(this.hub.connect(), this.policy);
    this.taps.push(tap);
    return tap;
  }
}

// -------------------------------------------------------------------- матч

/** Доставленный факт в форме, читаемой в ожидании: пара номера и типы событий. */
interface Fact {
  readonly epoch: number;
  readonly tick: number;
  readonly types: readonly string[];
}

function factOf(delivered: DeliveredEvents): Fact {
  return {
    epoch: delivered.epoch,
    tick: delivered.tick,
    types: delivered.events.map((event) => event.type),
  };
}

interface Party {
  readonly client: MatchClient;
  readonly host: ClientHost;
  readonly tap: Tap;
  /** Всё, что слито потребителю за матч, в порядке слива. */
  readonly facts: Fact[];
  /** Тик последнего применённого состояния после каждой итерации; `-1` — состояния ещё нет. */
  readonly applied: number[];
}

function pump(party: Party): readonly Fact[] {
  const step = party.host.step();
  const fresh = step.events.map(factOf);
  party.facts.push(...fresh);
  party.applied.push(party.client.latest?.tick ?? -1);
  return fresh;
}

interface Match {
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly clock: Clock;
  readonly a: Party;
  readonly b: Party;
  /** Тики матча: сервер шагает, канал доставляет, клиенты забирают доехавшее. */
  tick(count?: number): Promise<void>;
  /** Доставка без шага расписания — для рассылки по факту восстановления (NTR-16). */
  deliver(): Promise<void>;
  /** Отпустить задержанное каналом и дать клиентам это разобрать. */
  release(party: Party): Promise<void>;
}

async function playing(config: MatchConfig, policies: { a?: Policy; b?: Policy } = {}): Promise<Match> {
  const hub = new LoopbackHub();
  const server = new MatchServer(config);
  const host = new MatchHost(server, hub);
  const clock: Clock = { ms: 0 };
  const aLink = new TapLink(hub, policies.a ?? PASS);
  const bLink = new TapLink(hub, policies.b ?? PASS);
  const connectedA = connectClient(aLink, 'p1', clock, config.scene);
  const connectedB = connectClient(bLink, 'p2', clock, config.scene);
  await settle();

  const a: Party = { ...connectedA, tap: aLink.taps[0]!, facts: [], applied: [] };
  const b: Party = { ...connectedB, tap: bLink.taps[0]!, facts: [], applied: [] };

  const drain = async (): Promise<void> => {
    pump(a);
    pump(b);
    await settle();
  };

  return {
    server,
    host,
    clock,
    a,
    b,
    async tick(count = 1) {
      for (let i = 0; i < count; i++) {
        clock.ms += 1000 / TICK_RATE;
        host.step();
        await settle();
        await drain();
      }
    },
    async deliver() {
      host.flush();
      await settle();
      await drain();
    },
    async release(party: Party) {
      party.tap.release();
      await drain();
    },
  };
}

// ------------------------------------------------------------------ хелперы

function eventsOnWire(party: Party): EventsMessage[] {
  return party.tap.wire.filter((message): message is EventsMessage => message.type === 'Events');
}

function snapshotsOnWire(party: Party): SnapshotMessage[] {
  return party.tap.wire.filter((message): message is SnapshotMessage => message.type === 'Snapshot');
}

function rangesOf(messages: readonly EventsMessage[]): number[][] {
  return messages.map((message) => [message.from, message.to]);
}

/** Метки, дожившие до персонального снапшота: чем и видно уход в туман и смерть. */
function marksIn(state: PresentedState): number[] {
  const ids: number[] = [];
  for (const entity of query(state.world, { all: ['Mark'] })) {
    ids.push(coreWorld.getField(state.world, entity, 'Mark', 'id'));
  }
  return ids.sort((left, right) => left - right);
}

/** Уникальные тики применённых состояний — «какие рассылки клиент вообще видел». */
function appliedTicks(party: Party): number[] {
  return [...new Set(party.applied.filter((tick) => tick >= 0))];
}

// -------------------------------------------------------------------- тесты

describe('поток событий на границе: накопление и номер тика (NTR-15)', () => {
  it('событие тика, снапшот которого не рассылается, доезжает с номером своего тика', async () => {
    // Каст на тике 3 при рассылке на каждом втором: снапшота тика 3 не будет
    // никогда, и «события только на тиках рассылки» означали бы систематическую
    // потерю, а не случайную.
    const match = await playing(
      eventConfig({ marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: 3, type: 'Cast' }] }),
    );
    await match.tick(6);

    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    // Контроль: тика 3 в применённых состояниях нет вовсе — номер приехал с
    // фактом, а не был выведен из соседнего снапшота.
    expect(appliedTicks(match.a)).toEqual([2, 4, 6]);
    expect(match.a.client.metrics.eventBatchesDelivered).toBe(1);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });

  it('смерть отличима от ухода в туман: событие есть у одной, нет у другой (NET-14)', async () => {
    // Метка 1 умирает: событие на тике 3, тело уходит из мира тиком позже.
    // Метка 2 просто уходит в туман с тика 7 — и не порождает ничего.
    //
    // Событие и уничтожение разнесены по тикам намеренно: политика видимости по
    // умолчанию (NET-13) считает видимость по УЖЕ отфильтрованному миру своего
    // тика, поэтому событие про сущность, уничтоженную тем же тиком, не прошло
    // бы отбор ни у кого, кроме наблюдателя. Контент сегодня обходит ловушку
    // иначе: труп в `duel.scene.json` живёт дальше под `Dead`, а единственный
    // destroyEntity того же тика (`FireballExploded`) не ссылается на сущность.
    const match = await playing(
      eventConfig({
        marks: [
          { id: 1, visibleTo: BOTH },
          { id: 2, visibleTo: BOTH },
        ],
        emits: [{ mark: 1, tick: 3, type: 'EntityDied' }],
        reaps: [{ mark: 1, tick: 4 }],
        flips: [{ mark: 2, fromTick: 7, mask: ONLY_B }],
      }),
    );

    await match.tick(2);
    expect(marksIn(match.a.client.latest!)).toEqual([1, 2]);

    await match.tick(4);
    // Метка 1 исчезла — и поток объясняет чем: `EntityDied` с номером своего тика.
    expect(marksIn(match.a.client.latest!)).toEqual([2]);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['EntityDied'] }]);

    await match.tick(4);
    // Метка 2 исчезла тоже — и поток молчит: это туман, а не смерть. Различение
    // держится на том, что события тиков между рассылками не теряются: тик 7
    // рассылкой не сопровождался вовсе.
    expect(marksIn(match.a.client.latest!)).toEqual([]);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['EntityDied'] }]);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });
});

describe('поток событий на границе: отбор на тике публикации (NTR-15, NET-13)', () => {
  it('враг ушёл в туман между публикацией и рассылкой — событие доехало', async () => {
    const match = await playing(
      eventConfig({
        marks: [{ id: 1, visibleTo: BOTH }],
        emits: [{ mark: 1, tick: 3, type: 'Cast' }],
        flips: [{ mark: 1, fromTick: 4, mask: ONLY_B }],
      }),
    );
    await match.tick(8);

    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    // Контроль: к ближайшей рассылке враг из персонального снапшота уже вырезан.
    // Отбор по состоянию на момент отправки потерял бы здесь законный факт.
    expect(marksIn(match.a.client.latest!)).toEqual([]);
  });

  it('враг вышел из тумана между публикацией и рассылкой — событие не доехало ни разу', async () => {
    const match = await playing(
      eventConfig(
        {
          marks: [{ id: 1, visibleTo: ONLY_B }],
          emits: [{ mark: 1, tick: 3, type: 'Cast' }],
          flips: [{ mark: 1, fromTick: 4, mask: BOTH }],
        },
        // Повтор включён нарочно: «не доехало» проверяется на канале, который
        // повторяет каждую пачку трижды, — то есть ни одна рассылка её не везла.
        { eventRepeat: 2 },
      ),
    );
    await match.tick(12);

    expect(match.a.facts).toEqual([]);
    expect(match.a.client.metrics.eventBatchesDelivered).toBe(0);
    // Контроль два. Первый: событие БЫЛО — своей команде каст доехал. Второй:
    // враг у A виден, то есть молчание не от того, что он остался в тумане.
    expect(match.b.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(marksIn(match.a.client.latest!)).toEqual([1]);
  });

  it('шина в кадре отобрана тем же вызовом, что и поток (NET-18, NTR-15)', async () => {
    // Каст невидимого врага НА тике рассылки: если бы шина кадра отбиралась
    // отдельно от потока (или не отбиралась вовсе), утечка приехала бы
    // состоянием в обход потока событий. Проверяется поэтому КАДР НА ПРОВОДЕ, а
    // не поверхность клиента: презентационная проекция шину не отдаёт вовсе
    // (NTR-15), и через неё утечку было бы не видно.
    const match = await playing(
      eventConfig({
        marks: [{ id: 1, visibleTo: ONLY_B }],
        emits: [{ mark: 1, tick: 4, type: 'Cast' }],
      }),
    );
    await match.tick(6);

    const frameA = snapshotsOnWire(match.a).find((message) => message.tick === 4)!;
    expect(frameA.snapshot.events).toEqual([]);
    expect(eventsOnWire(match.a).flatMap((message) => message.batches)).toEqual([]);
    expect(match.a.facts).toEqual([]);

    // Контроль: у команды врага и шина кадра, и поток несут один и тот же факт —
    // отбор один, а не два разных с разными предикатами.
    const frameB = snapshotsOnWire(match.b).find((message) => message.tick === 4)!;
    expect(frameB.snapshot.events.map((event) => event.type)).toEqual(['Cast']);
    expect(match.b.facts).toEqual([{ epoch: 0, tick: 4, types: ['Cast'] }]);
  });
});

describe('поток событий на границе: ненадёжный канал (NTR-2, NTR-15)', () => {
  const lossyConfig = (): MatchConfig =>
    eventConfig(
      { marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: 3, type: 'Cast' }] },
      { eventRepeat: 2 },
    );

  it('одна потеря чинится повтором: факт доехал, разрыв не засчитан', async () => {
    // Роняется единственное сообщение, которое везёт пачку тика 3 ПЕРВЫМ.
    // Следующее повторяет её — за это избыточность и заведена.
    const match = await playing(lossyConfig(), { a: verdictOn('Events', [1], 'drop') });
    await match.tick(10);

    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
    // Контроль: уроненное сообщение действительно везло пачку — иначе проверка
    // была бы о том, что ничего не терялось.
    const dropped = match.a.tap.seen.filter((message) => message.type === 'Events')[1]!;
    expect(dropped.batches.map((batch) => batch.tick)).toEqual([3]);
    expect(eventsOnWire(match.a)).toHaveLength(4);
  });

  it('потерь больше глубины повтора — счётчик разрывов вырос, факт потерян названно', async () => {
    const match = await playing(lossyConfig(), { a: verdictOn('Events', [1, 2, 3], 'drop') });
    await match.tick(10);

    // Ни догадки, ни запроса: дыра названа и посчитана, а не заглажена.
    expect(match.a.facts).toEqual([]);
    expect(match.a.client.metrics.eventRangeGaps).toBe(1);
    // Контроль: у клиента B тот же матч на исправном канале — факт доехал.
    expect(match.b.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
  });

  it('переставленное сообщение приезжает после более поздних и отбрасывается по курсору', async () => {
    const match = await playing(lossyConfig(), { a: verdictOn('Events', [1], 'hold') });
    await match.tick(4);
    // Сообщение рассылки тика 4 канал задержал: факта пока нет.
    expect(match.a.facts).toEqual([]);

    await match.tick(2);
    // Его повтор в рассылке тика 6 приехал вовремя — факт применён.
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    const droppedBefore = match.a.client.metrics.eventBatchesDropped;

    await match.release(match.a);
    // Задержанное приехало последним. Порядок сообщений на проводе значения не
    // имеет: правило однократности держит курсор получателя, а не вера в канал.
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventBatchesDropped).toBe(droppedBefore + 1);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });

  it('тик, доставленный дважды, применяется один раз', async () => {
    // Дубль с двух сторон сразу: сервер повторяет пачку по избыточности, а канал
    // сверх того доставляет одно сообщение дважды (NTR-2).
    const match = await playing(lossyConfig(), { a: verdictOn('Events', [1], 'twice') });
    await match.tick(10);

    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventBatchesDelivered).toBe(1);
    // Пачка тика 3 приехала четырежды (три рассылки плюс дубль канала) — и три
    // раза отброшена: звук и VFX играются ровно один раз.
    expect(match.a.client.metrics.eventBatchesDropped).toBe(3);
  });

  it('устаревший снапшот отброшен, а события того же тика применены', async () => {
    // Канал держит снапшот тика 4 и весь поток, а снапшот тика 6 пропускает.
    // Задержанное отпускается разом, в порядке отправки: у состояния и у фактов
    // правила отбрасывания противоположны, и одно опоздание разводит их.
    const match = await playing(
      eventConfig({ marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: 4, type: 'Cast' }] }),
      {
        a: (message, nth) =>
          message.type === 'Events' || (message.type === 'Snapshot' && nth === 1) ? 'hold' : 'pass',
      },
    );
    await match.tick(6);

    expect(match.a.client.latest!.tick).toBe(6);
    expect(match.a.facts).toEqual([]);

    await match.release(match.a);
    // Снапшот тика 4 доехал после применённого тика 6 — пара не больше, он
    // отброшен и картинка назад не прыгнула.
    expect(match.a.client.metrics.snapshotsDropped).toBe(1);
    expect(match.a.client.latest!.tick).toBe(6);
    // А события ТОГО ЖЕ тика применены: курсор потока до них ещё не дошёл.
    // Один курсор на двоих вернул бы потерю с другой стороны.
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 4, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });
});

describe('поток событий на границе: тишина и конец матча (NTR-15)', () => {
  it('рассылка без событий доезжает, курсор идёт вперёд, разрыв не засчитан', async () => {
    const match = await playing(
      eventConfig({ marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: 9, type: 'Cast' }] }),
    );
    await match.tick(12);

    // Диапазоны смежны и покрывают КАЖДЫЙ тик матча, включая тики без событий:
    // без пустых сообщений получатель обязан был бы трактовать тишину как
    // «ничего не произошло», то есть молча принимать потерю за отсутствие факта.
    expect(rangesOf(eventsOnWire(match.a))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
      [11, 12],
    ]);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 9, types: ['Cast'] }]);
    // Курсор шёл по объявленным диапазонам, а не по последней непустой пачке:
    // иначе рассылка тика 10 началась бы позже курсора и считалась бы разрывом.
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
    expect(match.a.client.metrics.eventBatchesDropped).toBe(0);
  });

  it('события последнего тика доезжают раньше End', async () => {
    // Матч кончается по-настоящему — порогом молчания слота (NTR-6), а не
    // вызовом остановки в тесте: события тиков 5 и 6 рассылкой не покрыты
    // (рассылка на каждом четвёртом), и без слива перед `End` они пропали бы.
    const match = await playing(
      eventConfig(
        {
          marks: [{ id: 1, visibleTo: BOTH }],
          emits: [
            { mark: 1, tick: 5, type: 'Cast' },
            { mark: 1, tick: 6, type: 'EntityDied' },
          ],
        },
        { snapshotRate: 15, silenceTicks: 5 },
      ),
    );
    await match.tick(6);

    expect(match.server.phase).toBe('ended');
    expect(match.a.client.phase).toBe('closed');
    expect(match.a.client.closeReason).toBe('ended');
    // Порядок на проводе: поток раньше `End`, соединение закрывается после.
    expect(match.a.tap.wire.slice(-2).map((message) => message.type)).toEqual(['Events', 'End']);
    expect(match.a.facts).toEqual([
      { epoch: 0, tick: 5, types: ['Cast'] },
      { epoch: 0, tick: 6, types: ['EntityDied'] },
    ]);
    // Матч кончается событием — потерять именно его и значит потерять то
    // единственное, ради чего поток заведён.
    expect(rangesOf(eventsOnWire(match.a)).slice(-1)).toEqual([[5, 6]]);
  });
});

describe('поток событий на границе: перемотка (NTR-16, шов с rewind-epoch)', () => {
  const REWIND_TO = 6;
  /** Тик, переисполняемый после возобновления: он публикует событие в ОБЕИХ ветвях. */
  const REPLAYED = REWIND_TO + 1;

  function rewoundConfig(): MatchConfig {
    return eventConfig(
      { marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: REPLAYED, type: 'Cast' }] },
      { eventRepeat: 2, rewind: { interval: 1, capacity: 64 } },
    );
  }

  /** Единственный разрешённый флоу (NET-11, WSM-2) — тот же, что в `rewind.test.ts`. */
  async function rewind(match: Match, to: number): Promise<void> {
    match.server.pause();
    match.server.beginRewind();
    match.server.seekTo(to);
    match.server.pause();
    match.server.resume();
    await match.deliver();
  }

  it('событие переисполненного тика доезжает и применяется, хотя его номер не выше курсора', async () => {
    const match = await playing(rewoundConfig());
    await match.tick(10);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: REPLAYED, types: ['Cast'] }]);

    await rewind(match, REWIND_TO);
    await match.tick(4);

    // Тот же номер тика, другая ветвь истории. Курсор «номер последнего
    // применённого тика» погасил бы это событие на всю глубину отката — то есть
    // NET-14 оказался бы неисполним ровно там, где ульта и применяется.
    expect(match.a.facts).toEqual([
      { epoch: 0, tick: REPLAYED, types: ['Cast'] },
      { epoch: 1, tick: REPLAYED, types: ['Cast'] },
    ]);
    expect(match.a.client.epoch).toBe(1);
    // Перемотка наблюдаема с обеих сторон и дефектом канала не является: рост
    // эпохи разрывом диапазона не считается.
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });

  it('пачка стёртой эпохи, доехавшая повтором после смены эпохи, отбрасывается по паре', async () => {
    // Канал держит последнее сообщение прежней эпохи и отпускает его уже после
    // того, как клиент принял диапазон новой.
    const match = await playing(rewoundConfig(), { a: verdictOn('Events', [4], 'hold') });
    await match.tick(10);
    await rewind(match, REWIND_TO);
    // Ровно две рассылки новой эпохи: курсор встал на тик 8, а задержанное
    // сообщение прежней эпохи объявляет диапазон до тика 10. По ОДНОМУ номеру
    // тика оно выглядит свежим — отбрасывает его только сравнение пары.
    await match.tick(2);
    expect(match.a.facts).toContainEqual({ epoch: 1, tick: REPLAYED, types: ['Cast'] });

    const droppedBefore = match.a.client.metrics.eventBatchesDropped;
    const factsBefore = [...match.a.facts];
    await match.release(match.a);

    // По паре `(эпоха, тик)` она меньше курсора — принять её нельзя, и второй
    // раз тот же факт не проигрывается.
    expect(match.a.facts).toEqual(factsBefore);
    expect(match.a.client.metrics.eventBatchesDropped).toBe(droppedBefore + 1);
    // И это не разрыв: сам переход эпохи не растит счётчик дефектов канала.
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });

  it('тики внутреннего реплея не порождают ни одного доставленного факта (REW-4, OBS-5)', async () => {
    // Интервал истории 4: `seekTo(3)` восстанавливает снапшот тика 0 и
    // ДОИГРЫВАЕТ тики 1..3 реплеем, то есть публикует каст тика 3 повторно.
    const match = await playing(
      eventConfig(
        { marks: [{ id: 1, visibleTo: BOTH }], emits: [{ mark: 1, tick: 3, type: 'Cast' }] },
        { eventRepeat: 2, rewind: { interval: 4, capacity: 32 } },
      ),
    );
    await match.tick(8);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);

    match.server.pause();
    match.server.beginRewind();
    match.server.seekTo(3);
    expect(match.server.tick).toBe(3);
    await match.deliver();

    // Скраб не доставил ни одного факта: сетевой слой — потребитель `TickResult`
    // живых тиков, и переисполненные тики ему не видны по построению.
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventBatchesDelivered).toBe(1);

    // Контроль, ради которого скраб взят именно на тик публикации: реплей каст
    // ДЕЙСТВИТЕЛЬНО переиздал — он лежит в шине восстановленного кадра. Шина в
    // кадре при этом источником фактов не является (NTR-15), и потому
    // повторного проигрывания из неё не будет.
    const restored = snapshotsOnWire(match.a).slice(-1)[0]!;
    expect(restored).toMatchObject({ epoch: 1, tick: 3 });
    expect(restored.snapshot.events.map((event) => event.type)).toEqual(['Cast']);

    match.server.pause();
    match.server.resume();
    await match.tick(4);
    expect(match.a.facts).toEqual([{ epoch: 0, tick: 3, types: ['Cast'] }]);
    expect(match.a.client.metrics.eventRangeGaps).toBe(0);
  });
});
