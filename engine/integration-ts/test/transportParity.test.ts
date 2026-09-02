/**
 * Тот же матч на другом транспорте (NTR-2): выделенная сессия отыгрывается на
 * внутрипроцессном рандеву и поверх WebSocket, и различие обязано исчерпываться
 * сборкой транспорта — канонический лог, hash `worldInit` и финальное состояние
 * совпадают побитово, а запись реплеится ядром (NTR-8).
 *
 * Здесь поднимаются настоящие сокеты — как в `webSocketRendezvous.test.ts` и по
 * той же причине: предмет проверки — что смена реализации транспорта ничего не
 * меняет, и проверить это подменой транспорта нечем. Порт эфемерный (`0`),
 * конфликтов с машиной нет. Время матча при этом остаётся ручным (`clock.ms`):
 * реальные миллисекунды нужны только доставке, темп двигает тест.
 *
 * Запас у расписания даётся паузами и увеличенным `inputDelay`: сравнение логов
 * сравнивает МАТЧИ, а не задержки канала, поэтому контрольный ассерт сверяет
 * счётчики предсказанных кадров между прогонами — опоздай ввод в одном из них,
 * различие было бы названо счётчиком, а не выглядело бы загадочным диффом лога.
 *
 * Старт матча паузой не ждётся — ждётся ПО УСЛОВИЮ (`untilPlaying`). Над
 * сокетом `Start` едет отдельной poll-фазой цикла событий, а просроченный
 * таймер срабатывает в фазе timers раньше неё: под нагрузкой всего сьюта клиент
 * делал первый шаг ещё не в `playing`, ввод на нём не уходил, и прогон над
 * сокетом отличался от внутрипроцессного одним кадром — счётчик предсказанных
 * называл `[5, 5]` против `[4, 4]`. Внутри цикла тот же порядок фаз безопасен:
 * кадр потребляется через `inputDelay` итераций после отправки, и poll-фаза
 * между ними наступает всегда.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain, type InputFrame } from '@fluxus/core';
import {
  DedicatedSession,
  InProcessRendezvous,
  WebSocketRendezvous,
  contentPack,
  joinMatch,
  type JoinedMatch,
  type MatchConfig,
  type Rendezvous,
} from '@fluxus/net';
import { BUILD_ID, TICK_RATE, duelConfig, fuzzInput, type Clock } from './fixtures.js';

const TICKS = 24;

/** Реальная пауза: сокету, в отличие от loopback, микротасков `settle()` мало. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Предел ожидания старта: не темп матча, а страховка от зависшего теста. */
const START_TIMEOUT_MS = 2000;

/**
 * Ждать, пока каждый клиент не получит `Start` и не перейдёт в `playing`.
 * Условие вместо паузы: пауза измеряла бы не доставку, а совпадение фаз цикла
 * событий (см. шапку), и под нагрузкой это совпадение не гарантировано.
 */
async function untilPlaying(clients: readonly JoinedMatch[]): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!clients.every((joined) => joined.client.phase === 'playing')) {
    if (Date.now() > deadline) {
      const phases = clients.map((joined) => joined.client.phase).join(', ');
      throw new Error(`Start не доехал до клиентов за ${START_TIMEOUT_MS} мс: фазы ${phases}`);
    }
    await pause(1);
  }
}

function clientOptions(playerId: string, config: MatchConfig) {
  const pack = contentPack({ duel: config.scene });
  return {
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
}

interface Played {
  readonly via: string;
  readonly worldInitHash: string;
  readonly canonical: readonly InputFrame[];
  readonly final: unknown;
  readonly predicted: readonly number[];
  readonly replayed: unknown;
}

async function playDedicated(rendezvous: Rendezvous, config: MatchConfig): Promise<Played> {
  const clock: Clock = { ms: 0 };
  const session = await DedicatedSession.open({ rendezvous, config });
  const a = await joinMatch({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p1', config),
    clientHost: { now: () => clock.ms, input: fuzzInput(config.seed, 'parity-p1', TICKS + 64) },
  });
  const b = await joinMatch({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p2', config),
    clientHost: { now: () => clock.ms, input: fuzzInput(config.seed, 'parity-p2', TICKS + 64) },
  });
  await untilPlaying([a, b]);

  for (let i = 0; i < TICKS; i++) {
    clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await pause(2);
    session.host.step();
    await pause(2);
  }

  const replay = runScenario(session.server.toScenario());
  const played: Played = {
    via: session.info.rendezvous,
    worldInitHash: session.server.worldInitHash,
    canonical: [...session.server.canonicalInputs],
    final: snapshotToPlain(session.server.snapshot()),
    predicted: session.server.metrics.slots.map((slot) => slot.predicted),
    replayed: replay.ticks[replay.ticks.length - 1],
  };
  await session.close();
  return played;
}

describe('парность транспортов выделенной сессии (NTR-2)', () => {
  it('канонический лог и финальное состояние не зависят от транспорта', async () => {
    // Один конфиг на оба прогона: различаться им больше нечем.
    const config = duelConfig({ inputDelay: 4 });
    const inProcess = await playDedicated(new InProcessRendezvous(), config);
    const webSocket = new WebSocketRendezvous({ port: 0, host: '127.0.0.1' });
    const overSocket = await playDedicated(webSocket, config);
    await webSocket.close();

    // Контроль один: матчи шли на действительно разных транспортах.
    expect(inProcess.via).toBe('in-process');
    expect(overSocket.via).toBe('ws');
    // Контроль два: судьба кадров в обоих прогонах одна — если бы ввод опоздал
    // на одном из транспортов, дифф был бы назван здесь, а не в логе.
    expect(overSocket.predicted).toEqual(inProcess.predicted);

    // Смена транспорта не меняет ни пролог, ни лог, ни состояние (NTR-2).
    expect(overSocket.worldInitHash).toBe(inProcess.worldInitHash);
    expect(overSocket.canonical.length).toBeGreaterThan(0);
    expect(overSocket.canonical).toEqual(inProcess.canonical);
    expect(overSocket.final).toEqual(inProcess.final);

    // И обе записи — по-прежнему канонические: прогон ядра даёт серверное
    // состояние побитово (NTR-8).
    expect(inProcess.replayed).toEqual(inProcess.final);
    expect(overSocket.replayed).toEqual(overSocket.final);
  });
});
