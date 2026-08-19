/**
 * Воспроизводимость трейса матча (DIAG-9) поверх готовой парности записи и
 * прогона (NTR-8, `transportParity.test.ts`).
 *
 * Утверждение, которое здесь доказывается: трейс живого матча можно ПЕРЕСНЯТЬ.
 * Матч отыгрывается под трейсом, его запись прогоняется `runScenario` на том же
 * уровне и с тем же отбором, и строки обязаны совпасть построчно — с точностью
 * до строк-отметок хоста, которых у прогонщика сценария нет и быть не может.
 * Без автоматической проверки это утверждение остаётся обещанием: разъехаться
 * трейсы могут молча, на первой же правке порядка съёма.
 *
 * Почему в интеграционной суите (CLI-9): проверка сводит вместе хост матча
 * (net) и прогонщик сценария (ядро), и собирается она из публичных поверхностей
 * пакетов — как это делает запускалка, а не тест пакета.
 *
 * Второй предмет — отметки ветви на матче с ПЕРЕМОТКОЙ (NTR-16, REW-4): один
 * номер тика исполняется дважды, и журнал по такому трейсу обязан различать
 * проходы. Журнал здесь собирается настоящей командой (`bin/journal.mjs`,
 * CLI-12) в подпроцессе — тем же путём, каким его соберёт человек.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createJsonlSink,
  parseTraceSelect,
  runScenario,
  selectingSink,
  type SceneDef,
} from '@game-mvp/core';
import { createMatchTrace, type MatchConfig, type TraceSelect } from '@game-mvp/net';
import { STEP, TICK_RATE, connectClient, duelConfig, duelScene, harness, settle } from './fixtures.js';

const TICKS = 16;
const REWIND_TO = 6;
const TICKS_AFTER = 4;
/** Бит, по удержанию которого сцена ниже публикует событие. */
const DEATH_BUTTON = 0;

const CORE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core-ts', 'bin');
const JOURNAL_CLI = join(CORE_BIN, 'journal.mjs');
const SIM_CLI = join(CORE_BIN, 'sim.mjs');

/**
 * Дуэль плюс событие на КАЖДОМ тике удержания кнопки — не по фронту.
 *
 * Не по фронту намеренно: переигранный реплеем участок обязан содержать
 * события, иначе различать ветви было бы не на чем. Имя `Died` выбрано под
 * вопрос, ради которого отметки и заводятся: показывает ли журнал одну смерть
 * дважды.
 */
function deathScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Death',
        order: 90,
        query: { all: ['Input', 'Player'] },
        as: 'e',
        do: [
          {
            if: {
              cond: { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'buttons'] }, DEATH_BUTTON] },
              then: [
                {
                  emitEvent: {
                    type: 'Died',
                    data: {
                      entity: { var: 'e' },
                      slot: { getComponent: [{ var: 'e' }, 'Player', 'slot'] },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Ввод, не зависящий от номера тика: кнопка удержана, движение постоянное. */
const holdDeath = (): { move: { x: number; y: number }; aimDir: number; buttons: number } => ({
  move: { x: STEP, y: 0 },
  aimDir: 0,
  buttons: 1 << DEATH_BUTTON,
});

interface Traced {
  readonly lines: readonly string[];
  readonly config: MatchConfig;
  readonly server: ReturnType<typeof harness>['server'];
}

/**
 * Матч под трейсом на loopback. Клиенты настоящие: предмет проверки — трейс
 * АВТОРИТЕТНОЙ симуляции (DIAG-8, NET-1), и порождать ввод должен тот, кто
 * порождает его в бою.
 */
async function playTraced(
  level: 'systems' | 'full',
  select: TraceSelect | undefined,
  ticks: number,
  overrides: Partial<MatchConfig> = {},
): Promise<Traced> {
  const lines: string[] = [];
  const scene = deathScene();
  const config = duelConfig({
    scene,
    trace: createMatchTrace(level, select, (line) => void lines.push(line)),
    ...overrides,
  });
  const fixture = harness(config);
  const build = { physics: config.physics!, visibility: config.visibility! };
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, holdDeath, build);
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, holdDeath, build);
  await settle();

  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
  }
  return { lines, config, server: fixture.server };
}

/** Строки-отметки хоста (DIAG-9) отличаются полем-признаком, а не содержимым. */
const isMark = (line: string): boolean => 'mark' in (JSON.parse(line) as Record<string, unknown>);

describe('DIAG-9: живой матч и реплей его записи', () => {
  it('строки совпадают построчно, если отбросить отметки хоста', async () => {
    const match = await playTraced('full', undefined, TICKS);

    // Запись матча — то, что кладётся рядом с трейсом (CLI-11): без неё
    // переснять его нечем, ввод порождают клиенты, а не seed.
    const replayed: string[] = [];
    runScenario(match.server.toScenario(), createJsonlSink('full', (line) => void replayed.push(line)));

    const live = match.lines.filter((line) => !isMark(line));
    // Контроль: трейс не пуст и отметки в нём БЫЛИ — иначе «с точностью до
    // отметок» проверяло бы пустое множество.
    expect(live.length).toBeGreaterThan(0);
    expect(match.lines.length).toBeGreaterThan(live.length);

    expect(live).toEqual(replayed);
  });

  it('тот же отбор на записи даёт тот же файл', async () => {
    // «Тот же отбор» — буквально та же функция, а не второе похожее условие:
    // строка флага разбирается общим для обеих команд `parseTraceSelect`
    // (`--trace-select=event`), а применяет её обёртка ядра `selectingSink` —
    // та самая, которой отбирают и хост матча, и прогон сценария (DIAG-9).
    // Отбор, собранный в тесте руками, проверял бы соседнюю функцию: у него, в
    // частности, не было бы пропуска записей о нарушенных инвариантах (FP-4).
    const onlyEvents: TraceSelect = parseTraceSelect('event')!;
    const match = await playTraced('full', onlyEvents, TICKS);

    const replayed: string[] = [];
    runScenario(
      match.server.toScenario(),
      selectingSink(createJsonlSink('full', (line) => void replayed.push(line)), onlyEvents),
    );

    const live = match.lines.filter((line) => !isMark(line));
    expect(live.length).toBeGreaterThan(0);
    expect(live).toEqual(replayed);
  });

  it('тот же отбор переснимает трейс НАСТОЯЩЕЙ командой прогона сценария (CLI-11)', async () => {
    // Утверждение CLI-11 «трейс переснимается записью» проверяется тем путём,
    // которым его пройдёт человек: файл записи плюс `bin/sim.mjs` с теми же
    // флагами. Без этого «тот же отбор» держалось бы на том, что тест и
    // запускалка зовут одну функцию, — а у команды сценария флага отбора могло
    // бы не быть вовсе.
    const dir = mkdtempSync(join(tmpdir(), 'trace-reshoot-'));
    try {
      const match = await playTraced('full', parseTraceSelect('event'), TICKS);
      const scenarioPath = join(dir, 'match.scenario.json');
      writeFileSync(scenarioPath, JSON.stringify(match.server.toScenario()));
      const run = spawnSync(
        process.execPath,
        [SIM_CLI, scenarioPath, '--trace=full', '--trace-select=event'],
        { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
      );
      expect(run.status, run.stderr.slice(0, 400)).toBe(0);

      const live = match.lines.filter((line) => !isMark(line));
      expect(live.length).toBeGreaterThan(0);
      expect(run.stderr).toBe(live.join(''));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DIAG-9: перемотка переисполнила тик', () => {
  let dir: string;
  let traced: Traced;
  let journal: { tick: number; seq: number; kind: string; type: string; branch?: string }[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trace-parity-'));
    // Интервал крупнее шага отката: ближайший снапшот лежит ПОЗАДИ цели, и
    // `seekTo` действительно доигрывает вперёд реплеевыми тиками (REW-2).
    traced = await playTraced('full', undefined, TICKS, { rewind: { interval: 4, capacity: 64 } });
    traced.server.pause();
    traced.server.beginRewind();
    traced.server.seekTo(REWIND_TO);
    traced.server.pause();
    traced.server.resume();
    for (let i = 0; i < TICKS_AFTER; i++) {
      traced.server.advance();
      traced.server.drain();
    }

    const tracePath = join(dir, 'trace.jsonl');
    writeFileSync(tracePath, traced.lines.join(''));
    writeFileSync(
      join(dir, 'dict.json'),
      JSON.stringify({ events: { Died: { kind: 'death', target: 'entity' } } }),
    );
    // Журнал собирается ТОЙ САМОЙ командой (CLI-12), а не повторной сборкой в
    // тесте: проверяется путь, которым журнал получает человек.
    const run = spawnSync(process.execPath, [JOURNAL_CLI, tracePath, '--dict', join(dir, 'dict.json')], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(run.status, run.stderr).toBe(0);
    journal = run.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as (typeof journal)[number]);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('матч действительно распался на эпохи и переиграл тики', () => {
    expect(traced.server.epoch).toBe(1);
    expect(traced.server.canonicalSegments.map((segment) => segment.epoch)).toEqual([0, 1]);
    const marks = traced.lines
      .filter(isMark)
      .map((line) => JSON.parse(line) as { mark: string; epoch: number; tick: number });
    expect(marks.some((mark) => mark.mark === 'replayBegin')).toBe(true);
    expect(marks.some((mark) => mark.mark === 'replayEnd')).toBe(true);
    // Живые тики новой эпохи отмечены ЕЮ: номер тика повторяется, ветвь — нет.
    expect(marks.some((mark) => mark.mark === 'live' && mark.epoch === 1)).toBe(true);
  });

  it('каждая группа записей отнесена по отметкам к своей ветви', () => {
    const branches = new Set(journal.map((entry) => entry.branch));
    expect(branches).toEqual(new Set(['0', '0:replay', '1']));
    // Тик, исполненный в двух эпохах, и переигранный проход различимы: у одного
    // номера тика в журнале три ветви, а не одна каша.
    const atRewound = journal.filter((entry) => entry.tick === REWIND_TO);
    expect(new Set(atRewound.map((entry) => entry.branch))).toEqual(new Set(['0', '0:replay']));
  });

  it('журнал не показывает одну смерть дважды: в живой ветви она одна', () => {
    const live = journal.filter((entry) => entry.branch === '0' && entry.tick === REWIND_TO);
    // По одной смерти на слот — ровно столько, сколько их было в этой ветви.
    expect(live).toHaveLength(traced.config.players.length);
    for (const entry of live) expect(entry.kind).toBe('death');
    // Переигранный проход рядом, но он назван своей ветвью — и суммировать его
    // с живым читателю не придётся.
    expect(journal.filter((entry) => entry.branch === '0:replay' && entry.tick === REWIND_TO)).toHaveLength(
      traced.config.players.length,
    );
  });
});
