/**
 * Бот и перемотанный мир (`rewind` REW-1, WSM-1, SHELL-7, NTR-16).
 *
 * РЕГРЕССИЯ. Мозг видит только доставленные состояния своего клиента (BOT-3), а
 * доставка после перемотки идёт НАЗАД по номерам тиков — эпоха растёт, тик
 * уменьшается (NTR-16). Восприятие же отбрасывало наблюдение старше осознанного
 * («картинка назад не ходит»), и всё, что приходило после отката, отбрасывалось
 * до тех пор, пока мир не дотикает обратно: мозг оставался на СТЁРТОМ будущем.
 * Своё положение в нём тоже было стёртым, поэтому steering, ведомый разностью
 * «цель минус я», гнал бота в одну сторону всю глубину отката — до кромки арены
 * и за неё.
 *
 * Здесь пиннится обе половины лечения: пока мир не `Running`, бот ДЕРЖИТ (ввод
 * нулевой, кнопок нет), а на разрыве непрерывности бросает память и планы и
 * переоценивает мир по доставленному состоянию.
 *
 * Состояния берутся из НАСТОЯЩЕГО матча (`recordSteps`), а перемотка
 * собирается из них же — пересадкой мира раннего шага на поздний с признаком
 * разрыва: сервер матча в этой фикстуре ульту не кастует, а предмет теста —
 * реакция мозга на доставку, а не сама перемотка (её закрывают тесты ядра и
 * сети).
 */
import { describe, expect, it } from 'vitest';
import type { WorldMode } from '@game-mvp/core';
import type { ClientStep } from '@game-mvp/net';
import { Perception } from '../src/brains/classic/perception.js';
import { classicBrain } from '../src/brains/classic/classicBrain.js';
import { brainRandom } from '../src/brains/classic/random.js';
import { duelConfig, recordSteps, testProfile, STEP } from './fixtures.js';

const SELF = { playerId: 'bot-1', slot: 1, tickRate: 60 };
const random = (): ReturnType<typeof brainRandom> => brainRandom(7, 'test');

/**
 * Шаг клиента с подменённой парой (тик, режим) и признаком разрыва: ровно то,
 * что доставка кладёт мозгу на входе в перемотку и на выходе из неё.
 */
function branch(
  source: ClientStep,
  patch: { readonly tick: number; readonly mode: WorldMode; readonly discontinuity: boolean },
): ClientStep {
  const state = source.state;
  if (state === undefined) throw new Error('тест: у шага-источника нет состояния');
  const at = { ...state.to, tick: patch.tick, mode: patch.mode };
  return {
    state: { from: at, to: at, alpha: 0, lagMs: 0, discontinuity: patch.discontinuity },
    events: [],
  };
}

/** Человек уходит сперва на восток, затем на север: направление на него меняется. */
const WALK = (tick: number): { move: { x: number; y: number }; aimDir: number; buttons: number } =>
  tick <= 40
    ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 }
    : { move: { x: 0, y: STEP }, aimDir: 0, buttons: 0 };

interface Recorded {
  readonly early: ClientStep;
  readonly late: readonly ClientStep[];
  readonly earlyTick: number;
  readonly lateTick: number;
}

/** Матч на 80 тиков: ранний шаг (враг восточнее) и хвост поздних (враг севернее). */
async function recorded(): Promise<Recorded> {
  const run = await recordSteps(duelConfig(), 80, WALK);
  const withState = run.steps.filter((step) => step.state !== undefined);
  const early = withState[Math.floor(withState.length / 3)]!;
  const late = withState.slice(-6);
  return {
    early,
    late,
    earlyTick: early.state!.to.tick,
    lateTick: late[late.length - 1]!.state!.to.tick,
  };
}

describe('восприятие: перемотка стирает ветвь, а не только тики', () => {
  it('осознанная картинка идёт за откатившимся тиком, а не застревает в будущем', async () => {
    const { early, late, earlyTick, lateTick } = await recorded();
    expect(earlyTick).toBeLessThan(lateTick);

    const perception = new Perception(testProfile(), SELF, random());
    for (const step of late) perception.observe(step);
    const before = perception.perceive(lateTick);
    expect(before?.observedTick).toBe(lateTick);
    expect(perception.mode).toBe('Running');

    // Вход в перемотку: мир раннего тика, эпоха выросла, разрыв взведён.
    perception.observe(branch(early, { tick: earlyTick, mode: 'Rewinding', discontinuity: true }));
    expect(perception.mode).toBe('Rewinding');
    expect(perception.takeDiscontinuity()).toBe(true);
    // Признак гасится чтением — второго потребителя у него не бывает.
    expect(perception.takeDiscontinuity()).toBe(false);

    // Возобновление на откатившемся тике.
    perception.observe(branch(early, { tick: earlyTick, mode: 'Running', discontinuity: true }));
    expect(perception.mode).toBe('Running');
    expect(perception.takeDiscontinuity()).toBe(true);

    const after = perception.perceive(earlyTick);
    // Вот оно: картинка мозга — про откатившийся мир. До лечения `observedTick`
    // оставался равен `lateTick` до тех пор, пока мир не дотикает обратно.
    expect(after?.observedTick).toBe(earlyTick);
    // И буфер наблюдений пуст: доперемоточные шаги, ещё не отданные решению,
    // адресованы стёртой ветви и доехать до неё уже не должны.
    expect(before!.observedTick).not.toBe(after!.observedTick);
  });

  it('память о враге переезжает на его положение в откатившейся ветви', async () => {
    const { early, late, earlyTick, lateTick } = await recorded();
    const perception = new Perception(testProfile(), SELF, random());
    for (const step of late) perception.observe(step);
    const stale = perception.perceive(lateTick)!.enemies[0];
    expect(stale).toBeDefined();

    perception.observe(branch(early, { tick: earlyTick, mode: 'Rewinding', discontinuity: true }));
    perception.observe(branch(early, { tick: earlyTick, mode: 'Running', discontinuity: true }));
    const fresh = perception.perceive(earlyTick)!.enemies[0]!;

    // Человек шёл на север всю вторую половину прогона, и координата, по которой
    // бот пошёл бы преследовать, у стёртой ветви ДРУГАЯ. Помнить её — значит
    // идти в место, где противника не было и не будет.
    expect(fresh.y).toBeLessThan(stale!.y);
    expect(fresh.seenTick).toBe(earlyTick);
    expect(fresh.visible).toBe(true);
  });

  it('пауза и возобновление памяти НЕ стоят: ветвь та же', async () => {
    // Страховка по смене режима узкая: ветвь истории стирает перемотка, а не
    // всякая смена режима (WSM-1). Пауза оставляет мир там же, где он был, и
    // сброс памяти на ней означал бы, что игрок, поставивший паузу, дарит боту
    // амнезию: противник, стоящий на виду, забывается и переоценивается заново.
    // Задержка реакции ненулевая: она и делает проверку честной. Состояния,
    // приехавшие ВМЕСТЕ со сменой режима, к моменту съёма ещё не осознаны, и
    // сброс памяти нечем было бы прикрыть — бот остался бы слепым.
    const { late, lateTick } = await recorded();
    const DELAY = 6;
    const at = lateTick + DELAY;
    const perception = new Perception(
      testProfile({ reaction: { delayTicks: DELAY, jitterTicks: 0, memoryTicks: 120 } }),
      SELF,
      random(),
    );
    for (const step of late) perception.observe(step);
    const known = perception.perceive(at)!.enemies[0];
    expect(known).toBeDefined();

    const last = late[late.length - 1]!;
    const paused = { tick: lateTick + 1, mode: 'Paused' as const, discontinuity: false };
    perception.observe(branch(last, paused));
    expect(perception.mode).toBe('Paused');
    expect(perception.takeDiscontinuity()).toBe(false);
    perception.observe(branch(last, { ...paused, mode: 'Running' }));
    expect(perception.mode).toBe('Running');
    expect(perception.takeDiscontinuity()).toBe(false);

    // Возобновление — и бот сразу при деле: врага он помнит там же, где видел,
    // а не переоценивает мир с нуля. Сброс памяти дал бы здесь `undefined` —
    // осознанной картинки не осталось бы вовсе.
    const after = perception.perceive(at)!.enemies[0]!;
    expect(after).toEqual(known);
  });
});

describe('мозг: замерший мир и разрыв непрерывности', () => {
  /**
   * Идущий бот: дальность способности короче дистанции до человека, поэтому
   * выигрывает «давить» — цель steering'а стоит на противнике, и мозг отдаёт
   * ненулевое движение. Шум прицела ненулевой намеренно: держание обязано
   * повторить последний ОТДАННЫЙ прицел вместе с шумом, и на чистой базе
   * микро-слоя равенство прицелов было бы совпадением нулей.
   */
  const walkingProfile = (): ReturnType<typeof testProfile> =>
    testProfile({
      ability: { button: 0, cooldownTicks: 30, range: 2 },
      aim: { noiseDegrees: 5, noisePeriodTicks: 10 },
    });

  it('в `Rewinding` идущий бот встаёт: движение — ноль, прицел — прежний', async () => {
    const { early, late, lateTick } = await recorded();
    const brain = classicBrain()(walkingProfile(), SELF);
    for (const step of late) brain.observe(step);
    const playing = brain.sample(lateTick)!;
    // Контроль: в живом мире бот ИДЁТ — иначе «нулевое движение в замершем
    // мире» выполнялось бы само собой и лечение не пиннилось бы вовсе.
    expect(Math.hypot(playing.moveX, playing.moveY)).toBeGreaterThan(0);
    // И шум в отданном прицеле есть: равенство ниже — про повтор, а не про ноль.
    expect(playing.aimRadians).not.toBe(0);

    brain.observe(branch(early, { tick: 12, mode: 'Rewinding', discontinuity: true }));
    for (let tick = 12; tick < 20; tick++) {
      const held = brain.sample(tick)!;
      expect(held.moveX).toBe(0);
      expect(held.moveY).toBe(0);
      expect(held.buttons).toBe(0);
      // Прицел не мечется: держание — это стоять, а не крутиться. И повторяется
      // именно ОТДАННОЕ число: подставь базу без шума — прицел дёрнулся бы на
      // всю амплитуду ровно в тот кадр, в который мир замер.
      expect(held.aimRadians).toBe(playing.aimRadians);
    }
  });

  it('в `Rewinding` бьющий бот не жмёт: кнопок нет', async () => {
    // Вторая половина держания — своей геометрией: враг в дальности, выигрывает
    // «бить», и в живом мире бот жмёт способность. Без этого контроля «кнопок
    // нет» выполнялось бы у любого бота, которому нечем стрелять.
    const { early, late, lateTick } = await recorded();
    const brain = classicBrain()(testProfile(), SELF);
    for (const step of late) brain.observe(step);
    const playing = brain.sample(lateTick)!;
    expect(playing.buttons).not.toBe(0);

    brain.observe(branch(early, { tick: 12, mode: 'Rewinding', discontinuity: true }));
    for (let tick = 12; tick < 20; tick++) {
      const held = brain.sample(tick)!;
      expect(held.buttons).toBe(0);
      expect(held.moveX).toBe(0);
      expect(held.moveY).toBe(0);
    }
  });

  it('после возобновления бот целится в ДОСТАВЛЕННОГО врага, а не в стёртого', async () => {
    const { early, late, earlyTick, lateTick } = await recorded();
    // Интервал передумывания заведомо длиннее прогона: без сброса срока слой
    // решений держал бы поведение стёртой ветви, а `nextDecisionTick` остался
    // бы в будущем, недостижимом для откатившихся номеров тиков.
    const profile = testProfile({ decision: { intervalTicks: 500, jitterTicks: 0 } });
    const brain = classicBrain()(profile, SELF);
    for (const step of late) brain.observe(step);
    const stale = brain.sample(lateTick)!;

    brain.observe(branch(early, { tick: earlyTick, mode: 'Rewinding', discontinuity: true }));
    brain.sample(earlyTick);
    brain.observe(branch(early, { tick: earlyTick, mode: 'Running', discontinuity: true }));
    const fresh = brain.sample(earlyTick)!;

    // Прицел мозга — направление на ближайшего известного врага; в откатившейся
    // ветви оно другое, и первый же тик после возобновления обязан это показать.
    expect(fresh.aimRadians).not.toBe(stale.aimRadians);
    expect(Math.abs(fresh.aimRadians)).toBeLessThan(Math.abs(stale.aimRadians));
  });
});
