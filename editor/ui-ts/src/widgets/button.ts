/**
 * Кнопка в трёх вариантах: primary, secondary, ghost.
 *
 * Вариантов ровно три, потому что ролей ровно три: одно главное действие на
 * контекст (акцент — ED-22), обычные действия в рамке и служебные без рамки.
 * Четвёртый вариант появился бы как «такой же, но другого цвета» — и это уже
 * второй акцент, которого ED-22 не допускает.
 *
 * Недоступность выражается `aria-disabled`, а не атрибутом `disabled`: ED-26
 * требует видимой недоступности операции, а не молчаливого несрабатывания, и
 * элемент с `aria-disabled` остаётся достижимым с клавиатуры и объявляемым
 * скринридером, тогда как `disabled` выпадает из обхода вовсе.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonSpec {
  readonly label: UiText;
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}

export function button(spec: ButtonSpec): UiNode {
  const variant = spec.variant ?? 'secondary';
  const disabled = spec.disabled === true;
  return el('button', {
    classes: ['fx-button', `fx-button--${variant}`],
    attrs: { type: 'button', 'aria-disabled': String(disabled) },
    children: children(
      spec.icon === undefined ? undefined : icon({ name: spec.icon }),
      el('span', { text: spec.label }),
    ),
    on:
      spec.onPress === undefined || disabled
        ? undefined
        : {
            click: () => {
              spec.onPress?.();
            },
          },
  });
}
