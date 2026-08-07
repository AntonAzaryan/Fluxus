/**
 * Обнаружение протухшего перевода (ED-28): английское описание переписали, а
 * перевод остался прежним — и это должно быть видно, а не выясняться на глаз
 * при следующем чтении обоих файлов.
 *
 * Отпечатки лежат в отдельном генерируемом файле-спутнике локали, а не внутри
 * бандла. Причина та же, по какой `engine/schemas/` не правят руками: бандл —
 * плоская карта строк, которую открывает переводчик и любой инструмент
 * перевода, и машинным данным в нём делать нечего; спутник же целиком
 * порождается из пары бандлов и правится только регенерацией.
 *
 * Запись хранит два отпечатка — английского текста и перевода на момент
 * подтверждения. Одного мало: если бы записывался только английский, повторная
 * генерация после правки английского молча подтверждала бы неизменившийся
 * перевод, то есть стирала бы ровно тот сигнал, ради которого файл заведён.
 * По паре отпечатков правило подтверждения механическое: подтверждается тот
 * ключ, чей перевод с прошлого раза изменился.
 */
import { fnv1a32 } from '@game-mvp/core';
import type { LocaleBundle, LocaleId } from './resources.js';

/**
 * FNV-1a 32 из ядра поверх UTF-8 — реализации своего хеша здесь нет (ED-1).
 * Ширины хватает: отпечатки сравниваются поключно, и совпадение требуется от
 * переписанного описания того же поля, а не от любой пары строк бандла.
 */
export function fingerprint(text: string): string {
  return fnv1a32(new TextEncoder().encode(text)).toString(16).padStart(8, '0');
}

export interface FingerprintEntry {
  /** Отпечаток текста локали-источника (`en`) на момент подтверждения перевода. */
  readonly source: string;
  /** Отпечаток самого перевода на тот же момент — по нему видно, что перевод с тех пор трогали. */
  readonly translated: string;
}

export interface FingerprintFile {
  readonly locale: LocaleId;
  readonly source: LocaleId;
  readonly entries: Readonly<Record<string, FingerprintEntry>>;
}

/**
 * Пересборка спутника: ключ подтверждается заново, если его перевод изменился
 * с прошлого подтверждения (или подтверждается впервые); иначе прежняя запись
 * сохраняется как есть — вместе с прежним отпечатком английского, из-за
 * расхождения с которым перевод и числится протухшим. Ключи, которых больше
 * нет ни в источнике, ни в переводе, из спутника уходят.
 */
export function confirmTranslations(
  locale: LocaleId,
  source: LocaleBundle,
  translated: LocaleBundle,
  previous: FingerprintFile | undefined,
  sourceLocale = 'en',
): FingerprintFile {
  const entries: Record<string, FingerprintEntry> = {};
  for (const key of Object.keys(translated).sort()) {
    const sourceText = source[key];
    if (sourceText === undefined) continue;
    const translatedPrint = fingerprint(translated[key] ?? '');
    const before = previous?.entries[key];
    entries[key] =
      before !== undefined && before.translated === translatedPrint
        ? before
        : { source: fingerprint(sourceText), translated: translatedPrint };
  }
  return { locale, source: sourceLocale, entries };
}

/**
 * Канонический текст файла-спутника: ключи отсортированы, отступ два пробела,
 * перевод строки в конце. Форма — как у генерируемых схем ядра: файл переписан
 * генератором целиком, и дифф в нём должен показывать только изменившиеся
 * ключи.
 */
export function fingerprintFileContent(file: FingerprintFile): string {
  const entries: Record<string, FingerprintEntry> = {};
  for (const key of Object.keys(file.entries).sort()) entries[key] = file.entries[key]!;
  return `${JSON.stringify({ locale: file.locale, source: file.source, entries }, null, 2)}\n`;
}

export interface TranslationStatus {
  /** Английское описание переписано, перевод не тронут — перевод протух (ED-28). */
  readonly stale: readonly string[];
  /** Перевод изменился с последнего подтверждения: спутник не пересобран. */
  readonly unconfirmed: readonly string[];
  /** Ключ есть в источнике и отсутствует в переводе. */
  readonly missing: readonly string[];
}

/** Состояние перевода по трём непересекающимся признакам. */
export function translationStatus(
  source: LocaleBundle,
  translated: LocaleBundle,
  file: FingerprintFile,
): TranslationStatus {
  const stale: string[] = [];
  const unconfirmed: string[] = [];
  const missing: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const translation = translated[key];
    if (translation === undefined) {
      missing.push(key);
      continue;
    }
    const entry = file.entries[key];
    if (entry === undefined || entry.translated !== fingerprint(translation)) {
      unconfirmed.push(key);
      continue;
    }
    if (entry.source !== fingerprint(source[key] ?? '')) stale.push(key);
  }
  return { stale, unconfirmed, missing };
}
