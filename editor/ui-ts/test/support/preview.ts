/**
 * Вторая сторона канала оболочки без воркера — то, что тест подставляет вместо
 * `workerPreviewBackend` (ED-9, SHELL-3).
 *
 * Подделан ровно механизм доставки, и только он: пара портов вместо
 * `postMessage` и ручной шаг тика вместо таймера. Всё остальное — настоящее:
 * `WorkerShell` с настоящим ядром на своей стороне, `RemoteHost` на другой,
 * настоящие кодек и конверты. Иначе проверялось бы не «что пересекает границу»,
 * а «что тест положил на её место».
 *
 * Порт при этом ещё и протоколирует: список сообщений в обе стороны — это и
 * есть ответ на вопрос ED-13, меняет ли прогон движение камеры. Буфер тика
 * копируется в момент отправки, потому что владеет им пул и переиспользует его
 * (SHELL-3): сравнивать по ссылке было бы сравнением с самим собой.
 */
import {
  startPreviewSimulation,
  type PreviewBackendFactory,
  type PreviewSceneMessage,
  type PreviewSimulation,
} from '../../src/areas/scenePreview.js';

/** Структурный минимум порта оболочки; своего типа пакет не заводит. */
interface TestPort {
  post(message: unknown, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (message: unknown) => void): void;
}

/** Сообщение канала в виде, пригодном для сравнения двух прогонов. */
export interface RecordedMessage {
  /** Кто отправил: главный поток или воркер. */
  readonly from: 'main' | 'worker';
  readonly kind: string;
  /** Байты буфера тика на момент отправки; `null` — буфера в сообщении нет. */
  readonly bytes: readonly number[] | null;
}

export interface PreviewProbe {
  /** Сцены, с которыми поднимался прогон, — по одной на запуск (ED-9). */
  readonly scenes: readonly PreviewSceneMessage[];
  /** Всё, что прошло через канал, в порядке отправки. */
  readonly messages: readonly RecordedMessage[];
  /** Симуляция последнего прогона; `null` — прогонов не было. */
  readonly simulation: PreviewSimulation | null;
  /** Сколько прогонов снесено. */
  readonly disposals: number;
  /** Тики воркера вручную: таймеров в прогоне тестов нет. */
  step(ticks?: number): void;
  /** То, что подставляется области вместо воркера. */
  readonly factory: PreviewBackendFactory;
}

function bytesOf(message: unknown): readonly number[] | null {
  const buffer = (message as { buffer?: unknown }).buffer;
  return buffer instanceof ArrayBuffer ? [...new Uint8Array(buffer)] : null;
}

function kindOf(message: unknown): string {
  const tag = (message as { t?: unknown }).t;
  return typeof tag === 'string' ? tag : 'unknown';
}

export function previewProbe(): PreviewProbe {
  const scenes: PreviewSceneMessage[] = [];
  const messages: RecordedMessage[] = [];
  let simulation: PreviewSimulation | null = null;
  let disposals = 0;

  const factory: PreviewBackendFactory = (message) => {
    scenes.push(message);
    let onMain: ((message: unknown) => void) | null = null;
    let onWorker: ((message: unknown) => void) | null = null;
    const record = (from: 'main' | 'worker', payload: unknown): void => {
      messages.push({ from, kind: kindOf(payload), bytes: bytesOf(payload) });
    };
    const mainPort: TestPort = {
      post(payload) {
        record('main', payload);
        onWorker?.(payload);
      },
      onMessage(handler) {
        onMain = handler;
      },
    };
    const workerPort: TestPort = {
      post(payload) {
        record('worker', payload);
        onMain?.(payload);
      },
      onMessage(handler) {
        onWorker = handler;
      },
    };
    return {
      port: mainPort,
      start() {
        const started = startPreviewSimulation(workerPort, message);
        simulation = started;
        // `start` шлёт handshake (SHELL-5) и заводит тикер; тикер тут же
        // гасится — тики в прогоне тестов даёт `step`, а не часы.
        started.shell.start();
        started.shell.stop();
      },
      dispose() {
        simulation?.shell.stop();
        disposals++;
      },
    };
  };

  return {
    scenes,
    messages,
    get simulation(): PreviewSimulation | null {
      return simulation;
    },
    get disposals(): number {
      return disposals;
    },
    step(ticks = 1) {
      for (let index = 0; index < ticks; index++) simulation?.shell.stepTick();
    },
    factory,
  };
}
