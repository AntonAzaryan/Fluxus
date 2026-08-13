/**
 * Клиентская половина сетевого демо: `NetworkShell` поверх `MatchClient`
 * (SHELL-8, `netcode-transport` NTR-10) плюс выбор слота при входе (design D4).
 *
 * Одна дорога на оба сетевых режима страницы. Матч, поднятый своей же вкладкой,
 * и выделенный стенд различаются здесь ровно одним аргументом — как добраться
 * до сервера (`connect`): пара портов либо WebSocket. Ни клиент, ни оболочка
 * этого различия не видят (`net-session` SES-1, SES-2).
 *
 * Выбор слота — тоже сборка, а не протокол: клиент пробует имена ростера по
 * порядку и на штатный отказ `slot-taken` берёт следующее. Первый пришедший
 * получает первый слот; отказ во всех — «матч занят», и это сообщение, а не
 * молчание.
 *
 * Handshake оболочки буферизован до успеха попытки (`bufferedShellPort`):
 * главный поток обязан получить РОВНО ОДИН `hello` (SHELL-5), а неудачная
 * попытка — это лишний. Заодно в него дописывается id своей сущности, который
 * до `Welcome` неизвестен: слот приезжает оттуда (NTR-5).
 */
import {
  query,
  world as coreWorld,
  type EntityId,
  type Serializer,
  type SimulationState,
} from '@game-mvp/core';
import {
  MatchClient,
  buildMatchWorld,
  type ClientCloseReason,
  type Transport,
} from '@game-mvp/net';
import { NetworkShell } from '../src/networkShell.js';
import type { ShellPort } from '../src/protocol.js';
import { createDemoExtractor } from './extractor.js';
import {
  DEMO_MATCH,
  DEMO_SNAPSHOT_RATE,
  demoContentPack,
  demoMatchConfig,
} from './match.js';

/** Сколько ждать исхода одной попытки входа, мс. */
const JOIN_TIMEOUT_MS = 8000;

export interface DemoClientOptions {
  /** Канал к главному потоку (SHELL-3). */
  readonly port: ShellPort;
  /** Как добраться до сервера матча: пара портов или сокет (NTR-2). */
  readonly connect: (playerId: string) => Promise<Transport>;
  /** Имена ростера по порядку попыток (D4). */
  readonly candidates: readonly string[];
  readonly serializer?: Serializer;
  readonly clock?: () => number;
  /** Шаг ожидания исхода попытки; тест двигает матч сам (NTR-12). */
  readonly settle?: () => Promise<void>;
  readonly timeoutMs?: number;
}

export interface DemoJoined {
  readonly ok: true;
  readonly playerId: string;
  readonly shell: NetworkShell;
  readonly client: MatchClient;
  /** Мир, наполняемый снапшотами (SHELL-8): тикать его нечем и не нужно. */
  readonly state: SimulationState;
  /** Сущность своего героя — по слоту из `Welcome` (TICK-5). */
  readonly hero: EntityId;
}

export interface DemoJoinFailed {
  readonly ok: false;
  readonly reason: string;
}

export type DemoJoinResult = DemoJoined | DemoJoinFailed;

/**
 * Порт попыток входа: один настоящий порт — сколько угодно попыток, но ровно
 * один живой потребитель.
 *
 * Отложенная публикация: сообщения копятся, пока сборка не решила, что попытка
 * удалась. `commit` дописывает `extra` в handshake — то, что известно только
 * после `Welcome`, — и дальше порт работает насквозь; `discard` выбрасывает
 * конверт неудачной попытки И ОТЦЕПЛЯЕТ её оболочку.
 *
 * Отцепление здесь не гигиена, а контракт: `ShellPort.onMessage` держит одного
 * потребителя (`protocol.ts`), а под ним лежит `addEventListener`, то есть
 * подписки НАКАПЛИВАЮТСЯ. Оболочка отвергнутой попытки не умирает от
 * `stop()` — она продолжала бы получать каждый `ret` главного потока, а её
 * `ShellSender` складывал бы возвращённые буферы в пул, который никто не
 * дренирует. Поэтому к настоящему порту подписка идёт ровно одна, а кто за ней
 * стоит — решает эта обёртка.
 */
export function bufferedShellPort(real: ShellPort): {
  readonly port: ShellPort;
  commit(extra: unknown): void;
  discard(): void;
} {
  let buffered: unknown[] | null = [];
  let consumer: ((message: unknown) => void) | null = null;
  let subscribed = false;
  return {
    port: {
      post(message, transfer) {
        if (buffered === null) real.post(message, transfer);
        else buffered.push(message);
      },
      onMessage(handler) {
        consumer = handler;
        if (subscribed) return;
        subscribed = true;
        real.onMessage((message) => consumer?.(message));
      },
    },
    commit(extra) {
      const pending = buffered ?? [];
      buffered = null;
      for (const message of pending) {
        const envelope = message as { t?: string };
        real.post(envelope.t === 'hello' ? { ...envelope, extra } : message);
      }
    },
    discard() {
      buffered = [];
      consumer = null;
    },
  };
}

/** Своя сущность в мире матча: слот игрока — поле компонента `Player` (TICK-5). */
export function heroOfSlot(state: SimulationState, slot: number): EntityId {
  for (const entity of query(state.world, { all: ['Player', 'Position'] })) {
    if (coreWorld.getField(state.world, entity, 'Player', 'slot') === slot) return entity;
  }
  throw new Error(`демо: в мире матча нет сущности игрока слота ${slot}`);
}

type Outcome = 'accepted' | 'slot-taken' | 'closed' | 'timeout';

async function waitOutcome(
  client: MatchClient,
  settle: () => Promise<void>,
  now: () => number,
  timeoutMs: number,
): Promise<Outcome> {
  const deadline = now() + timeoutMs;
  for (;;) {
    // `Welcome` — и есть «слот наш» (NTR-5): `Start` придёт, когда займутся все.
    if (client.slot !== undefined) return 'accepted';
    if (client.phase === 'closed') {
      return client.closeDetail.includes('slot-taken') ? 'slot-taken' : 'closed';
    }
    if (now() >= deadline) return 'timeout';
    await settle();
  }
}

function refusal(client: MatchClient, playerId: string, outcome: Outcome): string {
  const reason: ClientCloseReason | undefined = client.closeReason;
  if (outcome === 'timeout') return `сервер не ответил на попытку войти как ${playerId}`;
  return `сервер отказал (${reason ?? '—'}): ${client.closeDetail}`;
}

/**
 * Войти в матч первым свободным слотом и поднять сетевую оболочку.
 *
 * Мир матча поднимается локально КАЖДОЙ попыткой (NTR-5, NTR-10): его хеш —
 * то, чем клиент доказывает серверу, что играет тот же контент, и переиспользовать
 * мир отвергнутой попытки значило бы экономить на единственной проверке, ради
 * которой он существует.
 */
export async function joinDemoMatch(options: DemoClientOptions): Promise<DemoJoinResult> {
  const config = demoMatchConfig(demoContentPack());
  const clock = options.clock ?? (() => performance.now());
  const settle = options.settle ?? (() => new Promise<void>((done) => setTimeout(done, 16)));
  const timeoutMs = options.timeoutMs ?? JOIN_TIMEOUT_MS;
  let lastReason = 'матч занят: свободных слотов нет';
  // Обёртка одна на все попытки: подписка к настоящему порту единственная, и
  // живым потребителем остаётся ровно одна оболочка (см. `bufferedShellPort`).
  const buffered = bufferedShellPort(options.port);

  for (const playerId of options.candidates) {
    let transport: Transport;
    try {
      transport = await options.connect(playerId);
    } catch (error) {
      return { ok: false, reason: `не удалось соединиться: ${String(error)}` };
    }

    const pack = demoContentPack();
    const client = new MatchClient({
      playerId,
      version: config.version,
      content: pack,
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
    });
    const world = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
    });
    const grid = world.sim.terrain?.grid;
    const shell = new NetworkShell({
      mode: 'network',
      port: buffered.port,
      client,
      transport,
      state: world.state,
      // Доставки идут в темпе рассылки снапшотов — знаменатель альфы главного
      // потока берётся оттуда же (SHELL-3, REND-2).
      tickSeconds: 1 / (DEMO_MATCH.snapshotRate ?? DEMO_SNAPSHOT_RATE),
      extractor: createDemoExtractor(grid),
      terrain: grid ?? null,
      // Пауза и перемотка тонкому клиенту не даются: своей машины состояний у
      // него нет (NET-11, REW-6), и HUD прячет эти кнопки (design D5).
      controlButtons: {},
      helloExtra: { hero: 0 },
      clock,
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
    });
    shell.start();

    const outcome = await waitOutcome(client, settle, clock, timeoutMs);
    if (outcome === 'accepted') {
      const hero = heroOfSlot(world.state, client.slot!);
      buffered.commit({ hero, playerId, slot: client.slot });
      return { ok: true, playerId, shell, client, state: world.state, hero };
    }

    lastReason = refusal(client, playerId, outcome);
    buffered.discard();
    shell.stop();
    transport.close('слот занят — пробую следующий');
    // Отказ не про слот (несовпавшая версия, разошедшийся контент, молчание
    // сервера) следующим именем не лечится — повторять его незачем (NTR-5).
    if (outcome !== 'slot-taken') break;
  }

  return { ok: false, reason: lastReason };
}
