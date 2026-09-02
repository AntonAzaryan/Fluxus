/**
 * Инварианты устоявшегося состояния и освобождения (`performance-budget`
 * PERF-9) — проверки с заранее известным ответом: эталон им не нужен, потому
 * что ожидаемое значение от нагрузки не зависит.
 *
 * Три нагрузки и три утверждения:
 *
 * - **оборот ядра**: на сцене, где каждый тик рождается сущность с тегом и
 *   умирает самая старая, величины `TICK_FOOTPRINT` в двух точках прогона после
 *   прогрева совпадают полем в поле. Список свободных слотов, записи тегов и
 *   пик буфера команд числом оборотов расти MUST NOT;
 * - **оборот доставки**: на доставке с вращающимися идентификаторами величины
 *   состояния приёма и подсистем в тех же двух точках равны — запись исчезнувшей
 *   сущности обязана сниматься, а не копиться;
 * - **цикл тракта**: «собрать → отыграть → снести», повторённый десять раз,
 *   после каждого сноса оставляет ноль живых ресурсов GPU у каждой подсистемы —
 *   так живёт вьюпорт авторинга (`editor` ED-15).
 *
 * Полноту учёта ресурсов стережёт сканер исходника (`render-ts/test/guard.test.ts`):
 * без него эти инварианты проверяли бы только то, что учтено.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSimulation,
  tick,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type ScenarioDef,
} from '@fluxus/core';
import {
  createFootprint,
  footprintLive,
  withFootprintSink,
  type ExtractedTick,
  type FootprintState,
  type RenderFootprint,
} from '@fluxus/render';
import { CHURN_LIFETIME, churnScene } from './fixtures.js';
import {
  BENCH_PRESETS,
  BENCH_PRESET_NAMES,
  PresentationBench,
  matchBench,
  syntheticTick,
  type SyntheticLoad,
} from './benchLoad.js';

// --------------------------------------------------------------- оборот ядра

/**
 * Тиков прогрева до первой точки: мир должен успеть выйти на постоянную
 * численность, то есть прожить полное поколение и начать возвращать слоты.
 */
const WARMUP_TICKS = 4 * CHURN_LIFETIME;
/** Точка B — вдвое дальше точки A: между ними оборот прокрутился ещё раз столько же. */
const SPAN_TICKS = WARMUP_TICKS;

const CHURN_LOAD: ScenarioDef = {
  name: 'churn',
  seed: 20260902,
  ticks: WARMUP_TICKS + SPAN_TICKS,
  scene: churnScene(),
};

/** Величины записи `TICK_FOOTPRINT` как есть — сравниваются полем в поле. */
type TickFields = Record<string, number>;

/**
 * Прогон нагрузки оборота: величины тика в двух точках после прогрева. Мир
 * прогоняется ОДИН раз, а не дважды: два прогона сравнивали бы две истории, а
 * инвариант — про одну, дошедшую до устоявшегося состояния.
 */
function churnPoints(): { readonly a: TickFields; readonly b: TickFields; readonly alive: number } {
  const seen = new Map<number, TickFields>();
  const sink: DiagnosticsSink = {
    trace: 'systems',
    record: (entry: DiagnosticRecord) => {
      if (entry.code !== 'TICK_FOOTPRINT') return;
      const data = entry.data ?? {};
      const fields: TickFields = {};
      for (const [name, value] of Object.entries(data)) fields[name] = Number(value);
      seen.set(entry.tick, fields);
    },
  };
  const { sim, state } = buildSimulation(
    { scene: CHURN_LOAD.scene, seed: CHURN_LOAD.seed },
    { where: 'нагрузка оборота', diagnostics: sink },
  );
  for (let i = 0; i < CHURN_LOAD.ticks; i++) tick(sim, state);
  const a = seen.get(WARMUP_TICKS);
  const b = seen.get(WARMUP_TICKS + SPAN_TICKS);
  expect(a, 'нет записи точки A').toBeDefined();
  expect(b, 'нет записи точки B').toBeDefined();
  return { a: a!, b: b!, alive: a!.entitiesAlive! };
}

describe('PERF-9: оборот ядра не растит величин занятой памяти', () => {
  it('величины в точках A и B совпадают полем в поле', () => {
    const { a, b } = churnPoints();
    // Сравниваются ВСЕ поля записи, а не выбранные: невозврат чего угодно —
    // слота, тега, команды — обязан ронять этот тест, а не проходить мимо
    // списка, который автор вспомнил.
    expect(b).toEqual(a);
  });

  it('нагрузка не выродилась: оборот идёт, и мир держит постоянную численность', () => {
    const { a, alive } = churnPoints();
    // Численность — на единицу меньше времени жизни: буфер команд флашится на
    // границе КАЖДОЙ системы (CMD-2), поэтому рождённая `Spawner`'ом сущность
    // видна запросу `Aging` уже на своём тике и стареет вместе со всеми.
    expect(alive).toBe(CHURN_LIFETIME - 1);
    // Слоты возвращаются — их список непуст, а тег есть у каждой живой.
    expect(a.entitiesFree).toBeGreaterThan(0);
    expect(a.tagEntries).toBe(alive);
    expect(a.commandsPeak).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ оборот доставки

/** Нагрузка доставки: наблюдатель на месте, остальные сущности сменяются. */
const DELIVERY_LOAD: SyntheticLoad = {
  entities: 48,
  observers: 2,
  vision: 1.5,
  extent: 16,
  // Одноразовых эффектов в нагрузке нет намеренно: выстрел живёт СВОЮ
  // длительность (REND-24), которая длиннее окна между точками, и растущий пул
  // читался бы как невозврат, хотя это просто ещё не отыгравшие эффекты.
  // Проверяется здесь оборот СОСТАВА доставки, а не время жизни эффекта.
  shots: 0,
};

/** Доставок прогрева и доставок между точками A и B. */
const DELIVERY_WARMUP = 20;
const DELIVERY_SPAN = 20;

/**
 * Доставка раунда `round` с ВРАЩАЮЩИМИСЯ идентификаторами: наблюдатели свои id
 * держат (иначе маска потеряла бы героя и нагрузка выродилась бы), остальные
 * приходят новыми и исчезают следующей доставкой — ровно тот состав, который
 * приём доставки обязан возвращать.
 */
function rotatingTick(round: number): ExtractedTick {
  const ext = syntheticTick(DELIVERY_LOAD);
  for (let i = DELIVERY_LOAD.observers; i < ext.count; i++) {
    ext.id[i] = 1_000_000 + round * ext.count + i;
  }
  return ext;
}

/** Величины состояния стенда после N доставок оборота. */
function deliverRounds(bench: PresentationBench, from: number, count: number): void {
  for (let round = from; round < from + count; round++) bench.deliver(rotatingTick(round));
}

describe('PERF-9: оборот доставки не растит величин состояния', () => {
  it('записи приёма и пулы подсистем в точках A и B равны', () => {
    const sink = createFootprint();
    let a: FootprintState | null = null;
    let b: FootprintState | null = null;
    withFootprintSink(sink, () => {
      const bench = matchBench(BENCH_PRESETS.ultra);
      deliverRounds(bench, 0, DELIVERY_WARMUP);
      a = { ...sink.state };
      deliverRounds(bench, DELIVERY_WARMUP, DELIVERY_SPAN);
      b = { ...sink.state };
    });
    // Величины — пики за прогон: выросшая между точками означает, что оборот
    // чего-то не вернул, и тест называет её по имени.
    expect(b).toEqual(a);
    expect(a!.viewRecords).toBe(DELIVERY_LOAD.entities);
  });

  it('нагрузка не выродилась: состав доставки действительно сменяется', () => {
    const first = rotatingTick(0);
    const second = rotatingTick(1);
    const shared = new Set([...first.id].filter((id) => [...second.id].includes(id)));
    // Общие идентификаторы — ровно наблюдатели, всё остальное сменилось.
    expect(shared.size).toBe(DELIVERY_LOAD.observers);
  });
});

// ------------------------------------------------------------- цикл тракта

/** Циклов сборки и сноса и доставок в каждом — как у вьюпорта на смене сцены (ED-15). */
const CYCLES = 10;
const CYCLE_DELIVERIES = 4;

/**
 * Владелец процессных заглушек (ASSET-4): геометрия и материал незагруженной
 * модели и текстура-заглушка вариантов скина строятся один раз на процесс и
 * сноса сцены не переживают по недосмотру, а по замыслу.
 *
 * Из инварианта он не вычёркивается, а проверяется ОТДЕЛЬНО: молчаливое
 * исключение сделало бы единственного владельца, переживающего снос, ещё и
 * единственным, кого никто не считает.
 */
const PLACEHOLDER_OWNER = 'placeholders';

/** Заглушки процесса поимённо: каждая ОДНА на процесс, чужих видов здесь нет. */
const PLACEHOLDER_KINDS: readonly string[] = ['geometry', 'material', 'texture'];

function subsystemLive(sink: RenderFootprint): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [owner, kinds] of Object.entries(footprintLive(sink))) {
    if (owner === PLACEHOLDER_OWNER) continue;
    const nonzero = Object.fromEntries(Object.entries(kinds).filter(([, value]) => value !== 0));
    if (Object.keys(nonzero).length > 0) out[owner] = nonzero;
  }
  return out;
}

/** Живых заглушек процесса: вид известен списку, и их не больше одной на вид. */
function expectPlaceholders(sink: RenderFootprint, where: string): void {
  const live = footprintLive(sink)[PLACEHOLDER_OWNER] ?? {};
  for (const [kind, count] of Object.entries(live)) {
    expect(PLACEHOLDER_KINDS, `${where}: незнакомая заглушка "${kind}"`).toContain(kind);
    expect(count, `${where}: заглушек вида "${kind}"`).toBeLessThanOrEqual(1);
  }
}

describe('PERF-9: цикл полного тракта не оставляет живых ресурсов', () => {
  for (const preset of BENCH_PRESET_NAMES) {
    it(`${preset}: ${String(CYCLES)} циклов «собрать → доставки → снести», после каждого ноль`, () => {
      const sink = createFootprint();
      withFootprintSink(sink, () => {
        for (let cycle = 0; cycle < CYCLES; cycle++) {
          const bench = matchBench(BENCH_PRESETS[preset]);
          deliverRounds(bench, cycle * CYCLE_DELIVERIES, CYCLE_DELIVERIES);
          // Учёт обязан был увидеть работу цикла: пустая таблица прошла бы
          // проверку ниже молча.
          expect(Object.keys(footprintLive(sink)).length, 'учёт пуст').toBeGreaterThan(0);

          bench.stage.dispose();

          expect(subsystemLive(sink), `${preset}, цикл ${String(cycle + 1)}`).toEqual({});
          expectPlaceholders(sink, `${preset}, цикл ${String(cycle + 1)}`);
        }
      });
    });
  }
});
