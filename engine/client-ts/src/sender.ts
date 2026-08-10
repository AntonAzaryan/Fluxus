/**
 * ShellSender — воркер-сторона канала состояния (SHELL-3, SHELL-4).
 *
 * Ping-pong с ack-conflation (design Decision 5): доставка уходит только
 * когда в пуле есть буфер, возврат буфера главным потоком — одновременно
 * ack. Пока свободного буфера нет, sender копит reliable-часть (события с
 * номерами тиков, дельту пола later-wins, OR флагов разрыва), а состояние
 * сущностей не копит вовсе: на отправке оно сериализуется из последнего
 * `extract`'а — очередь недоставленных состояний не существует по
 * построению.
 *
 * В устоявшемся режиме на тик не аллоцируется ничего, кроме мелкого
 * конверта сообщения: буферы циркулируют по кругу, перевыделение — только
 * при росте сцены, с запасом ×1.5 (SHELL-3).
 *
 * Путь доставки один на оба режима оболочки (SHELL-8): и локальная
 * воркер-сторона (`WorkerShell`), и сетевая (`NetworkShell`) отправляют состояние
 * этим sender'ом и этим кодеком, а раскладка буфера по режиму не ветвится
 * (SHELL-3). Различается только источник `ExtractedTick` — собственный тик или
 * применённый персональный снапшот.
 */
import type { ExtractedTick, RenderEvent } from '@game-mvp/render';
import { requiredBytes, writeTick } from './codec.js';
import type { ShellPort, TickEnvelope } from './protocol.js';

const EMPTY_EVENTS: readonly RenderEvent[] = [];
const EMPTY_KINDS: readonly string[] = [];
const EMPTY_DELTA: readonly number[] = [];

export interface SenderOptions {
  /** Буферов в пуле; 2 достаточно: один в полёте, один под запись. */
  readonly poolSize?: number;
  /** Начальный размер буфера в байтах. */
  readonly initialBytes?: number;
  /**
   * Лимит глубины аккумулятора событий в тиках (Risks: замороженный main).
   * События старше вытесняются со счётчиком `expiredEvents` в конверте —
   * после разморозки звук/VFX минутной давности не проигрываются пачкой.
   */
  readonly maxEventAgeTicks?: number;
}

export class ShellSender {
  private readonly port: ShellPort;
  private readonly pool: ArrayBuffer[] = [];
  private readonly maxEventAgeTicks: number;

  /** Последний extract; его колонки живы между тиками — источник отправки. */
  private latest: ExtractedTick | null = null;
  private dirty = false;

  private events: RenderEvent[] = [];
  private expiredEvents = 0;
  /** Аккумулированная дельта пола: клетка → последний бит (later-wins, SHELL-4). */
  private readonly floor = new Map<number, number>();
  private snapAllPending = false;
  private freshPending = false;
  private kindsSent = 0;

  constructor(port: ShellPort, options: SenderOptions = {}) {
    this.port = port;
    this.maxEventAgeTicks = options.maxEventAgeTicks ?? 120;
    const poolSize = options.poolSize ?? 2;
    const initialBytes = options.initialBytes ?? 16 * 1024;
    for (let i = 0; i < poolSize; i++) this.pool.push(new ArrayBuffer(initialBytes));
  }

  /** Тик извлечён: аккумулировать reliable-часть и отправить, если есть буфер. */
  push(ext: ExtractedTick): void {
    this.latest = ext;
    this.dirty = true;
    for (const event of ext.events) this.events.push(event);
    while (
      this.events.length > 0 &&
      ext.tick - (this.events[0]!.tick ?? ext.tick) > this.maxEventAgeTicks
    ) {
      this.events.shift();
      this.expiredEvents++;
    }
    const delta = ext.floorDelta;
    for (let i = 0; i + 1 < delta.length; i += 2) this.floor.set(delta[i]!, delta[i + 1]!);
    this.snapAllPending ||= ext.snapAll;
    this.freshPending ||= ext.freshEvents;
    this.tryFlush();
  }

  /**
   * Reliable-события, пришедшие НЕ из извлечённого тика: в сетевом режиме факты
   * приезжают отдельным сообщением `Events` (`netcode-transport` NTR-15), а не
   * шиной применённого снапшота, и попасть в конверт обязаны тем же путём, что
   * события локального тика (SHELL-4).
   *
   * Только накапливает: конверт несёт состояние вместе с фактами, и отправлять
   * факты в одиночку каналу нечем. Дожидаются они ближайшей доставки состояния
   * либо `flushEvents()`; политика вытеснения по глубине — одна на оба источника
   * и применяется в `push`, где известен номер тика.
   *
   * `freshEvents` — можно ли проигрывать эти факты (OBS-5); флаг конверта один на
   * все накопленные, и здесь он ИЛИ-ится ровно так же, как из `ExtractedTick` в
   * `push`. Отправитель обязан назвать его сам: факты стёртой перемоткой ветви
   * истории показывать второй раз нечего, и «свежесть» знает он, а не канал.
   */
  pushEvents(events: readonly RenderEvent[], freshEvents: boolean): void {
    for (const event of events) this.events.push(event);
    this.freshPending ||= freshEvents;
  }

  /**
   * Довыпустить накопленные факты, повторив последнее состояние.
   *
   * Конверт несёт факты только вместе с состоянием, поэтому обычно они уезжают
   * ближайшей доставкой. Когда ближайшей не будет — сессия кончилась: хвост
   * потока событий приходит вместе с концом матча и финальным снапшотом НЕ
   * сопровождается (`netcode-transport` NTR-15) — состояние повторяется. Это
   * законно ровно потому, что состояние conflatable: повторный конверт того же
   * тика `ViewBuffer` не двигает вперёд (prev/curr на месте, часы тика не
   * сбрасываются), а факт однократен, и потерять его нельзя.
   *
   * Свободного буфера в пуле может не быть — тогда доставка уйдёт ближайшим
   * `ack`: `dirty` для этого и взводится, а не «отправить или забыть».
   */
  flushEvents(): void {
    if (this.latest === null || this.events.length === 0) return;
    this.dirty = true;
    this.tryFlush();
  }

  /** Главный поток вернул буфер: пул пополнен, недоставленное — доставить. */
  ack(buffer: ArrayBuffer): void {
    this.pool.push(buffer);
    this.tryFlush();
  }

  private tryFlush(): void {
    const ext = this.latest;
    if (!this.dirty || ext === null) return;
    let buffer = this.pool.pop();
    if (buffer === undefined) return;

    const floorDelta = this.flattenFloor();
    const needed = requiredBytes(ext.count, floorDelta.length >>> 1);
    if (buffer.byteLength < needed) {
      // Единственное легальное место аллокации канала: рост сцены (SHELL-3).
      buffer = new ArrayBuffer(Math.ceil(needed * 1.5));
    }
    writeTick(buffer, ext, {
      snapAll: this.snapAllPending,
      freshEvents: this.freshPending,
      floorDelta,
    });

    const envelope: TickEnvelope = {
      t: 'tick',
      buffer,
      events: this.events.length > 0 ? this.events : EMPTY_EVENTS,
      kinds:
        this.kindsSent < ext.kindTable.length
          ? ext.kindTable.slice(this.kindsSent)
          : EMPTY_KINDS,
      expiredEvents: this.expiredEvents,
    };
    this.kindsSent = ext.kindTable.length;
    if (this.events.length > 0) this.events = [];
    this.expiredEvents = 0;
    this.floor.clear();
    this.snapAllPending = false;
    this.freshPending = false;
    this.dirty = false;

    this.port.post(envelope, [buffer]);
  }

  private flattenFloor(): ArrayLike<number> {
    if (this.floor.size === 0) return EMPTY_DELTA;
    const flat: number[] = [];
    for (const [cell, bit] of this.floor) flat.push(cell, bit);
    return flat;
  }
}
