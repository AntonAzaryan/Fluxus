/**
 * Строки хрома редактора — те самые `ui.*`, которых сознательно нет в
 * `@game-mvp/editor-core`: их «приносит тот, кто приносит сам интерфейс»
 * (см. `editorBundles.ts` соседнего пакета). Подпись кнопки, которой не
 * существует, ничем не лучше отсутствующей, поэтому бандл живёт здесь и растёт
 * вместе с виджетами.
 *
 * Корень `ui.` выбран не произвольно: пространство описаний полей (ED-28)
 * закрыто списком видов в `keys.ts` ядра редактора, и строки хрома в отчёт об
 * осиротевших ресурсах не попадают именно потому, что лежат вне него.
 *
 * Локали `ru` и `en` равноправны (ED-27): у обеих один и тот же набор ключей,
 * и это проверяется тестом, а не порядком в редакторе.
 */
import {
  EDITOR_BUNDLES,
  StringResources,
  type LocaleBundle,
  type LocaleBundles,
  type LocaleId,
} from '@game-mvp/editor-core';
import en from './locales/ui.en.json';
import ru from './locales/ui.ru.json';
import validationEn from './locales/validation.en.json';
import validationRu from './locales/validation.ru.json';

/** Префикс пространства строк хрома. */
export const UI_KEY_PREFIX = 'ui.';

export const UI_BUNDLES: LocaleBundles = { en, ru };

/**
 * Причины находок валидации (ED-8, ED-30) — отдельным бандлом, а не среди строк
 * хрома, и это не аккуратность ради аккуратности.
 *
 * Ключ причины выводится из пары «правило + код» (`reasonKey` ядра редактора), а
 * не из места, где причина показана: тот же ключ читает внешний потребитель,
 * которому интерфейса не видно вовсе. Поэтому пространство у него своё —
 * `validation.*`, — и складывать его в `ui.*` значило бы называть строку по
 * месту показа, то есть заводить ту самую ручную связь, которую ED-28 запрещает
 * для описаний полей.
 *
 * Живут они здесь временно: правило `editor.curvatureGrid` приходит из
 * `@game-mvp/editor-core`, и там же его причине место — вместе с остальными
 * тремя междокументными правилами, чьи причины интерфейс пока не показывает.
 */
export const VALIDATION_BUNDLES: LocaleBundles = { en: validationEn, ru: validationRu };

function merge(locale: LocaleId): LocaleBundle {
  return {
    ...(EDITOR_BUNDLES[locale] ?? {}),
    ...(VALIDATION_BUNDLES[locale] ?? {}),
    ...(UI_BUNDLES[locale] ?? {}),
  };
}

/**
 * Ресурсы интерфейса: описания полей из бандла редактора плюс строки хрома
 * отсюда. Слияние, а не вторая цепочка разрешения: у `StringResources` уже
 * есть два уровня (проект поверх редактора), и третий сделал бы порядок
 * разрешения неочевидным ради одного пакета.
 */
export function uiResources(locale: LocaleId, project?: LocaleBundles): StringResources {
  const editor: LocaleBundles = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(EDITOR_BUNDLES),
        ...Object.keys(VALIDATION_BUNDLES),
        ...Object.keys(UI_BUNDLES),
      ]),
    ].map((id) => [id, merge(id)]),
  );
  return new StringResources({ locale, editor, ...(project === undefined ? {} : { project }) });
}
