/**
 * Агент хоста целиком (SRV-1..SRV-8): состояние, реестр, управляющий эндпоинт и
 * раздача клиента, собранные в один headless-процесс.
 *
 * Headless и одинаковый на машине разработчика и на VPS — это требование, а не
 * следствие: способ управления агентом ОДИН, и это управляющий протокол (SRV-1,
 * SRV-2). Ни консольного интерфейса, ни окна у него нет; локальная команда
 * существует ровно одна — предъявить код пейринга (SRV-3), и она не управляет
 * серверами, а выдаёт допуск.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { startControlServer, type ControlServer } from './controlServer.js';
import { advertiseOf, startHttpServe, type HttpServe } from './httpServer.js';
import { createRegistry, type ServerRegistry } from './registry.js';
import type { AgentVersions } from './protocol/messages.js';
import { ensureCertificate, type AgentCertificate } from './state/certificate.js';
import { agentPaths, defaultStateDir, type AgentPaths } from './state/paths.js';
import { processBook, type BookEntry } from './state/book.js';
import { tokenStore, type TokenStore } from './state/tokens.js';

export interface AgentOptions {
  /** Порт управляющего эндпоинта; `0` — любой свободный (нужно тестам). */
  readonly controlPort: number;
  /** Порт раздачи клиента (SRV-8); `0` — любой свободный, `-1` — не раздавать. */
  readonly httpPort: number;
  /** Интерфейс, на котором СЛУШАТЬ (управляющий канал и раздача); умолчание — все. */
  readonly host?: string;
  /**
   * Интерфейс УПРАВЛЯЮЩЕГО канала отдельно от раздачи (по умолчанию — `host`).
   *
   * Разделены потому, что у поднятого КОНТЕЙНЕРОМ агента (MGR-5) правильные
   * привязки разные: управляющий канал — только loopback (агент локальный,
   * пейринг идёт через объявленный сервис), а раздача обязана слушать наружу и
   * называть достижимый хост (SRV-8), иначе ссылка входа ведёт на машину
   * тестера. На один `host` их не свести, не пожертвовав одним из двух.
   */
  readonly controlHost?: string;
  /**
   * Публичный хост, которым агент НАЗЫВАЕТ игровой эндпоинт и ссылку входа
   * (SRV-1, SRV-8): тестеру на другой машине loopback-адрес указал бы на его же
   * машину. Пусто — выводится из хоста РАЗДАЧИ, а при «слушать на всех» — имя
   * хоста (`os.hostname()`).
   */
  readonly advertiseHost?: string;
  /** Каталог состояния (решение D5); по умолчанию — `~/.fluxus/server-agent`. */
  readonly stateDir?: string;
  /** Скрипт запускалки стенда (решение D1). */
  readonly standScript: string;
  /** Корень дерева контента дистрибутива. */
  readonly contentRoot: string;
  /** Каталог собранного клиентского бандла; пустая строка — бандла нет. */
  readonly bundleDir: string;
  /** Версии дистрибутива (SRV-7): сходятся по построению при сборке. */
  readonly versions: AgentVersions;
  /** Чем запускать стенд; по умолчанию — тот же исполняемый файл, что у агента. */
  readonly runtime?: string;
  readonly now?: () => number;
}

export interface Agent {
  readonly paths: AgentPaths;
  readonly certificate: AgentCertificate;
  readonly tokens: TokenStore;
  readonly registry: ServerRegistry;
  /** Адрес управляющего эндпоинта: `wss://host:port`. */
  readonly controlUrl: string;
  readonly controlPort: number;
  /** Адрес раздачи клиента; пустая строка — раздачи нет. */
  readonly httpUrl: string;
  /**
   * Записи книги процессов, пережившие прошлый запуск агента (решение D5).
   * Наблюдение для отчёта запускалки: сверка уже проведена на старте.
   */
  readonly survivors: readonly BookEntry[];
  close(): Promise<void>;
}

/** Свободный порт у системы: занимаем и сразу отпускаем. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

export async function startAgent(options: AgentOptions): Promise<Agent> {
  const paths = agentPaths(options.stateDir ?? defaultStateDir());
  const certificate = ensureCertificate(paths);
  const tokens = tokenStore(paths.tokensFile);
  const book = processBook(paths.bookFile);
  // Сверка книги на старте (D5): запись без живого процесса — либо с PID,
  // занятым чужим процессом после перезагрузки, — уходит из неё. Перезагрузка
  // хоста серверы не воскрешает и не должна.
  const survivors = book.reconcile();
  if (!existsSync(options.standScript)) {
    throw new Error(`запускалка стенда "${options.standScript}" не найдена: агенту нечего поднимать`);
  }

  // Управляющий канал и раздача слушают на РАЗНЫХ интерфейсах, если так задано
  // (решение MGR-5): у поднятого контейнером агента control — loopback, а
  // раздача — наружу. По умолчанию оба берут `host`.
  const controlHost = options.controlHost ?? options.host;
  const serveHost = options.host;

  // Публичный хост определяется ОДИН раз и раздаётся раздаче и реестру — иначе
  // они назвали бы себя по-разному: явный `advertiseHost`, иначе хост РАЗДАЧИ, а
  // при «слушать на всех» — имя машины, потому что loopback тестеру бесполезен.
  const advertiseHost = advertiseOf(
    options.advertiseHost,
    serveHost === undefined || serveHost === '0.0.0.0' ? hostname() : serveHost,
  );

  const http: HttpServe | undefined =
    options.httpPort < 0
      ? undefined
      : await startHttpServe({
          port: options.httpPort,
          ...(serveHost === undefined ? {} : { host: serveHost }),
          advertiseHost,
          bundleDir: options.bundleDir,
          contentRoot: options.contentRoot,
        });

  // Управляющий сервер и реестр знают друг о друге, но собираются по очереди:
  // реестр публикует события через позднюю привязку, потому что публиковать их
  // некуда, пока эндпоинт не поднялся. Держатель, а не переменная: события
  // читают его ПОСЛЕ сборки, и порядок инициализации не должен быть предметом
  // веры.
  const endpoint: { server: ControlServer | undefined } = { server: undefined };
  const registry = createRegistry({
    paths,
    book,
    runtime: options.runtime ?? process.execPath,
    standScript: options.standScript,
    contentRoot: options.contentRoot,
    advertiseHost,
    joinUrl: (address) => http?.joinUrl(address) ?? '',
    freePort,
    onChanged: (id) => { endpoint.server?.publish(id, 'changed'); },
    onRemoved: (id) => { endpoint.server?.publish(id, 'removed'); },
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // Пережившие прежнего агента серверы (решение D5) возвращаются в реестр: их
  // процессы живы, матчи в них идут, и потерять управление ими значило бы
  // оставить админа с чужими процессами на своей машине.
  for (const entry of survivors) registry.adopt(entry);

  const control = await startControlServer({
    port: options.controlPort,
    ...(controlHost === undefined ? {} : { host: controlHost }),
    cert: certificate,
    tokens,
    registry,
    versions: options.versions,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  endpoint.server = control;

  return {
    paths,
    certificate,
    tokens,
    registry,
    controlPort: control.port,
    // Управляющий URL остаётся loopback: он — самоссылка для тестов и для
    // адресного файла локального контейнера (MGR-5), где хост и есть эта машина.
    // Удалённый админ подключается по адресу, который ввёл сам, не по этому.
    controlUrl: `wss://127.0.0.1:${String(control.port)}`,
    // Раздача называет себя ПУБЛИЧНЫМ хостом (SRV-8): по этому URL тестер с
    // другой машины откроет страницу игрока.
    httpUrl: http === undefined ? '' : `http://${http.host}:${String(http.port)}`,
    survivors,
    async close() {
      // Порядок обратный запуску: сперва отпускаем клиентов, потом серверы.
      // Серверы агент при своём закрытии НЕ убивает по умолчанию — их судьба
      // это политика менеджера (MGR-4), и решает её `stop-all`, а не выход
      // агента.
      await control.close();
      await http?.close();
    },
  };
}
