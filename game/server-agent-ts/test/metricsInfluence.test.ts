/**
 * «Метрики без влияния на матч» (SRV-4, сценарий): «WHEN к серверу подписан и
 * отписан админ-клиент THEN ход матча, канонический лог и снапшоты игрокам не
 * отличаются от матча без подписчика».
 *
 * Матч здесь НАСТОЯЩИЙ и внутрипроцессный: тот же `MatchServer` и тот же
 * `MatchHost`, которые поднимает стенд, на лупбэке и с расписанным по тикам
 * вводом — то есть воспроизводимый до бита (NTR-8, NTR-12). Проверяется ровно
 * утверждение требования: один и тот же матч играется дважды, и во втором
 * прогоне посреди матча появляется читатель наблюдаемых, а потом исчезает.
 *
 * Читаются ИМЕННО те величины, которые SRV-4 объявляет доступными подписчику и
 * которые собирает control-адаптер стенда (`game/demo-ts/app/controlAdapter.ts`,
 * решение D2): перечень слотов с их арендами (NTR-17..NTR-19), счётчики слотов,
 * круг несущего канала и серверная половина отклика по каждому соединению
 * (NTR-11), отчёт хоста с длительностью тика p99 и broadcast lag, счётчики
 * матча. Ни одного захода в мир: «сбор и доставка этих величин MUST NOT влиять
 * на ход матча и SHALL оставаться во внешнем слое» (SRV-4, OBS-2).
 *
 * Граница проверки названа честно. Доставка подписки — агент, управляющий канал
 * и команда стенду — закреплена своим тестом (`protocol.test.ts`, «метрики
 * приезжают только подписчику деталей»); здесь закреплено ПОСЛЕДСТВИЕ подписки:
 * то, что подписчик заставляет читать. Прогнать это через настоящий стенд
 * нечем — канонический лог матча стенд кладёт рядом только в отладочном прогоне
 * (CLI-11), а отладочного флага в закрытом наборе параметров запуска нет
 * (SRV-2), и заводить его ради теста значило бы расширять протокол под тест.
 */
import { describe, expect, it } from 'vitest';
import {
  contentPack,
  toWireSnapshot,
  ClientHost,
  LoopbackHub,
  MatchClient,
  MatchHost,
  MatchServer,
  type InputSample,
  type MatchConfig,
  type Transport,
} from '@fluxus/net';

/** Единица Q16.16: ввод и позиции в симуляции — фиксированная точка (DET-2). */
const ONE = 1 << 16;

/** Шагов расписания в прогоне: хватает и на вход в матч, и на его середину. */
const STEPS = 40;
/** Подписка появляется В СЕРЕДИНЕ матча и в середине же исчезает. */
const SUBSCRIBE_AT = 10;
const UNSUBSCRIBE_AT = 30;

/**
 * Сцена прогона: движение по вводу и ничего сверх. Взята минимальной намеренно —
 * предмет проверки не бой, а то, что чтение наблюдаемых в него не вмешивается;
 * зато ввод обязан состояние ДВИГАТЬ, иначе сравнение сравнивало бы нули.
 */
function arenaScene(): MatchConfig['scene'] {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
        },
      },
    ],
    systems: [
      {
        name: 'Movement',
        order: 10,
        query: { all: ['Position', 'Input'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: {
                x: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveX'] },
                  ],
                },
                y: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'y'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveY'] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    capacity: 8,
  };
}

/**
 * Ввод, расписанный по номеру тика и слоту: матч воспроизводим до бита, и
 * различие двух прогонов может означать только вмешательство наблюдателя.
 */
function scripted(slot: number, tick: number): InputSample {
  const phase = (tick + slot * 7) % 4;
  return {
    move: {
      x: phase === 0 ? ONE : phase === 2 ? -ONE : 0,
      y: phase === 1 ? ONE : 0,
    },
    aimDir: 0,
    buttons: phase === 3 ? 1 : 0,
  };
}

/** Доставка в loopback асинхронная (NTR-2), поэтому шаг прогона кончается тут. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

/**
 * Канал игрока с записью ВСЕГО, что ему доехало. Снапшот игроку — сообщение на
 * проводе, и сравнивать его честнее всего байтами: так «снапшоты игрокам не
 * отличаются» проверяется тем же, что игрок и получил.
 */
function recording(inner: Transport, seen: string[]): Transport {
  return {
    send: (bytes) => { inner.send(bytes); },
    close: (reason) => { inner.close(reason); },
    get isClosed(): boolean {
      return inner.isClosed;
    },
    onMessage(handler) {
      inner.onMessage((bytes) => {
        seen.push(Buffer.from(bytes).toString('base64'));
        handler(bytes);
      });
    },
    onClose: (handler) => { inner.onClose(handler); },
  };
}

/** Что прогон предъявляет к сравнению: ход матча, лог и снапшоты игрокам. */
interface Played {
  /** Канонический лог матча документом сценария (NTR-8). */
  readonly log: string;
  /** Итоговое состояние мира — то, что доиграно этим логом. */
  readonly state: string;
  /** Всё, что доехало каждому игроку, байт в байт. */
  readonly wire: readonly string[][];
  /** Тик, на котором прогон кончился: матч обязан был ИДТИ. */
  readonly ticks: number;
  /** Что прочитал наблюдатель на каждом шаге; пусто — матч без подписчика. */
  readonly readings: readonly number[];
}

/**
 * Один прогон матча. `watched` — появляется ли посреди матча админ-подписчик,
 * читающий наблюдаемые сервера и хоста.
 */
async function play(watched: boolean): Promise<Played> {
  const scene = arenaScene();
  const pack = contentPack({ duel: scene });
  const version = { buildId: 'srv4-build', contentPackHash: pack.hash };
  const config: MatchConfig = {
    version,
    players: ['p1', 'p2'],
    seed: 4242,
    sceneRef: 'duel',
    scene,
    initial: [{ prefab: 'Hero' }, { prefab: 'Hero', overrides: { Player: { slot: 1 } } }],
    tickRate: 60,
    snapshotRate: 30,
    inputDelay: 2,
    // Возврата после разрыва в этом прогоне нет, а окно тишины по умолчанию
    // короче прогона: без запаса матч кончился бы сам, и сравнивать было бы
    // нечего.
    silenceTicks: 10_000,
  };

  const hub = new LoopbackHub();
  const server = new MatchServer(config);
  // Часы инъектируются: величины отчёта не должны зависеть от того, как быстро
  // машина прокрутила прогон (NTR-12).
  const time = { ms: 0 };
  const host = new MatchHost(server, hub, { now: () => time.ms });

  const wire: string[][] = [];
  const clients = config.players.map((playerId, slot) => {
    const seen: string[] = [];
    wire.push(seen);
    const client = new MatchClient({ playerId, version, content: pack });
    const clientHost = new ClientHost(client, recording(hub.connect(), seen), {
      now: () => time.ms,
      input: (tick) => scripted(slot, tick),
    });
    clientHost.start();
    return clientHost;
  });
  await settle();
  expect(server.phase).toBe('running');

  const readings: number[] = [];
  for (let step = 0; step < STEPS; step++) {
    time.ms += 1;
    for (const client of clients) client.step();
    await settle();
    host.step();
    await settle();
    // Подписка появляется ПОСРЕДИ матча и посреди же исчезает — ровно так, как
    // это описывает сценарий SRV-4: «подписан и отписан админ-клиент».
    if (watched && step >= SUBSCRIBE_AT && step < UNSUBSCRIBE_AT) {
      readings.push(observe(server, host));
    }
  }

  const played: Played = {
    log: JSON.stringify(server.toScenario()),
    state: JSON.stringify(toWireSnapshot(server.snapshot())),
    wire,
    ticks: server.tick,
    readings,
  };
  await host.stop();
  await hub.close();
  return played;
}

/**
 * Взгляд админ-подписчика (SRV-4): всё, что требование объявляет доступным, —
 * публикуемыми наблюдаемыми сервера и хоста, без единого захода в мир (OBS-2).
 *
 * Величины НАКАПЛИВАЮТСЯ и возвращаются, а не выбрасываются: наблюдатель,
 * чьи чтения оптимизатор вправе выбросить, ничего бы и не проверял.
 */
function observe(server: MatchServer, host: MatchHost): number {
  let touched = 0;
  const report = host.report();
  touched += report.tick.p99Ms + report.broadcast.p99Ms + report.connections.length;
  for (let slot = 0; slot < server.config.players.length; slot++) {
    const lease = server.slotLease(slot);
    const counters = server.metrics.slots[slot];
    touched += (lease.attached ? 1 : 0) + (lease.barred ? 1 : 0) + (counters?.applied ?? 0);
    const connection = lease.connection;
    if (connection === undefined) continue;
    const wire = host.connectionMetrics(connection);
    // Круг несущего канала и СЕРВЕРНАЯ половина отклика (NTR-11) — ровно то, чем
    // админ отличает проблему сети от проблемы сервера.
    touched += (wire?.snapshotBytes ?? 0) + (wire?.responseMs ?? 0) + (wire === undefined ? 0 : 1);
  }
  touched += server.metrics.snapshotsSent + server.metrics.bytesSent;
  touched += server.tick + (server.phase === 'running' ? 1 : 0) + (server.pauseState === 'running' ? 1 : 0);
  return touched;
}

describe('метрики без влияния на матч (SRV-4)', () => {
  it('матч с подписавшимся и отписавшимся админом идентичен матчу без него', async () => {
    const watched = await play(true);
    const alone = await play(false);

    // Подписчик действительно был и действительно читал НЕПУСТЫЕ величины:
    // сравнение двух матчей, в одном из которых наблюдатель ничего не увидел,
    // доказывало бы только то, что прогон детерминирован.
    expect(watched.readings).toHaveLength(UNSUBSCRIBE_AT - SUBSCRIBE_AT);
    expect(watched.readings.every((value) => value > 0)).toBe(true);
    expect(alone.readings).toEqual([]);

    // Матч ШЁЛ: два стоящих матча совпали бы и без всяких требований.
    expect(watched.ticks).toBeGreaterThan(STEPS / 2);
    expect(watched.ticks).toBe(alone.ticks);

    // «Ход матча и канонический лог не отличаются» — документ сценария (NTR-8)
    // байт в байт: те же вводы на тех же тиках и то же число исполненных тиков.
    expect(watched.log).toBe(alone.log);
    // Ход матча — это ещё и то, ЧЕМ он кончился: лог, доигранный до другого
    // состояния, означал бы наблюдателя, который в мир всё-таки написал.
    expect(watched.state).toBe(alone.state);
    // «Снапшоты игрокам не отличаются» — байты, доехавшие каждому игроку.
    expect(watched.wire).toEqual(alone.wire);
    // Матч был непустым: сравнение пустых списков не проверяет ничего.
    expect(watched.wire[0]?.length).toBeGreaterThan(STEPS / 2);
  });
});
