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
        (port as DomPortLike).addEventListener('message', (event) => { handler(event.data); });
      }
      port.start?.();
    },
  };
}

// ---------------------------------------------------------------- режим

/**
 * Режим оболочки (SHELL-8): ровно два, и выбирается он на старте сессии.
 *
 * `local` — состояние производит сама оболочка: воркер тикает симуляцию, держит
 * `HistoryProvider` и исполняет переходы машины состояний у себя (демо,
 * редактор, офлайн-прогон). `network` — оболочка рисует состояние авторитетного
 * сервера: `tick()` не вызывается ни разу, ввод уезжает сообщением `Input`
 * (`netcode` NET-7), переходы принимает сервер (`netcode` NET-11).
 *
 * Третьего значения нет намеренно: смешанная форма — «тикаю и принимаю
 * авторитетные состояния, не предсказывая» — есть клиент с локальным
 * авторитетом, отрицаемый `netcode` NET-1 (SHELL-8).
 */
export type ShellMode = 'local' | 'network';

// ---------------------------------------------------------- воркер → main

/** Handshake до первой доставки состояния (SHELL-5). */
export interface HelloMessage {
  readonly t: 'hello';
  /**
   * Режим оболочки (SHELL-8). Поле обязательное, и умолчания у него нет:
   * главный поток обязан знать режим до первого кадра — от него зависит, какие
   * органы управления вообще существуют, — и выводить его наблюдением за
   * потоком доставок MUST NOT.
   */
  readonly mode: ShellMode;
  readonly tickSeconds: number;
  /** Сетка террейна целиком (structured clone — копия); null — сцена без террейна. */
  readonly terrain: TerrainGrid | null;
  /** Полезная нагрузка сборки (id локального игрока и прочее) — оболочка её не трактует. */
  readonly extra?: unknown;
}

/**
 * Собирает handshake — общий путь обеих воркер-сторон (SHELL-5, SHELL-8):
 * состав сообщения одинаков в оба режима, различается только значение `mode`.
 * Отдельной функцией, а не литералом на каждой стороне, чтобы «состав
 * handshake совпадает» держалось кодом, а не сравнением двух мест глазами.
 */
export function helloMessage(init: {
  readonly mode: ShellMode;
  readonly tickSeconds: number;
  readonly terrain: TerrainGrid | null;
  readonly extra?: unknown;
}): HelloMessage {
  return {
    t: 'hello',
    mode: init.mode,
    tickSeconds: init.tickSeconds,
    terrain: init.terrain,
    ...(init.extra !== undefined ? { extra: init.extra } : {}),
  };
}

/**
 * Конверт тика: плоский буфер состояния (transfer, conflatable) плюс
 * reliable-часть structured clone'ом — события честных тиков с прошлой
 * доставки (каждое с номером тика; реплеевые переэмиссии в аккумулятор
 * не попадают — «ровно один раз», см. `sender.ts`) и дословарь kind'ов
 * (SHELL-4, SHELL-5).
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
//
// Форма сообщений обратного канала одна на оба режима (SHELL-6, SHELL-8):
// главный поток отправляет ввод и запрашивает переходы одинаково, а что
// происходит с сообщением дальше, определяет режим. Ветвление UI по режиму
// здесь и запрещено: в локальном режиме сообщение доходит до core-API, в
// сетевом уезжает вводом на сервер.

/** Возврат прочитанного буфера в пул воркера; одновременно ack доставки (SHELL-3). */
export interface ReturnBufferMessage {
  readonly t: 'ret';
  readonly buffer: ArrayBuffer;
}

/**
 * Сырой ввод игрока (SHELL-6): main строит всё, кроме `tick`/`seq` — их знает
 * воркер-сторона (в локальном режиме — применяющая ввод на границе тика, в
 * сетевом — отправляющая его серверу). `move` — уже fixed-вектор: конверсию
 * float → fixed делает отправитель, ядру канал отдаёт канонический
 * `InputFrame`.
 */
export interface InputMessage {
  readonly t: 'input';
  readonly move: Vec2;
  readonly aimDir: number;
  readonly buttons: number;
}

/**
 * Запрос перехода машины состояний мира (WSM-1..6): пауза, перемотка,
 * возобновление. ЗАПРОС, а не факт: в локальном режиме воркер исполняет переход
 * у себя через core-API (WSM-5), в сетевом отправляет его вводом на авторитетный
 * сервер (`netcode` NET-11, `snapshot-rewind` REW-6) и у себя MUST NOT
 * исполнять. «Запрошено» и «произошло» разделены кругом до сервера, и главный
 * поток узнаёт о результате из доставленного состояния (SHELL-7).
 */
export interface ControlMessage {
  readonly t: 'control';
  readonly action: 'pause' | 'resume' | 'beginRewind' | 'seekTo';
  readonly tick?: number;
}

export type MainToWorker = ReturnBufferMessage | InputMessage | ControlMessage;
