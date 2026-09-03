/**
 * ShellSender — воркер-сторона канала состояния (SHELL-3, SHELL-4).
 *
 * Ping-pong с ack-conflation (design Decision 5): доставка уходит только
 * когда в пуле есть буфер, возврат буфера главным потоком — одновременно
 * ack. Пока свободного буфера нет, sender копит reliable-часть (события
 * честных тиков с номерами тиков, дельту пола later-wins, OR флагов
 * разрыва), а состояние сущностей не копит вовсе: на отправке оно
 * сериализуется из последнего `extract`'а — очередь недоставленных
 * состояний не существует по построению.
 *
 * В аккумулятор событий попадают ТОЛЬКО события честных проходов
 * (`freshEvents` extractor'а, OBS-5): rewind/replay переэмитирует уже
 * доставленные события (REW-10), и попади они в аккумулятор — конверт,
 * чьё окно пересекло перемотку, смешал бы дубликаты с новыми. «Ровно один
 * раз» (SHELL-4, match-hud HUD-5) держится здесь конструктивно: все
 * события конверта свежие, и его флаг `freshEvents` честен буквально.
 *
 * Второй источник фактов — сетевой поток `Events` (`pushEvents`), и он кладёт в
 * тот же накопитель факты, которые проигрывать НЕЛЬЗЯ (разрыв непрерывности,
 * SHELL-7). Флаг конверта один на пачку, поэтому «нельзя» в нём побеждает —
 * см. `unplayablePending`.
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
import type { ExtractedTick, RenderEvent } from '@fluxus/render';
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
  /**
   * Кадр УЕХАЛ — сообщить об этом извлечению (SHELL-3, SHELL-4): зеркало
   * последнего доставленного состояния двигает факт доставки, а не факт
   * извлечения, и знает о нём только отправитель. Не задан — извлечение
   * частичных кадров не ведёт (стенды, прямые вызовы кодека).
   */
  readonly onDelivered?: () => void;
}

export class ShellSender {
  private readonly port: ShellPort;
  private readonly pool: ArrayBuffer[] = [];
  private readonly maxEventAgeTicks: number;
  private readonly onDelivered: (() => void) | null;

  /** Последний extract; его колонки живы между тиками — источник отправки. */
  private latest: ExtractedTick | null = null;
  private dirty = false;

  private events: RenderEvent[] = [];
  private expiredEvents = 0;
  /** Аккумулированная дельта пола: клетка → последний бит (later-wins, SHELL-4). */
  private readonly floor = new Map<number, number>();
  private snapAllPending = false;
  /**
   * Сменилась ли ВЕТВЬ истории в окне доставки (SHELL-7) — своё ИЛИ, отдельно
   * от `snapAll`: конфляция (SHELL-4) вправе съесть тик смены ветви, и признак
   * обязан пережить её так же, как разрыв картинки. Оба признака нужны
   * приёмнику по-разному: по первому он снапит интерполяцию (REND-2), по
   * второму — забывает всё, что помнил по идентификаторам сущностей (NTR-16).
   */
  private branchChangedPending = false;
  /**
   * Был ли в окне честный проход (OBS-5). Аккумулятор несёт только события
   * честных тиков, поэтому флаг конверта означает «события этого конверта
   * свежие, их можно проигрывать» — реплеевых дубликатов в нём нет.
   */
  private freshPending = false;
  /**
   * В накопителе лежат факты, которые отправитель пометил НЕПРОИГРЫВАЕМЫМИ
   * (`pushEvents(events, false)`): факты, попавшие на разрыв непрерывности
   * (SHELL-7) — возврат после обрыва, стёртая перемоткой ветвь.
   *
   * Флаг конверта один на всю пачку, поэтому и решение одно на всю пачку, и
   * побеждает в нём «НЕЛЬЗЯ»: доигрывать сквозь разрыв запрещено (HUD-5), а
   * различить внутри одного конверта, какие факты по какую сторону разрыва,
   * получателю нечем. Без этого держалось узкое окно: разрыв кладёт факты, в
   * этот момент свободного буфера нет, доставка не уходит, — и следующий
   * обычный `push` ИЛИ-ил флаг в «можно», озвучивая уже перескочённую картинкой
   * историю.
   *
   * Взводит его только `pushEvents` и только когда факты действительно легли в
   * накопитель. Обычный `push` его не трогает вовсе: нечестный проход фактов не
   * накапливает (см. выше), и голосуй он тоже — любая перемотка гасила бы
   * следующие за ней честные факты, ни одного из которых разрыв не касался.
   */
  private unplayablePending = false;
  private kindsSent = 0;

  constructor(port: ShellPort, options: SenderOptions = {}) {
    this.port = port;
    this.maxEventAgeTicks = options.maxEventAgeTicks ?? 120;
    this.onDelivered = options.onDelivered ?? null;
    const poolSize = options.poolSize ?? 2;
    const initialBytes = options.initialBytes ?? 16 * 1024;
    for (let i = 0; i < poolSize; i++) this.pool.push(new ArrayBuffer(initialBytes));
  }

  /** Тик извлечён: аккумулировать reliable-часть и отправить, если есть буфер. */
  push(ext: ExtractedTick): void {
    this.latest = ext;
    this.dirty = true;
    // Только события честных проходов: реплеевый тик переэмитирует уже
    // доставленные (REW-10), их место — мусор, а не аккумулятор (SHELL-4).
    if (ext.freshEvents) {
      for (const event of ext.events) this.events.push(event);
    }
    let oldest = this.events[0];
    while (oldest !== undefined && ext.tick - (oldest.tick ?? ext.tick) > this.maxEventAgeTicks) {
      this.events.shift();
      this.expiredEvents++;
      oldest = this.events[0];
    }
    const delta = ext.floorDelta;
    // Пары «клетка → уровень» лежат подряд, и условие цикла держит обе внутри
    // длины: `i + 1 < delta.length`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- инвариант описан строкой выше
    for (let i = 0; i + 1 < delta.length; i += 2) this.floor.set(delta[i]!, delta[i + 1]!);
    this.snapAllPending ||= ext.snapAll;
    this.branchChangedPending ||= ext.branchChanged;
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
   * `freshEvents` — можно ли проигрывать эти факты (OBS-5). Отправитель обязан
   * назвать его сам: факты стёртой перемоткой ветви истории показывать второй
   * раз нечего, и «свежесть» знает он, а не канал.
   *
   * Флаг конверта один на все накопленные, и «нельзя» в нём ПОБЕЖДАЕТ
   * (`unplayablePending`): пачка, в которую положили факты разрыва, уезжает
   * непроигрываемой целиком, сколько бы честных фактов ни легло следом.
   * Доигрывать сквозь разрыв запрещено (HUD-5), а разделить пачку внутри одного
   * конверта нечем — флаг у неё один.
   *
   * Пустой список не голосует и вовсе ничего не делает: «фактов не было» — не
   * утверждение о проигрываемости.
   */
  pushEvents(events: readonly RenderEvent[], freshEvents: boolean): void {
    if (events.length === 0) return;
    for (const event of events) this.events.push(event);
    if (freshEvents) this.freshPending = true;
    else this.unplayablePending = true;
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
    const needed = requiredBytes(
      ext.count,
      floorDelta.length >>> 1,
      ext.statPairs,
      ext.removedCount,
    );
    if (buffer.byteLength < needed) {
      // Единственное легальное место аллокации канала: рост сцены (SHELL-3).
      buffer = new ArrayBuffer(Math.ceil(needed * 1.5));
    }
    writeTick(buffer, ext, {
      snapAll: this.snapAllPending,
      branchChanged: this.branchChangedPending,
      // «Нельзя» побеждает: непроигрываемый факт в накопителе гасит флаг всей
      // пачки (SHELL-4, HUD-5) — см. `unplayablePending`.
      freshEvents: this.freshPending && !this.unplayablePending,
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
    this.branchChangedPending = false;
    this.freshPending = false;
    this.unplayablePending = false;
    this.dirty = false;

    this.port.post(envelope, [buffer]);
    // Кадр уехал: зеркало извлечения двигается на него (SHELL-3). Строго ПОСЛЕ
    // записи буфера — до неё кадр ещё не доставлен, и ранний сдвиг зеркала
    // потерял бы изменения, если бы запись бросила (SHELL-4).
    this.onDelivered?.();
  }

  private flattenFloor(): ArrayLike<number> {
    if (this.floor.size === 0) return EMPTY_DELTA;
    const flat: number[] = [];
    for (const [cell, bit] of this.floor) flat.push(cell, bit);
    return flat;
  }
}
