/**
 * Golden-file suite (CLI-4, CLI-5). Сценарии и эталоны лежат вне `core-ts` —
 * в `engine/tests/golden/`: набор общий для всех реализаций ядра, а этот файл
 * лишь адаптер TS-реализации к нему.
 *
 * `npm run golden` (UPDATE_GOLDEN=1) перезаписывает эталоны; обычный прогон
 * только сверяет, поэтому изменение поведения системы краснеет здесь.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScenarioBytes, type ScenarioDef } from '../src/sim/scenario.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const decoder = new TextDecoder();

const scenarios = readdirSync(GOLDEN_DIR)
  .filter((name) => name.endsWith('.scenario.json'))
  .sort();

function load(name: string): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as ScenarioDef;
}

describe('golden-файлы (CLI-4, CLI-5)', () => {
  it('сценарии найдены', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const name of scenarios) {
    const goldenPath = join(GOLDEN_DIR, name.replace('.scenario.json', '.golden.json'));

    it(`${name} совпадает с эталоном`, () => {
      const produced = decoder.decode(runScenarioBytes(load(name)));
      if (UPDATE) {
        writeFileSync(goldenPath, produced);
        return;
      }
      expect(produced).toBe(readFileSync(goldenPath, 'utf8'));
    });

    it(`${name}: два прогона дают те же байты (DET-1)`, () => {
      const def = load(name);
      expect(decoder.decode(runScenarioBytes(def))).toBe(decoder.decode(runScenarioBytes(def)));
    });
  }
});
