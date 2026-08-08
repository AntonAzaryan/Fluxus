/**
 * Выделение — сквозное (ED-23): «Выделение, история операций (ED-18) и поиск
 * по проекту SHALL быть сквозными для всех областей».
 *
 * Модель одна на сессию, а запись в ней — на область. Это не противоречие, а
 * прочтение обоих предложений ED-23 сразу: механизм выделения один (внешний
 * потребитель — палитра команд, отчёт валидации, поиск по проекту — выделяет
 * что угодно и где угодно, не спрашивая, какая область сейчас на экране), а
 * то, что было выделено в области, автор находит на месте, вернувшись в неё.
 * Второй модели «выделение внутри области» не существует: она разошлась бы с
 * первой ровно там, где выделение ставит не пользователь.
 *
 * Ссылка на выделенное — непрозрачная строка. Каркас не разбирает её и не
 * ветвится по ней: что ею адресовано — запись расстановки, узел дерева, ассет
 * — знает область, которая её выдала (ED-25).
 */

/** Ссылка на выделенное. Смысл строки принадлежит области, выдавшей её. */
export type SelectionRef = string;

/** Выделение одной области — то, что видит вклад. */
export interface AreaSelection {
  current(): readonly SelectionRef[];
  has(ref: SelectionRef): boolean;
  set(refs: readonly SelectionRef[]): void;
  clear(): void;
}

/** Модель выделения сессии — то, что видит каркас и сквозные потребители. */
export interface SelectionModel {
  /** Выделение области, адресуемое снаружи: областью быть для этого не нужно. */
  get(areaId: string): readonly SelectionRef[];
  set(areaId: string, refs: readonly SelectionRef[]): void;
  /** Сужение модели до одной области — то, что уходит во вклад. */
  in(areaId: string): AreaSelection;
  subscribe(listener: () => void): () => void;
}

const EMPTY: readonly SelectionRef[] = Object.freeze([]);

export function createSelectionModel(): SelectionModel {
  const byArea = new Map<string, readonly SelectionRef[]>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const model: SelectionModel = {
    get: (areaId) => byArea.get(areaId) ?? EMPTY,
    set(areaId, refs) {
      // Копия, а не сама ссылка: массив приходит из чужих рук, и дописанный в
      // него позже элемент менял бы выделение задним числом, никого не оповестив.
      byArea.set(areaId, Object.freeze([...refs]));
      notify();
    },
    in: (areaId) => ({
      current: () => model.get(areaId),
      has: (ref) => model.get(areaId).includes(ref),
      set: (refs) => {
        model.set(areaId, refs);
      },
      clear: () => {
        model.set(areaId, []);
      },
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return model;
}
