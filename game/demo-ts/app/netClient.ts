/**
 * Клиентская половина сетевого демо: `NetworkShell` поверх `MatchClient`
 * (SHELL-8, `netcode-transport` NTR-10) плюс выбор слота при входе (design D4)
 * и возврат в матч после разрыва (NTR-17, design D8).
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
 * Переподключение — политика ЭТОЙ сборки, а не движка: оборвался канал в бою —
 * демо повторяет вход своим же именем игрока с растущей паузой, пока сервер
 * доступен и не сказал «матч кончился» либо окончательного отказа. Каждая
 * попытка — НОВЫЙ `MatchClient` и новая оболочка (design D5): чистые курсоры,
 * пустой буфер интерполяции и snap первого состояния достаются свойством
 * свежего инстанса, а не ручным сбросом, полноту которого пришлось бы
 * доказывать (NTR-17).
 *
 * Handshake оболочки буферизован до успеха попытки (`bufferedShellPort`):
 * главный поток обязан получить РОВНО ОДИН `hello` (SHELL-5), а неудачная
 * попытка — это лишний. Возврат в матч — тоже: оболочка новая, а сессия
 * главного потока та же. Заодно в handshake дописывается id своей сущности,
 * который до `Welcome` неизвестен: слот приезжает оттуда (NTR-5).
 */
import {
  query,
  world as coreWorld,
  type EntityId,
  type Serializer,
  type SimulationState,
} from '@fluxus/core';
import {
  MatchClient,
  buildMatchWorld,
  type ClientCloseReason,
  type Transport,
} from '@fluxus/net';
import { NetworkShell, type ShellPort } from '@fluxus/client';
import { createDemoExtractor } from './extractor.js';
import {
  DEMO_MATCH,
  DEMO_SNAPSHOT_RATE,
  demoContentPack,
  demoMatchConfig,
} from './match.js';

/** Сколько ждать исхода одной попытки входа, мс. */
const JOIN_TIMEOUT_MS = 8000;

/**
 * Паузы между попытками возврата, мс (design D8). Растущие и с потолком:
 * короткий всплеск лечится первой же попыткой, а сервер, которого нет,
 * не должен получать поток подключений. Хвост укладывается в окно возврата
 * демо-арены (`silenceSeconds` документа матча, NTR-6): попытки кончаются
 * раньше, чем матч — порогом молчания.
 */
const RECONNECT_DELAYS_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000,
];

/** Текст состояния «переподключение» для главного потока (design D8). */
export const RECONNECTING_NOTICE = 'соединение потеряно — возвращаюсь в матч…';
/** Пустое уведомление гасит показанное: возврат состоялся. */
const NOTICE_CLEARED = '';

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
  /**
   * Состояние сессии наружу — для страницы демо: «возвращаюсь в матч», «матч
   * кончился» (design D8). Пустая строка гасит показанное.
   */
  readonly notify?: (message: string) => void;
  /** Паузы между попытками возврата; тест двигает время сам. */
  readonly reconnectDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DemoJoined {
  readonly ok: true;
  readonly playerId: string;
  /** Оболочка ТЕКУЩЕГО подключения: возврат в матч поднимает новую (design D5). */
  readonly shell: NetworkShell;
  /** Клиент текущего подключения — он же одноразовый (NTR-17, design D5). */
  readonly client: MatchClient;
  /** Мир, наполняемый снапшотами (SHELL-8): тикать его нечем и не нужно. */
  readonly state: SimulationState;
  /** Сущность своего героя — по слоту из `Welcome` (TICK-5). */
  readonly hero: EntityId;
  /** Идёт ли сейчас возврат в матч — состояние для HUD страницы (design D8). */
  readonly reconnecting: boolean;
  /** Закрыть сессию: остановить оболочку и не пытаться возвращаться. */
  stop(): void;
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
 * Возврата в матч эта обёртка не касается: оболочка сессии одна на все её
 * подключения (`NetworkShell.reattach`), и `hello` она шлёт единственный раз —
 * на старте. «Главный поток получает РОВНО ОДИН handshake» (SHELL-5) держится
 * тем самым здесь против отвергнутых попыток входа, а реаттач второго и не
 * порождает: режим, темп, террейн и словарь статов от возврата не меняются.
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
 * Наблюдающая обёртка над транспортом: даёт сборке узнать о закрытии канала, не
 * отнимая единственный обработчик у `ClientHost` (`BaseTransport` держит по
 * одному обработчику на событие, и владеет ими оболочка).
 *
 * Обёртка, а не опрос состояния клиента таймером: закрытие — событие, и
 * сторожевой таймер, крутящийся всю сессию, стоил бы дороже и жил бы дольше,
 * чем то, что он сторожит.
 */
function watchedTransport(inner: Transport, onClosed: () => void): Transport {
  return {
    get isClosed() {
      return inner.isClosed;
    },
    send: (bytes) => {
      inner.send(bytes);
    },
    close: (reason) => {
      inner.close(reason);
    },
    onMessage: (handler) => {
      inner.onMessage(handler);
    },
    onClose: (handler) => {
      inner.onClose((reason) => {
        // Сначала оболочка: она закрывает клиента и называет исход
        // (`onTransportClosed`), а решение «возвращаться или нет» читает его.
        handler(reason);
        onClosed();
      });
    },
  };
}

/** Одно подключение: клиент попытки, её канал и исход входа. */
interface Attempt {
  readonly client: MatchClient;
  readonly transport: Transport;
  readonly outcome: Outcome;
}

/** Клиент матча одной попытки — одноразовый по построению (design D5, NTR-17). */
function attemptClient(playerId: string): MatchClient {
  const config = demoMatchConfig(demoContentPack());
  return new MatchClient({
    playerId,
    version: config.version,
    content: demoContentPack(),
    // Тот же номер бита, которым настроен сервер (`rewind.holdButton` из
    // документа матча): пока мир не в `Running`, наружу уезжает только он —
    // ведение скраба, — а движение и остальные действия маскируются (NET-11).
    ...(config.rewind?.holdButton !== undefined ? { holdButton: config.rewind.holdButton } : {}),
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  });
}

/**
 * Стоит ли повторять вход после закрытия канала (design D8).
 *
 * Повторяются ровно два исхода: оборванный канал (`disconnected` — владелец
 * слота вправе вернуться, пока не превышен порог молчания, NTR-6, NTR-17) и
 * «слот занят» — сервер ещё не заметил, что прежнее соединение умерло.
 * Остальное окончательно: матч кончился (`End`), разошлись версия или данные
 * матча (NTR-5), сломался протокол — повтор не лечит ни одного из них.
 */
function retryable(client: MatchClient): boolean {
  if (client.closeReason === 'disconnected') return true;
  return client.closeReason === 'rejected' && client.closeDetail.includes('slot-taken');
}

/**
 * Войти в матч первым свободным слотом, поднять сетевую оболочку и держать
 * сессию: разрыв в бою — не конец, а повод вернуться (NTR-17, design D8).
 *
 * Мир матча поднимается локально КАЖДОЙ попыткой ВХОДА (NTR-5, NTR-10): его
 * хеш — то, чем клиент доказывает серверу, что играет тот же контент, и
 * переиспользовать мир отвергнутой попытки значило бы экономить на единственной
 * проверке, ради которой он существует. Возврат в матч — другое дело: мир уже
 * поднят и принят, а его состояние и есть то, которое держит потребитель, —
 * первый же снапшот вернёт его в «сейчас» матча.
 */
export async function joinDemoMatch(options: DemoClientOptions): Promise<DemoJoinResult> {
  const config = demoMatchConfig(demoContentPack());
  let lastReason = 'матч занят: свободных слотов нет';
  // Обёртка одна на все попытки: подписка к настоящему порту единственная, и
  // живым потребителем остаётся ровно одна оболочка (см. `bufferedShellPort`).
  const buffered = bufferedShellPort(options.port);

  for (const playerId of options.candidates) {
    const world = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
    });
    const grid = world.sim.terrain?.grid;
    const session = demoSession(options, playerId, world.state, grid, buffered);
    const attempt = await session.begin();
    if ('failure' in attempt) return { ok: false, reason: attempt.failure };
    if (attempt.outcome === 'accepted') return session.joined(attempt);

    lastReason = refusal(attempt.client, playerId, attempt.outcome);
    buffered.discard();
    session.release(attempt, 'слот занят — пробую следующий');
    // Отказ не про слот (несовпавшая версия, разошедшийся контент, молчание
    // сервера) следующим именем не лечится — повторять его незачем (NTR-5).
    if (attempt.outcome !== 'slot-taken') break;
  }

  return { ok: false, reason: lastReason };
}

/**
 * Сессия одного имени игрока: текущее подключение и политика возврата в матч
 * (design D8). Политика повторов — код ДЕМО, а не движка: сервер о ней не знает
 * и знать не должен, для него возврат — обычный вход (NTR-17).
 */
function demoSession(
  options: DemoClientOptions,
  playerId: string,
  state: SimulationState,
  grid: Parameters<typeof createDemoExtractor>[0],
  buffered: ReturnType<typeof bufferedShellPort>,
) {
  const notify = options.notify ?? ((): void => {});
  const clock = options.clock ?? (() => performance.now());
  const settle = options.settle ?? (() => new Promise<void>((done) => setTimeout(done, 16)));
  const delays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let current: Attempt | undefined;
  /**
   * Оболочка сессии — ОДНА на все её подключения (design D5): клиент матча
   * одноразовый, а оболочка живёт через возврат в матч, потому что за ней
   * закреплено то, что от возврата не меняется, — handshake главного потока
   * (SHELL-5), таблица видов и счётчик отправленных её записей (см.
   * `NetworkShell.reattach`). Заводится на первой попытке: до неё поднимать
   * оболочку не для кого.
   */
  let shell: NetworkShell | undefined;
  /**
   * Состояние сессии ДЕРЖАТЕЛЕМ, а не отдельными переменными: флаги ставит
   * `stop()` из чужого стека, и сужение типа по потоку управления решило бы,
   * что за `await` они так и остались прежними, — проверка после паузы стала бы
   * заведомо ложной (тот же приём, что у держателя подписки в тестах порта).
   *
   * `returning` — «возврат уже идёт»: второе закрытие канала не должно запускать
   * вторую гонку попыток.
   */
  const flow = { stopped: false, reconnecting: false, returning: false };

  /**
   * Одна попытка входа: свой транспорт и свой клиент. Первая поднимает
   * оболочку, следующие — реаттач в неё же (NTR-17): мир матча, `Extractor` и
   * канал к главному потоку у сессии одни.
   */
  async function begin(): Promise<Attempt | { readonly failure: string }> {
    let transport: Transport;
    try {
      transport = await options.connect(playerId);
    } catch (error) {
      return { failure: `не удалось соединиться: ${String(error)}` };
    }
    const client = attemptClient(playerId);
    const watched = watchedTransport(transport, onClosed);
    if (shell === undefined) {
      shell = new NetworkShell({
        mode: 'network',
        port: buffered.port,
        client,
        transport: watched,
        state,
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
    } else {
      shell.reattach(client, watched);
    }
    const outcome = await waitOutcome(client, settle, clock, options.timeoutMs ?? JOIN_TIMEOUT_MS);
    return { client, transport, outcome };
  }

  function release(attempt: Attempt, reason: string): void {
    shell?.stop();
    if (!attempt.transport.isClosed) attempt.transport.close(reason);
  }

  function onClosed(): void {
    if (flow.stopped || flow.returning || current === undefined) return;
    if (!retryable(current.client)) {
      // Матч кончился либо отказ окончателен: возвращаться некуда (NTR-17).
      notify(`матч закончился: ${current.client.closeDetail}`);
      return;
    }
    flow.returning = true;
    flow.reconnecting = true;
    notify(RECONNECTING_NOTICE);
    void reconnect();
  }

  /**
   * Возврат в матч: попытки с растущей паузой, пока сервер доступен и окно
   * возврата не закрылось порогом молчания (NTR-6). Каждая попытка — новый
   * клиент в той же оболочке (design D5, `NetworkShell.reattach`).
   */
  async function reconnect(): Promise<void> {
    for (const delay of delays) {
      await sleep(delay);
      if (flow.stopped) return;
      const attempt = await begin();
      if ('failure' in attempt) continue;
      if (attempt.outcome === 'accepted') {
        current = attempt;
        flow.reconnecting = false;
        flow.returning = false;
        // Пустое уведомление гасит показанное: игрок снова в бою.
        notify(NOTICE_CLEARED);
        return;
      }
      release(attempt, 'вернуться не удалось — пробую снова');
      // Окончательный отказ повтором не лечится: матча нет либо слот отдан
      // навсегда — и об этом честнее сказать, чем молча повторять.
      if (attempt.outcome !== 'timeout' && !retryable(attempt.client)) {
        flow.reconnecting = false;
        notify(`вернуться в матч не удалось: ${attempt.client.closeDetail}`);
        return;
      }
    }
    flow.reconnecting = false;
    notify('вернуться в матч не удалось: сервер недоступен');
  }

  return {
    begin,
    release,
    /** Принятая попытка становится сессией: её оболочка живёт до `stop()`. */
    joined(accepted: Attempt): DemoJoined {
      current = accepted;
      const hero = heroOfSlot(state, accepted.client.slot!);
      buffered.commit({ hero, playerId, slot: accepted.client.slot });
      return {
        ok: true,
        playerId,
        state,
        hero,
        get shell() {
          return shell!;
        },
        get client() {
          return current!.client;
        },
        get reconnecting() {
          return flow.reconnecting;
        },
        stop() {
          flow.stopped = true;
          flow.reconnecting = false;
          if (current !== undefined) release(current, 'сессия закрыта');
        },
      };
    },
  };
}
