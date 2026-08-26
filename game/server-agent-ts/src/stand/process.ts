/**
 * Один процесс сервера матча под наблюдением агента (SRV-1, SRV-6; решения D1,
 * D2).
 *
 * Агент СПАВНИТ существующую запускалку стенда и не содержит предметной логики
 * матча: правила матча живут в процессе сервера, агент запускает, наблюдает и
 * останавливает. Процесс-на-сервер — не оптимизация, а изоляция крашей: падение
 * одного не задевает ни соседей, ни агента (SRV-1).
 *
 * Наблюдение идёт по stdio JSON-линиями (решение D2): маркированные линии —
 * отчёт и исходы команд, остальные — лог, который копится кольцом фиксированного
 * размера. Кольцо здесь не украшение: поток лога способен залить канал, и это
 * названный риск дизайна.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  CONTROL_LINE_PREFIX,
  decodeStandLine,
  encodeStandCommand,
  type StandCommandKind,
  type StandReadyLine,
  type StandReportLine,
} from './lines.js';

/** Строк лога в кольце: хвост, которого хватает на разбор, и который не растёт. */
export const LOG_RING = 400;

/** Длиннее — режется с пометкой: строка на мегабайт не помогает разбору. */
export const LOG_LINE_LIMIT = 2000;

/** Сколько ждать ответной линии на команду, прежде чем назвать это отказом. */
const COMMAND_TIMEOUT_MS = 5000;

/** Шаг пробы порта, пока сервер поднимается. */
const PROBE_STEP_MS = 50;

/** Сколько ждать штатного выхода после SIGTERM, прежде чем убивать. */
const GRACE_MS = 3000;

export type StandProcessState = 'starting' | 'listening' | 'crashed' | 'stopped';

export interface StandProcessOptions {
  /** Чем запускать: тот же исполняемый файл, которым запущен агент. */
  readonly runtime: string;
  /** Скрипт запускалки стенда — путь, а не команда из страницы (та же дисциплина, что у DSK-7). */
  readonly script: string;
  readonly args: readonly string[];
  readonly port: number;
  readonly cwd?: string;
  /** Сколько ждать, пока порт начнёт отвечать, прежде чем назвать это отказом. */
  readonly readyTimeoutMs?: number;
  /** Отчёт стенда доехал: агент обновляет запись реестра и будит подписчиков. */
  readonly onReport?: (report: StandReportLine) => void;
  readonly onReady?: (ready: StandReadyLine) => void;
  /**
   * Процесс вышел: код и сигнал — материал постмортема (SRV-6), а `state` —
   * вердикт «краш или остановка». Вердикт даёт процесс, а не код выхода: смерть
   * от SIGTERM, которого попросили мы сами, кодом `0` не сопровождается.
   */
  readonly onExit?: (code: number | null, signal: string | null, state: StandProcessState) => void;
  /** Новая строка лога: подписчику деталей уезжает хвост (SRV-4). */
  readonly onLog?: (line: string) => void;
}

export interface StandProcess {
  readonly pid: number;
  readonly state: StandProcessState;
  readonly exitCode: number | null;
  /** Последний отчёт стенда; `undefined` — процесс ещё ничего не сообщил. */
  readonly report: StandReportLine | undefined;
  readonly ready: StandReadyLine | undefined;
  /** Хвост лога процесса: кольцо фиксированного размера. */
  log(): readonly string[];
  /** Дождаться, пока порт начнёт отвечать; отказ — названная причина. */
  untilListening(): Promise<void>;
  /** Команда стенду (SRV-5): исход возвращается ответной линией. */
  command(cmd: StandCommandKind, slot?: number): Promise<string>;
  /** Остановить процесс: сперва вежливо, потом — как придётся. */
  stop(): Promise<void>;
  /** Процесс закончился (любым способом). */
  readonly exited: Promise<void>;
}

/** Отвечают ли по адресу. Ни одного байта в соединение не пишется. */
function answers(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (busy: boolean): void => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { done(true); });
    socket.once('timeout', () => { done(false); });
    socket.once('error', () => { done(false); });
  });
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Занят ли порт ДО запуска: занятость — названный отказ запуска (MGR-2). */
export function portBusy(port: number): Promise<boolean> {
  return answers(port);
}

export function startStandProcess(options: StandProcessOptions): StandProcess {
  const child: ChildProcess = spawn(options.runtime, [options.script, ...options.args], {
    // stdin — канал команд, stdout — отчёт и лог, stderr — тоже лог: трейс
    // стенда по умолчанию идёт туда, и терять его в никуда нельзя.
    stdio: ['pipe', 'pipe', 'pipe'],
    // СВОЯ группа процессов (POSIX). Иначе Ctrl+C в терминале агента шлёт SIGINT
    // всей группе переднего плана и убивает все идущие матчи разом — а серверы
    // обязаны переживать уход агента: на этом стоит и книга процессов (D5), и
    // выключенный тумблер MGR-4. Останов идёт по PID и от группы не зависит.
    ...(process.platform === 'win32' ? { windowsHide: true } : { detached: true }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  // Ошибки каналов stdio — НЕ повод падать. Запись в stdin процесса, который уже
  // умер, но чей `exit` ещё не доставлен, поднимает EPIPE необработанным
  // событием: агент умер бы вместе со ВСЕМИ своими серверами (SRV-1). Исход
  // висящей команды всё равно назовёт обработчик выхода.
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);

  const log: string[] = [];
  const pending = new Map<number, (reason: string) => void>();
  let state: StandProcessState = 'starting';
  /** Выход попросили МЫ: см. вердикт в обработчике `exit`. */
  let stopping = false;
  let exitCode: number | null = null;
  let report: StandReportLine | undefined;
  let ready: StandReadyLine | undefined;
  let nextId = 1;

  const remember = (line: string): void => {
    const text = line.length > LOG_LINE_LIMIT ? `${line.slice(0, LOG_LINE_LIMIT)}… [строка обрезана]` : line;
    log.push(text);
    if (log.length > LOG_RING) log.shift();
    options.onLog?.(text);
  };

  /** Хвосты потоков без перевода строки: их дочитывает выход процесса. */
  const flushes: (() => void)[] = [];

  /** Разбор потока в линии: stdout — поток байтов, линия вправе приехать частями. */
  const reader = (handle: (line: string) => void): ((chunk: string) => void) => {
    let rest = '';
    // Предсмертная строка без перевода — самая ценная для разбора (SRV-6):
    // выход процесса её дочитывает, а не выбрасывает вместе с буфером.
    flushes.push(() => {
      if (rest === '') return;
      const tail = rest;
      rest = '';
      handle(tail);
    });
    return (chunk: string): void => {
      rest += chunk;
      for (;;) {
        const edge = rest.indexOf('\n');
        if (edge < 0) break;
        handle(rest.slice(0, edge));
        rest = rest.slice(edge + 1);
      }
      // Прогресс-строка стенда пишется без перевода строки; чтобы она не копилась
      // в буфере бесконечно, длинный хвост считаем линией сам. УПРАВЛЯЮЩУЮ линию
      // так резать нельзя: половина JSON перестаёт быть отчётом и молча уходит в
      // лог — отчёт пропадает, а видимая запись застывает на прошлой (решение D2).
      if (rest.length > LOG_LINE_LIMIT && !rest.startsWith(CONTROL_LINE_PREFIX)) {
        handle(rest);
        rest = '';
      }
    };
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', reader((line) => {
    const control = decodeStandLine(line);
    if (control === undefined) {
      // Не управляющая линия — обычный лог. Разделяет их только маркер, и это
      // единственное, что не даёт им смешаться (решение D2).
      if (line.trim() !== '') remember(line);
      return;
    }
    if (control.t === 'report') {
      report = control;
      options.onReport?.(control);
      return;
    }
    if (control.t === 'ready') {
      ready = control;
      options.onReady?.(control);
      return;
    }
    pending.get(control.id)?.(control.ok ? '' : control.reason);
    pending.delete(control.id);
  }));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', reader((line) => { if (line.trim() !== '') remember(line); }));

  const exited = new Promise<void>((done) => {
    child.once('exit', (code, signal) => {
      exitCode = code;
      for (const flush of flushes) flush();
      // Крах — всё, кроме нулевого кода И кроме выхода, которого мы САМИ
      // попросили (SRV-1). Убитый OOM-killer'ом процесс кода не оставляет вовсе,
      // и считать его «остановленным» значило бы прятать ночной краш; но и
      // обратное неверно: стенд без обработчика SIGTERM уходит от сигнала, а на
      // Windows иначе не уходит вовсе — каждая штатная остановка объявлялась бы
      // крахом и писала постмортем (SRV-6).
      state = stopping || code === 0 ? 'stopped' : 'crashed';
      for (const [id, resolve] of pending) {
        resolve('процесс сервера завершился');
        pending.delete(id);
      }
      options.onExit?.(code, signal, state);
      done();
    });
    child.once('error', (error) => {
      state = 'crashed';
      remember(`процесс не запустился: ${error.message}`);
      options.onExit?.(null, null, state);
      done();
    });
  });

  return {
    get pid(): number {
      return child.pid ?? -1;
    },
    get state(): StandProcessState {
      return state;
    },
    get exitCode(): number | null {
      return exitCode;
    },
    get report(): StandReportLine | undefined {
      return report;
    },
    get ready(): StandReadyLine | undefined {
      return ready;
    },
    exited,
    log() {
      return [...log];
    },
    async untilListening() {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
      for (;;) {
        if (await answers(options.port)) {
          if (state === 'starting') state = 'listening';
          return;
        }
        if (state === 'crashed' || state === 'stopped') {
          throw new Error(
            `сервер завершился, не начав слушать порт ${options.port} (код ${String(exitCode)})`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(`сервер не начал слушать порт ${options.port}`);
        }
        await wait(PROBE_STEP_MS);
      }
    },
    command(cmd, slot = -1) {
      if (child.stdin === null || child.killed || state === 'crashed' || state === 'stopped') {
        return Promise.resolve('процесс сервера не работает');
      }
      const id = nextId++;
      return new Promise<string>((resolve) => {
        pending.set(id, resolve);
        child.stdin?.write(encodeStandCommand({ id, cmd, slot }));
        // Молчание в ответ — тоже исход, и он назван: команда, о которой нельзя
        // сказать «исполнена» или «отказано», хуже отказа.
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve('сервер не ответил на команду');
        }, COMMAND_TIMEOUT_MS).unref();
      });
    },
    async stop() {
      if (state === 'crashed' || state === 'stopped') return;
      stopping = true;
      child.kill('SIGTERM');
      // Таймер милости СНИМАЕТСЯ: проигравший в гонке `setTimeout` иначе держит
      // цикл событий ещё три секунды на каждый остановленный сервер.
      let grace: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise<boolean>((done) => {
        grace = setTimeout(() => { done(false); }, GRACE_MS);
      });
      const stopped = await Promise.race([exited.then(() => true), patience]);
      if (grace !== undefined) clearTimeout(grace);
      if (!stopped) child.kill('SIGKILL');
      await exited;
    },
  };
}
