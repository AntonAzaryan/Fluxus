/**
 * Контракты наведения вьюпорта (REND-15): точка экрана, мировой луч и
 * попадание, в которое он разрешается.
 *
 * Отдельным модулем, потому что их разделяют ДВЕ стороны сервиса: сам сервис
 * (`picking.ts`) и марш по полю высот (`surfaceMarch.ts`), пишущий в ту же
 * запись попадания. Запись одна и переиспользуемая — копии на кадр наведения не
 * заводится; поэтому и форма её описана в одном месте, а не в каждом из них.
 *
 * Всё здесь — float (REND-1): за входной границей рендера fixed-point не
 * существует, а индекс клетки — целое число сетки, не Q16.16-величина.
 */
import type { EntityId } from '@fluxus/core';

/**
 * Точка вьюпорта: положение указателя относительно левого верхнего угла
 * прямоугольника и его размеры, пиксели. Прямоугольник — вход луча наравне с
 * позой: без него неизвестно соотношение сторон (REND-15).
 */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Мировой луч picking'а; направление единичное. */
export interface PickRay {
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
}

export function createPickRay(): PickRay {
  return { originX: 0, originY: 0, originZ: 0, dirX: 0, dirY: 0, dirZ: 0 };
}

/** Во что разрешился курсор (REND-15). */
export type PickKind = 'handle' | 'entity' | 'surface';

/**
 * Попадание. Объект переиспользуется сервисом и валиден до следующего запроса —
 * потребитель, которому нужно пережить кадр, копирует нужные поля.
 */
export interface PickHit {
  readonly kind: PickKind;
  /** Ручка наложения; null — попадание не в ручку. */
  readonly handle: string | null;
  /** Сущность presentation-состояния; 0 — попадание не в объект. Ключ документа даёт `DocumentSource.keyOf` (REND-11). */
  readonly entity: EntityId;
  /**
   * Попадание пришлось на decoration-инстанс (REND-18): ключ документа тогда
   * даёт `DecorationSet.keyOf`, а не документный источник, — наборы разные, и
   * нумерация у них своя.
   */
  readonly decoration: boolean;
  /** Расстояние по лучу от точки наблюдения, мировые единицы. */
  readonly distance: number;
  /** Мировая точка попадания, float (REND-1). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Индекс клетки сетки; -1 — попадание не в поверхность. Целое число сетки, не fixed-point. */
  readonly cell: number;
  readonly cellX: number;
  readonly cellY: number;
  /** В клетке нет пола (REND-7): дыра, но клетка — кисть пола ED-10 в неё попадает. */
  readonly noFloor: boolean;
  /** Попадание пришлось на вертикальную стенку обрыва; клетка — верхняя (REND-7). */
  readonly wall: boolean;
}

/**
 * Внутренняя мутабельная форма `PickHit` — ТОТ ЖЕ набор полей со снятой
 * `readonly`, выведенный из него, а не переписанный: второй список полей
 * разошёлся бы с первым молча, и новое поле попадания появлялось бы в
 * контракте, не доезжая до того, кто его пишет.
 */
export type MutablePickHit = { -readonly [K in keyof PickHit]: PickHit[K] };
