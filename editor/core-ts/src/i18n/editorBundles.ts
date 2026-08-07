/**
 * Бандлы, которые редактор везёт с собой, и спутник отпечатков к переводу.
 *
 * Лежат в `src/i18n/locales/` и едут с кодом: это строки редактора, а не
 * контента, и в дереве контента им не место (`game-content` CONT-1) — там
 * живут описания того, что объявил проект, и подписи чужого инструмента их
 * дерево хранить не должно.
 *
 * Сегодня бандл покрывает то, что уже существует: словарь DSL (действия и
 * операторы, ED-4, ED-5) и поля форматов документов ядра (SER-5), которые
 * показывает инспектор (ED-24). Строк хрома интерфейса здесь нет — их приносит
 * тот, кто приносит сам интерфейс; выдуманная подпись несуществующей кнопки
 * ничем не лучше отсутствующей.
 */
import type { FingerprintFile } from './fingerprints.js';
import type { LocaleBundles, LocaleId } from './resources.js';
import en from './locales/editor.en.json';
import ru from './locales/editor.ru.json';
import ruFingerprints from './locales/editor.ru.fingerprints.json';

export const EDITOR_BUNDLES: LocaleBundles = { en, ru };

/** Спутник заводится на каждую локаль, кроме локали-источника: `en` не переводят с `en`. */
export const EDITOR_FINGERPRINTS: Readonly<Record<LocaleId, FingerprintFile>> = {
  ru: ruFingerprints,
};
