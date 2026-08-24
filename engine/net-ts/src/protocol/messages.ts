/**
 * Закрытый набор сообщений протокола (NTR-4) и разбор входящего.
 *
 * Разбор живёт здесь, а не в сервере: сообщение с провода недоверенное, и
 * граница, на которой оно становится доверенным, обязана быть одна. Цена
 * пропущенной проверки видна в ядре: `InputSystem` бросает на неизвестном
 * игроке и на фрейме слота без живой сущности (TICK-5), то есть непроверенный
 * ввод роняет весь матч, включая честного игрока, а не одного отправителя.
 *
 * `playerId` во входящем кадре ввода отсутствует намеренно: личность даёт
 * соединение, а не содержимое сообщения. Поле в кадре означало бы, что клиент
 * вправе назваться чужим слотом, и это пришлось бы отдельно опровергать.
 */
import { snapshotToPlain } from '@fluxus/core';
import type {
  Fixed,
  GameEvent,
  InputFrame,
  PlainSnapshot,
  ScenarioSpawn,
  Snapshot,
} from '@fluxus/core';

/** Пара версии игры (NET-16): непрозрачный идентификатор сборки и хеш контент-пака (NET-17). */
export interface GameVersion {
  readonly buildId: string;
  readonly contentPackHash: string;
}

/**
 * Исходы отказа во входе. Половина версии названа отдельно (NET-16): «обновить
 * сборку» и «обновить контент» — разные действия игрока, и это единственная
 * причина, по которой версия является парой, а не строкой.
 */
export type RejectReason =
  | 'build-mismatch'
  | 'content-mismatch'
  | 'match-in-progress'
  | 'unknown-player'
  | 'slot-taken'
  | 'observer-not-allowed'
  | 'protocol-error';

export type EndReason = 'player-silent' | 'player-left' | 'server-stopped';

/** Исходы, по которым соединение рвёт сам клиент. Отделены от `RejectReason`: это его решение, не серверное. */
export type ClientCloseReason = 'data-mismatch' | 'rejected' | 'ended' | 'protocol-error';

/**
 * Кадр ввода на проводе (TICK-2) — плоский: `Vec2` разложен в пару полей, чтобы
 * форма кадра не зависела от того, как ядро упаковывает вектор.
 */
export interface WireInput {
  readonly tick: number;
  readonly seq: number;
  readonly moveX: Fixed;
  readonly moveY: Fixed;
  readonly aimDir: Fixed;
  /**
   * Точка прицела (TICK-2) — ПЛОСКОЙ парой полей рядом с `moveX`/`moveY`, по
   * тому же основанию: форма кадра не зависит от того, как ядро упаковывает
   * вектор.
   *
   * Пара необязательна и едет целиком или не едет вовсе: половина точки — не
   * точка. Отсутствие означает «источник точкой не владел» и до ядра доезжает
   * отсутствием поля `target`, а не нулями — иначе клиент, у которого прицела
   * нет вовсе, сообщал бы прицеливание в начало координат.
   *
   * Номера шага, длины цепочки и накопленных ранее шагов провод не несёт
   * (TICK-2): накопление живёт в полях сущности-слота (`ability-system`
   * ABIL-5), и цепочка любой длины остаётся данными сцены.
   */
  readonly targetX?: Fixed;
  readonly targetY?: Fixed;
  readonly buttons: number;
}

// ------------------------------------------------------------ client → server

export interface HelloMessage {
  readonly type: 'Hello';
  readonly playerId: string;
  readonly version: GameVersion;
  readonly observer: boolean;
}

/**
 * Эпоха живёт на сообщении, а не на `WireInput`: `InputFrame` — контракт ядра
 * (TICK-2), он едет в канонический `inputs[]` и в golden-эталоны, а эпоха —
 * величина слоя матча (NTR-16). Это эпоха, против которой ввод порождён, то
 * есть эпоха последнего применённого клиентом снапшота (NTR-7).
 */
export interface InputMessage {
  readonly type: 'Input';
  readonly epoch: number;
  readonly frames: readonly WireInput[];
}

export interface ByeMessage {
  readonly type: 'Bye';
  readonly reason: string;
}

export type ClientMessage = HelloMessage | InputMessage | ByeMessage;

// ------------------------------------------------------------ server → client

/**
 * Данные конкретного матча (NET-16): сцена названа ссылкой, потому что она —
 * контент-пак, а раздавать контент-пак матча сервер MUST NOT. Стартовая
 * расстановка едет значением: это данные матча, а не правила.
 */
export interface MatchDescriptor {
  readonly sceneRef: string;
  readonly initial: readonly ScenarioSpawn[];
}

export interface Pacing {
  readonly tickRate: number;
  readonly snapshotRate: number;
  readonly inputDelay: number;
  /** Верхняя граница окна приёма ввода в тиках (NTR-7): конечная и заданная конфигом матча, а не клиентом. */
  readonly inputWindow: number;
  /**
   * Глубина повтора потока событий (NTR-15): сколько ПРЕДЫДУЩИХ рассылок
   * повторяет каждое сообщение `Events`. `0` — без повтора. Клиент по нему
   * ничего не решает — однократность держит его курсор, — но без него
   * диагностика разрыва диапазона не читается: разрыв при глубине 2 и разрыв
   * при глубине 0 суть разные наблюдения об одном и том же канале.
   */
  readonly eventRepeat: number;
}

export interface WelcomeMessage {
  readonly type: 'Welcome';
  readonly slot: number;
  readonly players: readonly string[];
  readonly seed: number;
  readonly match: MatchDescriptor;
  readonly worldInitHash: string;
  readonly pacing: Pacing;
}

export interface RejectMessage {
  readonly type: 'Reject';
  readonly reason: RejectReason;
  readonly detail: string;
}

export interface StartMessage {
  readonly type: 'Start';
  readonly tick: number;
}

/**
 * Персональный снапшот НА ПРОВОДЕ (NET-18) — проекция снапшота мира (SNAP-1), а
 * не он сам. Состав перечислен, а не унаследован: `Pick`, а не `Omit`, потому что
 * норма звучит как «на провод едет перечисленное», и новая часть, добавленная в
 * снапшот мира ради перемотки или диагностики, обязана попасть на провод только
 * будучи названной здесь и в NET-18, а не молча приехать вместе с типом.
 *
 * В проекцию входят данные ECS уцелевших после фильтрации по видимости (NET-12)
 * вместе со схемой идентификаторов персональной копии (ID-4), номер тика, машина
 * состояний мира (WSM-1, NET-11, SHELL-7) и шина этого тика, отобранная тем же
 * предикатом, что и поток `Events` (NET-13, NTR-15).
 *
 * Состояний стримов RNG (RNG-5) здесь нет и быть не может: состояние стрима есть
 * вся его будущая последовательность, то есть каждый будущий крит и разброс до
 * того, как они произойдут. Это утечка того же класса, что видимый в снапшоте
 * невидимый враг, но видимостью не ограниченная вовсе, а клиенту она не нужна —
 * он не исполняет `tick()` (NTR-10). Тому, кому нужно воспроизвести симуляцию,
 * служит канонический лог матча (NTR-8), а не поток снапшотов.
 *
 * Плоская форма ядра при этом не делится на две: `PlainSnapshot` обслуживает
 * вывод CLI (CLI-3, где `rng` обязателен), а кадр строится из её подмножества —
 * работа сетевого слоя, потому что «снапшот без rng» осмыслен только относительно
 * провода, о котором ядро не знает (DI-3).
 */
export type WireSnapshot = Pick<PlainSnapshot, 'tick' | 'world' | 'events' | 'mode'>;

/**
 * Проекция на провод из персонального снапшота, отданного фильтром ядра.
 *
 * Исключение действует для ВСЕХ получателей, включая соединение наблюдателя
 * (`viewpoint = ALL`, NET-15): отдельной ветки «спектейтору можно всё» здесь нет,
 * потому что основание исключения не видимость, а назначение потока — снапшот на
 * проводе есть представление, и ни один его получатель не тикает.
 *
 * ponytail: `snapshotToPlain` попутно перекладывает и состояния стримов, которые
 * тут же выбрасываются, — лишняя копия нескольких мелких массивов на кадр.
 * Убирается она узким входом ядра, а не правкой по ходу сетевой работы (NTR-1):
 * плоская форма ядра одна, и разделять её надвое ради байтов рано.
 */
export function toWireSnapshot(snapshot: Snapshot): WireSnapshot {
  const plain = snapshotToPlain(snapshot);
  return { tick: plain.tick, world: plain.world, events: plain.events, mode: plain.mode };
}

/**
 * Номер авторитетного состояния — пара `(epoch, tick)` (NTR-16): номер тика при
 * перемотке идёт назад, и один он состояние не называет.
 *
 * Эпоха едет ПОЛЕМ СООБЩЕНИЯ, рядом с проекцией, а не внутри неё (NET-18): она
 * свойство истории матча, а не мира, и в состояние мира не входит.
 */
export interface SnapshotMessage {
  readonly type: 'Snapshot';
  readonly epoch: number;
  readonly tick: number;
  readonly snapshot: WireSnapshot;
}

/**
 * События одного тика на проводе: номер тика и его отобранная шина в порядке
 * публикации (EVT-2). Порядок внутри пачки значим и потому передаётся списком,
 * а не картой: карта отдала бы упорядочивание сериализатору.
 */
export interface EventBatch {
  readonly tick: number;
  readonly events: readonly GameEvent[];
}

/**
 * Поток фактов тиков (NTR-15) — отдельное сообщение закрытого набора (NTR-4), а
 * не поле снапшота: у состояния и у фактов противоположные правила
 * отбрасывания, и одно сообщение вынуждало бы одно правило на двоих.
 *
 * `from`..`to` — ЗАМКНУТЫЙ диапазон покрытых тиков, и покрыт он полностью: тик
 * внутри диапазона, пачки которого в `batches` нет, означает «на этом тике
 * событий не было», а не «пачка потерялась». Отсюда же пустое сообщение на
 * рассылке без событий: без объявленного диапазона тишина и потеря
 * неразличимы.
 *
 * `epoch` — эпоха ВСЕГО диапазона, одно поле на сообщение (NTR-16). Диапазон
 * SHALL NOT пересекать границу эпохи: объявленный диапазон есть утверждение о
 * полном покрытии, а через границу перемотки один номер тика принадлежит двум
 * ветвям, и «покрыт полностью» перестаёт что-либо значить. Значит на смене
 * эпохи диапазон закрывается, и следующее сообщение открывает новый — с
 * эпохой новой ветви. Свойство структурное: на разборе проверять нечего сверх
 * того, что `from`/`to`/`tick` — числа одного объявленного диапазона, а
 * соблюдение этого при формировании сообщения держит сервер (задачи 3.8 и 3.9
 * этого изменения).
 *
 * Потолка на число пачек здесь нет намеренно, в отличие от `Input`
 * (`MAX_FRAMES_PER_MESSAGE`): границы накопления NTR-15 меряет в тиках, а не в
 * событиях и не в байтах, и молча укороченная пачка есть ровно та потеря,
 * против которой требование написано. Размер получившегося кадра — забота
 * реализации транспорта (NTR-2).
 */
export interface EventsMessage {
  readonly type: 'Events';
  readonly epoch: number;
  readonly from: number;
  readonly to: number;
  readonly batches: readonly EventBatch[];
}

export interface EndMessage {
  readonly type: 'End';
  readonly reason: EndReason;
  readonly tick: number;
}

export type ServerMessage =
  | WelcomeMessage
  | RejectMessage
  | StartMessage
  | SnapshotMessage
  | EventsMessage
  | EndMessage;

// ------------------------------------------------------------------- разбор

/** Отказ разбора. Несёт исход, который уедет в `Reject` до разрыва (NTR-4). */
export class ProtocolError extends Error {
  readonly reason: RejectReason;

  constructor(message: string, reason: RejectReason = 'protocol-error') {
    super(message);
    this.name = 'ProtocolError';
    this.reason = reason;
  }
}

/** Ширина `buttons` нормирована TICK-2 и здесь только повторяется, а не переопределяется. */
const BUTTONS_MAX = 65535;
/** Границы i32: поля Q16.16 приезжают в контейнере i32 (FP-1). */
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function str(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new ProtocolError(`${what}: поле "${key}" — непустая строка`);
  }
  return value;
}

function int(source: Record<string, unknown>, key: string, what: string, lo: number, hi: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new ProtocolError(`${what}: поле "${key}" — целое в [${lo}, ${hi}]`);
  }
  return value;
}

function version(value: unknown): GameVersion {
  const source = object(value, 'Hello.version');
  return {
    buildId: str(source, 'buildId', 'Hello.version'),
    contentPackHash: str(source, 'contentPackHash', 'Hello.version'),
  };
}

/**
 * Кадр ввода с провода. Проверяется всё, на что дальше по стеку полагается
 * ядро: `buttons` в пределах u16 (TICK-2), поля Q16.16 в пределах i32 (FP-1),
 * номер тика и `seq` — неотрицательные целые. Окно допустимых тиков зависит от
 * текущего тика матча и потому проверяется сервером, а не здесь.
 *
 * Точка прицела проверяется тем же диапазоном i32 (NTR-7, FP-1) — это и есть
 * «область мировых координат, представимая в Q16.16» из `input-devices` INP-3,
 * увиденная с транспортной границы. Геймплейных границ — дальности
 * способности, границы арены — здесь нет и быть не может: это политика
 * симуляции (ABIL-5), и обрезать по ней на входе значило бы решать её за
 * сервер матча.
 */
function wireInput(value: unknown): WireInput {
  const source = object(value, 'Input.frames[]');
  const target = wireTarget(source);
  return {
    tick: int(source, 'tick', 'Input.frames[]', 0, Number.MAX_SAFE_INTEGER),
    seq: int(source, 'seq', 'Input.frames[]', 0, Number.MAX_SAFE_INTEGER),
    moveX: int(source, 'moveX', 'Input.frames[]', I32_MIN, I32_MAX),
    moveY: int(source, 'moveY', 'Input.frames[]', I32_MIN, I32_MAX),
    aimDir: int(source, 'aimDir', 'Input.frames[]', I32_MIN, I32_MAX),
    ...target,
    buttons: int(source, 'buttons', 'Input.frames[]', 0, BUTTONS_MAX),
  };
}

/**
 * Необязательная пара точки прицела: обе половины или ни одной. Половина —
 * отказ разбора, а не молча выброшенная координата: кадр с одним `targetX`
 * означает дефект отправителя, и принять его значило бы отдать способности
 * координату, второй у которой не будет.
 */
function wireTarget(source: Record<string, unknown>): { targetX?: Fixed; targetY?: Fixed } {
  const hasX = source.targetX !== undefined;
  const hasY = source.targetY !== undefined;
  if (!hasX && !hasY) return {};
  if (hasX !== hasY) {
    throw new ProtocolError('Input.frames[]: точка прицела едет парой "targetX"/"targetY"');
  }
  return {
    targetX: int(source, 'targetX', 'Input.frames[]', I32_MIN, I32_MAX),
    targetY: int(source, 'targetY', 'Input.frames[]', I32_MIN, I32_MAX),
  };
}

/** Потолок кадров в одном сообщении: пачка на порядок больше буфера задержки — уже не догоняющий клиент, а мусор. */
const MAX_FRAMES_PER_MESSAGE = 64;

export function parseClientMessage(value: unknown): ClientMessage {
  const source = object(value, 'сообщение');
  const type = source.type;
  switch (type) {
    case 'Hello':
      return {
        type: 'Hello',
        playerId: str(source, 'playerId', 'Hello'),
        version: version(source.version),
        observer: source.observer === true,
      };
    case 'Input': {
      const frames = source.frames;
      if (!Array.isArray(frames)) throw new ProtocolError('Input: поле "frames" — массив');
      if (frames.length === 0) throw new ProtocolError('Input: пустой массив кадров');
      if (frames.length > MAX_FRAMES_PER_MESSAGE) {
        throw new ProtocolError(`Input: больше ${MAX_FRAMES_PER_MESSAGE} кадров в сообщении`);
      }
      // Эпоха проверяется тем же способом, что и номер тика: целое,
      // неотрицательное. Отсутствующее поле — разрыв соединения (NTR-4), а не
      // умолчание: молча подставленный ноль означал бы, что ввод из стёртой
      // перемоткой ветви истории приезжает помеченным нулевой эпохой и
      // проходит проверку сервера у любого клиента постарше протокола.
      return {
        type: 'Input',
        epoch: int(source, 'epoch', 'Input', 0, Number.MAX_SAFE_INTEGER),
        frames: frames.map(wireInput),
      };
    }
    case 'Bye':
      return { type: 'Bye', reason: typeof source.reason === 'string' ? source.reason : '' };
    default:
      // Молча проигнорированное сообщение отлаживается по эффекту, а не по
      // сообщению — тот же принцип, по которому `InputSystem` не отбрасывает
      // фрейм без сущности (NTR-4, TICK-5).
      throw new ProtocolError(`неизвестный тип сообщения: ${JSON.stringify(type)}`);
  }
}

/**
 * Данные события с провода: ПЛОСКАЯ карта чисел (OBS-1). Вложенный объект,
 * массив и строка отвергаются, а не сплющиваются: форма `GameEvent.data`
 * нормирована ядром, и провод её расширять не вправе.
 *
 * Проверяется конечность, а не целочисленность: `Record<string, number>` —
 * контракт ядра, и сужать его на границе значило бы завести на проводе вторую,
 * более строгую норму состава события. `NaN` и `Infinity` при этом не проходят:
 * они не число ни в одном смысле, полезном получателю.
 */
function eventData(value: unknown): Record<string, number> {
  const source = object(value, 'Events.batches[].events[].data');
  for (const key of Object.keys(source)) {
    const field = source[key];
    if (typeof field !== 'number' || !Number.isFinite(field)) {
      throw new ProtocolError(
        `Events.batches[].events[].data: поле "${key}" — число (OBS-1: плоская карта чисел)`,
      );
    }
  }
  return source as Record<string, number>;
}

function gameEvent(value: unknown): GameEvent {
  const source = object(value, 'Events.batches[].events[]');
  return {
    type: str(source, 'type', 'Events.batches[].events[]'),
    data: eventData(source.data),
  };
}

/**
 * Пачка одного тика. Номер тика проверяется по объявленному диапазону, а не
 * сам по себе: тик вне `from`..`to` означает сообщение, диапазон которого не
 * описывает его собственное тело, и принять такое — значит принять покрытие,
 * которого нет (NTR-15).
 */
function eventBatch(value: unknown, from: number, to: number): EventBatch {
  const source = object(value, 'Events.batches[]');
  const events = source.events;
  if (!Array.isArray(events)) throw new ProtocolError('Events.batches[]: поле "events" — массив');
  return {
    tick: int(source, 'tick', 'Events.batches[]', from, to),
    events: events.map(gameEvent),
  };
}

/**
 * Проекция с провода — теми же перечисленными частями, что и на отправке
 * (NET-18). Перечисление здесь не только симметрия: части ВЫБИРАЮТСЯ по именам, и
 * поэтому состояния стримов, приехавшие от сервера постарше нормы или от чужой
 * сборки, в декодированный кадр не попадают ни при каком `viewpoint` — а не
 * попадают потому, что их некуда положить.
 *
 * Глубоко плоская форма мира здесь не проверяется, как не проверялась и до
 * появления перечисления: её восстанавливает `snapshotFromPlain` ядра, и битая
 * форма даёт клиенту исход «снапшот не восстанавливается» (NTR-5), а не тихую
 * потерю поля.
 */
function wireSnapshot(value: unknown): WireSnapshot {
  const source = object(value, 'Snapshot.snapshot');
  return {
    tick: int(source, 'tick', 'Snapshot.snapshot', 0, Number.MAX_SAFE_INTEGER),
    world: source.world as WireSnapshot['world'],
    events: source.events as WireSnapshot['events'],
    mode: source.mode as WireSnapshot['mode'],
  };
}

/** Симметричный разбор на клиенте: сервер тоже недоверен ровно в той мере, в какой недоверен провод. */
export function parseServerMessage(value: unknown): ServerMessage {
  const source = object(value, 'сообщение');
  const type = source.type;
  switch (type) {
    case 'Welcome': {
      const match = object(source.match, 'Welcome.match');
      const initial = match.initial;
      const players = source.players;
      const pacing = object(source.pacing, 'Welcome.pacing');
      if (!Array.isArray(players) || players.some((p) => typeof p !== 'string')) {
        throw new ProtocolError('Welcome: поле "players" — массив строк');
      }
      if (!Array.isArray(initial)) throw new ProtocolError('Welcome.match: поле "initial" — массив');
      return {
        type: 'Welcome',
        slot: int(source, 'slot', 'Welcome', 0, players.length - 1),
        players: players as readonly string[],
        seed: int(source, 'seed', 'Welcome', I32_MIN, I32_MAX),
        match: {
          sceneRef: str(match, 'sceneRef', 'Welcome.match'),
          initial: initial as readonly ScenarioSpawn[],
        },
        worldInitHash: str(source, 'worldInitHash', 'Welcome'),
        pacing: {
          tickRate: int(pacing, 'tickRate', 'Welcome.pacing', 1, 1000),
          snapshotRate: int(pacing, 'snapshotRate', 'Welcome.pacing', 1, 1000),
          inputDelay: int(pacing, 'inputDelay', 'Welcome.pacing', 0, 1000),
          inputWindow: int(pacing, 'inputWindow', 'Welcome.pacing', 0, 1000),
          eventRepeat: int(pacing, 'eventRepeat', 'Welcome.pacing', 0, 1000),
        },
      };
    }
    case 'Reject':
      return {
        type: 'Reject',
        reason: str(source, 'reason', 'Reject') as RejectReason,
        detail: typeof source.detail === 'string' ? source.detail : '',
      };
    case 'Start':
      return { type: 'Start', tick: int(source, 'tick', 'Start', 0, Number.MAX_SAFE_INTEGER) };
    case 'Snapshot':
      return {
        type: 'Snapshot',
        epoch: int(source, 'epoch', 'Snapshot', 0, Number.MAX_SAFE_INTEGER),
        tick: int(source, 'tick', 'Snapshot', 0, Number.MAX_SAFE_INTEGER),
        snapshot: wireSnapshot(source.snapshot),
      };
    case 'Events': {
      const batches = source.batches;
      if (!Array.isArray(batches)) throw new ProtocolError('Events: поле "batches" — массив');
      // Пустой массив пачек легален и штатен: сообщение уходит на каждой
      // рассылке, в том числе когда во всём диапазоне не оказалось ни одного
      // события (NTR-15). Потолка на число пачек нет — см. `EventsMessage`.
      const from = int(source, 'from', 'Events', 0, Number.MAX_SAFE_INTEGER);
      const to = int(source, 'to', 'Events', from, Number.MAX_SAFE_INTEGER);
      return {
        type: 'Events',
        // Эпоха диапазона — одно поле на сообщение (NTR-16), проверяемое тем же
        // способом, что и номер тика. Отсутствующее поле — разрыв соединения
        // (NTR-4), а не умолчание: пачки стёртой перемоткой ветви приехали бы
        // помеченными нулевой эпохой и прошли бы курсор получателя.
        epoch: int(source, 'epoch', 'Events', 0, Number.MAX_SAFE_INTEGER),
        from,
        to,
        batches: batches.map((batch) => eventBatch(batch, from, to)),
      };
    }
    case 'End':
      return {
        type: 'End',
        reason: str(source, 'reason', 'End') as EndReason,
        tick: int(source, 'tick', 'End', 0, Number.MAX_SAFE_INTEGER),
      };
    default:
      throw new ProtocolError(`неизвестный тип сообщения: ${JSON.stringify(type)}`);
  }
}

/** Кадр с провода становится каноническим вводом ядра, получая личность от соединения (NTR-7). */
export function toInputFrame(wire: WireInput, playerId: string, tick: number): InputFrame {
  return {
    tick,
    playerId,
    seq: wire.seq,
    move: { x: wire.moveX, y: wire.moveY },
    aimDir: wire.aimDir,
    // Точка появляется в кадре ядра, только если приехала: канонический
    // `inputs[]` пишется отсюда (NTR-8), и подставленные нули отличали бы
    // запись матча от записи того же матча до появления поля (CLI-10).
    ...(wire.targetX === undefined || wire.targetY === undefined
      ? {}
      : { target: { x: wire.targetX, y: wire.targetY } }),
    buttons: wire.buttons,
  };
}
