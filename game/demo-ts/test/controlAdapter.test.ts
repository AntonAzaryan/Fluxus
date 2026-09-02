/**
 * Control-адаптер стенда (`server-control` SRV-4, SRV-5; решения D2, D9).
 *
 * Проверяется он на ПОДСТАВНОМ взгляде на матч, а не на живом сервере, по той же
 * причине, по которой так проверяются политики стенда (`standPolicy`,
 * `detachPause`): предмет здесь — что адаптер отчитывается и как он переводит
 * команды в вызовы, а не как идёт бой. Живой матч под агентом проверяется
 * сквозным прогоном в пакете агента.
 */
import { describe, expect, it } from 'vitest';
import { decodeStandLine, encodeStandCommand } from '@fluxus/server-agent/stand';
import {
  slotStatusOf,
  standControl,
  type AdapterLease,
  type StandMatchView,
} from '../app/controlAdapter.js';

const LEASE: AdapterLease = {
  claimed: false,
  attached: false,
  role: undefined,
  barred: false,
  lastEnd: undefined,
  lastReject: undefined,
};

/** Подставной матч: ровно те наблюдения, которые адаптер читает у сервера. */
function view(overrides: Partial<StandMatchView> = {}): StandMatchView & { calls: string[] } {
  const calls: string[] = [];
  const base: StandMatchView = {
    players: ['p1', 'p2'],
    round: 1,
    phase: () => 'running',
    tick: () => 120,
    pause: () => 'running',
    lease: () => ({ ...LEASE, claimed: true, attached: true, role: 'owner' }),
    counters: () => ({ applied: 10, predicted: 1, late: 0 }),
    wire: () => ({
      snapshotBytes: 2048,
      snapshotsSkipped: 7,
      rtt: { kind: 'measured', ms: 12 },
      responseMs: 40,
    }),
    metrics: () => {
      calls.push('metrics');
      return {
        tickP99Ms: 2,
        tickMeanMs: 1,
        broadcastP99Ms: 0.5,
        snapshotsSent: 100,
        bytesSent: 5000,
      };
    },
    disconnect: (slot) => {
      calls.push(`disconnect:${slot}`);
      return '';
    },
    bar: (slot) => {
      calls.push(`bar:${slot}`);
      return '';
    },
    unbar: (slot) => {
      calls.push(`unbar:${slot}`);
      return '';
    },
    freeze: () => {
      calls.push('freeze');
      return '';
    },
    unfreeze: () => {
      calls.push('unfreeze');
      return 'not-frozen';
    },
    stop: () => {
      calls.push('stop');
      return '';
    },
  };
  return { ...base, ...overrides, calls };
}

function adapter(match?: StandMatchView) {
  const written: string[] = [];
  let processCalls = 0;
  const control = standControl({
    write: (text) => written.push(text),
    process: () => {
      processCalls += 1;
      return { eventLoopDelayMs: 0.3, rssBytes: 1_000_000 };
    },
  });
  if (match !== undefined) control.attach(match);
  return {
    control,
    written,
    processes: () => processCalls,
    lines: () => written.flatMap((text) => text.trim().split('\n')).map(decodeStandLine),
  };
}

describe('статус игрока — производная аренды слота (SRV-4)', () => {
  it('шесть статусов выводятся из состояний аренды, а не из отдельного учёта', () => {
    expect(slotStatusOf({ ...LEASE, claimed: true, attached: true }, 'running')).toBe('active');
    // До старта живое соединение — ещё не игра: слот занят, матч не начался.
    expect(slotStatusOf({ ...LEASE, claimed: true, attached: true }, 'lobby')).toBe('connecting');
    expect(slotStatusOf({ ...LEASE, claimed: true, lastEnd: 'closed' }, 'running')).toBe('disconnected');
    // «Ушёл сам» и «оборвалось» — разные слова для админа (NTR-6, `Bye`).
    expect(slotStatusOf({ ...LEASE, claimed: true, lastEnd: 'bye' }, 'running')).toBe('left');
    expect(slotStatusOf({ ...LEASE, lastReject: 'slot-taken' }, 'running')).toBe('rejected');
    // Запертый слот показывается `removed` при любом положении дел (NTR-19).
    expect(slotStatusOf({ ...LEASE, claimed: true, attached: true, barred: true }, 'running')).toBe('removed');
    expect(slotStatusOf({ ...LEASE, barred: true }, 'lobby')).toBe('removed');
    // Слот, за которым никого не было: матч ждёт входа, и слот из ростера не исчезает.
    expect(slotStatusOf(LEASE, 'lobby')).toBe('connecting');
  });
});

describe('периодический отчёт стенда (решение D2)', () => {
  it('отчёт несёт фазу, слоты со статусами и наблюдаемые соединения', () => {
    const harness = adapter(view());
    harness.control.report();

    const lines = harness.lines();
    expect(lines).toHaveLength(1);
    const report = lines[0]!;
    expect(report.t).toBe('report');
    if (report.t !== 'report') return;
    expect(report.phase).toBe('running');
    expect(report.tick).toBe(120);
    expect(report.slots.map((slot) => slot.playerId)).toEqual(['p1', 'p2']);
    expect(report.slots[0]).toMatchObject({
      status: 'active',
      role: 'owner',
      rtt: { kind: 'measured', ms: 12 },
      serverResponseMs: 40,
      snapshotBytes: 2048,
      // Пропущенные по очереди снапшоты едут рядом с их размером (NTR-22):
      // третий ответ на «дорога, сервер или канал» в том же отчёте (SRV-4).
      snapshotsSkipped: 7,
    });
  });

  it('слот без живого соединения не выдумывает ни круга, ни байтов (NTR-11)', () => {
    const harness = adapter(
      view({
        lease: () => ({ ...LEASE, claimed: true, lastEnd: 'closed' }),
        wire: () => undefined,
      }),
    );
    harness.control.report();
    const report = harness.lines()[0]!;
    if (report.t !== 'report') throw new Error('ожидался отчёт');
    expect(report.slots[0]).toMatchObject({
      status: 'disconnected',
      role: null,
      // Отсутствие круга названо явно, а не нулём.
      rtt: { kind: 'unsupported' },
      serverResponseMs: null,
      snapshotBytes: 0,
      // Соединения нет — пропускать было нечего и некому.
      snapshotsSkipped: 0,
    });
  });

  it('между матчами отчитываться не о чем: адаптер молчит, а не врёт', () => {
    const harness = adapter();
    harness.control.report();
    expect(harness.written).toEqual([]);
  });
});

describe('отчёт метрик собирается только по подписке (решение D9)', () => {
  it('без подписки метрики не собираются вовсе — ни матча, ни процесса не спрашивают', () => {
    const match = view();
    const harness = adapter(match);
    harness.control.report();
    harness.control.report();

    const report = harness.lines()[0]!;
    if (report.t !== 'report') throw new Error('ожидался отчёт');
    expect(report.metrics).toBeNull();
    // Перцентиль по кольцу и `perf_hooks` — работа, и без читателя она не
    // делается: ни одного вызова.
    expect(match.calls).not.toContain('metrics');
    expect(harness.processes()).toBe(0);
    expect(harness.control.subscribed).toBe(false);
  });

  it('после подписки метрики появляются, после отписки — исчезают', () => {
    const match = view();
    const harness = adapter(match);
    harness.control.handle(encodeStandCommand({ id: 1, cmd: 'subscribe', slot: -1 }));
    harness.control.report();
    const subscribed = harness.lines().find((line) => line?.t === 'report');
    expect(subscribed?.t === 'report' && subscribed.metrics).toMatchObject({
      tickP99Ms: 2,
      eventLoopDelayMs: 0.3,
      rssBytes: 1_000_000,
    });
    expect(match.calls).toContain('metrics');

    harness.control.handle(encodeStandCommand({ id: 2, cmd: 'unsubscribe', slot: -1 }));
    harness.written.length = 0;
    harness.control.report();
    const after = harness.lines()[0]!;
    expect(after.t === 'report' && after.metrics).toBeNull();
  });
});

describe('команды агента (SRV-5)', () => {
  it('команда переводится в вызов сервера, исход возвращается ответной линией', () => {
    const match = view();
    const harness = adapter(match);
    harness.control.handle(encodeStandCommand({ id: 7, cmd: 'bar-slot', slot: 1 }));
    harness.control.handle(encodeStandCommand({ id: 8, cmd: 'unbar-slot', slot: 1 }));
    harness.control.handle(encodeStandCommand({ id: 9, cmd: 'disconnect-player', slot: 0 }));
    harness.control.handle(encodeStandCommand({ id: 10, cmd: 'pause', slot: -1 }));
    harness.control.handle(encodeStandCommand({ id: 11, cmd: 'stop', slot: -1 }));

    expect(match.calls).toEqual(['bar:1', 'unbar:1', 'disconnect:0', 'freeze', 'stop']);
    const results = harness.lines().filter((line) => line?.t === 'result');
    expect(results).toHaveLength(5);
    for (const result of results) expect(result.ok).toBe(true);
  });

  it('отказ сервера называется, а не проглатывается', () => {
    const harness = adapter(view());
    harness.control.handle(encodeStandCommand({ id: 1, cmd: 'resume', slot: -1 }));
    const result = harness.lines()[0]!;
    expect(result.t === 'result' && result.ok).toBe(false);
    expect(result.t === 'result' && result.reason).toBe('not-frozen');
  });

  it('слот вне ростера — названный отказ, а не исключение наружу', () => {
    const harness = adapter(view());
    harness.control.handle(encodeStandCommand({ id: 1, cmd: 'bar-slot', slot: 5 }));
    const result = harness.lines()[0]!;
    expect(result.t === 'result' && result.reason).toContain('вне ростера');
  });

  it('команда между матчами получает отказ, а не действие над мертвецом', () => {
    const harness = adapter(view());
    harness.control.detach();
    harness.control.handle(encodeStandCommand({ id: 1, cmd: 'pause', slot: -1 }));
    const result = harness.lines()[0]!;
    expect(result.t === 'result' && result.ok).toBe(false);
  });

  it('чужая строка в stdin молча пропускается: это не наш канал', () => {
    const harness = adapter(view());
    harness.control.handle('привет\n');
    harness.control.handle('{"id":0,"cmd":"pause"}');
    expect(harness.written).toEqual([]);
  });
});
