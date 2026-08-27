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

/**
 * Как клавиша раскладки области (ED-32) называется в подсказке. Раскладка
 * объявлена кодами (`KeyboardEvent.code`) — они не зависят ни от языка ввода,
 * ни от локали интерфейса, — а показать автору `KeyF` нельзя. Перевода тут нет
 * и быть не может: имя клавиши — машинная строка, как `F2` у знака области в
 * рельсе, а стрелки названы знаками, одинаковыми во всех локалях.
 */
const ARROWS: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

export function keyLabel(code: string): string {
  const arrow = ARROWS[code];
  if (arrow !== undefined) return arrow;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** Сочетание, отменяющее последнюю операцию сессии (ED-18). */
export const UNDO_BINDING = 'Ctrl+Z';

/** Сочетание, повторяющее отменённое. */
export const REDO_BINDING = 'Ctrl+Shift+Z';

/** Возврат фокуса к рельсу и отказ от начатого. */
export const DISMISS_KEY = 'Escape';

/**
 * Открытие палитры команд (ED-24). Сочетание сквозное, как отмена: палитра —
 * способ добраться до чего угодно из любой области, и область, объявившая это
 * сочетание своим, отобрала бы у автора единственный путь мимо дерева.
 */
export const PALETTE_BINDING = 'Ctrl+P';

/**
 * Цель нажатия в виде, не зависящем от того, есть ли в прогоне DOM: имя тега и
 * признак редактируемого содержимого. Больше о цели порядку разбора знать
 * нечего — виджет, который клавишу потребляет, объявляет это `preventDefault`,
 * а не своим тегом.
 */
export interface KeyTarget {
  readonly tagName?: string;
  readonly editable?: boolean;
}

const TEXT_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Идёт ли сейчас набор текста. Проверяется отдельно от «потреблено»: поле ввода
 * стрелку и букву не потребляет вызовом `preventDefault`, оно просто двигает
 * каретку, — а ED-32 отдаёт набору приоритет над клавишами области.
 */
export function textEntry(target: KeyTarget | null): boolean {
  if (target === null) return false;
  return TEXT_TAGS.has(target.tagName ?? '') || target.editable === true;
}

/** Что порядок разбора (ED-32) знает о нажатии к моменту последней ступени. */
export interface AreaKeyGate {
  /** Потребил ли нажатие виджет, держащий фокус (`widgets/rows.ts`, `dom/roving.ts`). */
  readonly defaultPrevented: boolean;
  readonly target: KeyTarget | null;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/**
 * Последняя ступень порядка ED-32: достаётся ли нажатие активной области.
 * Функция, а не три условия по месту, ровно затем, чтобы порядок был записан
 * один раз и проверялся без DOM: «стрелка в дереве камеру не двигает» — это
 * утверждение о ней, а не о том, куда уехал фокус.
 *
 * Сочетание с модификатором области не достаётся вовсе: оно принадлежит каркасу
 * и командам (ED-18, ED-24), которые разобраны раньше, — иначе `Ctrl+S` попал бы
 * инструменту, объявившему `S`. Shift модификатором в этом смысле не считается:
 * он меняет символ, а не адресата.
 */
export function areaGetsKey(gate: AreaKeyGate): boolean {
  if (gate.defaultPrevented) return false;
  if (gate.ctrl || gate.alt) return false;
  return !textEntry(gate.target);
}

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
function bindingOf(stroke: KeyStroke): string {
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

/** Одно ли это сочетание: сравнение объявленного с объявленным, а не с нажатием. */
export function sameBinding(left: string, right: string): boolean {
  const declared = canonical(left.split('+'));
  return declared !== '' && declared === canonical(right.split('+'));
}

/**
 * Сочетания, которые каркас разбирает раньше вкладов и потому не отдаёт им:
 * отмена, повтор и возврат фокуса одинаковы во всех областях (ED-18, ED-23).
 * Список объявлен здесь, рядом с самими сочетаниями, чтобы у каркаса не
 * заводилось второго перечня того, что он забирает.
 */
export const FRAME_BINDINGS: readonly string[] = Object.freeze([
  UNDO_BINDING,
  REDO_BINDING,
  DISMISS_KEY,
  PALETTE_BINDING,
]);
