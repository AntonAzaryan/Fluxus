/**
 * Сессия менеджера (`server-manager` MGR-1..MGR-4): хосты, агрегированный
 * список серверов, детали выбранного и админ-операции.
 *
 * Всё управление идёт ЧЕРЕЗ управляющий протокол агента (MGR-1): прямых путей к
 * процессам, файлам и портам серверов здесь нет — и не только «не используются»,
 * а физически отсутствуют, потому что единственная зависимость этого модуля —
 * клиентская библиотека протокола. Локальный и удалённый хост неразличимы по
 * построению: они отличаются лишь тем, откуда взялся адрес.
 *
 * Модуль headless: ни DOM, ни таймеров. Представление читает состояние и
 * подписывается на его смену — так же, как это устроено в редакторе, и по той
 * же причине: состояние проверяется тестом, а картинка глазами.
 */
import type {
  AdminOp,
  ServerEntry,
  ServerEvent,
  ServerMetricsView,
  StartParams,
} from '@fluxus/server-agent/protocol';
import {
  ControlClientError,
  createControlClient,
  type ControlClient,
  type ControlSocketFactory,
} from '@fluxus/server-agent/client';
import { hostBook, hostIdOf, type HostBook, type KnownHost, type PageStorage } from './hostBook.js';

/** Хост в списке менеджера. */
export interface HostView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** Локальный хост поднят объявленным сервисом контейнера (MGR-5). */
  readonly local: boolean;
  readonly connected: boolean;
  /**
   * Попытка подключения ИДЁТ: ни `connected`, ни `failure` пока ничего не
   * значат. Отдельное состояние, а не «ещё не подключён», потому что человеку
   * это разные вещи: попытка, которая длится, и попытка, которой не было.
   */
  readonly connecting: boolean;
  /** Версии дистрибутива хоста (SRV-7); пустые — рукопожатия ещё не было. */
  readonly buildId: string;
  readonly contentPackHash: string;
  /** Названная причина, по которой хост недоступен; пустая строка — доступен. */
  readonly failure: string;
}

/** Строка общего списка серверов (MGR-2): сервер вместе со своим хостом. */
export interface ServerRow {
  readonly host: string;
  readonly hostLabel: string;
  readonly entry: ServerEntry;
}

/** Детали выбранного сервера (MGR-3). */
export interface ServerDetails {
  readonly host: string;
  readonly entry: ServerEntry;
  /** Счётчики; `null` — подписка ещё не принесла отчёта (решение D9). */
  readonly metrics: ServerMetricsView | null;
  /** Хвост лога процесса. */
  readonly log: readonly string[];
}

export interface ManagerState {
  readonly hosts: readonly HostView[];
  readonly servers: readonly ServerRow[];
  readonly details: ServerDetails | undefined;
  /** Хост, на который нацелена форма запуска (MGR-2); пустая строка — цели нет. */
  readonly launchHost: string;
  /**
   * Документы матча ЦЕЛЕВОГО хоста (`launchHost`) — из перечня ЕГО агента
   * (решение D11). Перечень у каждого хоста свой: запускать документ, которого
   * на принимающем хосте нет, значило бы обещать отказ (MGR-2).
   */
  readonly matches: readonly string[];
  /** «Остановить серверы при выходе» (MGR-4). Умолчание — включён. */
  readonly killOnExit: boolean;
  /** Последняя названная причина отказа — то, что менеджер показывает человеку. */
  readonly notice: string;
}

/** Живой хост: клиент протокола плюс то, что он о хосте знает. */
interface LiveHost {
  view: HostView;
  client: ControlClient | undefined;
  servers: readonly ServerEntry[];
  /** Документы матча ЭТОГО хоста (решение D11): перечень у каждого свой. */
  matches: readonly string[];
}

export interface ManagerSessionOptions {
  /** Как открывать канал: в странице — `browserSocket`, в тестах — `nodeSocket`. */
  readonly connect: ControlSocketFactory;
  /** Хранилище страницы под книгу хостов (MGR-1, решение D11). */
  readonly storage: PageStorage;
  /** Имя этого менеджера в перечне выданных токенов агента. */
  readonly label?: string;
}

/** Сколько строк лога держать в деталях: хвост, а не весь лог процесса. */
const LOG_TAIL = 200;

export interface ManagerSession {
  readonly state: ManagerState;
  readonly book: HostBook;
  onChange(listener: () => void): () => void;
  /** Локальный хост (MGR-5): адрес и код приезжают от объявленного сервиса. */
  addLocal(url: string, pairingCode: string, fingerprint: string): Promise<void>;
  /** Удалённый хост: адрес плюс код пейринга (MGR-1, SRV-3). */
  addRemote(url: string, pairingCode: string, label: string): Promise<void>;
  /** Подключиться ко всем известным хостам книги. */
  restore(): Promise<void>;
  forget(hostId: string): Promise<void>;
  refresh(): Promise<void>;
  start(hostId: string, params: StartParams): Promise<void>;
  stop(hostId: string, serverId: string): Promise<void>;
  select(hostId: string, serverId: string): Promise<void>;
  admin(hostId: string, serverId: string, op: AdminOp, slot?: number): Promise<void>;
  /** Выбрать хост, на который нацелена форма запуска (MGR-2). */
  setLaunchHost(hostId: string): void;
  setKillOnExit(on: boolean): void;
  /** Закрытие менеджера (MGR-4): политика завершения исполняется здесь. */
  closing(): Promise<void>;
  close(): void;
}

export function createManagerSession(options: ManagerSessionOptions): ManagerSession {
  const book = hostBook(options.storage);
  const hosts = new Map<string, LiveHost>();
  const listeners = new Set<() => void>();
  let details: ServerDetails | undefined;
  /** Явно выбранная цель запуска; пустая строка — берётся первый подходящий. */
  let launchChoice = '';
  let killOnExit = true;
  let notice = '';

  /**
   * Целевой хост формы запуска: явно выбранный, если он ещё подключён; иначе
   * первый ЛОКАЛЬНЫЙ подключённый, иначе первый подключённый. Локальный по
   * умолчанию — обычный сценарий: свой агент под рукой (MGR-5).
   */
  const launchHostId = (): string => {
    const connected = [...hosts.values()].filter((host) => host.view.connected);
    const chosen = connected.find((host) => host.view.id === launchChoice);
    if (chosen !== undefined) return chosen.view.id;
    return (connected.find((host) => host.view.local) ?? connected[0])?.view.id ?? '';
  };

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const named = (error: unknown): string =>
    error instanceof ControlClientError ? `${error.reason}: ${error.message}` : String(error);

  const require = (hostId: string): LiveHost => {
    const host = hosts.get(hostId);
    if (host === undefined) throw new Error(`хоста "${hostId}" в списке нет`);
    return host;
  };

  const clientOf = (hostId: string): ControlClient => {
    const host = require(hostId);
    if (host.client?.connected !== true) {
      throw new Error(`хост "${host.view.label}" не подключён`);
    }
    return host.client;
  };

  /** Событие подписки (SRV-2): обновляет и список, и детали — без опроса. */
  const onEvent = (hostId: string, event: ServerEvent): void => {
    const host = hosts.get(hostId);
    if (host === undefined) return;
    const rest = host.servers.filter((entry) => entry.id !== event.server.id);
    host.servers = event.event === 'removed' ? rest : [...rest, event.server];
    if (details?.host === hostId && details.entry.id === event.server.id) {
      details =
        event.event === 'removed'
          ? undefined
          : {
              host: hostId,
              entry: event.server,
              metrics: event.metrics ?? details.metrics,
              log: [...details.log, ...event.log].slice(-LOG_TAIL),
            };
    }
    changed();
  };

  /**
   * Подключение к хосту. Один путь на локальный и удалённый (MGR-1): различаются
   * они только тем, откуда взялся адрес, — «после добавления локальный и
   * удалённый хосты SHALL быть неразличимы в работе с ними».
   */
  const attach = async (known: KnownHost, local: boolean, pairingCode: string): Promise<void> => {
    const existing = hosts.get(known.id);
    existing?.client?.close();
    const client = createControlClient(options.connect);
    const host: LiveHost = {
      client,
      servers: [],
      matches: [],
      view: {
        id: known.id,
        label: known.label,
        url: known.url,
        local,
        connected: false,
        connecting: true,
        buildId: '',
        contentPackHash: '',
        failure: '',
      },
    };
    hosts.set(known.id, host);
    // Хост показывается С НАЧАЛА попытки, а не по её исходу. Иначе всё время,
    // пока канал открывается — а он вправе открываться долго и вправе не
    // открыться никогда, — человек видит ровно то же, что до нажатия: пустое
    // место, хотя хост уже добавлен (MGR-1). А отказ, о котором нельзя сказать,
    // начался ли он вообще, не наблюдаем в смысле SRV-2.
    changed();
    client.onEvent((event) => { onEvent(known.id, event); });
    try {
      const welcome = await client.connect({
        url: known.url,
        token: known.token,
        pairingCode,
        pinned: known.fingerprint,
        label: options.label ?? 'Fluxus Server Manager',
      });
      host.view = {
        ...host.view,
        connected: true,
        connecting: false,
        buildId: welcome.versions.buildId,
        contentPackHash: welcome.versions.contentPackHash,
      };
      // Токен и отпечаток запоминаются ПОСЛЕ успеха: книга не должна помнить
      // того, чего не было. Локальный хост в книгу не попадает (MGR-5).
      if (!local) {
        book.remember({
          ...known,
          token: welcome.token === '' ? known.token : welcome.token,
          fingerprint: welcome.fingerprint,
        });
      }
      host.servers = (await client.list()).servers;
      // Перечень документов матча — у КАЖДОГО хоста свой (решение D11): один
      // общий список предлагал бы документы, которых на принимающем хосте нет.
      host.matches = (await client.matches()).matches;
    } catch (error) {
      host.client = undefined;
      // Причина НАЗЫВАЕТСЯ: добавление хоста — операция протокола (MGR-1), а
      // «Отказ любой операции SHALL быть наблюдаем как отказ с названной
      // причиной» (SRV-2). Смена отпечатка (SRV-3) обязана быть громкой тем же
      // порядком.
      host.view = { ...host.view, connected: false, connecting: false, failure: named(error) };
      notice = host.view.failure;
    }
    changed();
  };

  /** Операция с названным исходом: отказ агента доезжает до человека как есть. */
  const guarded = async (body: () => Promise<void>): Promise<void> => {
    try {
      await body();
      notice = '';
    } catch (error) {
      notice = named(error);
    }
    changed();
  };

  return {
    book,
    get state(): ManagerState {
      const rows: ServerRow[] = [];
      for (const host of hosts.values()) {
        for (const entry of host.servers) {
          rows.push({ host: host.view.id, hostLabel: host.view.label, entry });
        }
      }
      const launchHost = launchHostId();
      return {
        hosts: [...hosts.values()].map((host) => host.view),
        servers: rows,
        details,
        launchHost,
        // Документы ЦЕЛЕВОГО хоста, а не общий список: форма предлагает то, что
        // на нём и вправду есть (MGR-2, D11).
        matches: hosts.get(launchHost)?.matches ?? [],
        killOnExit,
        notice,
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addLocal(url, pairingCode, fingerprint) {
      return attach(
        { id: hostIdOf(url), label: 'этот компьютер', url, token: '', fingerprint },
        true,
        pairingCode,
      );
    },
    addRemote(url, pairingCode, label) {
      const id = hostIdOf(url);
      const known = book.get(id);
      return attach(
        { id, label: label === '' ? id : label, url: known?.url ?? url, token: known?.token ?? '', fingerprint: known?.fingerprint ?? '' },
        false,
        pairingCode,
      );
    },
    async restore() {
      for (const known of book.list()) await attach(known, false, '');
    },
    async forget(hostId) {
      hosts.get(hostId)?.client?.close();
      hosts.delete(hostId);
      book.forget(hostId);
      if (details?.host === hostId) details = undefined;
      changed();
      await Promise.resolve();
    },
    async refresh() {
      for (const host of hosts.values()) {
        if (host.client?.connected !== true) continue;
        host.servers = (await host.client.list()).servers;
      }
      changed();
    },
    start(hostId, params) {
      return guarded(async () => {
        const client = clientOf(hostId);
        await client.start(params);
        require(hostId).servers = (await client.list()).servers;
      });
    },
    stop(hostId, serverId) {
      return guarded(async () => {
        const client = clientOf(hostId);
        await client.stop(serverId);
        require(hostId).servers = (await client.list()).servers;
        if (details?.entry.id === serverId) details = undefined;
      });
    },
    select(hostId, serverId) {
      return guarded(async () => {
        const client = clientOf(hostId);
        // Отписка от прежнего: без читателя отчёт метрик не собирается (D9).
        if (details !== undefined && details.entry.id !== serverId) {
          try {
            await clientOf(details.host).unsubscribe(details.entry.id);
          } catch {
            // Хост мог уйти вместе с сервером: отписываться уже не от чего.
          }
        }
        const result = await client.subscribe(serverId);
        const entry = result.servers[0];
        if (entry === undefined) throw new Error(`сервера "${serverId}" у хоста больше нет`);
        const log = (await client.log(serverId)).log;
        details = { host: hostId, entry, metrics: null, log: [...log].slice(-LOG_TAIL) };
      });
    },
    admin(hostId, serverId, op, slot = -1) {
      // Админ-операции идут ТЕМ ЖЕ протоколом (MGR-3, SRV-5): «убрать» и
      // «вернуть» — это запирание слота и его снятие (NTR-19), а пауза —
      // серверное API паузы (NTR-20).
      return guarded(async () => {
        await clientOf(hostId).admin(serverId, op, slot);
      });
    },
    setLaunchHost(hostId) {
      launchChoice = hostId;
      changed();
    },
    setKillOnExit(on) {
      killOnExit = on;
      changed();
    },
    async closing() {
      // Политика завершения (MGR-4). На серверы УДАЛЁННЫХ хостов закрытие
      // локального менеджера не влияет ни при каком положении переключателя —
      // поэтому останов адресуется только локальному агенту.
      if (!killOnExit) return;
      for (const host of hosts.values()) {
        if (!host.view.local || host.client?.connected !== true) continue;
        try {
          await host.client.stopAll();
        } catch {
          // Агент мог уже уйти: закрытие менеджера не место для отказов.
        }
      }
    },
    close() {
      for (const host of hosts.values()) host.client?.close();
      hosts.clear();
      details = undefined;
      changed();
    },
  };
}
