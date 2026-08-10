/**
 * Оверлей-хост HUD (HUD-3, design Decision 5): отдельный DOM-слой поверх
 * canvas вьюпорта — сетка 3×3 фиксированных зон (углы, кромки, центр).
 * Механизм прохождения указателя: `pointer-events: none` на корне и зонах,
 * `auto` — только на элементах, объявленных интерактивными через
 * `interactive`. Вне интерактива клик доходит до вьюпорта — picking
 * (REND-15) и камера работают так же, как без HUD.
 *
 * Композиция раскладывает виджеты по именам зон, а не по абсолютным
 * координатам, — это переносимость композиции между разрешениями (HUD-4).
 */
import { el, type HudNode } from './dom/node.js';
import { renderNode } from './dom/render.js';
import { HUD_ZONES, type HudZoneName } from './zones.js';

/** Атрибут зоны на её контейнере — то, по чему тесты и стили находят зону. */
export const HUD_ZONE_ATTR = 'data-hud-zone';

/**
 * Корень: растянут по контейнеру, прозрачен для указателя (HUD-3) и не
 * участвует в кадре рендера — это DOM над canvas, а не его часть.
 */
const ROOT_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  inset: '0',
  display: 'grid',
  'grid-template-columns': 'auto 1fr auto',
  'grid-template-rows': 'auto 1fr auto',
  'pointer-events': 'none',
};

const ALIGNMENTS = ['start', 'center', 'end'] as const;

/** Место зоны в сетке 3×3: порядок `HUD_ZONES` — строки сверху, колонки слева. */
function zoneStyle(index: number): Record<string, string> {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return {
    'grid-row': String(row + 1),
    'grid-column': String(column + 1),
    'justify-self': ALIGNMENTS[column] ?? 'start',
    'align-self': ALIGNMENTS[row] ?? 'start',
    // Зона, как и корень, прозрачна для указателя: перехват — только там,
    // где виджет объявил интерактив (HUD-3).
    'pointer-events': 'none',
  };
}

/**
 * Помечает узел интерактивным: только такие элементы перехватывают указатель
 * (HUD-3). Возвращает новый узел — описания неизменяемы.
 */
export function interactive(node: HudNode): HudNode {
  return { ...node, style: { ...node.style, 'pointer-events': 'auto' } };
}

/**
 * Чистое описание оверлея — корень с девятью зонами; тест обходит его без
 * браузера. `onZone` отдаёт материализованные контейнеры зон хосту.
 */
export function overlayNode(onZone?: (zone: HudZoneName, element: Element) => void): HudNode {
  return el('div', {
    attrs: { 'data-hud-root': 'true' },
    style: ROOT_STYLE,
    children: HUD_ZONES.map((zone, index) =>
      el('div', {
        attrs: { [HUD_ZONE_ATTR]: zone },
        style: zoneStyle(index),
        ...(onZone !== undefined ? { ref: (element: Element) => { onZone(zone, element); } } : {}),
      }),
    ),
  });
}

/**
 * Материализованный оверлей над контейнером вьюпорта. Хост владеет корнем и
 * словарём зон; размещение и снятие виджетов — через него, чтобы граница
 * «описание → DOM» осталась в одном месте.
 */
export class HudOverlayHost {
  readonly root: Element;

  private readonly doc: Document;
  private readonly zones = new Map<HudZoneName, Element>();

  constructor(container: Element) {
    this.doc = container.ownerDocument;
    this.root = renderNode(
      this.doc,
      overlayNode((zone, element) => this.zones.set(zone, element)),
    );
    container.append(this.root);
  }

  /** Контейнер зоны; словарь фиксированный, неизвестное имя — ошибка сборки. */
  zone(name: HudZoneName): Element {
    const element = this.zones.get(name);
    if (element === undefined) throw new Error(`оверлей: зона "${name}" не материализована`);
    return element;
  }

  /** Материализует описание виджета и помещает его в зону. */
  place(zone: HudZoneName, node: HudNode): Element {
    const element = renderNode(this.doc, node);
    this.zone(zone).append(element);
    return element;
  }

  /** Убирает размещённый элемент виджета из его зоны. */
  remove(element: Element): void {
    element.remove();
  }

  /** Снимает весь оверлей с контейнера. */
  dispose(): void {
    this.root.remove();
  }
}
