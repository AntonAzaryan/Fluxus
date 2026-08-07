/**
 * Состояния валидации (ED-8) в виде, который ED-22 требует: различимые
 * иконкой, положением и текстом причины, а не только оттенком.
 *
 * Различие сделано структурным, а не дисциплинарным. Причина у состояния —
 * обязательное поле типа, поэтому «показать ошибку без объяснения» не
 * компилируется. Класс строгости на контроле и блок с иконкой и причиной
 * ставит одна функция `withValidation`, поэтому «покрасить рамку красным и
 * забыть сообщение» невозможно физически: красит и объясняет один вызов.
 *
 * Ни одно правило таблицы стилей, относящееся к валидации, не читает акцентных
 * токенов, и наоборот (`test/visualLanguage.test.ts`). Это ответ на сценарий
 * ED-22 «акцент для предупреждения»: совпадение сигналов сделало бы оба
 * нечитаемыми, а красный ошибки и лавовый акцент и так лежат в одном секторе
 * спектра.
 */
import { el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationState {
  readonly severity: ValidationSeverity;
  /**
   * Причина — то, что ED-8 отдаёт структурой (правило, путь, значение,
   * ожидание) и что интерфейс показывает человеком читаемой строкой.
   * Необязательной она быть не может: без неё остаётся один цвет.
   */
  readonly reason: UiText;
}

/** Иконка на строгость — формы различны, и различие проверяется тестом. */
export const SEVERITY_ICONS: Readonly<Record<ValidationSeverity, IconName>> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** Префикс класса, который получает контрол с нарушением. */
export const INVALID_CLASS_PREFIX = 'fx-invalid--';

/** Класс блока с иконкой и причиной. */
export const VALIDATION_CLASS = 'fx-validation';

/**
 * Блок «иконка + причина». Из модуля не выходит намеренно: доступна только
 * `withValidation`, которая ставит его вместе с классом строгости, и
 * разъединить их вызывающему нечем — ни снаружи пакета, ни изнутри.
 */
function validationMark(state: ValidationState): UiNode {
  return el('div', {
    classes: [VALIDATION_CLASS, `${VALIDATION_CLASS}--${state.severity}`],
    attrs: { role: 'status', 'data-severity': state.severity },
    children: [
      icon({ name: SEVERITY_ICONS[state.severity] }),
      el('span', { classes: [`${VALIDATION_CLASS}__reason`], text: state.reason }),
    ],
  });
}

/**
 * Навешивает состояние валидации на узел: класс строгости — самому узлу, блок
 * с иконкой и причиной — последним ребёнком. Без состояния возвращает узел как
 * есть, поэтому вызов безусловен и ветвления у виджетов нет.
 *
 * Положение сообщения задаётся не здесь, а таблицей стилей по контексту: под
 * контролом в таблице полей, в хвосте строки в дереве и списке. Виджету
 * достаточно вложенности — по ней тест и проверяет инвариант «класс строгости
 * есть ⇒ внутри есть иконка и причина».
 */
export function withValidation(node: UiNode, state: ValidationState | undefined): UiNode {
  if (state === undefined) return node;
  // Тип требует причину, но пустую строку тип пропускает, а пустая причина —
  // это ровно тот «различимый только оттенком» случай, который ED-22 и
  // запрещает. Дешевле упасть здесь, чем показать красную рамку без объяснения.
  if (state.reason.value.trim() === '') {
    throw new Error(`editor-ui: состояние ${state.severity} без текста причины`);
  }
  return {
    ...node,
    classes: [...(node.classes ?? []), `${INVALID_CLASS_PREFIX}${state.severity}`],
    children: [...(node.children ?? []), validationMark(state)],
  };
}
