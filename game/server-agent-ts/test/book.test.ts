/**
 * Книга процессов и сверка по МОМЕНТУ старта (решение D5).
 *
 * Голого «процесс с этим PID жив» мало: после перезагрузки тот же номер носит
 * чужой процесс, и `adopt` воскресил бы фантомный сервер, а `stop` убил бы
 * постороннего. Момент старта отличает наш процесс от занявшего его номер.
 */
import { describe, expect, it } from 'vitest';
import { processStartTicks, sameProcess } from '../src/state/book.js';

/** Заведомо мёртвый идентификатор процесса: своего PID тест не трогает. */
const DEAD_PID = 2_147_483_646;

describe('момент старта процесса и sameProcess (решение D5)', () => {
  const linux = process.platform === 'linux';

  it('свой процесс читается с ненулевым моментом старта (Linux)', () => {
    if (!linux) return;
    expect(processStartTicks(process.pid)).toBeGreaterThan(0);
    // Мёртвого процесса нет — читать нечего.
    expect(processStartTicks(DEAD_PID)).toBe(0);
  });

  it('sameProcess требует совпадения момента, а не только PID', () => {
    const startProc = linux ? processStartTicks(process.pid) : 0;
    // Свой процесс с ПРАВИЛЬНЫМ моментом — это он.
    expect(sameProcess({ pid: process.pid, startProc })).toBe(true);

    if (linux) {
      // Тот же живой PID, но ЧУЖОЙ момент старта — уже не наш процесс: ровно
      // так выглядит переиспользованный после перезагрузки номер.
      expect(sameProcess({ pid: process.pid, startProc: startProc + 1 })).toBe(false);
    }

    // Мёртвый PID — не наш ни при каком моменте.
    expect(sameProcess({ pid: DEAD_PID, startProc: 12_345 })).toBe(false);
  });

  it('момент неизвестен (`0`) — падаем на голое существование', () => {
    // На не-Linux момента нет; книга старых версий его тоже не носит. Тогда
    // `sameProcess` не строже проверки существования — лучшего у нас нет.
    expect(sameProcess({ pid: process.pid, startProc: 0 })).toBe(true);
    expect(sameProcess({ pid: DEAD_PID, startProc: 0 })).toBe(false);
  });
});
