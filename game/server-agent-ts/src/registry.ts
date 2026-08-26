/**
 * Реестр серверов агента (SRV-1): что поднято, в каком состоянии, по какому
 * адресу и с какой фазой матча.
 *
 * Состояние ПРОЦЕССА и фаза МАТЧА — разные поля, а не одно перечисление, и это
 * прямое требование: «Реестр SHALL сообщать … состояние процесса … и — отдельным
 * полем, а не вперемешку, — фазу текущего матча». Причина в том, что вопросы
 * разные: «жив ли процесс» решает агент, «идёт ли бой» — сервер матча внутри
 * него, и слепив их, реестр не ответил бы ни на один.
 *
 * Предметной логики матча здесь нет и быть не может (SRV-1): реестр знает, чем
 * запускать, как наблюдать и как останавливать. Всё, что он показывает про
 * матч, приезжает ОТЧЁТОМ процесса (решение D2), а не вычисляется здесь заново.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  AdminOp,
  ServerEntry,
  ServerMetricsView,
  SlotStatus,
  SlotView,
  StartParams,
} from './protocol/messages.js';
import { RefusalError } from './refusal.js';
import type { AgentPaths } from './state/paths.js';
import {
  processStartTicks,
  stopProcessByPid,
  type BookEntry,
  type ProcessBook,
} from './state/book.js';
import { portBusy, startStandProcess, type StandProcess } from './stand/process.js';
import type { StandReportLine, StandSlotReport } from './stand/lines.js';

/** Порт «авто» (SRV-2, риск занятости): агент выбирает свободный сам. */
const AUTO_PORT = 0;

/**
 * Абсолютный путь внутри дерева контента либо `undefined` — выход за корень.
 * Тот же предикат, что у раздачи (`httpServer.insideOf`): параметр запуска —
 * документ из дерева, а не произвольный путь файловой системы.
 */
function insideContentRoot(contentRoot: string, value: string): string | undefined {
  if (value === '') return undefined;
  const base = resolve(contentRoot);
  const full = resolve(base, value);
  if (full !== base && !full.startsWith(base + sep)) return undefined;
  return full;
}

export interface RegistryOptions {
  readonly paths: AgentPaths;
  readonly book: ProcessBook;
  /** Чем запускать стенд: тот же исполняемый файл, которым запущен агент. */
  readonly runtime: string;
  /** Скрипт запускалки стенда (решение D1) — путь дистрибутива, не команда клиента. */
  readonly standScript: string;
  /** Корень дерева контента: перечень документов матча и их пути (D11). */
  readonly contentRoot: string;
  /**
   * Публичный хост игрового эндпоинта (SRV-1, SRV-8): им называется
   * `ServerEntry.address`, чтобы адрес, отданный тестеру, вёл на ХОСТ, а не на
   * машину тестера. По умолчанию loopback — для локального прогона и тестов.
   */
  readonly advertiseHost?: string;
  /** Ссылка входа игрока по адресу сервера (SRV-8); пустая — раздачи нет. */
  readonly joinUrl: (address: string) => string;
  /** Свободный порт для запуска «порт: авто». */
  readonly freePort: () => Promise<number>;
  /** Реестр изменился: событие уезжает подписчикам (SRV-2), а не добывается опросом. */
  readonly onChanged: (id: string) => void;
  readonly onRemoved: (id: string) => void;
  readonly now?: () => number;
}

/** Живая запись реестра: процесс плюс всё, что агент о нём знает. */
interface LiveServer {
  readonly id: string;
  readonly params: StartParams;
  readonly port: number;
  /**
   * Процесс под наблюдением; `undefined` — сервер ПЕРЕЖИЛ прежнего агента
   * (решение D5) и найден по книге. Его stdio ушло вместе с тем агентом, поэтому
   * ни отчёта, ни команд у такого сервера нет: остаётся адрес, состояние и
   * остановка — по идентификатору процесса.
   */
  process: StandProcess | undefined;
  /** Идентификатор процесса ОС: им останавливается сервер, переживший агента. */
  pid: number;
  /** Момент старта процесса: отличает наш процесс от занявшего его PID (D5). */
  startProc: number;
  /**
   * Начинал ли сервер слушать хоть раз. Процесс, умерший ДО этого, — не крах
   * идущего матча (SRV-6), а несостоявшийся запуск (MGR-2): постмортема он не
   * оставляет и запись его отзывается целиком.
   */
  startedListening: boolean;
  /**
   * Последний ВАЛИДНЫЙ отчёт стенда: отчёт со статусом вне набора (SRV-4) не
   * заменяет его, а называется в логе — молча приведённый к легальному статусу
   * дрейф стенда врал бы админу. `undefined` — валидного отчёта ещё не было.
   */
  lastReport: StandReportLine | undefined;
  /** Уже названные в логе незнакомые статусы: чтобы не заливать канал одним и тем же. */
  readonly namedUnknownStatuses: Set<string>;
  state: ServerEntry['state'];
  exitCode: number | null;
  restarts: number;
  postmortem: string | null;
  postmortemFailure: string | null;
  /** Строки лога, ещё не уехавшие подписчику деталей. */
  pendingLog: string[];
  /** Каталог артефактов прогона: туда стенд кладёт запись и трейс, если пишет их. */
  readonly runDir: string;
}

/** Статус слота из отчёта стенда: перечень закрыт (SRV-4), незнакомое не проходит. */
const STATUSES: readonly SlotStatus[] = [
  'connecting',
  'active',
  'disconnected',
  'removed',
  'left',
  'rejected',
];

/**
 * Слот в проекцию реестра. Статус НЕ приводится к легальному молча: сюда
 * доезжают только отчёты, прошедшие проверку набора в `onReport` (иначе дрейф
 * стенда показал бы админу «подключается» вместо того, чтобы быть названным).
 * Поэтому `as SlotStatus` здесь безопасен — набор проверен выше по потоку.
 */
function slotView(slot: StandSlotReport): SlotView {
  const kind = slot.rtt.kind === 'measured' || slot.rtt.kind === 'pending' ? slot.rtt.kind : 'unsupported';
  return {
    slot: slot.slot,
    playerId: slot.playerId,
    status: slot.status as SlotStatus,
    role: slot.role,
    rtt: kind === 'measured' && slot.rtt.ms !== undefined ? { kind, ms: slot.rtt.ms } : { kind },
    serverResponseMs: slot.serverResponseMs,
    applied: slot.applied,
    predicted: slot.predicted,
    late: slot.late,
    snapshotBytes: slot.snapshotBytes,
  };
}

/** Слоты до первого отчёта: ростер известен из линии `ready`, статусов ещё нет. */
function pendingSlots(players: readonly string[]): readonly SlotView[] {
  return players.map((playerId, slot) => ({
    slot,
    playerId,
    status: 'connecting' as const,
    role: null,
    rtt: { kind: 'unsupported' as const },
    serverResponseMs: null,
    applied: 0,
    predicted: 0,
    late: 0,
    snapshotBytes: 0,
  }));
}

export interface ServerRegistry {
  list(): readonly ServerEntry[];
  /**
   * Взять под управление сервер, переживший прежнего агента (решение D5):
   * запись книги превращается в запись реестра. Управление таким сервером
   * ограничено — см. `LiveServer.process`.
   */
  adopt(entry: BookEntry): ServerEntry;
  entry(id: string): ServerEntry | undefined;
  metrics(id: string): ServerMetricsView | null;
  start(params: StartParams): Promise<ServerEntry>;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  admin(id: string, op: AdminOp, slot: number): Promise<void>;
  log(id: string): readonly string[];
  /** Строки лога, накопившиеся с прошлого запроса: подписчику уезжает хвост. */
  takeLog(id: string): readonly string[];
  /** Перечень документов матча дистрибутива (SRV-2, решение D11). */
  matches(): readonly string[];
  /** Подписан ли кто-нибудь на детали сервера: без подписки метрики не собираются (D9). */
  setSubscribed(id: string, on: boolean): Promise<void>;
}

/** Номер в имени записи (`srv-3`): счётчик имён не должен столкнуться с усыновлённым. */
function numberOf(id: string): number {
  const parsed = Number(id.replace(/^srv-/, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

export function createRegistry(options: RegistryOptions): ServerRegistry {
  const now = options.now ?? Date.now;
  const advertiseHost = options.advertiseHost ?? '127.0.0.1';
  const servers = new Map<string, LiveServer>();
  let counter = 0;

  const entryOf = (live: LiveServer): ServerEntry => {
    // ПОСЛЕДНИЙ ВАЛИДНЫЙ отчёт, а не сырой `process.report`: отчёт с незнакомым
    // статусом (SRV-4) не двигает видимую запись — он назван в логе, а не показан.
    const report: StandReportLine | undefined = live.lastReport;
    const ready = live.process?.ready;
    // Адрес игрового эндпоинта называет ПУБЛИЧНЫЙ хост, а не loopback: стенд
    // слушает на всех интерфейсах, и клиент с другой машины входит по этому же
    // адресу (SRV-1, SRV-8). Порт — реальный порт этого сервера.
    const address = `ws://${advertiseHost}:${String(live.port)}`;
    return {
      id: live.id,
      state: live.state,
      address,
      port: live.port,
      match: live.params.match,
      // Фаза матча — ОТДЕЛЬНОЕ поле (SRV-1). `null` до первого отчёта: процесс
      // ещё ничего не сообщил, и выдумывать за него «lobby» значило бы показать
      // админу фазу, которой никто не наблюдал.
      phase: report?.phase ?? null,
      pause: report?.pause ?? null,
      // Счётчик рестартов (SRV-1) — круги матча внутри одного процесса: стенд
      // поднимает следующий матч тем же конфигом, и номер круга он сообщает сам.
      restarts: report === undefined ? live.restarts : Math.max(0, report.round - 1),
      exitCode: live.exitCode,
      postmortem: live.postmortem,
      postmortemFailure: live.postmortemFailure,
      joinUrl: options.joinUrl(address),
      slots: report === undefined ? pendingSlots(ready?.players ?? []) : report.slots.map(slotView),
    };
  };

  const require = (id: string): LiveServer => {
    const live = servers.get(id);
    if (live === undefined) throw new RefusalError('unknown-server', `сервера "${id}" в реестре нет`);
    return live;
  };

  const running = (id: string): StandProcess => {
    const live = require(id);
    const process = live.process;
    if (live.state === 'crashed' || live.state === 'stopped') {
      throw new RefusalError('not-running', `сервер "${id}" не работает`);
    }
    if (process === undefined) {
      // Сервер пережил прежнего агента: его stdio ушло вместе с тем процессом,
      // и админ-операции до него не доходят. Названо это прямо — молчаливый
      // «успех» здесь означал бы операцию, которой не было (SRV-2).
      throw new RefusalError(
        'not-running',
        `сервер "${id}" пережил прежнего агента: доступны только реестр и остановка`,
      );
    }
    return process;
  };

  /**
   * Материалы разбора краша (SRV-6): код выхода, хвост лога и артефакты матча,
   * если прогон их писал. Сорвавшееся сохранение НАЗЫВАЕТСЯ там же, где
   * состояние `crashed`, а не теряется молча.
   */
  const postmortem = (live: LiveServer, code: number | null, signal: string | null): void => {
    const dir = join(options.paths.crashDir, `${live.id}-${String(now())}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'exit.json'),
        `${JSON.stringify({ server: live.id, exitCode: code, signal, port: live.port, match: live.params.match, at: now() }, null, 2)}\n`,
      );
      writeFileSync(join(dir, 'log.txt'), `${live.process?.log().join('\n') ?? ''}\n`);
      // Артефакты прогона — только если прогон их писал: каталог заводится
      // стендом, а не агентом (`--out-dir`), и пустого здесь не бывает.
      if (existsSync(live.runDir)) cpSync(live.runDir, join(dir, 'run'), { recursive: true });
      live.postmortem = dir;
      live.postmortemFailure = null;
    } catch (error) {
      live.postmortem = null;
      live.postmortemFailure = error instanceof Error ? error.message : String(error);
    }
  };

  /** Аргументы запускалки стенда из параметров запуска (SRV-2). */
  const argsOf = (params: StartParams, port: number, runDir: string): string[] => {
    const args = [
      '--control-adapter',
      '--port',
      String(port),
      '--match',
      join(options.contentRoot, params.match),
      '--out-dir',
      runDir,
    ];
    if (params.bot !== '') args.push('--bot', join(options.contentRoot, params.bot));
    if (params.botFillMs !== null) args.push('--bot-fill-ms', String(params.botFillMs));
    if (params.onDisconnect !== '') args.push('--on-disconnect', params.onDisconnect);
    // Авто-рестарт — умолчание стенда; выключается он флагом `--once`.
    if (!params.autoRestart) args.push('--once');
    return args;
  };

  /**
   * `startedAt` приходит СНАРУЖИ, а не читается здесь вторым `now()`: тем же
   * числом назван каталог прогона (`runs/<id>-<startedAt>`), и `adopt` собирает
   * его имя обратно из книги. Разойдись два чтения часов хоть на миллисекунду —
   * после рестарта агента постмортем (SRV-6) искал бы артефакты по имени,
   * которого на диске нет, и молча не находил бы ничего.
   */
  const startProcess = async (live: LiveServer, startedAt: number): Promise<void> => {
    const process = startStandProcess({
      runtime: options.runtime,
      script: options.standScript,
      args: argsOf(live.params, live.port, live.runDir),
      port: live.port,
      onReport: (report) => {
        // Статус вне закрытого набора (SRV-4) — дрейф стенда и агента: НЕ
        // приводим его молча к легальному, а называем в хвосте лога и
        // отбрасываем отчёт. Видимая запись остаётся на последнем валидном.
        const unknown = report.slots.map((s) => s.status).filter((s) => !STATUSES.includes(s as SlotStatus));
        for (const status of unknown) {
          if (live.namedUnknownStatuses.has(status)) continue;
          live.namedUnknownStatuses.add(status);
          live.pendingLog.push(`агент: незнакомый статус слота "${status}" — отчёт стенда отброшен (SRV-4)`);
          if (live.pendingLog.length > 200) live.pendingLog.shift();
        }
        if (unknown.length === 0) live.lastReport = report;
        options.onChanged(live.id);
      },
      onReady: () => { options.onChanged(live.id); },
      onLog: (line) => {
        live.pendingLog.push(line);
        if (live.pendingLog.length > 200) live.pendingLog.shift();
      },
      onExit: (code, signal, state) => {
        live.exitCode = code;
        // Вердикт даёт ПРОЦЕСС: он один знает, просили ли мы этот выход. Считать
        // здесь по коду значило бы объявлять крахом — и писать постмортем
        // (SRV-6) — всякую штатную остановку стенда, который уходит от SIGTERM.
        live.state = state;
        // Процесс, не начавший слушать, — несостоявшийся запуск, а не крах
        // идущего сервера: постмортема он не оставляет и событий не шлёт. Всю
        // его запись отзовёт путь отказа запуска ниже; попытайся onExit сохранить
        // постмортем здесь — он остался бы сиротой (никто не назовёт каталог).
        if (!live.startedListening) return;
        if (live.state === 'crashed') postmortem(live, code, signal);
        options.book.remove(live.id);
        options.onChanged(live.id);
      },
    });
    live.process = process;
    live.pid = process.pid;
    // Момент старта читается сразу за спавном: по нему следующий агент отличит
    // этот процесс от занявшего его PID после перезагрузки (D5).
    live.startProc = processStartTicks(process.pid);
    live.state = 'starting';
    options.book.add({
      id: live.id,
      pid: process.pid,
      port: live.port,
      match: live.params.match,
      startedAt,
      startProc: live.startProc,
    });
    try {
      await process.untilListening();
    } catch (error) {
      // Несостоявшийся запуск — НАЗВАННЫЙ отказ (MGR-2), и запись отзывается
      // ЦЕЛИКОМ: удаляется из реестра и книги И снимается у подписчиков.
      // Призрачная строка, которую нечем убрать (`stop`/`select` ответят
      // `unknown-server`), хуже отсутствия сервера. Удаление — ДО `stop()`,
      // чтобы `onRemoved` увидел уже пустой реестр, а `onExit` от остановки
      // ничего не публиковал (сервер так и не начал слушать).
      servers.delete(live.id);
      options.book.remove(live.id);
      options.onRemoved(live.id);
      await process.stop();
      throw new RefusalError('spawn-failed', error instanceof Error ? error.message : String(error));
    }
    live.startedListening = true;
    live.state = 'listening';
    options.onChanged(live.id);
  };

  return {
    list() {
      return [...servers.values()].map(entryOf);
    },
    entry(id) {
      const live = servers.get(id);
      return live === undefined ? undefined : entryOf(live);
    },
    metrics(id) {
      // Из ВАЛИДНОГО отчёта: метрики отброшенного (незнакомый статус) не
      // показываем — как и его слоты. Метрик нет, пока никто не подписан
      // (решение D9): отчёт их не собирал, и нули вместо них были бы ответом о
      // том, чего не мерили.
      return servers.get(id)?.lastReport?.metrics ?? null;
    },
    adopt(entry) {
      const live: LiveServer = {
        id: entry.id,
        params: {
          match: entry.match,
          port: entry.port,
          bot: '',
          botFillMs: null,
          onDisconnect: '',
          autoRestart: false,
        },
        port: entry.port,
        process: undefined,
        pid: entry.pid,
        startProc: entry.startProc,
        // Пережил прежнего агента и держит порт: он уже слушает.
        startedListening: true,
        // Отчёт от пережившего сервера больше не приходит: последнего валидного
        // нет, а слоты берутся из линии `ready`.
        lastReport: undefined,
        namedUnknownStatuses: new Set(),
        // Процесс жив (книга сверена на старте, D5), и порт он держит: состояние
        // называется `listening`, а фаза матча остаётся неизвестной — отчёт от
        // него больше не приходит.
        state: 'listening',
        exitCode: null,
        restarts: 0,
        postmortem: null,
        postmortemFailure: null,
        pendingLog: [],
        runDir: join(options.paths.root, 'runs', `${entry.id}-${String(entry.startedAt)}`),
      };
      servers.set(entry.id, live);
      if (counter < numberOf(entry.id)) counter = numberOf(entry.id);
      options.onChanged(entry.id);
      return entryOf(live);
    },
    async start(params) {
      // Документ матча и профиль бота — ПУТИ ВНУТРИ дерева контента (SRV-2,
      // D11: параметр есть документ из перечня `matches()` агента). `join`
      // разрешает `..`, поэтому `match: '../../../etc/hosts'` увёл бы `spawn` за
      // корень — не инъекция команды (шелла нет) и требует токена, но выход за
      // объявленную границу. Отвергаем его ДО существования файла, тем же
      // предикатом, что и раздача (`httpServer.insideOf`).
      const document = insideContentRoot(options.contentRoot, params.match);
      if (document === undefined) {
        throw new RefusalError('unknown-match', `документ матча "${params.match}" вне дерева контента`);
      }
      if (params.bot !== '' && insideContentRoot(options.contentRoot, params.bot) === undefined) {
        throw new RefusalError('unknown-match', `профиль бота "${params.bot}" вне дерева контента`);
      }
      if (!existsSync(document)) {
        throw new RefusalError('unknown-match', `документа матча "${params.match}" в дистрибутиве нет`);
      }
      // Порт «авто» выбирает агент; ЯВНО заданный занятый порт — названный
      // отказ, а не молчаливое переназначение (риск дизайна): админ увидел бы
      // сервер не там, где просил.
      const port = params.port === AUTO_PORT ? await options.freePort() : params.port;
      if (await portBusy(port)) {
        throw new RefusalError('port-busy', `порт ${String(port)} занят`);
      }
      counter += 1;
      const id = `srv-${String(counter)}`;
      const startedAt = now();
      const live: LiveServer = {
        id,
        params,
        port,
        process: undefined,
        pid: -1,
        startProc: 0,
        startedListening: false,
        lastReport: undefined,
        namedUnknownStatuses: new Set(),
        state: 'starting',
        exitCode: null,
        restarts: 0,
        postmortem: null,
        postmortemFailure: null,
        pendingLog: [],
        // Имя РАЗОВОЕ: счётчик имён начинается заново с каждым запуском агента, и
        // `runs/srv-1` без метки времени переиспользовался бы чужим прогоном —
        // а из него собираются материалы разбора краша (SRV-6). Момент один и
        // тот же и здесь, и в книге — см. `startProcess`.
        runDir: join(options.paths.root, 'runs', `${id}-${String(startedAt)}`),
      };
      servers.set(id, live);
      options.onChanged(id);
      await startProcess(live, startedAt);
      return entryOf(live);
    },
    async stop(id) {
      const live = require(id);
      if (live.process === undefined) {
        await stopProcessByPid(live.pid, live.startProc, (detail) => new RefusalError('internal', detail));
      }
      else await live.process.stop();
      live.state = 'stopped';
      options.book.remove(id);
      options.onChanged(id);
      servers.delete(id);
      options.onRemoved(id);
    },
    async stopAll() {
      // Останов ВСЕХ — политика менеджера (MGR-4), исполняемая агентом одной
      // операцией: закрывающемуся менеджеру нечем ждать N ответов.
      await Promise.all([...servers.keys()].map(async (id) => {
        try {
          await this.stop(id);
        } catch {
          // Уже ушедший сервер — не отказ операции «остановить все».
        }
      }));
    },
    async admin(id, op, slot) {
      const process = running(id);
      const live = require(id);
      const roster = live.lastReport?.slots.length ?? live.process?.ready?.players.length ?? 0;
      if (op !== 'pause' && op !== 'resume' && (slot < 0 || slot >= roster)) {
        throw new RefusalError('unknown-slot', `слота ${String(slot)} у сервера "${id}" нет`);
      }
      const reason = await process.command(op, slot);
      // Отказ сервера матча передаётся НАЗВАННЫМ (SRV-5): «нельзя сейчас» — это
      // ответ, а не молчание.
      if (reason !== '') throw new RefusalError('refused-by-server', reason);
      options.onChanged(id);
    },
    log(id) {
      return require(id).process?.log() ?? [];
    },
    takeLog(id) {
      const live = servers.get(id);
      if (live === undefined) return [];
      return live.pendingLog.splice(0, live.pendingLog.length);
    },
    matches() {
      const dir = join(options.contentRoot, 'matches');
      if (!existsSync(dir)) return [];
      // Перечень документов матча даёт АГЕНТ (решение D11): у профиля менеджера
      // дерева контента нет вовсе (DSK-5), и спрашивать он вправе только здесь.
      return readdirSync(dir)
        .filter((name) => name.endsWith('.match.json'))
        .sort()
        .map((name) => `matches/${name}`);
    },
    async setSubscribed(id, on) {
      const process = running(id);
      // Исход команды НАЗЫВАЕТСЯ (SRV-2). Выброшенный, он превращал молчащий
      // стенд в «подписка удалась»: метрики так и остаются пустыми, и человеку
      // ни разу не сказали, почему.
      const reason = await process.command(on ? 'subscribe' : 'unsubscribe');
      if (reason !== '') throw new RefusalError('refused-by-server', reason);
    },
  };
}
