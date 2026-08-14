/**
 * Десктопная реализация хоста среды (ED-12) поверх моста контейнера
 * (`desktop-shell` DSK-2).
 *
 * Проверяется не подставной объект, а НАСТОЯЩИЙ мост: Node-слой контейнера
 * поднимается на временном дереве, и через него ходит тот же адаптер, который
 * поедет в окне. Подставленный «мост» проверял бы согласие теста с самим
 * собой; здесь же байты доезжают до диска и читаются обратно с диска.
 *
 * Утверждения — те же, что шов предъявляет остальным средам (`editor/core-ts`
 * `test/host.test.ts` для памяти и наложения, `test/webHost.test.ts` для
 * вкладки): записанное читается обратно, перечисление одноуровневое и в
 * нормированном порядке, за корень дерева не выйти, чего среда не даёт — о том
 * она говорит. Сверх них — паритет байтов с веб-средой (ED-21): сохранение на
 * десктопе обязано класть на диск ровно то, что вкладка отправляет эндпойнту.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeAppProfile } from '@game-mvp/desktop-shell/bridge';
import { openApp, type OpenedApp } from '@game-mvp/desktop-shell/host';
import type { ContentChange } from '@game-mvp/editor-core';
import { createDesktopHost } from '../src/host/desktop.js';
import { createWebHost, type HttpFetch } from '../src/host/web.js';

const TREE: Readonly<Record<string, string>> = {
  'scenes/duel.scene.json': '{"components":[]}\n',
  'scenes/duel.presentation.json': '{"decorations":[]}\n',
  'visuals/manifest.json': '{"entities":{}}\n',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const opened: OpenedApp[] = [];
const trees: string[] = [];

afterEach(async () => {
  for (const app of opened.splice(0)) app.close();
  for (const tree of trees.splice(0)) await rm(tree, { recursive: true, force: true });
});

/** Контейнер на временном дереве: профиль редактора, но корень — свой. */
async function container(capabilities: readonly string[] = ['read', 'write', 'watch', 'dialog', 'window']): Promise<{
  app: OpenedApp;
  directory: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'editor-desktop-'));
  trees.push(workspace);
  const directory = join(workspace, 'content');
  for (const [path, content] of Object.entries(TREE)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const profile = normalizeAppProfile(
    {
      id: 'editor',
      title: 'Fluxus — редактор',
      bundle: join(workspace, 'bundle'),
      roots: [
        {
          id: 'content',
          label: 'content',
          directory,
          writable: capabilities.includes('write'),
          serve: true,
        },
      ],
      capabilities,
    },
    'editor.app.json',
  );
  const app = openApp({ profile, base: 'fluxus://app/' });
  opened.push(app);
  return { app, directory };
}

describe('ED-12: десктопный хост — то же дерево, что у остальных сред', () => {
  it('записанное читается обратно теми же байтами, и они лежат на диске', async () => {
    const { app, directory } = await container();
    const host = createDesktopHost(app.handle.bridge);
    await host.content.write('scenes/new.scene.json', encoder.encode('{"components":[1]}\n'));
    expect(decoder.decode(await host.content.read('scenes/new.scene.json'))).toBe('{"components":[1]}\n');
    expect(await readFile(join(directory, 'scenes/new.scene.json'), 'utf8')).toBe('{"components":[1]}\n');
  });

  it('перечисление одноуровневое и в нормированном порядке', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    expect((await host.content.list('scenes')).map((entry) => entry.name)).toEqual([
      'duel.presentation.json',
      'duel.scene.json',
    ]);
    expect((await host.content.list('')).map((entry) => entry.name)).toEqual(['scenes', 'visuals']);
    expect(await host.content.list('нет-такого')).toEqual([]);
  });

  it('stat различает файл, каталог и пустоту', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    expect(await host.content.stat('scenes/duel.scene.json')).toEqual({
      path: 'scenes/duel.scene.json',
      name: 'duel.scene.json',
      kind: 'file',
    });
    expect((await host.content.stat('scenes'))?.kind).toBe('directory');
    expect(await host.content.stat('scenes/нет.json')).toBeUndefined();
  });

  it('за корень дерева не выйти ни чтением, ни записью', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    await expect(host.content.read('../secrets.json')).rejects.toThrow(/выходит за корень/);
    await expect(host.content.write('../secrets.json', encoder.encode('{}'))).rejects.toThrow();
  });

  it('о собственной записи наблюдатель узнаёт', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    const seen: ContentChange[] = [];
    const stop = host.content.watch((change) => seen.push(change));
    await host.content.write('scenes/watched.scene.json', encoder.encode('{}\n'));
    expect(seen).toContainEqual({ path: 'scenes/watched.scene.json', kind: 'created' });
    stop();
  });

  it('корень открытого проекта приходит из профиля, а не из диалога (DSK-5)', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    expect(host.root?.label).toBe('content');
    expect(await host.picker.chooseRoot()).toEqual({ label: 'content' });
  });
});

describe('ED-12: чего среда не даёт, она говорит честно', () => {
  it('без возможности "write" сохранение отказывает, называя её', async () => {
    const { app, directory } = await container(['read']);
    const host = createDesktopHost(app.handle.bridge);
    await expect(host.content.write('scenes/duel.scene.json', encoder.encode('{}'))).rejects.toThrow(
      /"write"/,
    );
    // И документ не тронут: отказ — это отказ, а не тихая потеря правки.
    expect(await readFile(join(directory, 'scenes/duel.scene.json'), 'utf8')).toBe(
      TREE['scenes/duel.scene.json'],
    );
  });

  it('без возможности "watch" хост молчит, а не падает', async () => {
    const { app } = await container(['read']);
    const host = createDesktopHost(app.handle.bridge);
    const stop = host.content.watch(() => {
      throw new Error('уведомлений быть не должно');
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('без возможности "dialog" выбор отвечает undefined — как отказ автора', async () => {
    const { app } = await container(['read']);
    const host = createDesktopHost(app.handle.bridge);
    expect(await host.picker.chooseFile()).toBeUndefined();
    expect(await host.picker.chooseDirectory({ startIn: 'visuals' })).toBeUndefined();
  });

  it('без возможности "window" заголовок никуда не идёт и закрытие не спрашивается', async () => {
    const { app } = await container(['read']);
    const host = createDesktopHost(app.handle.bridge);
    host.window.setTitle('duel.scene.json');
    host.window.setUnsaved(true);
    // Отписка есть всегда — вызывающий пишется один раз, средой не ветвясь.
    const stop = host.window.onCloseRequest(() => false);
    stop();
    expect(await app.handle.requestClose()).toBe(true);
  });

  it('окно: заголовок, признак несохранённого и ответ на запрос закрытия', async () => {
    const { app } = await container();
    const host = createDesktopHost(app.handle.bridge);
    host.window.setTitle('duel.scene.json — Fluxus');
    host.window.setUnsaved(true);
    expect(app.handle.title).toBe('duel.scene.json — Fluxus');
    expect(app.handle.unsaved).toBe(true);
    const stop = host.window.onCloseRequest(() => false);
    expect(await app.handle.requestClose()).toBe(false);
    stop();
    expect(await app.handle.requestClose()).toBe(true);
  });
});

describe('ED-21: байты сохранения не зависят от среды', () => {
  it('десктоп кладёт на диск ровно то, что вкладка отправляет эндпойнту', async () => {
    // Канонический вид документа считает редактор, а не среда (DSK-2:
    // «через мост проходит только запись байтов по пути»). Значит, среда обязана
    // быть прозрачной — что подали, то и легло.
    const document = encoder.encode('{"components":[{"name":"Герой"}]}\n');

    let sent: Uint8Array | null = null;
    const fetchStub: HttpFetch = (_url, init) => {
      sent = init?.body as Uint8Array;
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        json: () => Promise.resolve({ kind: 'file', created: true }),
      });
    };
    const web = createWebHost({ fetch: fetchStub });
    await web.content.write('scenes/duel.scene.json', document);

    const { app, directory } = await container();
    const desktop = createDesktopHost(app.handle.bridge);
    await desktop.content.write('scenes/duel.scene.json', document);

    const onDisk = new Uint8Array(await readFile(join(directory, 'scenes/duel.scene.json')));
    expect(sent).not.toBeNull();
    expect([...onDisk]).toEqual([...(sent as unknown as Uint8Array)]);
    expect([...onDisk]).toEqual([...document]);
  });
});
