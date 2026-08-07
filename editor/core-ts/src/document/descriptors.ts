/**
 * Сессионный дескриптор — адрес записи списка, переживающий правку соседей
 * (ED-29: «адресация, ломающаяся от вставки или удаления соседа, непригодна
 * для последовательного применения операций»).
 *
 * Решение принято в `editor-ui-shell/design.md`, раздел «Адресация
 * размещённого — сессионный дескриптор», и здесь только исполняется:
 *
 * - не индекс — индекс едет от удаления соседа, и операция, собранная по
 *   прочитанному списку, попадает не туда;
 * - не устойчивый ID в самом документе — это изменение формата ради нужд
 *   инструмента: SER-8 такого поля не знает, симуляции оно не значит ничего, и
 *   в файле ему делать нечего.
 *
 * Дескриптор выдаётся при открытии документа, живёт в памяти сессии и на диск
 * не попадает. Область его жизни — сессия, и машинный каталог (ED-30) обязан
 * говорить об этом явно: `DESCRIPTOR_SCOPE` существует, чтобы каталог брал
 * этот факт отсюда, а не описывал его вторым текстом.
 *
 * Каркас не знает, какие именно списки адресуются дескрипторами: пути
 * отслеживаемых списков приносит тот, кто открывает документ (ED-25 — доменных
 * имён в каркасе быть не должно). Для конфига сцены это `initial` (SER-7).
 */
import { pathKey, type JsonPath } from './json.js';

/**
 * Непрозрачная строка. Марка типа не косметическая: она не даёт собрать
 * дескриптор из индекса или имени — единственный источник значения — сессия.
 */
export type DescriptorId = string & { readonly __editorDescriptor: unique symbol };

/**
 * Имя области жизни дескриптора — одно на пакет. В каталоге ED-30 сессионность
 * объявлена признаком параметра (`sessionScoped`, он же `SESSION_SCOPED_TYPES`
 * слоя операций), а эта константа — то, чем оба слоя называют одну и ту же
 * область: разойтись в названии им негде.
 */
export const DESCRIPTOR_SCOPE = 'session';

/** Таблица одного документа: ключ пути списка → дескрипторы записей по порядку. */
export type DescriptorTable = ReadonlyMap<string, readonly DescriptorId[]>;

/** Где сейчас лежит запись: путь её списка и индекс в нём на текущий момент. */
export interface DescriptorLocation {
  readonly list: JsonPath;
  readonly index: number;
  /** Полный путь записи в документе — `[...list, index]`. */
  readonly path: JsonPath;
}

/** Счётчик сессии: монотонный, значения не переиспользуются даже после undo. */
export class DescriptorMinter {
  #next = 1;

  mint(): DescriptorId {
    // Префикс отличает дескриптор от чего угодно ещё в отладочном выводе и
    // делает очевидным, что это не путь и не имя из документа.
    return `sd:${this.#next++}` as DescriptorId;
  }

  /** Партия дескрипторов на уже существующий список — по одному на запись. */
  mintFor(count: number): readonly DescriptorId[] {
    const ids: DescriptorId[] = [];
    for (let i = 0; i < count; i++) ids.push(this.mint());
    return Object.freeze(ids);
  }
}

/** Ищет дескриптор во всех отслеживаемых списках документа. */
export function locateDescriptor(
  table: DescriptorTable,
  lists: readonly JsonPath[],
  descriptor: string,
): DescriptorLocation | undefined {
  for (const list of lists) {
    const ids = table.get(pathKey(list));
    if (ids === undefined) continue;
    const index = ids.indexOf(descriptor as DescriptorId);
    if (index >= 0) return { list, index, path: [...list, index] };
  }
  return undefined;
}
