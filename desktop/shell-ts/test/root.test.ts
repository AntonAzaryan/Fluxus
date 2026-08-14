/**
 * Корень на диске: атомарность записи, невидимость собственного артефакта,
 * виды изменений (DSK-2).
 *
 * Контрактный сьют проверяет то, что видит страница; здесь — то, что видит
 * файловая система, и чего страница видеть не должна вовсе.
 */
import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeChange } from '../src/bridge/types.js';
import { createHostRoot, insideRoot } from '../src/host/root.js';
import { dropTree, fakeObserver, makeTree, putFile, readText, text, utf8 } from './support.js';

const trees: string[] = [];

afterEach(async () => {
  for (const tree of trees.splice(0)) await dropTree(tree);
});

async function tree(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await makeTree(files);
  trees.push(root);
  return root;
}

describe('запись атомарна и не оставляет следов', () => {
  it('после записи в каталоге лежит только целевой файл', async () => {
    const directory = await tree();
    const root = createHostRoot({ id: 'content', directory, writable: true });
    await root.write('scenes/duel.scene.json', utf8('{"scene":"duel"}'));
    expect(await readdir(`${directory}/scenes`)).toEqual(['duel.scene.json']);
    expect(await readText(directory, 'scenes/duel.scene.json')).toBe('{"scene":"duel"}');
    root.close();
  });

  it('временный файл не показывается ни перечислением, ни наблюдателем', async () => {
    const directory = await tree();
    const observer = fakeObserver();
    const root = createHostRoot({ id: 'content', directory, writable: true, observer: observer.observer });
    const seen: BridgeChange[] = [];
    root.watch((change) => seen.push(change));
    // Событие о собственном временном файле — не изменение дерева: страница о
    // технике записи контейнера знать не обязана.
    observer.emit('scenes/duel.scene.json.fluxus-tmp-1-2');
    await root.write('scenes/duel.scene.json', utf8('{}'));
    expect(seen.map((change) => change.path)).toEqual(['scenes/duel.scene.json']);
    expect((await root.list('scenes')).map((entry) => entry.name)).toEqual(['duel.scene.json']);
    root.close();
  });

  it('корень только на чтение отвергает запись, называя требование', async () => {
    const directory = await tree({ 'a.json': '{}' });
    const root = createHostRoot({ id: 'content', directory });
    await expect(root.write('a.json', utf8('{"changed":true}'))).rejects.toThrow('DSK-5');
    expect(await readText(directory, 'a.json')).toBe('{}');
    root.close();
  });
});

describe('вид изменения', () => {
  it('своя запись: created на новый файл, modified на существующий', async () => {
    const directory = await tree({ 'a.json': '{}' });
    const root = createHostRoot({ id: 'content', directory, writable: true, observer: fakeObserver().observer });
    const seen: BridgeChange[] = [];
    root.watch((change) => seen.push(change));
    await root.write('b.json', utf8('{}'));
    await root.write('a.json', utf8('{"a":1}'));
    expect(seen.map((change) => change.kind)).toEqual(['created', 'modified']);
    root.close();
  });

  it('исчезнувший файл приходит как removed', async () => {
    const directory = await tree({ 'a.json': '{}' });
    const observer = fakeObserver();
    const root = createHostRoot({ id: 'content', directory, observer: observer.observer });
    const seen: BridgeChange[] = [];
    root.watch((change) => seen.push(change));
    observer.emit('нет-такого.json');
    await new Promise((done) => setTimeout(done, 20));
    expect(seen).toEqual([{ root: 'content', path: 'нет-такого.json', kind: 'removed' }]);
    root.close();
  });

  it('наблюдение открывается один раз на корень и закрывается вместе с ним', async () => {
    const directory = await tree();
    const observer = fakeObserver();
    const root = createHostRoot({ id: 'content', directory, observer: observer.observer });
    const stop = root.watch(() => undefined);
    root.watch(() => undefined);
    expect(observer.open).toBe(1);
    stop();
    expect(observer.open).toBe(1);
    root.close();
    expect(observer.open).toBe(0);
  });
});

describe('чтение и границы', () => {
  it('read отдаёт собственную копию байтов', async () => {
    const directory = await tree({ 'a.json': '{"a":1}' });
    const root = createHostRoot({ id: 'content', directory });
    const first = await root.read('a.json');
    first[0] = 0;
    expect(text(await root.read('a.json'))).toBe('{"a":1}');
    root.close();
  });

  it('resolve не выпускает за корень', async () => {
    const directory = await tree();
    const root = createHostRoot({ id: 'content', directory });
    expect(root.resolve('scenes/duel.scene.json')).toBe(`${directory}/scenes/duel.scene.json`);
    expect(() => root.resolve('../secret')).toThrow();
    root.close();
  });

  it('insideRoot переводит абсолютный путь в путь дерева и отсекает чужой', async () => {
    const directory = await tree();
    const root = createHostRoot({ id: 'content', directory });
    await putFile(directory, 'scenes/duel.scene.json', '{}');
    expect(insideRoot(root, `${directory}/scenes/duel.scene.json`)).toBe('scenes/duel.scene.json');
    expect(insideRoot(root, directory)).toBe('');
    expect(insideRoot(root, '/etc/passwd')).toBeNull();
    root.close();
  });
});
