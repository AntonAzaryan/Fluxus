/**
 * Политика стенда «разрыв замораживает матч» (`netcode-transport` NTR-20,
 * решение D6) против НАСТОЯЩЕГО сервера матча: отвязка владельца ставит паузу
 * серверным API, возврат реконнектом (NTR-17) её снимает.
 *
 * Сервер здесь тот же, что играет по сети, и подменён только транспорт — его
 * нет вовсе: соединения заводятся вызовами (`connect`/`receive`/`disconnect`),
 * как во всей сетевой суите (NTR-3, NTR-12). Предмет проверки — политика
 * сборки, а не доставка.
 */
import { describe, expect, it } from 'vitest';
import {
  MatchServer,
  type GameVersion,
  type MatchConfig,
  type ClientMessage,
} from '@fluxus/net';
import { DetachPause } from '../app/detachPause.js';
import { DEMO_MATCH, DEMO_TICK_RATE, demoMatchConfig } from '../app/match.js';

/** Отсчёт возобновления демо в шагах расписания: 3 с при 60 Гц. */
const RESUME_STEPS = 180;

function hello(playerId: string, version: GameVersion): ClientMessage {
  return { type: 'Hello', playerId, version, role: 'owner', observer: false };
}

/**
 * Матч демо-арены с обоими занятыми слотами и наблюдателем политики над ним.
 * Конфиг — тот же документ, которым играет стенд: секция `pause` в нём и есть
 * политика, по которой матч возобновится (NTR-20).
 */
function stand(overrides: Partial<MatchConfig> = {}) {
  const config: MatchConfig = { ...demoMatchConfig(), silenceTicks: 100_000, ...overrides };
  const server = new MatchServer(config);
  server.connect(1);
  server.receive(1, hello(config.players[0]!, config.version));
  server.connect(2);
  server.receive(2, hello(config.players[1]!, config.version));
  server.drain();

  const report: string[] = [];
  const detach = new DetachPause({
    players: config.players,
    attached: (slot) => server.slotAttached(slot),
    running: () => server.phase === 'running',
    barred: (slot) => server.slotBarredAt(slot),
    state: () => server.pauseState,
    pause: () => server.pauseMatch(),
    resume: () => server.resumeMatch(),
    report: (message) => report.push(message),
  });
  return { config, server, detach, report };
}

function advance(server: MatchServer, steps: number): void {
  for (let i = 0; i < steps; i++) server.advance();
}

describe('разрыв замораживает матч, возврат владельца возобновляет (NTR-20, D6)', () => {
  it('отвязка владельца ставит паузу серверным API, возврат её снимает', () => {
    const s = stand();
    advance(s.server, 10);
    s.detach.poll();
    expect(s.server.pauseState).toBe('running');

    // Канал владельца закрылся: слот остаётся за игроком (NTR-6), но живого
    // соединения у него нет.
    s.server.disconnect(1);
    s.detach.poll();
    expect(s.server.pauseState).toBe('frozen');
    expect(s.detach.holding).toBe(true);
    // Инициатор — сервер: слота у обвязки нет и выдумывать его нельзя.
    expect(s.server.pauseInitiator).toBe(-1);

    // В заморозке живых тиков нет — матч стоит там, где его застали.
    const frozenTick = s.server.tick;
    advance(s.server, 50);
    expect(s.server.tick).toBe(frozenTick);

    // Владелец вернулся полным хендшейком (NTR-17) — политика снимает СВОЮ
    // паузу, и матч возобновляется по правилам документа матча.
    s.server.connect(3);
    s.server.receive(3, hello(s.config.players[0]!, s.config.version));
    s.detach.poll();
    expect(s.server.pauseState).toBe('resuming');
    expect(s.detach.holding).toBe(false);

    advance(s.server, RESUME_STEPS);
    expect(s.server.mode).toBe('Running');
    advance(s.server, 3);
    expect(s.server.tick).toBe(frozenTick + 3);
  });

  it('чужую паузу политика не снимает: игрок поставил — игрок и снимает', () => {
    const s = stand();
    advance(s.server, 5);
    // Паузу поставил игрок своим запросом (NTR-20), а не обвязка.
    s.server.receive(2, { type: 'PauseRequest', action: 'pause' });
    expect(s.server.pauseState).toBe('frozen');

    s.detach.poll();
    expect(s.detach.holding).toBe(false);
    // Все на связи — но заморозка чужая, и распоряжаться ею политике нечем.
    s.detach.poll();
    expect(s.server.pauseState).toBe('frozen');
    expect(s.server.pauseInitiator).toBe(1);
  });

  it('покинутый всеми матч не замораживается: иначе он не кончится никогда (NTR-6)', () => {
    const s = stand();
    const abandonedStand = new DetachPause({
      players: s.config.players,
      attached: (slot) => s.server.slotAttached(slot),
      running: () => s.server.phase === 'running',
      state: () => s.server.pauseState,
      pause: () => s.server.pauseMatch(),
      resume: () => s.server.resumeMatch(),
      abandoned: () => true,
    });
    advance(s.server, 5);
    s.server.disconnect(1);
    abandonedStand.poll();
    expect(s.server.pauseState).toBe('running');
    expect(abandonedStand.holding).toBe(false);
  });

  it('ушедший последним снимает УЖЕ СТОЯЩУЮ заморозку, и матч кончается сам (NTR-6)', () => {
    // Обычный порядок событий именно такой: сперва ушёл один и матч замёрз,
    // потом ушёл второй. Держи стенд паузу дальше — живых тиков не стало бы
    // вовсе, а порог молчания считается ИМИ: матч не кончился бы до истечения
    // `pause.maxPauseMs`, а в документе без этого поля — никогда.
    // Порог молчания короткий: предмет теста — что он вообще НАСТУПАЕТ, а не
    // его величина (в документе демо это пять минут окна возврата).
    const SILENCE_TICKS = 30;
    const s = stand({ silenceTicks: SILENCE_TICKS });
    let alone = false;
    const detach = new DetachPause({
      players: s.config.players,
      attached: (slot) => s.server.slotAttached(slot),
      running: () => s.server.phase === 'running',
      state: () => s.server.pauseState,
      pause: () => s.server.pauseMatch(),
      resume: () => s.server.resumeMatch(),
      abandoned: () => alone,
      report: (message) => s.report.push(message),
    });

    advance(s.server, 5);
    s.server.disconnect(1);
    detach.poll();
    expect(s.server.pauseState).toBe('frozen');
    expect(detach.holding).toBe(true);

    // Ушёл и второй — матч покинут всеми.
    s.server.disconnect(2);
    alone = true;
    detach.poll();
    expect(detach.holding).toBe(false);
    expect(s.report.join('\n')).toContain('покинут всеми');

    // Заморозка снята, живые тики пошли — и порог молчания их считает.
    advance(s.server, RESUME_STEPS + 1);
    expect(s.server.mode).toBe('Running');
    const tick = s.server.tick;
    advance(s.server, 10);
    expect(s.server.tick).toBe(tick + 10);

    // Замораживать снова стенд не пытается, сколько бы ни смотрел.
    detach.poll();
    detach.poll();
    expect(s.server.pauseState).toBe('running');

    // И матч действительно кончается сам — порогом молчания слота (NTR-6).
    advance(s.server, SILENCE_TICKS + 2);
    expect(s.server.phase).toBe('ended');
  });

  it('свёрнутый матч снимает свою заморозку: висящей паузы после матча не остаётся', () => {
    const s = stand();
    advance(s.server, 5);
    s.server.disconnect(1);
    s.detach.poll();
    expect(s.server.pauseState).toBe('frozen');

    s.detach.dispose();
    expect(s.server.pauseState).toBe('resuming');
    expect(s.detach.holding).toBe(false);
  });

  it('просроченную паузу политика не ставит заново: одна заморозка на один разрыв', () => {
    // Иначе стенд встал бы в круг, который не кончается: `maxPauseMs` истекает →
    // сервер возобновляет → опрос видит тот же слот без соединения →
    // замораживает снова. Серверное API бюджетов не спрашивает, упереться этому
    // кругу не во что, и матч, из которого владелец ушёл навсегда, не кончился
    // бы никогда — порог молчания (NTR-6) считается ЖИВЫМИ тиками, а их в
    // заморозке нет.
    const maxPauseMs = DEMO_MATCH.pause!.maxPauseMs!;
    const s = stand();
    advance(s.server, 5);
    s.server.disconnect(1);
    s.detach.poll();
    expect(s.detach.holding).toBe(true);

    // Ждём предел длительности одной заморозки и объявленный отсчёт за ним.
    advance(s.server, Math.ceil((maxPauseMs * DEMO_TICK_RATE) / 1000) + RESUME_STEPS + 1);
    expect(s.server.pauseState).toBe('running');
    expect(s.server.pauseInitiator).toBe(-1);

    // Слот по-прежнему без соединения — и матч всё равно идёт живыми тиками.
    s.detach.poll();
    expect(s.server.pauseState).toBe('running');
    expect(s.detach.holding).toBe(false);
    expect(s.detach.exhausted).toBe(true);
    const tick = s.server.tick;
    advance(s.server, 10);
    expect(s.server.tick).toBe(tick + 10);
    expect(s.report.join('\n')).toContain('снята не нами');

    // Возврат владельца закрывает эпизод — и право заморозить СЛЕДУЮЩИЙ разрыв
    // возвращается: предел стоит на одну отвязку, а не на матч.
    s.server.connect(3);
    s.server.receive(3, hello(s.config.players[0]!, s.config.version));
    s.detach.poll();
    expect(s.detach.exhausted).toBe(false);
    s.server.disconnect(3);
    s.detach.poll();
    expect(s.server.pauseState).toBe('frozen');
    expect(s.detach.holding).toBe(true);
  });

  it('отказ API называется вслух, а не теряется', () => {
    const s = stand();
    advance(s.server, 3);
    // Мир в перемотке: пауза матча в `Rewinding` получает именованный отказ
    // (NTR-20), и стенд обязан сказать это, а не молчать.
    s.server.pause();
    s.server.beginRewind();
    s.server.disconnect(1);
    s.detach.poll();
    expect(s.detach.holding).toBe(false);
    expect(s.report.join('\n')).toContain('rewinding');
  });

  it('запертый админом слот матч НЕ замораживает (NTR-19)', () => {
    const s = stand();
    advance(s.server, 10);

    // Админ убирает игрока (SRV-5): слот заперт, соединение владельца разорвано.
    s.server.bar(0);
    s.server.drain();
    expect(s.server.slotAttached(0)).toBe(false);

    // Ждать запертого владельца НЕЛЬЗЯ: его `Hello` получает названный отказ, и
    // вернуться он не может по определению. Заморозь стенд матч — и
    // админ-операция «убрать одного» встала бы всем матчем до истечения
    // `pause.maxPauseMs`, а в документе без этого поля — навсегда. NTR-19
    // обещает обратное: «матч продолжается — слот ведёт заместитель или
    // predicted-фреймы».
    s.detach.poll();
    expect(s.server.pauseState).toBe('running');
    expect(s.detach.holding).toBe(false);

    // И матч действительно идёт: тики живые, слот на predicted-кадрах (NTR-7).
    const before = s.server.tick;
    advance(s.server, 20);
    expect(s.server.tick).toBeGreaterThan(before);

    // Запрет снят, владелец ещё не вернулся — вот теперь ждать есть кого.
    s.server.unbar(0);
    s.detach.poll();
    expect(s.server.pauseState).toBe('frozen');
  });
});
