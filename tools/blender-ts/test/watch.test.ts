/**
 * Watch-режим (BLND-12): цикл, его отказ и его дебаунс.
 *
 * Настоящего `fs.watch` здесь нет ни в одном тесте, и это решение, а не
 * упрощение: наблюдатель ФС отвечает тогда, когда решит ядро, и тест, ждущий
 * его в CI, проверяет не конвейер, а планировщик — либо флакает, либо спит
 * секунду на каждую проверку. Поэтому watch и разложен на части
 * (`src/watch.ts`): цикл зовётся напрямую, время двигают подставленные таймеры,
 * а на долю живого наблюдателя остаётся ровно один вызов `changed()`, который
 * тест делает сам.
 *
 * Дерево при этом настоящее — временный каталог, — потому что проверяется
 * именно то, чего нет в памяти: обновился ли байт на диске и уцелел ли он при
 * отказе. Blender не зовётся ни в какой форме (BLND-7).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeHost } from '../src/nodeHost.js';
import { cliValidationRules, parseArgs, CliError } from '../src/cli.js';
import {
  createImportCycle,
  createWatchTrigger,
  type ImportCycle,
  type WatchTimers,
} from '../src/watch.js';
import {
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  SOURCE_ID,
  contentFiles,
  fixtureBytes,
} from './support.js';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function tree(files: Record<string, string | Uint8Array> = contentFiles()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'blender-watch-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, 'content', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const contentOf = (root: string, path: string): Promise<Buffer> =>
  readFile(join(root, 'content', path));

/** Автор сохранил в Blender: на месте экспорта лежат другие байты. */
async function saveSource(root: string, bytes: Uint8Array): Promise<void> {
  await writeFile(join(root, 'content', SOURCE_ID), bytes);
}

/**
 * Тот же экспорт с переставленным объектом — правка level-дизайнера, а не
 * другая фикстура: watch обязан довезти до диска именно её.
 */
function movedSource(x: number): Uint8Array {
  const source = JSON.parse(new TextDecoder().decode(fixtureBytes('placements.gltf'))) as {
    nodes: { name: string; translation?: number[] }[];
  };
  const moved = source.nodes.find((node) => node.name === 'alpha-hero');
  if (moved === undefined) throw new Error('фикстура не содержит объекта "alpha-hero"');
  moved.translation = [x, 0, 2.25];
  return new TextEncoder().encode(JSON.stringify(source));
}

interface Sink {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out: (text: string) => void; err: (text: string) => void };
}

function sink(): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}

function cycleOn(root: string, io: Sink): ImportCycle {
  const host = createNodeHost({ root: join(root, 'content') });
  return createImportCycle({
    host: host.content,
    source: SOURCE_ID,
    manifest: MANIFEST_ID,
    rules: cliValidationRules(),
    io: io.io,
  });
}

/** Позиция первой записи расстановки на диске — то, что автор двигал в Blender. */
async function firstX(root: string): Promise<number> {
  const scene = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as {
    initial: { overrides: { Position: { x: number } } }[];
  };
  return scene.initial[0]!.overrides.Position.x;
}

describe('BLND-12: обновление источника доезжает до документов', () => {
  it('сохранение в источнике переписывает документы новым прогоном', async () => {
    const root = await tree();
    const io = sink();
    const cycle = cycleOn(root, io);

    const first = await cycle.run();
    expect(first.ok).toBe(true);
    expect(first.written).toContain(SCENE_ID);
    expect(await firstX(root)).toBe(-98304); // -1.5 в Q16.16 — как в фикстуре

    await saveSource(root, movedSource(-4.5));
    const second = await cycle.run();

    expect(second.ok).toBe(true);
    expect(second.written).toContain(SCENE_ID);
    expect(await firstX(root)).toBe(-294912); // -4.5 в Q16.16
    expect(cycle.runs).toBe(2);
  });

  it('источник не менялся — прогон есть, записи нет (BLND-4)', async () => {
    const root = await tree();
    const cycle = cycleOn(root, sink());

    await cycle.run();
    const before = await contentOf(root, SCENE_ID);
    const again = await cycle.run();

    expect(again.ok).toBe(true);
    expect(again.written).toEqual([]);
    expect(await contentOf(root, SCENE_ID)).toEqual(before);
  });
});

describe('BLND-12: ошибочный источник — прежние документы и живой цикл', () => {
  it('отказ не трогает ни байта, называет объект и сохраняет последний валидный результат', async () => {
    const root = await tree();
    const io = sink();
    const cycle = cycleOn(root, io);

    const good = await cycle.run();
    const before = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    await saveSource(root, fixtureBytes('mixed.gltf'));
    const bad = await cycle.run();

    expect(bad.ok).toBe(false);
    // Адрес — имя объекта Blender: по нему автор находит правку в outliner'е.
    expect(io.err.join('\n')).toContain('gamma-ghost');
    expect(await contentOf(root, SCENE_ID)).toEqual(before.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(before.presentation);
    // Кадр показывает то, что лежит на диске, — то есть результат прогона 1.
    expect(cycle.lastValid()).toBe(good);
    expect(cycle.last()).toBe(bad);
  });

  it('исправленный источник продолжает цикл сам', async () => {
    const root = await tree();
    const cycle = cycleOn(root, sink());

    await cycle.run();
    await saveSource(root, fixtureBytes('mixed.gltf'));
    await cycle.run();
    await saveSource(root, movedSource(7.5));
    const healed = await cycle.run();

    expect(healed.ok).toBe(true);
    expect(await firstX(root)).toBe(491520); // 7.5 в Q16.16
    expect(cycle.lastValid()).toBe(healed);
    expect(cycle.runs).toBe(3);
  });

  it('исчезнувший источник — тот же отказ, а не падение watch', async () => {
    const root = await tree();
    const io = sink();
    const cycle = cycleOn(root, io);

    await cycle.run();
    await rm(join(root, 'content', SOURCE_ID));
    const gone = await cycle.run();

    expect(gone.ok).toBe(false);
    expect(gone.result).toBeNull();
    expect(io.err.join('\n')).toContain(SOURCE_ID);
    // Цикл жив: следующий прогон исполняется на общих основаниях.
    await saveSource(root, fixtureBytes('placements.gltf'));
    expect((await cycle.run()).ok).toBe(true);
  });
});

/** Таймеры под управлением теста: время двигает `flush`, а не планировщик ОС. */
function fakeTimers(): { timers: WatchTimers; flush: () => void; pending: () => number } {
  let queue: (() => void)[] = [];
  return {
    timers: {
      delay(_ms, run) {
        queue.push(run);
        return () => {
          queue = queue.filter((item) => item !== run);
        };
      },
    },
    flush: () => {
      const due = queue;
      queue = [];
      for (const run of due) run();
    },
    pending: () => queue.length,
  };
}

describe('BLND-12: дебаунс и сериализация прогонов', () => {
  it('пачка событий одного сохранения даёт один прогон', async () => {
    const clock = fakeTimers();
    let runs = 0;
    const trigger = createWatchTrigger({
      cycle: () => {
        runs += 1;
        return Promise.resolve();
      },
      timers: clock.timers,
    });

    trigger.notify();
    trigger.notify();
    trigger.notify();
    // Отложен ровно один вызов: каждое следующее событие отменяет предыдущий.
    expect(clock.pending()).toBe(1);
    clock.flush();
    await trigger.settled();

    expect(runs).toBe(1);
    trigger.close();
  });

  it('событие во время прогона даёт ровно один следующий, а не второй рядом', async () => {
    const clock = fakeTimers();
    const order: string[] = [];
    // Отпускание идущего прогона живёт полем, а не переменной: присваивают его
    // изнутри замыкания, и вывод типов увидел бы в переменной вечный `null`.
    const gate: { release: (() => void) | null } = { release: null };
    const trigger = createWatchTrigger({
      cycle: () => {
        order.push('start');
        return new Promise<void>((resolve) => {
          gate.release = () => {
            order.push('end');
            resolve();
          };
        });
      },
      timers: clock.timers,
    });

    trigger.notify();
    clock.flush();
    expect(order).toEqual(['start']);

    // Автор сохранил ещё дважды, пока шёл импорт.
    trigger.notify();
    trigger.notify();
    clock.flush();
    expect(order).toEqual(['start']);

    gate.release?.();
    // Ждать `settled` здесь нельзя: второй прогон стартует сам и тоже встанет
    // на ожидании — ждать его завершения значило бы ждать самого себя.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['start', 'end', 'start']);
    gate.release?.();
    await trigger.settled();

    expect(order).toEqual(['start', 'end', 'start', 'end']);
    trigger.close();
  });

  it('первый прогон идёт тем же насосом: событие во время него не даёт второго рядом', async () => {
    const clock = fakeTimers();
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const trigger = createWatchTrigger({
      cycle: () => {
        order.push('start');
        return new Promise<void>((resolve) => {
          gate.release = () => {
            order.push('end');
            resolve();
          };
        });
      },
      timers: clock.timers,
    });

    // Первый прогон — сразу, без дебаунса: watch начинается с импорта.
    const primed = trigger.prime();
    expect(order).toEqual(['start']);
    expect(trigger.running).toBe(true);

    // Blender сохранил, пока шёл первый импорт: второй прогон не пишет рядом
    // с первым, а встаёт ровно одним следующим.
    trigger.notify();
    clock.flush();
    expect(order).toEqual(['start']);

    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['start', 'end', 'start']);
    gate.release?.();
    await primed;
    await trigger.settled();

    expect(order).toEqual(['start', 'end', 'start', 'end']);
    trigger.close();
  });

  it('после закрытия событие ничего не планирует', () => {
    const clock = fakeTimers();
    let runs = 0;
    const trigger = createWatchTrigger({
      cycle: () => {
        runs += 1;
        return Promise.resolve();
      },
      timers: clock.timers,
    });

    trigger.notify();
    trigger.close();
    clock.flush();
    trigger.notify();

    expect(clock.pending()).toBe(0);
    expect(runs).toBe(0);
  });
});

describe('BLND-12: разбор флага watch', () => {
  it('--watch включается флагом и не спорит с умолчаниями', () => {
    const options = parseArgs([`content/${SOURCE_ID}`, '--watch'], '/repo');
    expect(options.watch).toBe(true);
    expect(options.dryRun).toBe(false);
  });

  it('--watch и --dry-run вместе — ошибка вызова, а не тихий выбор одного', () => {
    expect(() => parseArgs([`content/${SOURCE_ID}`, '--watch', '--dry-run'], '/repo')).toThrow(
      CliError,
    );
  });
});
