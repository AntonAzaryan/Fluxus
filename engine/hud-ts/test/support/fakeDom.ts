/**
 * Мини-DOM для тестов без браузера и без jsdom (образец — заглушки
 * `editor/ui-ts/test`): ровно та поверхность, которую зовут `renderNode`,
 * хелперы обновления и оверлей-хост. Никакого layout и hit-testing здесь нет
 * намеренно — HUD-3 проверяется по атрибутам и стилям описаний, а не
 * настоящим прохождением указателя.
 */

export class FakeElement {
  readonly tag: string;
  readonly childElements: FakeElement[] = [];
  parent: FakeElement | null = null;
  ownerDocument!: Document;

  /** Счётчик записей текста — тест `setText` проверяет «пишем только изменение». */
  textWrites = 0;

  private text: string | null = '';
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tag: string) {
    this.tag = tag;
  }

  get textContent(): string | null {
    return this.text;
  }

  set textContent(value: string | null) {
    this.text = value;
    this.textWrites += 1;
  }

  readonly classList = {
    toggle: (className: string, on: boolean): boolean => {
      const set = new Set((this.attributes.get('class') ?? '').split(' ').filter(Boolean));
      if (on) set.add(className);
      else set.delete(className);
      this.attributes.set('class', [...set].join(' '));
      return on;
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.childElements.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const node of this.childElements) node.parent = null;
    this.childElements.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.childElements.indexOf(this);
    if (index !== -1) this.parent.childElements.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Синтетическое событие — «клик» по кнопке виджета в тесте. */
  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    const element = new FakeElement(tag);
    element.ownerDocument = this as unknown as Document;
    return element;
  }
}

export interface FakeDom {
  readonly doc: Document;
  /** Контейнер вьюпорта, поверх которого встаёт оверлей. */
  readonly container: FakeElement;
}

export function fakeDom(): FakeDom {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  return { doc: doc as unknown as Document, container };
}

/** Обход материализованного поддерева — аналог `walk` для фейковых элементов. */
export function* walkElements(element: FakeElement): Generator<FakeElement> {
  yield element;
  for (const child of element.childElements) yield* walkElements(child);
}

export function asElement(element: FakeElement): Element {
  return element as unknown as Element;
}
