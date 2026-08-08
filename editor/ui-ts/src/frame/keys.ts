/**
 * Сочетания клавиш каркаса: переключение областей горячей клавишей (ED-23) и
 * сквозные undo/redo (ED-18).
 *
 * Сочетание описано строкой (`F2`, `Ctrl+Z`, `Ctrl+Shift+Z`), потому что
 * горячую клавишу объявляет вклад области, а вклад — данные, не код каркаса
 * (ED-25). Реестр вкладов уже следит, чтобы двое не претендовали на одну
 * клавишу, поэтому здесь только разбор и сравнение.
 *
 * `Meta` приравнена к `Ctrl`: одно и то же сочетание на макоси нажимается
 * другой клавишей, а вклад, объявляющий два варианта одного сочетания, занял
 * бы в реестре два ресурса вместо одного.
 */

/** Нажатие в виде, не зависящем от того, есть ли в прогоне DOM. */
export interface KeyStroke {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export function keyStrokeOf(event: KeyboardEvent): KeyStroke {
  return {
    key: event.key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** Сочетание, отменяющее последнюю операцию сессии (ED-18). */
export const UNDO_BINDING = 'Ctrl+Z';

/** Сочетание, повторяющее отменённое. */
export const REDO_BINDING = 'Ctrl+Shift+Z';

/** Возврат фокуса к рельсу и отказ от начатого. */
export const DISMISS_KEY = 'Escape';

/**
 * Канонические имена модификаторов — так же, как они пишутся в самих
 * сочетаниях. Порядок здесь и есть порядок в канонической записи: сравнение
 * идёт строками, а не тремя условиями, поэтому `Shift+Ctrl+Z` и `Ctrl+Shift+Z`
 * — одно и то же сочетание, а не два похожих.
 */
const MODIFIERS: readonly string[] = ['Ctrl', 'Shift', 'Alt'];

function canonical(parts: readonly string[]): string {
  const lower = parts.map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
  const key = lower.at(-1) ?? '';
  const used = new Set(lower.slice(0, -1));
  const ordered = MODIFIERS.filter((modifier) => used.has(modifier.toLowerCase()));
  return [...ordered, key].join('+').toLowerCase();
}

/** Нажатие в канонической записи сочетания — то, с чем сравнивается объявленное. */
export function bindingOf(stroke: KeyStroke): string {
  const [ctrl, shift, alt] = MODIFIERS;
  return canonical([
    ...(stroke.ctrl && ctrl !== undefined ? [ctrl] : []),
    ...(stroke.shift && shift !== undefined ? [shift] : []),
    ...(stroke.alt && alt !== undefined ? [alt] : []),
    stroke.key,
  ]);
}

export function matchesBinding(stroke: KeyStroke, binding: string): boolean {
  const declared = canonical(binding.split('+'));
  return declared !== '' && declared === bindingOf(stroke);
}
