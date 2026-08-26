/**
 * Корень на диске: атомарность записи, невидимость собственного артефакта,
 * виды изменений (DSK-2).
 *
 * Контрактный сьют проверяет то, что видит страница; здесь — то, что видит
 * файловая система, и чего страница видеть не должна вовсе.
 */
import { readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeChange } from '../src/bridge/types.js';
import { createHostRoot, insideRoot } from '../src/host/root.js';
import {
  dropTree,
  fakeObserver,
  linkDirectory,
  makeTree,
  putFile,
  readText,
  text,
  utf8,
  FILE_LINKS_ALLOWED,
} from './support.js';

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
    // Ожидание собирается тем же `join`, что и ответ: разделитель — свойство
    // платформы, а не предмет проверки (на Windows корень пришёл бы с `\`).
    expect(root.resolve('scenes/duel.scene.json')).toBe(join(directory, 'scenes/duel.scene.json'));
    expect(() => root.resolve('../secret')).toThrow();
    root.close();
  });

  it('запись поднимает корень, которого ещё нет на диске', async () => {
    // Проверка границы идёт по РЕАЛЬНОМУ пути, а у ненаступившего корня его
    // нет вовсе. Отказывать по этой причине нельзя: недостающие каталоги
    // создаёт запись, и ссылке наружу в несуществующем дереве взяться неоткуда.
    const directory = join(await tree(), 'ещё-нет');
    const root = createHostRoot({ id: 'content', directory, writable: true });
    await root.write('scenes/duel.scene.json', utf8('{}'));
    expect(await readText(directory, 'scenes/duel.scene.json')).toBe('{}');
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

/**
 * Ссылка внутри дерева — единственный обход, который лексической проверке пути
 * не виден вовсе: в пути нет ни одной точки, а разрешается он наружу. Создать
 * ссылку страница не может, но дерево приезжает и не от неё — из дистрибутива,
 * из репозитория, от чужого инструмента (DSK-5).
 */
describe('ссылка не выводит за корень (DSK-5)', () => {
  it('ни чтение, ни запись, ни stat, ни перечисление сквозь неё не проходят', async () => {
    const outside = await tree({ 'secret.txt': 'СЕКРЕТ ВНЕ КОРНЯ' });
    const directory = await tree({ 'scenes/duel.scene.json': '{"scene":"duel"}' });
    await linkDirectory(outside, join(directory, 'outside'));
    const root = createHostRoot({ id: 'content', directory, writable: true });

    await expect(root.read('outside/secret.txt')).rejects.toThrow('DSK-5');
    await expect(root.stat('outside/secret.txt')).rejects.toThrow('DSK-5');
    await expect(root.list('outside')).rejects.toThrow('DSK-5');
    await expect(root.write('outside/written.json', utf8('{}'))).rejects.toThrow('DSK-5');
    expect(() => root.resolve('outside/secret.txt')).toThrow('DSK-5');

    // И ни одного следа снаружи: запись отвергнута до создания каталогов.
    expect(await readText(outside, 'written.json')).toBeUndefined();
    expect(await readText(outside, 'secret.txt')).toBe('СЕКРЕТ ВНЕ КОРНЯ');
    root.close();
  });

  /**
   * Ссылка на ФАЙЛ — тот же обход, но заводится она не во всякой среде
   * (`FILE_LINKS_ALLOWED`), а подменить её ссылкой на каталог нельзя: это
   * другой случай, и он проверен выше. Поэтому здесь честный пропуск, а не
   * тихо ослабленная проверка.
   */
  it.skipIf(!FILE_LINKS_ALLOWED)('ссылка на файл наружу — такой же отказ', async () => {
    const outside = await tree({ 'secret.txt': 'СЕКРЕТ ВНЕ КОРНЯ' });
    const directory = await tree({ 'scenes/duel.scene.json': '{"scene":"duel"}' });
    await symlink(join(outside, 'secret.txt'), join(directory, 'secret-link.txt'));
    const root = createHostRoot({ id: 'content', directory, writable: true });

    await expect(root.read('secret-link.txt')).rejects.toThrow('DSK-5');
    await expect(root.write('secret-link.txt', utf8('{}'))).rejects.toThrow('DSK-5');
    expect(await readText(outside, 'secret.txt')).toBe('СЕКРЕТ ВНЕ КОРНЯ');
    root.close();
  });

  it('а ссылка внутрь дерева остаётся путём дерева', async () => {
    // Отказ по факту ссылки был бы проще и был бы неверен: наружу выводит не
    // ссылка, а то, куда она указывает.
    const directory = await tree({ 'scenes/duel.scene.json': '{"scene":"duel"}' });
    await linkDirectory(join(directory, 'scenes'), join(directory, 'сцены'));
    const root = createHostRoot({ id: 'content', directory });
    expect(text(await root.read('сцены/duel.scene.json'))).toBe('{"scene":"duel"}');
    expect((await root.list('сцены')).map((entry) => entry.name)).toEqual(['duel.scene.json']);
    root.close();
  });
});

/**
 * Путь, который ЕСТЬ, но не разрешается: ссылка, указывающая на саму себя.
 * `realpath` отвечает на неё `ELOOP` — не «пути нет», — и это ровно тот случай,
 * ради которого граница различает «ещё нет» и «не разрешилось»: проглоти она
 * второе, проверка молча опустилась бы до лексической, а лексической, как
 * сказано в шапке модуля, недостаточно (DSK-5).
 *
 * Петля здесь заведена ОБЫЧНОЙ ссылкой, а не junction'ом, и это не мелочь.
 * Junction такую петлю на Windows заводит без всякой привилегии — но УБРАТЬ его
 * потом нельзя ничем: ни `fs.rm`, ни `fs.rmdir`, ни `cmd rd`, ни `fsutil
 * reparsepoint delete` (проверено — диспетчер объектов отказывается разбирать
 * само имя, ERROR_CANT_RESOLVE_FILENAME). Фикстура, которую нельзя снести,
 * оставляла бы неудаляемый каталог во временной папке на КАЖДОМ прогоне гейта, а
 * `dropTree` вдобавок падал бы в `afterEach`. Обычная ссылка снимается
 * `unlink`, поэтому случай и проверяется там, где её дают заводить.
 */
describe.skipIf(!FILE_LINKS_ALLOWED)('путь, который не разрешается, — отказ (DSK-5)', () => {
  /** Часть причины, общая всем отказам этого рода. */
  const UNRESOLVED = 'не разрешается файловой системой';

  it('чтение, stat, перечисление, запись и resolve отвергаются с названной причиной', async () => {
    const directory = await tree({ 'scenes/duel.scene.json': '{"scene":"duel"}' });
    const loop = join(directory, 'loop');
    await symlink(loop, loop);
    const root = createHostRoot({ id: 'content', directory, writable: true });

    await expect(root.read('loop/secret.txt')).rejects.toThrow(UNRESOLVED);
    await expect(root.stat('loop')).rejects.toThrow(UNRESOLVED);
    await expect(root.list('loop')).rejects.toThrow(UNRESOLVED);
    await expect(root.write('loop/written.json', utf8('{}'))).rejects.toThrow(UNRESOLVED);
    expect(() => root.resolve('loop/secret.txt')).toThrow(UNRESOLVED);
    // Отказ назван требованием, а не только словами.
    await expect(root.read('loop/secret.txt')).rejects.toThrow('DSK-5');

    // И это именно ОТКАЗ, а не поломка корня: соседний документ читается.
    expect(text(await root.read('scenes/duel.scene.json'))).toBe('{"scene":"duel"}');
    root.close();
  });

  it('insideRoot отвечает «вне корня», а не сверяет непроверенное', async () => {
    const directory = await tree();
    const loop = join(directory, 'loop');
    await symlink(loop, loop);
    const root = createHostRoot({ id: 'content', directory });
    // Лексически путь лежит внутри корня — и ровно поэтому ответ «внутри» был
    // бы ответом наугад: чем этот путь окажется на диске, никто не проверил.
    expect(insideRoot(root, loop)).toBeNull();
    root.close();
  });

  it('корень, который сам не разрешается, отвергает операции, называя корень', async () => {
    const outer = await tree();
    const directory = join(outer, 'loop');
    await symlink(directory, directory);
    const root = createHostRoot({ id: 'content', directory, writable: true });

    await expect(root.read('a.json')).rejects.toThrow(`корень ${UNRESOLVED}`);
    await expect(root.list('')).rejects.toThrow(`корень ${UNRESOLVED}`);
    expect(() => root.resolve('a.json')).toThrow(`корень ${UNRESOLVED}`);
    root.close();
  });
});
