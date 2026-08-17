/**
 * Сторож реального времени ядра (`performance-budget` PERF-5, задача 3.2):
 * сколько тиков в секунду вытягивает симуляция на записанном матче (CLI-10).
 *
 * Не гейт стоимости — тот рядом, в `cost.test.ts`, и он точный (PERF-4).
 * Здесь меряется то, чего счётчики не видят в принципе: константное замедление
 * на единицу работы, при котором объём работы не изменился ни на команду.
 *
 * Конвенции — те же, что у замеров канала (`client-ts/test/bench.test.ts`) и
 * рендера (`render-ts/test/bench.test.ts`): прогрев JIT, `performance.now()`
 * вокруг измеряемого цикла, печать `[bench]` при КАЖДОМ прогоне, ассерт только
 * против деградации на порядок. Жёстких порогов здесь MUST NOT быть (PERF-5):
 * числа между машинами несравнимы, и порог «в притык» краснел бы на слабой
 * машине разработчика, ничего не поймав.
 *
 * Мерится чистый цикл тиков: сборка мира вынесена из замера, снапшоты не
 * строятся, диагностика не подключена — иначе сторож стерёг бы сериализацию
 * прогона, а не симуляцию.
 */
import { describe, expect, it } from 'vitest';
import { RECORDED_MATCHES, loadRecording, prepareRecording } from './benchLoad.js';

/** Прогонов на прогрев JIT и прогонов под замером. */
const WARMUP = 20;
const REPEATS = 40;

/**
 * Сторожевой порог: наблюдаемое на машине разработчика — 30 000…50 000 тиков/с
 * (разброс между записями — постоянные затраты тика, а не их объём). Порог на
 * порядок ниже наблюдаемого: разница машин его не трогает, а замедление на
 * порядок краснеет (PERF-5). Жёстче ассертить wall-time MUST NOT.
 */
const MIN_TICKS_PER_SECOND = 3_000;

/**
 * Тиков в секунду на одной записи. Миры собраны заранее и по одному на прогон:
 * замер обязан покрывать только цикл тиков, а повторный прогон — начинаться с
 * того же начального состояния, что и первый.
 */
function ticksPerSecond(name: string): number {
  const def = loadRecording(name);
  for (let i = 0; i < WARMUP; i++) prepareRecording(def).run();

  const prepared = Array.from({ length: REPEATS }, () => prepareRecording(def));
  const t0 = performance.now();
  for (const recording of prepared) recording.run();
  const elapsedMs = performance.now() - t0;

  const ticks = def.ticks * REPEATS;
  const rate = (ticks / elapsedMs) * 1000;
  console.log(
    `[bench] тик ядра, ${name}: ${Math.round(rate).toLocaleString('ru-RU')} тиков/с ` +
      `(${((elapsedMs / ticks) * 1000).toFixed(1)} мкс/тик, ${ticks} тиков за ${elapsedMs.toFixed(1)} мс)`,
  );
  return rate;
}

describe('замеры ядра на записанных матчах (информативно)', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: тиков в секунду выше порядка сторожевого порога`, () => {
      expect(ticksPerSecond(match)).toBeGreaterThan(MIN_TICKS_PER_SECOND);
    });
  }
});
