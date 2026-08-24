/**
 * Строки хрома редактора — те самые `ui.*`, которых сознательно нет в
 * `@fluxus/editor-core`: их «приносит тот, кто приносит сам интерфейс»
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
} from '@fluxus/editor-core';
import en from './locales/ui.en.json';
import ru from './locales/ui.ru.json';
import { CAMERA_EFFECT_BUNDLES } from './cameraEffectBundles.js';

/** Префикс пространства строк хрома. */
export const UI_KEY_PREFIX = 'ui.';

export const UI_BUNDLES: LocaleBundles = { en, ru };

/*
 * Причин находок валидации (`validation.*`, ED-8, ED-30) здесь нет: ключ причины
 * выводится из пары «правило + код» (`reasonKey`), правила живут в
 * `@fluxus/editor-core`, и его же бандл несёт их причины. Копия в этом пакете
 * была бы вторым определением той же строки — расходиться ей с оригиналом ничто
 * не мешает, а заметить расхождение некому.
 */
function merge(locale: LocaleId, contributed: readonly LocaleBundles[]): LocaleBundle {
  return {
    ...(EDITOR_BUNDLES[locale] ?? {}),
    ...(UI_BUNDLES[locale] ?? {}),
    // Описания типов эффектов камеры (ED-28) — своё пространство и свой бандл
    // (`cameraEffectBundles.ts`): в бандл хрома они не помещаются по префиксу, а
    // в бандл ядра редактора — потому что вывести их пути оно не может.
    ...(CAMERA_EFFECT_BUNDLES[locale] ?? {}),
    // Бандлы вкладов, которых пакет интерфейса не везёт с собой (ED-25, ED-27):
    // описание операции и причины находок принадлежат тому, кто объявил
    // операцию и правило, и заводить их копию здесь значило бы завести второй
    // набор формулировок, расходящийся с оригиналом молча (ED-28). Приносит их
    // сборка — она и решает, какие вклады в редакторе есть.
    ...contributed.reduce<LocaleBundle>((into, bundles) => ({ ...into, ...(bundles[locale] ?? {}) }), {}),
  };
}

/**
 * Ресурсы интерфейса: описания полей из бандла редактора плюс строки хрома
 * отсюда и бандлы вкладов, которые принесла сборка. Слияние, а не вторая
 * цепочка разрешения: у `StringResources` уже есть два уровня (проект поверх
 * редактора), и третий сделал бы порядок разрешения неочевидным ради одного
 * пакета.
 *
 * Бандлы вкладов идут ПОСЛЕДНИМИ отдельным аргументом, а не уровнем проекта:
 * уровень проекта приходит и уходит вместе с открытым проектом
 * (`setProjectBundles`), а вклад живёт столько же, сколько редактор.
 */
export function uiResources(
  locale: LocaleId,
  project?: LocaleBundles,
  ...contributed: readonly LocaleBundles[]
): StringResources {
  const editor: LocaleBundles = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(EDITOR_BUNDLES),
        ...Object.keys(UI_BUNDLES),
        ...Object.keys(CAMERA_EFFECT_BUNDLES),
        ...contributed.flatMap((bundles) => Object.keys(bundles)),
      ]),
    ].map((id) => [
      id,
      merge(id, contributed),
    ]),
  );
  return new StringResources({ locale, editor, ...(project === undefined ? {} : { project }) });
}
