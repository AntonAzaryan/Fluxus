/**
 * Фазз-смоук (CLI-9): случайные потоки ввода через публичный xorshift ядра.
 * Оракул — реплей-парность NTR-8: записанный матч обязан побитово
 * воспроизводиться прогоном сценария, поэтому ассерты о содержании матча не
 * нужны — любое расхождение состояния ловится сверкой.
 *
 * Оракул сильный, а корма ему нужно много. Seed'ов поэтому список, а не один:
 * поток ввода от seed'а детерминирован целиком, то есть один seed — это одна
 * траектория из пространства всех возможных, и сколько её ни гоняй, новых
 * комбинаций она не даст. Одновременное «влево + вправо», каст в тик выхода за
 * границу, три спавна подряд — каждая такая комбинация либо есть в потоке
 * seed'а, либо её не будет никогда.
 *
 * Дисциплина списка: seed, на котором фазз однажды упал, дописывается сюда
 * НАВСЕГДА и с пометкой, что он поймал. Так список превращается из случайной
 * выборки в набор регрессий, а красный тест по-прежнему воспроизводится с
 * одной попытки — детерминизм прогона от количества seed'ов не страдает.
 *
 * Бюджет тиков фиксирован: пространство расширяется seed'ами и фикстурами, а
 * не удлинением одного прогона.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain } from '@game-mvp/core';
import { fuzzInput, playMatch, type PlayedMatch } from './fixtures.js';

const TICKS = 90;

/**
 * Значения выбраны разнородными нарочно: xorshift от близких seed'ов расходится
 * быстро, но одинаковые по структуре числа — плохой способ это проверять.
 * Крайние (0, 1) отдельно: seed-ноль — классическое место, где реализация PRNG
 * вырождается, и стоит того, чтобы быть в списке постоянно.
 */
const SEEDS = [0, 1, 20260805, 0xc0ffee, 987654321] as const;

function play(seed: number): Promise<PlayedMatch> {
  return playMatch(TICKS, {
    a: fuzzInput(seed, 'fuzz-p1', TICKS + 64),
    b: fuzzInput(seed, 'fuzz-p2', TICKS + 64),
  });
}

describe('фазз по списку seed’ов (CLI-9)', () => {
  it.each(SEEDS)('seed %d: прогон воспроизводим и реплеится побитово (NTR-8)', async (seed) => {
    const first = await play(seed);
    const second = await play(seed);

    // Два независимых матча от одного seed — один и тот же матч целиком:
    // мир, канонический лог, финальное состояние.
    expect(first.server.worldInitHash).toBe(second.server.worldInitHash);
    expect(second.server.canonicalInputs).toEqual(first.server.canonicalInputs);
    expect(snapshotToPlain(second.server.snapshot())).toEqual(
      snapshotToPlain(first.server.snapshot()),
    );

    // Реплей-парность: канонический лог, прогнанный ядром как сценарий,
    // даёт побитово то состояние, в котором остановился сервер.
    const replay = runScenario(first.server.toScenario());
    expect(replay.worldInitHash).toBe(first.server.worldInitHash);
    expect(replay.ticks).toHaveLength(first.server.tick + 1);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(first.server.snapshot()));

    // Вертикаль пережила фазз: мост дожил до последнего снапшота клиента.
    expect(first.bridge.host.view.tick).toBe(first.b.client.latest!.tick);
  });

  /**
   * Разные seed'ы обязаны давать разные матчи. Без этой проверки список выше
   * мог бы молча выродиться: опечатка в прокидывании seed'а (или потеря его в
   * `fuzzInput`) превратила бы пять прогонов в пять копий одного, и фазз
   * продолжил бы зеленеть, перестав что-либо покрывать.
   */
  it('разные seed’ы дают разные потоки ввода, а не пять копий одного', async () => {
    const logs = await Promise.all(
      SEEDS.map(async (seed) => JSON.stringify((await play(seed)).server.canonicalInputs)),
    );
    expect(new Set(logs).size).toBe(SEEDS.length);
  });
});
