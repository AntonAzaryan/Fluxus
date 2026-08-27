/**
 * Стресс-нагрузка массы NPC (`npc-behavior` NPC-9): двести массовых крипов,
 * режиссёр волн, маршрут и двое героев в центре — тот же документ, стоимость
 * которого стережёт эталон гейта (`engine/tests/golden/npc-stress.cost.json`).
 *
 * Здесь проверяется другое — ВОСПРОИЗВОДИМОСТЬ на массе (DET-1): два прогона
 * одного документа дают те же байты. Побитового эталона состояния у нагрузки
 * нет намеренно: он весил бы мегабайты (основание — `benchLoad.ts` рядом с её
 * загрузчиком), а сравнение прогона с прогоном ловит ровно тот класс ошибки,
 * ради которого эталон и заводят, — недетерминированный обход, порядок или
 * зависимость от машины.
 *
 * Нагрузка лежит в `engine/tests/golden/` рядом с golden-набором и контентом
 * НЕ является: это фикстура движка (CONT-4).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScenario, runScenarioBytes, type ScenarioDef } from '../src/sim/scenario.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');
const decoder = new TextDecoder();

function load(): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, 'npc-stress.load.json'), 'utf8')) as ScenarioDef;
}

describe('NPC-9: масса NPC воспроизводима побитово (DET-1)', () => {
  it('два прогона документа нагрузки дают те же байты', () => {
    const def = load();
    expect(decoder.decode(runScenarioBytes(def))).toBe(decoder.decode(runScenarioBytes(def)));
  });

  it('нагрузка действительно массовая и действительно движется', () => {
    const def = load();
    const run = runScenario(def);
    // Расстановка живёт в конфиге сцены (SER-7): нагрузка — сама арена, а не
    // документ прогона поверх неё.
    const agents = (def.scene.initial ?? []).filter((entry) => entry.prefab === 'Creep').length;
    expect(agents).toBeGreaterThanOrEqual(150);
    // Мир последнего тика отличается от начального: агенты приняли решения и
    // сдвинулись, режиссёр выпустил пополнение.
    const first = JSON.stringify(run.ticks[0]);
    const last = JSON.stringify(run.ticks[run.ticks.length - 1]);
    expect(last).not.toBe(first);
    expect(last.length).toBeGreaterThan(first.length);
  });
});
