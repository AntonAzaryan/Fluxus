/**
 * Материализация описания узла в DOM — единственное место пакета, создающее
 * элементы (граница «описание → DOM» тонкая по образцу редактора). Всё
 * остальное — виджеты, композиция, хост — оперирует `HudNode` и потому
 * тестируется без браузера.
 *
 * Здесь же точечные обновления материализованных элементов: HUD обновляется
 * по каденсу доставки (HUD-5), и виджет пишет в DOM только изменившееся —
 * пере-рендер поддерева на каждую доставку дёргал бы layout впустую (Risks).
 */
import type { HudNode } from './node.js';

function build(doc: Document, node: HudNode): Element {
  const element = doc.createElement(node.tag);

  if (node.classes !== undefined && node.classes.length > 0) {
    element.setAttribute('class', node.classes.join(' '));
  }
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  const style = Object.entries(node.style ?? {});
  if (style.length > 0) {
    element.setAttribute('style', style.map(([name, value]) => `${name}: ${value}`).join('; '));
  }

  if (node.text !== undefined) element.textContent = node.text;
  for (const child of node.children ?? []) element.append(build(doc, child));

  for (const [event, handler] of Object.entries(node.on ?? {})) {
    element.addEventListener(event, handler);
  }
  node.ref?.(element);
  return element;
}

/** Строит элемент по описанию. Владение результатом переходит вызывающему. */
export function renderNode(doc: Document, node: HudNode): Element {
  return build(doc, node);
}

/** Заменяет содержимое узла-хозяина отрисованным описанием. */
export function renderInto(host: Element, node: HudNode): Element {
  const element = renderNode(host.ownerDocument, node);
  host.replaceChildren(element);
  return element;
}

/** Пишет текст, только если он изменился, — DOM не трогается впустую. */
export function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

/** Ставит или (при `null`) снимает атрибут; запись — только по изменению. */
export function setAttr(element: Element, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
    return;
  }
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** Включает или выключает класс — модификаторы состояния виджета. */
export function toggleClass(element: Element, className: string, on: boolean): void {
  element.classList.toggle(className, on);
}
