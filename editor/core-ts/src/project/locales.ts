/**
 * Бандлы локалей проекта (ED-27). Они лежат в дереве контента — `i18n/<locale>.json`,
 * имя задаёт `i18n/resources.ts`, — а читаются, как и всё в дереве, через хост
 * среды (ED-12): у слоя строковых ресурсов файловой системы нет и не должно
 * быть.
 *
 * Сбой чтения одной локали не мешает остальным и не мешает открыть проект:
 * отсутствующего файла локали в дереве может не быть вовсе (описания
 * компонентов пишет тот, кто объявил компонент, и он вправе их не писать), а
 * испорченный файл автор обязан увидеть — поэтому он возвращается отчётом, а не
 * исключением.
 */
import { SHIPPED_LOCALES, projectBundlePath } from '../i18n/resources.js';
import type { LocaleBundle, LocaleBundles, LocaleId } from '../i18n/resources.js';
import type { ContentTreeHost } from '../host/index.js';
import { decodeDocument } from './canonical.js';
import { isJsonObject, type JsonValue } from '../document/json.js';

export interface ProjectBundleFailure {
  readonly locale: LocaleId;
  readonly path: string;
  readonly reason: string;
}

export interface ProjectBundlesResult {
  readonly bundles: LocaleBundles;
  /** Локали, чей файл в дереве есть, но прочитать его как бандл не вышло. */
  readonly failures: readonly ProjectBundleFailure[];
}

/**
 * Итог чтения одного файла локали: бандл, причина отказа либо `undefined` —
 * «файла в дереве нет», что отказом не является.
 */
type BundleRead = { readonly bundle: LocaleBundle } | { readonly reason: string } | undefined;

async function readBundle(host: ContentTreeHost, path: string): Promise<BundleRead> {
  const found = await host.stat(path);
  if (found?.kind !== 'file') return undefined;
  let parsed: JsonValue;
  try {
    parsed = decodeDocument(await host.read(path));
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  if (!isJsonObject(parsed)) return { reason: 'бандл локали — плоская карта «ключ → строка»' };
  const bundle: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return { reason: `значение ключа "${key}" — не строка` };
    bundle[key] = value;
  }
  return { bundle };
}

export async function loadProjectBundles(
  host: ContentTreeHost,
  locales: readonly LocaleId[] = SHIPPED_LOCALES,
): Promise<ProjectBundlesResult> {
  const bundles: Record<LocaleId, LocaleBundle> = {};
  const failures: ProjectBundleFailure[] = [];

  for (const locale of locales) {
    const path = projectBundlePath(locale);
    const read = await readBundle(host, path);
    if (read === undefined) continue;
    if ('reason' in read) failures.push({ locale, path, reason: read.reason });
    else bundles[locale] = read.bundle;
  }

  return { bundles, failures };
}
