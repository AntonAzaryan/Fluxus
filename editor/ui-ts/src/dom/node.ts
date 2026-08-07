/**
 * Описание узла интерфейса — то, из чего виджеты собирают разметку, и то, что
 * тест может обойти без браузера.
 *
 * Виджет не трогает DOM напрямую, а возвращает `UiNode`; материализует дерево
 * `renderNode`. Разделение нужно не ради «виртуального DOM» — реактивности
 * здесь нет, — а ради двух вещей, которые иначе не проверяются:
 *
 * - ED-27 запрещает строковые литералы интерфейса вне ресурсов. Текст узла
 *   имеет тип `UiText`, а `UiText` собирается ровно двумя функциями: из
 *   ресурса по ключу и из значения документа. Литерал в подпись кнопки
 *   компилятор просто не пропустит.
 * - Готовое дерево обходится в тесте, и по каждому текстовому узлу видно, что
 *   он такое: разрешённый ресурс или значение открытого документа.
 *
 * Человеческий текст умеет прятаться в атрибутах (`title`, `aria-label`,
 * `placeholder`, `value`), поэтому такие атрибуты вынесены в отдельное поле
 * `labels` с тем же типом `UiText`, а `attrs` остаётся машинным: роли,
 * идентификаторы, типы контролов.
 *
 * По той же причине узел не умеет нести атрибут `style`: строка стиля — это
 * произвольный CSS в обход таблицы стилей, а на таблице держатся все три
 * структурные проверки ED-22 (роль акцента, сброс палитры на границе кадра,
 * высота строки из токена). Виджету достаётся `vars` — только пользовательские
 * свойства, только для параметра раскладки вроде глубины узла дерева.
 */
import type { TextSource } from '@game-mvp/editor-core';

/**
 * Откуда взялся текст. `resource` — строка из локали (ED-27); `value` —
 * содержимое открытого документа: имена компонентов, полей, префабов, ассетов
 * и их значения. Вторые не локализуются вовсе (ED-27), поэтому и различаются
 * от первых на уровне типа, а не соглашением.
 */
export type UiTextOrigin = 'resource' | 'value';

export interface UiText {
  readonly origin: UiTextOrigin;
  readonly value: string;
  /** Ключ ресурса — только у `origin: 'resource'`; по нему тест и проверяет локали. */
  readonly key?: string;
}

/** Единственный способ показать строку интерфейса (ED-27). */
export function resourceText(source: TextSource, key: string): UiText {
  return { origin: 'resource', value: source.text(key), key };
}

/**
 * Единственный способ показать содержимое документа. Вызов с литералом —
 * дефект ED-27 и ловится `test/strings.test.ts`: аргумент обязан приходить из
 * данных, иначе это подпись интерфейса, притворившаяся значением.
 */
export function documentValue(value: string): UiText {
  return { origin: 'value', value };
}

/** Атрибуты, несущие человеческий текст, — только через `UiText`. */
export interface UiLabels {
  readonly title?: UiText;
  readonly ariaLabel?: UiText;
  readonly placeholder?: UiText;
  /**
   * Содержимое поля ввода. Видно автору так же, как подпись, и потому идёт
   * сюда, а не в машинные атрибуты: иначе значение в инспекторе — единственный
   * текст на странице, которого учёт ED-27 не видит. У `<option>` `value` —
   * машинный идентификатор выбора, и остаётся в `attrs`.
   */
  readonly value?: UiText;
}

export type UiHandler = (event: Event) => void;

export interface UiNode {
  readonly tag: string;
  /** `svg` — для встроенных иконок; наследуется детьми. */
  readonly ns?: 'svg';
  readonly classes?: readonly string[];
  /** Машинные атрибуты: `role`, `type`, `id`, `data-*`, `aria-*` без текста. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** Пользовательские свойства CSS (`--fx-depth`) — параметр правила, не стиль. */
  readonly vars?: Readonly<Record<string, string>>;
  readonly labels?: UiLabels;
  readonly text?: UiText;
  readonly children?: readonly UiNode[];
  readonly on?: Readonly<Record<string, UiHandler>>;
}

export type UiNodeSpec = Omit<UiNode, 'tag'>;

/** Конструктор узла: `el('div', { classes: [...], children: [...] })`. */
export function el(tag: string, spec: UiNodeSpec = {}): UiNode {
  return { tag, ...spec };
}

/** Отбрасывает пропущенных детей — избавляет виджеты от ветвлений в списках. */
export function children(...items: readonly (UiNode | undefined)[]): readonly UiNode[] {
  return items.filter((item): item is UiNode => item !== undefined);
}

/** Обход дерева в порядке документа — основа всех структурных проверок. */
export function* walk(node: UiNode): Generator<UiNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

export function hasClass(node: UiNode, className: string): boolean {
  return node.classes?.includes(className) === true;
}

export function findAll(node: UiNode, predicate: (candidate: UiNode) => boolean): UiNode[] {
  return [...walk(node)].filter(predicate);
}

/** Весь видимый автору текст поддерева — и подписи, и текстовые атрибуты. */
export function collectTexts(node: UiNode): UiText[] {
  const texts: UiText[] = [];
  for (const current of walk(node)) {
    if (current.text !== undefined) texts.push(current.text);
    const labels = current.labels;
    if (labels === undefined) continue;
    for (const label of [labels.title, labels.ariaLabel, labels.placeholder, labels.value]) {
      if (label !== undefined) texts.push(label);
    }
  }
  return texts;
}
