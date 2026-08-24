/**
 * Случайность внутри мозга (BOT-5): человечность бота — это шум прицела и
 * джиттер таймингов, а им нужен генератор.
 *
 * Детерминизм на мозг не распространяется, и несеяная случайность здесь была бы
 * законна. Взят всё же поток ядра с явным seed'ом, и причина не нормативная, а
 * практическая: воспроизводимый мозг чинится по одному прогону, а `Math.random`
 * превращает разбор поведения в ловлю призрака. В симуляцию эта случайность не
 * попадает никак — она уходит во ввод, который остаётся каноническими данными.
 */
import { XorShift128Stream, seedStateFromName } from '@fluxus/core';

export interface BrainRandom {
  /** Целое в [0, bound). */
  below(bound: number): number;
  /** Float в [-1, 1] — амплитуда шума. */
  signed(): number;
}

export function brainRandom(seed: number, streamName: string): BrainRandom {
  const stream = new XorShift128Stream(seedStateFromName(seed, streamName));
  return {
    below: (bound) => (bound <= 1 ? 0 : stream.nextBelow(Math.trunc(bound))),
    signed: () => (stream.next() / 0x1_0000_0000) * 2 - 1,
  };
}
