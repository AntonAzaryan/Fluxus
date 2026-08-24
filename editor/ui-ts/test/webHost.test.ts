/**
 * ED-12: «Всё, чем среды различаются — чтение и запись дерева контента, реакция
 * на его изменение извне, выбор файлов и каталогов, оконная интеграция — SHALL
 * быть скрыто за одним интерфейсом хоста среды, имеющим реализацию в каждой из
 * них».
 *
 * Здесь проверяется веб-реализация: сеть подставлена структурным дублём
 * `fetch`, потому что проверяется не HTTP, а поведение шва — чтение по пути от
 * корня дерева (он же ID ассета, ASSET-2), перечисление в нормированном порядке
 * (одинаковом во всех средах), запись и уведомление наблюдателей.
 *
 * Отдельно проверено то, о чём легче всего соврать: среда без эндпойнта дерева
 * (статическая выкладка) обязана отказать, называя путь, а не показать пустой
 * каталог и «успешную» запись.
 */
import { describe, expect, it } from 'vitest';
import { createHostAssetSource } from '@fluxus/editor-core';
import { createWebHost, type HttpFetch, type HttpRequest, type HttpResponse } from '../src/host/web.js';
import { resolveInside } from '../app/contentEndpoint.js';

const encoder = new TextEncoder();

interface Call {
  readonly url: string;
  readonly init?: HttpRequest;
}

function response(status: number, payload: unknown, bytes?: Uint8Array): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => {
      const source = bytes ?? new Uint8Array();
      const out = new ArrayBuffer(source.byteLength);
      new Uint8Array(out).set(source);
      return Promise.resolve(out);
    },
    json: () =>
      payload === undefined ? Promise.reject(new Error('не JSON')) : Promise.resolve(payload),
  };
}

/** Дубль сети: дерево задаётся таблицей ответов, вызовы записываются. */
function net(answers: Record<string, () => HttpResponse>): {
  fetch: HttpFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      const answer = answers[url];
      return Promise.resolve(answer === undefined ? response(404, { kind: 'missing' }) : answer());
    },
  };
}

describe('ED-12: чтение дерева — тот же путь, что у ID ассета', () => {
  it('read берёт байты по пути от корня дерева', async () => {
    const { fetch, calls } = net({
      '/visuals/manifest.json': () => response(200, undefined, encoder.encode('{}')),
    });
    const host = createWebHost({ fetch });
    const bytes = new Uint8Array(await host.content.read('visuals/manifest.json'));
    expect(new TextDecoder().decode(bytes)).toBe('{}');
    expect(calls[0]?.url).toBe('/visuals/manifest.json');
  });

  it('модуль ассетов читает то же дерево тем же швом (ASSET-2)', async () => {
    const { fetch, calls } = net({
      '/visuals/models/hero.mdx': () => response(200, undefined, encoder.encode('mdx')),
    });
    const host = createWebHost({ fetch });
    const source = createHostAssetSource(host.content);
    await source.read('visuals/models/hero.mdx');
    expect(calls[0]?.url).toBe('/visuals/models/hero.mdx');
  });

  it('отсутствующий файл — ошибка, называющая путь', async () => {
    const host = createWebHost({ fetch: net({}).fetch });
    await expect(host.content.read('scenes/missing.json')).rejects.toThrow('scenes/missing.json');
  });
});

describe('ED-12, ED-20: перечисление каталога — часть шва', () => {
  const listing = (): HttpResponse =>
    response(200, {
      kind: 'directory',
      entries: [
        { name: 'models', kind: 'directory' },
        { name: 'arena-curvature.json', kind: 'file' },
        { name: 'manifest.json', kind: 'file' },
      ],
    });

  it('порядок нормирован и не зависит от порядка ответа среды', async () => {
    const host = createWebHost({ fetch: net({ '/__content?path=visuals': listing }).fetch });
    const entries = await host.content.list('visuals');
    expect(entries.map((entry) => entry.name)).toEqual([
      'arena-curvature.json',
      'manifest.json',
      'models',
    ]);
    expect(entries.map((entry) => entry.path)).toContain('visuals/models');
  });

  it('stat отвечает о том, что лежит по пути', async () => {
    const host = createWebHost({
      fetch: net({
        '/__content?path=visuals%2Fmanifest.json': () => response(200, { kind: 'file' }),
      }).fetch,
    });
    expect(await host.content.stat('visuals/manifest.json')).toEqual({
      path: 'visuals/manifest.json',
      name: 'manifest.json',
      kind: 'file',
    });
    expect((await host.content.stat(''))?.kind).toBe('directory');
  });

  it('несуществующего каталога нет — пустой список, как и у хоста в памяти', async () => {
    const host = createWebHost({
      fetch: net({ '/__content?path=visuals%2Fmissing': () => response(200, { kind: 'missing' }) })
        .fetch,
    });
    expect(await host.content.list('visuals/missing')).toEqual([]);
    expect(await host.content.stat('visuals/missing')).toBeUndefined();
  });

  it('среда без эндпойнта дерева отказывает, а не притворяется пустым каталогом', async () => {
    // Статическая выкладка отвечает на такой запрос чем угодно, кроме ответа о
    // дереве. Показать это пустым списком значило бы соврать автору о проекте.
    const host = createWebHost({
      fetch: net({ '/__content?path=visuals': () => response(200, { hello: 'index.html' }) }).fetch,
    });
    await expect(host.content.list('visuals')).rejects.toThrow('visuals');
  });
});

describe('CONT-1: за корень дерева контента не выходит ничего', () => {
  it('выход за корень отвергается до сети, а не сетью', async () => {
    const { fetch, calls } = net({});
    const host = createWebHost({ fetch });
    await expect(host.content.read('../engine/core-ts/package.json')).rejects.toThrow('корень');
    await expect(host.content.list('..')).rejects.toThrow('корень');
    await expect(host.content.write('../x.json', new Uint8Array())).rejects.toThrow('корень');
    expect(calls).toEqual([]);
  });

  it('вторая граница — серверная: эндпойнт сам решает, что лежит в дереве', () => {
    const root = '/srv/content';
    expect(resolveInside(root, 'visuals/manifest.json')).toBe('/srv/content/visuals/manifest.json');
    // Абсолютный путь читается как путь ОТ КОРНЯ ДЕРЕВА, а не от корня диска.
    expect(resolveInside(root, '/etc/passwd')).toBe('/srv/content/etc/passwd');
    expect(resolveInside(root, '')).toBe(root);
    for (const escape of ['../secrets', 'a/../../secrets', '..', '..\\secrets', 'a/./../../b']) {
      expect(resolveInside(root, escape), escape).toBeNull();
    }
    // Сосед с общим префиксом именем каталога не является.
    expect(resolveInside('/srv/content', '../content-private/x')).toBeNull();
  });

  it('отказ эндпойнта со своей причиной её и называет, а не подменяет догадкой', async () => {
    const host = createWebHost({
      fetch: net({
        '/__content?path=visuals': () =>
          response(500, { kind: 'missing', reason: 'EACCES: доступ к каталогу закрыт' }),
      }).fetch,
    });
    // Иначе автор пошёл бы искать отсутствующий эндпойнт вместо своих прав.
    await expect(host.content.list('visuals')).rejects.toThrow('EACCES');
  });
});

describe('ED-12: запись документа и реакция на изменение дерева', () => {
  it('write отдаёт байты среде и называет путь, если записи там нет', async () => {
    const written: Call[] = [];
    const fetch: HttpFetch = (url, init) => {
      written.push({ url, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(response(201, { kind: 'file', created: true }));
    };
    const host = createWebHost({ fetch });
    const changes: string[] = [];
    host.content.watch((change) => changes.push(`${change.kind}:${change.path}`));

    await host.content.write('scenes/duel.scene.json', encoder.encode('{}'));
    expect(written[0]?.url).toBe('/__content?path=scenes%2Fduel.scene.json');
    expect(written[0]?.init?.method).toBe('PUT');
    // Наблюдатели узнают и о собственной записи редактора: на этом держится
    // свежесть кэша ассетов (`createHostAssetSource`).
    expect(changes).toEqual(['created:scenes/duel.scene.json']);

    const refusing = createWebHost({ fetch: net({}).fetch });
    await expect(refusing.content.write('scenes/duel.scene.json', new Uint8Array())).rejects.toThrow(
      'scenes/duel.scene.json',
    );
  });

  it('внешняя правка дерева доходит до наблюдателей через канал оболочки', () => {
    const pushes: ((path: string, kind: 'created' | 'modified' | 'removed') => void)[] = [];
    const host = createWebHost({
      fetch: net({}).fetch,
      changes: (listener) => {
        pushes.push(listener);
        return () => undefined;
      },
    });
    const push = pushes[0];
    expect(push).toBeDefined();
    const seen: string[] = [];
    const stop = host.content.watch((change) => seen.push(`${change.kind}:${change.path}`));
    push?.('/visuals/manifest.json', 'modified');
    expect(seen).toEqual(['modified:visuals/manifest.json']);
    stop();
    push?.('visuals/manifest.json', 'modified');
    expect(seen).toHaveLength(1);
  });

  it('без канала хост молчит о чужих правках — и это допустимо швом', () => {
    const host = createWebHost({ fetch: net({}).fetch });
    let seen = 0;
    const stop = host.content.watch(() => seen++);
    expect(typeof stop).toBe('function');
    expect(seen).toBe(0);
  });
});

describe('ED-12: диалоги и окно среды', () => {
  it('корень — свойство оболочки; диалогов выбора у вкладки нет', async () => {
    const host = createWebHost({ fetch: net({}).fetch, root: { label: 'content' } });
    expect(host.root?.label).toBe('content');
    expect(await host.picker.chooseRoot()).toEqual({ label: 'content' });
    // Отказ автора и отсутствие диалога выражены одинаково — вызывающий
    // пишется один раз (шов `ContentPicker`).
    expect(await host.picker.chooseFile()).toBeUndefined();
    expect(await host.picker.chooseDirectory()).toBeUndefined();
  });

  it('несохранённое держит вкладку: закрытие спрашивают, пока редактор отвечает «нельзя»', () => {
    const listeners: ((event: { preventDefault(): void; returnValue?: unknown }) => void)[] = [];
    const host = createWebHost({
      fetch: net({}).fetch,
      window: {
        addEventListener: (_type, listener) => listeners.push(listener),
        removeEventListener: () => undefined,
      },
      documentTitle: { set: () => undefined },
    });
    host.window.onCloseRequest(() => false);

    let prevented = 0;
    const ask = (): void => {
      for (const listener of listeners) listener({ preventDefault: () => prevented++ });
    };
    ask();
    expect(prevented).toBe(0);
    host.window.setUnsaved(true);
    ask();
    expect(prevented).toBe(1);
  });

  it('заголовок уходит среде, а не пишется мимо шва', () => {
    const titles: string[] = [];
    const host = createWebHost({ fetch: net({}).fetch, documentTitle: { set: (v) => titles.push(v) } });
    host.window.setTitle('Fluxus');
    expect(titles).toEqual(['Fluxus']);
  });
});
