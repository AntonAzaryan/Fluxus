/**
 * Roving-фокус: в списке из сотни строк ровно одна достижима клавишей Tab, а
 * между строками ходят стрелками.
 *
 * Заведено здесь, в общем словаре описания узлов, а не в каркасе и не в
 * виджетах: roving-контейнером является и рельс областей (каркас), и дерево
 * навигатора (виджет), и правило у них одно. Дважды написанное правило обхода
 * разъезжается ровно в тот момент, когда его правят в одном месте.
 *
 * Контейнер помечает себя `data-roving` с собственным идентификатором. Пометка
 * нужна не стилям: интерфейс перерисовывается целиком, и после перерисовки
 * фокус надо вернуть туда, где он был, — по этой пометке его и находит
 * `frame/mount.ts`. Без неё каждая правка поля выбрасывала бы автора в начало
 * страницы.
 */

/** Атрибут, которым контейнер объявляет себя roving-контейнером. */
export const ROVING_ATTR = 'data-roving';

/** Машинные атрибуты контейнера. */
export function rovingContainer(id: string): Readonly<Record<string, string>> {
  return { [ROVING_ATTR]: id };
}

/**
 * Машинные атрибуты элемента внутри контейнера. Держащий фокус — единственная
 * остановка Tab; остальные достижимы только стрелками.
 */
export function rovingItem(active: boolean): Readonly<Record<string, string>> {
  return { tabindex: active ? '0' : '-1' };
}

/**
 * Куда переходит фокус по клавише. `undefined` — клавиша не про перемещение,
 * и обработчик обязан оставить её вызывающему: перехваченная и ничего не
 * сделавшая клавиша хуже неперехваченной.
 */
export function rovingTarget(key: string, index: number, length: number): number | undefined {
  if (length === 0) return undefined;
  const clamp = (value: number): number => Math.min(Math.max(value, 0), length - 1);
  switch (key) {
    case 'ArrowDown':
      return clamp(index + 1);
    case 'ArrowUp':
      return clamp(index - 1);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return undefined;
  }
}
