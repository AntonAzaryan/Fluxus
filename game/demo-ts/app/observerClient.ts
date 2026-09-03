/**
 * Наблюдатель матча на странице демо (`netcode-transport` NTR-9, NTR-21):
 * соединение без игрового слота, поток без фильтрации (`netcode` NET-15),
 * камера ведёт участника перебором (`camera` CAM-10).
 *
 * Отдельным модулем от входа участника (`netClient.ts`), а не веткой в нём, и
 * это ровно то, чем наблюдатель отличается: у него нет ни перебора слотов
 * (слота он не просит), ни политики возврата в матч (возвращать нечего — слот
 * за ним не числится, NTR-6), ни своей сущности. Общее у них — сборка мира по
 * документу матча и сетевая оболочка (`client-shell` SHELL-8), и оно берётся
 * оттуда же, откуда берёт участник: третьего описания матча в демо нет.
 *
 * Третьего РЕЖИМА оболочки при этом не появляется (SHELL-8): наблюдатель —
 * обычный сетевой режим без второй половины. `tick()` не зовётся, мир
 * наполняется применёнными снапшотами, а вверх не уходит ничего — `MatchClient`
 * наблюдателя ввод не отправляет вовсе.
 */
import { type Serializer, type SimulationState } from '@fluxus/core';
import { MatchClient, buildMatchWorld, type Transport } from '@fluxus/net';
import { NetworkShell, type ShellPort } from '@fluxus/client';
import type { HudComposition, HudCompositionEntry } from '@fluxus/hud';
import { createDemoExtractor } from './extractor.js';
import {
  DEMO_MATCH,
  DEMO_SNAPSHOT_RATE,
  demoClientBuildOptions,
  demoContentPack,
  demoMatchConfig,
} from './match.js';
import type { DemoJoinFailed } from './netClient.js';

/**
 * Чем наблюдатель представляется в `Hello` (NTR-4). Идентификатор игрока в
 * сообщении обязателен, но слота наблюдателю не даёт: ростер сервер сверяет
 * только у участников (NTR-6), а имя остаётся тем, что видно в его логе.
 */
export const OBSERVER_PLAYER_ID = 'observer';

/** Сколько ждать приветствия наблюдателю, мс. */
const GREET_TIMEOUT_MS = 8000;

/**
 * Имя селектора своей сущности в реестре демо (`hud.ts`). Виджеты, забинденные
 * на него, у наблюдателя показывать нечего — своей сущности у него нет.
 */
const HERO_SELECTOR = 'hero.entity';

export interface DemoObserverOptions {
  /** Канал к главному потоку (SHELL-3). */
  readonly port: ShellPort;
  /** Как добраться до сервера матча (NTR-2): у наблюдателя имя не спрашивают. */
  readonly connect: () => Promise<Transport>;
  readonly serializer?: Serializer;
  readonly clock?: () => number;
  /** Шаг ожидания приветствия; тест двигает матч сам (NTR-12). */
  readonly settle?: () => Promise<void>;
  readonly timeoutMs?: number;
}

export interface DemoObserving {
  readonly ok: true;
  /** Оболочка наблюдения: сетевой режим без второй половины (SHELL-8). */
  readonly shell: NetworkShell;
  readonly client: MatchClient;
  /** Мир, наполняемый снапшотами (SHELL-8): тикать его нечем и не нужно. */
  readonly state: SimulationState;
  /** Закрыть наблюдение: остановить оболочку и канал. */
  stop(): void;
}

export type DemoObserveResult = DemoObserving | DemoJoinFailed;

/**
 * Композиция HUD наблюдателя (HUD-4): та же, минус записи, забинденные на свою
 * сущность, — панель кулдаунов, живой портрет и полоса здоровья над героем.
 *
 * Фильтром по биндингу, а не вторым значением композиции: состав HUD остаётся
 * ОДНИМ описанием (`hud.ts`), и виджет, добавленный к герою завтра, выпадет у
 * наблюдателя сам. Оставить их значило бы показать кулдауны и портрет ПЕРВОГО
 * попавшегося героя доставки — чужое намерение, которое `netcode` NET-12
 * бережёт даже от участника матча.
 */
export function observerHudComposition(base: HudComposition): HudComposition {
  return { entries: base.entries.filter((entry) => !bindsHero(entry)) };
}

function bindsHero(entry: HudCompositionEntry): boolean {
  return Object.values(entry.bindings ?? {}).includes(HERO_SELECTOR);
}

/**
 * Подключиться наблюдателем и держать наблюдение до `stop()`.
 *
 * Мир матча поднимается ЛОКАЛЬНО, как у участника (NTR-5, NTR-21): его хеш —
 * то, чем клиент доказывает серверу, что смотрит тот же контент, и второй
 * сверки у наблюдателя нет ровно потому, что первая та же самая.
 */
export async function observeDemoMatch(options: DemoObserverOptions): Promise<DemoObserveResult> {
  const config = demoMatchConfig(demoContentPack());
  const clock = options.clock ?? ((): number => performance.now());
  const settle = options.settle ?? ((): Promise<void> => new Promise((done) => setTimeout(done, 16)));

  const world = buildMatchWorld({
    scene: config.scene,
    seed: config.seed,
    players: config.players,
    ...(config.initial !== undefined ? { initial: config.initial } : {}),
    ...demoClientBuildOptions(config),
  });

  let transport: Transport;
  try {
    transport = await options.connect();
  } catch (error) {
    return { ok: false, reason: `не удалось соединиться: ${String(error)}` };
  }

  const client = new MatchClient({
    playerId: OBSERVER_PLAYER_ID,
    version: config.version,
    content: demoContentPack(),
    observer: true,
    ...demoClientBuildOptions(config),
  });
  const shell = new NetworkShell({
    mode: 'network',
    port: options.port,
    client,
    transport,
    state: world.state,
    tickSeconds: 1 / (DEMO_MATCH.snapshotRate ?? DEMO_SNAPSHOT_RATE),
    extractor: createDemoExtractor(world.sim.terrain?.grid),
    terrain: world.sim.terrain?.grid ?? null,
    // Ни паузы, ни перемотки: своей машины состояний у тонкого клиента нет
    // (NET-11, REW-6), а паузу МАТЧА наблюдатель не ставит — сервер ответил бы
    // ему названным отказом `not-a-player` (NTR-20).
    controlButtons: {},
    // Полезная нагрузка handshake (SHELL-5) — то, чего у наблюдателя НЕТ:
    // своей сущности. Главный поток по этому и собирает HUD без виджетов героя
    // и камеру наблюдения, а не по догадке о потоке доставок (SHELL-8).
    helloExtra: { observer: true, players: [...DEMO_MATCH.players] },
    clock,
    ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
  });
  shell.start();

  const deadline = clock() + (options.timeoutMs ?? GREET_TIMEOUT_MS);
  for (;;) {
    // Наблюдение началось приветствием (NTR-21): признак ставит `Welcome`, а не
    // опция клиента, — до него сервер ещё не сказал, что пускает смотреть.
    if (client.observer) break;
    if (client.phase === 'closed') {
      shell.stop();
      return { ok: false, reason: `сервер отказал (${client.closeReason ?? '—'}): ${client.closeDetail}` };
    }
    if (clock() >= deadline) {
      shell.stop();
      transport.close('наблюдатель не дождался приветствия');
      return { ok: false, reason: 'сервер не ответил на попытку смотреть матч' };
    }
    await settle();
  }

  return {
    ok: true,
    shell,
    client,
    state: world.state,
    stop(): void {
      shell.stop();
      if (!transport.isClosed) transport.close('наблюдение закрыто');
    },
  };
}
