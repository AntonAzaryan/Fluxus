/**
 * Контролы полей — текстовое, числовое, выпадающий список, переключатель:
 * то, из чего собирается инспектор (ED-24) и что регистрируют вкладами
 * редакторы полей (ED-25). Лежат вместе, потому что делят одну оболочку
 * `.fx-control` и один способ нести состояние валидации.
 *
 * Числовое поле отличается от текстового не типом ввода, а показом: моноширные
 * цифры и выравнивание вправо, чтобы в столбце из сорока значений разряды
 * стояли под разрядами. Тип `number` у `<input>` при этом не ставится
 * сознательно — симуляция считает в Q16.16 (ядро, DET), и браузерный
 * нормализатор чисел с плавающей точкой здесь только мешает: значение
 * приходит и уходит строкой, а разбирает её операция авторинга.
 *
 * Граница операции — взаимодействие, а не событие ввода (design change
 * `editor-ui-shell`), поэтому наружу отдаётся `onCommit` по `change`, а не
 * посимвольный `input`.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon } from './icon.js';
import { withValidation, type ValidationState } from './validation.js';

export interface FieldSpec {
  readonly value: UiText;
  /** Подпись для доступности: контрол живёт в таблице, где подпись — соседняя ячейка. */
  readonly label: UiText;
  readonly placeholder?: UiText;
  readonly readOnly?: boolean;
  readonly validation?: ValidationState;
  readonly onCommit?: (raw: string) => void;
}

function control(spec: FieldSpec, extraClasses: readonly string[]): UiNode {
  return el('div', {
    classes: ['fx-control'],
    children: [
      el('input', {
        classes: ['fx-input', ...extraClasses],
        attrs: { type: 'text', ...(spec.readOnly === true ? { readonly: '' } : {}) },
        labels: { ariaLabel: spec.label, placeholder: spec.placeholder, value: spec.value },
        on:
          spec.onCommit === undefined || spec.readOnly === true
            ? undefined
            : {
                change: (event: Event) => {
                  const target = event.target;
                  if (target instanceof HTMLInputElement) spec.onCommit?.(target.value);
                },
              },
      }),
    ],
  });
}

export function textField(spec: FieldSpec): UiNode {
  return withValidation(control(spec, []), spec.validation);
}

export function numberField(spec: FieldSpec): UiNode {
  return withValidation(control(spec, ['fx-input--number']), spec.validation);
}

export interface SelectOption {
  readonly value: string;
  readonly label: UiText;
}

export interface SelectSpec {
  readonly label: UiText;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly validation?: ValidationState;
  readonly onSelect?: (value: string) => void;
}

/**
 * Выпадающий список на нативном `<select>`: клавиатура, поиск по первым
 * буквам и поведение на касание достаются даром, а рисованный список пришлось
 * бы воспроизводить целиком. Своя стрелка — потому что нативную не покрасить.
 */
export function select(spec: SelectSpec): UiNode {
  const disabled = spec.disabled === true;
  return withValidation(
    el('div', {
      classes: ['fx-control'],
      children: [
        el('div', {
          classes: ['fx-select-wrap'],
          children: [
            el('select', {
              classes: ['fx-input', 'fx-select'],
              attrs: { 'aria-disabled': String(disabled), ...(disabled ? { disabled: '' } : {}) },
              labels: { ariaLabel: spec.label },
              children: spec.options.map((option) =>
                el('option', {
                  attrs: {
                    value: option.value,
                    ...(option.value === spec.value ? { selected: '' } : {}),
                  },
                  text: option.label,
                }),
              ),
              on:
                spec.onSelect === undefined || disabled
                  ? undefined
                  : {
                      change: (event: Event) => {
                        const target = event.target;
                        if (target instanceof HTMLSelectElement) spec.onSelect?.(target.value);
                      },
                    },
            }),
            icon({ name: 'chevron-down' }),
          ],
        }),
      ],
    }),
    spec.validation,
  );
}

export interface ToggleSpec {
  readonly label: UiText;
  readonly on: boolean;
  readonly disabled?: boolean;
  readonly validation?: ValidationState;
  readonly onChange?: (next: boolean) => void;
}

/**
 * Переключатель. Включённое состояние — одно из пяти мест, за которыми ED-22
 * закрепил акцент, и единственный признак «включено» здесь не цвет: положение
 * бегунка несёт то же самое.
 *
 * Оболочка `.fx-control` вокруг него не украшение: булево поле нарушает
 * правило схемы ровно так же, как числовое, и без оболочки состоянию
 * валидации некуда встать — а «некуда встать» на практике означает «молча
 * потеряли» (ED-8).
 */
export function toggle(spec: ToggleSpec): UiNode {
  const disabled = spec.disabled === true;
  const switchNode = el('button', {
    classes: ['fx-toggle', ...(spec.on ? ['fx-is-on'] : [])],
    attrs: {
      type: 'button',
      role: 'switch',
      'aria-checked': String(spec.on),
      'aria-disabled': String(disabled),
    },
    labels: { ariaLabel: spec.label },
    children: children(el('span', { classes: ['fx-toggle__knob'] })),
    on:
      spec.onChange === undefined || disabled
        ? undefined
        : {
            click: () => {
              spec.onChange?.(!spec.on);
            },
          },
  });
  return withValidation(
    el('div', { classes: ['fx-control'], children: [switchNode] }),
    spec.validation,
  );
}
