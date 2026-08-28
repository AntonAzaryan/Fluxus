/**
 * Хост среды командной строки (ED-12): перечисление дерева (ED-20), граница
 * корня и честное «этого у меня нет».
 *
 * Импорт этот файл не запускает вовсе — предмет проверки в том, что третья
 * среда конвейера отдаёт дерево ровно так же, как две другие. Пока это не
 * утверждается, паритет сред держится на том, что импорту хватает `read`,
 * `write` и `stat`: `list` в среде командной строки не звал никто, и разойтись
 * с вебом он мог бы молча.
 *
 * Дерево настоящее — временный каталог, — потому что проверяется именно
 * свойство файловой системы: порядок, в котором каталог отдаёт ОС, свойством
 * дерева не является. Blender не зовётся ни в какой форме (BLND-7).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHost, walkContentTree, type ContentChange } from '@fluxus/editor-core';
import { createNodeHost } from '../src/nodeHost.js';
import { MANIFEST_ID, SCENE_ID, contentFiles } from './support.js';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/**
 * Два соседних файла с именами, чей порядок создания не совпадает ни с
 * алфавитным, ни с регистронезависимым: `Zeta.json` обязан идти перед
 * `alpha.json` (кодовые точки, `compareContentNames`), хотя записан позже.
 */
const EXTRA: Record<string, string> = { 'visuals/Zeta.json': '{}\n', 'visuals/alpha.json': '{}\n' };

function files(): Record<string, string | Uint8Array> {
  return contentFiles(undefined, undefined, undefined, EXTRA);
}

/** Пустой каталог: тестам про отсутствующие у среды возможности дерево не нужно. */
async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'blender-host-'));
  created.push(root);
  return root;
}

/** Временный «репозиторий»: дерево контента лежит в `content/`, как и в настоящем. */
async function tree(): Promise<string> {
  const root = await emptyRoot();
  for (const [path, content] of Object.entries(files())) {
    const target = join(root, 'content', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return join(root, 'content');
}

describe('ED-20: перечисление дерева средой командной строки', () => {
  it('уровень отдаётся в нормированном порядке, а не в порядке ОС', async () => {
    const host = createNodeHost({ root: await tree() });

    expect(await host.content.list('')).toEqual([
      { path: 'scenes', name: 'scenes', kind: 'directory' },
      { path: 'visuals', name: 'visuals', kind: 'directory' },
    ]);
    // Порядок задан кодовыми точками: `Zeta.json` перед `alpha.json`, хотя
    // записан позже и в алфавите среды стоял бы после.
    expect((await host.content.list('visuals')).map((entry) => entry.name)).toEqual([
      'Zeta.json',
      'alpha.json',
      'manifest.json',
    ]);
    expect(await host.content.list('scenes')).toEqual([
      { path: 'scenes/duel.gltf', name: 'duel.gltf', kind: 'file' },
      { path: 'scenes/duel.presentation.json', name: 'duel.presentation.json', kind: 'file' },
      { path: 'scenes/duel.scene.json', name: 'duel.scene.json', kind: 'file' },
    ]);
  });

  it('`stat` отличает файл от каталога, а корень — всегда каталог', async () => {
    const host = createNodeHost({ root: await tree() });
    expect(await host.content.stat(SCENE_ID)).toEqual({
      path: SCENE_ID,
      name: 'duel.scene.json',
      kind: 'file',
    });
    expect((await host.content.stat('visuals'))?.kind).toBe('directory');
    expect((await host.content.stat(''))?.kind).toBe('directory');
    // Отсутствие — не отказ: `stat` о несуществующем пути отвечает `undefined`,
    // и парный presentation-документ, которого у сцены ещё нет, конвейер
    // спрашивает именно так (`project.ts`).
    expect(await host.content.stat('scenes/missing.json')).toBeUndefined();
  });

  it('несуществующий каталог — пустой уровень, а не отказ', async () => {
    const host = createNodeHost({ root: await tree() });
    // Дерево без каталога звуков — законное состояние, и просмотрщик ассетов
    // (ED-20) показывает пустую ветку, а не падает. Файл на месте каталога —
    // тот же случай: спрашивать у него содержимое бессмысленно, но не смертельно.
    expect(await host.content.list('visuals/sounds')).toEqual([]);
    expect(await host.content.list(SCENE_ID)).toEqual([]);
  });

  it('обход дерева из Node неотличим от обхода того же дерева в памяти (ED-12)', async () => {
    const host = createNodeHost({ root: await tree() });
    const memory = createMemoryHost({ files: files() });
    // Ровно это ED-12 и требует от шва: «расхождение сред MUST NOT приводить к
    // двум реализациям». Список — наблюдаемая шва, и разойтись он не вправе.
    expect(await walkContentTree(host.content)).toEqual(await walkContentTree(memory.content));
    expect((await walkContentTree(host.content)).map((entry) => entry.path)).toEqual([
      'scenes',
      'scenes/duel.gltf',
      'scenes/duel.presentation.json',
      'scenes/duel.scene.json',
      'visuals',
      'visuals/Zeta.json',
      'visuals/alpha.json',
      'visuals/manifest.json',
    ]);
  });
});

describe('ED-12: чего у командной строки нет, она говорит честно', () => {
  it('диалогов выбора нет, и сказано это тем же способом, что отказ пользователя', async () => {
    const host = createNodeHost({ root: await emptyRoot() });
    expect(await host.picker.chooseRoot()).toBeUndefined();
    expect(await host.picker.chooseFile({ extensions: ['.glb'] })).toBeUndefined();
    expect(await host.picker.chooseDirectory()).toBeUndefined();
  });

  it('окна нет: заголовок и признак несохранённого идти некуда', async () => {
    const host = createNodeHost({ root: await emptyRoot() });
    host.window.setTitle('duel.scene.json');
    host.window.setUnsaved(true);
    // Подписка на закрытие возвращает отписку и в среде, где закрытия не
    // бывает: вызывающий шва не различает сред (ED-12), и отписаться он вправе
    // так же, как в вебе.
    const stop = host.window.onCloseRequest(() => false);
    expect(stop).toBeTypeOf('function');
    stop();
  });

  it('наблюдения за деревом нет — и watch-режим поэтому живёт в CLI, а не в шве (BLND-12)', async () => {
    const host = createNodeHost({ root: await emptyRoot() });
    const seen: ContentChange[] = [];
    const stop = host.content.watch((change) => seen.push(change));

    await host.content.write(MANIFEST_ID, new TextEncoder().encode('{}\n'));

    // Молчит даже на собственную запись хоста. Это не дефект, а объявленное
    // отсутствие: наблюдателя ФС поднимает `runImportWatch`, и если бы шов
    // изображал слежение, watch-режим сработал бы дважды на одну правку.
    expect(seen).toEqual([]);
    // Отписка ничего не отменяет — и всё-таки существует и зовётся без отказа.
    expect(stop).toBeTypeOf('function');
    stop();
  });
});

describe('ED-12: путь дерева не выводит за корень', () => {
  it('чтение, запись, `stat` и перечисление за корнем отвергаются', async () => {
    const root = await tree();
    const host = createNodeHost({ root });
    // Та же граница, что у загрузчика ассетов (ASSET-3): в вебе за корнем для
    // редактора ничего и нет, и в Node этой разницы быть не должно — иначе
    // источник, названный в аргументе CLI, читал бы что угодно на машине.
    await expect(host.content.read('../secrets.json')).rejects.toThrow(/выходит за корень/);
    await expect(host.content.write('../secrets.json', new Uint8Array([1]))).rejects.toThrow(
      /выходит за корень/,
    );
    await expect(host.content.stat('scenes/../../secrets.json')).rejects.toThrow(/выходит за корень/);
    await expect(host.content.list('..')).rejects.toThrow(/выходит за корень/);
  });

  it('корень назван абсолютным путём, и он же — метка по умолчанию', async () => {
    const root = await tree();
    expect(createNodeHost({ root: join(root, 'scenes', '..') })).toMatchObject({
      name: 'node',
      directory: resolve(root),
      root: { label: resolve(root) },
    });
    expect(createNodeHost({ root, name: 'cli', label: 'демо-проект' })).toMatchObject({
      name: 'cli',
      root: { label: 'демо-проект' },
    });
  });
});
