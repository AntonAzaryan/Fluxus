/**
 * Рандеву и инвайт (`net-session` SES-3, SES-5).
 *
 * Проверяется то, что рандеву обязано давать сборке матча: транспорт до хоста и
 * названный отказ там, где транспорта не будет. Ни один тест здесь не знает,
 * какие байты внутри инвайта, — это и есть его непрозрачность.
 */
import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite } from '../src/session/invite.js';
import { RendezvousError } from '../src/session/rendezvous.js';
import { InProcessRendezvous } from '../src/session/rendezvous/inProcess.js';
import { settle } from './fixtures.js';

function counterTokens(): () => string {
  let next = 0;
  return () => `token-${++next}`;
}

describe('инвайт', () => {
  it('переживает кодирование и разбор', () => {
    const invite = encodeInvite({ via: 'ws', channel: 'lobby', token: 'abc', url: 'ws://1.2.3.4:9/lobby' });
    expect(decodeInvite(invite)).toEqual({
      via: 'ws',
      channel: 'lobby',
      token: 'abc',
      url: 'ws://1.2.3.4:9/lobby',
    });
  });

  it('чужая строка отсеивается до разбора', () => {
    expect(() => decodeInvite('ws://1.2.3.4:9/lobby')).toThrow(RendezvousError);
  });

  it('инвайт без обязательного поля не разбирается', () => {
    const broken = encodeInvite({ via: 'ws', channel: 'lobby', token: 'abc' }).replace('fluxus1.', 'fluxus1.x');
    expect(() => decodeInvite(broken)).toThrow(RendezvousError);
  });
});

describe('внутрипроцессное рандеву', () => {
  it('publish и resolve дают связанные концы одного канала', async () => {
    const rendezvous = new InProcessRendezvous({ token: counterTokens() });
    const published = await rendezvous.publish('lobby');

    const accepted: Uint8Array[] = [];
    published.transports.onConnection((transport) => {
      transport.onMessage((bytes) => accepted.push(bytes));
    });

    const client = await rendezvous.resolve(published.invite);
    client.send(Uint8Array.of(1, 2, 3));
    await settle();

    expect(accepted).toHaveLength(1);
    expect(Array.from(accepted[0]!)).toEqual([1, 2, 3]);
  });

  it('доставка асинхронная и после resolve тоже (NTR-2)', async () => {
    const rendezvous = new InProcessRendezvous({ token: counterTokens() });
    const published = await rendezvous.publish('match');
    let delivered = false;
    published.transports.onConnection((transport) => {
      transport.onMessage(() => {
        delivered = true;
      });
    });

    const client = await rendezvous.resolve(published.invite);
    client.send(Uint8Array.of(7));
    // Синхронная доставка дала бы тест, зелёный на порядке вызовов, которого в
    // сети не существует, — поэтому проверяется именно «ещё не доставлено».
    expect(delivered).toBe(false);
    await settle();
    expect(delivered).toBe(true);
  });

  it('неизвестный инвайт отвергается названным отказом', async () => {
    const rendezvous = new InProcessRendezvous({ token: counterTokens() });
    const foreign = encodeInvite({ via: 'in-process', channel: 'lobby', token: 'нет такого' });
    await expect(rendezvous.resolve(foreign)).rejects.toThrow(RendezvousError);
  });

  it('инвайт чужой реализации отвергается, а не резолвится молча', async () => {
    const rendezvous = new InProcessRendezvous({ token: counterTokens() });
    const foreign = encodeInvite({ via: 'ws', channel: 'lobby', token: 'token-1', url: 'ws://x/lobby' });
    await expect(rendezvous.resolve(foreign)).rejects.toThrow(RendezvousError);
  });

  it('после закрытия сессии инвайт не действует', async () => {
    const rendezvous = new InProcessRendezvous({ token: counterTokens() });
    const published = await rendezvous.publish('lobby');
    await published.close();
    await expect(rendezvous.resolve(published.invite)).rejects.toThrow(RendezvousError);
  });

  it('два матча в одном процессе не связаны общим реестром', async () => {
    const first = new InProcessRendezvous({ token: counterTokens() });
    const second = new InProcessRendezvous({ token: counterTokens() });
    const published = await first.publish('lobby');
    // Токены совпадают — реестры разные, и второй матч чужой инвайт не знает.
    await expect(second.resolve(published.invite)).rejects.toThrow(RendezvousError);
  });
});
