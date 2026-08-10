/**
 * Пост-условие оборванного тика (SYS-9): что уже в мире, чего в нём нет и что
 * происходит с командами упавшей системы.
 *
 * Норма сегодня выполняется устройством `tick()` — буфер команд локален вызову,
 * — и потому её легко потерять рефакторингом, не заметив: тесты состояния мира
 * после успешного тика такую потерю не увидят. Здесь она пришпилена.
 */
import { describe, expect, it } from 'vitest';
import { EvaluatedSystem, validateSystem, type SystemDef } from '../src/dsl/evaluatedSystem.js';
import type { Action } from '../src/dsl/actions.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { createWorld, getField, listAlive, spawn, type PrefabDef } from '../src/ecs/world.js';
import type { ComponentSchema, SimulationState, TickResult } from '../src/types.js';

const F = fixed.fromFloat;

/** По полю на систему: чей след дошёл до мира, видно по одному дампу. */
const Mark: ComponentSchema = {
  name: 'Mark',
  fields: { first: 'fixed', second: 'fixed', third: 'fixed', fourth: 'fixed' },
};

const PREFABS: PrefabDef[] = [
  { name: 'Subject', components: { Mark: { first: 0, second: 0, third: 0, fourth: 0 } } },
];

const v = (name: string): object => ({ var: name });
/** Номер тика в Q16.16 — чтобы след системы говорил, на каком тике он оставлен. */
const nowFixed = { fromInt: [{ tick: [] }] };

/** Ставит свой след и, если задано, публикует факт. */
const marker = (name: string, order: number, field: string, extra: readonly Action[] = []): SystemDef => ({
  name,
  order,
  query: { all: ['Mark'] },
  as: 'e',
  do: [
    { modifyComponent: { entity: v('e'), component: 'Mark', values: { [field]: nowFixed } } },
    { emitEvent: { type: name, data: {} } },
    ...extra,
  ],
});

/**
 * Третья система: след ставится, факт публикуется, а на втором тике исполнение
 * упирается в пустой диапазон `randomBelow` — ошибку класса 3 (ACT-1, SYS-9).
 */
const THIRD: SystemDef = marker('Third', 30, 'third', [
  {
    if: {
      cond: { '>': [nowFixed, F(1)] },
      then: [{ randomBelow: { as: 'roll', bound: F(0), do: [] } }],
    },
  },
]);

const SYSTEMS: readonly SystemDef[] = [
  marker('First', 10, 'first'),
  marker('Second', 20, 'second'),
  THIRD,
  marker('Fourth', 40, 'fourth'),
];

function makeSim(): { sim: Simulation; state: SimulationState; entity: number } {
  const world = createWorld([Mark], PREFABS);
  const entity = spawn(world, 'Subject');
  const registry = new SystemRegistry();
  for (const def of SYSTEMS) registry.registerFromJson(def, world);
  return { sim: { systems: registry, worldSeed: 1, math: mathApi }, state: initialState(world, 1), entity };
}

const marks = (state: SimulationState, entity: number): Record<string, number> => ({
  first: getField(state.world, entity, 'Mark', 'first'),
  second: getField(state.world, entity, 'Mark', 'second'),
  third: getField(state.world, entity, 'Mark', 'third'),
  fourth: getField(state.world, entity, 'Mark', 'fourth'),
});

const eventTypes = (state: SimulationState): string[] => [...state.events].map((e) => e.type);

describe('обрыв тика на системе посреди прохода (SYS-9)', () => {
  it('мир содержит эффекты слитых систем и ни одного эффекта упавшей', () => {
    const { sim, state, entity } = makeSim();
    tick(sim, state); // тик 1 проходит целиком

    let returned: TickResult | undefined;
    expect(() => void (returned = tick(sim, state))).toThrow(/randomBelow/);

    // Отчёта о тике не существует: ошибка приходит исключением (SYS-9).
    expect(returned).toBeUndefined();
    expect(marks(state, entity)).toEqual({
      first: F(2), // слита
      second: F(2), // слита
      third: F(1), // команда второго тика отброшена целиком
      fourth: F(1), // система не запускалась вовсе
    });
  });

  it('номер тика увеличен, а шина содержит опубликованное до обрыва', () => {
    const { sim, state } = makeSim();
    tick(sim, state);

    expect(() => tick(sim, state)).toThrow();

    // Тик начался и частично состоялся — делать вид, что его не было, ядро не вправе.
    expect(state.tick).toBe(2);
    // Шина очищена в начале тика и содержит ровно опубликованное до обрыва.
    expect(eventTypes(state)).toEqual(['First', 'Second', 'Third']);
  });

  it('ошибка не публикуется событием и не становится частью симуляции', () => {
    const { sim, state } = makeSim();
    tick(sim, state);
    expect(() => tick(sim, state)).toThrow();

    // Событие-ошибка стало бы входом систем, реагирующих на него, — вторым
    // каналом, обязанным совпасть между реализациями побитово.
    expect(eventTypes(state).filter((type) => !['First', 'Second', 'Third', 'Fourth'].includes(type))).toEqual([]);
    for (const event of state.events) expect(event.data).toEqual({});
  });

  it('перемотка к более раннему снапшоту возвращает мир в согласованное состояние (REW-2)', () => {
    const { sim, state, entity } = makeSim();
    tick(sim, state);
    const snapshot = takeSnapshot(state);

    expect(() => tick(sim, state)).toThrow();
    const consistent = marks(state, entity);

    restoreSnapshot(state, snapshot);

    expect(state.tick).toBe(1);
    expect(marks(state, entity)).toEqual({ first: F(1), second: F(1), third: F(1), fourth: F(1) });
    expect(eventTypes(state)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    // Состояние обрыва не потерялось молча: до перемотки оно было другим.
    expect(consistent).not.toEqual(marks(state, entity));
    // С восстановленного состояния симуляция продолжается штатно — на тике 2
    // она снова упирается в тот же дефект контента, а не в мусор от обрыва.
    expect(() => tick(sim, state)).toThrow(/randomBelow/);
  });

  it('сущности упавшей системы не появляются и не исчезают', () => {
    const spawner: SystemDef = {
      name: 'Spawner',
      order: 50,
      do: [
        { spawnEntity: { prefab: 'Subject' } },
        { randomBelow: { as: 'roll', bound: F(0), do: [] } },
      ],
    };
    const world = createWorld([Mark], PREFABS);
    spawn(world, 'Subject');
    const registry = new SystemRegistry();
    registry.registerFromJson(spawner, world);
    const state = initialState(world, 1);

    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, state)).toThrow();

    // Спавн — такая же команда буфера, как запись поля (CMD-1): отброшена вместе с ним.
    expect(listAlive(state.world).length).toBe(1);
  });
});

describe('отказ на применении команд отбрасывает буфер целиком (SYS-9, CMD-2)', () => {
  /**
   * Обрыв не в теле системы, а на `flush`: `spawn` упирается в ёмкость мира
   * (ID-1). Проверять тут есть что именно потому, что часть команд системы к
   * этому моменту уже была бы применена наивным проходом «применяй по одной».
   */
  const GREEDY: SystemDef = {
    name: 'Greedy',
    order: 20,
    query: { all: ['Mark'] },
    as: 'e',
    do: [
      { modifyComponent: { entity: v('e'), component: 'Mark', values: { second: nowFixed } } },
      { emitEvent: { type: 'Greedy', data: {} } },
      { spawnEntity: { prefab: 'Subject' } },
      // Места под второй спавн уже нет: ёмкость 2, один субъект жив с начала.
      { spawnEntity: { prefab: 'Subject' } },
    ],
  };

  function greedySim(): { sim: Simulation; state: SimulationState; entity: number } {
    const world = createWorld([Mark], PREFABS, 2);
    const entity = spawn(world, 'Subject');
    const registry = new SystemRegistry();
    for (const def of [marker('First', 10, 'first'), GREEDY, marker('Third', 30, 'third')]) {
      registry.registerFromJson(def, world);
    }
    return { sim: { systems: registry, worldSeed: 1, math: mathApi }, state: initialState(world, 1), entity };
  }

  it('ни одна команда упавшей системы до мира не доходит, а слитые системы целы', () => {
    const { sim, state, entity } = greedySim();

    expect(() => tick(sim, state)).toThrow(/превышена capacity \(2\)/);

    expect(marks(state, entity)).toEqual({
      first: F(1), // слита до отказа
      second: 0, // запись поля отброшена вместе со спавном
      third: 0, // система не запускалась вовсе
      fourth: 0,
    });
    // Первый спавн буфера отброшен так же, как второй: буфер применяется целиком
    // или не применяется вовсе.
    expect(listAlive(state.world).length).toBe(1);
  });

  it('пост-условие обрыва то же, что у ошибки вычисления: тик увеличен, шина цела', () => {
    const { sim, state } = greedySim();
    expect(() => tick(sim, state)).toThrow();

    expect(state.tick).toBe(1);
    // События публикуются мимо буфера команд и обрыв их не отменяет (EVT-2).
    expect(eventTypes(state)).toEqual(['First', 'Greedy']);
  });

  it('спавн в пределах ёмкости проходит: отказ — про ёмкость, а не про сам буфер', () => {
    const world = createWorld([Mark], PREFABS, 3);
    spawn(world, 'Subject');
    const registry = new SystemRegistry();
    registry.registerFromJson(GREEDY, world);
    const state = initialState(world, 1);

    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, state)).not.toThrow();
    expect(listAlive(state.world).length).toBe(3);
  });

  it('слот, освобождённый destroy в том же буфере, достаётся следующему spawn', () => {
    // Ёмкость исчерпана с начала: место под спавн появляется только из destroy,
    // и проход валидации обязан считать пул так же, как его считает аллокация.
    const recycler: SystemDef = {
      name: 'Recycler',
      order: 10,
      query: { all: ['Mark'] },
      as: 'e',
      do: [{ destroyEntity: { entity: v('e') } }, { spawnEntity: { prefab: 'Subject' } }],
    };
    const world = createWorld([Mark], PREFABS, 1);
    spawn(world, 'Subject');
    const registry = new SystemRegistry();
    registry.registerFromJson(recycler, world);
    const state = initialState(world, 1);

    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, state)).not.toThrow();
    expect(listAlive(state.world).length).toBe(1);
  });
});

describe('сообщение об ошибке класса 3 (SYS-9)', () => {
  it('называет систему, путь до узла и причину', () => {
    const { sim, state } = makeSim();
    tick(sim, state);

    expect(() => tick(sim, state)).toThrow(
      /система "Third", узел \[0\]\.forEach\.do\[2\]\.if\.then\[0\]\.randomBelow: действие "randomBelow": "bound" должен быть не меньше 1, получено 0/,
    );
  });

  it('путь ведёт сквозь вложенные тела действий до узла с ошибкой', () => {
    const nested: SystemDef = {
      name: 'Reactor',
      order: 10,
      do: [
        { emitEvent: { type: 'Scorch', data: {} } },
        {
          forEachEvent: {
            type: 'Scorch',
            as: 'hit',
            do: [
              {
                let: {
                  bindings: { amount: F(1) },
                  // У события "Scorch" поля "damage" нет — ошибка вычисления (EXPR-2).
                  do: [{ emitEvent: { type: 'Echo', data: { d: { eventField: [v('hit'), 'damage'] } } } }],
                },
              },
            ],
          },
        },
      ],
    };
    const world = createWorld([Mark], PREFABS);
    const registry = new SystemRegistry();
    registry.registerFromJson(nested, world);

    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(world, 1))).toThrow(
      /система "Reactor", узел \[1\]\.forEachEvent\.do\[0\]\.let\.do\[0\]\.emitEvent: оператор "eventField": у события "Scorch" нет поля "damage"/,
    );
  });

  it('ошибка нативной системы именем системы не обрастает: класс 3 — про системы из данных', () => {
    const world = createWorld([Mark], PREFABS);
    const registry = new SystemRegistry();
    registry.register({
      name: 'Native',
      order: 10,
      run: () => {
        throw new Error('дефект кода');
      },
    });

    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(world, 1))).toThrow(
      /^дефект кода$/,
    );
  });
});

describe('система из данных валидна до тика (SYS-3)', () => {
  it('все системы этого файла проходят регистрацию: обрыв — не дефект формы', () => {
    const world = createWorld([Mark], PREFABS);
    for (const def of SYSTEMS) expect(() => { validateSystem(def, world); }).not.toThrow();
    // Исполнитель, а не валидатор: пустой диапазон вычисляется и на регистрации неизвестен.
    expect(new EvaluatedSystem(THIRD).name).toBe('Third');
  });
});
