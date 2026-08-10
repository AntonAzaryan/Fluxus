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

export async function loadProjectBundles(
  host: ContentTreeHost,
  locales: readonly LocaleId[] = SHIPPED_LOCALES,
): Promise<ProjectBundlesResult> {
  const bundles: Record<LocaleId, LocaleBundle> = {};
  const failures: ProjectBundleFailure[] = [];

  for (const locale of locales) {
    const path = projectBundlePath(locale);
    const found = await host.stat(path);
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
    if (found === undefined || found.kind !== 'file') continue;
    let parsed: JsonValue;
    try {
      parsed = decodeDocument(await host.read(path));
    } catch (error) {
      failures.push({ locale, path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!isJsonObject(parsed)) {
      failures.push({ locale, path, reason: 'бандл локали — плоская карта «ключ → строка»' });
      continue;
    }
    const bundle: Record<string, string> = {};
    let broken: string | undefined;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        broken = key;
        break;
      }
      bundle[key] = value;
    }
    if (broken !== undefined) {
      failures.push({ locale, path, reason: `значение ключа "${broken}" — не строка` });
      continue;
    }
    bundles[locale] = bundle;
  }

  return { bundles, failures };
}
