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
  /** Процесс вышел: код и сигнал — материал постмортема (SRV-6). */
  readonly onExit?: (code: number | null, signal: string | null) => void;
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
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  const log: string[] = [];
  const pending = new Map<number, (reason: string) => void>();
  let state: StandProcessState = 'starting';
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

  /** Разбор потока в линии: stdout — поток байтов, линия вправе приехать частями. */
  const reader = (handle: (line: string) => void): ((chunk: string) => void) => {
    let rest = '';
    return (chunk: string): void => {
      rest += chunk;
      for (;;) {
        const edge = rest.indexOf('\n');
        if (edge < 0) break;
        handle(rest.slice(0, edge));
        rest = rest.slice(edge + 1);
      }
      // Прогресс-строка стенда пишется без перевода строки; чтобы она не копилась
      // в буфере бесконечно, длинный хвост считаем линией сам.
      if (rest.length > LOG_LINE_LIMIT) {
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
      // Крах — ВСЁ, кроме нулевого кода (SRV-1): и ненулевой код, и смерть от
      // сигнала. Убитый OOM-killer'ом процесс кода не оставляет вовсе, и
      // считать его «остановленным» значило бы прятать ночной краш. Остановку,
      // которую попросили мы сами, реестр помечает `stopped` явно — ему не
      // нужно выводить её из кода выхода.
      state = code === 0 ? 'stopped' : 'crashed';
      for (const [id, resolve] of pending) {
        resolve('процесс сервера завершился');
        pending.delete(id);
      }
      options.onExit?.(code, signal);
      done();
    });
    child.once('error', (error) => {
      state = 'crashed';
      remember(`процесс не запустился: ${error.message}`);
      options.onExit?.(null, null);
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
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), wait(GRACE_MS).then(() => false)]);
      if (!stopped) child.kill('SIGKILL');
      await exited;
    },
  };
}
