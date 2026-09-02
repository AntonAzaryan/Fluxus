/**
 * Расписание с фиксированным темпом без дрейфа (`schedule.ts`, NTR-7).
 *
 * Проверяется в виртуальном времени: часы и таймер подменены, а таймер
 * ОКРУГЛЯЕТ задержку вниз до целых миллисекунд — ровно так, как это делают
 * `setTimeout`/`setInterval` Node и браузера. Именно это округление и делало из
 * `setInterval(1000 / 60)` 62,5 Гц, поэтому без него проверка ничего бы не
 * проверяла.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CATCHUP_STEPS, startPaced, type PacedTimerDeps } from '../src/schedule.js';

interface Virtual {
  readonly deps: PacedTimerDeps;
  /** Продвинуть часы на `ms`, исполняя таймеры в порядке срабатывания. */
  advance(ms: number): void;
  /** Сдвинуть часы, НЕ исполняя таймеров: поток был занят. */
  stall(ms: number): void;
  readonly now: () => number;
}

function virtual(): Virtual {
  let now = 0;
  let nextId = 1;
  const queue: { at: number; id: number; callback: () => void }[] = [];
  const deps: PacedTimerDeps = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextId++;
      // Целые миллисекунды, как у настоящих таймеров.
      queue.push({ at: now + Math.floor(delayMs), id, callback });
      return id;
    },
    clearTimer: (handle) => {
      const index = queue.findIndex((entry) => entry.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
  };
  return {
    deps,
    now: () => now,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        queue.sort((left, right) => left.at - right.at || left.id - right.id);
        const next = queue[0];
        if (next === undefined || next.at > end) break;
        queue.shift();
        now = Math.max(now, next.at);
        next.callback();
      }
      now = end;
    },
    stall(ms) {
      now += ms;
    },
  };
}

const PERIOD = 1000 / 60;

describe('темп без дрейфа', () => {
  it('за секунду исполняется ровно tickRate шагов, несмотря на целые миллисекунды таймера', () => {
    const clock = virtual();
    let steps = 0;
    const timer = startPaced(PERIOD, () => { steps++; }, clock.deps);

    clock.advance(10_000);

    // `setInterval(16.67)` дал бы здесь 625: период округляется до 16 мс.
    expect(steps).toBe(600);
    timer.stop();
  });

  it('интервалы между шагами — 16 и 17 мс вперемешку, а не 16 всегда', () => {
    const clock = virtual();
    const at: number[] = [];
    const timer = startPaced(PERIOD, () => { at.push(clock.now()); }, clock.deps);

    clock.advance(1000);
    timer.stop();

    const gaps = new Set(at.slice(1).map((time, index) => time - at[index]!));
    expect([...gaps].sort()).toEqual([16, 17]);
  });

  it('короткая задержка потока догоняется шагами подряд: счёт шагов не теряется', () => {
    const clock = virtual();
    let steps = 0;
    let stalled = false;
    const timer = startPaced(PERIOD, () => {
      steps++;
      // Один шаг занял поток на десять периодов — сборка мусора, тяжёлый тик.
      if (!stalled) {
        stalled = true;
        clock.stall(10 * PERIOD);
      }
    }, clock.deps);

    clock.advance(2000);

    expect(steps).toBe(120);
    timer.stop();
  });

  it('длинная остановка не даёт залпа: пропущенные шаги не исполняются, точка отсчёта переносится', () => {
    const clock = virtual();
    let steps = 0;
    let burst = 0;
    let lastAt = -1;
    const timer = startPaced(PERIOD, () => {
      steps++;
      // Шаги в один и тот же момент времени — залп.
      if (clock.now() === lastAt) burst++;
      lastAt = clock.now();
    }, clock.deps);

    clock.advance(1000);
    expect(steps).toBe(60);
    // Пауза отладчика: пять секунд, в триста периодов.
    clock.stall(5000);
    clock.advance(1000);

    // За секунду после остановки — секунда шагов, а не шесть.
    expect(steps).toBeGreaterThanOrEqual(60 + 60);
    expect(steps).toBeLessThanOrEqual(60 + 60 + MAX_CATCHUP_STEPS + 1);
    expect(burst).toBeLessThanOrEqual(MAX_CATCHUP_STEPS + 1);
    timer.stop();
  });

  it('stop() снимает назначенный шаг', () => {
    const clock = virtual();
    let steps = 0;
    const timer = startPaced(PERIOD, () => { steps++; }, clock.deps);

    clock.advance(100);
    timer.stop();
    const stopped = steps;
    clock.advance(1000);

    expect(steps).toBe(stopped);
    // Повторный вызов — не ошибка.
    timer.stop();
  });

  it('исключение шага не убивает расписание: следующий шаг назначен', () => {
    const clock = virtual();
    let steps = 0;
    const timer = startPaced(PERIOD, () => {
      steps++;
      if (steps === 3) throw new Error('шаг упал');
    }, clock.deps);

    expect(() => { clock.advance(100); }).toThrow('шаг упал');
    // Исключение прервало продвижение часов на моменте падения — досчитать до
    // секунды от него, а не от ста миллисекунд.
    clock.advance(1000 - clock.now());

    expect(steps).toBe(60);
    timer.stop();
  });

  it('период — положительное конечное число: иначе ошибка сборки, а не таймер на ноль', () => {
    const clock = virtual();
    expect(() => startPaced(0, () => {}, clock.deps)).toThrow(/положительным/);
    expect(() => startPaced(Number.NaN, () => {}, clock.deps)).toThrow(/положительным/);
    expect(() => startPaced(Number.POSITIVE_INFINITY, () => {}, clock.deps)).toThrow(/положительным/);
  });
});
