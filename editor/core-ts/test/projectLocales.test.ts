/**
 * Бандлы локалей проекта (ED-27) читаются из дерева контента через хост среды
 * (ED-12): у слоя строковых ресурсов файловой системы нет, и второго пути к
 * файлам локалей не существует.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../src/host/index.js';
import { loadProjectBundles } from '../src/project/index.js';
import { EDITOR_BUNDLES, PROJECT_BUNDLE_DIR, StringResources, projectBundlePath } from '../src/i18n/index.js';

describe('ED-27: бандлы локалей проекта живут в дереве контента', () => {
  it('читаются по соглашению `i18n/<locale>.json` и ложатся поверх бандла редактора', async () => {
    expect(projectBundlePath('ru')).toBe(`${PROJECT_BUNDLE_DIR}/ru.json`);
    const host = createMemoryHost({
      files: {
        'i18n/ru.json': '{"component.Hero":"Герой"}\n',
        'i18n/en.json': '{"component.Hero":"Hero"}\n',
      },
    });

    const { bundles, failures } = await loadProjectBundles(host.content);

    expect(failures).toEqual([]);
    expect(bundles).toEqual({ en: { 'component.Hero': 'Hero' }, ru: { 'component.Hero': 'Герой' } });

    const resources = new StringResources({ locale: 'ru', editor: EDITOR_BUNDLES, project: bundles });
    expect(resources.describe(['component', 'Hero'])).toBe('Герой');
  });

  it('отсутствующего файла локали в дереве может не быть вовсе', async () => {
    const host = createMemoryHost({ files: { 'i18n/ru.json': '{}\n' } });
    const { bundles, failures } = await loadProjectBundles(host.content);
    expect(Object.keys(bundles)).toEqual(['ru']);
    expect(failures).toEqual([]);
  });

  it('испорченный файл локали виден отчётом, а не исключением, и не мешает остальным', async () => {
    const host = createMemoryHost({
      files: { 'i18n/ru.json': '{ не json', 'i18n/en.json': '{"a":1}\n' },
    });
    const { bundles, failures } = await loadProjectBundles(host.content);

    expect(bundles).toEqual({});
    expect(failures.map((failure) => failure.locale).sort()).toEqual(['en', 'ru']);
    expect(failures.find((failure) => failure.locale === 'en')?.reason).toContain('"a"');
  });
});
