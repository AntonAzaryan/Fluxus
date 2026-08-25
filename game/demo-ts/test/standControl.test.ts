/**
 * Стенд под агентом — на НАСТОЯЩЕМ прогоне процесса (решение D2).
 *
 * Проверяется здесь то, чего не видит ни один модульный тест: что отчёт
 * действительно доезжает из дочернего процесса и что он НЕ СМЕШИВАЕТСЯ с логом
 * без маркировки. Дефект этой границы — управляющая линия, приклеенная к хвосту
 * прогресс-строки, — снаружи выглядит как «агент не видит сервер», и ручным
 * прогоном его не поймать.
 *
 * Второй предмет — умолчание: без флага адаптера стенд ведёт себя ровно как
 * прежде, ни одной лишней строки в stdout.
 *
 * Прогон запускается подпроцессом тем же интерпретатором, каким его запускает
 * агент (`process.execPath`). Чтение дерева контента законно: это тест ИГРЫ
 * (CONT-1).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_LINE_PREFIX, decodeStandLine, type StandLine } from '@fluxus/server-agent/stand';

const STAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'demo-serve.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

interface Run {
  readonly child: ChildProcess;
  readonly control: StandLine[];
  readonly log: string[];
  send(command: Record<string, unknown>): void;
}

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

async function startStand(args: readonly string[]): Promise<Run> {
  const port = await freePort();
  const child = spawn(process.execPath, [STAND, '--port', String(port), '--once', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  running.push(child);
  const control: StandLine[] = [];
  const log: string[] = [];
  let rest = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    rest += chunk;
    for (;;) {
      const edge = rest.indexOf('\n');
      if (edge < 0) break;
      const line = rest.slice(0, edge);
      rest = rest.slice(edge + 1);
      const parsed = decodeStandLine(line);
      if (parsed === undefined) {
        if (line.trim() !== '') log.push(line);
      } else {
        control.push(parsed);
      }
    }
  });
  return {
    child,
    control,
    log,
    send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
  };
}

async function until(condition: () => boolean, deadlineMs = 20_000): Promise<boolean> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return condition();
}

describe('стенд с control-адаптером (решение D2)', () => {
  it('отчёт читается из дочернего процесса и не смешан с логом', async () => {
    const run = await startStand(['--control-adapter']);

    // Линия готовности: адрес и ростер знает только сам стенд.
    await until(() => run.control.some((line) => line.t === 'ready'));
    const ready = run.control.find((line) => line.t === 'ready');
    expect(ready?.t === 'ready' && ready.players.length).toBeGreaterThan(0);
    expect(ready?.t === 'ready' && ready.buildId).not.toBe('');

    // Периодический отчёт: фаза и слоты со статусами (SRV-4).
    await until(() => run.control.some((line) => line.t === 'report'));
    const report = run.control.find((line) => line.t === 'report');
    if (report?.t !== 'report') throw new Error('отчёта не было');
    expect(report.phase).toBe('lobby');
    expect(report.slots).toHaveLength(ready?.t === 'ready' ? ready.players.length : 0);
    for (const slot of report.slots) expect(slot.status).toBe('connecting');
    // Без подписки метрики не собираются (решение D9).
    expect(report.metrics).toBeNull();

    // И собственный отчёт стенда человеку — рядом, но БЕЗ маркера: разбор его
    // не трогает, а строки не слиплись.
    expect(run.log.length).toBeGreaterThan(0);
    for (const line of run.log) expect(line.startsWith(CONTROL_LINE_PREFIX)).toBe(false);
    expect(run.log.join('\n')).toContain('стенд демо-арены');
  }, 40_000);

  it('команда меняет состояние слота, исход возвращается ответной линией (SRV-5)', async () => {
    const run = await startStand(['--control-adapter']);
    await until(() => run.control.some((line) => line.t === 'report'));

    // Запирание слота (NTR-19) — через адаптер, тем же серверным API.
    run.send({ id: 1, cmd: 'bar-slot', slot: 0 });
    await until(() => run.control.some((line) => line.t === 'result' && line.id === 1));
    const barred = run.control.find((line) => line.t === 'result' && line.id === 1);
    expect(barred?.t === 'result' && barred.ok).toBe(true);
    // Статус слота в следующем отчёте — `removed`, и слот из перечня не исчез.
    await until(() =>
      run.control.some((line) => line.t === 'report' && line.slots[0]?.status === 'removed'),
    );
    const after = [...run.control].reverse().find((line) => line.t === 'report');
    expect(after?.t === 'report' && after.slots).toHaveLength(2);

    // Отказ сервера матча возвращается НАЗВАННЫМ: паузу до старта ставить нельзя.
    run.send({ id: 2, cmd: 'pause', slot: -1 });
    await until(() => run.control.some((line) => line.t === 'result' && line.id === 2));
    const denied = run.control.find((line) => line.t === 'result' && line.id === 2);
    expect(denied?.t === 'result' && denied.ok).toBe(false);
    expect(denied?.t === 'result' && denied.reason).toBe('match-not-running');

    // Подписка включает сбор метрик — и они появляются в отчёте (решение D9).
    run.send({ id: 3, cmd: 'subscribe', slot: -1 });
    await until(() => run.control.some((line) => line.t === 'report' && line.metrics !== null));
    const detailed = [...run.control].reverse().find((line) => line.t === 'report' && line.metrics !== null);
    expect(detailed?.t === 'report' && detailed.metrics?.rssBytes).toBeGreaterThan(0);
  }, 40_000);

  it('без флага адаптера стенд ведёт себя как прежде: ни одной управляющей линии', async () => {
    const run = await startStand([]);
    await until(() => run.log.some((line) => line.includes('жду участников')));
    // Ожидание тишины: управляющих линий не появляется и позже.
    await new Promise((done) => setTimeout(done, 1500));
    expect(run.control).toEqual([]);
    expect(run.log.join('\n')).toContain('стенд демо-арены');
  }, 40_000);
});
