/**
 * Заменимость мозга (BOT-2): одна сборка бот-хоста, две реализации за
 * контрактом — различие исчерпывается фабрикой.
 *
 * Это и есть проверяемая форма утверждения «замена мозга — замена сборки»: если
 * бы хостинг знал про реализацию, тест не собрался бы дважды одним и тем же
 * кодом.
 */
import { describe, expect, it } from 'vitest';
import type { BotBrainFactory } from '../src/brain.js';
import { BotHost } from '../src/host.js';
import { evaluatedBrain } from '../src/brains/evaluated/evaluatedBrain.js';
import { walkToCenter } from '../src/brains/scripted.js';
import { brainFactoryByKind, BRAIN_KINDS } from '../src/brains/registry.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  settle,
  stepMatch,
  testBehavior,
  testProfile,
} from './fixtures.js';

/** Одна и та же сборка на любой мозг: меняется только переданная фабрика. */
async function playWith(brain: BotBrainFactory, ticks = 40): Promise<{
  readonly slot: number | undefined;
  readonly phase: string;
  readonly inputs: number;
  readonly frames: readonly { readonly playerId: string; readonly buttons: number }[];
}> {
  const fixture = harness(duelConfig());
  const human = connectHuman(fixture, 'p1');
  const bots = new BotHost();
  const seat = connectBot(fixture, bots, { playerId: 'bot-1', brain, profile: testProfile() });
  await settle();
  for (let i = 0; i < ticks; i++) await stepMatch(fixture, [human.host, seat]);
  const result = {
    slot: seat.client.slot,
    phase: seat.client.phase,
    inputs: seat.client.metrics.inputsSent,
    frames: (fixture.server.toScenario().inputs ?? []).filter((f) => f.playerId === 'bot-1'),
  };
  bots.dispose();
  return result;
}

describe('замена реализации мозга — замена сборки (BOT-2)', () => {
  it('скриптовый и evaluated входят в матч одинаково', async () => {
    const scripted = await playWith(walkToCenter);
    const evaluated = await playWith(evaluatedBrain({ behavior: testBehavior() }));

    for (const played of [scripted, evaluated]) {
      expect(played.slot).toBe(1);
      expect(played.phase).toBe('playing');
      expect(played.inputs).toBeGreaterThan(0);
      expect(played.frames.length).toBeGreaterThan(0);
    }
    // Мозги разные — и ввод разный: сборка одна, поведение своё у каждого.
    expect(JSON.stringify(evaluated.frames)).not.toBe(JSON.stringify(scripted.frames));
  });

  it('скриптовый мозг воспроизводим: два прогона — один поток ввода', async () => {
    const first = await playWith(walkToCenter, 30);
    const second = await playWith(walkToCenter, 30);
    expect(JSON.stringify(second.frames)).toBe(JSON.stringify(first.frames));
  });

  it('реестр разворачивает имя мозга в фабрику — так его выбирает воркер', () => {
    const assembly = { center: { x: 0, y: 0 }, behavior: testBehavior() };
    for (const kind of BRAIN_KINDS) {
      expect(typeof brainFactoryByKind(kind, assembly)).toBe('function');
    }
    expect(() =>
      brainFactoryByKind('ml' as (typeof BRAIN_KINDS)[number], assembly),
    ).toThrow(/неизвестный мозг/);
  });

  /**
   * Мозг без документа поведения не конструируется вовсе (BOT-8): политика
   * выбора действий приезжает документом, и молчаливое умолчание означало бы
   * ту самую политику в коде, которую документ отменяет.
   */
  it('evaluated без документа поведения отвергается сборкой (BOT-8)', () => {
    expect(() => brainFactoryByKind('evaluated', { center: { x: 0, y: 0 } })).toThrow(
      /документ поведения/,
    );
  });
});
