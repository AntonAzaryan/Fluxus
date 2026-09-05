/**
 * Конверты сборки демо между главным потоком и воркерами (`app/wiring.ts`):
 * guard'ы опознают СВОЙ конверт и отвергают чужой.
 *
 * Предмет — не форма сообщения ради формы: с конвертом теперь едут документы
 * контент-пака (`game-content` CONT-5, design D4), и сторона матча без них не
 * поднимается вовсе. Конверт без документов обязан быть отличим от полного —
 * иначе воркер собрал бы матч «на умолчаниях», которых у него нет, и первым
 * наблюдаемым стал бы отказ входа по хешу контент-пака (NTR-5).
 */
import { describe, expect, it } from 'vitest';
import {
  isDemoClientInit,
  isDemoServerInit,
  isDemoSoloInit,
  type DemoClientInit,
  type DemoServerInit,
  type DemoSoloInit,
} from '../app/wiring.js';
import type { DemoDocuments } from '../app/match.js';

/** Документы конверту нужны как значение, а не как содержимое: guard их не разбирает. */
const DOCUMENTS = { match: {}, scenes: {}, sceneIds: {} } as unknown as DemoDocuments;

const SERVER: DemoServerInit = { t: 'demo-server-init', documents: DOCUMENTS };
const SOLO: DemoSoloInit = { t: 'demo-solo-init', documents: DOCUMENTS };
const CLIENT: DemoClientInit = { t: 'demo-client-init', documents: DOCUMENTS, url: 'ws://x' };

describe('guard конвертов сборки принимает свой конверт (design D4)', () => {
  it('каждый guard опознаёт свой конверт и не опознаёт чужой', () => {
    expect(isDemoServerInit(SERVER)).toBe(true);
    expect(isDemoSoloInit(SOLO)).toBe(true);
    expect(isDemoClientInit(CLIENT)).toBe(true);

    // Соло-конверт — свой, а не разновидность серверного: воркеры у них разные,
    // и перепутанный конверт поднял бы не ту сторону (SHELL-8).
    expect(isDemoServerInit(SOLO)).toBe(false);
    expect(isDemoSoloInit(SERVER)).toBe(false);
    expect(isDemoClientInit(SERVER)).toBe(false);
    expect(isDemoSoloInit(CLIENT)).toBe(false);
  });

  it('конверт без документов не принимается ни одним guard-ом (CONT-5)', () => {
    expect(isDemoServerInit({ t: 'demo-server-init' })).toBe(false);
    expect(isDemoSoloInit({ t: 'demo-solo-init' })).toBe(false);
    expect(isDemoClientInit({ t: 'demo-client-init', url: 'ws://x' })).toBe(false);
    // И `documents: null` — тоже отсутствие: поле есть, значения нет.
    expect(isDemoSoloInit({ t: 'demo-solo-init', documents: null })).toBe(false);
  });

  it('не сообщение конвертом не считается', () => {
    for (const message of [undefined, null, 42, 'demo-solo-init', {}]) {
      expect(isDemoServerInit(message)).toBe(false);
      expect(isDemoSoloInit(message)).toBe(false);
      expect(isDemoClientInit(message)).toBe(false);
    }
  });
});
