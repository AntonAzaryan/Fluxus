/**
 * Управляющий эндпоинт агента (SRV-2, SRV-3; решения D3, D4): wss плюс закрытый
 * набор JSON-сообщений.
 *
 * Только шифрованный канал: незашифрованного варианта нет ни в какой
 * конфигурации — сервер поднимается на `https.createServer` с сертификатом
 * агента, и второго слушателя рядом не существует.
 *
 * Рукопожатие предъявляет ВЕРСИЮ, и несовпадение — названный отказ с версиями
 * обеих сторон, а не молчание. Дальше действует токен: операция без
 * действительного токена — отказ, а отзыв токена рвёт и живые подключения.
 *
 * Изменения состояния уезжают СОБЫТИЯМИ (SRV-2): опрос реестра клиенту не нужен
 * — и это не удобство, а требование, потому что опросом статус игрока пришлось
 * бы догонять частотой, которой в админ-канале не бывает.
 */
import { createServer, type Server } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CONTROL_PROTOCOL_VERSION,
  type AgentVersions,
  type ControlRequest,
  type ControlResponse,
  type RefusalReason,
  type ResultResponse,
  type ServerEntry,
} from './protocol/messages.js';
import { ControlProtocolError, parseControlRequest } from './protocol/parse.js';
import { RefusalError, refusalOf } from './refusal.js';
import type { ServerRegistry } from './registry.js';
import type { AgentCertificate } from './state/certificate.js';
import type { TokenStore } from './state/tokens.js';

/**
 * Потолок управляющего кадра. Самое большое сообщение набора — перечень
 * серверов со слотами и хвостом лога; мегабайта хватает с запасом, а всё, что
 * больше, — не операция протокола.
 */
const MAX_FRAME_BYTES = 1 << 20;

/**
 * Сколько соединение вправе молчать до рукопожатия. Открытый и не назвавшийся
 * сокет держит сессию и память бесплатно и без токена — дедлайн делает эту
 * плату конечной. Значение с большим запасом к клиентскому (`controlClient`).
 */
const GREETING_DEADLINE_MS = 15_000;

/** Период проверки живости соединений: пропущенный ответ — мёртвый канал. */
const HEARTBEAT_MS = 30_000;

/** Пустой исход: поля ответа перечислены всегда, чтобы разбор был один на все. */
const EMPTY_RESULT: Omit<ResultResponse, 't' | 'id'> = {
  servers: [],
  matches: [],
  log: [],
  tokens: [],
  server: '',
};

export interface ControlServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly cert: AgentCertificate;
  readonly tokens: TokenStore;
  readonly registry: ServerRegistry;
  readonly versions: AgentVersions;
  readonly now?: () => number;
}

export interface ControlServer {
  /** Порт, на котором эндпоинт поднялся: `0` в запросе означает «любой свободный». */
  readonly port: number;
  /** Событие реестра подписчикам (SRV-2). */
  publish(id: string, kind: 'changed' | 'removed'): void;
  close(): Promise<void>;
}

/** Операция набора: всё, кроме рукопожатия, — у неё есть номер (SRV-2). */
type NumberedRequest = Exclude<ControlRequest, { t: 'hello' }>;

/**
 * Номер запроса из СЫРОГО тела — до разбора. Ответ на операцию клиент ждёт по
 * номеру; отказ, потерявший номер, для него неотличим от молчания.
 */
function requestIdOf(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  const id: unknown = (raw as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : 0;
}

/** Одно подключение управляющего канала. */
interface Session {
  readonly socket: WebSocket;
  /** Секрет предъявленного токена; пустая строка — рукопожатие не пройдено. */
  token: string;
  /** Серверы, на детали которых подписано ЭТО подключение (SRV-2). */
  readonly details: Set<string>;
  /**
   * Ответило ли соединение на последний пинг. Живость проверяется ниже: `ws`
   * сам не пингует, а TCP молчит про пропавшую машину часами.
   *
   * Полем СЕССИИ, а не отдельным множеством сокетов рядом: у второго множества
   * своё время жизни, и снимать соединение пришлось бы из ДВУХ мест — `forget`
   * убирает сессию, а сокет остался бы в нём навсегда. Агент живёт долго
   * (`desktop-shell` DSK-7), менеджер переподключается на каждый запуск, и такая
   * утечка росла бы без предела. Здесь снимать нечего: сессию удалили — записи
   * о живости не стало.
   */
  alive: boolean;
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const now = options.now ?? Date.now;
  const https: Server = createServer({ key: options.cert.key, cert: options.cert.cert });
  // Потолок кадра. Умолчание `ws` — 100 МиБ, и это память, которую ЛЮБОЙ сосед
  // по сети занимает ДО всякой проверки токена: кадр буферизуется целиком,
  // прежде чем его увидит разбор. Сообщения набора (SRV-2) мерятся килобайтами.
  const wss = new WebSocketServer({ server: https, maxPayload: MAX_FRAME_BYTES });
  // `ws` пере-излучает ошибку HTTP-сервера на себе, и делает это РАНЬШЕ, чем
  // `once('error', reject)` ниже: без слушателя занятый порт становится не
  // названным отказом, а необработанным событием, роняющим агента вместе со
  // всеми его серверами (SRV-1). Отказ называется промисом listen'а.
  wss.on('error', () => undefined);
  const sessions = new Set<Session>();

  await new Promise<void>((resolve, reject) => {
    https.once('error', reject);
    https.listen(options.port, options.host ?? '0.0.0.0', () => {
      https.removeListener('error', reject);
      resolve();
    });
  });
  const address = https.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  const send = (session: Session, message: ControlResponse): void => {
    if (session.socket.readyState !== session.socket.OPEN) return;
    session.socket.send(JSON.stringify(message));
  };

  const refuse = (session: Session, id: number, reason: RefusalReason, detail: string, close = false): void => {
    // Причина — из ЗАКРЫТОГО набора (SRV-2), а не приведённая к `never`: тип
    // держит словарь закрытым на границе, где сообщение уходит, — иначе будущий
    // вызов отправил бы причину, которую разбор клиента отвергнет как `malformed`.
    send(session, { t: 'refused', id, reason, detail });
    if (close) session.socket.close();
  };

  const result = (session: Session, id: number, body: Partial<Omit<ResultResponse, 't' | 'id'>>): void => {
    send(session, { t: 'result', id, ...EMPTY_RESULT, ...body });
  };

  /**
   * Рукопожатие (SRV-2, SRV-3). Порядок проверок — версия, затем допуск: клиент
   * чужой версии не обязан понимать даже отказ в допуске, а версии в отказе
   * названы обе, чтобы человеку было что обновлять.
   */
  const greet = (session: Session, request: Extract<ControlRequest, { t: 'hello' }>): void => {
    if (request.protocol !== CONTROL_PROTOCOL_VERSION) {
      refuse(
        session,
        0,
        'protocol-version',
        `версия протокола агента ${String(CONTROL_PROTOCOL_VERSION)}, клиента ${String(request.protocol)}`,
        true,
      );
      return;
    }
    let issued = '';
    if (request.pairingCode !== '') {
      // Перебор кода заперт (SRV-3): отказ называет причину, а не сливается с
      // «код неверен» — человек за пультом обязан отличить «ошибся» от «канал
      // молотят», и второе означает подождать окончания окна.
      if (options.tokens.pairingLocked(now())) {
        refuse(session, 0, 'pairing-failed', 'пейринг временно заперт: слишком много неверных попыток', true);
        return;
      }
      const token = options.tokens.redeem(request.pairingCode, request.label, now());
      if (token === undefined) {
        // Три случая одним отказом, и все три названы: набор причин закрыт
        // (SRV-2), а различать их В ОТКАЗЕ означало бы отвечать перебирающему,
        // насколько он близок. Человеку с кодом на руках хватает перечисления —
        // «уже обменян» среди них самый частый (второй запуск менеджера в одном
        // окне ротации), и молчать о нём значило бы посылать его искать опечатку.
        refuse(session, 0, 'pairing-failed', 'код пейринга неверен, уже обменян или просрочен', true);
        return;
      }
      issued = token.secret;
    }
    const presented = issued === '' ? request.token : issued;
    if (!options.tokens.valid(presented)) {
      refuse(session, 0, 'unauthorized', 'нужен действительный токен либо код пейринга', true);
      return;
    }
    session.token = presented;
    send(session, {
      t: 'welcome',
      protocol: CONTROL_PROTOCOL_VERSION,
      agent: options.versions,
      fingerprint: options.cert.fingerprint,
      // Секрет уезжает РОВНО ОДИН раз — в ответ на пейринг; дальше клиент
      // предъявляет его сам, и переспросить его негде.
      token: issued,
    });
  };

  /**
   * Событие подписчику: запись реестра плюс детали, если он на них подписан.
   *
   * Хвост лога приходит УЖЕ СЛИТЫМ (`tail`), а не забирается здесь: `takeLog`
   * разрушающий, и вызов его на каждого подписчика отдал бы строки лога только
   * первому, а второму (SRV-2 допускает второй клиент на один сервер) — пустоту.
   * Слить его один раз на рассылку и раздать всем — забота `publish`.
   */
  const eventOf = (
    session: Session,
    entry: ServerEntry,
    kind: 'changed' | 'removed',
    tail: readonly string[],
  ): void => {
    const detailed = session.details.has(entry.id);
    send(session, {
      t: 'event',
      event: kind,
      server: entry,
      // Метрики — только подписчику деталей (решение D9): без подписки отчёт их
      // не собирал, и слать нечего.
      metrics: detailed ? options.registry.metrics(entry.id) : null,
      log: detailed ? tail : [],
    });
  };

  const dispatch = async (session: Session, request: NumberedRequest): Promise<void> => {
    if (session.token === '' || !options.tokens.valid(session.token)) {
      // Токен могли отозвать МЕЖДУ операциями: отозванный перестаёт действовать
      // и для существующих подключений (SRV-3).
      throw new RefusalError('unauthorized', 'токен недействителен');
    }
    switch (request.t) {
      case 'list':
        result(session, request.id, { servers: options.registry.list() });
        return;
      case 'matches':
        result(session, request.id, { matches: options.registry.matches() });
        return;
      case 'start': {
        const entry = await options.registry.start(request.params);
        result(session, request.id, { servers: [entry], server: entry.id });
        return;
      }
      case 'stop':
        await options.registry.stop(request.server);
        result(session, request.id, { server: request.server });
        return;
      case 'stop-all':
        await options.registry.stopAll();
        result(session, request.id, {});
        return;
      case 'subscribe': {
        const entry = options.registry.entry(request.server);
        if (entry === undefined) throw new RefusalError('unknown-server', `сервера "${request.server}" нет`);
        // Подписка записывается ПОСЛЕ успеха включения сбора: отказ (сервер
        // упал, стенд не ответил) иначе оставлял бы соединение подписчиком
        // операции, которой человеку назвали отказ, — и хвост лога разрушающим
        // `takeLog` уходил бы читателю, которого нет.
        await options.registry.setSubscribed(request.server, true);
        session.details.add(request.server);
        result(session, request.id, { servers: [entry], server: request.server });
        return;
      }
      case 'unsubscribe':
        session.details.delete(request.server);
        // Последний отписавшийся гасит сбор метрик в процессе сервера (D9).
        if (![...sessions].some((other) => other.details.has(request.server))) {
          await options.registry.setSubscribed(request.server, false);
        }
        result(session, request.id, { server: request.server });
        return;
      case 'admin':
        await options.registry.admin(request.server, request.op, request.slot);
        result(session, request.id, { server: request.server });
        return;
      case 'log':
        result(session, request.id, { log: options.registry.log(request.server), server: request.server });
        return;
      case 'tokens':
        result(session, request.id, { tokens: options.tokens.list() });
        return;
      case 'revoke': {
        // Секрет читается ДО отзыва: им же закрываются живые подключения.
        const secret = options.tokens.secretOf(request.token);
        if (!options.tokens.revoke(request.token)) {
          throw new RefusalError('unknown-token', `токена "${request.token}" нет`);
        }
        result(session, request.id, { tokens: options.tokens.list() });
        for (const other of sessions) {
          if (secret !== undefined && other.token === secret) other.socket.close();
        }
        return;
      }
    }
  };

  wss.on('connection', (socket: WebSocket) => {
    const session: Session = { socket, token: '', details: new Set(), alive: true };
    sessions.add(session);
    // Не назвавшееся соединение закрывается по дедлайну: см. `GREETING_DEADLINE_MS`.
    const greetingDeadline = setTimeout(() => {
      if (session.token === '') socket.terminate();
    }, GREETING_DEADLINE_MS);
    greetingDeadline.unref();
    socket.on('message', (data: Buffer) => {
      let raw: unknown;
      let request: ControlRequest;
      try {
        raw = JSON.parse(data.toString('utf8'));
        request = parseControlRequest(raw);
      } catch (error) {
        const reason = error instanceof ControlProtocolError ? error.reason : 'malformed';
        // Отказ РАЗБОРА возвращается тем же номером, что и всякий другой: он
        // вычитывается из сырого тела ещё до разбора. С номером рукопожатия
        // (`0`) клиент не связал бы его ни с чем, и операция — скажем, `start`
        // с портом вне диапазона — висела бы вечно вместо названного отказа
        // (SRV-2).
        refuse(session, requestIdOf(raw), reason, error instanceof Error ? error.message : String(error));
        return;
      }
      if (request.t === 'hello') {
        // Рукопожатие бывает ОДНО. Второй `hello` в установленном соединении —
        // не операция набора: приняв его, агент позволил бы подменить личность
        // живой сессии и заново разменивать пейринг-коды по уже открытому каналу.
        if (session.token === '') greet(session, request);
        else refuse(session, 0, 'unknown-message', 'повторное рукопожатие в установленном соединении');
        return;
      }
      void dispatch(session, request).catch((error: unknown) => {
        const named = refusalOf(error);
        refuse(session, request.id, named.reason, named.detail);
      });
    });
    socket.on('pong', () => { session.alive = true; });
    socket.on('close', () => { clearTimeout(greetingDeadline); forget(session); });
    socket.on('error', () => { clearTimeout(greetingDeadline); forget(session); });
  });

  /**
   * Не ответившее на пинг соединение считается мёртвым и рвётся. Без этого
   * менеджер, у которого выдернули сеть, оставался бы в `sessions` подписчиком —
   * и каждый подписанный стенд считал бы перцентили и `perf_hooks` в горячем
   * цикле без единого читателя (решение D9).
   */
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /**
   * Соединение ушло: снять его подписки и, если на сервер больше никто не
   * подписан, погасить сбор метрик в его процессе (решение D9).
   *
   * Без этого закрытый или упавший менеджер оставлял бы КАЖДЫЙ стенд подписанным
   * навсегда — то есть считающим перцентили и `perf_hooks` в горячем цикле без
   * единого читателя. Ветвь `unsubscribe` в `dispatch` делает ровно это для
   * живого клиента; здесь тот же учёт для клиента, спросить которого уже нельзя.
   */
  const forget = (session: Session): void => {
    const watched = [...session.details];
    // Соединение снимается ПЕРВЫМ: «остался ли подписчик» считается уже без него.
    sessions.delete(session);
    for (const server of watched) {
      if (![...sessions].some((other) => other.details.has(server))) {
        // Сервер мог уйти вместе с менеджером: гасить сбор уже не на чем, и
        // отказ «сервера нет» здесь не ошибка, а обычный конец эпизода.
        void options.registry.setSubscribed(server, false).catch(() => undefined);
      }
    }
  };

  return {
    port,
    publish(id, kind) {
      const entry = options.registry.entry(id);
      // Хвост лога слит ОДИН раз на рассылку (`takeLog` разрушающий) и роздан
      // всем подписчикам деталей — иначе второй из них получил бы пустоту.
      const detailedListeners = [...sessions].some(
        (session) => session.token !== '' && session.details.has(id),
      );
      const tail = detailedListeners ? options.registry.takeLog(id) : [];
      for (const session of sessions) {
        if (session.token === '') continue;
        // Запись ушедшего сервера реестр уже не отдаёт: событию `removed`
        // достаточно его имени, и остальные поля называются пустыми.
        eventOf(session, entry ?? removedEntry(id), kind, tail);
      }
    },
    close() {
      clearInterval(heartbeat);
      return new Promise<void>((resolve) => {
        for (const session of sessions) session.socket.close();
        wss.close();
        https.close(() => { resolve(); });
        https.closeAllConnections();
      });
    },
  };
}

/** Запись ушедшего сервера: имя есть, остального уже нет — и это сказано явно. */
function removedEntry(id: string): ServerEntry {
  return {
    id,
    state: 'stopped',
    address: '',
    port: 0,
    match: '',
    phase: null,
    pause: null,
    restarts: 0,
    exitCode: null,
    postmortem: null,
    postmortemFailure: null,
    joinUrl: '',
    slots: [],
  };
}
