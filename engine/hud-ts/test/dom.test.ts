/**
 * Узловая абстракция пакета: построение и обход описаний без браузера,
 * материализация через фейковый документ и точечные обновления (задача 1.2;
 * образец — `editor/ui-ts/src/dom`).
 */
import { describe, expect, it } from 'vitest';
import {
  children,
  el,
  findAll,
  hasClass,
  renderInto,
  renderNode,
  setAttr,
  setText,
  toggleClass,
  walk,
} from '../src/index.js';
import { asElement, fakeDom, type FakeElement } from './support/fakeDom.js';

describe('описание узла', () => {
  it('el собирает дерево, walk обходит его в порядке документа', () => {
    const tree = el('div', {
      classes: ['panel'],
      children: [el('span', { text: 'a' }), el('button', { text: 'b' })],
    });
    expect([...walk(tree)].map((node) => node.tag)).toEqual(['div', 'span', 'button']);
    expect(hasClass(tree, 'panel')).toBe(true);
    expect(findAll(tree, (node) => node.text !== undefined)).toHaveLength(2);
  });

  it('children отбрасывает пропущенных детей', () => {
    const list = children(el('a'), undefined, el('b'));
    expect(list.map((node) => node.tag)).toEqual(['a', 'b']);
  });
});

describe('материализация (граница «описание → DOM»)', () => {
  it('переносит классы, атрибуты, стиль, текст, детей и обработчики', () => {
    const { doc } = fakeDom();
    const clicks: unknown[] = [];
    let captured: Element | null = null;
    const element = renderNode(
      doc,
      el('button', {
        classes: ['hud-button', 'primary'],
        attrs: { type: 'button', 'data-slot': 'cast' },
        style: { 'pointer-events': 'auto', color: 'white' },
        text: 'Каст',
        children: [el('span', { text: '!' })],
        on: { click: (event) => clicks.push(event) },
        ref: (node) => (captured = node),
      }),
    ) as unknown as FakeElement;

    expect(element.getAttribute('class')).toBe('hud-button primary');
    expect(element.getAttribute('type')).toBe('button');
    expect(element.getAttribute('data-slot')).toBe('cast');
    expect(element.getAttribute('style')).toBe('pointer-events: auto; color: white');
    expect(element.childElements[0]!.textContent).toBe('!');
    element.dispatch('click', { kind: 'test' });
    expect(clicks).toEqual([{ kind: 'test' }]);
    expect(captured).toBe(element as unknown as Element);
  });

  it('renderInto заменяет содержимое хозяина', () => {
    const { doc, container } = fakeDom();
    container.append((doc as unknown as { createElement(tag: string): FakeElement }).createElement('p'));
    renderInto(asElement(container), el('div', { text: 'x' }));
    expect(container.childElements).toHaveLength(1);
    expect(container.childElements[0]!.tag).toBe('div');
  });
});

describe('точечные обновления', () => {
  it('setText пишет только изменившийся текст', () => {
    const { doc } = fakeDom();
    const element = renderNode(doc, el('span', { text: 'тик 1' })) as unknown as FakeElement;
    const writes = element.textWrites;
    setText(asElement(element), 'тик 1'); // без изменения — без записи
    expect(element.textWrites).toBe(writes);
    setText(asElement(element), 'тик 2');
    expect(element.textContent).toBe('тик 2');
    expect(element.textWrites).toBe(writes + 1);
  });

  it('setAttr ставит и снимает атрибут', () => {
    const { doc } = fakeDom();
    const element = renderNode(doc, el('div')) as unknown as FakeElement;
    setAttr(asElement(element), 'aria-disabled', 'true');
    expect(element.getAttribute('aria-disabled')).toBe('true');
    setAttr(asElement(element), 'aria-disabled', null);
    expect(element.hasAttribute('aria-disabled')).toBe(false);
  });

  it('toggleClass включает и выключает модификатор', () => {
    const { doc } = fakeDom();
    const element = renderNode(doc, el('div', { classes: ['panel'] })) as unknown as FakeElement;
    toggleClass(asElement(element), 'is-paused', true);
    expect(element.getAttribute('class')).toBe('panel is-paused');
    toggleClass(asElement(element), 'is-paused', false);
    expect(element.getAttribute('class')).toBe('panel');
  });
});
