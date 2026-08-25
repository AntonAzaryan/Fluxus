/* eslint-disable max-lines -- baseline */
/**
 * Авторитетный сервер матча (NTR-3): владеет симуляцией, принимает разобранные
 * сообщения, отдаёт адресованные исходящие — и не делает ввода-вывода.
 *
 * Ни сокетов, ни таймеров, ни системных часов внутри: расписание держит
 * драйвер снаружи и зовёт `advance()`. Это не стилистика, а условие
 * проверяемости — сервер, который сам зовёт таймер, тестируется только
 * ожиданием реального времени или подменой таймеров, а сервер, которому тик
 * продвигают вызовом, тестируется как функция. В автотесте и в живом матче
 * исполняется один и тот же код (NTR-12).
 */
import {
  createInputLog,
  createRewindController,
  dispatch,
  filterSnapshot,
  tick as advanceTick,
  world as coreWorld,
  VIEWPOINT_ALL,
  type EntityId,
  type EventVisibility,
  type ExemptEntry,
  type InputFrame,
  type InputLog,
  type LocomotionOptions,
  type PhysicsOptions,
  type RewindController,
  type ScenarioDef,
  type ScenarioSpawn,
  type SceneDef,
  type Snapshot,
  type TickObserver,
  type TickResult,
  type VisibilityOptions,
  type WorldMode,
} from '@fluxus/core';
import { BranchHistory, type MatchHistory } from '../match/history.js';
import {
  firstRewindRequest,
  warnToConsole,
  REWIND_REQUEST_EVENT,
  type RewindRequestWarn,
} from '../match/rewindRequest.js';
import type { MatchTrace } from '../match/trace.js';
import { buildMatchWorld } from '../match/world.js';
import { createServerMetrics, type ServerMetrics } from '../metrics.js';
import type { ConnectionId } from '../transport/transport.js';
import type {
  ClientMessage,
  ConnectionRole,
  EndReason,
  EventBatch,
  EventsMessage,
  GameVersion,
  Pacing,
  PauseAction,
  PauseDenyReason,
  PauseState,
  RejectReason,
  ServerMessage,
  WireInput,
} from '../protocol/messages.js';
import { toInputFrame, toWireSnapshot } from '../protocol/messages.js';

export interface MatchConfig {
  /** Версия матча — версия серверной сборки (NET-16). */
  readonly version: GameVersion;
  /** Слоты: индекс в списке и есть слот (TICK-5). Число слотов — величина конфига, не константа (NTR-6). */
  readonly players: readonly string[];
  readonly seed: number;
  /** Ссылка на сцену в контент-паке. Содержимое сцены клиенту не уходит (NET-16). */
  readonly sceneRef: string;
  readonly scene: SceneDef;
  readonly initial?: readonly ScenarioSpawn[];
  readonly name?: string;
  /**
   * `viewpoint` слота (NET-12). По умолчанию — сам слот: в FFA каждый игрок сам
   * себе команда. Умолчание безопасное: сцена без тумана даёт пустой запрос
   * видимости, и фильтр не режет ничего, а сцена с туманом режет по своей
   * команде. Умолчания «всё видно» здесь быть не может — это wallhack по
   * невнимательности.
   */
  readonly teams?: readonly number[];
  readonly tickRate?: number;
  readonly snapshotRate?: number;
  readonly inputDelay?: number;
  /**
   * Верхняя граница окна приёма ввода в тиках (NTR-7). Механизм — конечность
   * границы, политика — само число: без неё размер буфера неприменённого ввода
   * на слот задаёт клиент, а не конфиг матча. Не меньше `inputDelay`, иначе
   * корректно помеченный клиентом кадр не проходит проверку сервера.
   */
  readonly inputWindow?: number;
  /**
   * Глубина повтора потока событий (NTR-15): сколько ПРЕДЫДУЩИХ рассылок
   * повторяет каждое сообщение `Events`. Величина, а не константа, по той же
   * причине, что `tickRate` и `snapshotRate` (NTR-7): она предъявляется замеру,
   * и прибор для неё — счётчик разрывов диапазона (NTR-11).
   *
   * `0` легален и означает «без повтора»: на канале без потерь избыточность —
   * чистый трафик. Умолчание 2 — «переживает две потери подряд», то есть каждая
   * пачка едет трижды.
   */
  readonly eventRepeat?: number;
  /**
   * История для серверной перемотки (NET-11). Поле необязательное: матч без
   * ульты отката снапшотов не снимает и переходов машины состояний не знает —
   * интервал и глубина суть параметры провайдера, а не константы ядра (SNAP-4).
   */
  readonly rewind?: MatchRewindOptions;
  /**
   * Политика паузы матча (NTR-20): бюджеты, право противника на снятие,
   * длительность отсчёта возобновления, максимум одной паузы. Данные документа
   * матча, а не константы сервера — «сервер MUST NOT содержать балансных
   * констант паузы» (NTR-20, механизм против политики).
   *
   * Поля нет — политики нет, и это НЕ умолчание с числами: игроки паузу не
   * ставят вовсе (бюджет ноль), отсчёт нулевой, ограничений на снятие и на
   * длительность нет. Серверное API паузы (`pauseMatch`) при этом работает: оно
   * не игрок, и бюджет игрока к нему не относится.
   */
  readonly pause?: MatchPauseOptions;
  /**
   * Приёмник диагностики запроса перемотки (REW-12): испорченный payload и
   * запрос, который матч НЕ МОЖЕТ исполнить структурно — история не собрана.
   * Шов сборки, а не свойство матча: куда пишет диагностика — в консоль
   * запускалки, в буфер теста или в лог стенда, — решает хост.
   *
   * Умолчание — `console.warn` (`rewindRequest.ts`). Умолчания «молчать» здесь
   * быть не может: матч, поднятый без секции `rewind`, отбрасывает каждый каст
   * ульты, и снаружи это неотличимо от ульты, которая просто ничего не делает.
   * Ровно так дефект и жил — стенд играл без перемотки, ничего об этом не
   * говоря.
   */
  readonly rewindWarn?: RewindRequestWarn;
  /** Порог молчания слота в тиках; по умолчанию 10 секунд при текущем `tickRate`. */
  readonly silenceTicks?: number;
  readonly allowObserver?: boolean;
  readonly physics?: PhysicsOptions;
  readonly locomotion?: LocomotionOptions;
  /**
   * Включение и параметры пересчёта видимости (NTR-14) — третий нативный механизм
   * конфига матча наравне с физикой и вводом: `VisibilitySystem` нативна и берёт
   * `raycast` (FOW-4, PHYS-6), то есть является зависимостью сборки (DI-3), а не
   * данными сцены, и JSON-системой сцены не выразима. Форма поля — та же, что у
   * поля `visibility` документа прогона сценария (CLI-2): пустой объект включает
   * пересчёт, отсутствие поля означает «пересчёта нет».
   *
   * Асимметрия с физикой в том, что матч со сценой, включающей туман войны (флаг
   * `fog`, SER-7), без этого поля НЕ СОБИРАЕТСЯ — отказ живёт в общем пути сборки
   * (`buildMatchWorld`), одинаково на сервере и на клиенте.
   */
  readonly visibility?: VisibilityOptions;
  /**
   * Действующий предикат видимости события (NET-13) — параметр, а не зашитое
   * решение (NTR-9): точная политика при разной видимости источника и цели
   * остаётся открытым геймплейным вопросом, и закрытие его будет сменой ЭТОГО
   * поля, а не правкой ядра или сетевого слоя.
   *
   * Отсутствие поля означает предикат, нормированный NET-13, — а не умолчание
   * конкретной сборки: величина, приезжающая молчанием, была бы политикой,
   * выбранной тем, кто первым написал код.
   */
  readonly eventVisibility?: EventVisibility;
  readonly observers?: readonly TickObserver[];
  /**
   * Трейс матча (DIAG-8): sink симуляции и приёмник отметок ветви истории
   * (DIAG-9) одним объектом. Необязателен, и по умолчанию его нет — матч без
   * него идёт ровно так же, как шёл до появления поля.
   *
   * Ввода-вывода сервер от этого не приобретает (NTR-3): строку пишет функция,
   * инъектированная хостом при сборке трейса (`createMatchTrace`), а сервер
   * лишь передаёт sink в сборку мира и зовёт отметки на границах, которые знает
   * только он.
   *
   * В документ записи матча поле не попадает: состав `toScenario()` перечислен
   * там поимённо, и отладочные поля конфига в запись не входят (CLI-11).
   */
  readonly trace?: MatchTrace;
}

/** Настройки истории матча (SNAP-3, SNAP-4) плюс поля вне отката (REW-9). */
export interface MatchRewindOptions {
  /** Тиков между снапшотами. */
  readonly interval: number;
  /** Сколько снапшотов держится. */
  readonly capacity: number;
  /** Поля и компоненты, переживающие откат, например cooldown самой ульты (REW-9). */
  readonly exempt?: readonly ExemptEntry[];
  /**
   * Бит действия во входном сообщении `Input`, удержание которого ведёт скраб
   * (NET-11): второго канала под управление в протоколе нет и заводить его
   * нельзя (NTR-8). Раскладку битов знает сборка игры, а не сетевой слой, —
   * поэтому номер приезжает конфигом матча.
   *
   * Поля нет — органа управления скрабом у матча нет: сервер, войдя в
   * перемотку, возобновит мир по порогу молчания инициатора, а не зависнет в
   * `Rewinding`.
   */
  readonly holdButton?: number;
  /**
   * Тиков, на которые точка перемотки уходит назад за ЦИКЛ РАССЫЛКИ. Величина
   * конфига, а не баланса: это скорость интерактивного скраба — то же, чем
   * является чувствительность органа управления, — и глубину ульты она не
   * задаёт (та приезжает из контента в payload запроса).
   */
  readonly step?: number;
  /**
   * Порог молчания инициатора в тиках: кадры перестали приходить — считаем
   * орган отпущенным. Без порога разрыв связи инициатора вешал бы мир в
   * `Rewinding` навсегда, а этого режима у матча нет.
   */
  readonly holdTimeoutTicks?: number;
}

/**
 * Политика паузы матча (NTR-20) — секция документа матча целиком. Каждое поле
 * необязательно, и отсутствующее означает «правила нет», а не число: числа
 * принадлежат игре, и сервер их не придумывает.
 *
 * Все длительности — в миллисекундах, потому что отсчёт паузы не тиковый
 * (решение D2): живых тиков в заморозке нет. Сервер переводит их в шаги своего
 * расписания (`advance()` зовётся драйвером в темпе `tickRate` и в заморозке
 * тоже) — часов внутри у него по-прежнему нет (NTR-3).
 */
export interface MatchPauseOptions {
  /**
   * Сколько пауз за матч вправе поставить ОДИН слот. Нет поля — ни одной:
   * механизм без объявленной политики права не выдаёт.
   */
  readonly budgetPerPlayer?: number;
  /**
   * Через сколько миллисекунд заморозки чужую паузу вправе снять другой слот.
   * Инициатора это не ограничивает никогда — снять свою он может сразу.
   */
  readonly opponentUnpauseAfterMs?: number;
  /** Длительность объявляемого обратного отсчёта возобновления. `0` — возобновление сразу. */
  readonly resumeCountdownMs?: number;
  /**
   * Максимальная длительность ОДНОЙ заморозки: по её истечении сервер сам
   * объявляет возобновление (риск «пауза на неопределённо долго вешает матч»).
   * `0` и отсутствие поля — ограничения нет.
   */
  readonly maxPauseMs?: number;
  /**
   * Ставить ли паузу при отвязке соединения владельца (решение D6). Поле читает
   * ОБВЯЗКА (стенд, агент) — сервер о разрывах наружу не сообщает и политики
   * реакции на них не исполняет (NTR-3). Живёт оно здесь потому, что это
   * правило паузы, а правила паузы — данные документа матча (NTR-20).
   *
   * Названа здесь только отвязка, и кто сядет в опустевший слот — не словарь
   * этого файла: происхождение участника сервер матча не различает вовсе, и
   * отсутствие такого слова в его исходниках закреплено отдельным тестом.
   */
  readonly onOwnerDetach?: 'pause' | 'ignore';
}

/**
 * Источник заморозки мира (решение D1, NTR-20) — исчерпывающий перечень.
 *
 * Мир бывает в `Paused` по двум разным поводам, и хост обязан их различать:
 * пауза матча и служебная заморозка машины перемотки (`Running → Paused →
 * Rewinding`, WSM-2). Спутай их — и `PauseRequest` посреди скраба снял бы чужую
 * перемотку, а `resume()` машины перемотки — чужую паузу матча.
 */
type FreezeSource = 'none' | 'match-pause' | 'rewind';

/** Слот-инициатор, которого нет: пауза от обвязки стенда или админа (NTR-20). */
const SERVER_SLOT = -1;

/**
 * Ведение точки перемотки (REW-7): что именно сервер сейчас скрабит. Живёт
 * только между входом в `Rewinding` и возобновлением — состоянием матча не
 * является и в снапшот не попадает.
 */
interface ScrubSession {
  /** Слот инициатора; `-1` — сущность запроса слоту не сопоставлена. */
  readonly slot: number;
  /** Тик, глубже которого точка не уходит: глубина запроса и глубина истории. */
  readonly floor: number;
  /** Держит ли инициатор орган управления — по самому свежему его кадру. */
  held: boolean;
  /** Тиков с последнего кадра инициатора: молчание дольше порога = отпускание. */
  idleTicks: number;
  /** Тиков с прошлого шага скраба: шаг делается раз в цикл рассылки. */
  sinceStep: number;
  /**
   * Хотя бы один шаг уже сделан. Нужен ровно затем, чтобы ПЕРВЫЙ шаг не ждал
   * цикла рассылки и не перепроверял орган: вход в перемотку уже означает, что
   * орган был удержан (ульта прожата им же), и короткое нажатие обязано
   * двигать точку (REW-13).
   */
  stepped: boolean;
}

/**
 * Сегмент канонического лога (NTR-16): непрерывный прогон исполненных тиков в
 * пределах одной эпохи. Матч без перемотки даёт ровно один сегмент, и его
 * кадры совпадают с прежним плоским списком — сегментация обобщает форму лога,
 * а не отменяет её.
 */
export interface MatchSegment {
  readonly epoch: number;
  readonly frames: readonly InputFrame[];
}

/** Внутренняя, дописываемая форма сегмента: наружу уходит только `MatchSegment`. */
interface OpenSegment {
  readonly epoch: number;
  readonly frames: InputFrame[];
}

/**
 * Разосланное окно потока событий (NTR-15): замкнутый диапазон тиков одной
 * рассылки и непустые пачки внутри него. Тик диапазона, пачки которого нет,
 * означает «на этом тике событий не было», поэтому пустые пачки не хранятся —
 * покрытие держит объявленный диапазон, а не перечисление тиков.
 */
interface EventWindow {
  readonly from: number;
  readonly to: number;
  readonly batches: readonly EventBatch[];
}

/**
 * Накопитель потока событий одного `viewpoint` (NTR-15, решение 2 дизайна).
 *
 * По `viewpoint`, а не по соединению: два соединения одной команды получают
 * один и тот же отобранный поток, и хранить его дважды незачем.
 *
 * Глубина накопления меряется в тиках и равна «период рассылки × (глубина
 * повтора + 1)»: `repeats` держит `eventRepeat` уже разосланных окон по
 * `snapshotEvery` тиков каждое, плюс открытое окно текущего периода. Границы в
 * событиях или байтах здесь не появляются: тик, породивший много событий, — это
 * бой, а не отказ протокола.
 */
interface EventStream {
  /** Первый ещё не разосланный живой тик текущей эпохи; `-1` — окно не открыто. */
  from: number;
  /** Последний накопленный живой тик; значим только при `from >= 0`. */
  to: number;
  /** Непустые пачки открытого окна, в порядке возрастания тика. */
  batches: EventBatch[];
  /** Кольцо разосланных окон, повторяемых следующими сообщениями. */
  readonly repeats: EventWindow[];
}

export type MatchPhase = 'lobby' | 'running' | 'ended';

/** Исходящее: сообщение конкретному соединению и признак «после этого закрыть». */
export interface Outgoing {
  readonly to: ConnectionId;
  readonly message: ServerMessage;
  readonly closeAfter: boolean;
}

type ConnectionPhase = 'greeting' | 'player' | 'observer';

interface Connection {
  readonly id: ConnectionId;
  phase: ConnectionPhase;
  /** Слот игрока; у наблюдателя — `-1`. */
  slot: number;
  /**
   * Роль соединения в слоте (NTR-18): арендатор слота — владелец или
   * заместитель. У наблюдателя и до хендшейка значения не имеет.
   */
  role: ConnectionRole;
  /**
   * Первый тик, факты которого адресованы ЭТОМУ соединению (NTR-17): тик его
   * посадки плюс один. Накопитель потока общий на `viewpoint` (NTR-15), а
   * «поток открыт заново» — свойство соединения, и держится оно этим срезом
   * (см. `eventsFor`). У соединения, севшего до первого тика, срез не режет
   * ничего.
   */
  eventsFrom: number;
  /**
   * Эпоха, в которой сделан срез (NTR-16). Номер тика без эпохи ветвь истории
   * не называет: после перемотки тики идут заново, и «позже» между эпохами не
   * определено — срез, применённый к чужой эпохе, вырезал бы живую ветвь
   * целиком.
   */
  eventsEpoch: number;
}

const DEFAULTS = {
  tickRate: 60,
  snapshotRate: 30,
  inputDelay: 2,
  /** Четверть секунды при 60 Гц (NTR-7): больше половины круга на играбельном канале и всё же конечная величина. */
  inputWindow: 15,
  /** Две предыдущие рассылки (NTR-15): пачка едет трижды и переживает две потери подряд. */
  eventRepeat: 2,
  silenceSeconds: 10,
  /** Тиков за цикл рассылки: при 60 Гц и рассылке 30 Гц — двенадцать тиков в секунду. */
  scrubStep: 4,
  /** Четверть секунды при 60 Гц — та же величина, что окно приёма ввода. */
  holdTimeoutTicks: 15,
} as const;

/**
 * Компонент и поле слота игрока в мире матча. Те же, что ставит `InputSystem`
 * умолчанием (`buildMatchWorld` регистрирует её без переопределения): по ним
 * сервер сопоставляет сущность-инициатора запроса перемотки со слотом, чей
 * ввод он читает во время скраба.
 */
const SLOT_COMPONENT = 'Player';
const SLOT_FIELD = 'slot';

const EMPTY_FRAMES: readonly InputFrame[] = [];

/**
 * Число политики паузы: неотрицательное целое либо отсутствие. Отказ на сборке
 * матча, а не приведение молча: `budgetPerPlayer: -1` и `resumeCountdownMs:
 * 1.5` не означают ничего, а тихо приведённые к нулю выдали бы политику,
 * которой в документе не написано (NTR-20, механизм против политики).
 */
function nonNegative(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`MatchConfig: ${field} (${value}) — целое, не меньше нуля (NTR-20)`);
  }
  return value;
}

/**
 * `pause.onOwnerDetach` — единственное НЕчисловое поле политики паузы, и
 * проверяется оно здесь наравне с числами, хотя читает его обвязка, а не
 * сервер.
 *
 * Здесь потому, что документ матча один на всех потребителей — выделенный
 * стенд, страницу, агента, — и проверка на стороне читателя означала бы, что
 * `"Pause"`, `"puase"` и `"freeze"` тихо значат «политики нет» ровно у того
 * потребителя, который проверить забыл. Это тот же класс дефекта, что потерянная
 * секция документа: объявленное геймдизайнером правило исчезает молча.
 */
function ownerDetach(value: string | undefined): void {
  if (value === undefined || value === 'pause' || value === 'ignore') return;
  throw new Error(`MatchConfig: pause.onOwnerDetach ("${value}") — "pause" либо "ignore" (NTR-20)`);
}

export class MatchServer {
  readonly config: MatchConfig;
  readonly worldInitHash: string;
  readonly metrics: ServerMetrics;

  private readonly tickRate: number;
  private readonly snapshotRate: number;
  private readonly snapshotEvery: number;
  private readonly inputDelay: number;
  private readonly inputWindow: number;
  private readonly eventRepeat: number;
  private readonly silenceTicks: number;

  private readonly sim: ReturnType<typeof buildMatchWorld>['sim'];
  private readonly state: ReturnType<typeof buildMatchWorld>['state'];

  /** Механизм перемотки (NET-11, WSM-1..6). `undefined` — матч поднят без истории. */
  private readonly history: MatchHistory | undefined;
  private readonly inputLog: InputLog | undefined;
  private readonly rewindController: RewindController | undefined;
  /**
   * Ручка переходов машины состояний мира (WSM-5) — есть у КАЖДОГО матча, в том
   * числе поднятого без истории.
   *
   * Пауза матча (NTR-20) историей не пользуется вовсе: ей нужны `pause()` и
   * `resume()`, то есть два перехода `Running ↔ Paused`, и ядру для них нечего
   * восстанавливать. Второй реализации этих переходов ядро не публикует, а
   * писать `state.mode = 'Paused'` рядом означало бы завести WSM-2 второй раз в
   * обход единственного core-API (WSM-5, DI-3), — поэтому у матча без секции
   * `rewind` контроллер собирается на ВЫРОЖДЕННОЙ истории, в которую никто
   * никогда не пишет и из которой никто не читает: `beginRewind`/`seekTo`
   * закрыты отдельной проверкой (`requireRewind`), и добраться до неё неоткуда.
   */
  private readonly wsm: RewindController;
  private readonly scrubStep: number;
  private readonly holdTimeoutTicks: number;
  /** Ведущаяся перемотка; `undefined` — сервер скраб не ведёт. */
  private scrub: ScrubSession | undefined;
  /**
   * Несобираемость перемотки уже названа вслух. Один раз на матч: ульта с
   * прожатым cooldown'ом просится раз в несколько секунд, и строка на каждый
   * каст утопила бы отчёт запускалки в собственном шуме.
   */
  private rewindUnavailableReported = false;

  // ------------------------------------------------------------ пауза матча
  //
  // Состояние паузы — состояние ХОСТА, а не мира (решение D1): в снапшот оно не
  // входит, в канонический лог не попадает и симуляции невидимо (NTR-20).
  // Отсчёты ведутся в ШАГАХ РАСПИСАНИЯ: драйвер зовёт `advance()` тем же темпом
  // и в заморозке, поэтому шаг равен тику матча по длительности, а часов внутри
  // сервера по-прежнему нет (NTR-3) — иначе его нельзя было бы прогнать
  // вызовами в тесте (NTR-12).

  /** Кто заморозил мир (D1): пауза матча, машина перемотки или никто. */
  private freezeSource: FreezeSource = 'none';
  private pausePhase: PauseState = 'running';
  /** Слот, чьё действие привело к текущему состоянию; `SERVER_SLOT` — обвязка. */
  private pauseSlot: number = SERVER_SLOT;
  /** Сколько пауз слот уже израсходовал за матч (бюджет — политика документа). */
  private readonly pausesUsed: number[];
  /** Шагов расписания с начала текущей заморозки: право противника и максимум. */
  private frozenSteps = 0;
  /** Шагов до объявленного возобновления; значим только в `resuming`. */
  private resumeSteps = 0;
  private readonly pauseBudget: number;
  private readonly opponentUnpauseSteps: number;
  private readonly resumeCountdownSteps: number;
  /** `0` — ограничения на длительность одной заморозки нет. */
  private readonly maxPauseSteps: number;

  private readonly connections = new Map<ConnectionId, Connection>();
  /**
   * Живое соединение слота — его арендатор (NTR-17, NTR-18); `undefined` —
   * слот свободен (до `Start`) либо арендатора у него сейчас нет.
   *
   * Аренда — не состав: после `Start` слот остаётся за игроком ростера (NTR-6),
   * меняется только соединение. Отсюда и разделение с `slotClaimed`: первое
   * поле отвечает на «кто говорит за слот прямо сейчас», второе — на «занят ли
   * слот ростером».
   */
  private readonly slotConnection: (ConnectionId | undefined)[];
  private readonly slotClaimed: boolean[];
  /** Пришедший, но ещё не исполненный ввод: слот → тик → кадр. */
  private readonly pending: Map<number, InputFrame>[];
  private readonly lastFrame: (InputFrame | undefined)[];

  /**
   * Накопители потока событий по `viewpoint` (NTR-15). Ключей не больше, чем
   * различных `viewpoint` матча, то есть числа слотов плюс наблюдатель: карта
   * от длительности матча не растёт.
   */
  private readonly eventStreams = new Map<number, EventStream>();

  /** Канонический лог сегментами (NTR-16); плоский список — его частный случай. */
  private readonly segments: OpenSegment[] = [];
  private readonly outbox: Outgoing[] = [];
  private matchPhase: MatchPhase = 'lobby';
  /**
   * Тик начала матча — тот, что уехал в `Start` (NTR-6). Хранится ради
   * реконнекта: вернувшемуся владельцу уходит `Start` с ТЕМ ЖЕ тиком начала
   * (NTR-17), потому что матч для него не начался заново.
   */
  private startTick = 0;

  /**
   * Пара `(эпоха, тик)` последнего авторитетного состояния матча (NTR-16).
   * Эпоха выводится из самой последовательности состояний, а не из наблюдения
   * за переходами машины состояний мира: вход в `Rewinding` номера тика не
   * двигает, а одно `seekTo` даёт до десятка восстановлений.
   */
  private currentEpoch = 0;
  /**
   * Тик последнего авторитетного состояния: исполненного тика либо
   * восстановления. `-1` — состояний ещё не было, и сравнивать не с чем.
   *
   * Считать только разосланные состояния было бы мало: рассылка идёт по
   * расписанию `snapshotRate` и отстаёт от живого тика, поэтому восстановление
   * на тик между последней рассылкой и текущим тиком не увеличило бы эпоху —
   * и переисполненные тики дописались бы в сегмент прежней эпохи вторыми
   * кадрами на тот же номер.
   */
  private lastStateTick = -1;
  /**
   * Наибольший тик, до которого достижимо доигрывание вперёд по ЖИВОЙ ветви:
   * тик последнего исполненного живого тика. Восстановлением не двигается —
   * скраб вперёд внутри перемотки (REW-7, NTR-16: «восстановленные состояния
   * идут на тиках 480, 490, 470») доигрывает по тем же каноническим вводам, из
   * которых эти тики и были исполнены.
   *
   * Сравнивать здесь с `state.tick` было бы неверно в обе стороны. Первый
   * `seekTo(480)` опускает `state.tick` до 480, и `seekTo(490)` следом стал бы
   * «перемоткой вперёд», хотя тик 490 в этой ветви исполнен и лежит в логе.
   * Обратно: после возобновления с тика 480 и исполнения тика 481 записи лога
   * на тики 482..500 принадлежат стёртой ветви — доигрывать по ним нельзя, и
   * граница обязана опуститься. Живой тик её и опускает, потому что ставит её
   * равной себе, а не максимуму за матч.
   */
  private liveFrontier = 0;

  constructor(config: MatchConfig) {
    if (config.players.length === 0) throw new Error('MatchConfig: нужен хотя бы один слот');
    if (new Set(config.players).size !== config.players.length) {
      throw new Error('MatchConfig: игрок указан дважды');
    }
    // `viewpoint` игрока обязан быть номером команды (FOW-2, `[0, 31]`).
    // Проверяется, а не подразумевается: `VIEWPOINT_ALL` — это -1, и конфиг с
    // отрицательным номером команды выдал бы игроку поток без фильтрации, то
    // есть ровно то, что NTR-9 запрещает «ни при каких условиях».
    config.teams?.forEach((team, slot) => {
      if (!Number.isInteger(team) || team < 0 || team > 31) {
        throw new Error(`MatchConfig: команда слота ${slot} вне диапазона [0, 31] (FOW-2): ${team}`);
      }
    });
    this.config = config;
    this.tickRate = config.tickRate ?? DEFAULTS.tickRate;
    this.snapshotRate = config.snapshotRate ?? DEFAULTS.snapshotRate;
    // Кратность — не придирка: при некратной частоте интервал между рассылками
    // плавал бы от тика к тику, и замер отклика мерил бы дрожание расписания.
    if (this.tickRate % this.snapshotRate !== 0) {
      throw new Error(
        `MatchConfig: snapshotRate (${this.snapshotRate}) не делит tickRate (${this.tickRate}) нацело`,
      );
    }
    this.snapshotEvery = this.tickRate / this.snapshotRate;
    this.inputDelay = config.inputDelay ?? DEFAULTS.inputDelay;
    this.inputWindow = config.inputWindow ?? DEFAULTS.inputWindow;
    // Окно уже запаса задержки означало бы, что сервер отвергает собственную
    // разметку: клиент помечает кадр тиком `serverTick + inputDelay` по тому же
    // конфигу, который прислал сервер (NTR-7).
    if (this.inputWindow < this.inputDelay) {
      throw new Error(
        `MatchConfig: inputWindow (${this.inputWindow}) меньше inputDelay (${this.inputDelay})`,
      );
    }
    this.eventRepeat = config.eventRepeat ?? DEFAULTS.eventRepeat;
    // Ноль легален — «без повтора» (NTR-15); отрицательное и дробное не
    // означают ничего: глубина считается в рассылках, а не в долях рассылки, и
    // молча приведённое к нулю значение выдало бы канал без избыточности за
    // настроенный.
    if (!Number.isInteger(this.eventRepeat) || this.eventRepeat < 0) {
      throw new Error(`MatchConfig: eventRepeat (${this.eventRepeat}) — целое, не меньше нуля (NTR-15)`);
    }
    this.silenceTicks = config.silenceTicks ?? this.tickRate * DEFAULTS.silenceSeconds;
    this.scrubStep = config.rewind?.step ?? DEFAULTS.scrubStep;
    this.holdTimeoutTicks = config.rewind?.holdTimeoutTicks ?? DEFAULTS.holdTimeoutTicks;
    // Нулевой и дробный шаг не означают ничего: точка перемотки считается в
    // тиках, а шаг «ноль» превратил бы удержание в вечное `Rewinding` без
    // движения — то есть в тот самый зависший мир, от которого стоит порог
    // молчания.
    if (!Number.isInteger(this.scrubStep) || this.scrubStep < 1) {
      throw new Error(`MatchConfig: rewind.step (${this.scrubStep}) — целое ≥ 1`);
    }
    if (!Number.isInteger(this.holdTimeoutTicks) || this.holdTimeoutTicks < 1) {
      throw new Error(
        `MatchConfig: rewind.holdTimeoutTicks (${this.holdTimeoutTicks}) — целое ≥ 1`,
      );
    }
    // Номер бита проверяется наравне с шагом и порогом: `1 << 32` в JS даёт
    // единицу, `1 << -1` — старший бит, и оба молча читали бы из кадра НЕ ту
    // кнопку. Отказ на сборке матча вместо скраба, который ведёт себя странно.
    const holdButton = config.rewind?.holdButton;
    if (holdButton !== undefined && (!Number.isInteger(holdButton) || holdButton < 0 || holdButton > 31)) {
      throw new Error(`MatchConfig: rewind.holdButton (${holdButton}) — целое 0..31 (NET-11)`);
    }

    // Политика паузы (NTR-20). Отсутствующая секция и отсутствующее поле дают
    // НЕЙТРАЛЬНЫЙ элемент механизма, а не число: бюджета у игроков нет, отсчёт
    // нулевой, ограничений на снятие и на длительность нет. Числа приезжают
    // документом матча — сервер балансных констант паузы не содержит.
    this.pauseBudget = nonNegative(config.pause?.budgetPerPlayer, 'pause.budgetPerPlayer');
    // Миллисекунды отсчёта живут ровно до перевода в шаги: наружу уезжает
    // ОСТАТОК (`countdownMs`), а он считается из шагов — держать рядом ещё и
    // объявленную длительность значило бы завести второе мнение о ней.
    this.resumeCountdownSteps = this.stepsOf(
      nonNegative(config.pause?.resumeCountdownMs, 'pause.resumeCountdownMs'),
    );
    this.opponentUnpauseSteps = this.stepsOf(
      nonNegative(config.pause?.opponentUnpauseAfterMs, 'pause.opponentUnpauseAfterMs'),
    );
    this.maxPauseSteps = this.stepsOf(nonNegative(config.pause?.maxPauseMs, 'pause.maxPauseMs'));
    ownerDetach(config.pause?.onOwnerDetach);
    this.pausesUsed = Array.from({ length: config.players.length }, () => 0);

    const built = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.locomotion !== undefined ? { locomotion: config.locomotion } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
      ...(config.trace !== undefined ? { diagnostics: config.trace.sink } : {}),
    });
    this.sim = built.sim;
    this.state = built.state;
    this.worldInitHash = built.worldInitHash;

    const slots = config.players.length;
    this.metrics = createServerMetrics(slots);
    this.slotConnection = Array.from({ length: slots }, () => undefined);
    this.slotClaimed = Array.from({ length: slots }, () => false);
    this.pending = Array.from({ length: slots }, () => new Map<number, InputFrame>());
    this.lastFrame = Array.from({ length: slots }, () => undefined);

    if (config.rewind !== undefined) {
      // Реплей внутри `seekTo` идёт по каноническим вводам (REW-2), поэтому лог
      // ядра ведётся рядом с сегментами: сегменты — история матча, `InputLog` —
      // рабочий буфер механизма восстановления.
      const history = new BranchHistory({
        interval: config.rewind.interval,
        capacity: config.rewind.capacity,
      });
      // Глубина лога вводов привязана к глубине истории, а не к умолчанию
      // `createInputLog`: реплей внутри `seekTo` идёт от ближайшего снапшота
      // (REW-2), то есть заглядывает назад на `depth` тиков от самого свежего
      // снапшота плюс ещё до `interval - 1` тиков, на которые живой тик успел
      // уйти вперёд от него. Умолчание в 1024 кадра при глубоком буфере
      // (SNAP-4 — своё число у каждого провайдера) молча оставило бы реплей без
      // вводов, и восстановленное состояние разошлось бы с исходным (DET-1).
      const inputLog = createInputLog(history.depth + config.rewind.interval + 1);
      // Состояние до первого тика — тоже точка восстановления (REW-1).
      history.record(this.state);
      this.history = history;
      this.inputLog = inputLog;
      this.rewindController = createRewindController(this.sim, this.state, {
        history,
        inputs: inputLog,
        ...(config.rewind.exempt !== undefined ? { exempt: config.rewind.exempt } : {}),
      });
    }
    // Одна ручка переходов на обе заморозки (см. поле `wsm`): у матча с историей
    // это контроллер перемотки, у матча без неё — он же на вырожденной истории.
    // Две ручки означали бы два независимых мнения о `state.mode`.
    this.wsm =
      this.rewindController ??
      createRewindController(this.sim, this.state, {
        history: new BranchHistory({ interval: 1, capacity: 1 }),
        inputs: createInputLog(1),
      });
  }

  get tick(): number {
    return this.state.tick;
  }

  /** Текущая эпоха матча (NTR-16): в мир она не попадает и живёт только здесь. */
  get epoch(): number {
    return this.currentEpoch;
  }

  /** Расписание матча. Читает драйвер — он держит темп, сервер часов не знает (NTR-3). */
  get pacing(): Pacing {
    return {
      tickRate: this.tickRate,
      snapshotRate: this.snapshotRate,
      inputDelay: this.inputDelay,
      inputWindow: this.inputWindow,
      eventRepeat: this.eventRepeat,
    };
  }

  get phase(): MatchPhase {
    return this.matchPhase;
  }

  /** Режим мира (WSM-1). Читает драйвер и политика ульты — сервер её не подменяет. */
  get mode(): WorldMode {
    return this.state.mode;
  }

  /**
   * Канонический лог матча сегментами (NTR-16) — модель, определённая и для
   * матча с перемоткой.
   */
  get canonicalSegments(): readonly MatchSegment[] {
    return this.segments;
  }

  /**
   * Канонический ввод матча плоским списком, включая predicted-кадры (NTR-8).
   *
   * Форма определена для матча без перемотки — то есть ровно для одного
   * сегмента (NTR-16). У матча с перемоткой один номер тика исполнен в
   * нескольких эпохах, и «кадр тика 512» перестаёт называть одну величину:
   * такой лог читается сегментами, а склейка ниже годится только на диагностику.
   */
  get canonicalInputs(): readonly InputFrame[] {
    if (this.segments.length === 0) return EMPTY_FRAMES;
    if (this.segments.length === 1) return this.segments[0]!.frames;
    return this.segments.flatMap((segment) => segment.frames);
  }

  /**
   * Полное состояние матча копией — вход проверки парности (NTR-8) и дебага.
   * Копия, а не ссылка: наружу канонический мир не отдаётся, его читает только
   * сам сервер (NET-12).
   *
   * Идёт тем же `filterFor`, что и рассылка: предикат видимости события у матча
   * один — тот, который называет его конфиг (NET-13, NTR-9), — и второй его
   * источник рядом означал бы, что диагностика смотрит на мир не теми глазами,
   * какими его видит клиент.
   */
  snapshot(viewpoint: number = VIEWPOINT_ALL): Snapshot {
    return this.filterFor(viewpoint);
  }

  // ------------------------------------------------------------- соединения

  connect(id: ConnectionId): void {
    if (this.connections.has(id)) throw new Error(`MatchServer: соединение ${id} уже зарегистрировано`);
    this.connections.set(id, {
      id,
      phase: 'greeting',
      slot: -1,
      role: 'owner',
      eventsFrom: 0,
      eventsEpoch: this.currentEpoch,
    });
  }

  disconnect(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    this.releaseSlot(connection);
  }

  /**
   * Соединение перестало существовать — аренда слота кончается вместе с ним
   * (NTR-17). Одно место на оба конца соединения: закрытый канал
   * (`disconnect`) и разрыв по названному исходу (`reject`). Раздельные ветви
   * означали бы, что слот освобождается от одного вида смерти соединения и не
   * освобождается от другого, — а слот с мёртвым арендатором не пускает ни
   * владельца обратно (NTR-17: «слот которого не занят живым соединением»), ни
   * заместителя (NTR-18), и врёт наблюдающей сборке-основателю сессии, у
   * которой этот факт — единственная наблюдательная поверхность
   * (`slotAttached`).
   *
   * Аренда снимается, только если её держало ИМЕННО это соединение: вытесненное
   * владельцем (NTR-18) закрывается ПОСЛЕ того, как слот достался владельцу, и
   * без проверки его закрытие отняло бы слот у только что вошедшего.
   */
  private releaseSlot(connection: Connection): void {
    if (connection.slot < 0) return;
    if (this.slotConnection[connection.slot] !== connection.id) return;
    this.slotConnection[connection.slot] = undefined;
    // До старта слот освобождается совсем — состав ещё не зафиксирован. После
    // старта он остаётся за игроком (NTR-6): матч продолжается на
    // predicted-кадрах, а вернуться в него вправе владелец слота (NTR-17) либо
    // заместитель (NTR-18) — но не новый участник.
    if (this.matchPhase === 'lobby') this.slotClaimed[connection.slot] = false;
  }

  /**
   * Есть ли у слота живое соединение — наблюдение СНАРУЖИ сервера (NTR-18):
   * политика «что делать со слотом, оставшимся без соединения» живёт у
   * сборки-основателя сессии, и наблюдать ей нужен ровно этот факт. Кто именно
   * арендует слот — владелец или заместитель, — сервер не рассказывает и не
   * различает: он даёт механизм аренды, а не сведения об участниках.
   */
  slotAttached(slot: number): boolean {
    return this.slotConnection[slot] !== undefined;
  }

  /** Разбор кадра не удался либо сообщение недопустимо — исход называется, соединение рвётся (NTR-4). */
  protocolError(id: ConnectionId, reason: RejectReason, detail: string): void {
    this.metrics.rejectedMessages++;
    this.reject(id, reason, detail);
  }

  receive(id: ConnectionId, message: ClientMessage): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;

    switch (message.type) {
      case 'Hello':
        if (connection.phase !== 'greeting') {
          this.protocolError(id, 'protocol-error', 'повторный Hello в установленном соединении');
          return;
        }
        this.greet(connection, message.playerId, message.version, message.role, message.observer);
        return;
      case 'Input':
        if (connection.phase !== 'player') {
          this.protocolError(id, 'protocol-error', 'ввод от соединения без игрового слота');
          return;
        }
        this.ingest(connection.slot, message.epoch, message.frames);
        return;
      case 'PauseRequest':
        // Запрос допустим в любом состоянии соединения ПОСЛЕ хендшейка, включая
        // наблюдательское: недопущенный политикой запрос получает адресный
        // `Pause` с причиной, а не разрыв (NTR-20, решение D4). Разрыв остаётся
        // только за запросом ДО хендшейка — сообщением, недопустимым для
        // состояния соединения (NTR-4).
        if (connection.phase === 'greeting') {
          this.protocolError(id, 'protocol-error', 'запрос паузы до входа в матч');
          return;
        }
        this.requestPause(connection, message.action);
        return;
      case 'Bye':
        // Осознанный уход отвязывает соединение от слота — и только (design D4
        // change'а `add-player-reconnect`). Матча он не завершает: слот остаётся
        // за игроком ростера (NTR-6), дальше работают окно возврата (NTR-17),
        // замещающее соединение (NTR-18) и порог молчания. Прежнее мгновенное
        // `End` ломало бы замещение ровно в том случае, ради которого оно
        // заведено: ушедший добровольно убивал бы матч в обход заместителя.
        this.disconnect(id);
        return;
    }
  }

  /**
   * Вход в матч (NTR-5) — один и тот же для первого входа, реконнекта (NTR-17)
   * и замещающего соединения (NTR-18): те же две сверки, тот же `Welcome`, те
   * же исходы отказа. Отдельного сообщения и ослабленного пути у возврата нет —
   * реконнект есть тот же вход, поздний по времени, а набор сообщений закрыт
   * (NTR-4).
   */
  private greet(
    connection: Connection,
    playerId: string,
    version: GameVersion,
    role: ConnectionRole,
    observer: boolean,
  ): void {
    // Сверка версии — до того, как о матче сообщено что-либо (NTR-5). Половина
    // называется отдельно: «обновить сборку» и «обновить контент» — разные
    // действия игрока (NET-16).
    if (version.buildId !== this.config.version.buildId) {
      this.reject(connection.id, 'build-mismatch', `версия сборки матча: ${this.config.version.buildId}`);
      return;
    }
    if (version.contentPackHash !== this.config.version.contentPackHash) {
      this.reject(
        connection.id,
        'content-mismatch',
        `хеш контент-пака матча: ${this.config.version.contentPackHash}`,
      );
      return;
    }

    if (observer) {
      if (this.config.allowObserver !== true) {
        this.reject(connection.id, 'observer-not-allowed', 'сервер запущен без разрешения на наблюдателя');
        return;
      }
      connection.phase = 'observer';
      // Наблюдателю слот не выдаётся, поэтому и `Welcome` со слотом ему не
      // адресован: он не игрок, состава матча не занимает и `Start` дождётся
      // вместе со всеми. Роль соединения (NTR-18) для него не значит ничего —
      // она про право на слот, а слота у наблюдателя нет.
      //
      // Единственное, чего он не дождётся сам, — это заморозка: рассылок в ней
      // нет, и наблюдатель, подключившийся в паузу, смотрел бы в пустой экран.
      // Состояние паузы он получает наравне с игроками (NTR-20, NTR-9) — тем же
      // путём и в том же порядке.
      this.sendPauseState(connection);
      return;
    }

    const slot = this.config.players.indexOf(playerId);
    if (slot < 0) {
      // Ростер зафиксирован (NTR-6): реконнект возвращает участника ростера, но
      // входа новым не открывает.
      this.reject(connection.id, 'unknown-player', `игрок "${playerId}" не заявлен в матче`);
      return;
    }
    if (this.matchPhase === 'ended') {
      // Возвращаться некуда: идущего матча нет (NTR-17). Названный отказ, а не
      // тихое зависание без снапшотов.
      this.reject(connection.id, 'match-ended', 'матч уже завершён');
      return;
    }
    if (this.matchPhase === 'lobby') {
      this.greetBeforeStart(connection, slot, role);
      return;
    }
    this.greetRunning(connection, slot, role);
  }

  /**
   * Вход до `Start`: слоты занимают владельцы. Заместителю здесь отказ с
   * названным исходом (NTR-18) — кто и чем занимает пустой слот до старта,
   * решает сборка-основатель сессии, и механизмом замещения это не является.
   */
  private greetBeforeStart(connection: Connection, slot: number, role: ConnectionRole): void {
    if (role === 'substitute') {
      this.reject(
        connection.id,
        'substitute-before-start',
        'до старта матча слоты занимают владельцы (NTR-18)',
      );
      return;
    }
    if (this.slotClaimed[slot] === true) {
      this.reject(connection.id, 'slot-taken', `слот ${slot} уже занят`);
      return;
    }
    this.seat(connection, slot, role);
    this.welcome(connection, slot);
    if (this.slotClaimed.every(Boolean)) this.start();
  }

  /**
   * Вход в ИДУЩИЙ матч — смена арендатора слота, а не состава (NTR-6):
   * реконнект владельца (NTR-17) либо замещающее соединение (NTR-18).
   *
   * Слот с живым соединением отдаётся только в одном случае — владелец
   * вытесняет заместителя; во всех остальных «слот занят». Двух владельцев у
   * слота не бывает, и «умного» отбора настоящего владельца при двух
   * предъявителях одного идентификатора нет и не будет без аутентификации:
   * граница названа в NTR-17.
   */
  private greetRunning(connection: Connection, slot: number, role: ConnectionRole): void {
    const live = this.slotConnection[slot];
    if (live !== undefined) {
      const holder = this.connections.get(live);
      if (role !== 'owner' || holder?.role !== 'substitute') {
        this.reject(connection.id, 'slot-taken', `слот ${slot} занят живым соединением`);
        return;
      }
      // Вытеснение — исход плюс разрыв (NTR-18), без нового типа сообщения.
      // Соединение уходит из карты немедленно (`reject`), поэтому ввод
      // вытесненного дальше отбрасывается на общих основаниях проверки слота
      // отправителя (NTR-7), а его закрытие не отнимет слот у владельца
      // (см. `disconnect`): тика с двумя арендаторами слота не существует.
      this.reject(live, 'displaced-by-owner', `слот ${slot} возвращён владельцу`);
    }
    this.seat(connection, slot, role);
    this.welcome(connection, slot);
    // Повторный `Start` — с ИСХОДНЫМ тиком начала матча (NTR-17): матч для
    // вернувшегося не начался заново, а оценка серверного тика у него
    // синхронизируется первым принятым снапшотом (NTR-10).
    this.send(connection.id, { type: 'Start', tick: this.startTick });
    // Реконнект В ПАУЗУ (NTR-20, решение D8): хендшейк от состояния паузы не
    // зависит, но живых рассылок в заморозке нет — поэтому замороженное
    // состояние и текущее состояние паузы уезжают здесь, в фиксированном
    // порядке. Заместитель, севший в паузу, получает то же самое: путь один.
    this.sendPauseState(connection);
  }

  /**
   * Соединение садится в слот арендатором (NTR-17, NTR-18). Единственное место,
   * где слот получает живое соединение, — и потому единственное, где гасится
   * наследство прежнего арендатора.
   */
  private seat(connection: Connection, slot: number, role: ConnectionRole): void {
    connection.phase = 'player';
    connection.slot = slot;
    connection.role = role;
    this.slotClaimed[slot] = true;
    this.slotConnection[slot] = connection.id;
    // Посадка живого соединения обнуляет молчание слота (NTR-6): порог есть
    // окно ВОЗВРАТА, и отсчитывать его новому арендатору с чужого числа значило
    // бы закрыть окно раньше срока. Дальше счётчик живёт как жил — по
    // неприбывшему вводу: живое соединение, переставшее слать кадры, порогом
    // матч завершает наравне с отвалившимся.
    this.metrics.slots[slot]!.silentTicks = 0;
    // Неисполненный ввод прежнего арендатора гасится: он адресован будущим
    // тикам слота, у которого сменился арендатор, и применялся бы уже за
    // вернувшегося владельца (NTR-7, NTR-18).
    this.pending[slot]!.clear();
    // Поток `Events` для ЭТОГО соединения открывается заново (NTR-17): всё, что
    // опубликовано до его посадки, ему не адресовано — ни как повтор виденного
    // до разрыва, ни как досылка пропущенного. Срез адресуется ПАРОЙ (NTR-16):
    // один номер тика ветвь истории не называет.
    connection.eventsFrom = this.state.tick + 1;
    connection.eventsEpoch = this.currentEpoch;
  }

  private welcome(connection: Connection, slot: number): void {
    this.send(connection.id, {
      type: 'Welcome',
      slot,
      players: this.config.players,
      seed: this.config.seed,
      match: { sceneRef: this.config.sceneRef, initial: this.config.initial ?? [] },
      worldInitHash: this.worldInitHash,
      pacing: this.pacing,
    });
  }

  /**
   * Сообщение потока для КОНКРЕТНОГО соединения (NTR-17): диапазон и пачки
   * срезаны по ПАРЕ его посадки — эпохе и тику (NTR-16).
   *
   * Накопитель ведётся по `viewpoint` — два соединения одной команды делят
   * отобранный поток (NET-12), — а «открыт заново» относится к соединению:
   * вернувшемуся не едут ни повторы окон, которые он видел ДО разрыва (дубли
   * VFX), ни пачки тиков, исполненных, пока у слота не было живого соединения
   * (досылка пропущенного, которую NTR-17 запрещает). Срез именно здесь, а не
   * сбросом накопителя, потому что накопитель может быть общим: выбросить
   * открытое окно из-за чужого возврата значило бы потерять ещё не
   * доставленные факты союзника — то, ради чего поток и заведён.
   *
   * Объявленный диапазон от среза не перестаёт быть полным: тики
   * `[eventsFrom, to]` собраны накопителем целиком, и тик без пачки внутри них
   * по-прежнему означает «событий не было» (NTR-15).
   *
   * Срез действует ТОЛЬКО в своей эпохе (NTR-16). Номера тиков разных эпох
   * несравнимы — «позже» между ветвями истории не определено, — и срез,
   * применённый к сообщению новой ветви, вырезал бы её целиком: перемотка
   * возвращает мир на тик РАНЬШЕ посадки вернувшегося (в этом её смысл), и
   * каждое следующее сообщение потока оказалось бы пустым с перевёрнутым
   * диапазоном `from > to`. Разбор такой кадр отвергает (NTR-4), клиент рвёт
   * канал — то есть возврат в матч заканчивался бы вылетом на первой же ульте
   * отката. Ветвь при этом ничего от среза и не требует: смена эпохи гасит
   * накопители целиком (`onEpochChanged`), и пережить её опубликованному до
   * посадки нечем.
   *
   * `undefined` — «этому соединению слать нечего»: весь объявленный диапазон
   * опубликован до его посадки. Пустое сообщение с `from > to` вместо этого
   * было бы кадром, который получатель обязан отвергнуть.
   */
  private eventsFor(connection: Connection, message: EventsMessage): EventsMessage | undefined {
    const from = connection.eventsFrom;
    if (message.epoch !== connection.eventsEpoch || from <= message.from) return message;
    if (from > message.to) return undefined;
    return {
      ...message,
      from,
      batches: message.batches.filter((batch) => batch.tick >= from),
    };
  }

  private start(): void {
    this.matchPhase = 'running';
    this.startTick = this.state.tick;
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      this.send(connection.id, { type: 'Start', tick: this.startTick });
    }
  }

  /**
   * Приём ввода (NTR-7). Порядок проверок — эпоха, верхняя граница окна,
   * исполненный тик, дубль: эпоха относится к сообщению целиком, окно и
   * исполненность к номеру тика, дедуп — к уже принятому кадру.
   */
  private ingest(slot: number, epoch: number, frames: readonly WireInput[]): void {
    const counters = this.metrics.slots[slot]!;
    const pending = this.pending[slot]!;
    const playerId = this.config.players[slot]!;

    // Единственное, что сервер берёт из кадров замороженного мира, — контрольный
    // бит инициатора перемотки: это «управление самой перемоткой», разрешённое
    // REW-5, и на симуляцию после возобновления оно не влияет (NET-11). Живых
    // тиков в `Rewinding` нет, поэтому через мир этот бит не доехал бы вовсе.
    //
    // Эпоха здесь намеренно не проверяется: клиент узнаёт о новой эпохе только
    // из восстановленного состояния, а держать орган управления он начинает
    // раньше — сверка эпохи погасила бы ровно те кадры, ради которых чтение и
    // заведено. Ветвь истории они не задевают: в мир этот бит не попадает.
    this.observeScrubHold(slot, frames);

    // Мир не идёт — ввод не принимается вовсе (NET-11, REW-5). Проверка стоит
    // перед проверкой эпохи, потому что клиент, пересинхронизировавшийся по
    // первому снапшоту новой эпохи, шлёт кадры с ВЕРНОЙ эпохой и верными
    // будущими тиками, пока мир ещё в `Rewinding` или `Paused`: они прошли бы
    // все остальные проверки, дождались бы в `pending` возобновления и легли бы
    // на мир залпом — «ввод, накопленный в замороженном мире и применённый
    // скопом на возобновлении, дал бы залп действий, которых игрок в идущем
    // матче не совершал» (NET-11).
    //
    // Молча и без счётчиков: NTR-11 такого класса не определяет, а канал здесь
    // исправен — отправитель не видит, что мир остановлен, и его кадры не
    // дефект ни канала, ни клиента. Пауза и перемотка для него неразличимы,
    // поэтому правило одно на оба режима.
    if (this.state.mode !== 'Running') return;

    // Эпоха — величина сообщения, а не кадра (NTR-16): ввод, порождённый в
    // стёртой перемоткой ветви истории, по номеру тика неотличим от свежего, и
    // без этой проверки применялся бы тем успешнее, чем мельче был откат.
    // Счётчик прежний, вышедших за окно (NTR-11): разошедшаяся эпоха — самый
    // крупный случай разъехавшейся оценки тика, а не отдельный класс дефекта.
    if (epoch !== this.currentEpoch) {
      counters.outOfWindow += frames.length;
      return;
    }

    for (const wire of frames) {
      // Верхняя граница окна — конечная и заданная конфигом матча (NTR-7): без
      // неё размер буфера неприменённого ввода на слот задавал бы клиент.
      // Отсюда же оценка буфера: в `pending` попадают только тики из
      // `(currentTick, currentTick + inputWindow]`, то есть не больше
      // `inputWindow` записей на слот.
      if (wire.tick > this.state.tick + this.inputWindow) {
        counters.outOfWindow++;
        continue;
      }
      if (wire.tick <= this.state.tick) {
        // Тик уже исполнен в текущей эпохе: он вошёл в канонический лог и
        // разослан клиентам, и правка задним числом переписала бы историю
        // незаметно для участников (NTR-7). Перемотка переписывает её иначе —
        // целым сегментом и новой эпохой, то есть наблюдаемо.
        counters.late++;
        continue;
      }
      // Дедуп «первый выигрывает» на пару (слот, тик) в пределах эпохи (NTR-7).
      // Молча и без счётчиков: избыточная отправка — штатный режим протокола
      // (NTR-4), и счёт её как дефекта сделал бы метрики нечитаемыми ровно у
      // исправного клиента.
      if (pending.has(wire.tick)) continue;
      pending.set(wire.tick, toInputFrame(wire, playerId, wire.tick));
    }
  }

  // ------------------------------------------------------------------- тик

  /**
   * Один тик матча. Вне `running` — no-op: до заполнения слотов мир стоит на
   * `worldInit` (NTR-6), после конца матча двигать нечего.
   */
  advance(): void {
    if (this.matchPhase !== 'running') return;
    // Вне `Running` живых тиков нет (REW-4): в `Paused` мир заморожен, в
    // `Rewinding` темп задаёт механизм перемотки. Тик ядра это и сам знает, но
    // до него дело доходить не должно — иначе канонический лог получил бы
    // кадры на тик, которого не было.
    //
    // Расписание при этом не останавливается: драйвер зовёт `advance()` тем же
    // темпом, и шаг перемотки делается здесь — точка остановки идёт назад по
    // тикам, пока инициатор держит орган управления (REW-7). Тем же шагом
    // ведётся и пауза матча (NTR-20): обратный отсчёт возобновления и предел
    // длительности заморозки — величины расписания хоста, а не тика (D2).
    //
    // Возобновившийся здесь мир исполняет первый живой тик СЛЕДУЮЩИМ шагом, а
    // не этим: один шаг расписания — одно действие, и втискивать тик в шаг,
    // который только что объявил возобновление, значило бы менять смысл шага в
    // зависимости от состояния.
    if (this.state.mode !== 'Running') {
      this.drivePause();
      this.driveScrub();
      return;
    }

    const tick = this.state.tick + 1;
    const frames: InputFrame[] = [];
    for (let slot = 0; slot < this.config.players.length; slot++) {
      frames.push(this.frameFor(slot, tick));
    }
    // Канонический лог пишется до тика: он и есть вход, который потом
    // прогоняется через `runScenario` (NTR-8). Сегмент открывается здесь —
    // первым ИСПОЛНЕННЫМ тиком новой эпохи (NTR-16).
    this.segmentOfEpoch().frames.push(...frames);
    this.inputLog?.record(tick, frames);

    // Отметка ветви — ПЕРЕД исполнением (DIAG-9): записи тика поедут в тот же
    // поток следом, и читатель отнесёт их к названной здесь эпохе, не забегая
    // вперёд. Эпоха матча — понятие сетевого слоя, полем записи ядра ей стать
    // нельзя (DI-6), поэтому она и приезжает отдельной строкой.
    this.config.trace?.mark({ mark: 'live', epoch: this.currentEpoch, tick });
    const result = advanceTick(this.sim, this.state, frames);
    dispatch(result, this.config.observers ?? []);
    this.history?.record(this.state);
    // Исполненный тик — тоже авторитетное состояние матча, и последовательность,
    // из которой выводится эпоха, состоит из них и из восстановлений.
    this.lastStateTick = this.state.tick;
    // Живой тик переписал запись лога на свой номер: дальше него запись
    // принадлежит стёртой ветви, и доигрывать по ней нечего.
    this.liveFrontier = this.state.tick;

    // Персональные проекции ЭТОГО тика — на каждом исполненном тике, а не
    // только на тиках рассылки (NTR-15, «Момент фильтрации»): видимость
    // события оценивается по состоянию мира того тика, на котором событие
    // опубликовано, а к рассылке мир уже другой. Отсюда же место в порядке
    // обработки — то же, где формируются персональные снапшоты (NTR-3).
    //
    // `result.isReplay` здесь всегда `false`, и проверять это нечем: живой тик
    // исполняется только этим вызовом `tick()`, а переисполненные тики
    // (`isReplay = true`, REW-4) живут внутри `seekTo` ядра и наружу
    // `TickResult` не отдают вовсе — накопителю их не видно по построению
    // (NTR-15, `tick-loop` OBS-5). Гарда нет потому, что гардить нечего.
    const filtered = this.filterByViewpoint();
    this.collectEvents(filtered);
    // Эпоха внутри `broadcastSnapshots` здесь не растёт: живой тик больше
    // предыдущего авторитетного состояния по построению, и накопленное окно
    // между отбором и рассылкой сброшено быть не может.
    if (tick % this.snapshotEvery === 0) this.broadcastSnapshots(filtered);

    // Запрос перемотки дренируется ПОСЛЕ тика и после рассылки его состояния:
    // тик, на котором ульта прожата, — обычный живой тик, и мир внутри него
    // событием не изменён (TICK-3). Переходы проводит хост, то есть сервер.
    this.drainRewindRequest(result);

    for (let slot = 0; slot < this.config.players.length; slot++) {
      if (this.metrics.slots[slot]!.silentTicks > this.silenceTicks) {
        this.end('player-silent');
        return;
      }
    }
  }

  /**
   * Сегмент текущей эпохи, открываемый по требованию (NTR-16). Открытие именно
   * здесь, на исполненном тике, и означает, что эпоха без исполненных тиков
   * сегмента не порождает: промежуточные точки скраба (REW-7) в состоянии мира
   * следа не оставляют.
   */
  private segmentOfEpoch(): OpenSegment {
    const last = this.segments[this.segments.length - 1];
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
    if (last !== undefined && last.epoch === this.currentEpoch) return last;
    const opened: OpenSegment = { epoch: this.currentEpoch, frames: [] };
    this.segments.push(opened);
    return opened;
  }

  private frameFor(slot: number, tick: number): InputFrame {
    const counters = this.metrics.slots[slot]!;
    const pending = this.pending[slot]!;
    const arrived = pending.get(tick);
    if (arrived !== undefined) {
      pending.delete(tick);
      this.lastFrame[slot] = arrived;
      counters.applied++;
      counters.silentTicks = 0;
      return arrived;
    }

    counters.predicted++;
    counters.silentTicks++;
    const last = this.lastFrame[slot];
    const playerId = this.config.players[slot]!;
    // Повтор последнего (TICK-2). До первого кадра повторять нечего — нулевой
    // ввод, а не отсутствие ввода: слот обязан присутствовать в каноническом
    // логе на каждом тике, иначе запись перестаёт быть воспроизводимой.
    if (last === undefined) {
      return { tick, playerId, seq: 0, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };
    }
    return { ...last, tick };
  }

  /**
   * `viewpoint` соединения (NET-12, NTR-9). Наблюдателю — `VIEWPOINT_ALL`,
   * игроку — команда его слота либо сам слот. Одно место на все каналы:
   * разойтись `viewpoint`'ом между снапшотом и потоком событий значило бы
   * завести второй отбор там, где NET-13 требует один.
   */
  private viewpointOf(connection: Connection): number {
    return connection.phase === 'observer'
      ? VIEWPOINT_ALL
      : (this.config.teams?.[connection.slot] ?? connection.slot);
  }

  /**
   * Персональная проекция текущего состояния (NET-12, NET-18): отобранный мир и
   * отобранная тем же вызовом шина. Наблюдателю (`VIEWPOINT_ALL`) фильтр
   * снимается целиком — и с мира, и с шины, — а не по каналам (NTR-9).
   *
   * ponytail: отбор идёт единственным опубликованным входом ядра, а он копирует
   * мир целиком (`engine/core-ts/src/sim/filter.ts`). Звать его на каждом тике
   * на каждый `viewpoint` — вдвое больше копий, чем прежде, при `snapshotRate`
   * вдвое меньше `tickRate`. Узкий вход «отфильтровать только события, без
   * копирования мира» заводится ОТДЕЛЬНЫМ изменением ядра со своим требованием
   * (NTR-1), а не правкой по ходу сетевой работы; до него живём копией и меряем.
   */
  private filterFor(viewpoint: number): Snapshot {
    return this.config.eventVisibility === undefined
      ? filterSnapshot(this.state, viewpoint)
      : filterSnapshot(this.state, viewpoint, this.config.eventVisibility);
  }

  /**
   * Проекции тика по одной на активный `viewpoint`, а не на соединение: два
   * соединения одной команды видят одно и то же, и второй вызов фильтра дал бы
   * ту же копию мира второй раз.
   */
  private filterByViewpoint(): Map<number, Snapshot> {
    const filtered = new Map<number, Snapshot>();
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      const viewpoint = this.viewpointOf(connection);
      if (filtered.has(viewpoint)) continue;
      filtered.set(viewpoint, this.filterFor(viewpoint));
    }
    return filtered;
  }

  private streamOf(viewpoint: number): EventStream {
    const existing = this.eventStreams.get(viewpoint);
    if (existing !== undefined) return existing;
    const opened: EventStream = { from: -1, to: -1, batches: [], repeats: [] };
    this.eventStreams.set(viewpoint, opened);
    return opened;
  }

  /**
   * Накопление УЖЕ ОТОБРАННОГО (NTR-15): в поток кладётся шина персональной
   * проекции, а не шина тика. Отобрать позже нельзя, не изменив ответ, и оба
   * направления ошибки дефектны — потерянный факт видимого врага и утёкший
   * факт невидимого.
   *
   * Открытое окно ведёт диапазон, а не список тиков: тик без событий пачки не
   * заводит, но в диапазон входит, и получатель читает его как «событий не
   * было».
   */
  private collectEvents(filtered: ReadonlyMap<number, Snapshot>): void {
    const tick = this.state.tick;
    // Накопитель `viewpoint`, которого на этом тике нет вовсе (все его
    // соединения отпали), выбрасывается, а не ждёт возвращения. Иначе
    // объявленный диапазон солгал бы (NTR-15): окна в кольце остались бы от
    // прежнего соединения, тики без соединения никем не собирались, и первое же
    // сообщение вернувшегося наблюдателя объявило бы `from` из старого кольца —
    // то есть покрытие интервала, который не считали, а событие внутри него
    // читалось бы как «событий не было». Возобновившийся `viewpoint` начинает с
    // чистого окна: разрыв в его потоке — это разрыв, а не тишина.
    //
    // Заодно карта перестаёт держать мёртвые накопители: ключей в ней не больше,
    // чем активных `viewpoint` прямо сейчас.
    for (const viewpoint of this.eventStreams.keys()) {
      if (!filtered.has(viewpoint)) this.eventStreams.delete(viewpoint);
    }
    for (const [viewpoint, personal] of filtered) {
      const stream = this.streamOf(viewpoint);
      if (stream.from < 0) stream.from = tick;
      stream.to = tick;
      if (personal.events.length > 0) stream.batches.push({ tick, events: personal.events });
    }
  }

  /**
   * Закрыть открытое окно `viewpoint` и собрать из него сообщение (NTR-15).
   *
   * Объявленный диапазон — повторяемые окна плюс текущее. Окна смежны по
   * построению (каждое открывается тиком, следующим за `to` предыдущего),
   * поэтому склейка непрерывна и покрыта полностью. Повтор — избыточность
   * вместо подтверждений: пачка едет `eventRepeat + 1` раз и переживает
   * `eventRepeat` потерь подряд, а однократность держит курсор получателя.
   */
  private closeEventWindow(viewpoint: number, epoch: number): EventsMessage {
    const stream = this.streamOf(viewpoint);
    const closed: EventWindow = { from: stream.from, to: stream.to, batches: stream.batches };
    const batches: EventBatch[] = [];
    for (const window of stream.repeats) batches.push(...window.batches);
    batches.push(...closed.batches);
    const from = stream.repeats[0]?.from ?? closed.from;

    stream.repeats.push(closed);
    // Кольцо: разосланных окон держится ровно `eventRepeat`. При нуле окно
    // вытесняется сразу же — «без повтора» (NTR-15).
    while (stream.repeats.length > this.eventRepeat) stream.repeats.shift();
    stream.from = -1;
    stream.to = -1;
    stream.batches = [];

    return { type: 'Events', epoch, from, to: closed.to, batches };
  }

  /**
   * Тик исполнен один раз, снапшотов — по числу соединений (NET-12).
   *
   * `filtered` — проекции ЭТОГО тика, снятые отбором событий (NTR-15): рассылка
   * по расписанию берёт их готовыми, а не фильтрует мир второй раз. Тем самым
   * шина в кадре `Snapshot` и поток `Events` отобраны буквально одним вызовом на
   * одном тике — то, чего требует шов с NET-18: разойдись предикат или момент, и
   * клиент увидел бы в состоянии факт, которого нет в потоке.
   *
   * Отсутствие `filtered` означает рассылку МИМО расписания — по факту
   * восстановления во время `Rewinding` (NTR-16). Она фильтрует сама и потока
   * событий не несёт: расписание у `Events` то же, что у снапшотов по NTR-7
   * (NTR-15, «Расписание»), восстановленный тик исполнен в ПРЕЖНЕЙ эпохе и свои
   * события в ней уже отдал, переисполненные тики в накопитель не попадают
   * (REW-4, OBS-5), а живых тиков новой эпохи в этот момент ещё нет — то есть
   * объявлять нечего: диапазон замкнут, и открыть его не с чего.
   */
  private broadcastSnapshots(filtered?: ReadonlyMap<number, Snapshot>): void {
    // Номер тика берётся из самого состояния, а не из аргумента: рассылка идёт
    // и по расписанию, и по факту восстановления (NTR-16), и вызывающая сторона
    // не должна иметь способа разойтись номером с тем, что уедет на провод.
    const tick = this.state.tick;
    // Единственное место, где эпоха увеличивается (NTR-16). Правило —
    // «тик очередного авторитетного состояния меньше тика предыдущего», и оно
    // применяется здесь потому, что здесь формируется рассылка: оба источника
    // состояния проходят через эту точку и второй нумерации не заводят.
    if (this.lastStateTick >= 0 && tick < this.lastStateTick) this.onEpochChanged(tick);
    this.lastStateTick = tick;
    // Та же выведенная величина штампуется и в `Snapshot`, и в `Events`
    // (NTR-16): считать эпоху заново на каждое сообщение значило бы завести
    // второй вывод одной величины.
    const epoch = this.currentEpoch;

    // Сообщение потока — одно на `viewpoint`: два соединения одной команды
    // делят и пачку, и кадр.
    const events = filtered === undefined ? undefined : new Map<number, EventsMessage>();

    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      const viewpoint = this.viewpointOf(connection);
      const personal = filtered?.get(viewpoint) ?? this.filterFor(viewpoint);
      // На провод уезжает ПРОЕКЦИЯ персонального снапшота — перечисленные NET-18
      // части, а не объект ядра целиком: состояния стримов RNG в кадр не
      // кладутся. Ветки «наблюдателю можно всё» здесь нет и не будет —
      // `toWireSnapshot` один на всех получателей (NET-18, NET-15).
      this.send(connection.id, { type: 'Snapshot', epoch, tick, snapshot: toWireSnapshot(personal) });
      this.metrics.snapshotsSent++;

      // Поток идёт тем же путём и наблюдателю, и игроку — отдельной ветки для
      // `VIEWPOINT_ALL` здесь нет (NTR-15). Условие на `filtered` — не про
      // наблюдателя, а про то, что события этого тика для этого `viewpoint`
      // отобраны: иначе объявленный диапазон утверждал бы покрытие, которого не
      // считали.
      if (events === undefined || filtered?.has(viewpoint) !== true) continue;
      let message = events.get(viewpoint);
      if (message === undefined) {
        message = this.closeEventWindow(viewpoint, epoch);
        events.set(viewpoint, message);
      }
      // Общая на `viewpoint` пачка — и персональный срез по паре посадки
      // соединения (NTR-17): вернувшемуся не едет ни виденное до разрыва, ни
      // пропущенное за время отсутствия. Срез, съевший диапазон целиком, не
      // едет вовсе — сообщения без диапазона не бывает (NTR-15).
      const addressed = this.eventsFor(connection, message);
      if (addressed !== undefined) this.send(connection.id, addressed);
    }
  }

  /**
   * Разрыв монотонности тика (NTR-16). Кроме самого счётчика здесь гасится
   * накопленный, но ещё не применённый ввод всех слотов (NTR-7): он порождён в
   * стёртой ветви истории, помечен прежней эпохой и после возобновления
   * применялся бы тем успешнее, чем мельче был откат.
   *
   * Здесь же сбрасываются накопители потока событий (NTR-15): пачки стёртой
   * эпохи по паре `(эпоха, тик)` меньше курсора получателя и приняты быть не
   * могут, сколько их ни повторяй. Кольцо уходит целиком — оно той же стёртой
   * эпохи, — и первое сообщение новой эпохи откроет диапазон с первого ЖИВОГО
   * тика новой ветви.
   *
   * Но открытое окно ПЕРЕД сбросом отдаётся: его префикс — тики от `stream.from`
   * до тика восстановления — исполнен живьём и перемоткой НЕ стёрт, их эффекты
   * лежат в восстановленном мире, и «события каждого исполненного тика SHALL
   * доставляться» (NTR-15, «Накопление») относится к ним в полной мере.
   * Выбросить их вместе с кольцом значило бы терять факты тем вернее, чем реже
   * рассылка. Уходит это сообщением ПРЕЖНЕЙ эпохи и до того, как эпоха выросла:
   * по паре оно выше курсора получателя, встык к последнему объявленному
   * диапазону (`from` = первый несобранный тик, `to` = тик восстановления), а
   * рост эпохи следом разрывом не считается (NTR-16, решение 8).
   *
   * Хвост за точкой восстановления — пачки стёртой ветви — отбрасывается вместе
   * с кольцом: цена, записанная в решении 8 дизайна.
   */
  private onEpochChanged(restoredTick: number): void {
    this.flushPrefixOfErasedEpoch(restoredTick);
    this.currentEpoch++;
    for (const pending of this.pending) pending.clear();
    this.eventStreams.clear();
    // Персональные срезы потока (NTR-17) снимаются вместе с накопителями:
    // накопители ушли целиком, и пережить смену ветви истории тому, что
    // опубликовано до посадки соединения, нечем — резать в новой эпохе больше
    // не от чего, а номера её тиков со старым срезом несравнимы (NTR-16).
    for (const connection of this.connections.values()) {
      connection.eventsFrom = 0;
      connection.eventsEpoch = this.currentEpoch;
    }
  }

  /**
   * Префикс открытого окна каждого `viewpoint` — исполненные и не стёртые
   * перемоткой тики — уходит сообщением прежней эпохи (см. `onEpochChanged`).
   *
   * Это последнее сообщение эпохи, следующего за ним не будет, поэтому оно
   * максимально избыточно (NTR-15 «Избыточность», тот же довод, что у хвоста
   * перед `End`): кольцо повторов вкладывается целиком, срезанное по точке
   * восстановления. Тики за ней — ветвь, которую перемотка стёрла: их пачки
   * не едут, а объявленный диапазон кончается на `restoredTick`, так что
   * «покрыт полностью» остаётся правдой. Слать нечего только когда и окно, и
   * кольцо целиком за точкой восстановления либо пусты.
   */
  private flushPrefixOfErasedEpoch(restoredTick: number): void {
    const epoch = this.currentEpoch;
    for (const [viewpoint, stream] of this.eventStreams) {
      const from = stream.repeats[0]?.from ?? stream.from;
      if (from < 0 || from > restoredTick) continue;
      const batches: EventBatch[] = [];
      for (const window of stream.repeats) batches.push(...window.batches);
      if (stream.from >= 0) batches.push(...stream.batches);
      this.sendToViewpoint(viewpoint, {
        type: 'Events',
        epoch,
        from,
        to: restoredTick,
        batches: batches.filter((batch) => batch.tick <= restoredTick),
      });
    }
  }

  /**
   * Одно сообщение — всем соединениям `viewpoint`, тем же объектом: пачка
   * считается один раз на `viewpoint`, как и на рассылке.
   */
  private sendToViewpoint(viewpoint: number, message: ServerMessage): void {
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      if (this.viewpointOf(connection) !== viewpoint) continue;
      // Поток режется по паре посадки и здесь: путь доставки другой, а правило
      // «соединению не едет то, что опубликовано до его посадки» одно (NTR-17).
      if (message.type !== 'Events') {
        this.send(connection.id, message);
        continue;
      }
      const personal = this.eventsFor(connection, message);
      if (personal !== undefined) this.send(connection.id, personal);
    }
  }

  // ------------------------------------------------------------ пауза матча

  /** Текущее состояние паузы матча (NTR-20). Наблюдательный доступ для обвязки и тестов. */
  get pauseState(): PauseState {
    return this.pausePhase;
  }

  /** Слот-инициатор текущего состояния паузы; `-1` — обвязка (стенд, админ). */
  get pauseInitiator(): number {
    return this.pauseSlot;
  }

  /**
   * Длительность в миллисекундах → шагов расписания. Драйвер зовёт `advance()`
   * в темпе `tickRate` и в заморозке тоже (см. `advance`), поэтому шаг равен
   * тику по длительности — и отсчёт паузы остаётся wall-clock'ом ХОСТА
   * (решение D2), не заводя часов внутри сервера (NTR-3).
   *
   * Округление вверх: объявленная длительность — обещание игроку, и отсчёт,
   * кончившийся раньше объявленного, хуже кончившегося на шаг позже.
   */
  private stepsOf(ms: number): number {
    if (ms <= 0) return 0;
    return Math.max(1, Math.ceil((ms * this.tickRate) / 1000));
  }

  /**
   * Запрос паузы от участника матча (NTR-20). Решает СЕРВЕР по данным политики
   * матча: бюджеты и права — его учёт вне мира (решение D3).
   *
   * Недопущенный запрос получает адресный `Pause` с НЕИЗМЕНЁННЫМ состоянием и
   * названной причиной — соединение живо, матч не тронут (решение D4): `Reject`
   * в этом протоколе рвёт соединение (NTR-4, NTR-5), а «нельзя сейчас» — не
   * нарушение протокола.
   */
  private requestPause(connection: Connection, action: PauseAction): void {
    // Наблюдатель (NTR-9) паузой не распоряжается: слота у него нет, бюджет
    // считать не на ком, и «кто поставил» некому назвать.
    if (connection.phase !== 'player') {
      this.denyPause(connection.id, 'not-a-player');
      return;
    }
    const denied =
      action === 'pause' ? this.freezeBySlot(connection.slot) : this.unfreezeBySlot(connection.slot);
    if (denied !== undefined) this.denyPause(connection.id, denied);
  }

  /**
   * Пауза по вызову ОБВЯЗКИ (NTR-20): стенд — в том числе как политика реакции
   * на отвязку владельца (решение D6), — админ через управляющий канал
   * (`server-control` SRV-5).
   *
   * Тот же путь, что у запроса игрока, минус бюджет игрока: бюджет — правило
   * для участников матча, а обвязка участником не является. Возвращает
   * названную причину отказа либо `undefined` — обвязке её показывать человеку,
   * а не гадать по состоянию.
   */
  pauseMatch(): PauseDenyReason | undefined {
    return this.freezeBySlot(SERVER_SLOT);
  }

  /** Снятие паузы обвязкой (NTR-20): срок права противника к ней не относится. */
  resumeMatch(): PauseDenyReason | undefined {
    return this.unfreezeBySlot(SERVER_SLOT);
  }

  /**
   * Заморозка: общий путь игрока и обвязки. Проверки идут от самого общего к
   * самому частному — состояние матча, состояние мира, состояние паузы, бюджет,
   * — потому что ровно в этом порядке они перестают быть верными.
   */
  private freezeBySlot(slot: number): PauseDenyReason | undefined {
    if (this.matchPhase !== 'running') return 'match-not-running';
    // Мир в `Rewinding` — машина перемотки доигрывает свой флоу нетронутой
    // (NTR-20, сценарий «Пауза во время перемотки»). Её служебный `Paused`
    // сюда попасть не может: скраб ведётся вызовами `advance()` внутри одного
    // шага, и снаружи мир между ними всегда `Rewinding`.
    if (this.freezeSource === 'rewind' || this.state.mode === 'Rewinding') return 'rewinding';
    // Объявленный отсчёт доводится до конца: отмены объявленного возобновления
    // механизм не знает, а поставить паузу снова можно уже после него — за счёт
    // своего бюджета. Иначе двое игроков ставили бы и снимали её по кругу, и
    // матч не возобновился бы никогда.
    //
    // Причина при этом называет то, что есть на самом деле: «уже стоит» и «уже
    // возобновляется» — разные состояния и разные действия игрока дальше
    // (ждать снятия против ждать отсчёта), а отказ обязан быть ИМЕННОВАННЫМ
    // (NTR-20), то есть отвечать на «почему нельзя», а не на «нельзя».
    if (this.pausePhase === 'resuming') return 'already-resuming';
    if (this.pausePhase !== 'running') return 'already-frozen';
    if (slot !== SERVER_SLOT) {
      if ((this.pausesUsed[slot] ?? 0) >= this.pauseBudget) return 'budget-spent';
      this.pausesUsed[slot] = (this.pausesUsed[slot] ?? 0) + 1;
    }
    this.wsm.pause();
    this.freezeSource = 'match-pause';
    this.pausePhase = 'frozen';
    this.pauseSlot = slot;
    this.frozenSteps = 0;
    this.resumeSteps = 0;
    this.broadcastPause();
    return undefined;
  }

  /**
   * Снятие: объявление обратного отсчёта либо немедленное возобновление, если
   * политика отсчёта не объявила.
   *
   * Право на снятие ЧУЖОЙ паузы приходит по сроку (`opponentUnpauseAfterMs`):
   * инициатор снимает свою когда угодно, обвязка — тоже (она не противник).
   */
  private unfreezeBySlot(slot: number): PauseDenyReason | undefined {
    if (this.matchPhase !== 'running') return 'match-not-running';
    if (this.freezeSource === 'rewind') return 'rewinding';
    if (this.pausePhase === 'running') return 'not-frozen';
    if (this.pausePhase === 'resuming') return 'already-resuming';
    if (
      slot !== SERVER_SLOT &&
      slot !== this.pauseSlot &&
      this.frozenSteps < this.opponentUnpauseSteps
    ) {
      return 'too-early';
    }
    this.beginResume(slot);
    return undefined;
  }

  /**
   * Объявление возобновления (NTR-20): «возобновляется» с длительностью отсчёта,
   * по истечении которого проводится `Paused → Running`.
   *
   * Нулевой отсчёт — не особый случай, а его вырожденная длина: состояние
   * `resuming` не объявляется вовсе, и матч продолжается тем же шагом. Объявить
   * отсчёт нулевой длительности значило бы прислать HUD состояние, которое
   * кончится раньше, чем он его нарисует.
   */
  private beginResume(slot: number): void {
    this.pauseSlot = slot;
    if (this.resumeCountdownSteps === 0) {
      this.finishResume();
      return;
    }
    this.pausePhase = 'resuming';
    this.resumeSteps = this.resumeCountdownSteps;
    this.broadcastPause();
  }

  /** Конец отсчёта: `Paused → Running` и объявление «идёт» (NTR-20). */
  private finishResume(): void {
    this.wsm.resume();
    this.freezeSource = 'none';
    this.pausePhase = 'running';
    this.resumeSteps = 0;
    this.frozenSteps = 0;
    // Накопленный неприменённый ввод гасится по тому же основанию, что и на
    // выходе из перемотки (`resume`): кадр, доехавший до заморозки, ждал бы
    // возобновления и лёг бы на мир залпом — «действий, которых игрок в идущем
    // матче не совершал» (NET-11).
    for (const pending of this.pending) pending.clear();
    this.broadcastPause();
  }

  /**
   * Ведение паузы в темпе расписания: обратный отсчёт возобновления и предел
   * длительности одной заморозки.
   *
   * Предел — ответ на риск «пауза на неопределённо долго вешает матч и слоты
   * стенда»: по его истечении возобновление объявляет САМ сервер, инициатором
   * `SERVER_SLOT`. Число приходит документом матча, а не отсюда.
   */
  private drivePause(): void {
    if (this.freezeSource !== 'match-pause') return;
    if (this.pausePhase === 'resuming') {
      this.resumeSteps--;
      if (this.resumeSteps <= 0) this.finishResume();
      return;
    }
    this.frozenSteps++;
    if (this.maxPauseSteps > 0 && this.frozenSteps >= this.maxPauseSteps) {
      this.beginResume(SERVER_SLOT);
    }
  }

  /** Остаток объявленного отсчёта в миллисекундах — то, что уезжает на провод. */
  private countdownMs(): number {
    if (this.pausePhase !== 'resuming') return 0;
    return Math.ceil((this.resumeSteps * 1000) / this.tickRate);
  }

  /**
   * Смена состояния паузы — ВСЕМ соединениям матча, включая наблюдателя
   * (NTR-20, NTR-9). Адресного среза здесь нет и быть не может: пауза одна на
   * матч, и знать о ней участники обязаны одинаково.
   */
  private broadcastPause(): void {
    const message: ServerMessage = {
      type: 'Pause',
      state: this.pausePhase,
      slot: this.pauseSlot,
      countdownMs: this.countdownMs(),
    };
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      this.send(connection.id, message);
    }
  }

  /**
   * Адресный отказ (решение D4): то же сообщение, НЕИЗМЕНЁННОЕ состояние и
   * названная причина. Уходит только запросившему — рассылать отказ остальным
   * значило бы сообщать им о чужих нажатиях.
   */
  private denyPause(to: ConnectionId, denied: PauseDenyReason): void {
    this.send(to, {
      type: 'Pause',
      state: this.pausePhase,
      slot: this.pauseSlot,
      countdownMs: this.countdownMs(),
      denied,
    });
  }

  /**
   * Состояние паузы вошедшему в ИДУЩИЙ матч (решение D8, NTR-20) — вернувшемуся
   * владельцу (NTR-17), заместителю (NTR-18) и наблюдателю (NTR-9).
   *
   * Уезжает ВСЕГДА, а не только в заморозке, и это не избыточность: «паузы нет»
   * — утверждение сервера, а его отсутствие — отсутствие утверждения. Вернись
   * игрок в матч, который возобновили без него, и без этого сообщения его HUD
   * так и держал бы оверлей паузы, поставленной до разрыва: доставленного
   * состояния, которое его снимет, не пришло бы никогда (HUD-9).
   *
   * Замороженное состояние снапшотом идёт ПЕРЕД ним, и порядок обратным быть не
   * может: рассылок снапшота в заморозке нет вовсе, поэтому без него вернувшийся
   * смотрел бы в пустой мир до самого возобновления, а приди `Pause` раньше —
   * HUD мигнул бы «боем», потому что состояние приехало бы после объявления
   * паузы.
   */
  private sendPauseState(connection: Connection): void {
    if (this.matchPhase !== 'running') return;
    if (this.pausePhase !== 'running') {
      const personal = this.filterFor(this.viewpointOf(connection));
      this.send(connection.id, {
        type: 'Snapshot',
        epoch: this.currentEpoch,
        tick: this.state.tick,
        snapshot: toWireSnapshot(personal),
      });
    }
    this.send(connection.id, {
      type: 'Pause',
      state: this.pausePhase,
      slot: this.pauseSlot,
      countdownMs: this.countdownMs(),
    });
  }

  // -------------------------------------------------------------- перемотка

  /**
   * Механизм перемотки (WSM-5). Политика ульты — кто инициирует, на сколько
   * отматывает, где останавливается — живёт системой поверх этих вызовов, и
   * сервер её не подменяет: здесь только доставка её последствий клиентам.
   */
  private requireRewind(): RewindController {
    if (this.rewindController === undefined) {
      throw new Error('MatchServer: матч поднят без истории — перематывать нечем (NET-11, SNAP-4)');
    }
    return this.rewindController;
  }

  /**
   * Исполнение запроса, пришедшего из симуляции (REW-12): `Running → Paused →
   * Rewinding` (WSM-2, NET-11). Решение о входе в перемотку порождает
   * геймплейная система ульты, а не сервер: здесь только проведение переходов и
   * запоминание того, чем ограничен скраб.
   *
   * Запрос не в `Running` игнорируется: перемотка внутри перемотки запрещена
   * (REW-8), а гейты политики (cooldown, стоимость) отработали в evaluator до
   * эмиссии события. Испорченный payload — туда же: `parse` предупреждает и
   * отдаёт `undefined`, а не бросает (см. `rewindRequest.ts`).
   *
   * Матч, поднятый БЕЗ истории, запрос тоже не исполняет — перематывать в нём
   * нечем, и падать из-за контента, рассчитанного на другой профиль матча,
   * серверу незачем. Но это не тот же случай, что «запрос не в `Running`», и
   * сводить их к одному `return` нельзя. REW-12 велит игнорировать запрос,
   * поданный не в `Running`: там сработала норма — мир уже перематывается, и
   * второго входа у машины состояний нет. Здесь же дефект СБОРКИ: сцена просит
   * механизм, которого хост не собрал, — и молчание об этом выглядит снаружи
   * как ульта, которая ничего не делает. Ровно так и жил дефект: стенд поднимал
   * матч без секции `rewind`, потому что раскладка документа её теряла
   * (`bin/matchFile.mjs`), а сервер не сказал ни слова.
   *
   * Отчёт — диагностика, а не исключение: живой матч убивать нечем (то же
   * основание, что у испорченного payload'а), и не молчаливый счётчик: искать
   * его пошли бы уже после того, как дефект признали дефектом.
   */
  private drainRewindRequest(result: TickResult): void {
    // Несобираемость уже названа — сканировать шину незачем: второй раз она
    // ничего нового не сообщит, а матч без истории возвращается к прежней
    // нулевой стоимости дренажа.
    if (this.rewindController === undefined && this.rewindUnavailableReported) return;
    if (this.state.mode !== 'Running') return;
    const request = firstRewindRequest(result.events, this.config.rewindWarn);
    if (request === undefined) return;
    if (this.rewindController === undefined) {
      this.rewindUnavailableReported = true;
      const warn = this.config.rewindWarn ?? warnToConsole;
      warn(
        `${REWIND_REQUEST_EVENT}: матч ${this.config.name === undefined ? '' : `"${this.config.name}" `}` +
          'поднят без секции `rewind` — истории нет, перематывать нечем (NET-11, SNAP-4). ' +
          'Запрос отброшен, следующие запросы этого матча отбрасываются молча; ' +
          'секция `rewind` живёт в документе матча (NTR-6, NTR-14)',
      );
      return;
    }

    this.pause();
    this.beginRewind();
    const session: ScrubSession = {
      slot: this.slotOf(request.initiator),
      floor: this.scrubFloor(request.depthTicks),
      // Орган управления в момент каста удержан по построению: ульта прожата
      // им же. Первый пришедший кадр инициатора это подтвердит или снимет.
      held: true,
      idleTicks: 0,
      sinceStep: 0,
      stepped: false,
    };
    // Шага здесь нет намеренно: тик, на котором ульта прожата, обязан остаться
    // тем, каким его оставил живой тик (TICK-3), — точку ведёт драйвер, и
    // первый её шаг он делает на первом же своём вызове (см. `driveScrub`).
    this.scrub = session;
  }

  /**
   * Глубина, ниже которой точка перемотки не уходит: глубина из запроса
   * (политика контента) и фактическая глубина истории (SNAP-6) — что мельче.
   * Ниже нуля не бывает: тик 0 — тоже точка восстановления (REW-1).
   */
  private scrubFloor(depthTicks: number): number {
    const requested = this.state.tick - Math.max(0, depthTicks);
    return Math.max(0, requested, this.history?.oldestTick ?? 0);
  }

  /** Слот сущности-инициатора; `-1` — сущность слоту матча не сопоставлена. */
  private slotOf(entity: EntityId): number {
    const world = this.state.world;
    if (!coreWorld.isAlive(world, entity)) return -1;
    if (!coreWorld.hasComponent(world, entity, SLOT_COMPONENT)) return -1;
    const slot = coreWorld.getField(world, entity, SLOT_COMPONENT, SLOT_FIELD);
    return slot >= 0 && slot < this.config.players.length ? slot : -1;
  }

  /**
   * Контрольный бит инициатора из самого свежего его кадра (REW-13, NET-11).
   * Кадры не-инициатора не читаются вовсе: скраб ведёт только тот, чья система
   * ульту прожала, — остальной ввод замороженного мира отбрасывается, как и
   * прежде.
   *
   * «Самый свежий» меряется по `seq`, а не по номеру тика: `seq` монотонен у
   * отправителя (NTR-7), а номер тика клиент пересинхронизирует по каждому
   * восстановленному состоянию (NTR-10) и во время скраба УМЕНЬШАЕТ — по нему
   * кадр, отправленный позже, выглядел бы более старым. Пока сообщение везёт
   * ровно один кадр, разницы нет; правило же должно держаться и на пачке.
   */
  private observeScrubHold(slot: number, frames: readonly WireInput[]): void {
    const session = this.scrub;
    if (session?.slot !== slot) return;
    const button = this.config.rewind?.holdButton;
    if (button === undefined) return;
    let freshest: WireInput | undefined;
    for (const wire of frames) {
      if (freshest === undefined || wire.seq > freshest.seq) freshest = wire;
    }
    if (freshest === undefined) return;
    session.held = (freshest.buttons & (1 << button)) !== 0;
    session.idleTicks = 0;
  }

  /**
   * Ведение точки перемотки (REW-13, NTR-16). Первый шаг делается на первом же
   * ведении, дальше — раз в цикл рассылки, пока орган удержан. Реже тика
   * намеренно (начиная со второго шага): каждое
   * восстановление уезжает клиентам отдельным состоянием, и вести точку чаще,
   * чем сервер её рассылает, значило бы считать восстановления, которых никто
   * не увидит.
   *
   * Отпускание, молчание инициатора дольше порога и достижение глубины дают
   * один и тот же исход — `Rewinding → Paused → Running` (WSM-2): мир
   * продолжается с той точки, на которой скраб кончился.
   *
   * Тот же драйвер на втором хосте — `WorkerShell.driveScrub`
   * (`engine/client-ts`, SHELL-6): локальный режим ведёт точку по тем же
   * правилам, читая орган из сообщений главного потока, а не из кадров слота.
   * Общего кода у них нет намеренно — см. комментарий там, — поэтому правка
   * ЗДЕСЬ обязана быть повторена ТАМ, и наоборот. Держит их в шаге
   * поведенческий тест, поставленный обоим хостам: короткое нажатие двигает
   * точку и возобновляет мир на более раннем тике.
   */
  private driveScrub(): void {
    const session = this.scrub;
    if (session === undefined) return;
    // Мир вывели из `Rewinding` мимо драйвера (пауза от политики, ручной
    // `resume`) — ведение точки прекращается: авторитет над машиной состояний
    // один, и второго ведущего у неё нет.
    if (this.state.mode !== 'Rewinding') {
      this.scrub = undefined;
      return;
    }
    // Сущность-инициатор слоту матча не сопоставлена (бот, сущность сцены,
    // погибший игрок) — органа управления у этой перемотки нет вовсе, и
    // `observeScrubHold` для неё не сработает ни разу. Ждать порог молчания
    // незачем: он отвечает на «связь пропала», а здесь ответ известен сразу —
    // мир замер бы на четверть секунды впустую.
    if (session.slot < 0) {
      this.stopScrub();
      return;
    }

    session.idleTicks++;

    // ПЕРВЫЙ шаг — на первом же ведении, без ожидания цикла рассылки и без
    // перепроверки органа. Прежде первого шага ждали `snapshotEvery` тиков, а
    // проверка отпускания стояла ЗА тем же гейтом, — и короткое нажатие не
    // двигало точку ВООБЩЕ: игрок отпускал орган внутри первого цикла, драйвер
    // досиживал цикл, видел уже отпущенный орган и возобновлял мир на том же
    // тике. Ульта сгорала на полный cooldown, не отмотав ни тика.
    //
    // Перепроверки органа на этом шаге нет по построению: вход в перемотку
    // означает, что орган был удержан — ульту прожали им же (REW-13, NET-11).
    if (!session.stepped) {
      this.stepScrub();
      return;
    }

    // Дальше отпускание и молчание инициатора читаются КАЖДЫЙ тик, а не на
    // границе шага: досиженный цикл — это мир, замерший уже после того, как
    // игрок отпустил клавишу.
    if (!session.held || session.idleTicks > this.holdTimeoutTicks) {
      this.stopScrub();
      return;
    }

    session.sinceStep++;
    if (session.sinceStep < this.snapshotEvery) return;
    this.stepScrub();
  }

  /**
   * Один шаг точки перемотки назад (REW-13): на `rewind.step` тиков, но не
   * глубже заявленной глубины автостопа и не глубже фактической глубины
   * истории — обе границы уже сведены в `floor` (SNAP-6).
   *
   * Достигнув дна, скраб останавливается сам: дальше отматывать нечего, и
   * возобновление не ждёт отпускания клавиши.
   *
   * Зовут его двое — вход в перемотку и драйвер, — и оба через эту функцию:
   * второй экземпляр той же арифметики рядом и есть способ им разойтись.
   */
  private stepScrub(): void {
    const session = this.scrub;
    if (session === undefined) return;
    session.sinceStep = 0;
    session.stepped = true;
    const target = Math.max(session.floor, this.state.tick - this.scrubStep);
    if (target < this.state.tick) this.seekTo(target);
    // Автостоп: дальше отматывать нечего, и резюм не ждёт отпускания клавиши.
    if (target <= session.floor) this.stopScrub();
  }

  /** Конец ведения точки: мир возобновляется с текущей, откаченной, точки. */
  private stopScrub(): void {
    this.scrub = undefined;
    this.pause();
    this.resume();
  }

  /**
   * `Running → Paused` либо `Rewinding → Paused` (WSM-2) — СЛУЖЕБНАЯ заморозка
   * машины перемотки. Паузой матча она не является: у той свой путь
   * (`pauseMatch`, `PauseRequest`) и своя причина в поле `freezeSource`.
   *
   * Из паузы матча перемотка не начинается, и отказ здесь явный (NTR-20): «мир
   * заморожен паузой матча» — не то состояние, из которого машина перемотки
   * умеет продолжить, а запрос перемотки в заморозке не рождается вовсе (REW-12:
   * его порождает живой тик, которых тут нет).
   */
  pause(): void {
    if (this.freezeSource === 'match-pause') {
      throw new Error(
        'MatchServer.pause: мир заморожен паузой матча (NTR-20) — перемотка из неё не начинается',
      );
    }
    this.requireRewind().pause();
    this.freezeSource = 'rewind';
  }

  /**
   * `Paused → Rewinding` (WSM-2). Прямого входа из `Running` нет ни у политики,
   * ни у сетевого слоя — единственный флоу `Running → Paused → Rewinding →
   * Paused → Running` (NET-11).
   *
   * Отказ на паузе матча стоит ЗДЕСЬ, а не только в `pause()`, потому что
   * требование говорит про перемотку, а не про вход в неё: «перемотка из паузы
   * матча не начинается» (NTR-20). Ядру этот вход законен — `beginRewind`
   * спрашивает у мира только `Paused`, а пауза матча ровно его и оставляет, —
   * поэтому единственное место, где заморозки различаются, это хост (D1).
   * Без гарда обвязка получила бы `Rewinding` с причиной заморозки
   * `match-pause`, а возобновление паузы упало бы позже и в чужом месте.
   */
  beginRewind(): void {
    if (this.freezeSource === 'match-pause') {
      throw new Error(
        'MatchServer.beginRewind: мир заморожен паузой матча (NTR-20) — перемотка из неё не начинается',
      );
    }
    this.requireRewind().beginRewind();
  }

  /**
   * `Paused → Running` — продолжить с текущего, в том числе перемотанного, тика.
   *
   * Накопленный неприменённый ввод гасится и здесь, а не только на смене эпохи:
   * ввод в замороженный мир не принимается вовсе (`ingest`), но перемотка на
   * тот же тик эпохи не двигает (NTR-16), и кадр, доехавший до `pause()`, ждал
   * бы в `pending` возобновления. Залпа на возобновлении быть не должно
   * (NET-11, REW-5), а лишний `clear` на переходе стоит ровно ничего.
   */
  resume(): void {
    if (this.freezeSource === 'match-pause') {
      throw new Error(
        'MatchServer.resume: паузу матча снимает `resumeMatch`/`PauseRequest` (NTR-20), а не выход из перемотки',
      );
    }
    this.requireRewind().resume();
    this.freezeSource = 'none';
    for (const pending of this.pending) pending.clear();
  }

  /**
   * Восстановление целевого тика (REW-2) с рассылкой по факту, мимо расписания
   * `snapshotRate` (NTR-16, NET-11): живых тиков во время `Rewinding` не
   * исполняется, и расписанию не на чем срабатывать. Реплеевые тики внутри
   * `seekTo` собственных рассылок не порождают — наблюдаемым результатом
   * является одно восстановленное состояние, а не поток промежуточных.
   *
   * Потока событий эта рассылка не несёт (см. `broadcastSnapshots`): её тик
   * исполнен в прежней эпохе и свои факты в ней уже отдал, а живых тиков новой
   * эпохи ещё нет.
   */
  seekTo(tick: number): void {
    const controller = this.requireRewind();
    // Точка остановки лежит в уже исполненном прошлом живой ветви (REW-7). Без
    // этой проверки `seekTo` на неисполненный тик доиграл бы мир вперёд
    // реплеевыми тиками по ПУСТОМУ логу вводов — тики, которых в каноническом
    // логе нет и не будет (NTR-16), то есть тихо невоспроизводимая запись.
    // Ошибкой, как у соседей: перемотка вперёд — дефект вызывающей политики, а
    // не штатный случай.
    //
    // Граница — `liveFrontier`, а не текущий тик: скраб вперёд внутри одной
    // перемотки законен (NTR-16, «Инициатор ведёт точку остановки») и идёт по
    // тем же каноническим вводам, что уже исполнены.
    if (tick > this.liveFrontier) {
      throw new Error(
        `MatchServer.seekTo: точка остановки ${tick} впереди исполненного тика ${this.liveFrontier} (REW-7)`,
      );
    }
    // Реплей внутри `seekTo` переисполняет уже отчитанные тики (REW-4, WSM-6),
    // и его записи идут по тем же номерам, что записи живой ветви. Отметки
    // вокруг него ставит сервер, потому что границы вызова видны только ему:
    // запускалка не заглядывает внутрь `advance()`, и отметка после него
    // относила бы к ветви уже вытекшие строки (DIAG-9).
    //
    // Эпоха здесь — ещё ПРЕЖНЯЯ: переисполняются тики той ветви, которая
    // сейчас идёт; новую заведёт рассылка восстановленного состояния ниже.
    this.config.trace?.mark({ mark: 'replayBegin', epoch: this.currentEpoch, tick });
    controller.seekTo(tick);
    this.config.trace?.mark({ mark: 'replayEnd', epoch: this.currentEpoch, tick });
    // Ветвь, которую перемотка стёрла, уходит из истории здесь же: живые тики
    // новой эпохи пойдут по тем же номерам, и без обрезки в буфере оказались бы
    // два снапшота одного тика — см. `BranchHistory`.
    this.history?.dropAfter(this.state.tick);
    this.adoptFramesOf(this.state.tick);
    this.broadcastSnapshots();
  }

  /**
   * Повторяемым «последним кадром» слота становится кадр, применённый на тике
   * восстановления (NTR-7): мир вернулся в это состояние целиком, и повтор
   * кадра из стёртого будущего означал бы ввод, которого в этой ветви истории
   * не было. До первого кадра повторять снова нечего — нулевой ввод.
   */
  private adoptFramesOf(tick: number): void {
    const restored = this.inputLog?.at(tick) ?? EMPTY_FRAMES;
    for (let slot = 0; slot < this.config.players.length; slot++) {
      const playerId = this.config.players[slot]!;
      this.lastFrame[slot] = restored.find((frame) => frame.playerId === playerId);
    }
  }

  /**
   * Хвост потока перед `End` (NTR-15, «Завершение матча»): накопленное с
   * последней рассылки уходит ДО закрытия соединения. Матч кончается событием —
   * последним убийством, истёкшим таймером, — и потерять именно его значит
   * потерять то единственное, ради чего поток заведён.
   *
   * Сообщение — максимально избыточное, а не минимальное: оно собирается как на
   * рассылке (кольцо повторов плюс открытое окно), потому что у него нет
   * СЛЕДУЮЩЕГО. «Каждое сообщение SHALL повторять события нескольких предыдущих
   * рассылок» (NTR-15, «Избыточность») держится тем, что пачка едет
   * `eventRepeat + 1` раз; окно, закрытое последней рассылкой по расписанию,
   * уехало бы ровно один раз, и его потеря была бы невосполнима — при том что
   * сам хвост доехал. Лишние байты последнего сообщения матча стоят дешевле
   * потерянного последнего убийства.
   *
   * Отсюда же второй случай: слить нечего, но кольцо не пусто — сообщение всё
   * равно уходит. Последнее сообщение матча обязано быть самым избыточным, а не
   * самым скупым. Молчание остаётся ровно на «нечего слить вовсе»: ни хвоста, ни
   * кольца — объявлять нечего.
   *
   * Кольцо при этом не трогается: матч кончился, повторять больше нечем и некуда.
   */
  private flushEvents(viewpoint: number, epoch: number): EventsMessage | undefined {
    const stream = this.eventStreams.get(viewpoint);
    if (stream === undefined) return undefined;
    const last = stream.repeats[stream.repeats.length - 1];
    if (stream.from < 0 && last === undefined) return undefined;

    const batches: EventBatch[] = [];
    for (const window of stream.repeats) batches.push(...window.batches);
    batches.push(...stream.batches);
    const message: EventsMessage = {
      type: 'Events',
      epoch,
      from: stream.repeats[0]?.from ?? stream.from,
      // Хвоста может не быть вовсе: тогда объявляется ровно то, что уже
      // объявлялось последней рассылкой, — повтор, который получатель отбросит
      // по курсору, если предыдущее сообщение доехало.
      to: stream.from < 0 ? last!.to : stream.to,
      batches,
    };
    stream.from = -1;
    stream.to = -1;
    stream.batches = [];
    return message;
  }

  private end(reason: EndReason): void {
    if (this.matchPhase === 'ended') return;
    this.matchPhase = 'ended';
    const epoch = this.currentEpoch;
    const tails = new Map<number, EventsMessage | undefined>();
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      const viewpoint = this.viewpointOf(connection);
      // Хвост считается один раз на `viewpoint` — как и всякая пачка потока, —
      // а уезжает каждому соединению этого `viewpoint`.
      if (!tails.has(viewpoint)) tails.set(viewpoint, this.flushEvents(viewpoint, epoch));
      const tail = tails.get(viewpoint);
      // Порядок в одном `drain()` значим ровно здесь: `Events` раньше `End`,
      // соединение закрывается после — исходящее с `closeAfter` последнее.
      if (tail !== undefined) {
        const personal = this.eventsFor(connection, tail);
        if (personal !== undefined) this.send(connection.id, personal);
      }
      this.send(connection.id, { type: 'End', reason, tick: this.state.tick }, true);
    }
  }

  /** Внешняя остановка — драйвером, а не по внутреннему условию. */
  stop(): void {
    this.end('server-stopped');
  }

  // -------------------------------------------------------------- исходящие

  private send(to: ConnectionId, message: ServerMessage, closeAfter = false): void {
    this.outbox.push({ to, message, closeAfter });
  }

  private reject(to: ConnectionId, reason: RejectReason, detail: string): void {
    this.send(to, { type: 'Reject', reason, detail }, true);
    const connection = this.connections.get(to);
    this.connections.delete(to);
    // Отказ бывает и УЖЕ СЕВШЕМУ соединению: испорченный кадр, сообщение не для
    // своего состояния, повторный `Hello` — всё это разрыв с названным исходом
    // (NTR-4), и аренда слота кончается вместе с соединением так же, как при
    // закрытом канале. Иначе слот навсегда числился бы занятым мертвецом.
    if (connection !== undefined) this.releaseSlot(connection);
  }

  /** Забрать накопленные исходящие. Отправляет их транспортный слой (NTR-3). */
  drain(): Outgoing[] {
    if (this.outbox.length === 0) return [];
    return this.outbox.splice(0, this.outbox.length);
  }

  /**
   * Матч как сценарий прогона (NTR-8): та же тройка, что принимает
   * `runScenario` ядра. Прогон обязан дать побитово то же состояние — это и
   * есть доказательство, что сетевой слой не сломал детерминизм.
   *
   * Форма документа плоская, и определена она ровно для матча без перемотки —
   * одного сегмента (NTR-16). Матч с перемоткой отдаётся `canonicalSegments`:
   * раскладка сегментов по документу сценария принадлежит `cli-testing` CLI-2,
   * и до неё записать такой матч сценарием нечем. Отказ здесь явный, потому
   * что плоский список с ключом-тиком у такого матча означал бы два разных
   * кадра под одним номером — то есть тихо невоспроизводимую запись.
   */
  toScenario(): ScenarioDef {
    if (this.segments.length > 1) {
      throw new Error(
        `MatchServer.toScenario: матч из ${this.segments.length} сегментов (NTR-16) — ` +
          'плоская форма документа сценария определена только для матча без перемотки (CLI-2)',
      );
    }
    return {
      name: this.config.name ?? 'match',
      seed: this.config.seed,
      ticks: this.state.tick,
      scene: this.config.scene,
      initial: this.config.initial ?? [],
      inputs: this.canonicalInputs,
      players: this.config.players,
      ...(this.config.physics !== undefined ? { physics: this.config.physics } : {}),
      ...(this.config.locomotion !== undefined ? { locomotion: this.config.locomotion } : {}),
      ...(this.config.visibility !== undefined ? { visibility: this.config.visibility } : {}),
    };
  }
}
