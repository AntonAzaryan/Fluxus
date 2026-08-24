/**
 * Слушающая сторона стенда демо-арены (`bin/demo-serve.mjs`) между матчами
 * (design D2, D3): порт открывается один раз, очередному матчу отдаётся
 * «сессионный вид» слушающей стороны, а подключившиеся в окно рестарта ждут
 * следующего матча — вместе со всем, что успели сказать.
 *
 * Вынесено из стенда отдельным модулем ради проверяемости окна рестарта тестом
 * (`test/standSession.test.ts`) без настоящего сокета: дефект этого окна —
 * потерянный `Hello` — снаружи неотличим от сети («сервер не ответил» после
 * тайм-аута входа), и ручным прогоном его не поймать.
 */
import type { Transport, TransportServer } from '@game-mvp/net';

/** Слушающая сторона стенда: очередь окна рестарта, претенденты и вид для матча. */
export interface StandSession {
  /**
   * Претенденты на слоты: соединения, которые уже ЗАГОВОРИЛИ и не закрыты.
   *
   * Отсчёт до заморозки ростера идёт от них, а не от факта соединения (D2).
   * Разница не косметическая: открытый сокет, не сказавший ни слова, — это
   * сканер порта, недогрузившаяся вкладка или прокси, и заводить по нему матч
   * нельзя. Дедлайн, взведённый молчащим сокетом, сажает ботов в ОБА слота,
   * матч стартует бот против бота и занимает стенд, а пришедший следом человек
   * получает «матч занят» — стенд, выведенный из строя чужим подключением.
   *
   * Претендент опознаётся первым сообщением, а не разбором `Hello`: первое,
   * что шлёт участник, и есть предъявление версии (NTR-5), и второй разбор
   * протокола рядом с сервером обвязке не нужен — ей нужен факт «кто-то пришёл
   * играть». Отвергнутый (чужая версия, занятый слот) закрывается сервером и
   * из множества уходит сам.
   */
  readonly claimants: ReadonlySet<Transport>;
  /** Принять сырое соединение слушающего сокета. */
  accept(raw: Transport): void;
  /** Появился первый претендент этого матча — взвести дедлайн (D2). Переназначается каждым матчем. */
  onClaimant(handler: () => void): void;
  /** Претендентов не осталось — отсчёт начинать не с кого. Переназначается каждым матчем. */
  onClaimantsGone(handler: () => void): void;
  /** Вид слушающей стороны для ОДНОГО матча: его `close()` порт не отпускает. */
  readonly sessionServer: TransportServer;
}

export function standSession(): StandSession {
  /** Соединения текущего матча: закрываются на рестарте, порт остаётся. */
  const live = new Set<Transport>();
  const claimants = new Set<Transport>();
  /** Обработчик соединений текущего матча; между матчами — `undefined`. */
  let session: ((transport: Transport) => void) | undefined;
  /** Пришедшие, пока матч не поднят: подключившийся раньше не теряется. */
  const waiting: Transport[] = [];
  let claimantHandler = (): void => {};
  let claimantsGoneHandler = (): void => {};

  /**
   * Наблюдающая обёртка над соединением: считает, заговорил ли участник, и
   * убирает его при закрытии. Обёртка, а не подписка рядом, потому что и
   * `onMessage`, и `onClose` держат ровно по одному обработчику
   * (`BaseTransport`), и принадлежат они `MatchHost` — вклиниться можно только
   * между ним и настоящим транспортом. Байты обёртка не разбирает и не трогает.
   *
   * На настоящий транспорт обёртка подписывается СРАЗУ, в момент принятия
   * соединения, а не тогда, когда подпишется матч: `BaseTransport` без
   * обработчика молча роняет входящие байты, а `Hello` клиент шлёт ровно один
   * раз и не повторяет (`MatchClient.start`). Клиент, попавший в окно
   * рестарта, иначе терял бы его безвозвратно — сообщение приходило бы раньше,
   * чем конструктор следующего `MatchHost` разберёт очередь ждущих: клиент
   * висел бы до тайм-аута входа, а стенд, так и не увидев претендента, не
   * взвёл бы дедлайн бот-заполнителя (BOT-7). Байты, пришедшие до подписки
   * матча, копятся здесь и отдаются его обработчику в порядке прихода.
   */
  function observed(inner: Transport): Transport {
    let spoke = false;
    /** Пришедшее до подписки матча — окно рестарта. */
    const pending: Uint8Array[] = [];
    let messageHandler: ((bytes: Uint8Array) => void) | undefined;
    let closeHandler: ((reason?: string) => void) | undefined;
    let closed = false;
    let closedReason: string | undefined;
    const wrapper: Transport = {
      get isClosed() {
        return inner.isClosed;
      },
      send: (bytes) => {
        inner.send(bytes);
      },
      close: (reason) => {
        inner.close(reason);
      },
      onMessage(handler) {
        // Тот же контракт, что у `BaseTransport`: обработчик один.
        if (messageHandler !== undefined) {
          throw new Error('Transport: обработчик сообщений уже назначен');
        }
        messageHandler = handler;
        while (pending.length > 0) handler(pending.shift()!);
      },
      onClose(handler) {
        if (closeHandler !== undefined) {
          throw new Error('Transport: обработчик закрытия уже назначен');
        }
        closeHandler = handler;
        // Поздний подписчик уже закрытого соединения узнаёт о закрытии
        // немедленно (контракт `BaseTransport.onClose`): закрыться оно могло в
        // окне рестарта, до подписки матча.
        if (closed) handler(closedReason);
      },
    };
    inner.onMessage((bytes) => {
      if (!spoke) {
        spoke = true;
        claimants.add(wrapper);
        claimantHandler();
      }
      if (messageHandler === undefined) pending.push(bytes);
      else messageHandler(bytes);
    });
    inner.onClose((reason) => {
      live.delete(wrapper);
      if (claimants.delete(wrapper) && claimants.size === 0) claimantsGoneHandler();
      closed = true;
      closedReason = reason;
      closeHandler?.(reason);
    });
    return wrapper;
  }

  return {
    claimants,
    accept(raw) {
      const transport = observed(raw);
      live.add(transport);
      if (session === undefined) waiting.push(transport);
      else session(transport);
    },
    onClaimant(handler) {
      claimantHandler = handler;
    },
    onClaimantsGone(handler) {
      claimantsGoneHandler = handler;
    },
    sessionServer: {
      onConnection(next) {
        session = next;
        while (waiting.length > 0) next(waiting.shift()!);
      },
      close() {
        session = undefined;
        for (const transport of live) transport.close('match-restarted');
        live.clear();
        claimants.clear();
        return Promise.resolve();
      },
    },
  };
}
