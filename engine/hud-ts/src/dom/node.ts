/**
 * Описание узла HUD — то, из чего виджеты собирают разметку, и то, что тест
 * обходит без браузера и без jsdom.
 *
 * Собственный аналог `editor/ui-ts/src/dom/node.ts`, а не импорт из него:
 * связывать игровой клиент с authoring-инструментом ради пары хелперов —
 * сцепление дороже дублирования (design Decision 2, Risks). Отличия от
 * редакторского образца сознательные:
 *
 * - Текст — обычная строка. Дисциплина ресурсов ED-27 — норма редактора;
 *   строковые ресурсы матчевого HUD — открытый вопрос design.md, и первая
 *   версия обходится строками из композиции.
 * - Узел умеет `style` — словарь CSS-свойств. У редактора инлайн-стиль
 *   запрещён ради структурных проверок таблицы (ED-22); у HUD инлайн-стиль —
 *   сам механизм HUD-3: `pointer-events` на корне, зонах и интерактиве обязан
 *   быть виден в описании узла, чтобы тест проверял его без браузера.
 * - Узел умеет `ref`: HUD обновляется по каденсу доставки (HUD-5), и виджету
 *   нужны ссылки на материализованные элементы для точечных обновлений текста
 *   и атрибутов — вместо пере-рендера поддерева на каждую доставку (Risks:
 *   «виджеты обновляют только изменившиеся текст/атрибуты»).
 */

export type HudHandler = (event: Event) => void;

export interface HudNode {
  readonly tag: string;
  readonly classes?: readonly string[];
  /** Машинные атрибуты: `role`, `type`, `data-*`, `aria-*`. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** CSS-свойства инлайн-стиля (kebab-case) — прежде всего `pointer-events` (HUD-3). */
  readonly style?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly HudNode[];
  readonly on?: Readonly<Record<string, HudHandler>>;
  /** Вызывается при материализации — виджет запоминает элемент для точечных обновлений. */
  readonly ref?: (element: Element) => void;
}

export type HudNodeSpec = Omit<HudNode, 'tag'>;

/** Конструктор узла: `el('div', { classes: [...], children: [...] })`. */
export function el(tag: string, spec: HudNodeSpec = {}): HudNode {
  return { tag, ...spec };
}

/** Отбрасывает пропущенных детей — избавляет виджеты от ветвлений в списках. */
export function children(...items: readonly (HudNode | undefined)[]): readonly HudNode[] {
  return items.filter((item): item is HudNode => item !== undefined);
}

/** Обход дерева в порядке документа — основа проверок без браузера. */
export function* walk(node: HudNode): Generator<HudNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

export function hasClass(node: HudNode, className: string): boolean {
  return node.classes?.includes(className) === true;
}

export function findAll(node: HudNode, predicate: (candidate: HudNode) => boolean): HudNode[] {
  return [...walk(node)].filter(predicate);
}
