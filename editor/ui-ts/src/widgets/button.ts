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
 *
 * ## Кнопка-знак
 *
 * Инструмент бара опознаётся знаком, а не подписью (ED-31), поэтому у кнопки
 * есть режим «только знак». Имя и подсказка в нём обязательны, и обязательны
 * ТИПОМ, а не договорённостью: элемента, чьё имя существует только картинкой,
 * ED-31 не допускает — знак без имени недоступен ни обходу с клавиатуры, ни
 * автору, который этот знак не узнал. Оба текста при этом остаются `UiText`,
 * то есть приходят ресурсами и попадают в учёт ED-27.
 *
 * Состояние переключателя объявляется `aria-pressed`, а не подменой подписи:
 * по подписи, меняющейся между текущим режимом и результатом нажатия,
 * невозможно определить, что она сообщает (ED-31). Акцент нажатого состояния —
 * тот же самый «включённый переключатель», за которым его закрепил ED-22, а не
 * второй акцент.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonCommon {
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  /**
   * Включённость переключателя. `undefined` — элемент не переключатель, и
   * `aria-pressed` у него не появляется вовсе: «не нажат» и «не переключатель»
   * — разные утверждения, и объявлять второе первым значило бы врать обходу.
   */
  readonly pressed?: boolean;
  /** Подсказка среды. У кнопки с горячей клавишей она её и называет (ED-31). */
  readonly title?: UiText;
}

/** Кнопка с видимой подписью; знак рядом с ней необязателен. */
export interface LabelledButtonSpec extends ButtonCommon {
  readonly label: UiText;
  readonly icon?: IconName;
}

/** Кнопка-знак: подписи не видно, поэтому имя и подсказка обязательны (ED-31). */
export interface IconButtonSpec extends ButtonCommon {
  readonly icon: IconName;
  /** Доступное имя — то, что объявляет обход клавиатурой. */
  readonly name: UiText;
  readonly title: UiText;
}

export type ButtonSpec = LabelledButtonSpec | IconButtonSpec;

export function button(spec: ButtonSpec): UiNode {
  const variant = spec.variant ?? 'secondary';
  const disabled = spec.disabled === true;
  const labelled = 'label' in spec;
  return el('button', {
    classes: ['fx-button', `fx-button--${variant}`, ...(labelled ? [] : ['fx-button--icon'])],
    attrs: {
      type: 'button',
      'aria-disabled': String(disabled),
      ...(spec.pressed === undefined ? {} : { 'aria-pressed': String(spec.pressed) }),
    },
    labels: {
      ...(labelled ? {} : { ariaLabel: spec.name }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
    },
    children: children(
      spec.icon === undefined ? undefined : icon({ name: spec.icon }),
      labelled ? el('span', { text: spec.label }) : undefined,
    ),
    ...(spec.onPress === undefined || disabled
      ? {}
      : {
          on: {
            click: () => {
              spec.onPress?.();
            },
          },
        }),
  });
}
