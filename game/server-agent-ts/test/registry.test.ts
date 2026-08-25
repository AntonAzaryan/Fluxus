/**
 * Реестр серверов напрямую (SRV-1, SRV-2, SRV-4, SRV-6): отказ запуска и дрейф
 * статуса стенда — без wss и клиента, со шпионами вместо публикации событий.
 *
 * Напрямую, а не через протокол, потому что предмет — ровно события реестра
 * (`onChanged`/`onRemoved`) и постмортем: их проще наблюдать шпионами, чем
 * реконструировать по подписке.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRegistry, freePort, type ServerRegistry } from '../src/index.js';
import { agentPaths } from '../src/state/paths.js';
import { processBook } from '../src/state/book.js';
import { FAKE_STAND, sandbox, startParams, until, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const registries: ServerRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stopAll();
  for (const box of boxes.splice(0)) box.drop();
});

interface Spied {
  readonly registry: ServerRegistry;
  readonly changed: string[];
  readonly removed: string[];
  readonly crashDir: string;
  readonly runsDir: string;
}

function spiedRegistry(): Spied {
  const box = sandbox();
  boxes.push(box);
  const paths = agentPaths(box.stateDir);
  const changed: string[] = [];
  const removed: string[] = [];
  const registry = createRegistry({
    paths,
    book: processBook(paths.bookFile),
    runtime: process.execPath,
    standScript: FAKE_STAND,
    contentRoot: box.contentRoot,
    joinUrl: (address) => `http://x/?server=${address}`,
    freePort,
    onChanged: (id) => changed.push(id),
    onRemoved: (id) => removed.push(id),
  });
  registries.push(registry);
  return { registry, changed, removed, crashDir: paths.crashDir, runsDir: join(paths.root, 'runs') };
}

describe('отказ запуска не оставляет призрака (SRV-1, SRV-2)', () => {
  it('несостоявшийся запуск отзывается целиком: onRemoved вызван, реестр пуст', async () => {
    const spied = spiedRegistry();
    // Стенд, выходящий немедленно ДО прослушивания порта.
    await expect(spied.registry.start(startParams({ match: 'matches/die.match.json' }))).rejects.toMatchObject({
      reason: 'spawn-failed',
    });
    // Реестр пуст — и это видно И агенту (`list`), И подписчику (`onRemoved`):
    // строку, которую нечем убрать, отзывает событие снятия, а не тишина.
    expect(spied.registry.list()).toEqual([]);
    expect(spied.removed).toContain('srv-1');
    // changed мог прийти на добавление, но последнее слово — за removed.
    expect(spied.removed.length).toBeGreaterThan(0);
  });

  it('несостоявшийся запуск НЕ оставляет сиротского постмортема (SRV-6)', async () => {
    const spied = spiedRegistry();
    await expect(spied.registry.start(startParams({ match: 'matches/die.match.json' }))).rejects.toThrow();
    // Постмортем — материал разбора КРАХА идущего сервера, а не несостоявшегося
    // запуска: сироты (каталог, который никто не назовёт) быть не должно.
    const crashEntries = existsSync(spied.crashDir) ? readdirSync(spied.crashDir) : [];
    expect(crashEntries).toEqual([]);
  });
});

describe('дрейф статуса стенда называется, а не приводится молча (SRV-4)', () => {
  it('отчёт с незнакомым статусом отбрасывается, статус — в хвосте лога', async () => {
    const spied = spiedRegistry();
    const started = await spied.registry.start(startParams({ match: 'matches/drift.match.json' }));
    // Хвост лога подписчика (`takeLog`) копится: диагностика агента едет им же.
    const tail: string[] = [];
    await until(() => {
      tail.push(...spied.registry.takeLog(started.id));
      return tail.some((line) => line.includes('незнакомый статус'));
    });
    expect(tail.some((line) => line.includes('"взлетает"'))).toBe(true);

    // Видимая запись НЕ показывает «подключается» вместо дрейфа: отброшенный
    // отчёт не двигает слоты — они остаются на ростере линии `ready` (роль
    // null, статус `connecting` как «отчёта ещё не было»), а сам дрейф назван.
    const entry = spied.registry.entry(started.id);
    expect(entry?.slots.every((slot) => slot.status === 'connecting')).toBe(true);

    // Незнакомый статус называется ОДИН раз, а не заливает канал каждым отчётом.
    for (let i = 0; i < 4; i++) {
      await new Promise((done) => setTimeout(done, 120));
      tail.push(...spied.registry.takeLog(started.id));
    }
    const named = tail.filter((line) => line.includes('незнакомый статус'));
    expect(named).toHaveLength(1);
  });
});
