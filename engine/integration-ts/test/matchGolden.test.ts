/**
 * Записанные матчи как golden-фикстуры (CLI-10): матч разыгрывается на
 * loopback-стеке, канонический лог снимается `toScenario()` и сверяется с
 * `engine/tests/golden/match-*.scenario.json`. Пары `*.golden.json` к этим
 * сценариям пишет обычный `npm run golden` ядра — отдельного формата у
 * записи матча нет, это сценарий CLI-2.
 *
 * Красный тест здесь означает: сетевой слой стал записывать матч иначе
 * (пейсинг, подстановка кадров, порядок канонического лога). Принятие —
 * явной командой `npm run record` (UPDATE_MATCHES=1) с диффом фикстур на
 * ревью, затем `npm run golden` ядра для пары к новому сценарию.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { duelConfig, fuzzInput, playMatch, propScene, walkRight, type PlayedMatch } from './fixtures.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');
const UPDATE = process.env['UPDATE_MATCHES'] === '1';

const FUZZ_TICKS = 60;
const FUZZ_SEED = 977;

interface Recording {
  readonly file: string;
  readonly play: () => Promise<PlayedMatch>;
}

const RECORDINGS: readonly Recording[] = [
  {
    // Движение одного игрока при молчащем втором: виден и ввод, и подстановка
    // predicted-кадров молчащего слота (TICK-2) в каноническом логе.
    file: 'match-walk.scenario.json',
    play: () => playMatch(24, { a: walkRight(16) }, duelConfig({ name: 'match-walk' })),
  },
  {
    // Seeded-фазз обоих слотов: пространство сценариев шире рукописного.
    file: 'match-fuzz.scenario.json',
    play: () =>
      playMatch(
        FUZZ_TICKS,
        {
          a: fuzzInput(FUZZ_SEED, 'record-p1', FUZZ_TICKS + 64),
          b: fuzzInput(FUZZ_SEED, 'record-p2', FUZZ_TICKS + 64),
        },
        duelConfig({ name: 'match-fuzz', seed: FUZZ_SEED }),
      ),
  },
  {
    // Сцена с непустой расстановкой (SER-7, SER-8): реквизит сцены занимает
    // первые ID, герои матча идут за ним. Забытая в прологе `buildMatchWorld`
    // расстановка сцены краснеет здесь и в паре ядра к этому сценарию (NTR-8).
    file: 'match-props.scenario.json',
    play: () =>
      playMatch(16, { a: walkRight(12) }, duelConfig({ name: 'match-props', scene: propScene() })),
  },
];

describe('записанные матчи в golden-наборе (CLI-10)', () => {
  for (const recording of RECORDINGS) {
    it(`${recording.file}: свежая запись матча совпадает с фикстурой`, async () => {
      const match = await recording.play();
      const produced = `${JSON.stringify(match.server.toScenario(), null, 2)}\n`;
      const path = join(GOLDEN_DIR, recording.file);
      if (UPDATE) {
        writeFileSync(path, produced);
        return;
      }
      expect(produced).toBe(readFileSync(path, 'utf8'));
    });
  }
});
