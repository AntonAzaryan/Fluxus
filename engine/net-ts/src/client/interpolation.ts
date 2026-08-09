/**
 * Буфер интерполяции чужих сущностей (NET-3): рендер идёт с небольшим
 * отставанием между двумя authoritative-снапшотами, старт ~100 мс.
 *
 * Отставание — не задержка ради задержки, а запас, из которого берётся
 * непрерывность: без него каждый пропущенный или переупорядоченный снапшот
 * превращался бы в рывок либо в экстраполяцию «на глазок».
 *
 * `alpha` здесь — обычный float, и это не нарушение DET-2: интерполяция живёт
 * в представлении, а не в симуляции. В мир из этого файла не уходит ничего.
 */
import { world as coreWorld, type EntityId, type Snapshot } from '@game-mvp/core';

export interface InterpolationOptions {
  readonly delayMs?: number;
  /** Глубина буфера в снапшотах; по умолчанию — секунда при рассылке 30 Гц. */
  readonly capacity?: number;
}

/**
 * Состояние, отдаваемое представлению, — снапшот БЕЗ шины (NTR-15, «Шина внутри
 * снапшота»).
 *
 * Шина едет в кадре на проводе и хранится в буфере как есть: это состояние,
 * восстанавливаемое вместе с миром (`snapshot-rewind` SNAP-1), и снятие его
 * сделало бы снапшот неполным. Но «получатель MUST NOT брать из неё факты для
 * представления»: единственный источник фактов — поток `Events`
 * (`MatchClient.takeEvents`), иначе события тиков рассылки проигрывались бы
 * дважды — из состояния и из потока. Дисциплина «не читать» держится не
 * уговором, а типом: презентационная поверхность шины не отдаёт вовсе, и
 * потребителю нечего прочитать по невнимательности.
 */
export type PresentedState = Omit<Snapshot, 'events'>;

export interface InterpolationSample {
  readonly from: PresentedState;
  readonly to: PresentedState;
  /** Доля между `from` и `to`, `[0, 1]`. */
  readonly alpha: number;
  /** Насколько отображаемый момент отстаёт от последнего пришедшего снапшота, мс. */
  readonly lagMs: number;
}

export const DEFAULT_DELAY_MS = 100;
const DEFAULT_CAPACITY = 30;

interface Received {
  readonly snapshot: Snapshot;
  readonly atMs: number;
}

export class InterpolationBuffer {
  private readonly received: Received[] = [];
  private readonly delayMs: number;
  private readonly capacity: number;

  constructor(options: InterpolationOptions = {}) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  get length(): number {
    return this.received.length;
  }

  /** Последнее пришедшее состояние в презентационной проекции (см. `PresentedState`). */
  get latest(): PresentedState | undefined {
    return this.received[this.received.length - 1]?.snapshot;
  }

  /**
   * Кладёт снапшот в буфер по возрастанию тика. Приход не по порядку —
   * штатный случай на неупорядоченном канале (NTR-2), поэтому место
   * определяется вставкой, а не предположением «пришёл — значит последний».
   */
  push(snapshot: Snapshot, atMs: number): void {
    let at = this.received.length;
    while (at > 0 && this.received[at - 1]!.snapshot.tick > snapshot.tick) at--;
    this.received.splice(at, 0, { snapshot, atMs });
    while (this.received.length > this.capacity) this.received.shift();
  }

  /**
   * Сброс буфера на смене эпохи (NTR-10): накопленные состояния прежней эпохи
   * стёрты вместе с ней, интерполировать между ветвями истории нечем, и
   * промежуточных положений между ними не существовало.
   *
   * Отсюда же берётся snap: после сброса в буфере одно состояние, и первый же
   * `sample` отдаёт `from === to` с нулевой альфой — «проезда» к перемотанному
   * положению не происходит. Сброс обязателен ещё и потому, что порядок здесь
   * держится тиком: без него состояние прежней эпохи с большим номером тика
   * так и осталось бы `latest`, и перемотанный мир не показался бы вовсе.
   */
  reset(): void {
    this.received.length = 0;
  }

  /** Пара снапшотов, между которыми лежит отображаемый момент, и доля между ними. */
  sample(nowMs: number): InterpolationSample | undefined {
    if (this.received.length === 0) return undefined;
    const target = nowMs - this.delayMs;
    const newest = this.received[this.received.length - 1]!;

    if (this.received.length === 1 || target <= this.received[0]!.atMs) {
      const only = this.received[0]!;
      return { from: only.snapshot, to: only.snapshot, alpha: 0, lagMs: newest.atMs - only.atMs };
    }

    for (let i = this.received.length - 1; i > 0; i--) {
      const to = this.received[i]!;
      const from = this.received[i - 1]!;
      if (target >= from.atMs && target <= to.atMs) {
        const span = to.atMs - from.atMs;
        const alpha = span === 0 ? 0 : (target - from.atMs) / span;
        return { from: from.snapshot, to: to.snapshot, alpha, lagMs: newest.atMs - target };
      }
    }

    // Отображаемый момент обогнал буфер: показываем последнее известное и не
    // экстраполируем. Экстраполяция чужих сущностей запрещена (NET-2), а в
    // туман — тем более (NET-3).
    return { from: newest.snapshot, to: newest.snapshot, alpha: 0, lagMs: newest.atMs - target };
  }
}

/**
 * Сущности, бывшие в `from` и отсутствующие в `to`. Для рендера это список на
 * плавное гашение: отсутствие означает «ушла в туман», а не смерть (NET-14) —
 * смерть приезжает явным событием, и различать эти случаи обязан клиент.
 */
export function vanishedEntities(from: PresentedState, to: PresentedState): EntityId[] {
  const gone: EntityId[] = [];
  for (const entity of coreWorld.listAlive(from.world)) {
    if (!coreWorld.isAlive(to.world, entity)) gone.push(entity);
  }
  return gone;
}
