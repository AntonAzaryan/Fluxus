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
 * Роль соединения в слоте (NTR-18): владелец слота либо заместитель.
 *
 * Свойство СОЕДИНЕНИЯ, а не участника: сервер по-прежнему не отличает ботов от
 * людей (`bot-player` BOT-1) — он различает право на слот, и предъявить любую
 * роль технически может любая сторона.
 */
export type ConnectionRole = 'owner' | 'substitute';

/**
 * Исходы отказа во входе. Половина версии названа отдельно (NET-16): «обновить
 * сборку» и «обновить контент» — разные действия игрока, и это единственная
 * причина, по которой версия является парой, а не строкой.
 *
 * `match-ended` пришёл на смену прежнему «матч уже идёт»: идущий матч
 * участника ростера больше не отвергает — он принимает его реконнектом
 * (NTR-17), — и единственный матч, возвращаться в который некуда, это матч
 * завершённый (NTR-17, сценарий «Игрок вернулся слишком поздно»).
 */
export type RejectReason =
  | 'build-mismatch'
  | 'content-mismatch'
  | 'match-ended'
  | 'unknown-player'
  | 'slot-taken'
  /** Заместитель до `Start`: до старта слоты занимают владельцы (NTR-18). */
  | 'substitute-before-start'
  /** Заместитель вытеснен вернувшимся владельцем слота (NTR-18). */
  | 'displaced-by-owner'
  /**
   * Слот заперт админ-операцией (NTR-19): владельцу называется ЗАПРЕТ, а не
   * занятость. Отличимость от `slot-taken` — не косметика: занятый слот игрок
   * ждёт и пробует снова, а запрет ему сняли или не сняли, и это разные
   * действия дальше. Данными существующего `Reject`, а не новым сообщением:
   * набор закрыт (NTR-4).
   */
  | 'slot-barred'
  | 'observer-not-allowed'
  | 'protocol-error';

/**
 * Исходы конца матча. Добровольного «игрок вышел» здесь нет намеренно: `Bye` в
 * идущем матче отвязывает соединение от слота, а не завершает матч (NTR-6:
 * «Разрыв соединения игрока MUST NOT останавливать матч»), — дальше работают
 * порог молчания и политика сборки-основателя (`bot-player` BOT-14). Иначе
 * ушедший добровольно убивал бы матч в обход заместителя.
 */
export type EndReason = 'player-silent' | 'server-stopped';

/**
 * Требуемое действие в `PauseRequest` (NTR-20): поставить паузу либо снять её.
 * Двух значений хватает потому, что состояние паузы одно на матч, а не на
 * слот: «снять» относится к той паузе, которая стоит, кто бы её ни поставил.
 */
export type PauseAction = 'pause' | 'resume';

/**
 * Состояние паузы матча (NTR-20): исчерпывающий перечень из трёх значений —
 * ровно те, которые называет требование.
 *
 * - `running` — паузы нет, матч идёт;
 * - `frozen` — мир заморожен (`Running → Paused`, WSM-2), живых тиков нет;
 * - `resuming` — возобновление объявлено, идёт обратный отсчёт; мир всё ещё
 *   заморожен, и `Paused → Running` произойдёт по его истечении.
 *
 * Состояние — свойство МАТЧА, а не соединения: одно и то же значение уезжает
 * всем, включая наблюдателя (NTR-9).
 *
 * Перечень объявлен ЗНАЧЕНИЕМ, а тип выведен из него: разбор обязан перечень
 * проверить (HUD ветвится по этим значениям, HUD-9), а список, написанный
 * вторым разом для проверки, — это второе место, где закрытый набор может
 * разойтись сам с собой.
 */
export const PAUSE_STATES = ['running', 'frozen', 'resuming'] as const;

export type PauseState = (typeof PAUSE_STATES)[number];

/**
 * Именованные причины отказа в запросе паузы (NTR-20). Отказ — законное «нельзя
 * сейчас», а не нарушение протокола: он уезжает адресным `Pause` с неизменённым
 * состоянием и соединения MUST NOT рвать (решение D4 дизайна).
 *
 * Перечень закрыт по тому же основанию, что и набор сообщений (NTR-4): причина,
 * приехавшая свободной строкой, читалась бы человеком, а показывать её обязан
 * HUD (HUD-9).
 */
export const PAUSE_DENY_REASONS = [
  /** Матч ещё не начался или уже кончился — замораживать нечего. */
  'match-not-running',
  /** Мир в `Rewinding`: машина перемотки доигрывает свой флоу (NTR-20, WSM-2). */
  'rewinding',
  /** Запрос от соединения без игрового слота — наблюдателя (NTR-9). */
  'not-a-player',
  /** Бюджет пауз слота исчерпан (политика документа матча). */
  'budget-spent',
  /** Пауза уже стоит: повторная заморозка ничего не меняет. */
  'already-frozen',
  /** Возобновление уже объявлено — объявленный отсчёт доводится до конца. */
  'already-resuming',
  /** Снятие в идущем матче: снимать нечего. */
  'not-frozen',
  /** Чужую паузу противник вправе снять не раньше срока, названного политикой. */
  'too-early',
] as const;

export type PauseDenyReason = (typeof PAUSE_DENY_REASONS)[number];

/**
 * Исходы, по которым соединение рвёт сам клиент. Отделены от `RejectReason`:
 * это его решение, не серверное.
 *
 * `ended` и `disconnected` — разные исходы, и разница у них потребительская
 * (NTR-17): матч кончился сообщением `End`, возвращаться некуда, — против
 * «канал закрылся», после которого владелец слота вправе вернуться реконнектом.
 * Слитые в один исход, они заставляли бы сборку решать это по тексту.
 */
export type ClientCloseReason =
  | 'data-mismatch'
  | 'rejected'
  | 'ended'
  | 'disconnected'
  | 'protocol-error';

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
  /**
   * Роль соединения в слоте (NTR-18) — поле ОБЯЗАТЕЛЬНОЕ: свободных полей «на
   * будущее» и необязательных расширений набор не допускает (NTR-4), а
   * умолчание, подставленное разбором, означало бы согласование возможностей в
   * рантайме. Участники исполняют одну версию (NET-16), и смена формата
   * `Hello` — смена сборки.
   */
  readonly role: ConnectionRole;
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

/**
 * Запрос паузы матча (NTR-20) — отдельный тип закрытого набора (NTR-4), а не
 * бит в `Input`.
 *
 * Битом это выразить нельзя, и причина не в удобстве: кадры ввода в заморозке
 * отбрасываются целиком (NET-11, REW-5), то есть «снять паузу» не доехало бы
 * ровно в том состоянии, ради которого оно и посылается. Единственное
 * исключение из отбрасывания — контрольный бит ведения скраба (REW-5), и второе
 * исключение рядом с ним означало бы, что заморозка перестала быть заморозкой
 * ввода.
 */
export interface PauseRequestMessage {
  readonly type: 'PauseRequest';
  readonly action: PauseAction;
}

export interface ByeMessage {
  readonly type: 'Bye';
  readonly reason: string;
}

export type ClientMessage = HelloMessage | InputMessage | PauseRequestMessage | ByeMessage;

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

/**
 * `seed` в составе НЕТ намеренно (NTR-5, SES-4): клиент `tick()` не исполняет
 * (NTR-10), стартовый мир поднимает с нулём вместо присланного значения, и
 * контрольная сумма `worldInit` (DET-1) от него не зависит. Поле, которое никто
 * не читает, — то самое «свободное поле на будущее», которого NTR-4 не
 * допускает. Ростер (`players`), наоборот, клиенту жизненно нужен: без него он
 * не соберёт стартовый мир и не сверит контрольную сумму.
 */
export interface WelcomeMessage {
  readonly type: 'Welcome';
  readonly slot: number;
  readonly players: readonly string[];
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

/**
 * Состояние паузы матча (NTR-20). Одно сообщение на два назначения — объявление
 * смены состояния всем соединениям и адресный отказ запросившему, — и это не
 * экономия типов, а решение D4: `Reject` в этом протоколе рвёт соединение
 * (NTR-4, NTR-5), а «нельзя сейчас» соединения не рвёт.
 *
 * Отсчёт едет ДЛИТЕЛЬНОСТЬЮ, а не тиком и не моментом времени (решение D2):
 * тики в заморозке не исполняются, поэтому тикового отсчёта быть не может, а
 * общих часов у сервера с клиентом нет. Клиент ведёт визуальный отсчёт от
 * доставленной длительности (HUD-9); авторитетен момент фактического
 * возобновления — первый живой снапшот.
 */
export interface PauseMessage {
  readonly type: 'Pause';
  readonly state: PauseState;
  /**
   * Слот, чьё действие привело к этому состоянию; `-1` — сервер: пауза от
   * обвязки стенда, админ-пауза (`server-control` SRV-5) и самовозобновление по
   * истечении максимальной длительности паузы. Слота у них нет и выдумывать его
   * нельзя — HUD назвал бы игрока, который ничего не делал.
   */
  readonly slot: number;
  /** Остаток объявленного отсчёта возобновления в миллисекундах; вне `resuming` — 0. */
  readonly countdownMs: number;
  /**
   * Именованная причина отказа (NTR-20). Поля НЕТ — это объявление состояния, а
   * не отказ: два разных высказывания, и значение «не отказано» было бы третьим
   * состоянием там, где их два. Свободным расширением поле не является (NTR-4) —
   * его отсутствие несёт смысл, как отсутствие точки прицела в кадре ввода.
   */
  readonly denied?: PauseDenyReason;
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
  | PauseMessage
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

/**
 * Роль соединения с провода (NTR-18). Отсутствие поля и незнакомое значение —
 * `protocol-error`, а не умолчание «владелец»: молча подставленная роль дала бы
 * заместителю право владельца, то есть вытеснение чужого соединения по
 * невнимательности отправителя.
 */
function connectionRole(source: Record<string, unknown>): ConnectionRole {
  const value = source.role;
  if (value !== 'owner' && value !== 'substitute') {
    throw new ProtocolError('Hello: поле "role" — "owner" либо "substitute" (NTR-18)');
  }
  return value;
}

/**
 * Признак наблюдателя с провода (NTR-9). Поле обязательное, как и роль рядом:
 * оно названо в закрытом наборе (NTR-4), а «свободных полей на будущее,
 * необязательных расширений и согласования возможностей в рантайме MUST NOT
 * быть» — умолчание, подставленное разбором, и есть такое согласование.
 * Отдельным полем от роли оно является потому, что роль — про право на СЛОТ, а
 * у наблюдателя слота нет вовсе (NTR-18, NTR-9).
 */
function observerFlag(source: Record<string, unknown>): boolean {
  const value = source.observer;
  if (typeof value !== 'boolean') {
    throw new ProtocolError('Hello: поле "observer" — булево (NTR-9)');
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
        role: connectionRole(source),
        observer: observerFlag(source),
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
    case 'PauseRequest': {
      // Умолчания у действия нет намеренно (NTR-4): молча подставленное
      // «поставить» превратило бы опечатку клиента в заморозку матча, а
      // подставленное «снять» — в снятие чужой паузы.
      const action = source.action;
      if (action !== 'pause' && action !== 'resume') {
        throw new ProtocolError('PauseRequest: поле "action" — "pause" либо "resume" (NTR-20)');
      }
      return { type: 'PauseRequest', action };
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

/**
 * Значение из закрытого перечня (NTR-20). Разбор обязан перечень ПРОВЕРИТЬ, а
 * не привести к типу приведением: HUD ветвится по этим значениям (HUD-9), и
 * незнакомое дошло бы до виджета молча.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProtocolError(`${what} — одно из ${allowed.join(', ')} (NTR-20)`);
  }
  return value as T;
}

/**
 * Причина отказа: её нет вовсе либо она из перечня. `undefined` и «не из
 * перечня» — разные случаи, и второй отвергается, а не приводится к первому:
 * отказ с неразобранной причиной выглядел бы для HUD объявлением состояния.
 */
function pauseDenied(source: Record<string, unknown>): { denied?: PauseDenyReason } {
  if (source.denied === undefined) return {};
  return { denied: oneOf(source.denied, PAUSE_DENY_REASONS, 'Pause: поле "denied"') };
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
    case 'Pause':
      return {
        type: 'Pause',
        state: oneOf(source.state, PAUSE_STATES, 'Pause: поле "state"'),
        // `-1` — сервер (обвязка стенда, админ): слота у него нет, и нижняя
        // граница включает его намеренно.
        slot: int(source, 'slot', 'Pause', -1, Number.MAX_SAFE_INTEGER),
        countdownMs: int(source, 'countdownMs', 'Pause', 0, Number.MAX_SAFE_INTEGER),
        ...pauseDenied(source),
      };
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
