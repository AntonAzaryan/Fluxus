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
 * Здесь же — аффорданс прогона и индикация режима (ED-26). Оба стоят именно
 * тут, а не на поверхности правки: бар один на окно и виден из любой рабочей
 * области, а требование говорит и «доступны из любой области», и «режим виден
 * постоянно». Кнопка одна на запуск и выход: состояний ровно два, и вторая
 * кнопка была бы вторым местом, где они перечислены.
 *
 * Пометка режима — чип, а не подпись самой кнопки: кнопка называет действие
 * («запустить», «выйти»), а чип — состояние, и слить их значило бы заставить
 * автора выводить режим из надписи на элементе управления, чего ED-26
 * запрещает прямым текстом.
 *
 * Чего здесь нет намеренно: палитры команд и списка результатов поиска (ED-24)
 * — задача W2-3. Строка поиска стоит здесь уже сейчас, потому что её запрос —
 * сквозное состояние сессии: он не должен теряться от перехода в другую область.
 */
import type { StringResources } from '@fluxus/editor-core';
import {
  children,
  documentValue,
  el,
  resourceText,
  type UiNode,
  type UiText,
} from '../dom/node.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { withValidation } from '../widgets/validation.js';
import type { EditorMode } from './preview.js';
import { eventValue } from '../widgets/field.js';

export interface TopBarSpec {
  readonly resources: StringResources;
  readonly query: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Текущий режим (ED-26): его показывает чип, а не поведение инструментов. */
  readonly mode: EditorMode;
  /** Есть ли что запускать; `false` — элемент показан недоступным (ED-26). */
  readonly canPreview: boolean;
  /** Причина, по которой прогон не состоялся; `null` — причины нет (ED-8). */
  readonly previewFailure: string | null;
  /**
   * Причина отказа последнего действия — открытия проекта, сохранения (ED-8,
   * ED-21). Стоит здесь по тому же основанию, что и режим: бар один на окно и
   * виден из любой области, а действие, отказавшее молча, автору не видно.
   * Текст приходит от того, кто отказал: каркас его не сочиняет (ED-27).
   */
  readonly notice: UiText | null;
  readonly onQuery: (query: string) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onPreview: () => void;
}

/** Подписи режима и действия — ключи ресурсов (ED-27), по одному на состояние. */
const MODE_LABELS: Readonly<Record<EditorMode, string>> = {
  edit: 'ui.chip.editMode',
  preview: 'ui.chip.previewMode',
};

const PREVIEW_LABELS: Readonly<Record<EditorMode, string>> = {
  edit: 'ui.action.preview',
  preview: 'ui.action.previewStop',
};

const LOCALES: readonly (readonly [string, string])[] = [
  ['ru', 'ui.locale.ru'],
  ['en', 'ui.locale.en'],
];

/**
 * Строка поиска отдаёт запрос посимвольно: по нему открывается палитра, а
 * палитра обязана сужаться по мере набора — иначе поиск при сотнях документов
 * не отличается от прохода по дереву (ED-24).
 *
 * Фокус при этом не теряется, хотя страница и пересобирается на каждый символ:
 * первый же символ переносит набор в строку запроса палитры, куда каркас и
 * просит вернуть фокус (`frame.ts`). Оставлять набор здесь было бы вторым полем
 * с тем же содержимым.
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
      input: (event: Event) => {
        const value = eventValue(event);
        if (value !== undefined) spec.onQuery(value);
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

  const preview = spec.mode === 'preview';
  return el('header', {
    classes: ['fx-bar'],
    children: children(
      el('span', { classes: ['fx-bar__title'], text: resourceText(spec.resources, 'ui.app.title') }),
      searchField(spec),
      // Прогон идёт — это включённое состояние, за которым ED-22 акцент и
      // закрепил; правка — обычное, и акцента ей не полагается.
      statusChip({
        label: resourceText(spec.resources, MODE_LABELS[spec.mode]),
        tone: preview ? 'active' : 'neutral',
        icon: preview ? 'play' : 'dot',
      }),
      button({
        label: resourceText(spec.resources, PREVIEW_LABELS[spec.mode]),
        variant: 'primary',
        icon: preview ? 'stop' : 'play',
        disabled: !spec.canPreview,
        onPress: spec.onPreview,
      }),
      // Причина — не оттенок: иконку, положение и текст ставит один вызов
      // (ED-8, ED-22), а сам текст приходит оттуда, где прогон не задался.
      spec.previewFailure === null
        ? undefined
        : withValidation(
            statusChip({
              label: resourceText(spec.resources, 'ui.preview.failed'),
              tone: 'error',
            }),
            { severity: 'error', reason: documentValue(spec.previewFailure) },
          ),
      // Отказ действия — иконка, положение и текст причины, а не оттенок
      // (ED-8, ED-22). Рядом с причиной сорвавшегося прогона: обе — «то, что
      // редактор попробовал и не смог», и разводить их по разным местам
      // значило бы заставить автора искать ответ в двух.
      spec.notice === null
        ? undefined
        : withValidation(
            statusChip({
              label: resourceText(spec.resources, 'ui.frame.refused'),
              tone: 'error',
            }),
            { severity: 'error', reason: spec.notice },
          ),
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
