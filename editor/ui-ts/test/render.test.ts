/**
 * Материализация описания узла в DOM. DOM в прогоне тестов нет — как и в
 * `root.test.ts`, вместо него подставляется документ-заглушка: `renderNode`
 * пользуется всего пятью операциями, и заглушка на них честно отвечает.
 *
 * Проверяется то, ради чего разделение и заведено: `UiText` доходит до
 * текстового узла, текстовые атрибуты получают свои имена (ED-27), а
 * встроенная иконка создаётся в пространстве имён SVG — иначе она не
 * рисуется, и ни один тест по описанию узлов этого бы не заметил.
 */
import { describe, expect, it } from 'vitest';
import { documentValue, el } from '../src/dom/node.js';
import { renderNode } from '../src/dom/render.js';
import { icon } from '../src/widgets/icon.js';

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly kids: FakeElement[] = [];
  readonly events: string[] = [];
  textContent = '';

  constructor(
    readonly tag: string,
    readonly ns: string | undefined,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(child: FakeElement): void {
    this.kids.push(child);
  }

  addEventListener(name: string): void {
    this.events.push(name);
  }
}

function fakeDocument(): Document {
  return {
    createElement: (tag: string) => new FakeElement(tag, undefined),
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  } as unknown as Document;
}

function render(node: Parameters<typeof renderNode>[1]): FakeElement {
  return renderNode(fakeDocument(), node) as unknown as FakeElement;
}

describe('материализация узла', () => {
  it('текст узла доходит до текстового содержимого', () => {
    const element = render(el('span', { text: documentValue('skeleton_02') }));
    expect(element.textContent).toBe('skeleton_02');
  });

  it('текстовые атрибуты получают свои имена, машинные — свои', () => {
    const element = render(
      el('input', {
        attrs: { type: 'search' },
        labels: { placeholder: documentValue('idle'), ariaLabel: documentValue('skin') },
      }),
    );
    expect(element.attributes.get('type')).toBe('search');
    expect(element.attributes.get('placeholder')).toBe('idle');
    expect(element.attributes.get('aria-label')).toBe('skin');
  });

  it('классы склеиваются в один атрибут, обработчики подписываются', () => {
    const element = render(
      el('button', {
        classes: ['fx-button', 'fx-button--primary'],
        on: { click: () => undefined },
      }),
    );
    expect(element.attributes.get('class')).toBe('fx-button fx-button--primary');
    expect(element.events).toEqual(['click']);
  });

  it('иконка и её пути создаются в пространстве имён SVG', () => {
    const element = render(icon({ name: 'error' }));
    expect(element.ns).toBe('http://www.w3.org/2000/svg');
    expect(element.kids.length).toBeGreaterThan(0);
    for (const path of element.kids) {
      expect(path.ns).toBe('http://www.w3.org/2000/svg');
      expect(path.attributes.get('d')?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('дети попадают внутрь родителя в порядке описания', () => {
    const element = render(
      el('div', {
        children: [el('span', { text: documentValue('a') }), el('span', { text: documentValue('b') })],
      }),
    );
    expect(element.kids.map((kid) => kid.textContent)).toEqual(['a', 'b']);
  });
});
