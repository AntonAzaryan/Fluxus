/**
 * Верхний бар каркаса — место сквозного, то есть того, что ED-23 запрещает
 * заводить по экземпляру на область: поиск по проекту, история операций,
 * настройка языка.
 *
 * История здесь именно одна: кнопки отмены и повтора спрашивают сессию
 * (`EditorSession`), у которой история одна на сессию (ED-18, ED-23), а не
 * активную область. Поэтому правка, сделанная в одной области, отменяется из
 * любой другой, и никакого «а в какой области это было» интерфейс не спрашивает.
 *
 * Недоступность выражена `aria-disabled`, а не пропаданием кнопки: элемент,
 * который сейчас нечем применить, обязан быть видимо недоступен (ED-26), а не
 * исчезать, оставляя автора гадать, был ли он.
 *
 * Чего здесь нет намеренно: аффорданса превью и индикации режима (ED-26) —
 * это задача W2-4, и место под них в баре уже есть; палитры команд и списка
 * результатов поиска (ED-24) — задача W2-3. Строка поиска стоит здесь уже
 * сейчас, потому что её запрос — сквозное состояние сессии: он не должен
 * теряться от перехода в другую область.
 */
import type { StringResources } from '@game-mvp/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import { button } from '../widgets/button.js';

export interface TopBarSpec {
  readonly resources: StringResources;
  readonly query: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onQuery: (query: string) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

const LOCALES: readonly (readonly [string, string])[] = [
  ['ru', 'ui.locale.ru'],
  ['en', 'ui.locale.en'],
];

/**
 * Строка поиска отдаёт запрос по `change`, а не по каждому нажатию: перерисовка
 * на посимвольный ввод уводила бы фокус из поля, а сам запрос — состояние
 * сессии, а не повод перерисовать страницу.
 */
function searchField(spec: TopBarSpec): UiNode {
  const label = resourceText(spec.resources, 'ui.app.search');
  return el('input', {
    classes: ['fx-input', 'fx-bar__search'],
    attrs: { type: 'search' },
    labels: {
      placeholder: label,
      ariaLabel: label,
      // Введённое автором — не подпись интерфейса и не локализуется: запрос
      // приходит из документа проекта ровно так же, как имя префаба (ED-27).
      ...(spec.query === '' ? {} : { value: documentValue(spec.query) }),
    },
    on: {
      change: (event: Event) => {
        const target = event.target;
        if (target !== null && 'value' in target && typeof target.value === 'string') {
          spec.onQuery(target.value);
        }
      },
    },
  });
}

export function frameTopBar(spec: TopBarSpec): UiNode {
  const localeButton = (locale: string, key: string): UiNode =>
    button({
      label: resourceText(spec.resources, key),
      variant: 'ghost',
      onPress: () => {
        // Смена языка без перезапуска (ED-27): ресурсы меняют локаль и
        // оповещают подписчиков, документы при этом не трогаются вовсе.
        spec.resources.setLocale(locale);
      },
    });

  return el('header', {
    classes: ['fx-bar'],
    children: children(
      el('span', { classes: ['fx-bar__title'], text: resourceText(spec.resources, 'ui.app.title') }),
      searchField(spec),
      button({
        label: resourceText(spec.resources, 'ui.frame.undo'),
        variant: 'ghost',
        icon: 'undo',
        disabled: !spec.canUndo,
        onPress: spec.onUndo,
      }),
      button({
        label: resourceText(spec.resources, 'ui.frame.redo'),
        variant: 'ghost',
        icon: 'redo',
        disabled: !spec.canRedo,
        onPress: spec.onRedo,
      }),
      ...LOCALES.map(([locale, key]) => localeButton(locale, key)),
    ),
  });
}
