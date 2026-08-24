/**
 * Собственный темп клиентского хоста (NTR-10, NTR-7): единственное место
 * клиента, где живёт настоящий таймер.
 *
 * Остальные сетевые тесты двигают клиента вручную через `step()` — это шов,
 * ради которого `run()` отделён от шага, и он же оставлял весь таймерный путь
 * непройденным. Проверяется здесь не симуляция (клиент ничего не тикает),
 * а три вещи, которыми ошибка в таймере проявляется на канале:
 *
 * 1. Темп берётся из `Welcome`. Клиент стартует умолчанием в 60 Гц, ещё не
 *    зная матча, и обязан перестроиться на его `tickRate`. Не перестроится —
 *    оценка серверного тика поедет, кадры ввода уйдут с чужими тиками и
 *    приедут на сервер за пределами буфера задержки (NTR-7): ввод пропадает,
 *    а состояние при этом остаётся серверным, потому что расходиться нечему.
 * 2. Закрытие канала снимает таймер. Иначе интервал переживает сокет и
 *    продолжает шагать мёртвым клиентом.
 * 3. `stop()` идемпотентен и действительно останавливает.
 *
 * Подменяются только `setInterval`/`clearInterval`: доставка в loopback идёт
 * микротасками и `settle()` — реальным `setTimeout`, их фейк сломал бы.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectClient, duelConfig, duelScene, harness, settle } from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Оба слота заняты — матч в игре, `advance()` считает тики. Handshake ещё не
 * доставлен. Таймер заводит только первый клиент: второй занимает слот и стоит,
 * иначе `getTimerCount()` считал бы оба интервала.
 */
function connected(tickRate: number) {
  const scene = duelScene();
  const fixture = harness(duelConfig({ tickRate, scene }));
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, {});
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
  return { fixture, a, b };
}

describe('темп клиентского хоста', () => {
  it('перестраивается с умолчания на темп матча из Welcome', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a } = connected(30);

    // Темпа матча ещё нет — таймер заводится на 60 Гц.
    a.host.run();
    await settle();
    expect(a.client.pacing?.tickRate).toBe(30);

    vi.advanceTimersByTime(1000);

    // Первый шаг приходит по умолчанию (16.6 мс), на нём же таймер
    // перезаводится на 33.3 мс — за секунду выходит примерно тридцать шагов.
    // Точное число зависит от того, как планировщик округляет период, поэтому
    // проверяется полоса; останься клиент на 60 Гц, шагов было бы вдвое больше,
    // и в неё он не попал бы.
    expect(a.client.serverTick).toBeGreaterThanOrEqual(28);
    expect(a.client.serverTick).toBeLessThanOrEqual(32);
  });

  it('идёт темпом матча и без перестройки, когда Welcome уже приехал', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a } = connected(60);
    await settle();

    a.host.run();
    // Повторный run() на том же темпе не перезаводит таймер и не сбивает фазу.
    a.host.run();
    vi.advanceTimersByTime(1000);

    expect(a.client.serverTick).toBeGreaterThanOrEqual(58);
    expect(a.client.serverTick).toBeLessThanOrEqual(63);
  });

  it('stop() останавливает шаг и переживает повторный вызов', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a } = connected(60);
    await settle();

    a.host.run();
    vi.advanceTimersByTime(100);
    const stopped = a.client.serverTick;
    expect(stopped).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);

    a.host.stop();
    a.host.stop();
    vi.advanceTimersByTime(1000);

    expect(vi.getTimerCount()).toBe(0);
    expect(a.client.serverTick).toBe(stopped);
  });

  it('закрытие канала снимает таймер и закрывает клиента', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a } = connected(60);
    await settle();

    a.host.run();
    vi.advanceTimersByTime(100);
    const atClose = a.client.serverTick;

    a.transport.close('канал закрыт');
    expect(a.client.phase).toBe('closed');
    // Оборванный канал называется своим исходом, а не «матч кончился»: после
    // него владелец слота вправе вернуться реконнектом (NTR-17).
    expect(a.client.closeReason).toBe('disconnected');

    // Счётчик, а не «тик не растёт»: закрытый клиент и так не считает тики,
    // поэтому по ним утечка интервала неотличима от снятого таймера.
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(a.client.serverTick).toBe(atClose);
  });
});
