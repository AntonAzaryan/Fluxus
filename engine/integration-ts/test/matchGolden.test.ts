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
 *
 * Сами определения записей — генератор ввода, число тиков и конфиг — живут в
 * `benchLoad.ts` (`MATCH_RECORDINGS`), а не здесь: этой же записью гейт
 * стоимости меряет провод сервера (`performance-budget` PERF-12), и второй
 * список рядом разошёлся бы с первым молча.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_DIR, MATCH_RECORDINGS, recordingFile } from './benchLoad.js';

const UPDATE = process.env.UPDATE_MATCHES === '1';

describe('записанные матчи в golden-наборе (CLI-10)', () => {
  for (const recording of MATCH_RECORDINGS) {
    const file = recordingFile(recording.name);
    it(`${file}: свежая запись матча совпадает с фикстурой`, async () => {
      const match = await recording.play();
      const produced = `${JSON.stringify(match.server.toScenario(), null, 2)}\n`;
      const path = join(GOLDEN_DIR, file);
      if (UPDATE) {
        writeFileSync(path, produced);
        return;
      }
      expect(produced).toBe(readFileSync(path, 'utf8'));
    });
  }
});
