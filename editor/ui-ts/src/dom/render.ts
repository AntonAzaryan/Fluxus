/**
 * Материализация описания узла в DOM. Единственное место пакета, которое
 * создаёт элементы и пишет в них текст, — поэтому здесь же, и только здесь,
 * `UiText` превращается в строку, а текстовые атрибуты получают свои имена.
 */
import type { UiNode, UiText } from './node.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function create(doc: Document, node: UiNode, inherited: 'svg' | undefined): Element {
  const ns = node.ns ?? inherited;
  return ns === 'svg' ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
}

function setLabel(element: Element, attribute: string, text: UiText | undefined): void {
  if (text !== undefined) element.setAttribute(attribute, text.value);
}

function build(doc: Document, node: UiNode, inherited: 'svg' | undefined): Element {
  const element = create(doc, node, inherited);
  const ns = node.ns ?? inherited;

  if (node.classes !== undefined && node.classes.length > 0) {
    element.setAttribute('class', node.classes.join(' '));
  }
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    element.setAttribute(name, value);
  }

  setLabel(element, 'title', node.labels?.title);
  setLabel(element, 'aria-label', node.labels?.ariaLabel);
  setLabel(element, 'placeholder', node.labels?.placeholder);

  if (node.text !== undefined) element.textContent = node.text.value;
  for (const child of node.children ?? []) element.append(build(doc, child, ns));

  for (const [event, handler] of Object.entries(node.on ?? {})) {
    element.addEventListener(event, handler);
  }
  return element;
}

/** Строит элемент по описанию. Владение результатом переходит вызывающему. */
export function renderNode(doc: Document, node: UiNode): Element {
  return build(doc, node, undefined);
}

/** Заменяет содержимое узла-хозяина отрисованным описанием. */
export function renderInto(host: Element, node: UiNode): Element {
  const doc = host.ownerDocument;
  const element = renderNode(doc, node);
  host.replaceChildren(element);
  return element;
}
