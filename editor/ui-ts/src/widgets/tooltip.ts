/**
 * Подсказка — всплывающая карточка над всем остальным.
 *
 * Показывает описание поля (ED-28) и, когда описания нет, сам ключ ресурса:
 * пустая подсказка прячет пробел в ресурсах, показанный ключ — нет. Поэтому
 * `body` обязателен, а `code` (ключ описания моноширным) — отдельное поле, а
 * не часть текста: по нему видно, о каком ресурсе речь, не гадая.
 *
 * Позиционированием подсказка не занимается: где ей встать относительно
 * якоря — дело того, кто её показывает, и зависит от области. Виджет — только
 * поверхность наложения.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';

export interface TooltipSpec {
  /** Заголовок — обычно путь поля, то есть идентификатор документа. */
  readonly title?: UiText;
  readonly body: UiText;
  /** Ключ ресурса описания — диагностика ED-28, а не текст для чтения. */
  readonly code?: UiText;
}

export function tooltip(spec: TooltipSpec): UiNode {
  return el('div', {
    classes: ['fx-tooltip'],
    attrs: { role: 'tooltip' },
    children: children(
      spec.title === undefined
        ? undefined
        : el('span', { classes: ['fx-tooltip__title'], text: spec.title }),
      el('span', { classes: ['fx-tooltip__body'], text: spec.body }),
      spec.code === undefined
        ? undefined
        : el('span', { classes: ['fx-tooltip__code'], text: spec.code }),
    ),
  });
}
