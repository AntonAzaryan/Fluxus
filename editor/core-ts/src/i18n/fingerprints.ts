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
import { fnv1a32, prettyJsonSerializer } from '@fluxus/core';
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
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
      before !== undefined && before.translated === translatedPrint
        ? before
        : { source: fingerprint(sourceText), translated: translatedPrint };
  }
  return { locale, source: sourceLocale, entries };
}

/**
 * Канонический текст файла-спутника. Форматирует ядро (`prettyJsonSerializer`),
 * а не своя строка: как выглядит записанный на диск JSON — правило ядра
 * (SER-1, SER-2), и вторая его реализация в редакторе запрещена (ED-1). Своё
 * здесь только одно — сортировка ключей: файл переписывается генератором
 * целиком, и дифф в нём должен показывать изменившиеся ключи, а не их порядок.
 */
export function fingerprintFileContent(file: FingerprintFile): string {
  const entries: Record<string, FingerprintEntry> = {};
  for (const key of Object.keys(file.entries).sort()) entries[key] = file.entries[key]!;
  const bytes = prettyJsonSerializer.encode({ locale: file.locale, source: file.source, entries });
  return new TextDecoder().decode(bytes);
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
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
    if (entry === undefined || entry.translated !== fingerprint(translation)) {
      unconfirmed.push(key);
      continue;
    }
    if (entry.source !== fingerprint(source[key] ?? '')) stale.push(key);
  }
  return { stale, unconfirmed, missing };
}
