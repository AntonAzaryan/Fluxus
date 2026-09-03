/**
 * Оверлей-хост (задача 3.1, HUD-3): корень и все зоны прозрачны для
 * указателя, перехват — только у элементов, объявленных интерактивными.
 * Проверка — по атрибутам и стилям описаний и материализованных элементов;
 * настоящего hit-testing без браузера нет и не нужно.
 */
import { describe, expect, it } from 'vitest';
import {
  HUD_ZONES,
  HUD_ZONE_ATTR,
  HudOverlayHost,
  el,
  findAll,
  interactive,
  overlayNode,
} from '../src/index.js';
import { asElement, fakeDom, walkElements } from './support/fakeDom.js';

describe('прохождение указателя (HUD-3)', () => {
  it('корень оверлея прозрачен для указателя', () => {
    const node = overlayNode();
    expect(node.style?.['pointer-events']).toBe('none');
  });

  it('весь фиксированный словарь зон присутствует, и каждая зона прозрачна', () => {
    const node = overlayNode();
    const zones = findAll(node, (candidate) => candidate.attrs?.[HUD_ZONE_ATTR] !== undefined);
    expect(zones.map((zone) => zone.attrs![HUD_ZONE_ATTR])).toEqual([...HUD_ZONES]);
    for (const zone of zones) {
      expect(zone.style?.['pointer-events']).toBe('none');
    }
  });

  it('interactive помечает элемент перехватывающим, не мутируя описание', () => {
    const button = el('button', { style: { color: 'white' } });
    const marked = interactive(button);
    expect(marked.style?.['pointer-events']).toBe('auto');
    expect(marked.style?.color).toBe('white');
    expect(button.style?.['pointer-events']).toBeUndefined();
  });

  it('в материализованном оверлее auto только у интерактивных элементов', () => {
    const { container } = fakeDom();
    const host = new HudOverlayHost(asElement(container));
    host.place('bottom', el('div', { children: [interactive(el('button', { text: 'Пауза' }))] }));

    const styles = [...walkElements(container)]
      .map((element) => element.getAttribute('style'))
      .filter((style): style is string => style !== null);
    const auto = styles.filter((style) => style.includes('pointer-events: auto'));
    const none = styles.filter((style) => style.includes('pointer-events: none'));
    expect(auto).toHaveLength(1); // только кнопка
    // Корень, все зоны и якорный слой (HUD-10): он лежит поверх сетки и,
    // как она, для указателя прозрачен — перехват остаётся на интерактиве.
    expect(none).toHaveLength(2 + HUD_ZONES.length);
  });
});

describe('размещение по зонам', () => {
  it('place кладёт виджет в контейнер зоны, remove убирает его', () => {
    const { container } = fakeDom();
    const host = new HudOverlayHost(asElement(container));
    const element = host.place('top-right', el('div', { text: 'статус' }));
    const zone = host.zone('top-right') as unknown as { childElements: unknown[] };
    expect(zone.childElements).toHaveLength(1);
    host.remove(element);
    expect(zone.childElements).toHaveLength(0);
  });

  it('dispose снимает оверлей с контейнера', () => {
    const { container } = fakeDom();
    const host = new HudOverlayHost(asElement(container));
    expect(container.childElements).toHaveLength(1);
    host.dispose();
    expect(container.childElements).toHaveLength(0);
  });
});
