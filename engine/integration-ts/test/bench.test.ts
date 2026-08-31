/**
 * Сторож реального времени ядра (`performance-budget` PERF-5, задача 3.2):
 * сколько тиков в секунду вытягивает симуляция на записанном матче (CLI-10).
 *
 * Не гейт стоимости — тот рядом, в `cost.test.ts`, и он точный (PERF-4).
 * Здесь меряется то, чего счётчики не видят в принципе: константное замедление
 * на единицу работы, при котором объём работы не изменился ни на команду.
 *
 * Конвенции — те же, что у замеров канала (`client-ts/test/bench.test.ts`) и
 * рендера (`render-ts/test/bench.test.ts`): прогрев JIT, `performance.now()`
 * вокруг измеряемого цикла, печать `[bench]` при КАЖДОМ прогоне, ассерт только
 * против деградации на порядок. Жёстких порогов здесь MUST NOT быть (PERF-5):
 * числа между машинами несравнимы, и порог «в притык» краснел бы на слабой
 * машине разработчика, ничего не поймав. Поэтому ассертится не темп в тиках за
 * секунду, а стоимость тика в ЭТАЛОННЫХ ЕДИНИЦАХ работы
 * (`engine/tests/bench/calibration.ts`): та же фиксированная нагрузка, померенная
 * в том же процессе, делит миллисекунды на скорость машины. Машина в отношении
 * сокращается, подорожание тика — нет. Темп в тиках за секунду по-прежнему
 * печатается: читать глазами удобнее его.
 *
 * Мерится чистый цикл тиков: сборка мира вынесена из замера, снапшоты не
 * строятся, диагностика не подключена — иначе сторож стерёг бы сериализацию
 * прогона, а не симуляцию.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NPC_STRESS, RECORDED_MATCHES, loadNpcStress, loadRecording, prepareRecording } from './benchLoad.js';
import { benchUnits, calibrationLine } from '../../tests/bench/calibration.js';
import { buildNavigation, createTerrainGrid, type ScenarioDef, type TerrainDef } from '@fluxus/core';

/** Прогонов на прогрев JIT и прогонов под замером. */
const WARMUP = 20;
const REPEATS = 40;

/**
 * Столько же для нагрузки массы NPC (NPC-9): её тик делает работу за две сотни
 * агентов, и полсотни прогонов заняли бы минуты — при том, что сторож мерит
 * ПОРЯДОК, а не разброс между прогонами.
 */
const NPC_WARMUP = 2;
const NPC_REPEATS = 4;

/**
 * Сторожевой порог: наблюдаемое — 0.014…0.022 эталонной единицы работы на тик
 * (разброс между записями — постоянные затраты тика, а не их объём). Под чужой
 * нагрузкой на машине держатся те же числа: скорость машины сокращается в
 * отношении, а всплески планировщика отсекает выбор лучшего прогона.
 *
 * Порог на порядок выше наблюдаемого: разница машин его не трогает, а
 * замедление на порядок краснеет (PERF-5). Жёстче ассертить wall-time MUST NOT.
 */
const MAX_UNITS_PER_TICK = 0.25;

/**
 * Стоимость тика одной записи в эталонных единицах машины. Миры собраны заранее
 * и по одному на прогон: замер обязан покрывать только цикл тиков, а повторный
 * прогон — начинаться с того же начального состояния, что и первый.
 *
 * Берётся ЛУЧШИЙ прогон, а не сумма всех: чужая нагрузка на машине умеет
 * сделать прогон только медленнее, никогда быстрее, — и на сумме её случайный
 * всплеск виден как удорожание тика, которого не было. Особенно это про массу
 * NPC: её прогонов всего четыре, и один отобранный планировщиком отрезок
 * двигает среднее в разы (наблюдалось 2.7 против 18.8 эталонной единицы на
 * одной машине). Той же логикой берётся минимум и в калибровке.
 */
function unitsPerTick(name: string, load?: ScenarioDef, warmup = WARMUP, repeats = REPEATS): number {
  const def = load ?? loadRecording(name);
  for (let i = 0; i < warmup; i++) prepareRecording(def).run();

  const prepared = Array.from({ length: repeats }, () => prepareRecording(def));
  let bestMs = Number.POSITIVE_INFINITY;
  let totalMs = 0;
  for (const recording of prepared) {
    const started = performance.now();
    recording.run();
    const elapsedMs = performance.now() - started;
    totalMs += elapsedMs;
    if (elapsedMs < bestMs) bestMs = elapsedMs;
  }

  const perTickMs = bestMs / def.ticks;
  const rate = 1000 / perTickMs;
  const units = benchUnits(perTickMs);
  console.log(
    `[bench] тик ядра, ${name}: ${Math.round(rate).toLocaleString('ru-RU')} тиков/с ` +
      `(${(perTickMs * 1000).toFixed(1)} мкс/тик, ${units.toFixed(3)} эталонной единицы; ` +
      `лучший из ${repeats} прогонов, тиков в прогоне ${def.ticks}, все за ${totalMs.toFixed(1)} мс)`,
  );
  return units;
}

describe('замеры ядра на записанных матчах (информативно)', () => {
  beforeAll(() => {
    // Печать при каждом прогоне (PERF-5): по этой строке читаются остальные —
    // тик печатается и в микросекундах, и в эталонных единицах машины.
    console.log(calibrationLine());
  });

  for (const match of RECORDED_MATCHES) {
    it(`${match}: тик дешевле сторожевого порога в эталонных единицах`, () => {
      expect(unitsPerTick(match)).toBeLessThan(MAX_UNITS_PER_TICK);
    });
  }
});

/**
 * Сторож массы NPC (`npc-behavior` NPC-9, PERF-5): двести массовых крипов на
 * арене — та же нагрузка, чью работу считает эталон стоимости, но замеряется
 * здесь ВРЕМЯ, которого счётчики не видят.
 *
 * Порог свой и много выше матчевого: тик этой нагрузки делает работу за две
 * сотни агентов, а не за двоих героев (наблюдаемое — 3 эталонных единицы на
 * тик). Запас у него шире соседского не по вкусу, а по разбросу: прогонов
 * здесь четыре, а не сорок, и каждый идёт полсекунды — на чужой нагрузке даже
 * лучший из них ловит планировщик и уезжает до 8 единиц. Как и у соседей выше,
 * он сторожит замедление на порядок, а не «сколько должно быть» (PERF-5).
 */
const MAX_NPC_UNITS_PER_TICK = 40;

describe('замер массы NPC (информативно, NPC-9)', () => {
  it(`${NPC_STRESS}: тик дешевле сторожевого порога в эталонных единицах`, () => {
    const units = unitsPerTick(NPC_STRESS, loadNpcStress(), NPC_WARMUP, NPC_REPEATS);
    expect(units).toBeLessThan(MAX_NPC_UNITS_PER_TICK);
  });
});

/**
 * Сторож поиска пути (`pathfinding` NAV-5, PERF-5, PERF-6): сколько реального
 * времени стоит один запрос `findPath` на синтетической сетке.
 *
 * Точный объём работы стережёт эталон стоимости (`nav-path.cost.json`,
 * PERF-4) — он считает раскрытия и пробы. Здесь меряется ровно то, чего
 * счётчики не видят: КОНСТАНТНОЕ подорожание одного узла, при котором число
 * узлов не изменилось ни на единицу.
 *
 * Оси нагрузки — те же две, что двигают стоимость поиска (PERF-6): размер сетки
 * (раскрытий на запрос) и число запросов за замер. Карты две и они намеренно
 * противоположны: серпантин-лабиринт заставляет A* обойти почти всю сетку, а
 * открытое поле уходит к цели по эвристике и почти не ветвится. Сторож обязан
 * пережить обе.
 *
 * Ассерт — только против деградации на порядок (PERF-5): наблюдаемое — 0.04…0.08
 * эталонной единицы на запрос открытого поля и 0.11…0.78 на запрос лабиринта
 * (лабиринт дороже не константой на узел, а работой: путь в нём проходит сетку
 * целиком, а сглаживание тянет опору вдоль каждого коридора). Порог — на
 * порядок выше худшего наблюдаемого, а не «в притык». Числа печатаются при
 * КАЖДОМ прогоне — читать их и есть смысл сторожа.
 */
const NAV_TILE = 65536;
const NAV_WARMUP = 2;
const NAV_REPEATS = 3;
const MAX_UNITS_PER_PATH = 8;

/** Серпантин-лабиринт либо открытое поле — синтетическая сетка сторожа. */
function navTerrain(size: number, maze: boolean): TerrainDef {
  const levels = Array.from({ length: size }, () => '0'.repeat(size));
  const flags = Array.from({ length: size }, (_, y) => {
    if (!maze || y % 2 === 0) return '.'.repeat(size);
    // Проход у противоположных краёв через ряд: путь сверху вниз обязан
    // пройти сеткой целиком, а не по диагонали.
    const gap = (y >> 1) % 2 === 0 ? size - 1 : 0;
    return Array.from({ length: size }, (_, x) => (x === gap ? '.' : '_')).join('');
  });
  return { width: size, height: size, tileSize: NAV_TILE, levels, flags };
}

/** Стоимость ОДНОГО запроса в эталонных единицах машины. */
function unitsPerPath(maze: boolean, size: number, requests: number): number {
  const grid = createTerrainGrid(navTerrain(size, maze));
  // Бюджет заведомо больше сетки: сторож меряет полный поиск, а не отказ по
  // исчерпанию (NAV-5).
  const navigation = buildNavigation(grid, { budget: size * size, maxAgentRadius: 0 });
  const half = NAV_TILE >> 1;
  const bottom = (size - 1) * NAV_TILE + half;
  const run = (): void => {
    for (let i = 0; i < requests; i++) {
      // Старт съезжает по верхнему ряду: два одинаковых запроса подряд мерили
      // бы кэш, которого у `findPath` нет и быть не должно (NAV-2).
      const from = { x: (i % size) * NAV_TILE + half, y: half };
      navigation.findPath(from, { x: half, y: bottom });
    }
  };

  for (let i = 0; i < NAV_WARMUP; i++) run();
  let bestMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < NAV_REPEATS; i++) {
    const started = performance.now();
    run();
    bestMs = Math.min(bestMs, performance.now() - started);
  }

  const perPathMs = bestMs / requests;
  const units = benchUnits(perPathMs);
  const kind = maze ? 'лабиринт' : 'поле';
  console.log(
    `[bench] findPath, ${kind} ${size}×${size}: ${(perPathMs * 1000).toFixed(1)} мкс/запрос ` +
      `(${units.toFixed(4)} эталонной единицы; запросов в прогоне ${requests}, ` +
      `лучший из ${NAV_REPEATS} прогонов)`,
  );
  return units;
}

describe('замер поиска пути (информативно, NAV-5)', () => {
  for (const maze of [true, false]) {
    // Ось «размер сетки» при неизменном числе запросов и ось «число запросов»
    // при неизменном размере: обе двигают стоимость, и обе обязаны остаться
    // ниже порога (PERF-6).
    for (const [size, requests] of [
      [24, 32],
      [48, 32],
      [48, 96],
    ] as const) {
      it(`${maze ? 'лабиринт' : 'поле'} ${size}×${size}, запросов ${requests}: дешевле порога`, () => {
        expect(unitsPerPath(maze, size, requests)).toBeLessThan(MAX_UNITS_PER_PATH);
      });
    }
  }
});
