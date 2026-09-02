/**
 * Управляющий протокол агента (`server-control` SRV-2, решение D3): ЗАКРЫТЫЙ
 * набор сообщений с версией в рукопожатии.
 *
 * Один словарь на всех: его говорит агент, его говорит клиентская библиотека
 * менеджера, по нему написаны тесты. Второй разбор рядом и есть тот способ, каким
 * стороны расходятся: половина сообщений начинает значить у клиента одно, у
 * агента другое, и обнаруживается это отказом в работе, а не отказом разбора.
 *
 * Дисциплина набора — та же, что у игрового протокола (NTR-4, NTR-5), но словарь
 * ОТДЕЛЬНЫЙ: у него другой контрагент (админ и будущий матчмейкер, а не игрок),
 * другой ритм (единицы сообщений в секунду против рассылки на каждом тике) и
 * другое время жизни. JSON, а не msgpack: объёмы админ-канала ничтожны, а
 * читаемость в отладке дороже (D3).
 *
 * Чего здесь нет намеренно: свободных полей «на будущее» и необязательных
 * расширений, согласуемых в рантайме. Версия предъявляется в рукопожатии, и
 * несовпадение — НАЗВАННЫЙ отказ (SRV-2), а не молчаливая деградация.
 *
 * Модуль не импортирует ничего: он читается и в процессе агента (Node), и в
 * странице менеджера (браузер), и в тестах. Появившийся здесь `node:*` сделал бы
 * словарь непереносимым ровно в тот момент, когда им пользуются обе стороны.
 */

/**
 * Версия управляющего протокола. Растёт при любом изменении набора сообщений:
 * несовпадение версий — названный отказ рукопожатия, поэтому «добавили поле, все
 * старые клиенты продолжают работать» здесь не бывает по построению.
 */
export const CONTROL_PROTOCOL_VERSION = 1;

/**
 * Состояние паузы матча (`netcode-transport` NTR-20) глазами админ-канала.
 *
 * Набор НАЗВАН константой, как соседние `SERVER_STATES` и `MATCH_PHASES`, а не
 * переписан литералом в разборе: там он был бы вторым местом, где закрытый набор
 * может разойтись сам с собой. Импортировать его из `@fluxus/net` нельзя —
 * словарь читается и страницей менеджера, а корень `@fluxus/net` тянет за собой
 * `ws` и `node:*`; связь наборов держит тест соответствия, а не сборка.
 */
export const PAUSE_STATES = ['running', 'frozen', 'resuming'] as const;

export type PauseStateView = (typeof PAUSE_STATES)[number];

// ------------------------------------------------------------------ реестр

/** Состояние ПРОЦЕССА сервера (SRV-1) — не путать с фазой матча в нём. */
export const SERVER_STATES = ['starting', 'listening', 'crashed', 'stopped'] as const;

export type ServerState = (typeof SERVER_STATES)[number];

/** Фаза матча (`netcode-transport`, `MatchPhase`) — ОТДЕЛЬНЫМ полем, а не вперемешку с состоянием процесса (SRV-1). */
export const MATCH_PHASES = ['lobby', 'running', 'ended'] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

/**
 * Статус игрока в слоте (SRV-4) — производная состояний аренды слота
 * (`netcode-transport` NTR-17, NTR-18, NTR-19), а не отдельная бухгалтерия:
 *
 * - `connecting` — слот ещё не ведёт живой арендатор, а матч не начался: ждём
 *   входа либо идёт хендшейк;
 * - `active` — слот ведёт живое соединение в идущем матче;
 * - `disconnected` — соединение оборвалось, слот остался за игроком (NTR-6) и
 *   идёт на predicted-кадрах (NTR-7);
 * - `removed` — слот заперт админ-операцией (NTR-19); из перечня он НЕ исчезает;
 * - `left` — участник ушёл сам (`Bye`), а не потерял связь;
 * - `rejected` — последний вход в этот слот получил названный отказ (NTR-5).
 */
export const SLOT_STATUSES = [
  'connecting',
  'active',
  'disconnected',
  'removed',
  'left',
  'rejected',
] as const;

export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** Круг несущего канала соединения либо названное его отсутствие (NTR-11). */
export interface SlotRtt {
  readonly kind: 'measured' | 'pending' | 'unsupported';
  /** Миллисекунды; присутствует только при `measured`. */
  readonly ms?: number;
}

/** Слот сервера глазами админа (SRV-4). */
export interface SlotView {
  readonly slot: number;
  readonly playerId: string;
  readonly status: SlotStatus;
  /** Роль живого арендатора (NTR-18); `null` — арендатора нет. */
  readonly role: 'owner' | 'substitute' | null;
  readonly rtt: SlotRtt;
  /**
   * СЕРВЕРНАЯ ПОЛОВИНА отклика в мс (NTR-11): от прихода кадра ввода до
   * ближайшего персонального снапшота. `null` — замера не было.
   *
   * Именно половина, а не полное «нажал → увидел»: та величина принадлежит
   * КЛИЕНТУ (в неё входят круг, буфер задержки ввода и темп рассылки), и уехать
   * в админ-канал не может — сообщения для неё в закрытом наборе нет (NTR-4). На
   * вопрос «дорога или сервер» админу отвечает пара «круг соединения + этот
   * замер», а не одна цифра (`server/host.ts` называет её так же).
   */
  readonly serverResponseMs: number | null;
  readonly applied: number;
  readonly predicted: number;
  readonly late: number;
  readonly snapshotBytes: number;
  /**
   * Снапшоты, НЕ отправленные слоту из-за очереди отправки его соединения
   * (NTR-22). Третий ответ на вопрос «дорога, сервер или канал» рядом с кругом и
   * длительностью тика (NTR-11): длинная дорога поднимает круг, занятый сервер —
   * длительность тика, узкий канал — этот счётчик при здоровых первых двух.
   */
  readonly snapshotsSkipped: number;
}

/** Счётчики матча и процесса сервера (SRV-4, NTR-11). */
export interface ServerMetricsView {
  readonly tickP99Ms: number;
  readonly tickMeanMs: number;
  readonly broadcastP99Ms: number;
  readonly snapshotsSent: number;
  readonly bytesSent: number;
  /** Задержка цикла событий процесса стенда, мс (`perf_hooks`, решение D9). */
  readonly eventLoopDelayMs: number;
  readonly rssBytes: number;
}

/** Запись реестра серверов (SRV-1). */
export interface ServerEntry {
  readonly id: string;
  readonly state: ServerState;
  /** Адрес игрового эндпоинта: `ws://host:port`. */
  readonly address: string;
  readonly port: number;
  /** Документ матча, которым сервер поднят. */
  readonly match: string;
  /** Фаза матча ОТДЕЛЬНЫМ полем (SRV-1); `null` — процесс ещё ничего не сообщил. */
  readonly phase: MatchPhase | null;
  /** Состояние паузы матча (NTR-20); `null` — процесс ещё ничего не сообщил. */
  readonly pause: PauseStateView | null;
  readonly restarts: number;
  /** Код выхода упавшего процесса; `null` — процесс не падал. */
  readonly exitCode: number | null;
  /** Каталог материалов краш-постмортема (SRV-6); `null` — материалов нет. */
  readonly postmortem: string | null;
  /** Сорвавшееся сохранение материалов названо здесь, а не потеряно молча (SRV-6). */
  readonly postmortemFailure: string | null;
  /** Ссылка входа игрока (SRV-8); пустая строка — раздачи у агента нет. */
  readonly joinUrl: string;
  readonly slots: readonly SlotView[];
}

/** Параметры запуска сервера (SRV-2). */
export interface StartParams {
  /** Документ матча из перечня агента (`matches`). */
  readonly match: string;
  /** Порт игрового эндпоинта; `0` — «порт: авто», агент выберет свободный. */
  readonly port: number;
  /** Профиль бота-заполнителя; пустая строка — умолчание стенда. */
  readonly bot: string;
  /** Дедлайн бот-заполнителя, мс; `null` — умолчание стенда (BOT-7). */
  readonly botFillMs: number | null;
  /** Политика разрыва стенда (BOT-14, NTR-20); пустая строка — умолчание. */
  readonly onDisconnect: string;
  /** Поднимать ли сервер заново после конца матча (авто-рестарт стенда). */
  readonly autoRestart: boolean;
}

/** Админ-операция над матчем и игроками (SRV-5). */
export const ADMIN_OPS = [
  'disconnect-player',
  'bar-slot',
  'unbar-slot',
  'pause',
  'resume',
] as const;

export type AdminOp = (typeof ADMIN_OPS)[number];

/**
 * Названные причины отказа (SRV-2: «Отказ любой операции SHALL быть наблюдаем
 * как отказ с названной причиной»). Перечень закрыт по тому же основанию, что и
 * набор сообщений: причина, приехавшая свободной строкой, читалась бы человеком,
 * а показывать её обязано приложение (MGR-2).
 */
export const REFUSAL_REASONS = [
  /** Версия протокола клиента не та (SRV-2). */
  'protocol-version',
  /** Нет действительного токена (SRV-3). */
  'unauthorized',
  /** Пейринг-код не предъявлен, просрочен или неверен (SRV-3). */
  'pairing-failed',
  'unknown-message',
  'malformed',
  'unknown-server',
  /** Порт занят — названная причина отказа запуска (MGR-2). */
  'port-busy',
  'spawn-failed',
  /** Операция требует живого процесса, а его нет. */
  'not-running',
  'unknown-match',
  'unknown-token',
  'unknown-slot',
  /** Сервер матча отказал в операции своим исходом (SRV-5). */
  'refused-by-server',
  'internal',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// -------------------------------------------------------- клиент → агент

interface HelloRequest {
  readonly t: 'hello';
  readonly protocol: number;
  /** Долгоживущий токен (SRV-3); пустая строка — токена нет. */
  readonly token: string;
  /** Пейринг-код, обмениваемый на токен (SRV-3); пустая строка — обмена нет. */
  readonly pairingCode: string;
  /** Имя клиента в перечне выданных токенов: человеку нужно знать, что он отзывает. */
  readonly label: string;
}

/** Операция с номером: исход возвращается тем же номером (SRV-2). */
interface Numbered {
  readonly id: number;
}

export interface ListRequest extends Numbered {
  readonly t: 'list';
}

export interface MatchesRequest extends Numbered {
  readonly t: 'matches';
}

export interface StartRequest extends Numbered {
  readonly t: 'start';
  readonly params: StartParams;
}

export interface StopRequest extends Numbered {
  readonly t: 'stop';
  readonly server: string;
}

export interface StopAllRequest extends Numbered {
  readonly t: 'stop-all';
}

export interface SubscribeRequest extends Numbered {
  readonly t: 'subscribe';
  readonly server: string;
}

export interface UnsubscribeRequest extends Numbered {
  readonly t: 'unsubscribe';
  readonly server: string;
}

export interface AdminRequest extends Numbered {
  readonly t: 'admin';
  readonly server: string;
  readonly op: AdminOp;
  /** Слот операции; `-1` — операция матча целиком (пауза, возобновление). */
  readonly slot: number;
}

export interface LogRequest extends Numbered {
  readonly t: 'log';
  readonly server: string;
}

export interface TokensRequest extends Numbered {
  readonly t: 'tokens';
}

export interface RevokeRequest extends Numbered {
  readonly t: 'revoke';
  readonly token: string;
}

export type ControlRequest =
  | HelloRequest
  | ListRequest
  | MatchesRequest
  | StartRequest
  | StopRequest
  | StopAllRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | AdminRequest
  | LogRequest
  | TokensRequest
  | RevokeRequest;

// -------------------------------------------------------- агент → клиент

/** Версии дистрибутива хоста (SRV-7): сходятся по построению при сборке. */
export interface AgentVersions {
  readonly buildId: string;
  readonly contentPackHash: string;
  /** Имя дистрибутива: репозиторий разработчика либо собранный host bundle. */
  readonly distribution: string;
}

export interface WelcomeResponse {
  readonly t: 'welcome';
  readonly protocol: number;
  readonly agent: AgentVersions;
  /** Отпечаток сертификата агента (SRV-3) — тот же, что закрепляет TOFU. */
  readonly fingerprint: string;
  /** Выданный пейрингом токен; пустая строка — обмена не было. */
  readonly token: string;
}

export interface RefusedResponse {
  readonly t: 'refused';
  /** Номер отказанной операции; `0` — отказ рукопожатия, номера у него нет. */
  readonly id: number;
  readonly reason: RefusalReason;
  readonly detail: string;
}

/** Выданный токен в перечне (SRV-3). Сам секрет наружу больше не уезжает. */
export interface TokenView {
  readonly id: string;
  readonly label: string;
  readonly issuedAt: number;
}

export interface ResultResponse {
  readonly t: 'result';
  readonly id: number;
  /** Реестр — ответ `list`; пустой массив у остальных операций. */
  readonly servers: readonly ServerEntry[];
  /** Перечень документов матча — ответ `matches` (D11). */
  readonly matches: readonly string[];
  /** Хвост лога процесса — ответ `log` (SRV-2). */
  readonly log: readonly string[];
  /** Выданные токены — ответ `tokens` (SRV-3). */
  readonly tokens: readonly TokenView[];
  /** Затронутый операцией сервер; пустая строка — операция не о сервере. */
  readonly server: string;
}

/**
 * Событие подписки (SRV-2): изменения доставляются подписчику, а не добываются
 * опросом. Одно тело на все события — запись реестра: «сменилась фаза»,
 * «сменился статус игрока» и «процесс вышел» суть одно и то же наблюдение за
 * записью, и три формы вместо одной заставили бы читателя склеивать их обратно.
 */
export interface ServerEvent {
  readonly t: 'event';
  readonly event: 'changed' | 'removed';
  readonly server: ServerEntry;
  /** Счётчики матча и процесса; `null` — подписки на детали нет (решение D9). */
  readonly metrics: ServerMetricsView | null;
  /** Хвост лога с прошлого события; пустой массив — новых строк не было. */
  readonly log: readonly string[];
}

export type ControlResponse = WelcomeResponse | RefusedResponse | ResultResponse | ServerEvent;
