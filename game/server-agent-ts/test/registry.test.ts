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
import { createRegistry, freePort, CONTROL_TAIL_LIMIT, type ServerRegistry } from '../src/index.js';
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
  /** Книга процессов реестра (D5): её момент старта именует каталог прогона. */
  readonly bookFile: string;
}

function spiedRegistry(now?: () => number): Spied {
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
    ...(now === undefined ? {} : { now }),
  });
  registries.push(registry);
  return {
    registry,
    changed,
    removed,
    crashDir: paths.crashDir,
    runsDir: join(paths.root, 'runs'),
    bookFile: paths.bookFile,
  };
}

/**
 * Часы, отдающие НОВОЕ значение на каждый вызов. Совпади два чтения `now()`,
 * тест на настоящих часах проходил бы по совпадению миллисекунды — то есть
 * почти всегда, и разъехавшиеся имена он бы не поймал.
 */
function tickingClock(): () => number {
  let value = 1_700_000_000_000;
  return () => value++;
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

describe('каталог прогона назван ОДНИМ моментом старта (SRV-6, D5)', () => {
  it('имя каталога прогона и запись книги — одно и то же число', async () => {
    const spied = spiedRegistry(tickingClock());
    const started = await spied.registry.start(startParams());

    const entry = processBook(spied.bookFile).entries.find((record) => record.id === started.id);
    expect(entry).toBeDefined();
    // `adopt` собирает имя каталога обратно ИЗ КНИГИ (`runs/<id>-<startedAt>`):
    // прочитай запуск часы дважды, после рестарта агента постмортем искал бы
    // артефакты по имени, которого на диске нет, — и молча не находил бы ничего.
    expect(readdirSync(spied.runsDir)).toContain(`${started.id}-${String(entry!.startedAt)}`);
  });

  it('постмортем краха забирает артефакты прогона, а не пустоту', async () => {
    const spied = spiedRegistry(tickingClock());
    const started = await spied.registry.start(startParams({ match: 'matches/crash.match.json' }));
    await until(() => spied.registry.entry(started.id)?.state === 'crashed');

    const crashed = spied.registry.entry(started.id);
    expect(crashed?.postmortemFailure).toBeNull();
    expect(crashed?.postmortem).not.toBeNull();
    // Пинается здесь ветвь артефактов постмортема (SRV-6) — то, что каталог,
    // названный стенду флагом `--out-dir`, доезжает в материалы разбора. Момента
    // старта этот тест НЕ различает: `postmortem` копирует `live.runDir`, а он
    // построен из того же локального `startedAt`, что ушёл стенду, — книга в этот
    // путь не входит. Единственный момент старта пинает тест выше.
    //
    // Каталог при этом заводит фикстура: настоящий стенд создаёт его только в
    // отладочном прогоне, которого в наборе параметров запуска (SRV-2) нет, — см.
    // шапку `fixtures/fakeStand.mjs` и пункт 9 ревью от 2026-08-26.
    expect(existsSync(join(crashed!.postmortem!, 'run', 'run.json'))).toBe(true);
  });
});

describe('хвост управляющей линии не растёт без предела (SRV-1)', () => {
  it('маркированный хвост без перевода строки сбрасывается и НАЗЫВАЕТСЯ', async () => {
    // Управляющую линию потолок обычной строки не режет намеренно: половина
    // JSON перестаёт быть отчётом (решение D2). Но исключение без потолка — это
    // буфер, растущий до `RangeError` внутри обработчика `data`, то есть смерть
    // агента вместе со ВСЕМИ его серверами. Стенд здесь льёт вдвое больше
    // потолка одной записью (`fixtures/fakeStand.mjs`).
    const spied = spiedRegistry();
    const started = await spied.registry.start(startParams({ match: 'matches/flood.match.json' }));

    // Срок короче умолчания `until`: два мегабайта приезжают за доли секунды, а
    // не приехав — тест обязан сказать «сброса не было», а не упереться в
    // тайм-аут vitest'а и назвать отказ зависанием.
    const dropped = await until(
      () => spied.registry.log(started.id).some((line) => line.includes('хвост сброшен')),
      3000,
    );
    expect(dropped).toBe(true);
    // Сброшен В ЛОГ и с названным размером: молча выброшенный мегабайт выглядел
    // бы как «стенд перестал отчитываться» — и отлаживали бы не то.
    const named = spied.registry.log(started.id).find((line) => line.includes('хвост сброшен'));
    expect(named).toContain(String(CONTROL_TAIL_LIMIT));
    // И агент ЖИВ: сервер по-прежнему в реестре и его можно остановить.
    expect(spied.registry.entry(started.id)?.state).toBe('listening');
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
    // Счётчики слота до первого отчёта — нули, а не отсутствие поля: перечень
    // слотов есть ростер (NTR-6), и вид менеджера читает его целиком (NTR-22).
    expect(entry?.slots.every((slot) => slot.snapshotsSkipped === 0)).toBe(true);

    // Незнакомый статус называется ОДИН раз, а не заливает канал каждым отчётом.
    for (let i = 0; i < 4; i++) {
      await new Promise((done) => setTimeout(done, 120));
      tail.push(...spied.registry.takeLog(started.id));
    }
    const named = tail.filter((line) => line.includes('незнакомый статус'));
    expect(named).toHaveLength(1);
  });
});
