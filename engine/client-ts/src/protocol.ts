/**
 * Протокол канала оболочки (client-shell): типы сообщений между воркером и
 * главным потоком и минимальная абстракция порта.
 *
 * Порт — то единственное, что оболочка знает о механизме доставки: DOM
 * `Worker`/`MessagePort`, Node `MessagePort` (тесты) и синхронная пара в
 * одном потоке подходят одинаково. Замена доставки не трогает ни кодек,
 * ни sender/receiver (SHELL-3).
 */
import type { TerrainGrid, Vec2 } from '@game-mvp/core';
import type { RenderEvent } from '@game-mvp/render';

// ---------------------------------------------------------------------- порт

export interface ShellPort {
  post(message: unknown, transfer?: ArrayBuffer[]): void;
  /** Обработчик один: два потребителя одного порта — ошибка сборки, а не сценарий. */
  onMessage(handler: (message: unknown) => void): void;
}

/** Структурный минимум DOM-порта (Worker / MessagePort / DedicatedWorkerGlobalScope). */
interface DomPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
}

/** Структурный минимум Node-порта (worker_threads MessagePort — EventEmitter). */
interface NodePortLike {
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (value: unknown) => void): void;
  start?(): void;
}

/**
 * Оборачивает реальный порт в `ShellPort`. Node-порт отдаёт значение прямо в
 * листенер, DOM-порт — событие с `data`; `start()` дергается там, где он есть
 * (MessagePort без него копит сообщения).
 */
export function shellPort(port: DomPortLike | NodePortLike): ShellPort {
  return {
    post(message, transfer) {
      // Сигнатуры DOM и Node совместимы по ArrayBuffer-переносу.
      (port as DomPortLike).postMessage(message, transfer);
    },
    onMessage(handler) {
      if ('on' in port && typeof port.on === 'function') {
        port.on('message', handler);
      } else {
        (port as DomPortLike).addEventListener('message', (event) => handler(event.data));
      }
      port.start?.();
    },
  };
}

// ---------------------------------------------------------- воркер → main

/** Handshake до первой доставки состояния (SHELL-5). */
export interface HelloMessage {
  readonly t: 'hello';
  readonly tickSeconds: number;
  /** Сетка террейна целиком (structured clone — копия); null — сцена без террейна. */
  readonly terrain: TerrainGrid | null;
  /** Полезная нагрузка сборки (id локального игрока и прочее) — оболочка её не трактует. */
  readonly extra?: unknown;
}

/**
 * Конверт тика: плоский буфер состояния (transfer, conflatable) плюс
 * reliable-часть structured clone'ом — события всех тиков с прошлой доставки
 * (каждое с номером тика) и дословарь kind'ов (SHELL-4, SHELL-5).
 */
export interface TickEnvelope {
  readonly t: 'tick';
  readonly buffer: ArrayBuffer;
  readonly events: readonly RenderEvent[];
  /** Новые записи словаря kind'ов с прошлой доставки, append-only. */
  readonly kinds: readonly string[];
  /** Сколько событий вытеснено лимитом глубины аккумулятора (Risks: замороженный main). */
  readonly expiredEvents: number;
}

export type WorkerToMain = HelloMessage | TickEnvelope;

// ---------------------------------------------------------- main → воркер

/** Возврат прочитанного буфера в пул воркера; одновременно ack доставки (SHELL-3). */
export interface ReturnBufferMessage {
  readonly t: 'ret';
  readonly buffer: ArrayBuffer;
}

/**
 * Сырой ввод игрока (SHELL-6): main строит всё, кроме `tick`/`seq` — их
 * знает только воркер, применяющий ввод на границе тика. `move` — уже
 * fixed-вектор: конверсию float → fixed делает отправитель, ядру канал
 * отдаёт канонический `InputFrame`.
 */
export interface InputMessage {
  readonly t: 'input';
  readonly move: Vec2;
  readonly aimDir: number;
  readonly buttons: number;
}

/** Команды машины состояний мира (WSM-1..6): пауза, перемотка, возобновление. */
export interface ControlMessage {
  readonly t: 'control';
  readonly action: 'pause' | 'resume' | 'beginRewind' | 'seekTo';
  readonly tick?: number;
}

export type MainToWorker = ReturnBufferMessage | InputMessage | ControlMessage;
