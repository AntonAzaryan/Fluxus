/**
 * Шов среды (ED-12) и то, что на нём стоит: перечисление дерева для
 * просмотрщика ассетов (ED-20), наложение несохранённого (ED-9) и переходник к
 * модулю ассетов (ASSET-2, ASSET-4).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  contentPathExtension,
  contentPathName,
  contentPathParent,
  createHostAssetSource,
  createMemoryHost,
  createOverlayHost,
  isInsideContentPath,
  joinContentPath,
  normalizeContentPath,
  walkContentTree,
  type ContentChange,
} from '../src/host/index.js';

const TREE = {
  'scenes/duel.scene.json': '{"components":[]}\n',
  'visuals/manifest.json': '{"entities":{}}\n',
  'visuals/models/hero.mdx': 'MDLX',
  'visuals/textures/skin.png': 'PNG',
  'i18n/ru.json': '{"component.Hero":"Герой"}\n',
};

const decoder = new TextDecoder();

describe('ED-12: путь в дереве контента — свойство дерева, а не среды', () => {
  it('нормализация приводит разделители и убирает пустые сегменты', () => {
    expect(normalizeContentPath('visuals\\models/./hero.mdx')).toBe('visuals/models/hero.mdx');
    expect(normalizeContentPath('/visuals//models/')).toBe('visuals/models');
    expect(normalizeContentPath('')).toBe('');
  });

  it('выход за корень дерева контента запрещён', () => {
    expect(() => normalizeContentPath('../secrets.json')).toThrow(/выходит за корень/);
    expect(() => normalizeContentPath('visuals/../../etc')).toThrow(/выходит за корень/);
  });

  it('разбор пути: имя, каталог, расширение, вложенность', () => {
    expect(contentPathName('visuals/models/hero.mdx')).toBe('hero.mdx');
    expect(contentPathParent('visuals/models/hero.mdx')).toBe('visuals/models');
    expect(contentPathExtension('visuals/models/hero.MDX')).toBe('.mdx');
    expect(contentPathExtension('LICENSE')).toBe('');
    expect(joinContentPath('visuals', 'models/hero.mdx')).toBe('visuals/models/hero.mdx');
    expect(isInsideContentPath('visuals/models/hero.mdx', 'visuals')).toBe(true);
    expect(isInsideContentPath('visualsX/hero.mdx', 'visuals')).toBe(false);
    expect(isInsideContentPath('anything', '')).toBe(true);
  });
});

describe('ED-12: чтение и запись дерева идут только через хост', () => {
  it('записанное читается обратно теми же байтами', async () => {
    const host = createMemoryHost();
    await host.content.write('scenes/duel.scene.json', new TextEncoder().encode('{}\n'));
    expect(decoder.decode(await host.content.read('scenes/duel.scene.json'))).toBe('{}\n');
    expect(host.writes).toEqual(['scenes/duel.scene.json']);
  });

  it('прочитанные байты — копия: правка у потребителя дерева не меняет', async () => {
    const host = createMemoryHost({ files: TREE });
    const bytes = new Uint8Array(await host.content.read('visuals/models/hero.mdx'));
    bytes[0] = 0;
    expect(host.text('visuals/models/hero.mdx')).toBe('MDLX');
  });

  it('отсутствующий файл — ошибка, называющая путь', async () => {
    const host = createMemoryHost();
    await expect(host.content.read('scenes/missing.json')).rejects.toThrow(/scenes\/missing\.json/);
  });

  it('`stat` отличает файл от каталога, а корень — всегда каталог', async () => {
    const host = createMemoryHost({ files: TREE });
    expect(await host.content.stat('visuals/models/hero.mdx')).toEqual({
      path: 'visuals/models/hero.mdx',
      name: 'hero.mdx',
      kind: 'file',
    });
    expect((await host.content.stat('visuals/models'))?.kind).toBe('directory');
    expect((await host.content.stat(''))?.kind).toBe('directory');
    expect(await host.content.stat('visuals/sounds')).toBeUndefined();
  });
});

describe('ED-20: просмотрщику ассетов нужен обход дерева, и он есть только через хост', () => {
  it('`list` перечисляет один уровень в нормированном порядке', async () => {
    const host = createMemoryHost({ files: TREE });
    expect(await host.content.list('')).toEqual([
      { path: 'i18n', name: 'i18n', kind: 'directory' },
      { path: 'scenes', name: 'scenes', kind: 'directory' },
      { path: 'visuals', name: 'visuals', kind: 'directory' },
    ]);
    expect((await host.content.list('visuals')).map((entry) => entry.name)).toEqual([
      'manifest.json',
      'models',
      'textures',
    ]);
  });

  it('обход отдаёт каталог перед его содержимым и порядок, не зависящий от среды', async () => {
    const host = createMemoryHost({ files: TREE });
    expect((await walkContentTree(host.content)).map((entry) => entry.path)).toEqual([
      'i18n',
      'i18n/ru.json',
      'scenes',
      'scenes/duel.scene.json',
      'visuals',
      'visuals/manifest.json',
      'visuals/models',
      'visuals/models/hero.mdx',
      'visuals/textures',
      'visuals/textures/skin.png',
    ]);
  });

  it('обход фильтруется по файлам и пропускает каталоги целиком', async () => {
    const host = createMemoryHost({ files: TREE });
    const models = await walkContentTree(host.content, 'visuals', {
      acceptFile: (entry) => contentPathExtension(entry.path) === '.mdx',
      skipDirectory: (entry) => entry.name === 'textures',
    });
    expect(models.map((entry) => entry.path)).toEqual(['visuals/models', 'visuals/models/hero.mdx']);
  });

  it('глубина обхода ограничена: ссылка на предка не должна вешать просмотрщик', async () => {
    const host = createMemoryHost({ files: TREE });
    const shallow = await walkContentTree(host.content, '', { maxDepth: 1 });
    expect(shallow.map((entry) => entry.path)).toEqual(['i18n', 'scenes', 'visuals']);
  });
});

describe('ED-12: реакция на изменение дерева извне', () => {
  it('наблюдатель получает и чужую правку, и запись самого редактора', async () => {
    const host = createMemoryHost({ files: TREE });
    const seen: ContentChange[] = [];
    const stop = host.content.watch((change) => seen.push(change));

    host.set('scenes/duel.scene.json', '{"components":[{"name":"Pos"}]}\n');
    await host.content.write('visuals/manifest.json', new TextEncoder().encode('{}\n'));
    host.set('scenes/new.scene.json', '{}\n');
    host.remove('i18n/ru.json');

    expect(seen).toEqual([
      { path: 'scenes/duel.scene.json', kind: 'modified' },
      { path: 'visuals/manifest.json', kind: 'modified' },
      { path: 'scenes/new.scene.json', kind: 'created' },
      { path: 'i18n/ru.json', kind: 'removed' },
    ]);

    stop();
    host.set('scenes/duel.scene.json', '{}\n');
    expect(seen).toHaveLength(4);
  });
});

describe('ED-12: выбор файлов и оконная интеграция — через тот же хост', () => {
  it('отказ пользователя и отсутствие диалога у среды выражаются одинаково', async () => {
    const silent = createMemoryHost();
    expect(await silent.picker.chooseRoot()).toBeUndefined();
    expect(await silent.picker.chooseFile({ extensions: ['.mdx'] })).toBeUndefined();
    expect(silent.choiceRequests).toEqual([{ kind: 'root' }, { kind: 'file', request: { extensions: ['.mdx'] } }]);
  });

  it('выбранный корень становится корнем хоста', async () => {
    const host = createMemoryHost({ choices: { root: { label: 'demo-project' } } });
    expect(host.root).toBeUndefined();
    expect(await host.picker.chooseRoot()).toEqual({ label: 'demo-project' });
    expect(host.root).toEqual({ label: 'demo-project' });
  });

  it('окно узнаёт о несохранённом и спрашивает разрешения на закрытие', () => {
    const host = createMemoryHost();
    host.window.setTitle('duel.scene.json');
    host.window.setUnsaved(true);
    expect(host.windowState).toEqual({ title: 'duel.scene.json', unsaved: true });

    const stop = host.window.onCloseRequest(() => false);
    expect(host.requestClose()).toBe(false);
    stop();
    expect(host.requestClose()).toBe(true);
  });
});

describe('ED-9, ED-21: наложение держит несохранённое, не касаясь дерева контента', () => {
  it('чтение берёт наложение, основа остаётся нетронутой', async () => {
    const base = createMemoryHost({ files: TREE, name: 'disk' });
    const staged = createOverlayHost(base);

    await staged.content.write('scenes/duel.scene.json', new TextEncoder().encode('{"components":[1]}\n'));

    expect(decoder.decode(await staged.content.read('scenes/duel.scene.json'))).toBe('{"components":[1]}\n');
    expect(base.text('scenes/duel.scene.json')).toBe(TREE['scenes/duel.scene.json']);
    expect(base.writes).toEqual([]);
    expect(staged.overlay.paths()).toEqual(['scenes/duel.scene.json']);
  });

  it('перечисление сливает наложение с основой без дублей', async () => {
    const base = createMemoryHost({ files: TREE });
    const staged = createOverlayHost(base);
    await staged.content.write('scenes/duel.scene.json', new TextEncoder().encode('{}\n'));
    await staged.content.write('scenes/draft.scene.json', new TextEncoder().encode('{}\n'));

    expect((await staged.content.list('scenes')).map((entry) => entry.name)).toEqual([
      'draft.scene.json',
      'duel.scene.json',
    ]);
    expect((await staged.content.stat('visuals/models/hero.mdx'))?.kind).toBe('file');
  });

  it('корень, диалоги и окно наложение не подменяет: среда та же', () => {
    const base = createMemoryHost({ root: { label: 'demo' } });
    const staged = createOverlayHost(base);
    expect(staged.root).toEqual({ label: 'demo' });
    expect(staged.picker).toBe(base.picker);
    expect(staged.window).toBe(base.window);
  });
});

describe('ASSET-2: модуль ассетов и редактор читают одно дерево одним швом', () => {
  it('источник ассетов читает те же байты, что и документы', async () => {
    const host = createMemoryHost({ files: TREE });
    const source = createHostAssetSource(host.content);
    expect(decoder.decode(await source.read('visuals/models/hero.mdx'))).toBe('MDLX');
    source.dispose();
  });

  it('источник поверх наложения отдаёт несохранённую правку манифеста (ED-9, ED-19)', async () => {
    const base = createMemoryHost({ files: TREE });
    const staged = createOverlayHost(base);
    await staged.content.write('visuals/manifest.json', new TextEncoder().encode('{"entities":{"Hero":{}}}\n'));

    const source = createHostAssetSource(staged.content);
    expect(decoder.decode(await source.read('visuals/manifest.json'))).toBe('{"entities":{"Hero":{}}}\n');
    expect(base.text('visuals/manifest.json')).toBe(TREE['visuals/manifest.json']);
    source.dispose();
  });

  it('поколение и уведомление называют момент, когда кэш ассетов пора выбросить', async () => {
    const host = createMemoryHost({ files: TREE });
    const source = createHostAssetSource(host.content);
    const stale = vi.fn();
    source.onStale(stale);

    expect(source.generation).toBe(0);
    host.set('visuals/textures/skin.png', 'PNG2');
    expect(source.generation).toBe(1);
    expect(stale).toHaveBeenCalledWith('visuals/textures/skin.png');

    await host.content.write('visuals/manifest.json', new TextEncoder().encode('{}\n'));
    expect(source.generation).toBe(2);

    source.dispose();
    host.set('visuals/textures/skin.png', 'PNG3');
    expect(source.generation).toBe(2);
  });
});
