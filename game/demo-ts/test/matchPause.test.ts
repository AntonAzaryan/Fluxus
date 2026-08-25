/**
 * Пауза матча на демо-арене (`netcode-transport` NTR-20): два игрока стенда
 * ставят и снимают её ПО ДОКУМЕНТУ МАТЧА — по тем самым числам, которыми играет
 * `content/matches/duel.match.json`.
 *
 * Проверяется здесь не механизм (он проверен в `engine/net-ts`), а то, что
 * политика доезжает до сервера данными и работает целиком: секция, потерянная в
 * раскладке документа, отняла бы у игроков паузу МОЛЧА — ровно так когда-то
 * была потеряна `rewind` и вместе с ней ульта отката на выделенном стенде.
 *
 * Числа из документа читаются, а не переписываются: они — политика демо и
 * тюнятся при игровой проверке (design D3, Open Questions change'а). Тест
 * обязан пережить их правку и упасть только на потерянном поведении.
 */
import { describe, expect, it } from 'vitest';
import {
  MatchServer,
  type ClientMessage,
  type GameVersion,
  type MatchConfig,
  type Outgoing,
  type PauseMessage,
} from '@fluxus/net';
import { DEMO_MATCH, DEMO_TICK_RATE, demoMatchConfig } from '../app/match.js';

/**
 * Политика паузы демо-арены — из документа матча. Её отсутствие и есть дефект:
 * без секции игроки паузы не получают вовсе (NTR-20, механизм против политики).
 */
const POLICY = DEMO_MATCH.pause;

/** Длительность документа → шаги расписания: живых тиков в заморозке нет (D2). */
function steps(ms: number): number {
  return Math.ceil((ms * DEMO_TICK_RATE) / 1000);
}

function hello(playerId: string, version: GameVersion): ClientMessage {
  return { type: 'Hello', playerId, version, role: 'owner', observer: false };
}

function pauseRequest(action: 'pause' | 'resume'): ClientMessage {
  return { type: 'PauseRequest', action };
}

/** Матч демо-арены с обоими занятыми слотами: соединение 1 — p1, 2 — p2. */
function stand(): { server: MatchServer; config: MatchConfig } {
  // Порог молчания заведомо длиннее прогона: предмет здесь пауза, а слот, за
  // который никто не говорит, завершил бы матч сам (NTR-6).
  const config: MatchConfig = { ...demoMatchConfig(), silenceTicks: 1_000_000 };
  const server = new MatchServer(config);
  server.connect(1);
  server.receive(1, hello(config.players[0]!, config.version));
  server.connect(2);
  server.receive(2, hello(config.players[1]!, config.version));
  server.drain();
  return { server, config };
}

function advance(server: MatchServer, count: number): void {
  for (let i = 0; i < count; i++) server.advance();
}

function pausesTo(outgoing: readonly Outgoing[], to: number): PauseMessage[] {
  return outgoing
    .filter((entry) => entry.to === to)
    .map((entry) => entry.message)
    .filter((message): message is PauseMessage => message.type === 'Pause');
}

/** Снятие своей паузы инициатором и доведение объявленного отсчёта до конца. */
function unpause(server: MatchServer, connection: number): void {
  server.receive(connection, pauseRequest('resume'));
  advance(server, steps(POLICY?.resumeCountdownMs ?? 0) + 1);
}

describe('два игрока на стенде ставят и снимают паузу (NTR-20)', () => {
  it('документ демо-арены объявляет политику паузы: без неё паузы нет вовсе', () => {
    // Сама секция и есть предмет: сервер балансных констант паузы не содержит,
    // и «поле потерялось в раскладке» снаружи выглядит как «кнопка не работает».
    expect(POLICY).toBeDefined();
    expect(POLICY!.budgetPerPlayer).toBeGreaterThan(0);
    expect(POLICY!.resumeCountdownMs).toBeGreaterThan(0);
  });

  it('первый игрок замораживает матч, и объявление уезжает обоим', () => {
    const s = stand();
    advance(s.server, 20);
    const frozenTick = s.server.tick;
    expect(frozenTick).toBeGreaterThan(0);

    s.server.receive(1, pauseRequest('pause'));
    const out = s.server.drain();
    expect(s.server.pauseState).toBe('frozen');
    // Инициатор назван слотом, а не выдуман: оверлей паузы покажет его имя (HUD-9).
    expect(s.server.pauseInitiator).toBe(0);
    const announced = { type: 'Pause', state: 'frozen', slot: 0, countdownMs: 0 };
    expect(pausesTo(out, 1)).toEqual([announced]);
    expect(pausesTo(out, 2)).toEqual([announced]);

    // Живых тиков в заморозке нет — мир стоит там, где его застали.
    advance(s.server, 60);
    expect(s.server.tick).toBe(frozenTick);
    expect(s.server.epoch).toBe(0);
  });

  it('противник снимает чужую паузу не раньше срока политики, инициатор — сразу', () => {
    const s = stand();
    advance(s.server, 10);
    const frozenTick = s.server.tick;
    s.server.receive(1, pauseRequest('pause'));
    s.server.drain();

    const opponentWait = POLICY?.opponentUnpauseAfterMs ?? 0;
    if (opponentWait > 0) {
      s.server.receive(2, pauseRequest('resume'));
      // Отказ АДРЕСНЫЙ и с названной причиной: соединение живо, матч не тронут.
      expect(pausesTo(s.server.drain(), 2)[0]).toMatchObject({
        state: 'frozen',
        denied: 'too-early',
      });
      expect(s.server.pauseState).toBe('frozen');
    }

    // Свою инициатор снимает когда угодно — срок противника его не держит.
    s.server.receive(1, pauseRequest('resume'));
    expect(s.server.pauseState).toBe('resuming');
    expect(pausesTo(s.server.drain(), 2)[0]).toMatchObject({
      state: 'resuming',
      countdownMs: POLICY!.resumeCountdownMs,
    });

    // По истечении объявленного отсчёта матч продолжается С ТОГО ЖЕ тика.
    advance(s.server, steps(POLICY!.resumeCountdownMs!));
    expect(s.server.mode).toBe('Running');
    expect(s.server.tick).toBe(frozenTick);
    advance(s.server, 5);
    expect(s.server.tick).toBe(frozenTick + 5);
  });

  it('бюджет документа конечен: сверх него — именованный отказ, а не разрыв', () => {
    const s = stand();
    advance(s.server, 5);
    const budget = POLICY!.budgetPerPlayer!;
    for (let i = 0; i < budget; i++) {
      s.server.receive(1, pauseRequest('pause'));
      expect(s.server.pauseState).toBe('frozen');
      unpause(s.server, 1);
      expect(s.server.pauseState).toBe('running');
    }

    s.server.drain();
    s.server.receive(1, pauseRequest('pause'));
    const out = s.server.drain();
    expect(pausesTo(out, 1)[0]).toMatchObject({ state: 'running', denied: 'budget-spent' });
    // Соседу о чужом нажатии не сообщают, соединение живо, матч идёт.
    expect(pausesTo(out, 2)).toEqual([]);
    expect(out.some((entry) => entry.message.type === 'Reject')).toBe(false);
    expect(s.server.mode).toBe('Running');

    // Бюджет — на СЛОТ, а не на матч: у второго игрока он свой.
    s.server.receive(2, pauseRequest('pause'));
    expect(s.server.pauseState).toBe('frozen');
    expect(s.server.pauseInitiator).toBe(1);
  });
});
