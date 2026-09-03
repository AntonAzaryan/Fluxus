/**
 * Зеркало ПОСЛЕДНЕГО ДОСТАВЛЕННОГО кадра (`client-shell` SHELL-3, change
 * `delivery-interpolation-and-dirty-extract`, design D4).
 *
 * Плоская форма раньше несла полное состояние на тик: четырнадцать колонок ×
 * каждая живая сущность независимо от того, двигалась она или стояла. Зеркало
 * отвечает на единственный вопрос, который делает кадр частичным: «отличается
 * ли строка от той, что у приёмника уже есть».
 *
 * Почему сравнение, а не dirty-множества ядра (OBS-4): множества знают про
 * КОМПОНЕНТЫ, а строка кадра несёт производные — визуальный тип из тегов, фазу
 * манёвра из конфигурации, курс из скорости, статы сборки. Часть из них
 * меняется без записи в компонент (курс остановившегося — `NaN`), часть — при
 * записи того же значения. Сравнение отвечает ровно на вопрос канала.
 *
 * Зеркало двигает ФАКТ ДОСТАВКИ (`commit`), а не факт извлечения: кадр, не
 * уехавший из-за занятого пула буферов (SHELL-4), зеркала не трогает, и на
 * следующем тике та же строка снова отличается. Накопителя «изменившихся с
 * прошлой отправки» поэтому не существует — отличие от зеркала И ЕСТЬ
 * накопленная разница.
 *
 * Ёмкость растёт вместе со сценой и переиспользуется между тиками: это
 * долгоживущий буфер пути извлечения, который REND-26 разрешает явно.
 */
import type { EntityId } from '@fluxus/core';
import { CHANNEL_LAYOUT, channelColumns, type ChannelArrayValue } from './channelLayout.js';

/**
 * Колонки кадра и его разреженная секция статов глазами зеркала — ровно то,
 * что оно сравнивает и копирует. Форма совпадает с `ExtractedTick`, но зеркало
 * не знает ни о тике, ни о режиме, ни о событиях: его дело — строки.
 */
export interface MirroredFrame {
  readonly count: number;
  readonly statCount: Uint8Array;
  readonly statIndex: Int32Array;
  readonly statValue: Float64Array;
  readonly id: Float64Array;
}

/**
 * Равенство значений колонки. `NaN` равен `NaN` НАМЕРЕННО: им плоская форма
 * выражает «значения нет» — стоящая сущность приносит `NaN` в курсе, не летящая
 * — в фазе полёта, и сравнение по `!==` объявляло бы их изменившимися каждый
 * тик, то есть ровно те строки, ради которых частичный кадр и заводится.
 */
function same(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

export class FrameMirror {
  /** Слот сущности в зеркале; отсутствие — сущность приёмнику неизвестна. */
  private readonly slotOf = new Map<EntityId, number>();
  /** Освободившиеся слоты: смерть сущности не двигает ёмкость зеркала. */
  private readonly free: number[] = [];
  private next = 0;
  private capacity = 0;
  private columns: Record<string, ChannelArrayValue> = channelColumns(0);
  private statCount = new Uint8Array(0);
  private statIndex = new Int32Array(0);
  private statValue = new Float64Array(0);
  private readonly statSize: number;

  constructor(statSize: number) {
    this.statSize = statSize;
  }

  /** Сущностей в зеркале; ноль — приёмнику не известно ничего (полный кадр). */
  get size(): number {
    return this.slotOf.size;
  }

  /** Идентификаторы, известные приёмнику, — вход поиска исчезнувших. */
  ids(): IterableIterator<EntityId> {
    return this.slotOf.keys();
  }

  /** Знает ли приёмник эту сущность (иначе строка едет как появившаяся). */
  has(entity: EntityId): boolean {
    return this.slotOf.has(entity);
  }

  /** Приёмник не знает ничего: разрыв непрерывности, смена ветви, начало сессии. */
  clear(): void {
    this.slotOf.clear();
    this.free.length = 0;
    this.next = 0;
  }

  /**
   * Отличается ли строка `row` кадра от того, что у приёмника уже есть.
   * Сущность вне зеркала отличается заведомо: она для приёмника появилась.
   * `statAt` — начало её пар в разреженной секции кадра.
   */
  differs(frame: MirroredFrame, row: number, entity: EntityId, statAt: number): boolean {
    const slot = this.slotOf.get(entity);
    if (slot === undefined) return true;
    const columns = frame as unknown as Record<string, ChannelArrayValue>;
    for (const column of CHANNEL_LAYOUT) {
      const mirrored = this.columns[column.name]!;
      const fresh = columns[column.name]!;
      if (!same(mirrored[slot]!, fresh[row]!)) return true;
    }
    const count = frame.statCount[row]!;
    if (this.statCount[slot] !== count) return true;
    const base = slot * this.statSize;
    for (let k = 0; k < count; k++) {
      if (this.statIndex[base + k] !== frame.statIndex[statAt + k]) return true;
      if (!same(this.statValue[base + k]!, frame.statValue[statAt + k]!)) return true;
    }
    return false;
  }

  /**
   * Кадр ДОСТАВЛЕН: его строки становятся тем, что приёмник знает, а
   * перечисленные исчезнувшие — забываются. Строки, которых в кадре нет, в
   * зеркале уже совпадают с ним по построению (иначе они бы в него попали).
   */
  commit(frame: MirroredFrame, removed: Float64Array, removedCount: number): void {
    for (let i = 0; i < removedCount; i++) {
      const entity = removed[i]!;
      const slot = this.slotOf.get(entity);
      if (slot === undefined) continue;
      this.slotOf.delete(entity);
      this.free.push(slot);
    }
    let statAt = 0;
    const columns = frame as unknown as Record<string, ChannelArrayValue>;
    for (let row = 0; row < frame.count; row++) {
      const entity = frame.id[row]!;
      const slot = this.slotOf.get(entity) ?? this.allocate(entity);
      for (const column of CHANNEL_LAYOUT) {
        this.columns[column.name]![slot] = columns[column.name]![row]!;
      }
      const count = frame.statCount[row]!;
      this.statCount[slot] = count;
      const base = slot * this.statSize;
      for (let k = 0; k < count; k++) {
        this.statIndex[base + k] = frame.statIndex[statAt + k]!;
        this.statValue[base + k] = frame.statValue[statAt + k]!;
      }
      statAt += count;
    }
  }

  /** Слот под новую сущность: из освободившихся либо ростом ёмкости. */
  private allocate(entity: EntityId): number {
    const reused = this.free.pop();
    const slot = reused ?? this.next++;
    if (slot >= this.capacity) this.grow(slot + 1);
    this.slotOf.set(entity, slot);
    return slot;
  }

  /**
   * Рост ёмкости — с запасом ×1.5, как у колонок кадра: событие изменения
   * состава сцены, а не тик (REND-26). Прежние значения переносятся: слоты
   * живых сущностей от перевыделения не меняются.
   */
  private grow(needed: number): void {
    const capacity = Math.max(16, Math.ceil(needed * 1.5));
    const grown = channelColumns(capacity);
    for (const column of CHANNEL_LAYOUT) {
      const target = grown[column.name]!;
      const source = this.columns[column.name]!;
      // Поэлементно, а не `set`: колонки таблицы — союз четырёх ширин, и общего
      // типа у пары «источник, приёмник» нет. Рост редок — событие сцены.
      for (let i = 0; i < this.capacity; i++) target[i] = source[i]!;
    }
    this.columns = grown;
    const statCount = new Uint8Array(capacity);
    statCount.set(this.statCount);
    this.statCount = statCount;
    const statIndex = new Int32Array(capacity * this.statSize);
    statIndex.set(this.statIndex);
    this.statIndex = statIndex;
    const statValue = new Float64Array(capacity * this.statSize);
    statValue.set(this.statValue);
    this.statValue = statValue;
    this.capacity = capacity;
  }
}
