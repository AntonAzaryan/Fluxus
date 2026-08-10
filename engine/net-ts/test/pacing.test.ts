/**
 * Темп и буфер задержки ввода (NTR-7, TICK-2).
 *
 * Все проверки идут по `MatchServer` напрямую — без сокетов, без таймеров и без
 * ожидания реального времени. Это и есть польза от NTR-3: матч тестируется как
 * функция, а не как процесс.
 */
import { describe, expect, it } from 'vitest';
import { duelConfig, harness, hello, inputMessage, wireInput, STEP } from './fixtures.js';

function running(configOverrides = {}) {
  const config = duelConfig(configOverrides);
  const fixture = harness(config);
  fixture.server.connect(1);
  fixture.server.receive(1, hello('p1', config.version));
  fixture.server.connect(2);
  fixture.server.receive(2, hello('p2', config.version));
  fixture.server.drain();
  return fixture;
}

describe('расписание', () => {
  it('до заполнения слотов мир стоит на worldInit (NTR-6)', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));

    server.advance();
    server.advance();
    expect(server.phase).toBe('lobby');
    expect(server.tick).toBe(0);
    expect(server.canonicalInputs).toHaveLength(0);
  });

  it('матч стартует, когда занят последний слот', () => {
    const { server } = running();
    expect(server.phase).toBe('running');
    expect(server.tick).toBe(0);
  });

  it('комплект фреймов раньше срока не двигает тик досрочно (TICK-2)', () => {
    const { server } = running();
    server.receive(1, inputMessage(wireInput(1, 1, STEP)));
    server.receive(2, inputMessage(wireInput(1, 1, STEP)));

    // Фреймы обоих игроков на тик 1 уже у сервера, но момент тика не наступил:
    // темп задаёт расписание, а не поток ввода.
    expect(server.tick).toBe(0);
    server.advance();
    expect(server.tick).toBe(1);
  });
});

describe('судьба кадра', () => {
  it('кадр применяется на своём тике', () => {
    const { server } = running();
    server.receive(1, inputMessage(wireInput(1, 7, STEP)));
    server.advance();

    expect(server.metrics.slots[0]!.applied).toBe(1);
    expect(server.canonicalInputs[0]).toMatchObject({ playerId: 'p1', seq: 7, tick: 1 });
  });

  it('отсутствующий кадр заменяется повтором последнего и попадает в канонический лог', () => {
    const { server } = running();
    server.receive(1, inputMessage(wireInput(1, 1, STEP)));
    server.advance();
    server.advance();

    const counters = server.metrics.slots[0]!;
    expect(counters.applied).toBe(1);
    expect(counters.predicted).toBe(1);
    // Повтор — тот же ввод с новым тиком (TICK-2).
    const second = server.canonicalInputs.filter((frame) => frame.playerId === 'p1')[1]!;
    expect(second.tick).toBe(2);
    expect(second.move.x).toBe(STEP);
  });

  it('до первого кадра предсказывается нулевой ввод, а не пропуск слота', () => {
    const { server } = running();
    server.advance();

    const frames = server.canonicalInputs;
    // Оба слота присутствуют на каждом тике, иначе запись перестала бы быть
    // воспроизводимой (NTR-8).
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.playerId).sort()).toEqual(['p1', 'p2']);
    expect(frames.every((frame) => frame.move.x === 0 && frame.buttons === 0)).toBe(true);
  });

  it('опоздавший кадр отбрасывается и виден в счётчике', () => {
    const { server } = running();
    server.advance();
    server.advance();
    expect(server.tick).toBe(2);

    server.receive(1, inputMessage(wireInput(2, 5, STEP)));
    expect(server.metrics.slots[0]!.late).toBe(1);
    // Ровно один класс, а не оба сразу: «ввод теряется» и «ввод ощущается вяло»
    // суть разные дефекты с разными починками (NTR-11).
    expect(server.metrics.slots[0]!.outOfWindow).toBe(0);

    // Мир назад не переигрывается (NET-1): состояние тика 2 уже посчитано.
    server.advance();
    const applied = server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(applied.every((frame) => frame.seq !== 5)).toBe(true);
  });

  it('кадр за пределами окна отличается от опоздавшего', () => {
    const { server } = running();
    server.receive(1, inputMessage(wireInput(100_000, 1, STEP)));

    const counters = server.metrics.slots[0]!;
    expect(counters.outOfWindow).toBe(1);
    expect(counters.late).toBe(0);
  });

  it('граница окна проходит ровно по currentTick + inputWindow (NTR-7)', () => {
    const { server } = running({ inputWindow: 5 });
    server.advance();
    expect(server.tick).toBe(1);
    const counters = server.metrics.slots[0]!;

    // Обе стороны одного сравнения: на тик за границей — отброс, ровно на
    // границе — приём. Сдвиг сравнения на единицу в любую сторону краснит тест.
    server.receive(1, inputMessage(wireInput(1 + 5 + 1, 71, STEP)));
    expect(counters.outOfWindow).toBe(1);
    server.receive(1, inputMessage(wireInput(1 + 5, 70, STEP)));
    expect(counters.outOfWindow).toBe(1);

    // Принятый кадр дождался своего тика и применился — то есть он лёг в буфер
    // неприменённого ввода, а не был сочтён принятым и потерян.
    for (let tick = 2; tick <= 6; tick++) server.advance();
    expect(counters.applied).toBe(1);
    const own = server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(own.find((frame) => frame.tick === 6)).toMatchObject({ seq: 70 });
    expect(own.some((frame) => frame.seq === 71)).toBe(false);
  });

  it('повтор кадра на ту же пару (слот, тик) гасится молча, и выигрывает первый (NTR-7)', () => {
    const { server } = running();
    // Избыточность штатна и на канале NTR-2 неизбежна: копия приходит и
    // отдельным сообщением (слот 0), и второй записью в одном (слот 1).
    server.receive(1, inputMessage(wireInput(1, 70, STEP)));
    server.receive(1, inputMessage(wireInput(1, 71, -STEP)));
    server.receive(2, inputMessage(wireInput(1, 80, STEP), wireInput(1, 81, -STEP)));
    server.advance();

    const atTick = server.canonicalInputs.filter((frame) => frame.tick === 1);
    expect(atTick).toHaveLength(2);
    // Применён первый принятый, а не последний: при «последний выигрывает»
    // значение слота оставалось бы открытым до дедлайна и зависело бы от
    // порядка обработки внутри сервера.
    expect(atTick.map((frame) => frame.seq).sort((a, b) => a - b)).toEqual([70, 80]);
    expect(atTick.every((frame) => frame.move.x === STEP)).toBe(true);

    // Молча и без счётчиков: избыточная отправка — штатный режим протокола
    // (NTR-4), и счёт её дефектом сделал бы метрики NTR-11 нечитаемыми ровно у
    // исправного клиента.
    for (const slot of [0, 1]) {
      const counters = server.metrics.slots[slot]!;
      expect(counters.applied).toBe(1);
      expect(counters.late).toBe(0);
      expect(counters.outOfWindow).toBe(0);
    }
  });
});

describe('молчание слота', () => {
  it('матч завершается по превышению порога, а не мгновенно (NTR-6)', () => {
    const { server } = running({ silenceTicks: 3 });
    server.drain();

    for (let i = 0; i < 3; i++) server.advance();
    expect(server.phase).toBe('running');

    server.advance();
    expect(server.phase).toBe('ended');
    const ends = server.drain().filter((entry) => entry.message.type === 'End');
    expect(ends).toHaveLength(2);
    expect(ends[0]!.message).toMatchObject({ reason: 'player-silent' });
  });

  it('пришедший кадр сбрасывает счётчик молчания', () => {
    const { server } = running({ silenceTicks: 3 });
    server.advance();
    server.advance();
    expect(server.metrics.slots[0]!.silentTicks).toBe(2);

    server.receive(1, inputMessage(wireInput(3, 1, STEP)));
    server.receive(2, inputMessage(wireInput(3, 1, STEP)));
    server.advance();
    expect(server.metrics.slots[0]!.silentTicks).toBe(0);
  });

  it('осознанный уход завершает матч сразу, не дожидаясь порога', () => {
    const { server } = running({ silenceTicks: 1000 });
    server.drain();
    server.receive(1, { type: 'Bye', reason: 'вышел' });

    expect(server.phase).toBe('ended');
    expect(server.drain()[0]!.message).toMatchObject({ type: 'End', reason: 'player-left' });
  });

  it('разрыв соединения матч не останавливает', () => {
    const { server } = running({ silenceTicks: 1000 });
    server.disconnect(1);
    server.advance();

    expect(server.phase).toBe('running');
    expect(server.metrics.slots[0]!.predicted).toBe(1);
  });

  it('вернуться в идущий матч нельзя, и это сказано явно', () => {
    const config = duelConfig({ silenceTicks: 1000 });
    const fixture = harness(config);
    const { server } = fixture;
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    server.drain();

    server.disconnect(1);
    server.connect(3);
    server.receive(3, hello('p1', config.version));
    expect(server.drain()[0]!.message).toMatchObject({ reason: 'match-in-progress' });
  });
});

describe('конфиг темпа', () => {
  it('некратная частота рассылки отвергается на сборке матча', () => {
    expect(() => harness(duelConfig({ tickRate: 60, snapshotRate: 45 }))).toThrow(/не делит/);
  });

  it('inputWindow меньше inputDelay отвергается на сборке матча (NTR-7)', () => {
    expect(() => harness(duelConfig({ inputDelay: 20, inputWindow: 15 }))).toThrow(/меньше inputDelay/);
  });

  it('глубина повтора событий — целое, не меньше нуля; ноль легален (NTR-15)', () => {
    expect(() => harness(duelConfig({ eventRepeat: -1 }))).toThrow(/eventRepeat/);
    expect(() => harness(duelConfig({ eventRepeat: 1.5 }))).toThrow(/eventRepeat/);
    // Ноль означает «без повтора», а не «параметр не задан».
    expect(harness(duelConfig({ eventRepeat: 0 })).server.pacing.eventRepeat).toBe(0);
    // Умолчание — две предыдущие рассылки.
    expect(harness(duelConfig()).server.pacing.eventRepeat).toBe(2);
  });

  it('число слотов — величина конфига, а не константа (NTR-6)', () => {
    const config = duelConfig({ players: ['p1', 'p2', 'p3', 'p4'] });
    const { server } = harness(config);
    for (let i = 0; i < 3; i++) {
      server.connect(i + 1);
      server.receive(i + 1, hello(config.players[i]!, config.version));
    }
    expect(server.phase).toBe('lobby');

    server.connect(4);
    server.receive(4, hello('p4', config.version));
    expect(server.phase).toBe('running');
  });
});
