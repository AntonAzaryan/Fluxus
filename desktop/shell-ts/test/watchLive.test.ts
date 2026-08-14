/**
 * Единственный тест слоя хоста с живым `fs.watch` (DSK-2, «события изменения»).
 *
 * Всё остальное про наблюдение проверено на подставном наблюдателе и без
 * таймингов — и это правильный способ: классификация событий и подписка суть
 * поведение кода, а не ядра ОС. Но ровно одно утверждение по частям не
 * проверяется никак: «настоящий наблюдатель вообще срабатывает, и срабатывает
 * рекурсивно — на файл в подкаталоге». Оно про выбор `fs.watch(dir,
 * {recursive:true})`, и стоит того, чтобы один раз завести живой watcher.
 *
 * Тайминга здесь нет: тест ждёт УСЛОВИЯ до крайнего срока, а не спит фиксированный
 * срок, — медленная машина делает тест медленнее, а не красным. Платформа без
 * рекурсивного наблюдения его пропускает: контейнер там честно говорит
 * `observing === false` и молчит, а приложение обязано это пережить.
 */
import { describe, expect, it } from 'vitest';
import type { BridgeChange } from '../src/bridge/types.js';
import { createHostRoot } from '../src/host/root.js';
import { dropTree, makeTree, putFile, waitFor } from './support.js';

describe('живое наблюдение за корнем', () => {
  it('правка файла в подкаталоге доезжает до подписчика', async ({ skip }) => {
    const directory = await makeTree({ 'scenes/duel.scene.json': '{"scene":"duel"}' });
    const root = createHostRoot({ id: 'content', directory });
    const seen: BridgeChange[] = [];
    root.watch((change) => seen.push(change));

    if (!root.observing) {
      root.close();
      await dropTree(directory);
      skip('платформа не даёт рекурсивного наблюдения: контейнер об этом и говорит');
      return;
    }

    await putFile(directory, 'scenes/duel.scene.json', '{"scene":"правлено"}');
    const arrived = await waitFor(() => seen.some((change) => change.path === 'scenes/duel.scene.json'));
    root.close();
    await dropTree(directory);
    expect(arrived).toBe(true);
  });
});
