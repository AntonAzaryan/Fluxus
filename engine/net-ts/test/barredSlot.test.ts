/**
 * Запертый слот (NTR-19): обратимый административный запрет владельцу занимать
 * свой слот.
 *
 * Проверяется здесь бухгалтерия ДОПУСКА — по `MatchServer` напрямую, без
 * транспорта и таймеров (NTR-3, NTR-12), ровно как аренда слота в
 * `reconnect.test.ts`. Три утверждения требования и есть три предмета: отказ
 * владельцу отличим от «слот занят», заместитель запиранием не тронут, после
 * снятия владелец возвращается штатным реконнектом.
 *
 * Побитовая парность записи такого матча (NTR-8) проверяется на цельной
 * вертикали (`engine/integration-ts/test/barredSlot.test.ts`): предмет там —
 * канонический лог, а не допуск.
 */
import { describe, expect, it } from 'vitest';
import { duelConfig, harness, hello, inputMessage, wireInput } from './fixtures.js';
import type { MatchConfig, MatchServer, Outgoing } from '../src/server/matchServer.js';
import type { RejectMessage, ServerMessage } from '../src/protocol/messages.js';

/** Матч с обоими занятыми слотами: соединение 1 — p1, соединение 2 — p2. */
function running(overrides: Partial<MatchConfig> = {}) {
  const config = duelConfig({ silenceTicks: 1000, ...overrides });
  const fixture = harness(config);
  fixture.server.connect(1);
  fixture.server.receive(1, hello('p1', config.version));
  fixture.server.connect(2);
  fixture.server.receive(2, hello('p2', config.version));
  fixture.server.drain();
  return { ...fixture, config };
}

function messagesTo(outgoing: readonly Outgoing[], to: number): ServerMessage[] {
  return outgoing.filter((entry) => entry.to === to).map((entry) => entry.message);
}

function rejectsTo(outgoing: readonly Outgoing[], to: number): RejectMessage[] {
  return messagesTo(outgoing, to).filter(
    (message): message is RejectMessage => message.type === 'Reject',
  );
}

/** Вход соединения за игрока; возвращает адресованное именно ему. */
function join(
  server: MatchServer,
  config: MatchConfig,
  id: number,
  playerId: string,
  role: 'owner' | 'substitute' = 'owner',
): ServerMessage[] {
  server.connect(id);
  server.receive(id, hello(playerId, config.version, false, role));
  return messagesTo(server.drain(), id);
}

describe('запирание слота — операция серверного API (NTR-19)', () => {
  it('живое соединение владельца рвётся названным исходом запрета', () => {
    const { server, config } = running();
    expect(server.slotAttached(0)).toBe(true);

    server.bar(0);
    const rejects = rejectsTo(server.drain(), 1);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.reason).toBe('slot-barred');
    // Слот остался за игроком ростера (NTR-6), но живого арендатора у него нет.
    expect(server.slotAttached(0)).toBe(false);
    expect(server.slotBarredAt(0)).toBe(true);
    expect(server.phase).toBe('running');
    // Аренда кончилась ИМЕННО запиранием — это и увидит обвязка статусом
    // `removed` (`server-control` SRV-4).
    expect(server.slotLease(0).lastEnd).toBe('barred');
    expect(config.players[0]).toBe('p1');
  });

  it('отказ владельцу отличим от «слот занят»', () => {
    const { server, config } = running();
    server.bar(0);
    server.drain();

    // Заперт: повторный `Hello` владельца получает ЗАПРЕТ.
    const barred = join(server, config, 3, 'p1');
    expect(barred.filter((m) => m.type === 'Reject')).toEqual([
      { type: 'Reject', reason: 'slot-barred', detail: 'слот 0 заперт администратором' },
    ]);

    // А занятый живым соединением слот соседа — по-прежнему «занят»: два разных
    // положения дел и два разных исхода, а не один на оба.
    const taken = join(server, config, 4, 'p2');
    expect(taken.find((m): m is RejectMessage => m.type === 'Reject')!.reason).toBe('slot-taken');
  });

  it('заместителя запирание не трогает: слот ведёт он, матч продолжается (NTR-18)', () => {
    const { server, config } = running();
    // Владелец ушёл сам, слот занял заместитель.
    server.disconnect(1);
    const seated = join(server, config, 3, 'p1', 'substitute');
    expect(seated.some((message) => message.type === 'Welcome')).toBe(true);
    expect(server.slotLease(0).role).toBe('substitute');

    server.bar(0);
    // Ни одного отказа заместителю: запрет адресован владельцу.
    expect(rejectsTo(server.drain(), 3)).toEqual([]);
    expect(server.slotAttached(0)).toBe(true);
    expect(server.slotBarredAt(0)).toBe(true);

    // И его ввод продолжает исполняться: слот ведёт заместитель.
    server.receive(3, inputMessage(wireInput(server.tick + 2, 1)));
    server.advance();
    server.advance();
    expect(server.metrics.slots[0]!.applied).toBeGreaterThan(0);
  });

  it('вход заместителя в ЗАПЕРТЫЙ слот без арендатора разрешён', () => {
    const { server, config } = running();
    server.bar(0);
    server.drain();
    expect(server.slotAttached(0)).toBe(false);

    const seated = join(server, config, 3, 'p1', 'substitute');
    expect(seated.some((message) => message.type === 'Welcome')).toBe(true);
    expect(server.slotAttached(0)).toBe(true);
  });

  it('после снятия владелец возвращается штатным реконнектом (NTR-17)', () => {
    const { server, config } = running();
    server.bar(0);
    server.drain();
    server.advance();

    server.unbar(0);
    expect(server.slotBarredAt(0)).toBe(false);
    const back = join(server, config, 3, 'p1');
    // Ровно тот же путь входа, что у всякого реконнекта (NTR-17), включая
    // состояние паузы вернувшемуся (NTR-20): своего пути у возврата из-под
    // запрета нет — «после снятия владелец возвращается штатным реконнектом».
    expect(back.map((message) => message.type)).toEqual(['Welcome', 'Start', 'Pause']);
    expect(server.slotAttached(0)).toBe(true);
    expect(server.slotLease(0).role).toBe('owner');
  });

  it('запирание не двигает ни ростер, ни эпоху, ни канонический лог (NTR-8, NTR-16)', () => {
    const { server } = running();
    server.advance();
    server.advance();
    const before = server.canonicalInputs.length;
    const epoch = server.epoch;

    server.bar(0);
    server.unbar(0);
    server.drain();

    expect(server.canonicalInputs).toHaveLength(before);
    expect(server.epoch).toBe(epoch);
    // Слот по-прежнему занят игроком ростера: запирание меняет допуск, а не состав.
    expect(server.slotLease(0).claimed).toBe(true);
    // И следующий тик по-прежнему кладёт по кадру на каждый слот (NTR-7).
    server.advance();
    expect(server.canonicalInputs).toHaveLength(before + 2);
  });

  it('повторное запирание ничего не меняет, а слот вне ростера — отказ', () => {
    const { server } = running();
    server.bar(0);
    server.drain();
    server.bar(0);
    expect(server.drain()).toEqual([]);

    expect(() => { server.bar(7); }).toThrow('вне ростера');
    expect(() => { server.unbar(-1); }).toThrow('вне ростера');
  });

  it('исход аренды называет, чем она кончилась: ушёл сам, оборвалось, вытеснен (SRV-4)', () => {
    const { server, config } = running();
    // Осознанный уход отличим от разрыва: разные слова для админа.
    server.receive(2, { type: 'Bye', reason: 'вышел' });
    expect(server.slotLease(1).lastEnd).toBe('bye');

    server.disconnect(1);
    expect(server.slotLease(0).lastEnd).toBe('closed');

    join(server, config, 3, 'p1', 'substitute');
    join(server, config, 4, 'p1');
    expect(server.slotLease(0).lastEnd).toBe('displaced');
    expect(server.slotLease(0).role).toBe('owner');
  });
});
