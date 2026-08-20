/**
 * Общие слои мозга (BOT-2): восприятие с памятью и задержкой реакции, геометрия
 * исполнителей и микро-слой на Yuka.
 *
 * Слои общие для любой реализации контракта — политику выбора действий они не
 * содержат вовсе (она в документе, BOT-8), и потому проверяются отдельно от
 * мозга, который их склеивает.
 *
 * Восприятие проверяется на НАСТОЯЩЕМ потоке наблюдений — шагах клиента,
 * записанных в loopback-матче: синтетический снапшот проверял бы разбор
 * фикстуры, а не границу BOT-3. Геометрия и микро — на литеральных мирах: они
 * уже за границей, работают с float и никакого снапшота не касаются.
 */
import { describe, expect, it } from 'vitest';
import { Perception, type PerceivedWorld } from '../src/brains/layers/perception.js';
import { MicroLayer } from '../src/brains/layers/micro.js';
import { planFor } from '../src/brains/layers/plan.js';
import { brainRandom } from '../src/brains/layers/random.js';
import type { BotProfile } from '../src/profile.js';
import {
  STEP,
  boltConfig,
  duelConfig,
  fogConfig,
  recordSteps,
  testProfile,
} from './fixtures.js';

const SELF = { playerId: 'bot-1', slot: 1, tickRate: 60 };
const random = () => brainRandom(7, 'test');

function world(overrides: Partial<PerceivedWorld> = {}): PerceivedWorld {
  return {
    tick: 100,
    observedTick: 100,
    self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
    slots: [],
    enemies: [],
    threats: [],
    arenaRadius: 20,
    carrying: false,
    ...overrides,
  };
}

function enemyAt(x: number, y: number, visible = true): PerceivedWorld['enemies'][number] {
  return { id: 2, x, y, vx: 0, vy: 0, slot: 0, team: 0, seenTick: 100, visible };
}

describe('восприятие: задержка реакции (BOT-6)', () => {
  it('наблюдение доезжает до решения не раньше, чем велит профиль', async () => {
    const recorded = await recordSteps(duelConfig(), 40);
    const profile = testProfile({
      reaction: { delayTicks: 10, jitterTicks: 0, memoryTicks: 120 },
    });
    const perception = new Perception(profile, SELF, random());

    let firstAware = -1;
    let lastLag = 0;
    for (const [index, step] of recorded.steps.entries()) {
      perception.observe(step);
      const view = step.state;
      if (view === undefined) continue;
      const perceived = perception.perceive(view.to.tick);
      if (perceived === undefined) continue;
      if (firstAware === -1) firstAware = index;
      lastLag = view.to.tick - perceived.observedTick;
    }

    expect(firstAware).toBeGreaterThanOrEqual(10);
    // Картинка мозга отстаёт ровно на задержку реакции — то самое, без чего бот
    // играет по точным координатам снапшота и потому сверхчеловечен.
    expect(lastLag).toBeGreaterThanOrEqual(10);
  });

  it('нулевая задержка не задерживает: профиль умеет выразить и это', async () => {
    const recorded = await recordSteps(duelConfig(), 20);
    const perception = new Perception(testProfile(), SELF, random());
    let aware = 0;
    for (const step of recorded.steps) {
      perception.observe(step);
      const tick = step.state?.to.tick;
      if (tick !== undefined && perception.perceive(tick) !== undefined) aware++;
    }
    expect(aware).toBeGreaterThan(0);
  });
});

describe('восприятие: память под туманом войны (BOT-3)', () => {
  it('ушедший в туман враг остаётся последним виденным, а не актуальным', async () => {
    // Обзор шире стартовой дистанции: враг сперва виден. Человек уходит ВЛЕВО,
    // то есть прочь от бота (тот стоит правее), — дистанция растёт, и слот бота
    // теряет его из виду.
    const recorded = await recordSteps(fogConfig({}, 4), 80, (tick) =>
      tick <= 80 ? { move: { x: -STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined,
    );
    const profile = testProfile({ reaction: { delayTicks: 0, jitterTicks: 0, memoryTicks: 600 } });
    const perception = new Perception(profile, SELF, random());

    let sawVisible = false;
    let rememberedX: number | undefined;
    let lastSeenTick = -1;
    for (const step of recorded.steps) {
      perception.observe(step);
      const tick = step.state?.to.tick;
      if (tick === undefined) continue;
      const perceived = perception.perceive(tick);
      const enemy = perceived?.enemies[0];
      if (enemy === undefined) continue;
      if (enemy.visible) {
        sawVisible = true;
        continue;
      }
      rememberedX = enemy.x;
      lastSeenTick = enemy.seenTick;
    }

    expect(sawVisible).toBe(true);
    // Враг пропал из персонального снапшота, но помнится — с меткой тика, когда
    // виделся: знать актуальное положение мозг не может (BOT-3).
    expect(rememberedX).toBeDefined();
    expect(lastSeenTick).toBeGreaterThan(0);
    const authoritative = recorded.fixture.server.snapshot();
    expect(authoritative.tick).toBeGreaterThan(lastSeenTick);
  });

  it('горизонт памяти из профиля забывает пропавшего', async () => {
    // Человек уходит ВЛЕВО, то есть прочь от бота (он стоит правее): дистанция
    // растёт, и слот бота теряет его из виду.
    const recorded = await recordSteps(fogConfig({}, 4), 80, (tick) =>
      tick <= 80 ? { move: { x: -STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined,
    );
    const profile = testProfile({ reaction: { delayTicks: 0, jitterTicks: 0, memoryTicks: 5 } });
    const perception = new Perception(profile, SELF, random());
    let lastCount = 0;
    for (const step of recorded.steps) {
      perception.observe(step);
      const tick = step.state?.to.tick;
      if (tick === undefined) continue;
      lastCount = perception.perceive(tick)?.enemies.length ?? lastCount;
    }
    expect(lastCount).toBe(0);
  });
});

describe('восприятие: экстраполяция проджектайлов (задача 3.1)', () => {
  it('летящий снаряд без слота игрока опознан угрозой и сближением', async () => {
    const recorded = await recordSteps(boltConfig(0.1), 40);
    const profile = testProfile({ reaction: { delayTicks: 6, jitterTicks: 0, memoryTicks: 120 } });
    const perception = new Perception(profile, SELF, random());
    const threats: number[] = [];
    let closing = false;
    for (const step of recorded.steps) {
      perception.observe(step);
      const tick = step.state?.to.tick;
      if (tick === undefined) continue;
      const perceived = perception.perceive(tick);
      const threat = perceived?.threats[0];
      if (threat === undefined) continue;
      threats.push(threat.x);
      closing ||= threat.closing;
    }
    expect(threats.length).toBeGreaterThan(0);
    // Экстраполяция: положение снаряда сдвинуто вперёд по его скорости — это
    // предсказание полёта, а не знание о невидимом (BOT-3).
    expect(threats[threats.length - 1]!).toBeGreaterThan(threats[0]!);
    expect(closing).toBe(true);
  });
});

describe('план поведения: геометрия цели', () => {
  const profile = testProfile();
  const center = { x: 0, y: 0 };

  it('отступление ведёт в центр арены', () => {
    const plan = planFor('retreat', world(), profile, center);
    expect(plan.targetX).toBe(0);
    expect(plan.targetY).toBe(0);
  });

  it('давление ведёт к врагу — до дистанции боя, кайт — от него', () => {
    // Дистанция боя профиля — 8: с пятнадцати бот подходит на восемь, а не в
    // упор. Идти к ногам противника значит лишить себя и уклонения, и разлёта
    // собственных снарядов.
    const far = world({ enemies: [enemyAt(15, 0)] });
    expect(planFor('pressure', far, profile, center).targetX).toBeCloseTo(7, 5);
    // Уже на дистанции боя — стоять и кружить (стрейф микро-слоя), а не пятиться.
    const at = world({ enemies: [enemyAt(3, 0)] });
    expect(planFor('pressure', at, profile, center).targetX).toBeCloseTo(0, 5);
    expect(planFor('kite', at, profile, center).targetX).toBeLessThan(0);
  });

  it('уклонение уходит вбок от линии полёта снаряда', () => {
    const incoming = world({
      threats: [{ id: 3, x: -2, y: 0, vx: 1, vy: 0, distance: 2, closing: true }],
    });
    const plan = planFor('dodge', incoming, profile, center);
    expect(Math.abs(plan.targetY)).toBeGreaterThan(0);
    expect(plan.targetX).toBeCloseTo(0, 5);
  });

  it('цель не выходит за арену с запасом из профиля («не стоять у края»)', () => {
    const far = world({ enemies: [enemyAt(40, 0)] });
    const plan = planFor('pressure', far, profile, center);
    expect(Math.hypot(plan.targetX, plan.targetY)).toBeLessThanOrEqual(
      20 - profile.movement.edgeMargin + 1e-6,
    );
  });
});

describe('микро-слой на Yuka (задача 3.3)', () => {
  const options = { tickSeconds: 1 / 60 };

  function micro(profile: BotProfile): MicroLayer {
    return new MicroLayer(profile, random(), options);
  }

  it('steering ведёт в сторону цели поведения', () => {
    const layer = micro(testProfile());
    const scene = world({ enemies: [enemyAt(15, 0)] });
    const plan = planFor('pressure', scene, testProfile(), { x: 0, y: 0 });
    let intent = layer.step(plan, scene, 0);
    for (let tick = 1; tick < 5; tick++) intent = layer.step(plan, scene, tick);
    expect(intent.moveX).toBeGreaterThan(0);
    expect(Math.abs(intent.moveY)).toBeLessThan(1e-6);
  });

  it('длина намерения не выходит за долю хода из профиля (INP-3)', () => {
    const profile = testProfile({
      movement: {
        maxSpeed: 0.5,
        arriveTolerance: 0.25,
        edgeMargin: 2,
        engageRange: 8,
        strafe: 0,
        strafePeriodTicks: 30,
      },
    });
    const layer = micro(profile);
    const scene = world({ enemies: [enemyAt(9, 0)] });
    const plan = planFor('pressure', scene, profile, { x: 0, y: 0 });
    let intent = layer.step(plan, scene, 0);
    for (let tick = 1; tick < 20; tick++) intent = layer.step(plan, scene, tick);
    expect(Math.hypot(intent.moveX, intent.moveY)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('нулевой шум прицела даёт точный угол, ненулевой — в пределах амплитуды', () => {
    const exact = micro(testProfile());
    const scene = world({ enemies: [enemyAt(0, 5)] });
    const plan = planFor('pressure', scene, testProfile(), { x: 0, y: 0 });
    expect(exact.step(plan, scene, 0).aimRadians).toBeCloseTo(Math.PI / 2, 6);

    const noisy = micro(
      testProfile({ aim: { noiseDegrees: 30, noisePeriodTicks: 10 } }),
    );
    const first = noisy.step(plan, scene, 0).aimRadians;
    expect(first).not.toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(first - Math.PI / 2)).toBeLessThanOrEqual((30 * Math.PI) / 180);
    // Ошибка держится период из профиля: человек промахивается «в сторону», а
    // не дрожит каждый тик.
    expect(noisy.step(plan, scene, 5).aimRadians).toBeCloseTo(first, 9);
    expect(noisy.step(plan, scene, 11).aimRadians).not.toBeCloseTo(first, 9);
  });

  it('шум не накапливается: стоящий без цели бот не проворачивается вокруг себя', () => {
    const profile = testProfile({ aim: { noiseDegrees: 30, noisePeriodTicks: 3 } });
    const layer = micro(profile);
    // Ни врага, ни движения: цель — там, где бот стоит. Прицел обязан дрожать
    // вокруг одного направления, а не уходить случайным блужданием.
    const scene = world();
    const plan = planFor('retreat', scene, profile, { x: 0, y: 0 });
    const limit = (30 * Math.PI) / 180 + 1e-9;
    let maxDrift = 0;
    for (let tick = 0; tick < 200; tick++) {
      maxDrift = Math.max(maxDrift, Math.abs(layer.step(plan, scene, tick).aimRadians));
    }
    expect(maxDrift).toBeLessThanOrEqual(limit);
  });
});
