/**
 * Иконки — встроенным SVG, без пакета иконок: ноль новых зависимостей.
 *
 * Набор ровно такой, какой потребляют виджеты этого пакета и следующие задачи
 * каркаса. Иконка без потребителя — мёртвый вес, и её здесь нет.
 *
 * Геометрия задана путями в сетке 12×12 и хранится данными, а не разметкой,
 * по причине из ED-22: состояния валидации обязаны различаться формой, и
 * «формы различны» — это утверждение о `ICONS`, которое тест проверяет
 * сравнением, а не разглядыванием картинки.
 */
import { el, type UiNode } from '../dom/node.js';

export type IconName =
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'close'
  | 'error'
  | 'warning'
  | 'info'
  | 'hint'
  | 'search'
  | 'play'
  | 'dot';

export interface IconGeometry {
  /** Пути в системе координат 12×12. */
  readonly paths: readonly string[];
  /** Заливка вместо обводки — для сплошных знаков вроде «пуска». */
  readonly filled?: boolean;
}

const CIRCLE = 'M1.5 6a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0';

export const ICONS: Readonly<Record<IconName, IconGeometry>> = {
  'chevron-right': { paths: ['M4.5 2.5 L8 6 L4.5 9.5'] },
  'chevron-down': { paths: ['M2.5 4.5 L6 8 L9.5 4.5'] },
  check: { paths: ['M2.5 6.5 L5 9 L9.5 3.5'] },
  close: { paths: ['M3 3 L9 9', 'M9 3 L3 9'] },
  // Ошибка — крест в круге: замкнутая форма с пересечением.
  error: { paths: [CIRCLE, 'M4.2 4.2 L7.8 7.8', 'M7.8 4.2 L4.2 7.8'] },
  // Предупреждение — треугольник: у формы есть верх, и он один.
  warning: { paths: ['M6 1.4 L11 10.4 L1 10.4 Z', 'M6 4.6 V7.2', 'M6 8.9 V9.0'] },
  // Сведение — круг с вертикальным штрихом снизу и точкой сверху.
  info: { paths: [CIRCLE, 'M6 5.9 V8.6', 'M6 3.6 V3.7'] },
  hint: { paths: [CIRCLE, 'M4.6 4.7a1.45 1.45 0 1 1 1.4 1.9 V7.2', 'M6 8.7 V8.8'] },
  search: { paths: ['M1.8 5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0', 'M7.4 7.4 L10.4 10.4'] },
  play: { paths: ['M3.8 2.4 L9.6 6 L3.8 9.6 Z'], filled: true },
  dot: { paths: ['M3.6 6a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0'], filled: true },
};

export interface IconSpec {
  readonly name: IconName;
  /** `lg` — там, где иконка стоит вместо кнопки, а не рядом с текстом. */
  readonly size?: 'md' | 'lg';
}

/**
 * Иконка как узел. Имя проставляется в `data-icon`: по нему структурный тест
 * отличает форму от формы, не зная ничего о путях.
 */
export function icon(spec: IconSpec): UiNode {
  const geometry = ICONS[spec.name];
  return el('svg', {
    ns: 'svg',
    classes: ['fx-icon', ...(spec.size === 'lg' ? ['fx-icon--lg'] : [])],
    attrs: { viewBox: '0 0 12 12', 'data-icon': spec.name, 'aria-hidden': 'true', focusable: 'false' },
    children: geometry.paths.map((d) =>
      el('path', {
        classes: [geometry.filled === true ? 'fx-icon__fill' : 'fx-icon__stroke'],
        attrs: { d },
      }),
    ),
  });
}
