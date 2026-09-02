/**
 * Детерминированные величины занятой памяти ядра (`performance-budget` PERF-8).
 *
 * Проверяется ровно то, ради чего они заведены: сводка покидает симуляцию тем
 * же стоком диагностики, что и сводка стоимости, обычной записью DIAG-2,
 * считает размеры структур, которыми мир ВЛАДЕЕТ, воспроизводима побитово
 * (DIAG-6) и инертна — без стока учёт не исполняется вовсе.
 *
 * Байтов кучи среды исполнения здесь нет ни одного и быть не может (PERF-8):
 * они меняются с версией среды при неизменном коде. Их рост стережёт сторож
 * PERF-10 (`integration-ts/test/memory.test.ts`), а не эта запись.
 */
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { addTag, createWorld, spawn } from '../src/ecs/world.js';
import { createTerrainGrid } from '../src/systems/terrain.js';
import { buildNavigation } from '../src/systems/nav/navigation.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { traceLine } from '../src/sim/trace.js';
import type { PrefabDef } from '../src/ecs/world.js';
import type {
  ComponentSchema,
  DiagnosticRecord,
  DiagnosticsSink,
  NavigationApi,
  SimulationState,
  System,
  TraceLevel,
} from '../src/types.js';

const FOOTPRINT_CODE = 'TICK_FOOTPRINT';
const WORLD_SEED = 4242;

/** Ёмкость мира теста: маленькая и НАЗВАННАЯ — байты считаются от неё вручную. */
const CAPACITY = 64;

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Health', fields: { current: 'fixed' } },
];

const PREFABS: PrefabDef[] = [
  { name: 'unit', components: { Position: { x: 0, y: 0 }, Health: { current: 65536 } } },
  { name: 'tagged', tags: ['alpha', 'beta'], components: { Health: { current: 1 } } },
];

function collector(trace: TraceLevel): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace, record: (entry) => entries.push(entry) }, entries };
}

/** Сводки размера состояния в порядке выдачи. */
function footprints(entries: readonly DiagnosticRecord[]): DiagnosticRecord[] {
  return entries.filter((entry) => entry.code === FOOTPRINT_CODE);
}

/** Числовое поле последней сводки — форма данных записи объявлена DIAG-2. */
function field(entries: readonly DiagnosticRecord[], name: string): number {
  const last = footprints(entries).at(-1);
  expect(last, `сводки ${FOOTPRINT_CODE} не было`).toBeDefined();
  return Number(last!.data?.[name] ?? Number.NaN);
}

interface Stand {
  readonly sim: (diagnostics?: DiagnosticsSink) => Simulation;
  readonly state: SimulationState;
}

/** Мир и симуляция с одной системой, которую задаёт вызывающий. */
function stand(system: System, navigation?: NavigationApi): Stand {
  const world = createWorld(SCHEMAS, PREFABS, CAPACITY);
  const registry = new SystemRegistry();
  registry.register(system);
  return {
    sim: (diagnostics?: DiagnosticsSink) => ({
      systems: registry,
      worldSeed: WORLD_SEED,
      math: mathApi,
      ...(navigation !== undefined ? { navigation } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    }),
    state: initialState(world, WORLD_SEED),
  };
}

/** Система, не делающая ничего: величины мира от неё не зависят. */
const IDLE: System = { name: 'Idle', order: 1, run: () => {} };

describe('PERF-8: сводка размера состояния — обычная запись диагностики (DIAG-2)', () => {
  it('одна запись на тик, вида `tickFootprint` и с кодом TICK_FOOTPRINT', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);
    tick(sim(sink), state);

    const records = footprints(entries);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tick: 1,
      kind: 'tickFootprint',
      level: 'info',
      code: FOOTPRINT_CODE,
    });
    expect(records[1]).toMatchObject({ tick: 2, kind: 'tickFootprint' });
  });

  it('запись принадлежит тику, а не системе: состав полей закрыт', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const record = footprints(entries)[0]!;
    expect(record.system).toBeUndefined();
    expect(record.outcome).toBeUndefined();
    // Состав сериализованной записи проверяется ЦЕЛИКОМ (DIAG-2): любое лишнее
    // поле — часы, окружение, имя системы — обязано ронять этот тест.
    const plain = JSON.parse(traceLine(record)) as Record<string, unknown>;
    expect(Object.keys(plain)).toEqual(['code', 'data', 'kind', 'level', 'seq', 'tick']);
  });

  it('данные записи — только числа названных величин, и ни одного байта кучи', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const data = footprints(entries)[0]?.data ?? {};
    expect(Object.keys(data).sort()).toEqual([
      'commandsPeak',
      'entitiesAlive',
      'entitiesFree',
      'eventsPeak',
      'navBytes',
      'navHeapCapacity',
      'tagEntries',
      'worldBytes',
    ]);
    for (const value of Object.values(data)) expect(Number.isInteger(value)).toBe(true);
  });

  it('уровень `off` сводки не пишет: величины — штатная телеметрия (DIAG-3)', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('off');
    tick(sim(sink), state);
    expect(footprints(entries)).toHaveLength(0);
  });

  it('оборванный тик сводки не получает — состав мира на нём неполон', () => {
    const { sim, state } = stand({
      name: 'Bad',
      order: 1,
      run: () => {
        throw new Error('падение системы');
      },
    });
    const { sink, entries } = collector('systems');
    expect(() => tick(sim(sink), state)).toThrow(/падение системы/);
    expect(footprints(entries)).toHaveLength(0);
  });

  it('замороженный тик сводки не получает: его и не было (WSM-2)', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('systems');
    state.mode = 'Paused';
    tick(sim(sink), state);
    expect(footprints(entries)).toHaveLength(0);
  });
});

describe('PERF-8: величины считают то, чем мир владеет', () => {
  it('worldBytes равен ручной сумме колонок, масок и индекса', () => {
    const { sim, state } = stand(IDLE);
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    // Три поля `fixed` (Position.x, Position.y, Health.current) — по колонке
    // Int32Array ёмкости мира; маски — одно слово Uint32Array на сущность (два
    // компонента влезают в одно); индекс — Uint32Array поколений и Uint8Array
    // живости. Сумма выписана ЗДЕСЬ, а не взята у мира: иначе тест сверял бы
    // реализацию с ней же самой.
    const columns = 3 * CAPACITY * 4;
    const masks = CAPACITY * 4;
    const index = CAPACITY * 4 + CAPACITY;
    expect(field(entries, 'worldBytes')).toBe(columns + masks + index);
  });

  it('worldBytes не зависит от населённости мира — это ЁМКОСТЬ', () => {
    const { sim, state } = stand({
      name: 'Spawner',
      order: 1,
      run: (ctx) => {
        if (ctx.tick <= 4) ctx.commands.spawn('unit');
      },
    });
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);
    const empty = field(entries, 'worldBytes');
    for (let i = 0; i < 4; i++) tick(sim(sink), state);
    expect(field(entries, 'worldBytes')).toBe(empty);
  });

  it('спавн и гибель двигают alive и free на единицу (ID-2, ID-6)', () => {
    let spawned = 0;
    const { sim, state } = stand({
      name: 'Churn',
      order: 1,
      run: (ctx) => {
        if (ctx.tick === 1) {
          ctx.commands.spawn('unit');
          spawned = 0;
        }
        if (ctx.tick === 2) spawned = ctx.query({ all: ['Health'] })[0]!;
        if (ctx.tick === 3) ctx.commands.destroy(spawned);
      },
    });
    const { sink, entries } = collector('systems');

    tick(sim(sink), state);
    expect(field(entries, 'entitiesAlive')).toBe(1);
    expect(field(entries, 'entitiesFree')).toBe(0);

    tick(sim(sink), state);
    expect(field(entries, 'entitiesAlive')).toBe(1);

    tick(sim(sink), state);
    // Слот погибшей вернулся в список свободных — ровно то, чей невозврат
    // сценарий PERF-8 обязан ловить диффом эталона.
    expect(field(entries, 'entitiesAlive')).toBe(0);
    expect(field(entries, 'entitiesFree')).toBe(1);
  });

  it('теги считаются записями, а не сущностями', () => {
    const world = createWorld(SCHEMAS, PREFABS, CAPACITY);
    const entity = spawn(world, 'tagged');
    const registry = new SystemRegistry();
    registry.register(IDLE);
    const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
    const state = initialState(world, WORLD_SEED);
    const { sink, entries } = collector('systems');

    tick({ ...sim, diagnostics: sink }, state);
    // Prefab принёс сущности два тега — записей две, а не одна.
    expect(field(entries, 'tagEntries')).toBe(2);

    addTag(world, entity, 'gamma');
    tick({ ...sim, diagnostics: sink }, state);
    expect(field(entries, 'tagEntries')).toBe(3);
  });

  it('commandsPeak — ПИК длины буфера за тик, а не сумма по системам', () => {
    const world = createWorld(SCHEMAS, PREFABS, CAPACITY);
    const first = spawn(world, 'unit');
    const registry = new SystemRegistry();
    // Первая система заказывает три записи, вторая — одну: буфер флашится на
    // границе каждой, поэтому пик — три, а сумма была бы четыре.
    registry.register({
      name: 'Three',
      order: 1,
      run: (ctx) => {
        ctx.commands.setField(first, 'Health', 'current', 1);
        ctx.commands.setField(first, 'Position', 'x', 2);
        ctx.commands.setField(first, 'Position', 'y', 3);
      },
    });
    registry.register({
      name: 'One',
      order: 2,
      run: (ctx) => {
        ctx.commands.setField(first, 'Health', 'current', 4);
      },
    });
    const { sink, entries } = collector('systems');
    tick(
      { systems: registry, worldSeed: WORLD_SEED, math: mathApi, diagnostics: sink },
      initialState(world, WORLD_SEED),
    );
    expect(field(entries, 'commandsPeak')).toBe(3);
  });

  it('eventsPeak — длина журнала событий тика, и она не переезжает в следующий', () => {
    const { sim, state } = stand({
      name: 'Emitter',
      order: 1,
      run: (ctx) => {
        for (let i = 0; i < ctx.tick; i++) ctx.events.emit('beep');
      },
    });
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);
    expect(field(entries, 'eventsPeak')).toBe(1);
    tick(sim(sink), state);
    // Шина чистится в начале тика: вторая сводка называет события ВТОРОГО тика,
    // а не сумму двух.
    expect(field(entries, 'eventsPeak')).toBe(2);
  });

  it('navBytes считает рабочие структуры поиска и растёт площадью арены', () => {
    const measure = (size: number): number => {
      const grid = createTerrainGrid({
        width: size,
        height: size,
        tileSize: fixed.fromInt(1),
        levels: Array.from({ length: size }, () => '0'.repeat(size)),
        flags: Array.from({ length: size }, () => '.'.repeat(size)),
      });
      const navigation = buildNavigation(grid, { budget: size * size, maxAgentRadius: 0 });
      const half = fixed.fromInt(1) >> 1;
      const far = fixed.fromInt(size - 1) + half;
      const { sim, state } = stand(
        {
          name: 'Walker',
          order: 1,
          run: (ctx) => {
            ctx.navigation?.findPath({ x: half, y: half }, { x: far, y: far });
          },
        },
        navigation,
      );
      const { sink, entries } = collector('systems');
      tick(sim(sink), state);
      return field(entries, 'navBytes');
    };

    const small = measure(16);
    const large = measure(32);
    // Пять массивов по клетке (`Int32Array`) плюс карты проходимости и зазора
    // запечённой сетки: 16×16 → 5·256·4 + 256 + 2·256 = 5888 байт, и куча
    // открытых узлов сверху. Вчетверо большая площадь — вчетверо больше байтов
    // с точностью до кучи, которая от площади не зависит (NAV-5, PERF-8).
    expect(small).toBeGreaterThan(5 * 16 * 16 * 4);
    expect(large).toBeGreaterThan(3.5 * small);
    expect(large).toBeLessThan(4.5 * small);
  });

  it('navHeapCapacity растёт запросом по большой сетке и не падает (NAV-5)', () => {
    const size = 48;
    const grid = createTerrainGrid({
      width: size,
      height: size,
      tileSize: fixed.fromInt(1),
      levels: Array.from({ length: size }, () => '0'.repeat(size)),
      flags: Array.from({ length: size }, () => '.'.repeat(size)),
    });
    const navigation = buildNavigation(grid, { budget: size * size, maxAgentRadius: 0 });
    const half = fixed.fromInt(1) >> 1;
    const far = fixed.fromInt(size - 1) + half;
    const { sim, state } = stand(
      {
        name: 'Walker',
        order: 1,
        run: (ctx) => {
          if (ctx.tick === 1) return;
          ctx.navigation?.findPath({ x: half, y: half }, { x: far, y: far });
        },
      },
      navigation,
    );
    const { sink, entries } = collector('systems');

    // Тик без запроса: куча ещё той ёмкости, с какой её создали.
    tick(sim(sink), state);
    const initial = field(entries, 'navHeapCapacity');
    expect(initial).toBe(0);
    // Байтов навигации на тике без запроса тоже нет: величины снимаются на
    // запросе, а не на сборке — сборка идёт вне тика (NAV-3).
    expect(field(entries, 'navBytes')).toBe(0);

    tick(sim(sink), state);
    const grown = field(entries, 'navHeapCapacity');
    expect(grown).toBeGreaterThan(0);

    // Ёмкость только растёт: буфер живёт на экземпляре поиска и между запросами
    // не отдаётся (NAV-2) — второй такой же запрос её не уменьшает.
    tick(sim(sink), state);
    expect(field(entries, 'navHeapCapacity')).toBe(grown);
  });
});

describe('DIAG-4/PERF-8: учёт инертен, а без стока не исполняется', () => {
  it('без подключённого стока записей нет вовсе — учёту некуда и незачем считать', () => {
    const { sim, state } = stand(IDLE);
    const { entries } = collector('systems');
    tick(sim(), state);
    expect(entries).toHaveLength(0);
  });

  it('прогон со стоком даёт то же состояние мира, что прогон без него', () => {
    const build = (): Stand =>
      stand({
        name: 'Churn',
        order: 1,
        run: (ctx) => {
          ctx.commands.spawn('tagged');
          const alive = ctx.query({ all: ['Health'] });
          if (alive.length > 3) ctx.commands.destroy(alive[0]!);
          ctx.events.emit('beep');
        },
      });

    const plain = build();
    for (let i = 0; i < 8; i++) tick(plain.sim(), plain.state);

    const traced = build();
    const { sink } = collector('systems');
    for (let i = 0; i < 8; i++) tick(traced.sim(sink), traced.state);

    // Мир, прошедший под стоком, обязан совпасть с миром без стока: наблюдатель
    // не меняет хода симуляции (DIAG-4).
    expect(traced.state.tick).toBe(plain.state.tick);
    expect(JSON.stringify(traced.state.world)).toBe(JSON.stringify(plain.state.world));
  });

  it('два прогона одной нагрузки дают побитово одинаковый поток сводок (DIAG-6)', () => {
    const lines = (): string[] => {
      const { sim, state } = stand({
        name: 'Churn',
        order: 1,
        run: (ctx) => {
          ctx.commands.spawn('tagged');
          ctx.events.emit('beep');
        },
      });
      const { sink, entries } = collector('systems');
      for (let i = 0; i < 5; i++) tick(sim(sink), state);
      return footprints(entries).map((entry) => traceLine(entry));
    };

    const first = lines();
    expect(first).toHaveLength(5);
    expect(lines()).toEqual(first);
  });
});
