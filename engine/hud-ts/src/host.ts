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
 * Атрибут якорного слоя (HUD-10): виджеты, размещённые по мировому якорю
 * (`rendering` REND-41), живут в нём, а не в клетках сетки зон — их место
 * задают пиксели кадра, и в поток сетки они не встают.
 */
export const HUD_ANCHOR_LAYER_ATTR = 'data-hud-anchors';

/** Атрибут держателя одного якорного виджета — по нему его находят тесты. */
export const HUD_ANCHOR_ATTR = 'data-hud-anchor';

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

/**
 * Якорный слой: растянут по контейнеру поверх сетки зон и, как она, прозрачен
 * для указателя (HUD-3) — перехват остаётся только на объявленном интерактиве.
 * Он лежит В ТОЙ ЖЕ клетке сетки, что и центральная зона, и растянут на всю
 * сетку: собственного `position: relative` у корня нет, а абсолютное
 * позиционирование внутри `grid` считается от него же.
 */
const ANCHOR_LAYER_STYLE: Readonly<Record<string, string>> = {
  'grid-row': '1 / -1',
  'grid-column': '1 / -1',
  position: 'relative',
  'justify-self': 'stretch',
  'align-self': 'stretch',
  'pointer-events': 'none',
};

/**
 * Держатель одного якорного виджета: точка в кадре плюс перенос «по центру и
 * НАД точкой». Якорь публикуется над макушкой инстанса (REND-41), и виджет,
 * поставленный левым верхним углом в эту точку, накрывал бы юнита собой.
 */
const ANCHOR_HOLDER_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  left: '0',
  top: '0',
  'pointer-events': 'none',
  // До первого кадра якоря нет, и показывать виджет негде (HUD-10).
  display: 'none',
};

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
 * Чистое описание оверлея — корень с девятью зонами и якорным слоем (HUD-10);
 * тест обходит его без браузера. `onZone` отдаёт материализованные контейнеры
 * зон хосту, `onAnchors` — якорный слой.
 */
export function overlayNode(
  onZone?: (zone: HudZoneName, element: Element) => void,
  onAnchors?: (element: Element) => void,
): HudNode {
  return el('div', {
    attrs: { 'data-hud-root': 'true' },
    style: ROOT_STYLE,
    children: [
      ...HUD_ZONES.map((zone, index) =>
        el('div', {
          attrs: { [HUD_ZONE_ATTR]: zone },
          style: zoneStyle(index),
          ...(onZone !== undefined ? { ref: (element: Element) => { onZone(zone, element); } } : {}),
        }),
      ),
      el('div', {
        attrs: { [HUD_ANCHOR_LAYER_ATTR]: 'true' },
        style: ANCHOR_LAYER_STYLE,
        ...(onAnchors !== undefined ? { ref: onAnchors } : {}),
      }),
    ],
  });
}

/** Держатель якорного виджета как описание — тот же путь материализации. */
export function anchorHolderNode(child: HudNode): HudNode {
  return el('div', {
    attrs: { [HUD_ANCHOR_ATTR]: 'true' },
    style: ANCHOR_HOLDER_STYLE,
    children: [child],
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
  private anchorLayer: Element | null = null;

  constructor(container: Element) {
    this.doc = container.ownerDocument;
    this.root = renderNode(
      this.doc,
      overlayNode(
        (zone, element) => this.zones.set(zone, element),
        (element) => {
          this.anchorLayer = element;
        },
      ),
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

  /**
   * Материализует описание виджета в ДЕРЖАТЕЛЕ якорного слоя (HUD-10) и
   * возвращает держатель: двигает его исполнитель, а виджет о своём размещении
   * не знает вовсе. Держатель и есть то, что снимает `remove`.
   */
  placeAnchored(node: HudNode): Element {
    const layer = this.anchorLayer;
    if (layer === null) throw new Error('оверлей: якорный слой не материализован');
    const holder = renderNode(this.doc, anchorHolderNode(node));
    layer.append(holder);
    return holder;
  }

  /** Убирает размещённый элемент виджета из его зоны либо якорного слоя. */
  remove(element: Element): void {
    element.remove();
  }

  /** Снимает весь оверлей с контейнера. */
  dispose(): void {
    this.root.remove();
  }
}
