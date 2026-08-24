/**
 * Разрыв, замещение и возврат владельца на цельной вертикали (CLI-9): сервер
 * матча, настоящие клиенты, внутрипроцессный транспорт (NTR-2, NTR-12).
 *
 * Предмет проверки — ШОВ, а не бухгалтерия аренды слота (её держат unit-тесты
 * `net-ts`): матч, переживший разрыв, замещающее соединение и возврат владельца,
 * обязан остаться ЗАПИСЬЮ САМОГО СЕБЯ. Канонический лог (NTR-8) не знает ни о
 * разрыве, ни о смене арендатора — в нём только кадры слотов, включая predicted
 * времени отсутствия (NTR-7), — и прогон этой записи ядром даёт побитово то же
 * состояние (NTR-17, сценарий «Запись матча с разрывом и возвратом»).
 *
 * Заместитель здесь — обычный `MatchClient` с ролью заместителя (NTR-18), а не
 * бот-хост: сервер ботов от людей не отличает (`bot-player` BOT-1), и на этом
 * шве бот неотличим от человека по построению. Сборка бота-заместителя (BOT-14)
 * проверяется своим тестом в `engine/bot-ts`, где ей и место.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain, type InputFrame } from '@fluxus/core';
import {
  contentPack,
  ClientHost,
  MatchClient,
  type InputSource,
  type Transport,
} from '@fluxus/net';
import {
  BUILD_ID,
  STEP,
  TICK_RATE,
  connectClient,
  duelConfig,
  harness,
  settle,
  type ClientLink,
  type ConnectedClient,
  type Harness,
} from './fixtures.js';

/** Порог молчания с запасом: окно возврата тест закрывает сам, а не временем. */
const SILENCE_TICKS = 1000;

/** Ровный ввод: движение вправо — его видно и в логе, и в снапшоте. */
const walk: InputSource = () => ({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 });
const stand: InputSource = () => ({ move: { x: 0, y: STEP }, aimDir: 0, buttons: 0 });

/**
 * Слушающая сторона с перехваченным каналом: тесту нужно РВАТЬ канал, а
 * фикстурный `connectClient` транспорт наружу не отдаёт. Шов для этого уже
 * есть — `ClientLink` (NTR-2): «канал теряет и переставляет сообщения» —
 * свойство реализации транспорта, и подменяется она, а не сервер с клиентом.
 */
function tapped(hub: ClientLink): { readonly link: ClientLink; readonly last: () => Transport } {
  let last: Transport | undefined;
  return {
    link: {
      connect: () => {
        last = hub.connect();
        return last;
      },
    },
    last: () => {
      if (last === undefined) throw new Error('канал ещё не открыт');
      return last;
    },
  };
}

/**
 * Вход в матч с НАЗВАННОЙ ролью соединения (NTR-18). Отдельно от фикстурного
 * `connectClient`, потому что заместитель — единственный участник вертикали,
 * которому роль нужна не по умолчанию.
 */
function connectAs(
  fixture: Harness,
  playerId: string,
  role: 'owner' | 'substitute',
  input: InputSource,
): ConnectedClient {
  const pack = contentPack({ duel: fixture.config.scene });
  const client = new MatchClient({
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    role,
    ...(fixture.config.physics !== undefined ? { physics: fixture.config.physics } : {}),
    ...(fixture.config.visibility !== undefined ? { visibility: fixture.config.visibility } : {}),
  });
  const host = new ClientHost(client, fixture.hub.connect(), {
    now: () => fixture.clock.ms,
    input,
  });
  host.start();
  return { client, host };
}

async function play(
  fixture: Harness,
  ticks: number,
  clients: readonly ConnectedClient[],
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / TICK_RATE;
    for (const client of clients) if (client.client.phase !== 'closed') client.host.step();
    await settle();
    fixture.host.step();
    await settle();
  }
}

/** Кадры одного слота в порядке тиков — по ним видно и разрыв, и возврат. */
function framesOf(frames: readonly InputFrame[], playerId: string): readonly InputFrame[] {
  return frames.filter((frame) => frame.playerId === playerId);
}

describe('матч переживает разрыв, замещение и возврат владельца (NTR-17, NTR-18)', () => {
  it('запись матча не знает ни о разрыве, ни о смене арендатора, и реплеится побитово', async () => {
    const fixture: Harness = harness(duelConfig({ silenceTicks: SILENCE_TICKS }));
    const clock = fixture.clock;
    const ownerLink = tapped(fixture.hub);
    const owner = connectClient(ownerLink.link, 'p1', clock, fixture.config.scene, walk);
    const rival = connectClient(fixture.hub, 'p2', clock, fixture.config.scene, stand);
    await settle();
    expect(fixture.server.phase).toBe('running');

    // Матч идёт обоими людьми.
    await play(fixture, 8, [owner, rival]);
    expect(fixture.server.tick).toBe(8);

    // Разрыв: слот остаётся за игроком и идёт на predicted-кадрах (NTR-6).
    ownerLink.last().close('обрыв сети');
    await settle();
    expect(owner.client.closeReason).toBe('disconnected');
    expect(fixture.server.slotAttached(0)).toBe(false);
    await play(fixture, 6, [rival]);
    expect(fixture.server.phase).toBe('running');
    expect(fixture.server.metrics.slots[0]!.predicted).toBeGreaterThan(0);

    // Заместитель садится в слот без живого соединения (NTR-18) и ведёт его.
    const substitute = connectAs(fixture, 'p1', 'substitute', stand);
    await settle();
    expect(substitute.client.slot).toBe(0);
    expect(fixture.server.slotAttached(0)).toBe(true);
    await play(fixture, 8, [rival, substitute]);

    // Владелец возвращается реконнектом — заместитель вытеснен (NTR-18).
    const back = connectClient(fixture.hub, 'p1', clock, fixture.config.scene, walk);
    await settle();
    expect(back.client.slot).toBe(0);
    expect(back.client.phase).toBe('playing');
    expect(substitute.client.phase).toBe('closed');
    expect(substitute.client.closeDetail).toContain('displaced-by-owner');
    await play(fixture, 8, [rival, back]);

    const server = fixture.server;
    expect(server.phase).toBe('running');
    // Ветвь истории не менялась: перемотки не было, и эпоха не росла (NTR-16).
    expect(server.epoch).toBe(0);
    // Вернувшийся видит «сейчас» матча, а не досматривает пропущенное (NTR-17):
    // первый принятый диапазон событий разрывом не считается.
    expect(back.client.latest!.tick).toBe(server.tick);
    expect(back.client.metrics.eventRangeGaps).toBe(0);

    // Ростер не двигался: в логе те же два слота и по кадру на слот на тик.
    const canonical = [...server.canonicalInputs];
    expect(new Set(canonical.map((frame) => frame.playerId))).toEqual(new Set(['p1', 'p2']));
    expect(canonical).toHaveLength(server.tick * 2);
    const own = framesOf(canonical, 'p1');
    expect(own.map((frame) => frame.tick)).toEqual(
      Array.from({ length: server.tick }, (_, index) => index + 1),
    );

    // И главное (NTR-8, NTR-17): прогон записи ядром даёт то же состояние
    // побитово. Ни разрыва, ни заместителя, ни возврата в записи нет — только
    // кадры слотов, и воспроизводится она без знания о них.
    const replay = runScenario(server.toScenario());
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
  });

  it('невернувшийся слот завершает матч порогом молчания, а не зависает (NTR-6)', async () => {
    const fixture: Harness = harness(duelConfig({ silenceTicks: 6 }));
    const clock = fixture.clock;
    const ownerLink = tapped(fixture.hub);
    const owner = connectClient(ownerLink.link, 'p1', clock, fixture.config.scene, walk);
    const rival = connectClient(fixture.hub, 'p2', clock, fixture.config.scene, stand);
    await settle();

    await play(fixture, 4, [owner, rival]);
    ownerLink.last().close('обрыв сети');
    await settle();
    await play(fixture, 10, [rival]);

    expect(fixture.server.phase).toBe('ended');
    // Матч кончился названным исходом, и клиент соперника об этом узнал.
    expect(rival.client.phase).toBe('closed');
    expect(rival.client.closeReason).toBe('ended');
    expect(rival.client.closeDetail).toBe('player-silent');
  });
});
