/**
 * Режим наблюдателя на странице демо (`netcode-transport` NTR-9, NTR-21):
 * выбор режима, вход наблюдателем в поднятый матч, состав HUD и разрешение
 * стенда.
 *
 * Собирается теми же модулями, что вкладка (`app/observerClient.ts`,
 * `app/localSession.ts`, `app/match.ts`): своей реализации клиента или сервера
 * здесь нет (NTR-12), подменены только среда исполнения бота и расписание —
 * матч двигает тест, а не таймеры.
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isBotWorkerInit,
  startBotWorker,
  type BotHost,
  type WorkerLike,
} from '@fluxus/bot';
import type { RenderSubsystem, TickView } from '@fluxus/render';
import { RemoteHost, portTransport, shellPort, type ShellPort } from '@fluxus/client';
import { demoMatchConfig, type DemoDocuments } from '../app/match.js';
import { demoBotBehavior, demoBotProfile } from '../app/bots.js';
import { openLocalSession, type DemoLocalSession } from '../app/localSession.js';
import { demoHudComposition } from '../app/hud.js';
import { observeDemoMatch, observerHudComposition } from '../app/observerClient.js';
import { demoMode, slotCandidates } from '../app/mode.js';
import { standArgs } from '../app/demoStand.js';
import { demoDocuments, dummyContext, syncPortPair } from './fixtures.js';

const channels: MessageChannel[] = [];
const sessions: DemoLocalSession[] = [];
let bots: BotHost | null = null;

/** Документы контент-пака из дерева — тем же загрузчиком, что у страницы (CONT-5). */
let documents: DemoDocuments;
/** Ростер матча из прочитанного документа: имена слотов — данные матча (TICK-5). */
let players: readonly string[];

beforeAll(async () => {
  documents = await demoDocuments();
  players = documents.match.players;
});

afterEach(async () => {
  bots?.dispose();
  bots = null;
  for (const session of sessions) await session.dispose();
  sessions.length = 0;
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.length = 0;
});

async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeChannel(): MessageChannel {
  const channel = new MessageChannel();
  channels.push(channel);
  return channel;
}

function botThread(): WorkerLike {
  return {
    postMessage(message: unknown): void {
      if (isBotWorkerInit(message)) bots = startBotWorker(message, { autoRun: false });
    },
  };
}

/**
 * Матч стенда, ПУСКАЮЩИЙ наблюдателя (NTR-9): разрешение — решение запуска, и
 * здесь оно принимается так же, как флагом `--observer` у `demo-serve.mjs`.
 * Слоты держат боты — человека в этом матче нет вовсе, смотрят за ними.
 */
function watchedSession(): DemoLocalSession {
  const profile = demoBotProfile('профиль бота теста');
  const opened = openLocalSession({
    config: { ...demoMatchConfig(documents), allowObserver: true },
    reserved: [],
    bots: {
      worker: botThread(),
      channel: () => makeChannel(),
      brain: 'evaluated',
      profile,
      behavior: demoBotBehavior(profile),
    },
  });
  sessions.push(opened);
  return opened;
}

interface Probe {
  readonly subsystem: RenderSubsystem;
  readonly views: TickView[];
}

function probe(): Probe {
  const views: TickView[] = [];
  return {
    views,
    subsystem: {
      name: 'probe',
      init: () => {},
      syncTick: (view) => views.push(view),
      updateFrame: () => {},
    },
  };
}

/** Вход наблюдателем тем же путём, каким входит вкладка в режиме `?observer`. */
async function watch(opened: DemoLocalSession, clock: { ms: number }) {
  const [rawWorkerPort, mainPort] = syncPortPair();
  const posted: unknown[] = [];
  const workerPort: ShellPort = {
    post(message, transfer) {
      posted.push(message);
      rawWorkerPort.post(message, transfer);
    },
    onMessage(handler) {
      rawWorkerPort.onMessage(handler);
    },
  };
  const shellProbe = probe();
  const remote: RemoteHost = new RemoteHost(dummyContext(), {
    clock: () => clock.ms,
    onReady: () => remote.register(shellProbe.subsystem),
  }).connect(mainPort);
  const observing = await observeDemoMatch({
    port: workerPort,
    documents,
    connect: () => Promise.resolve(portTransport(shellPort(opened.connect(makeChannel())))),
    clock: () => clock.ms,
    settle: () => flush(1),
    timeoutMs: 2000,
  });
  return { observing, remote, probe: shellProbe, posted };
}

function hellos(posted: readonly unknown[]): { extra?: Record<string, unknown> }[] {
  return posted.filter(
    (message): message is { t: 'hello'; extra?: Record<string, unknown> } =>
      (message as { t?: string }).t === 'hello',
  );
}

describe('режим страницы: наблюдатель (SHELL-8, NTR-21)', () => {
  const page = { protocol: 'http:', hostname: 'localhost' };

  it('`?observer` — свой режим с адресом стенда, а не разновидность `?server`', () => {
    expect(demoMode('?observer', page)).toEqual({
      kind: 'observer',
      url: 'ws://localhost:8080',
    });
    expect(demoMode('?observer&server=ws://10.0.0.5:9000', page)).toEqual({
      kind: 'observer',
      url: 'ws://10.0.0.5:9000',
    });
    // Наблюдать можно только матч, который кто-то держит: без `?observer`
    // прежние режимы не тронуты.
    expect(demoMode('?server=', page)).toEqual({ kind: 'server', url: 'ws://localhost:8080' });
    expect(demoMode('', page)).toEqual({ kind: 'local' });
    // `?solo` остаётся сильнее: там сервера нет вовсе, и смотреть нечего.
    expect(demoMode('?solo&observer', page)).toEqual({ kind: 'solo' });
  });

  it('у наблюдателя нет кандидатов на слот: слота он не просит (NTR-9)', () => {
    expect(slotCandidates({ kind: 'observer', url: 'ws://x' }, players)).toEqual([]);
    // У прочих режимов перебор прежний.
    expect(slotCandidates({ kind: 'server', url: 'ws://x' }, players)).toEqual([...players]);
  });

  it('стенд пускает наблюдателя только по флагу запуска (NTR-9)', () => {
    expect(standArgs({ port: 8080, script: '/s.mjs' })).toEqual(['/s.mjs', '--port', '8080']);
    expect(standArgs({ port: 8080, script: '/s.mjs', observer: true })).toEqual([
      '/s.mjs',
      '--port',
      '8080',
      '--observer',
    ]);
  });
});

describe('состав HUD наблюдателя (HUD-4, NTR-21)', () => {
  const base = demoHudComposition({ controls: false, matchPause: true, tickMs: 1000 / 60 });
  const widgets = (composition = base): string[] =>
    composition.entries.map((entry) => entry.widget);

  it('виджеты своего героя не монтируются: своей сущности у наблюдателя нет', () => {
    // Контроль: в обычной сборке они есть — иначе тест ничего бы не проверял.
    expect(widgets()).toEqual(expect.arrayContaining(['cooldowns', 'portrait', 'hp-bar']));

    const observed = widgets(observerHudComposition(base));
    expect(observed).not.toContain('cooldowns');
    expect(observed).not.toContain('portrait');
    expect(observed).not.toContain('hp-bar');
  });

  it('остальное остаётся: оно живёт на той же доставке (HUD-1)', () => {
    const observed = widgets(observerHudComposition(base));
    expect(observed).toEqual(
      expect.arrayContaining(['match-status', 'runtime', 'deaths', 'minimap', 'pause-overlay']),
    );
    // Ни один оставшийся виджет не забинден на своего героя.
    for (const entry of observerHudComposition(base).entries) {
      expect(Object.values(entry.bindings ?? {})).not.toContain('hero.entity');
    }
  });
});

describe('наблюдатель смотрит матч стенда насквозь (NTR-21, NET-15)', () => {
  it('входит без слота, получает весь мир и не отправляет ввода', async () => {
    const clock = { ms: 0 };
    const opened = watchedSession();
    // Слоты держат боты: матч идёт сам, а смотрят за ним.
    opened.filler.fill();
    await flush();
    expect(opened.server.phase).toBe('running');

    const rig = await watch(opened, clock);
    expect(rig.observing.ok).toBe(true);
    if (!rig.observing.ok) return;
    // Таймер оболочки снимается: шаги делает тест (NTR-12).
    rig.observing.shell.stop();

    expect(rig.observing.client.observer).toBe(true);
    expect(rig.observing.client.slot).toBeUndefined();
    // Handshake доехал ровно один (SHELL-5), и своей сущности в нём нет —
    // именно по нему страница собирает HUD без виджетов героя (SHELL-8).
    expect(rig.remote.mode).toBe('network');
    expect(hellos(rig.posted)).toHaveLength(1);
    expect(hellos(rig.posted)[0]!.extra).toEqual({ observer: true, players: [...players] });

    for (let i = 0; i < 20; i++) {
      clock.ms += 1000 / 60;
      rig.observing.shell.step();
      bots!.step();
      await flush(1);
      opened.host.step();
      await flush(1);
    }
    rig.observing.shell.step();
    await flush();

    expect(rig.observing.client.phase).toBe('playing');
    expect(rig.observing.client.metrics.snapshotsApplied).toBeGreaterThan(0);
    // Поток без фильтрации (NET-15, NTR-9): в кадре ОБА участника, тогда как
    // персональный снапшот игрока этой же сцены несёт одного — второй за
    // пределами обзора (FOW-7), и сервер вырезает его до провода (NET-12).
    const view = rig.probe.views.at(-1)!;
    const heroes = [...view.entities.values()].filter((entity) => entity.kind === 'Hero');
    expect(heroes).toHaveLength(players.length);
    // Вверх не уехало ничего: ни одного кадра ввода (NTR-21).
    expect(rig.observing.client.metrics.inputsSent).toBe(0);
    expect(opened.server.canonicalInputs.every((frame) => frame.playerId !== 'observer')).toBe(true);

    rig.observing.stop();
  });

  it('стенд без разрешения отвечает названным отказом, а не тишиной (NTR-9)', async () => {
    const clock = { ms: 0 };
    const profile = demoBotProfile('профиль бота теста');
    const opened = openLocalSession({
      // Разрешения нет — ровно то, чем стенд поднят без `--observer`.
      config: demoMatchConfig(documents),
      reserved: [],
      bots: {
        worker: botThread(),
        channel: () => makeChannel(),
        brain: 'evaluated',
        profile,
        behavior: demoBotBehavior(profile),
      },
    });
    sessions.push(opened);

    const rig = await watch(opened, clock);
    expect(rig.observing.ok).toBe(false);
    if (rig.observing.ok) return;
    expect(rig.observing.reason).toContain('observer-not-allowed');
  });
});
