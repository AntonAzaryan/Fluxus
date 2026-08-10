/**
 * Чтение поля компонента, которым сущность не владеет (ECS-7).
 *
 * Проверяется то, что наблюдаемо: значение (нейтральное для ТИПА поля, а не
 * содержимое ячейки), тотальность (тик не обрывается ни на снятом компоненте,
 * ни на мёртвой сущности, ни на мусорном идентификаторе), сохранённая проверка
 * имён (ECS-5 не подменён) и разведение каналов (FP-4): мягкий assert
 * debug-сборки не меняет ни результата, ни байтов прогона.
 *
 * Чего здесь нет: теста на отсутствие аллокаций на владеющем пути — это
 * свойство кода, а не поведения. И теста на обнуление ячеек: ECS-7 нормирует
 * чтение, а не хранилище, поэтому остаточное значение в плоской форме мира
 * ожидается, а не осуждается — и это здесь как раз закреплено.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addComponent,
  createWorld,
  destroy,
  getField,
  removeComponent,
  spawn,
  toPlain,
  type PrefabDef,
} from '../src/ecs/world.js';
import { createCommandBuffer } from '../src/ecs/commands.js';
import { indexOf as rawIndexOf, makeEntityId } from '../src/ecs/entityIndex.js';
import { withDiagnostics } from '../src/debug.js';
import { EvaluatedSystem, type SystemDef } from '../src/dsl/evaluatedSystem.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  NO_ENTITY,
  type ComponentSchema,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type EntityId,
  type System,
  type SystemContext,
  type WorldState,
} from '../src/types.js';
import type { ScenarioDef } from '../src/sim/scenario.js';

const Health: ComponentSchema = { name: 'Health', fields: { current: 'fixed', max: 'fixed' } };
/** Носитель ссылки: `target` — поле типа `entity`, `hits` — обычный `i32`. */
const Seeker: ComponentSchema = { name: 'Seeker', fields: { target: 'entity', hits: 'i32' } };
/** Куда система-читатель кладёт прочитанное: чтение обязано быть наблюдаемым в мире. */
const Note: ComponentSchema = { name: 'Note', fields: { value: 'i32' } };

const SCHEMAS: readonly ComponentSchema[] = [Health, Seeker, Note];

const PREFABS: readonly PrefabDef[] = [
  { name: 'hero', components: { Health: { current: 500, max: 500 }, Note: { value: 0 } } },
  // Ни `Health`, ни `Seeker` — единственный, кем читают «без владения».
  { name: 'rock', components: { Note: { value: 0 } } },
  { name: 'seeker', components: { Seeker: { target: 0, hits: 9 }, Note: { value: 0 } } },
];

function world(): WorldState {
  return createWorld(SCHEMAS, PREFABS, 16);
}

function collector(): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace: 'off', record: (entry) => entries.push(entry) }, entries };
}

const ownershipCodes = (entries: readonly DiagnosticRecord[]): string[] =>
  entries.filter((e) => e.code === 'COMPONENT_READ_WITHOUT_OWNERSHIP').map((e) => e.code);

describe('чтение без владения — нейтральное значение типа поля (ECS-7)', () => {
  it('живая сущность без компонента читает нейтраль, хотя в ячейке лежит её собственное прошлое', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    addComponent(state, rock, 'Health', { current: 777, max: 777 });
    removeComponent(state, rock, 'Health');

    // Ячейка не обнулена — и не обязана быть (ECS-7, «норма о чтении, а не о хранилище»).
    expect(toPlain(state).components.Health!.current![rawIndexOf(rock)]).toBe(777);
    expect(getField(state, rock, 'Health', 'current')).toBe(0);
    expect(getField(state, rock, 'Health', 'max')).toBe(0);
  });

  it('компонент, которого у сущности не было никогда, читается так же', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    // Владеющее чтение не задето: нейтраль — ответ на отсутствие владения, а не на всё.
    expect(getField(state, hero, 'Health', 'current')).toBe(500);
    expect(getField(state, rock, 'Health', 'current')).toBe(0);
  });

  it('поле типа entity даёт «ссылки нет» (-1), а не ноль — ноль валидный EntityId (ECS-6)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    // Первая аллоцированная сущность имеет идентификатор 0 — потому и не он значит «нет ссылки».
    expect(hero).toBe(0);

    const rock = spawn(state, 'rock');
    addComponent(state, rock, 'Seeker', { target: hero, hits: 4 });
    removeComponent(state, rock, 'Seeker');

    expect(getField(state, rock, 'Seeker', 'target')).toBe(NO_ENTITY);
    expect(getField(state, rock, 'Seeker', 'target')).not.toBe(hero);
    // Соседнее поле того же компонента — ноль: нейтральное значение своё у каждого типа.
    expect(getField(state, rock, 'Seeker', 'hits')).toBe(0);
  });

  it('переиспользованный слот не отдаёт значение прежнего владельца (ID-6)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    destroy(state, hero);
    const rock = spawn(state, 'rock');

    // Тот же слот, другое поколение — ровно случай, от которого защищают поколения (ID-3).
    expect(rawIndexOf(rock)).toBe(rawIndexOf(hero));
    expect(rock).not.toBe(hero);
    expect(toPlain(state).components.Health!.current![rawIndexOf(rock)]).toBe(500);

    expect(getField(state, rock, 'Health', 'current')).toBe(0);
  });

  it('не-живая сущность читается нейтралью, а не последним своим значением', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    expect(getField(state, hero, 'Health', 'current')).toBe(500);
    destroy(state, hero);
    expect(getField(state, hero, 'Health', 'current')).toBe(0);
  });

  it('мусорный идентификатор даёт нейтраль и ровно одну запись — маску на нём не спрашивают', () => {
    const state = world();
    spawn(state, 'hero');
    spawn(state, 'hero');
    spawn(state, 'hero');
    spawn(state, 'hero');

    // Индекс за capacity, отрицательные, поколение из ниоткуда, нецелое.
    for (const garbage of [999999, -1, -5, 2 ** 47 + 3, 0.5]) {
      const { sink, entries } = collector();
      withDiagnostics(sink, 1, () => {
        expect(getField(state, garbage, 'Health', 'current')).toBe(0);
      });
      // Ровно одна запись, и она об отсутствии владения: живость проверяется
      // РАНЬШЕ маски, поэтому MASK_INDEX_OUT_OF_RANGE к находке не примешивается.
      expect(entries.map((e) => e.code)).toEqual(['COMPONENT_READ_WITHOUT_OWNERSHIP']);
      expect(getField(state, garbage, 'Seeker', 'target')).toBe(NO_ENTITY);
    }

    // `makeEntityId` этот идентификатор собрал бы сам — мусор он лишь по адресату.
    expect(makeEntityId(3, 2 ** 23)).toBe(2 ** 47 + 3);
  });
});

describe('опечатка в имени остаётся ошибкой (ECS-5)', () => {
  it('незарегистрированный компонент и несуществующее поле бросают — и у владельца, и у не-владельца', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');

    for (const entity of [hero, rock]) {
      expect(() => getField(state, entity, 'Halth', 'current')).toThrow(
        /getField: компонент "Halth" не зарегистрирован/,
      );
      expect(() => getField(state, entity, 'Health', 'currnt')).toThrow(
        /getField: у компонента "Health" нет поля "currnt"/,
      );
    }
  });

  it('имя проверяется раньше живости: у мёртвой сущности опечатка тоже бросает', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    destroy(state, hero);
    expect(() => getField(state, hero, 'Health', 'currnt')).toThrow(/нет поля "currnt"/);
    expect(() => getField(state, hero, 'Halth', 'current')).toThrow(/не зарегистрирован/);
  });
});

describe('тотальность внутри тика (ECS-7, CMD-2, CMD-5)', () => {
  it('компонент снят предыдущей системой этого тика — следующая читает нейтраль', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const registry = new SystemRegistry();
    registry.register({
      name: 'Stripper',
      order: 10,
      run: (ctx) => { ctx.commands.removeComponent(hero, 'Health'); },
    });
    let seen: number | undefined;
    let owned: boolean | undefined;
    registry.register({
      name: 'Reader',
      order: 20,
      run: (ctx) => {
        owned = ctx.has(hero, 'Health');
        seen = ctx.get(hero, 'Health', 'current');
      },
    });

    expect(getField(state, hero, 'Health', 'current')).toBe(500);
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    expect(() => { tick(sim, initialState(state, 1)); }).not.toThrow();
    expect(owned).toBe(false);
    expect(seen).toBe(0);
  });

  it('сущность убита предыдущей системой — чтение не обрывает тик', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const registry = new SystemRegistry();
    registry.register({ name: 'Reaper', order: 10, run: (ctx) => { ctx.commands.destroy(hero); } });
    let seen: number | undefined;
    let alive: boolean | undefined;
    registry.register({
      name: 'Reader',
      order: 20,
      run: (ctx) => {
        alive = ctx.isAlive(hero);
        seen = ctx.get(hero, 'Health', 'current');
      },
    });

    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    expect(() => { tick(sim, initialState(state, 1)); }).not.toThrow();
    expect(alive).toBe(false);
    expect(seen).toBe(0);
  });

  it('мягкий assert не бросает и не меняет прочитанное значение (FP-4)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const before = JSON.stringify(toPlain(state));
    const { sink, entries } = collector();
    let seen: number | undefined;
    withDiagnostics(sink, 5, () => {
      expect(() => { seen = getField(state, rock, 'Health', 'current'); }).not.toThrow();
    });
    expect(seen).toBe(0);
    expect(ownershipCodes(entries)).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tick: 5, kind: 'assert', level: 'warn' });
    // Диагностика мира не касается: байты плоской формы те же.
    expect(JSON.stringify(toPlain(state))).toBe(before);
    // Владеющее чтение записи не порождает — иначе канал был бы шумом.
    const owner = spawn(state, 'hero');
    const quiet = collector();
    withDiagnostics(quiet.sink, 6, () => {
      expect(getField(state, owner, 'Health', 'current')).toBe(500);
    });
    expect(quiet.entries).toHaveLength(0);
  });

  it('peekField отвечает о буфере, а промах падает в мир через тот же getField (CMD-5)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const commands = createCommandBuffer(state);
    const read = (entity: EntityId): number =>
      commands.peekField(entity, 'Health', 'current') ?? getField(state, entity, 'Health', 'current');

    // Промах буфера — `undefined`, и оба потребителя (`terrain.carveFloor`,
    // `systems/modifiers.ts`) падают в мир этим самым `??`.
    expect(commands.peekField(rock, 'Health', 'current')).toBeUndefined();
    expect(read(rock)).toBe(0);

    // Поставленная команда отвечает из буфера и владения не спрашивает: это
    // ответ о накопленном, а не о мире (CMD-5).
    commands.setField(rock, 'Health', 'current', 321);
    expect(read(rock)).toBe(321);
    expect(getField(state, rock, 'Health', 'current')).toBe(0);
  });
});

describe('выражение и нативная система отвечают одинаково (SYS-6)', () => {
  /** Читает `Health.current` без guard'а `hasComponent` и кладёт прочитанное в `Note.value`. */
  const READER_JSON: SystemDef = {
    name: 'Reader',
    order: 10,
    query: { all: ['Note'] },
    as: 'e',
    do: [
      {
        modifyComponent: {
          entity: { var: 'e' },
          component: 'Note',
          values: { value: { getComponent: [{ var: 'e' }, 'Health', 'current'] } },
        },
      },
    ],
  };

  /** Та же логика на TS — эталон парности. */
  class NativeReader implements System {
    readonly name = 'Reader';
    readonly order = 10;

    run(ctx: SystemContext): void {
      for (const entity of ctx.query({ all: ['Note'] })) {
        ctx.commands.setField(entity, 'Note', 'value', ctx.get(entity, 'Health', 'current'));
      }
    }
  }

  function notesAfterTick(system: System): number[] {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    const registry = new SystemRegistry();
    registry.register(system);
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    tick(sim, initialState(state, 1));
    return [getField(state, hero, 'Note', 'value'), getField(state, rock, 'Note', 'value')];
  }

  it('getComponent без guard\'а даёт то же, что ctx.get: нейтраль у не-владельца', () => {
    const fromJson = notesAfterTick(new EvaluatedSystem(READER_JSON));
    const fromNative = notesAfterTick(new NativeReader());
    expect(fromJson).toEqual([500, 0]);
    expect(fromJson).toEqual(fromNative);
  });
});

describe('debug и release совпадают побитово (FP-4)', () => {
  /** Сцена с чтением без владения: `rock` не владеет `Health`, а система читает без guard'а. */
  const SCENARIO: ScenarioDef = {
    name: 'ownerless-read',
    seed: 11,
    ticks: 3,
    scene: {
      components: [Health, Note],
      prefabs: [
        { name: 'hero', components: { Health: { current: 500, max: 500 }, Note: { value: 0 } } },
        { name: 'rock', components: { Note: { value: 0 } } },
      ],
      systems: [
        {
          name: 'Reader',
          order: 10,
          query: { all: ['Note'] },
          as: 'e',
          do: [
            {
              modifyComponent: {
                entity: { var: 'e' },
                component: 'Note',
                values: {
                  value: { '+': [{ getComponent: [{ var: 'e' }, 'Note', 'value'] }, { getComponent: [{ var: 'e' }, 'Health', 'current'] }] },
                },
              },
            },
          ],
        },
      ],
      capacity: 16,
      initial: [{ prefab: 'hero' }, { prefab: 'rock' }],
    },
  };

  /**
   * Отдельный граф модулей на режим: `DEBUG` вычисляется при загрузке
   * `src/debug.ts`, поэтому иначе оба прогона шли бы в одном режиме и тест был
   * бы вакуумным.
   */
  async function loadRunner(production: boolean): Promise<{
    debug: boolean;
    run: (typeof import('../src/sim/scenario.js'))['runScenario'];
  }> {
    const previous = process.env.NODE_ENV;
    if (production) process.env.NODE_ENV = 'production';
    else delete process.env.NODE_ENV;
    vi.resetModules();
    try {
      const debugModule = await import('../src/debug.js');
      const scenarioModule = await import('../src/sim/scenario.js');
      return { debug: debugModule.DEBUG, run: scenarioModule.runScenario };
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      vi.resetModules();
    }
  }

  it('состояния по тикам совпадают, и сценарий действительно читает без владения', async () => {
    const release = await loadRunner(true);
    const debug = await loadRunner(false);
    // Анти-вакуумность №1: режимы правда разные.
    expect(release.debug).toBe(false);
    expect(debug.debug).toBe(true);

    // Анти-вакуумность №2: в прогоне есть чтение без владения — иначе сверка
    // сравнивала бы два одинаковых документа ни о чём.
    const { sink, entries } = collector();
    debug.run(SCENARIO, sink);
    expect(ownershipCodes(entries).length).toBeGreaterThan(0);

    const asDebug = JSON.stringify(debug.run(SCENARIO));
    const asRelease = JSON.stringify(release.run(SCENARIO));
    expect(asDebug).toBe(asRelease);

    // И ответ по сути: владелец накапливает, не-владелец остаётся на нейтрали.
    const run = JSON.parse(asDebug) as {
      ticks: { world: { components: Record<string, Record<string, number[]>> } }[];
    };
    const last = run.ticks[run.ticks.length - 1]!.world.components.Note!.value!;
    expect(last).toEqual([1500, 0]);
  });
});
