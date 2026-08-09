/**
 * Скелет рабочей области (ED-24): навигатор редактируемого — поверхность
 * правки — инспектор выбранного, в этом порядке и в этих местах во всех
 * областях.
 *
 * Собирает скелет каркас, а не область: область отдаёт три узла и не имеет
 * способа поменять их местами, оставить зону пустой или добавить четвёртую.
 * Именно это и есть «переход между областями не должен требовать заново искать
 * глазами то же самое» в исполнимом виде — не соглашение авторов вкладов, а
 * отсутствие у них такой возможности.
 *
 * Порядок зон в разметке — он же порядок обхода клавишей Tab. Совпадение не
 * случайное: скелет одинаков во всех областях, значит и клавиатурный путь
 * через него одинаков, и заучивается он один раз.
 */
import type { StringResources } from '@game-mvp/editor-core';
import { el, resourceText, type UiNode } from '../dom/node.js';
import type { AreaZones } from './area.js';
import {
  INSPECTOR_ZONE_CLASS,
  NAVIGATOR_ZONE_CLASS,
  SURFACE_ZONE_CLASS,
} from './styles.js';

/** Имя зоны: и ключ ресурса подписи, и метка `data-zone` для проверок. */
export type ZoneName = 'navigator' | 'surface' | 'inspector';

/**
 * Место фокуса по умолчанию (ED-32): поверхность правки активной области.
 * Именно зона скелета, а не что-то внутри неё, — во-первых, зона есть у каждой
 * области и одинакова во всех (ED-24), во-вторых, «место по умолчанию MUST NOT
 * потреблять клавиши области», а пустая зона не потребляет ничего. Рельс на
 * этой роли был бы прямым нарушением: он roving-контейнер и стрелки забирает.
 *
 * Остановкой Tab зона не становится (`tabindex="-1"`): обход страницы от неё не
 * удлиняется, а фокус ей ставят программно — возвратом клавиатуры области.
 */
export const SURFACE_FOCUS_ID = 'fx-zone-surface';

/** Порядок зон. Один на все области — в этом всё требование ED-24. */
export const ZONE_ORDER: readonly ZoneName[] = Object.freeze([
  'navigator',
  'surface',
  'inspector',
]);

const ZONE_CLASSES: Readonly<Record<ZoneName, string>> = {
  navigator: NAVIGATOR_ZONE_CLASS,
  surface: SURFACE_ZONE_CLASS,
  inspector: INSPECTOR_ZONE_CLASS,
};

/**
 * Панель и зона — разные вещи, и обе нужны: `.fx-panel` даёт поверхность,
 * рамку и прокрутку, класс зоны — место в скелете и его ширину. Поверхность
 * правки панелью не является: у неё нет ни рамки, ни своей прокрутки.
 */
const ZONE_SURFACES: Readonly<Record<ZoneName, readonly string[]>> = {
  navigator: ['fx-panel'],
  surface: [],
  inspector: ['fx-panel'],
};

function zone(name: ZoneName, content: UiNode, resources: StringResources): UiNode {
  return el('section', {
    classes: ['fx-zone', ZONE_CLASSES[name], ...ZONE_SURFACES[name]],
    attrs: {
      role: 'region',
      'data-zone': name,
      ...(name === 'surface' ? { id: SURFACE_FOCUS_ID, tabindex: '-1' } : {}),
    },
    labels: { ariaLabel: resourceText(resources, `ui.frame.zone.${name}`) },
    children: [content],
  });
}

/** Скелет области целиком. */
export function areaSkeleton(zones: AreaZones, resources: StringResources): UiNode {
  return el('div', {
    classes: ['fx-skeleton'],
    children: ZONE_ORDER.map((name) => zone(name, zones[name], resources)),
  });
}
