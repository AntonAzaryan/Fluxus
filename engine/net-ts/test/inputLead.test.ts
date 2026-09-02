/**
 * Адаптивный запас разметки ввода (NTR-7) и его наблюдаемость (NTR-11).
 *
 * Две половины, и они проверяют разное. Первая — контроллер сам по себе, на
 * синтетической последовательности «отправлено — подтверждено»: ни матча, ни
 * таймеров, ни канала, только пороги (design D1, D2). Вторая — матч на
 * эмуляторе канала в виртуальном времени (design D6): профиль «LAN» обязан
 * оставить поведение прежним, профиль «туннель» — тот самый канал, на котором
 * константная разметка теряла управление.
 *
 * Прогоны второй половины НАМЕРЕННО длинные — по несколько окон стабильности
 * контроллера. Установившийся режим и есть предмет проверки: подъём виден за
 * секунды, а вот «спуск не отъедает управление раз в десять секунд до конца
 * матча» видно только за окнами, и первая редакция этих тестов, остановившаяся
 * до первого спуска, ровно это и пропустила.
 */
import { describe, expect, it } from 'vitest';
import type { InputSource } from '../src/client/host.js';
import { LeadController } from '../src/client/lead.js';
import type { Pacing } from '../src/protocol/messages.js';
import { duelConfig } from './fixtures.js';
import {
  channelConfig,
  channelMatch,
  DOWNLINK_DEAD,
  DOWNLINK_LOSS,
  LAN,
  TUNNEL,
  TUNNEL_JITTER,
  WALK,
  type ChannelMatch,
} from './support/channel.js';

/**
 * Темп синтетических проверок: шаг подъёма 2 тика (период рассылки), окно
 * стабильности 100 отправок (пять секунд), пол 2, потолок 8 (окно приёма 12
 * минус запас оценки: период рассылки плюс `inputDelay`). Все величины выведены из ЭТИХ полей, а не зашиты в контроллер,
 * — поэтому мелкий темп делает проверку короткой, не делая её ненастоящей.
 */
const PACING: Pacing = {
  tickRate: 20,
  snapshotRate: 10,
  inputDelay: 2,
  inputWindow: 12,
  eventRepeat: 0,
};

const STEP_TICKS = PACING.tickRate / PACING.snapshotRate;
const SETTLE_WINDOW = 5 * PACING.tickRate;
/** Срок эха сверх запаса: рассылка, запас оценки тика и допуск на часы. */
const SLACK = STEP_TICKS + (STEP_TICKS + PACING.inputDelay) + STEP_TICKS;
/** Потолок: окно приёма за вычетом запаса оценки тика. */
const CEILING = PACING.inputWindow - STEP_TICKS - PACING.inputDelay;

/** Возраст подтверждения: на сколько тиков назад помечен подтверждённый кадр. */
const ECHO_AGE = 6;

/**
 * Сколько отправок без единого подтверждения поднимают запас: срок эха плюс
 * сама отправка, на которой он истёк.
 */
function deadline(lead: number): number {
  return lead + SLACK + 1;
}

/**
 * Сколько отправок нужно, чтобы подтверждение дошло до кадра, отправленного УЖЕ
 * под текущим значением: до него контроллер судит по сроку, а не по разности.
 */
const PROVEN = ECHO_AGE + 1;

/** Чистое окно стабильности целиком: путь первого подтверждения плюс само окно. */
const STABLE = SETTLE_WINDOW + ECHO_AGE;

interface Feed {
  readonly sends: number;
  /**
   * Сколько тиков подряд сервер жил на повторе последнего кадра на момент
   * каждой отправки. Поля нет — подтверждений не приходит вовсе (канал, на
   * котором не применяется ничего).
   */
  readonly behind?: number;
  /**
   * Снапшоты доезжают. `false` — downlink оборван: подтверждений нет, но и
   * канала состояний нет, и срок эха на этом не срабатывает (design D1).
   */
  readonly snapshots?: boolean;
  /**
   * Раз в столько отправок клиент пропускает СВОЙ номер тика: отставшие часы
   * подтянулись через `resyncTick`, и тик остался без кадра вовсе.
   */
  readonly skipEvery?: number;
}

/**
 * Синтетическая последовательность отправок: по кадру на тик, как их шлёт
 * клиент, — номер кадра и его тик здесь совпадают. Возвращает следующий
 * свободный `seq`.
 *
 * Подтверждение собирается парой тиков: «кадр, помеченный тиком T, применился, а
 * снапшот приехал с тиком T + behind». Возраст подтверждения на разность не
 * влияет — в этом и смысл тиковой шкалы, — поэтому берётся любой правдоподобный.
 *
 * Снапшоты приезжают по умолчанию даже там, где ни один кадр не подтверждён:
 * длинный канал состояния шлёт исправно, просто своего кадра клиент в них ещё
 * не видит. Обрыв downlink — отдельный случай и отдельная ручка.
 */
function feed(control: LeadController, from: number, plan: Feed): number {
  let seq = from;
  for (let i = 0; i < plan.sends; i++) {
    const tick = seq;
    if (plan.snapshots !== false) control.snapshotApplied();
    if (plan.behind !== undefined) {
      const marked = tick - ECHO_AGE;
      control.applied(marked, marked + plan.behind);
    }
    control.sent(seq, tick);
    seq++;
  }
  return seq;
}

/**
 * Тот же поток, но с ДЫРАМИ в собственной разметке: раз в `skipEvery` тиков
 * отставшие часы клиента подтягиваются `resyncTick` через номер, и тик остаётся
 * без кадра вовсе. Эхо считается по-серверному: тик, на который кадра не было,
 * сервер живёт на повторе, и подтверждение, приехавшее на нём, отстаёт ровно на
 * этот тик — при канале, доставляющем всё и вовремя.
 */
function feedSlow(control: LeadController, from: number, ticks: number, skipEvery: number): void {
  let seq = from;
  for (let i = 0; i < ticks; i++) {
    const tick = from + i;
    if (i > 0 && i % skipEvery === 0) continue;
    const marked = tick - ECHO_AGE;
    const missed = marked > from && (marked - from) % skipEvery === 0;
    control.snapshotApplied();
    // Пропущенный тик виден подтверждением с отставанием в один тик: кадра на
    // него не было, и сервер прожил его повтором предыдущего.
    if (missed) control.applied(marked - 1, marked);
    else control.applied(marked, marked);
    control.sent(seq, tick);
    seq++;
  }
}

/** Матч «сосед рядом с сервером плюс второй за длинной дорогой». */
function tunnelMatch(profile = TUNNEL, overrides = {}): ChannelMatch {
  return channelMatch({
    config: channelConfig(overrides),
    profiles: [LAN, profile],
    input: () => WALK,
  });
}

/** Счётчики слота: сколько ввода применено и сколько заменено повтором. */
function slotOf(match: ChannelMatch, index: number): { applied: number; predicted: number } {
  const slot = match.server.metrics.slots[index]!;
  return { applied: slot.applied, predicted: slot.predicted };
}

describe('детектор опоздания и контроллер запаса (design D1, D2)', () => {
  it('чистое эхо запас не двигает: он остаётся на нижней границе', () => {
    const control = new LeadController(PACING);

    feed(control, 1000, { sends: 10 * SETTLE_WINDOW, behind: 0 });

    expect(control.lead).toBe(PACING.inputDelay);
  });

  it('канал, на котором не применяется ничего, поднимает запас по сроку эха', () => {
    const control = new LeadController(PACING);

    // Подтверждений нет вовсе: до срока запас стоит, на сроке поднимается на
    // период рассылки.
    const seq = feed(control, 1, { sends: deadline(PACING.inputDelay) - 1 });
    expect(control.lead).toBe(PACING.inputDelay);

    feed(control, seq, { sends: 1 });
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS);
  });

  it('размеченный тик, прожитый сервером на повторе, поднимает запас — допуска на серию нет', () => {
    // Опоздавший кадр отброшен вместе с нажатиями, которые нёс (NTR-7), и
    // разность видна только на тиках рассылки: допуск в несколько тиков делал
    // бы контроллер слепым к каналу, где опаздывает каждый двадцатый кадр, — он
    // сходился бы к значению, при котором ввод теряется постоянно.
    const control = new LeadController(PACING);
    const seq = feed(control, 1, { sends: PROVEN, behind: 0 });
    expect(control.lead).toBe(PACING.inputDelay);

    feed(control, seq, { sends: 1, behind: 1 });
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS);
  });

  it('снапшот без своего кадра — наблюдение: сервер прошёл барьер без нас, подъём раньше срока', () => {
    // На старте длинного канала эха нет вовсе: сервер ни одного кадра слота не
    // применял и повторяет нулевой (TICK-2). Но тик снапшота — серверная
    // величина, и снапшот, тик которого уже за первым размеченным, говорит,
    // что кадры к своим тикам не доехали, — ждать срока эха незачем.
    const control = new LeadController(PACING);
    const first = 100;
    control.snapshotApplied();
    control.sent(1, first);
    // Снапшот ещё до барьера: сервер размеченных тиков не проходил — молчание.
    control.noEcho(first - 1);
    control.sent(2, first + 1);
    expect(control.lead).toBe(PACING.inputDelay);
    // Сервер прошёл первый размеченный тик, а нашего кадра в нём нет.
    control.noEcho(first);
    control.sent(3, first + 2);
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS);
  });

  it('молчание игрока запас не двигает ни вверх, ни вниз', () => {
    const control = new LeadController(PACING);
    const seq = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    const raised = control.lead;
    expect(raised).toBeGreaterThan(PACING.inputDelay);

    // Кадры под новым значением доезжают: разность есть на чём стоять, и
    // молчание попадает уже на РАБОТАЮЩИЙ детектор, а не на срок эха.
    const spoke = feed(control, seq, { sends: PROVEN, behind: 0 });
    expect(control.lead).toBe(raised);

    // Подтверждения приходят, отправок нет: сигнала не существует — наблюдать
    // нечего, даже если сервер давно живёт на повторе.
    const silentUntil = spoke + 10 * SETTLE_WINDOW;
    for (let tick = spoke; tick <= silentUntil; tick++) {
      control.snapshotApplied();
      control.applied(spoke - 1, tick);
    }
    expect(control.lead).toBe(raised);

    // И ПЕРВАЯ отправка после молчания его не воскрешает. Номера отправок
    // непрерывны — молчащий источник ввода `seq` не тратит, `pushInput` его не
    // зовёт вовсе, — поэтому разрыв в номерах эту дыру не ловит и ловить не
    // должен: ловится она дырой в РАЗМЕТКЕ. Серия повторов, накопленная за
    // молчание, есть длина молчания, а не длина канала, и счёт её опозданием
    // был бы храповиком запаса на канале с нулевой задержкой.
    let tick = silentUntil + raised;
    let next = spoke;
    for (let i = 0; i < SETTLE_WINDOW / 2; i++) {
      control.snapshotApplied();
      // Первая отправка судится по эху МОЛЧАНИЯ — тому самому, что накопило
      // серию длиной в молчание; дальше подтверждения приходят свежие и чистые.
      if (i > 0) control.applied(tick - ECHO_AGE, tick - ECHO_AGE);
      control.sent(next++, tick++);
    }

    expect(control.lead).toBe(raised);
  });

  it('редкий ввод запас не разгоняет: между отправками сервер живёт повтором', () => {
    // Источник ввода отдаёт сэмпл раз в двадцать тиков (`InputSource` вправе
    // вернуть `undefined`) — и всё это время сервер честно живёт на повторе
    // последнего кадра. Разность «тик снапшота − тик подтверждённого кадра»
    // растёт вместе с паузой, но тики паузы клиент не размечал: канал ни при
    // чём, и запас с пола не двигается.
    const control = new LeadController(PACING);
    let seq = 1;
    let lastMarked = 0;
    for (let tick = 1; tick <= 40 * SETTLE_WINDOW; tick++) {
      control.snapshotApplied();
      // Эхо снапшота прошлого тика: последний применённый кадр вместе с его
      // `seq` и тиком (TICK-2) — между отправками он не меняется, а тик
      // снапшота растёт.
      if (lastMarked > 0) control.applied(lastMarked, tick - 1);
      if (tick % 20 !== 1) continue;
      control.sent(seq++, tick);
      lastMarked = tick;
    }

    expect(control.lead).toBe(PACING.inputDelay);
  });

  it('оборванный downlink запас не двигает: срок эха ждёт снапшота (design D1)', () => {
    // Снапшотов нет вовсе, отправки живые: подтверждений не приходит ровно так
    // же, как на канале длиннее запаса, — а лечится это не запасом. Своим
    // сроком, без этого условия, детектор угнал бы запас в потолок на поломке
    // канала СОСТОЯНИЙ.
    const control = new LeadController(PACING);

    feed(control, 1, { sends: 50 * deadline(PACING.inputWindow), snapshots: false });

    expect(control.lead).toBe(PACING.inputDelay);
  });

  it('протухшее наблюдение и спуска не даёт: чистое окно набирается по эху', () => {
    const control = new LeadController(PACING);
    const seq = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    const raised = control.lead;
    const spoke = feed(control, seq, { sends: PROVEN, behind: 0 });
    expect(control.lead).toBe(raised);

    // Downlink оборвался посреди чистой полосы: отправки живые, подтверждений
    // больше нет ни одного. Последняя разность осталась нулевой — и без проверки
    // свежести окно стабильности набралось бы на ней одной, то есть запас
    // спускала бы ПОТЕРЯ СНАПШОТОВ, ради независимости от которой и выбрана
    // тиковая шкала.
    feed(control, spoke, { sends: 10 * STABLE, snapshots: false });

    expect(control.lead).toBe(raised);
  });

  it('пропущенный клиентом тик чистого окна не рвёт: часы медленнее — не канал', () => {
    const control = new LeadController(PACING);
    // Запас поднят сроком эха; дальше канал доставляет всё и вовремя, но
    // отставшие часы клиента раз в сорок тиков перешагивают номер — тик уходит
    // в повтор, хотя кадра на него не было вовсе.
    const seq = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    const raised = control.lead;
    expect(raised).toBe(PACING.inputDelay + STEP_TICKS);

    feedSlow(control, seq, 4 * SETTLE_WINDOW, 40);

    // Спуск идёт своим темпом: собственная дыра разметки чистое окно не рвёт,
    // иначе на медленных часах запас не вернулся бы к полу никогда — подъём
    // пропущенных номеров не лечит.
    expect(control.lead).toBe(PACING.inputDelay);
  });

  it('потолок — окно приёма за вычетом запаса оценки тика (NTR-7)', () => {
    const control = new LeadController(PACING);

    feed(control, 1, { sends: 50 * deadline(PACING.inputWindow) });

    // Не `inputWindow`: кадр помечается ОТ оценки, а ей `resyncTick` разрешает
    // стоять на «период рассылки + inputDelay» выше снапшотной — с запасом
    // ровно в окно кадр уезжал бы за окно приёма и терялся бы собственной
    // разметкой, что NTR-7 и запрещает.
    expect(control.lead).toBe(CEILING);
    expect(CEILING).toBeLessThan(PACING.inputWindow);
  });

  it('спуск идёт по тику за окно стабильности и медленнее подъёма, до пола (NTR-7)', () => {
    const control = new LeadController(PACING);
    // Подъём: два тика за один срок эха.
    const raised = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS);

    // Спуск: тик за окно стабильности, то есть впятеро реже и вдвое мельче.
    const short = feed(control, raised, { sends: STABLE - 1, behind: 0 });
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS);
    const afterFirst = feed(control, short, { sends: 1, behind: 0 });
    expect(control.lead).toBe(PACING.inputDelay + STEP_TICKS - 1);

    const afterSecond = feed(control, afterFirst, { sends: STABLE, behind: 0 });
    expect(control.lead).toBe(PACING.inputDelay);

    // Пол — `inputDelay`: ниже него запас не опускается, сколько ни жди.
    feed(control, afterSecond, { sends: 10 * STABLE, behind: 0 });
    expect(control.lead).toBe(PACING.inputDelay);
  });

  it('неудачная проба возвращает прежнее значение, а следующая ждёт вдвое дольше', () => {
    const control = new LeadController(PACING);
    // Два срока эха подряд без подтверждений: 2 → 4 → 6.
    let seq = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    seq = feed(control, seq, { sends: deadline(control.lead) });
    const raised = control.lead;
    expect(raised).toBe(PACING.inputDelay + 2 * STEP_TICKS);

    // Чистое окно — спуск на тик; канал этого тика не выдерживает: первый же
    // размеченный тик на повторе — сигнал.
    seq = feed(control, seq, { sends: STABLE, behind: 0 });
    expect(control.lead).toBe(raised - 1);
    seq = feed(control, seq, { sends: PROVEN, behind: 1 });
    // Возврат ровно туда, откуда спустились: то значение доставку доказало.
    expect(control.lead).toBe(raised);

    // Второе окно той же длины пробы больше не даёт — она удвоилась.
    seq = feed(control, seq, { sends: STABLE, behind: 0 });
    expect(control.lead).toBe(raised);
    feed(control, seq, { sends: STABLE, behind: 0 });
    expect(control.lead).toBe(raised - 1);
  });

  it('смена эпохи наблюдение начинает заново, а запас сохраняет (design D3)', () => {
    const control = new LeadController(PACING);
    const seq = feed(control, 1, { sends: deadline(PACING.inputDelay) });
    const adapted = control.lead;

    control.resync();
    // Пара тиков из новой эпохи с прежней не сравнима: номера тиков после
    // перемотки идут заново. Поэтому подтверждение прежней эпохи — с огромной
    // разностью — доказательством не становится, и до первого подтверждения под
    // текущим значением работает срок, а не разность.
    control.applied(seq, 1);
    feed(control, seq, { sends: deadline(adapted) - 1, behind: 0 });

    expect(control.lead).toBe(adapted);
  });
});

describe('разметка ввода адаптивным запасом (NTR-7)', () => {
  it('на канале без плеча запас не растёт, а разметка совпадает с константной', () => {
    const match = channelMatch({
      config: channelConfig(),
      profiles: [LAN, LAN],
      input: () => WALK,
    });
    match.run(1200);

    for (const seat of match.clients) {
      expect(seat.client.metrics.inputLead).toBe(match.server.pacing.inputDelay);
    }
    for (const slot of match.server.metrics.slots) {
      expect(slot.applied).toBeGreaterThan(1100);
      // Predicted остаётся только за хендшейком: кадров слота ещё нет, а тики
      // уже идут. Дальше кадры успевают, и счётчик стоит.
      expect(slot.predicted).toBeLessThan(10);
    }
  });

  it('туннель: ввод второго игрока перестаёт быть predicted, когда запас дорос', () => {
    const match = tunnelMatch();
    match.run(100);

    const near = match.server.metrics.slots[0]!;
    // Сосед рядом с сервером канала не заметил: запас на нижней границе.
    expect(match.clients[0]!.client.metrics.inputLead).toBe(2);
    expect(near.applied).toBeGreaterThan(80);
    // Второй игрок: запас поднялся в границах окна, и кадры пошли.
    const lead = match.clients[1]!.client.metrics.inputLead!;
    expect(lead).toBeGreaterThan(match.server.pacing.inputDelay);
    expect(lead).toBeLessThanOrEqual(match.server.pacing.inputWindow);
    expect(match.server.metrics.slots[1]!.applied).toBeGreaterThan(40);
  });

  it('туннель в установившемся режиме: спуск не отъедает управление (design D2)', () => {
    const match = tunnelMatch();
    // Два окна стабильности: первый спуск случается ПОСЛЕ первого из них, и
    // прогон, кончившийся раньше, про установившийся режим не говорит ничего —
    // ровно это и пропустила первая редакция теста.
    match.run(400);
    const settled = slotOf(match, 1);

    match.run(2000);
    const later = slotOf(match, 1);
    const applied = later.applied - settled.applied;
    const predicted = later.predicted - settled.predicted;

    // Управление у игрока: подавляющее большинство тиков — его собственный
    // ввод, а не повтор (NTR-7: «фрейм не успел» — редкое событие).
    expect(applied).toBeGreaterThan(1900);
    expect(predicted).toBeLessThan(80);
    // Пробы спуска редеют вдвое с каждой неудачей, поэтому следующий отрезок
    // той же длины дешевле предыдущего. Без этого правила слот терял бы по
    // секунде управления каждые несколько секунд до конца матча — при нулевом
    // счётчике опозданий у соседа на том же сервере.
    match.run(2000);
    const last = slotOf(match, 1);
    expect(last.predicted - later.predicted).toBeLessThan(predicted);
    expect(last.applied - later.applied).toBeGreaterThan(1950);
    expect(slotOf(match, 0).predicted).toBeLessThan(10);
  });

  it('на джиттере запас держится в одном тике: разброс порогов не набирает', () => {
    const match = tunnelMatch(TUNNEL_JITTER);
    match.run(400);
    const settled = match.clients[1]!.client.metrics.inputLead!;
    expect(settled).toBeGreaterThan(match.server.pacing.inputDelay);
    const before = slotOf(match, 1);

    // Стабильность держится НЕ тем, что пороги молчат: на джиттере набираются
    // оба, и это штатно (design D2). Чистое окно доводит контроллер до пробы
    // спуска, канал этого тика не выдерживает — и неудачная проба возвращает
    // РОВНО то значение, с которого спустилась, а не шаг подъёма. Полоса в один
    // тик и есть след этой пары; шире неё она стать не может, и потому
    // проверяются оба направления, а не «значение не менялось».
    const seen = new Set<number>();
    const probes: number[] = [];
    let previous = settled;
    for (let i = 0; i < 2000; i++) {
      match.step();
      const now = match.clients[1]!.client.metrics.inputLead!;
      if (now < previous) probes.push(i);
      previous = now;
      seen.add(now);
    }
    const values = [...seen].sort((left, right) => left - right);

    expect(values[values.length - 1]! - values[0]!).toBeLessThanOrEqual(1);
    // Проб за двадцать окон стабильности — две, и вторая ждала дольше первой:
    // память о значении, оказавшемся малым, удваивает окно с каждой неудачей.
    // Без неё их было бы по одной на окно, и цена неудачи стала бы постоянной.
    expect(probes.length).toBe(2);
    expect(probes[1]! - probes[0]!).toBeGreaterThan(probes[0]!);
    const after = slotOf(match, 1);
    expect(after.applied - before.applied).toBeGreaterThan(1800);
    // Predicted здесь — цена ровно этих двух проб, и она заметна: одна неудача
    // стоит десятков тиков повтора, пока эхо не докажет, что тик был лишним.
    // Граница держится близко к измеренной, иначе она пропустила бы лишнюю
    // пробу целиком.
    expect(after.predicted - before.predicted).toBeLessThan(100);
  });

  it('канал выправился — запас спускается к нижней границе и на ней остаётся', () => {
    const match = tunnelMatch();
    match.run(200);
    expect(match.clients[1]!.client.metrics.inputLead).toBeGreaterThan(2);

    // Дорога стала короткой на живом канале: профиль — данные, и подмена его
    // здесь означает ровно сценарий «Канал выправился» (NTR-7).
    match.channels[1]!.retune(LAN);
    // Тик за пять секунд стабильности (design D2): спуск с потолка до пола
    // занимает столько же окон, сколько тиков между ними, плюс начатое окно.
    match.run(8 * SETTLE_WINDOW);

    expect(match.clients[1]!.client.metrics.inputLead).toBe(match.server.pacing.inputDelay);
  });

  it('канал выправился при медленных часах клиента: спуск доходит до пола (NTR-7)', () => {
    // Зеркало проверки быстрых часов, и ломается на нём другое. Собственный
    // таймер второго клиента идёт на два процента МЕДЛЕННЕЕ серверного, и
    // `resyncTick` подтягивает его оценку ЧЕРЕЗ номер: тик остаётся без кадра
    // вовсе, сервер живёт его повтором. Считай контроллер такой повтор
    // опозданием, чистого окна не набралось бы никогда — и запас, поднятый
    // туннелем, остался бы наверху навсегда, платя лишний отклик за поломку,
    // которой подъём не лечит. Продакшен-таймеры у обеих сторон — голый
    // `setInterval` без догона, так что медленной стороной клиент бывает
    // примерно так же часто, как быстрой.
    const match = channelMatch({
      config: channelConfig(),
      profiles: [LAN, TUNNEL],
      input: () => WALK,
      slowStepEvery: (index) => (index === 1 ? 50 : undefined),
    });
    match.run(200);
    expect(match.clients[1]!.client.metrics.inputLead!).toBeGreaterThan(2);
    const before = slotOf(match, 1);

    match.channels[1]!.retune(LAN);
    match.run(8 * SETTLE_WINDOW);

    expect(match.clients[1]!.client.metrics.inputLead).toBe(match.server.pacing.inputDelay);
    // Управление у игрока: пропущенные шаги стоят своих тиков повтора и ровно
    // их — с этой ценой живёт любой клиент на собственном таймере.
    const after = slotOf(match, 1);
    expect(after.applied - before.applied).toBeGreaterThan(750);
    expect(match.server.metrics.slots[1]!.outOfWindow).toBe(0);
  });

  it('оборванный downlink запас не двигает вовсе: ни вверх, ни вниз (design D1)', () => {
    // Крайний случай несимметричной поломки: снапшотов не доезжает НИ ОДНОГО,
    // ввод доезжает. Подтверждений нет ровно так же, как на канале длиннее
    // запаса, — и по сроку эха запас уехал бы в потолок, лечи он этим поломку
    // канала СОСТОЯНИЙ. Спуск ломается симметрично: последняя разность осталась
    // чистой, и чистое окно набралось бы на наблюдении, которого больше нет.
    const match = channelMatch({
      config: channelConfig(),
      profiles: [LAN, { up: TUNNEL, down: TUNNEL }],
      input: () => WALK,
    });
    // Рвётся рано, пока ни один кадр не подтверждён: именно в этом состоянии
    // работает срок эха, и именно его потеря снапшотов и подделывает.
    match.run(12);
    match.downlinks[1]!.retune(DOWNLINK_DEAD);
    match.run(100);
    const frozen = match.clients[1]!.client.metrics.inputLead!;
    const snapshots = match.clients[1]!.client.metrics.snapshotsApplied;
    const pacing = match.server.pacing;
    // Подъёмы — только те, что успели застать живые снапшоты (единицы), а не
    // разгон в потолок: без снапшотов ни срок эха, ни разность не работают.
    const ceiling = pacing.inputWindow - pacing.tickRate / pacing.snapshotRate - pacing.inputDelay;
    expect(frozen).toBeLessThan(ceiling / 2);

    match.run(20 * SETTLE_WINDOW);

    expect(match.clients[1]!.client.metrics.snapshotsApplied).toBe(snapshots);
    expect(match.clients[1]!.client.metrics.inputLead).toBe(frozen);
    // Uplink жив — кадры доезжают, просто опаздывают. Раздельный счёт (NTR-11)
    // это и показывает: опоздания есть, а запас без эха не растёт.
    expect(match.server.metrics.slots[1]!.late).toBeGreaterThan(0);
  });

  it('перемотка начинает наблюдение заново, а не только сохраняет значение (design D1, D3)', () => {
    // Соседний тест проверяет, что перемотка сохраняет ЗНАЧЕНИЕ. Здесь — вторая
    // половина того же требования: НАБЛЮДЕНИЕ она обязана начать заново, потому
    // что пара тиков через смену эпохи не сравнима (NTR-16).
    //
    // Разрыв в номерах отправок этого не ловит: игрок, не трогающий управление
    // во время перемотки, номеров не тратит вовсе — `pushInput` при пустом
    // сэмпле не вызывается. Тогда чистое окно прошлой ветви истории досчиталось
    // бы до конца уже в новой (спуск на ровном месте), а старый `behind`
    // сравнил бы тик старой эпохи с тиком новой (подъём на ровном месте).
    let silent = false;
    const idle: InputSource = (tick) => (silent ? undefined : WALK(tick));
    const match = channelMatch({
      config: channelConfig({ rewind: { interval: 2, capacity: 200 } }),
      profiles: [LAN, TUNNEL],
      input: (index) => (index === 1 ? idle : WALK),
    });
    match.run(200);
    const client = match.clients[1]!.client;
    const raised = client.metrics.inputLead!;
    expect(raised).toBeGreaterThan(2);

    // Канал выправился: дождаться очередного спуска — от него отсчитывается
    // новое окно стабильности, — и подойти к его концу вплотную: спуск
    // случился бы через считаные шаги, то есть решение принимается ровно на
    // границе перемотки. Отсчёт от наблюдаемого спуска, а не от числа шагов:
    // темп подъёма — величина контроллера, и тест его не приколачивает.
    match.channels[1]!.retune(LAN);
    let guard = 0;
    while (client.metrics.inputLead === raised && guard++ < 10 * SETTLE_WINDOW) match.step();
    const adapted = client.metrics.inputLead!;
    expect(adapted).toBe(raised - 1);
    match.run(SETTLE_WINDOW - 10);
    expect(client.metrics.inputLead).toBe(adapted);

    const epoch = match.server.epoch;
    silent = true;
    match.server.pause();
    match.server.beginRewind();
    match.server.seekTo(match.server.tick - 6);
    match.server.pause();
    match.server.resume();
    match.run(6);
    silent = false;
    expect(match.server.epoch).toBeGreaterThan(epoch);

    // Наблюдение началось заново: ни спуска по чужому окну, ни подъёма по
    // несравнимой паре.
    match.run(40);
    expect(client.metrics.inputLead).toBe(adapted);

    // И это не «запас застыл»: целое окно НОВОЙ эпохи спуск всё-таки даёт.
    match.run(2 * SETTLE_WINDOW);
    expect(client.metrics.inputLead).toBeLessThan(adapted);
  });

  it('перемотка запас не сбрасывает: он свойство канала, а не ветви истории (design D3)', () => {
    const match = tunnelMatch(TUNNEL, { rewind: { interval: 2, capacity: 60 } });
    match.run(200);
    const client = match.clients[1]!.client;
    const adapted = client.metrics.inputLead!;
    expect(adapted).toBeGreaterThan(2);
    const appliedBefore = match.server.metrics.slots[1]!.applied;

    // Полный флоу перемотки хостом (NET-11): Running → Paused → Rewinding →
    // Paused → Running. Эпоха меняется на восстановлении (NTR-16).
    const epoch = match.server.epoch;
    match.server.pause();
    match.server.beginRewind();
    match.server.seekTo(match.server.tick - 6);
    match.server.pause();
    match.server.resume();
    match.run(60);

    expect(match.server.epoch).toBeGreaterThan(epoch);
    expect(client.epoch).toBe(match.server.epoch);
    expect(client.metrics.inputLead).toBe(adapted);
    // Кадры новой эпохи успевают: запас пережил смену ветви истории вместе с
    // каналом, о котором он говорит.
    expect(match.server.metrics.slots[1]!.applied).toBeGreaterThan(appliedBefore);
  });

  it('удержанный скраб через рассылки запас не разгоняет (REW-7, NTR-16)', () => {
    const match = tunnelMatch(TUNNEL, { rewind: { interval: 2, capacity: 200 } });
    match.run(200);
    const client = match.clients[1]!.client;
    const adapted = client.metrics.inputLead!;

    // Скраб, УДЕРЖАННЫЙ через несколько рассылок: между шагами скраба матч
    // продолжает идти, оценка серверного тика у клиента живёт своей жизнью, а
    // кадры замороженного мира сервер отбрасывает целиком. Разность
    // «отправлено — применено» за это время накапливает что угодно, и мерить
    // ею канал нельзя: запас обязан остаться про канал.
    match.server.pause();
    match.server.beginRewind();
    for (let i = 0; i < 60; i++) {
      if (i % 4 === 0) match.server.seekTo(Math.max(1, match.server.tick - 2));
      match.step();
    }
    match.server.pause();
    match.server.resume();
    match.run(600);

    const lead = client.metrics.inputLead!;
    expect(lead).toBeLessThanOrEqual(adapted);
    expect(lead).toBeGreaterThanOrEqual(match.server.pacing.inputDelay);
    // Ввод после перемотки доезжает — то есть запас остался осмысленным, а не
    // уехал в потолок вместе с оценкой.
    const before = slotOf(match, 1);
    match.run(400);
    expect(slotOf(match, 1).applied - before.applied).toBeGreaterThan(380);
  });

  it('заморозка матча запас не двигает: пауза — не длина канала (NTR-20)', () => {
    const match = tunnelMatch();
    match.run(300);
    const client = match.clients[1]!.client;
    const adapted = client.metrics.inputLead!;
    expect(adapted).toBeGreaterThan(2);

    // Пауза длиннее любого окна контроллера. Кадры замороженного мира сервер
    // отбрасывает целиком (NET-11), снапшотов в паузе нет — и запас, считай он
    // это опозданием, вырос бы до потолка, померив длительность паузы вместо
    // длины канала.
    expect(match.server.pauseMatch()).toBeUndefined();
    match.run(4 * SETTLE_WINDOW);
    expect(client.metrics.inputLead).toBe(adapted);

    expect(match.server.resumeMatch()).toBeUndefined();
    match.run(SETTLE_WINDOW);
    expect(client.metrics.inputLead).toBe(adapted);
  });

  it('часы клиента быстрее серверных запас не разгоняют', () => {
    // Канал без плеча, но собственный таймер второго клиента идёт на процент
    // быстрее: оценка тика упирается в потолок `resyncTick` и стоит выше
    // снапшотной. Разность, считанная в отправках, а не в тиках, приняла бы это
    // за опоздание — и, поскольку она растёт вместе с запасом, подняла бы его
    // до потолка на исправном канале и не вернула бы.
    const match = channelMatch({
      config: channelConfig(),
      profiles: [LAN, LAN],
      input: () => WALK,
      extraStepEvery: (index) => (index === 1 ? 100 : undefined),
    });
    match.run(3000);

    expect(match.clients[1]!.client.metrics.inputLead).toBe(match.server.pacing.inputDelay);
    const slot = match.server.metrics.slots[1]!;
    expect(slot.applied).toBeGreaterThan(2900);
    // Разметка остаётся внутри окна приёма: потолок запаса на то и уменьшен на
    // запас оценки (NTR-7).
    expect(slot.outOfWindow).toBe(0);
  });

  it('рвётся downlink, uplink жив: потеря снапшотов запас не двигает (design D1)', () => {
    // Направления у канала раздельные, потому что предмет проверки — ровно
    // несимметричная поломка. Ломается downlink уже ПОСЛЕ хендшейка: `Welcome`
    // повторов не имеет, и потерянный на входе он означал бы тест про вход, а
    // не про запас.
    const match = channelMatch({
      config: channelConfig(),
      profiles: [LAN, { up: LAN, down: LAN }],
      input: () => WALK,
    });
    match.run(60);
    match.downlinks[1]!.retune(DOWNLINK_LOSS);
    const before = slotOf(match, 1);
    match.run(1000);

    // Эхо приходит реже — но каждое со своим тиком, и разность в тиковой шкале
    // от прореженных снапшотов не растёт. Поднимать запас на потерю снапшотов
    // значило бы лечить каналом ввода поломку канала состояний.
    expect(match.clients[1]!.client.metrics.inputLead).toBe(match.server.pacing.inputDelay);
    // Ввод при этом доезжает: uplink жив, и слот живёт своим вводом.
    const after = slotOf(match, 1);
    expect(after.applied - before.applied).toBeGreaterThan(950);
    expect(after.predicted - before.predicted).toBeLessThan(10);
    expect(match.clients[1]!.client.metrics.snapshotsApplied).toBeLessThan(
      match.clients[0]!.client.metrics.snapshotsApplied,
    );
  });

  it('длинный канал переживает адаптацию при ШТАТНОМ пороге молчания (NTR-6)', () => {
    // Темп демо-арены и круг в полокна: `duelConfig` без подмены порога — то
    // есть штатные десять секунд молчания (NTR-6). Слот на длинном канале живёт
    // на predicted, пока запас не дорос, и `silentTicks` при этом растут: если
    // адаптация медленнее порога, матч кончается «player-silent» раньше, чем
    // игрок получает управление.
    const match = channelMatch({
      config: duelConfig({ tickRate: 60, snapshotRate: 30, inputDelay: 2, inputWindow: 30 }),
      profiles: [LAN, { name: 'long', delaySteps: 13, jitterSteps: 0, lossPerMille: 0 }],
      input: () => WALK,
    });
    match.run(900);

    expect(match.server.phase).toBe('running');
    const lead = match.clients[1]!.client.metrics.inputLead!;
    expect(lead).toBeGreaterThan(20);
    const before = slotOf(match, 1);
    match.run(600);
    // Управление к этому моменту уже у игрока, а не у повтора.
    expect(slotOf(match, 1).applied - before.applied).toBeGreaterThan(540);
  });

  it('окно вдвое шире требует и порога молчания шире: подъём квадратичен (NTR-6)', () => {
    // Граница совета «поднимать надо `inputWindow`» (README): подъёмы идут по
    // сроку эха, и каждый следующий ждёт `lead + slack` тиков — время выхода
    // растёт КВАДРАТИЧНО по нужному запасу. Окно 30 при круге в полокна
    // укладывается в штатные десять секунд (соседний тест), окно 60 — уже нет.
    const wide = (silenceTicks: number): ChannelMatch =>
      channelMatch({
        config: duelConfig({
          tickRate: 60,
          snapshotRate: 30,
          inputDelay: 2,
          inputWindow: 60,
          ...(silenceTicks === 0 ? {} : { silenceTicks }),
        }),
        profiles: [LAN, { name: 'long-60', delaySteps: 25, jitterSteps: 0, lossPerMille: 0 }],
        input: () => WALK,
      });

    // Штатный порог: слот живёт на predicted, то есть для сервера молчит, — и
    // матч кончается «player-silent» раньше, чем запас дорастает до круга.
    const strict = wide(0);
    strict.run(3000);
    expect(strict.server.phase).toBe('ended');
    expect(slotOf(strict, 1).applied).toBe(0);

    // Порог, поднятый вместе с окном: выравнивание доходит, и управление у
    // игрока. Это и есть вторая половина совета — без неё окно шире вредит.
    const patient = wide(3600);
    patient.run(3000);
    expect(patient.server.phase).toBe('running');
    expect(patient.clients[1]!.client.metrics.inputLead!).toBeGreaterThan(40);
    const before = slotOf(patient, 1);
    patient.run(600);
    expect(slotOf(patient, 1).applied - before.applied).toBeGreaterThan(540);
  });

  it('канал с разбросом: в установившемся режиме кадры не теряются, а проба стоит единицы тиков', () => {
    // Профиль в духе edge-туннеля при темпе демо-арены: круг ~230–300 мс с
    // разбросом в два тика на направление. Опоздавший кадр отброшен вместе с
    // нажатиями (NTR-7), поэтому мерой служит серверный счётчик опозданий, а
    // не только «применено против предсказано». Допуск на серию повторов
    // оставлял бы здесь ~5 % кадров опаздывающими постоянно: контроллер
    // сходился к наименьшему значению, при котором серии редко длиннее допуска.
    const match = channelMatch({
      config: duelConfig({ tickRate: 60, snapshotRate: 30, inputDelay: 2, inputWindow: 30 }),
      profiles: [LAN, { name: 'edge-jitter', delaySteps: 7, jitterSteps: 2, lossPerMille: 0 }],
      input: () => WALK,
    });
    match.run(600);
    const client = match.clients[1]!.client;
    const settled = client.metrics.inputLead!;
    expect(settled).toBeGreaterThan(match.server.pacing.inputDelay);

    const late = match.server.metrics.slots[1]!.late;
    let lead = settled;
    let lowers = 0;
    let lastLower = -1;
    const probeCosts: number[] = [];
    let lateAtLower = late;
    for (let i = 0; i < 7200; i++) {
      match.step();
      const now = client.metrics.inputLead!;
      if (now < lead) {
        lowers++;
        lastLower = i;
        lateAtLower = match.server.metrics.slots[1]!.late;
      } else if (now > lead && lastLower >= 0) {
        probeCosts.push(match.server.metrics.slots[1]!.late - lateAtLower);
        lastLower = -1;
      }
      lead = now;
    }
    const dropped = match.server.metrics.slots[1]!.late - late;

    // Две минуты: потерянных кадров — доли процента, и все они — цена проб
    // спуска, а не постоянный фон.
    expect(dropped).toBeLessThan(0.01 * 7200);
    expect(lowers).toBeGreaterThan(0);
    // Неудачная проба обнаруживается первым же опозданием, а не сроком эха:
    // единицы тиков потерянного ввода, не десятки.
    for (const cost of probeCosts) expect(cost).toBeLessThanOrEqual(12);
    // Запас держится в полосе шириной в тик: значение и проба на тик ниже.
    expect(Math.abs(lead - settled)).toBeLessThanOrEqual(1);
  });

  it('запас публикуется в счётчиках клиента рядом с откликом (NTR-11)', () => {
    const match = tunnelMatch();
    match.run(12);
    // С первого же `Welcome`: «сколько сейчас запас» — вопрос, на который у
    // вошедшего в матч уже есть ответ.
    expect(match.clients[1]!.client.metrics.inputLead).toBe(2);

    match.run(120);
    const metrics = match.clients[1]!.client.metrics;
    expect(metrics.inputLead).toBeGreaterThan(2);
    // Рядом с ним — задержка «нажал → увидел»: обе величины про отклик, и
    // раздельно они отвечают, какую его долю даёт буфер задержки ввода.
    expect(metrics.inputToVisibleMs).toBeGreaterThan(0);
  });
});
