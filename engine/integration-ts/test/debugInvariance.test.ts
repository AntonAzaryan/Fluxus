/**
 * Инварианты отладочного режима рендера (`render-debug` RDBG-5, RDBG-8) на
 * ЖИВОЙ нагрузке: записанный матч (CLI-10) прогоняется дважды — со всеми
 * включёнными отладочными источниками и без единого, — и сверяется побитово.
 *
 * ## Почему именно так, а не «гейт прогоняется с выключенной отладкой»
 *
 * Формулировка «мы её не включаем» держится на том, что никто не забыл выключить
 * галочку в чужой сборке (RDBG-8, design D8). Сильная проверяется одним тестом:
 * два прогона одной записи, и если счётчики стоимости совпали побитово, эталоны
 * `*.cost.json` (PERF-4) от отладки не поедут ни при какой сборке.
 *
 * Нагрузка и стенд — те же, что у голден-гейта стоимости (`benchLoad.ts`): у
 * RDBG-8 и PERF-4 обязана быть ОДНА нагрузка, иначе «эталон не дрогнет»
 * доказывалось бы на другом мире. Подсистем на стенде пять, отладочных
 * источников — все, что объявили подсистемы (маска, поверхность, инстансы) плюс
 * источники сборки (доставка, читатель счётчиков).
 *
 * ## И симуляция ничего не заметила (RDBG-5)
 *
 * Тот же прогон сверяется каноническим логом симуляции: отладочный слой —
 * наблюдатель (REND-1), обратного канала в мир у него нет, и мир обязан пройти
 * тик в тик тот же путь. Расхождение здесь означало бы, что отладка попала в
 * симуляцию, — дефект реализации, а не повод регенерировать эталон.
 */
import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  jsonSerializer,
  prettyJsonSerializer,
  snapshotToPlain,
  takeSnapshot,
  type PlainSnapshot,
} from '@game-mvp/core';
import {
  createCostCounters,
  withCostSink,
  type RenderCostCounters,
  type TickView,
} from '@game-mvp/render';
import {
  BENCH_PRESETS,
  RECORDED_MATCHES,
  loadRecording,
  matchBench,
  playRecording,
} from './benchLoad.js';

const decoder = new TextDecoder();

/** Итог одного прогона записи: картина мира, картина доставки и стоимость. */
interface DebugRun {
  readonly log: string;
  readonly digests: readonly number[];
  readonly delivered: readonly string[];
  readonly render: RenderCostCounters;
  /** Секции дампа последнего кадра; пусто — отладка была выключена (RDBG-7). */
  readonly sections: readonly string[];
  /** Кадров, на которых отладочный слой действительно работал. */
  readonly debugFrames: number;
}

/** Состав доставки одной строкой: тик и его сущности по возрастанию ID. */
function composition(view: TickView): string {
  return `${view.tick}: ${[...view.entities.keys()].sort((a, b) => a - b).join(',')}`;
}

/**
 * Прогон записи с презентационным трактом; `debug` включает отладочный слой со
 * ВСЕМИ источниками. Стенд собирается ВНУТРИ замера: сток счётчиков к этому
 * моменту уже подключён, и источник стоимости остаётся его читателем, а не
 * подменяет сток своим (design D8).
 */
function playUnder(match: string, debug: boolean): DebugRun {
  const records: PlainSnapshot[] = [];
  const digests: number[] = [];
  const delivered: string[] = [];
  const counters = createCostCounters();
  let sections: readonly string[] = [];
  let debugFrames = 0;
  withCostSink(counters, () => {
    const bench = matchBench(BENCH_PRESETS.ultra, debug);
    playRecording(loadRecording(match), {
      onTick: (result) => {
        bench.step(result);
        const record = snapshotToPlain(takeSnapshot(result.state));
        records.push(record);
        digests.push(fnv1a32(jsonSerializer.encode(record)));
        delivered.push(composition(bench.buffer.view));
      },
    });
    sections = bench.debug === null ? [] : Object.keys(bench.debug.dump().sections);
    debugFrames = bench.debug?.frameCount ?? 0;
  });
  return {
    log: decoder.decode(prettyJsonSerializer.encode(records)),
    digests,
    delivered,
    render: counters,
    sections,
    debugFrames,
  };
}

const RUNS = new Map<string, { on: DebugRun; off: DebugRun }>();

function runsOf(match: string): { on: DebugRun; off: DebugRun } {
  const cached = RUNS.get(match);
  if (cached !== undefined) return cached;
  const runs = { on: playUnder(match, true), off: playUnder(match, false) };
  RUNS.set(match, runs);
  return runs;
}

describe('RDBG-8: эталон стоимости не замечает отладки', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: счётчики стоимости совпадают побитово`, () => {
      const { on, off } = runsOf(match);
      // Сперва доказательство, что проверять было что: слой действительно
      // работал, и источники действительно дали секции.
      expect(on.debugFrames).toBeGreaterThan(0);
      expect(on.sections.length).toBeGreaterThan(0);
      expect(off.sections).toEqual([]);
      // Все до единого: сравнение по полям, а не по паре выбранных счётчиков.
      expect({ ...on.render }).toEqual({ ...off.render });
      expect(off.render.syncTickSubsystems).toBeGreaterThan(0);
      expect(off.render.frameSubsystems).toBeGreaterThan(0);
    });
  }

  it('в дампе есть секции и подсистем, и сборки — проверялась вся отладка', () => {
    const { on } = runsOf('match-walk');
    expect(on.sections).toContain('fog.mask');
    expect(on.sections).toContain('terrain.surface');
    expect(on.sections).toContain('models.instances');
    expect(on.sections).toContain('net.delivery');
    expect(on.sections).toContain('cost.counters');
  });
});

describe('RDBG-5: отладка ничего не меняет', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: канонический лог и состав доставки те же`, () => {
      const { on, off } = runsOf(match);
      // Отпечатки первыми: их дифф называет тик, а не вываливает лог целиком.
      expect(on.digests, match).toEqual(off.digests);
      expect(on.log, match).toBe(off.log);
      expect(on.delivered, match).toEqual(off.delivered);
      expect(on.digests.length).toBe(loadRecording(match).ticks);
      // Мир не стоит: одинаковый лог одинаковых тиков доказывал бы только то,
      // что запись ничего не делает.
      expect(new Set(on.digests).size).toBeGreaterThan(1);
    });
  }
});
