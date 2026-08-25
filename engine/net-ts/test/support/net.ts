/**
 * Подпорки тестов, которым нужен настоящий сокет: свободный порт и ожидание по
 * условию.
 *
 * Ожидание — ПО УСЛОВИЮ с крайним сроком, а не по часам: медленная машина
 * обязана делать тест медленнее, а не красным. Тот же приём, что в контрактном
 * сьюте контейнера.
 */
import { createServer } from 'node:net';

/** Свободный порт у системы: фиксированный номер поссорил бы прогоны на одной машине. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

/** Ждёт условия до крайнего срока; возвращает его последнее значение. */
export async function until(condition: () => boolean, deadlineMs = 4000): Promise<boolean> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 5));
  }
  return condition();
}
