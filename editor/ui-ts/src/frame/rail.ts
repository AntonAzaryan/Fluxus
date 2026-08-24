/**
 * Вертикальный рельс рабочих областей — визуальное представление реестра
 * областей (ED-23, ED-25).
 *
 * «Представление реестра» здесь буквально: рельс строится обходом
 * `areas.all()` и ничего, кроме порядка, о наборе областей не решает.
 * Зарегистрировали вклад — знак появился; сняли — исчез; каркас при этом не
 * правится ни на строку. Ни одного условия «если область такая-то» здесь нет
 * и быть не может: рельс не знает, что за материал правит область.
 *
 * Явный элемент переключения (ED-23) — сам знак; вторая половина того же
 * требования, горячая клавиша, объявлена вкладом (`hotkey`) и разбирается в
 * `keys.ts`. Клавиша попадает сюда машинным атрибутом `data-hotkey`, а не
 * подписью: подпись обязана приходить из ресурсов (ED-27), а «F2» ресурсом не
 * является — её место в палитре команд (W2-3), где сочетания показываются
 * рядом с командами.
 */
import type { StringResources } from '@fluxus/editor-core';
import { el, resourceText, type UiNode } from '../dom/node.js';
import { rovingContainer, rovingItem, rovingTarget } from '../dom/roving.js';
import { icon } from '../widgets/icon.js';
import type { WorkspaceArea } from './area.js';

/** Идентификатор roving-контейнера рельса: по нему каркас возвращает сюда фокус. */
export const RAIL_ROVING_ID = 'fx-rail';

/** Класс знака области — по нему тест находит представление реестра. */
export const RAIL_ITEM_CLASS = 'fx-rail__item';

export interface AreaRailSpec {
  readonly areas: readonly WorkspaceArea[];
  readonly activeId: string;
  readonly resources: StringResources;
  readonly onActivate: (areaId: string) => void;
}

function railItem(spec: AreaRailSpec, area: WorkspaceArea): UiNode {
  const active = area.id === spec.activeId;
  const label = resourceText(spec.resources, area.labelKey);
  return el('button', {
    classes: [RAIL_ITEM_CLASS, ...(active ? ['fx-is-active'] : [])],
    attrs: {
      type: 'button',
      role: 'tab',
      'aria-selected': String(active),
      'data-area': area.id,
      ...(area.hotkey === undefined ? {} : { 'data-hotkey': area.hotkey }),
      ...rovingItem(active),
    },
    labels: { ariaLabel: label },
    children: [
      icon({ name: area.icon, size: 'lg' }),
      el('span', { classes: ['fx-rail__label'], text: label }),
    ],
    on: {
      click: () => {
        spec.onActivate(area.id);
      },
    },
  });
}

/**
 * Рельс целиком. Стрелки водят по знакам и сразу переключают область: рельс —
 * не список, из которого потом что-то выбирают, а сам переключатель, и
 * расхождение «фокус здесь, а показано другое» ему только вредит.
 */
export function areaRail(spec: AreaRailSpec): UiNode {
  const index = spec.areas.findIndex((area) => area.id === spec.activeId);
  return el('nav', {
    classes: ['fx-rail'],
    attrs: {
      role: 'tablist',
      'aria-orientation': 'vertical',
      ...rovingContainer(RAIL_ROVING_ID),
    },
    labels: { ariaLabel: resourceText(spec.resources, 'ui.frame.rail') },
    children: spec.areas.map((area) => railItem(spec, area)),
    on: {
      keydown: (event: Event) => {
        if (!('key' in event) || typeof event.key !== 'string') return;
        const target = rovingTarget(event.key, index, spec.areas.length);
        const area = target === undefined ? undefined : spec.areas[target];
        if (area === undefined) return;
        event.preventDefault();
        spec.onActivate(area.id);
      },
    },
  });
}
