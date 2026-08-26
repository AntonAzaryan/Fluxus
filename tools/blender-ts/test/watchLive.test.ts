/**
 * Единственный тест конвейера, поднимающий watch-режим целиком — с живым
 * наблюдателем файловой системы (BLND-12).
 *
 * Остальное проверено по частям и без таймингов (`watch.test.ts`), и это
 * правильный способ: цикл, дебаунс и отказ — поведение кода, а не ядра. Но
 * ровно одно утверждение по частям не проверяется никак — «наблюдатель вообще
 * срабатывает, в том числе на подмену файла переименованием». Оно про `fs.watch`
 * и про выбор «смотреть на каталог, а не на файл», и стоит оно того, чтобы
 * один раз завести настоящий watcher.
 *
 * Тайминга здесь при этом нет: тест не спит фиксированный срок, а ждёт УСЛОВИЯ
 * с крайним сроком — документ на диске обновился, — и удовлетворить его может
 * как наблюдатель, так и страховочный опрос. Медленная машина делает тест
 * медленнее, а не красным; среда без inotify проходит на опросе. Blender, как и
 * везде, не зовётся (BLND-7).
 */
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeHost } from '../src/nodeHost.js';
import { cliValidationRules } from '../src/cli.js';
import { runImportWatch } from '../src/watch.js';
import { MANIFEST_ID, SCENE_ID, SOURCE_ID, contentFiles, fixtureBytes } from './support.js';

/** -4.5 в Q16.16: позиция, в которую автор переставил объект. */
const MOVED_X = -294912;

/** Ждёт условия до крайнего срока: медленная машина делает тест медленным, а не красным. */
async function waitFor(condition: () => boolean, deadlineMs = 5000): Promise<void> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge && !condition()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('BLND-12: watch-режим целиком, с живым наблюдателем', () => {
  it('подмена источника переименованием доезжает до документов', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blender-live-'));
    for (const [path, content] of Object.entries(contentFiles())) {
      const target = join(root, 'content', path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const host = createNodeHost({ root: join(root, 'content') });
    const stop = new AbortController();
    const err: string[] = [];
    const done = runImportWatch({
      host: host.content,
      root: join(root, 'content'),
      source: SOURCE_ID,
      manifest: MANIFEST_ID,
      rules: cliValidationRules(),
      io: { out: () => undefined, err: (text) => err.push(text) },
      debounceMs: 20,
      pollMs: 50,
      signal: stop.signal,
    });

    // Первый импорт watch делает сам, ещё до всякой правки, и читает при этом
    // ИСТОЧНИК. Подменять его, пока это чтение идёт, нельзя: на Windows
    // переименование поверх открытого файла отвергается (`EPERM`), а на POSIX
    // проходит — и тогда первый же импорт подхватил бы новую позицию, то есть
    // тест зеленел бы, не проверив наблюдателя вовсе. Поэтому подмена ждёт, пока
    // watch отчитается о первом прогоне.
    await waitFor(() => err.some((line) => line.includes('импорт 1')));
    expect(err.join('\n')).toContain('импорт 1');

    const source = JSON.parse(new TextDecoder().decode(fixtureBytes('placements.gltf'))) as {
      nodes: { name: string; translation?: number[] }[];
    };
    const moved = source.nodes.find((node) => node.name === 'alpha-hero');
    if (moved === undefined) throw new Error('фикстура не содержит объекта "alpha-hero"');
    moved.translation = [-4.5, 0, 2.25];
    // Подмена через временный файл: ровно так пишет приличный экспортёр.
    const temporary = join(root, 'content/scenes/.duel.gltf.tmp');
    await writeFile(temporary, JSON.stringify(source));
    await rename(temporary, join(root, 'content', SOURCE_ID));

    const deadline = Date.now() + 5000;
    let x = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const scene = JSON.parse(
        (await readFile(join(root, 'content', SCENE_ID))).toString('utf8'),
      ) as { initial: { overrides: { Position: { x: number } } }[] };
      x = scene.initial[0]?.overrides.Position.x ?? 0;
      if (x === MOVED_X) break;
    }
    stop.abort();
    await done;
    await rm(root, { recursive: true, force: true });
    expect(x).toBe(MOVED_X);
    expect(err.join('\n')).toContain('watch: слежу');
  }, 20000);
});
