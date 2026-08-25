/**
 * Запертый слот на цельной вертикали (CLI-9): сервер матча, настоящие клиенты,
 * внутрипроцессный транспорт (NTR-2, NTR-12).
 *
 * Предмет проверки — сценарий NTR-19 «Запертый слот и канонический лог»: запись
 * матча, в котором слот запирали и запирание снимали, реплеится ПОБИТОВО. В
 * логе нет ни запирания, ни отказов входа — только кадры слотов, включая
 * predicted времени отсутствия владельца (NTR-7), — и прогон этой записи ядром
 * даёт то же состояние (NTR-8).
 *
 * Бухгалтерия допуска (отличимость исхода, неприкосновенность заместителя)
 * проверяется unit-тестами `net-ts`, где ей и место; здесь — шов.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain, type InputFrame } from '@fluxus/core';
import type { InputSource } from '@fluxus/net';
import {
  STEP,
  TICK_RATE,
  connectClient,
  duelConfig,
  harness,
  settle,
  type ConnectedClient,
  type Harness,
} from './fixtures.js';

/** Порог молчания с запасом: окно возврата тест закрывает сам, а не временем. */
const SILENCE_TICKS = 1000;

const walk: InputSource = () => ({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 });
const stand: InputSource = () => ({ move: { x: 0, y: STEP }, aimDir: 0, buttons: 0 });

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

function framesOf(frames: readonly InputFrame[], playerId: string): readonly InputFrame[] {
  return frames.filter((frame) => frame.playerId === playerId);
}

describe('матч с запиранием слота и снятием запрета (NTR-19)', () => {
  it('запись не знает о запирании и реплеится побитово (NTR-8)', async () => {
    const fixture: Harness = harness(duelConfig({ silenceTicks: SILENCE_TICKS }));
    const clock = fixture.clock;
    const owner = connectClient(fixture.hub, 'p1', clock, fixture.config.scene, walk);
    const rival = connectClient(fixture.hub, 'p2', clock, fixture.config.scene, stand);
    await settle();
    expect(fixture.server.phase).toBe('running');

    await play(fixture, 8, [owner, rival]);

    // Админ запирает слот: соединение владельца рвётся именованным исходом.
    fixture.server.bar(0);
    // Исход уезжает рассылкой хоста, как всякое исходящее сервера (NTR-3): в
    // живом стенде это делает ближайший шаг расписания, здесь — явный `flush`.
    fixture.host.flush();
    await settle();
    expect(owner.client.phase).toBe('closed');
    expect(owner.client.closeDetail).toContain('slot-barred');
    expect(fixture.server.slotAttached(0)).toBe(false);

    // Матч продолжается — слот идёт на predicted-кадрах (NTR-7), порог молчания
    // запиранием не отключён (NTR-6).
    await play(fixture, 6, [rival]);
    expect(fixture.server.phase).toBe('running');
    expect(fixture.server.metrics.slots[0]!.predicted).toBeGreaterThan(0);

    // Пока заперт — владелец не входит, и ему называется ЗАПРЕТ, а не занятость.
    const refused = connectClient(fixture.hub, 'p1', clock, fixture.config.scene, walk);
    await settle();
    expect(refused.client.phase).toBe('closed');
    expect(refused.client.closeDetail).toContain('slot-barred');

    // Запрет снят — владелец возвращается штатным реконнектом (NTR-17).
    fixture.server.unbar(0);
    const back = connectClient(fixture.hub, 'p1', clock, fixture.config.scene, walk);
    await settle();
    expect(back.client.slot).toBe(0);
    expect(back.client.phase).toBe('playing');
    await play(fixture, 8, [rival, back]);

    const server = fixture.server;
    expect(server.phase).toBe('running');
    // Ветвь истории не менялась: перемотки не было (NTR-16).
    expect(server.epoch).toBe(0);

    // Ростер не двигался: те же два слота и по кадру на слот на тик.
    const canonical = [...server.canonicalInputs];
    expect(new Set(canonical.map((frame) => frame.playerId))).toEqual(new Set(['p1', 'p2']));
    expect(canonical).toHaveLength(server.tick * 2);
    expect(framesOf(canonical, 'p1').map((frame) => frame.tick)).toEqual(
      Array.from({ length: server.tick }, (_, index) => index + 1),
    );

    // И главное (NTR-19, сценарий «Запертый слот и канонический лог»): прогон
    // записи ядром даёт побитово то же состояние — ни запирания, ни отказов
    // входа в ней нет, и воспроизводится она без знания о них.
    const replay = runScenario(server.toScenario());
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
  });
});
