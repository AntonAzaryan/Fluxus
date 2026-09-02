/**
 * Счётчики хоста сервера (NTR-11, решение D9): длительность исполнения тика с
 * перцентилем p99, broadcast lag и размер снапшотов ПО КАЖДОМУ соединению
 * отдельно.
 *
 * Меряются они в `MatchHost`, потому что там живут цикл и рассылка (NTR-3), и
 * проверяются здесь на лупбэке — часы инъектируются, так что утверждения о
 * величинах не зависят от реального времени (NTR-12).
 *
 * Второе утверждение важнее первого: сбор счётчиков MUST NOT влиять на матч и
 * MUST NOT попадать в канонический лог (NTR-11, OBS-2) — матч с читателем
 * отчёта и матч без него дают побитово один и тот же лог.
 */
import { describe, expect, it } from 'vitest';
import { DurationRing, summarize } from '../src/server/hostMetrics.js';
import { MatchHost } from '../src/server/host.js';
import { MatchServer } from '../src/server/matchServer.js';
import { LoopbackHub } from '../src/transport/loopback.js';
import { connectClient, duelConfig, settle } from './fixtures.js';

/** Часы теста: шагают ровно тогда, когда шагает тест. */
function clock(): { ms: number; now: () => number } {
  const state = { ms: 0, now: (): number => state.ms };
  return state;
}

describe('кольцо длительностей (NTR-11, OBS-2)', () => {
  it('перцентиль считается по накопленному, а пустое кольцо даёт нули', () => {
    const ring = new DurationRing(8);
    expect(summarize(ring)).toEqual({ lastMs: 0, meanMs: 0, p99Ms: 0, samples: 0 });

    for (const ms of [1, 1, 1, 1, 1, 1, 1, 100]) ring.record(ms);
    const summary = summarize(ring);
    expect(summary.samples).toBe(8);
    expect(summary.lastMs).toBe(100);
    // Выброс виден p99 и почти не виден среднему — ровно то различение, ради
    // которого NTR-11 называет перцентиль поимённо.
    expect(summary.p99Ms).toBe(100);
    expect(summary.meanMs).toBeLessThan(20);
  });

  it('кольцо фиксировано: длительность матча не двигает ни память, ни замер', () => {
    const ring = new DurationRing(4);
    for (let i = 0; i < 1000; i++) ring.record(i);
    expect(ring.count).toBe(4);
    expect(ring.last).toBe(999);
  });
});

describe('счётчики хоста на живом матче (NTR-11)', () => {
  it('длительность тика, broadcast lag и байты снапшотов растут по соединениям', async () => {
    const config = duelConfig({ silenceTicks: 1000 });
    const hub = new LoopbackHub();
    const server = new MatchServer(config);
    const time = clock();
    const host = new MatchHost(server, hub, { now: time.now });
    const wall = { ms: 0 };
    // Клиенты шлют ввод: без него серверная половина отклика не измеряется — и
    // это правильно, мерить нечего.
    const still = (): { move: { x: number; y: number }; aimDir: number; buttons: number } => ({
      move: { x: 0, y: 0 },
      aimDir: 0,
      buttons: 0,
    });
    const one = connectClient(hub, 'p1', wall, config.scene, { input: still });
    const two = connectClient(hub, 'p2', wall, config.scene, { input: still });
    await settle();
    expect(server.phase).toBe('running');

    for (let i = 0; i < 20; i++) {
      time.ms += 1; // Каждый шаг расписания «стоит» миллисекунду по часам теста.
      wall.ms += 1000 / 60;
      one.host.step();
      two.host.step();
      await settle();
      host.step();
      await settle();
    }

    const report = host.report();
    expect(report.tick.samples).toBe(20);
    // Часы двигает тест, поэтому величины детерминированы: тик исполняется
    // внутри одного шага часов, рассылка — сразу за ним.
    expect(report.tick.p99Ms).toBe(0);
    expect(report.broadcast.samples).toBeGreaterThan(0);
    expect(report.connections).toHaveLength(2);
    for (const connection of report.connections) {
      expect(connection.snapshots).toBeGreaterThan(0);
      expect(connection.snapshotBytes).toBeGreaterThan(0);
      // Байты соединения не меньше байтов его снапшотов: в них же ещё `Welcome`
      // и поток событий.
      expect(connection.bytes).toBeGreaterThanOrEqual(connection.snapshotBytes);
      // Лупбэк круг мерить не умеет и говорит это явно, а не нулём (NTR-11).
      expect(connection.rtt).toEqual({ kind: 'unsupported' });
      // И очередь отправки — тоже: у лупбэка без планировщика сборки её нет, а
      // ноль означал бы здоровый пустой канал (NTR-22).
      expect(connection.backlog).toEqual({ kind: 'unsupported' });
      // Канал очереди не показывает — пропускать нечего и не по чему.
      expect(connection.snapshotsSkipped).toBe(0);
      // Серверная половина отклика измерена: кадры ввода приходили, снапшоты
      // уходили. Часы двигает тест, поэтому величина детерминирована.
      expect(connection.responseMs).toBe(0);
    }
    // Сумма по соединениям сходится с общим счётчиком сервера: наблюдение
    // «по каждому соединению отдельно» не заводит второй бухгалтерии.
    const total = report.connections.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBe(server.metrics.bytesSent);
    await host.stop();
  });

  it('чтение отчёта не двигает ни матч, ни канонический лог (OBS-2)', async () => {
    const play = async (readReport: boolean): Promise<string> => {
      const config = duelConfig({ silenceTicks: 1000 });
      const hub = new LoopbackHub();
      const server = new MatchServer(config);
      const time = clock();
      const host = new MatchHost(server, hub, { now: time.now });
      const wall = { ms: 0 };
      connectClient(hub, 'p1', wall, config.scene);
      connectClient(hub, 'p2', wall, config.scene);
      await settle();
      for (let i = 0; i < 12; i++) {
        time.ms += 1;
        host.step();
        await settle();
        if (readReport) host.report();
      }
      const log = JSON.stringify(server.toScenario());
      await host.stop();
      return log;
    };

    // Матч с подписчиком отчёта и матч без него — одна и та же запись, байт в
    // байт: величина внешнего слоя в мир не попадает (NTR-11).
    expect(await play(true)).toBe(await play(false));
  });

  it('отчёт помнит разорванное соединение, но круга у него не выдумывает', async () => {
    const config = duelConfig({ silenceTicks: 1000 });
    const hub = new LoopbackHub();
    const server = new MatchServer(config);
    const host = new MatchHost(server, hub, { now: () => 0 });
    const wall = { ms: 0 };
    const first = connectClient(hub, 'p1', wall, config.scene);
    connectClient(hub, 'p2', wall, config.scene);
    await settle();
    host.step();
    await settle();

    first.transport.close('обрыв');
    await settle();
    const gone = host.report().connections.find((entry) => entry.id === 1);
    // Байты остались: «сколько мы отправили этому игроку» не должно пропадать
    // ровно тогда, когда админ пришёл разбираться.
    expect(gone?.bytes).toBeGreaterThan(0);
    expect(gone?.rtt).toEqual({ kind: 'unsupported' });
    // Очереди у закрытого соединения нет по той же причине, что и круга:
    // отсутствие называется явно, а не нулём (NTR-22).
    expect(gone?.backlog).toEqual({ kind: 'unsupported' });
    await host.stop();
  });
});

describe('соединения хоста без матча', () => {
  it('о незнакомом соединении хост молчит, а не выдумывает нули', async () => {
    const config = duelConfig({ silenceTicks: 1000 });
    const hub = new LoopbackHub();
    const server = new MatchServer(config);
    const host = new MatchHost(server, hub, { now: () => 0 });
    // Соединения с таким номером хост не видел: нули по нему были бы ответом о
    // том, чего нет, — и админ прочитал бы их как «отправлено ноль байт».
    expect(host.connectionMetrics(42)).toBeUndefined();

    const wall = { ms: 0 };
    connectClient(hub, 'p1', wall, config.scene);
    await settle();
    expect(host.connectionMetrics(1)).toBeDefined();
    await host.stop();
  });
});
