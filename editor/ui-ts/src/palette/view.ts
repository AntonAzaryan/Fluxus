/**
 * Показ палитры команд (ED-24): строка запроса и плотный список того, до чего
 * она даёт добраться.
 *
 * Устройство — комбобокс, а не список с обходом стрелками: фокус остаётся в
 * строке запроса, а стрелки водят подсветку по строкам. Причина
 * прагматическая и названа в `frame/mount.ts`: страница пересобирается целиком
 * на каждое изменение, и фокус после пересборки возвращается по пометке
 * roving-контейнера. Контейнер здесь — сама палитра, а его единственная
 * остановка Tab — строка запроса, поэтому набор текста переживает перерисовку,
 * которую вызывает он же.
 *
 * Список — тот же плотный список, что в навигаторе (`denseList`): палитра не
 * заводит своего вида строки, потому что строка у редактора одна (ED-22).
 * Недоступная строка помечена `aria-disabled` и приглушена — показана, а не
 * спрятана (ED-26).
 */
import type { StringResources } from '@fluxus/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import { rovingContainer } from '../dom/roving.js';
import { icon } from '../widgets/icon.js';
import { denseList, type ListItem } from '../widgets/rows.js';
import type { PaletteEntry } from './palette.js';

/** Идентификатор roving-контейнера палитры: по нему каркас возвращает сюда фокус. */
export const PALETTE_ROVING_ID = 'fx-palette';

/** Класс самой палитры — по нему её находит тест и таблица стилей. */
export const PALETTE_CLASS = 'fx-palette';

/** Класс затемнения под палитрой: клик по нему закрывает её. */
export const PALETTE_SCRIM_CLASS = 'fx-palette__scrim';

export interface PaletteViewSpec {
  readonly resources: StringResources;
  readonly entries: readonly PaletteEntry[];
  readonly query: string;
  /** Строка под подсветкой; пустая строка — подсвечена первая. */
  readonly activeId: string;
  readonly onQuery: (query: string) => void;
  readonly onActive: (id: string) => void;
  readonly onRun: (id: string) => void;
  readonly onDismiss: () => void;
}

/** Куда переходит подсветка по клавише; `undefined` — клавиша не про переход. */
function step(key: string, index: number, length: number): number | undefined {
  if (length === 0) return undefined;
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % length;
    case 'ArrowUp':
      return (index - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return undefined;
  }
}

function itemOf(entry: PaletteEntry, active: boolean): ListItem {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.detail === undefined ? {} : { secondary: entry.detail }),
    ...(entry.keys === undefined ? {} : { trailing: entry.keys }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    selected: active,
    disabled: entry.disabled,
  };
}

export function paletteView(spec: PaletteViewSpec): UiNode {
  const entries = spec.entries;
  const index = Math.max(
    entries.findIndex((entry) => entry.id === spec.activeId),
    0,
  );
  const active = entries[index]?.id ?? '';
  const label = resourceText(spec.resources, 'ui.palette.title');

  const query = el('input', {
    classes: ['fx-input', 'fx-palette__query'],
    // Единственная остановка Tab контейнера: по ней каркас и возвращает сюда
    // фокус после пересборки страницы.
    attrs: { type: 'search', tabindex: '0', role: 'combobox', 'aria-expanded': 'true' },
    labels: {
      placeholder: resourceText(spec.resources, 'ui.palette.placeholder'),
      ariaLabel: label,
      ...(spec.query === '' ? {} : { value: documentValue(spec.query) }),
    },
    on: {
      // Посимвольно: список обязан сужаться по мере набора, иначе поиск при
      // сотнях документов не отличается от прохода по дереву (ED-24).
      input: (event: Event) => {
        const target = event.target;
        if (target !== null && 'value' in target && typeof target.value === 'string') {
          spec.onQuery(target.value);
        }
      },
      keydown: (event: Event) => {
        if (!('key' in event) || typeof event.key !== 'string') return;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (active !== '') spec.onRun(active);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          spec.onDismiss();
          return;
        }
        const next = step(event.key, index, entries.length);
        if (next === undefined) return;
        event.preventDefault();
        const entry = entries[next];
        if (entry !== undefined) spec.onActive(entry.id);
      },
    },
  });

  return el('div', {
    classes: [PALETTE_SCRIM_CLASS],
    on: {
      click: (event: Event) => {
        // Только по самому затемнению: клик внутри палитры её не закрывает.
        if (event.target === event.currentTarget) spec.onDismiss();
      },
    },
    children: [
      el('div', {
        classes: [PALETTE_CLASS],
        attrs: { role: 'dialog', 'aria-modal': 'true', ...rovingContainer(PALETTE_ROVING_ID) },
        labels: { ariaLabel: label },
        children: children(
          el('div', {
            classes: ['fx-palette__head'],
            children: [icon({ name: 'search' }), query],
          }),
          entries.length === 0
            ? el('div', {
                classes: ['fx-row'],
                text: resourceText(spec.resources, 'ui.palette.empty'),
              })
            : denseList({
                label,
                onActive: spec.onActive,
                items: entries.map((entry) => ({
                  ...itemOf(entry, entry.id === active),
                  // Выбор строки — её исполнение: палитра существует ровно
                  // затем, чтобы добраться до чего-то одним действием (ED-24).
                  // У недоступной строки обработчика нет вовсе: она и показана
                  // недоступной, и не срабатывает (ED-26).
                  ...(entry.disabled ? {} : { onSelect: spec.onRun }),
                })),
              }),
        ),
      }),
    ],
  });
}
