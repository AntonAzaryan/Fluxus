/**
 * Режимы сессии в вертикали (`net-session` SES-1, SES-2, SES-9).
 *
 * Утверждение, ради которого ось режима заводится, звучит как «поменялась
 * только сборка». Проверяется оно ровно одним способом: один и тот же ввод,
 * отыгранный с хостом-игроком и на выделенном сервере, обязан дать побитово
 * один канонический лог (NTR-8), а различие обязано быть видно только в
 * опубликованном `SessionInfo`.
 *
 * Собирается всё из публичной поверхности `@game-mvp/net` — как того требует
 * CLI-9 и как это делает запускалка.
 */
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@game-mvp/core';
import {
  DedicatedSession,
  HostSession,
  InProcessRendezvous,
  contentPack,
  joinMatch,
  joinSession,
  type MatchConfig,
  type SessionInfo,
} from '@game-mvp/net';
import { BUILD_ID, TICK_RATE, duelConfig, settle, walkRight, type Clock } from './fixtures.js';

interface Played {
  readonly canonical: readonly InputFrame[];
  readonly info: SessionInfo;
  close(): Promise<void>;
}

function clientOptions(playerId: string, config: MatchConfig) {
  const pack = contentPack({ duel: config.scene });
  return {
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    // Зависимость сборки мира приезжает со сборкой клиента, а не с провода (NTR-14).
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
  };
}

/** Матч с хостом-игроком: лобби, заморозка, свой клиент рядом с сервером. */
async function playListen(ticks: number, config: MatchConfig): Promise<Played> {
  const rendezvous = new InProcessRendezvous();
  const clock: Clock = { ms: 0 };
  const { version: _version, players: _players, ...match } = config;
  const session = await HostSession.open({
    rendezvous,
    version: config.version,
    founder: 'p1',
    slots: 2,
    match,
  });

  const joining = joinSession({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p2', config),
    clientHost: { now: () => clock.ms },
  });
  await settle();
  const started = await session.start();
  const joined = await joining;

  const host = session.localClient(clientOptions('p1', config), {
    now: () => clock.ms,
    input: walkRight(ticks),
  });
  host.host.start();
  await settle();

  for (let i = 0; i < ticks; i++) {
    clock.ms += 1000 / TICK_RATE;
    host.host.step();
    joined.host.step();
    await settle();
    started.host.step();
    await settle();
  }

  return {
    canonical: started.server.canonicalInputs,
    info: session.info,
    close: () => session.close(),
  };
}

/** Тот же матч на выделенном сервере: лобби нет, ростер из конфига. */
async function playDedicated(ticks: number, config: MatchConfig): Promise<Played> {
  const rendezvous = new InProcessRendezvous();
  const clock: Clock = { ms: 0 };
  const session = await DedicatedSession.open({ rendezvous, config });

  const a = await joinMatch({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p1', config),
    clientHost: { now: () => clock.ms, input: walkRight(ticks) },
  });
  const b = await joinMatch({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p2', config),
    clientHost: { now: () => clock.ms },
  });
  await settle();

  for (let i = 0; i < ticks; i++) {
    clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await settle();
    session.host.step();
    await settle();
  }

  return {
    canonical: session.server.canonicalInputs,
    info: session.info,
    close: () => session.close(),
  };
}

/** Хватает, чтобы ввод успел пройти буфер задержки и попасть в лог не одним кадром. */
const TICKS = 30;

describe('режимы сессии в вертикали', () => {
  it('матч с хостом-игроком доходит до состояния второго участника', async () => {
    const config = duelConfig();
    const rendezvous = new InProcessRendezvous();
    const clock: Clock = { ms: 0 };
    const { version: _version, players: _players, ...match } = config;
    const session = await HostSession.open({
      rendezvous,
      version: config.version,
      founder: 'p1',
      slots: 2,
      match,
    });
    const joining = joinSession({
      rendezvous,
      invite: session.invite,
      client: clientOptions('p2', config),
      clientHost: { now: () => clock.ms },
    });
    await settle();
    const started = await session.start();
    const joined = await joining;
    const host = session.localClient(clientOptions('p1', config), {
      now: () => clock.ms,
      input: walkRight(TICKS),
    });
    host.host.start();
    await settle();

    for (let i = 0; i < TICKS; i++) {
      clock.ms += 1000 / TICK_RATE;
      host.host.step();
      joined.host.step();
      await settle();
      started.host.step();
      await settle();
    }

    // Ввод игрока 1 виден в состоянии игрока 2 — то же утверждение, что проверяет
    // внутрипроцессный прогон дуэли (NTR-12), только сессия основана по инвайту.
    expect(joined.client.latest).toBeDefined();
    expect(started.server.metrics.slots[0]!.applied).toBeGreaterThan(0);
    expect(joined.roster).toEqual(['p1', 'p2']);
    await session.close();
  });

  it('канонический лог не зависит от режима сессии (SES-9)', async () => {
    const config = duelConfig();
    const listen = await playListen(TICKS, config);
    const dedicated = await playDedicated(TICKS, config);

    expect(listen.canonical.length).toBeGreaterThan(0);
    expect(listen.canonical).toEqual(dedicated.canonical);

    // Единственное наблюдаемое различие — опубликованный режим.
    expect(listen.info.mode).toBe('listen');
    expect(dedicated.info.mode).toBe('dedicated');
    expect(listen.info.rendezvous).toBe(dedicated.info.rendezvous);

    await listen.close();
    await dedicated.close();
  });
});
