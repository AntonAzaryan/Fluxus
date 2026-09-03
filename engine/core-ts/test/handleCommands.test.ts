/**
 * Команда записи поля, адресованная handle'ом, и чтение по индексу запроса
 * (`data-driven-systems` SYS-10; `ecs-foundation` CMD-1, CMD-3, CMD-5, QUERY-2,
 * QUERY-3).
 *
 * Оба пути — оптимизация адресации, а не второе поведение: наблюдаемо здесь
 * ровно то, чем они обязаны совпадать со строковым путём — порядок применения,
 * точечное чтение буфера, запись о команде в трейсе, состав и порядок выборки,
 * значение чтения. Замер выигрыша сюда не входит: он диагностика
 * (`docs/reviews/2026-09-02-core-tick-headroom.md`), а не поведение.
 */
import { describe, expect, it } from 'vitest';
import { createCommandBuffer } from '../src/ecs/commands.js';
import { query, queryInto } from '../src/ecs/query.js';
import {
  createWorld,
  destroy,
  getField,
  getFieldByHandle,
  resolveFieldHandle,
  spawn,
  type PrefabDef,
} from '../src/ecs/world.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { mathApi } from '../src/math/mathApi.js';
import type {
  ComponentSchema,
  DiagnosticRecord,
  EntityId,
  FieldHandle,
  SystemContext,
  WorldState,
} from '../src/types.js';

const Position: ComponentSchema = { name: 'Position', fields: { x: 'fixed', y: 'fixed' } };
const Health: ComponentSchema = { name: 'Health', fields: { current: 'i32', max: 'i32' } };
const Note: ComponentSchema = { name: 'Note', fields: { value: 'i32' } };

const SCHEMAS: readonly ComponentSchema[] = [Position, Health, Note];

const PREFABS: readonly PrefabDef[] = [
  { name: 'hero', components: { Position: { x: 1, y: 2 }, Health: { current: 100, max: 100 } } },
  { name: 'rock', components: { Position: { x: 3, y: 4 } } },
  { name: 'note', components: { Note: { value: 7 } } },
];

function world(): WorldState {
  return createWorld([...SCHEMAS], [...PREFABS], 32);
}

describe('команда записи поля по handle (CMD-1, CMD-3, SYS-10)', () => {
  it('порядок применения — порядок создания, каким бы ни был адрес команды', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    const current = resolveFieldHandle(state, 'Health', 'current');

    // Три команды на ОДНО поле: handle, имя, handle. Побеждает последняя
    // созданная — правило одно на оба канала (CMD-3).
    commands.setFieldByHandle(hero, current, 11);
    commands.setField(hero, 'Health', 'current', 22);
    commands.setFieldByHandle(hero, current, 33);
    expect(getField(state, hero, 'Health', 'current')).toBe(100);

    commands.flush();
    expect(getField(state, hero, 'Health', 'current')).toBe(33);
  });

  it('строковая команда после handle-команды перекрывает её', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    commands.setFieldByHandle(hero, resolveFieldHandle(state, 'Health', 'max'), 55);
    commands.setField(hero, 'Health', 'max', 77);
    commands.flush();
    expect(getField(state, hero, 'Health', 'max')).toBe(77);
  });

  it('команда мёртвой цели отбрасывается так же, как строковая (CMD-7)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    commands.destroy(hero);
    commands.setFieldByHandle(hero, resolveFieldHandle(state, 'Health', 'current'), 5);
    expect(() => {
      commands.flush();
    }).not.toThrow();
    expect(getField(state, hero, 'Health', 'current')).toBe(0);
  });

  it('непредставимое значение остаётся жёсткой ошибкой прохода валидации (ECS-3, SYS-9)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    commands.setFieldByHandle(hero, resolveFieldHandle(state, 'Health', 'current'), 2 ** 40);
    expect(() => {
      commands.flush();
    }).toThrow(/непредставимо \(ECS-3\)/);
    // Проверка идёт ДО первой мутации: мир не тронут (SYS-9).
    expect(getField(state, hero, 'Health', 'current')).toBe(100);
  });

  it('запись невладеющей сущности пуста, как и по имени (ECS-8)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const commands = createCommandBuffer(state);
    commands.setFieldByHandle(rock, resolveFieldHandle(state, 'Health', 'current'), 42);
    commands.flush();
    expect(getField(state, rock, 'Health', 'current')).toBe(0);
  });
});

describe('точечное чтение буфера видит команду по handle (CMD-5)', () => {
  it('адрес спрашивают именами, а поставлен он handle-командой', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    expect(commands.peekField(hero, 'Health', 'current')).toBeUndefined();

    commands.setFieldByHandle(hero, resolveFieldHandle(state, 'Health', 'current'), 13);
    expect(commands.peekField(hero, 'Health', 'current')).toBe(13);
    // Соседнее поле того же компонента командой не тронуто.
    expect(commands.peekField(hero, 'Health', 'max')).toBeUndefined();
    // Незарегистрированное имя — «команд на это поле не было», а не бросок.
    expect(commands.peekField(hero, 'Ghost', 'current')).toBeUndefined();
  });

  it('возвращается последняя по порядку создания — из обоих каналов (CMD-3, CMD-5)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    const current = resolveFieldHandle(state, 'Health', 'current');

    commands.setField(hero, 'Health', 'current', 1);
    commands.setFieldByHandle(hero, current, 2);
    expect(commands.peekField(hero, 'Health', 'current')).toBe(2);

    commands.setField(hero, 'Health', 'current', 3);
    expect(commands.peekField(hero, 'Health', 'current')).toBe(3);

    // То же, что окажется в мире после flush (CMD-5).
    commands.flush();
    expect(getField(state, hero, 'Health', 'current')).toBe(3);
  });

  it('адресат чужой — команда не видна (CMD-5)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const other = spawn(state, 'hero');
    const commands = createCommandBuffer(state);
    commands.setFieldByHandle(hero, resolveFieldHandle(state, 'Health', 'current'), 9);
    expect(commands.peekField(other, 'Health', 'current')).toBeUndefined();
  });
});

describe('трейс не различает способ адресации команды (DIAG-2, DIAG-5)', () => {
  /** Один тик одной системы, пишущей `Health.current`; записи о командах. */
  function traceOf(byHandle: boolean): DiagnosticRecord[] {
    const state = world();
    const hero = spawn(state, 'hero');
    const entries: DiagnosticRecord[] = [];
    const registry = new SystemRegistry();
    registry.register({
      name: 'Writer',
      order: 10,
      run: (ctx: SystemContext) => {
        if (byHandle) {
          ctx.commands.setFieldByHandle(hero, ctx.resolveField('Health', 'current'), 41);
          ctx.commands.setFieldByHandle(hero, ctx.resolveField('Health', 'current'), 42);
        } else {
          ctx.commands.setField(hero, 'Health', 'current', 41);
          ctx.commands.setField(hero, 'Health', 'current', 42);
        }
      },
    });
    const sim: Simulation = {
      systems: registry,
      worldSeed: 1,
      math: mathApi,
      diagnostics: { trace: 'full', record: (entry) => entries.push(entry) },
    };
    tick(sim, initialState(state, 1));
    return entries.filter((entry) => entry.kind === 'command');
  }

  it('записи о командах совпадают у обоих каналов побитово', () => {
    const byHandle = traceOf(true);
    expect(byHandle).toHaveLength(2);
    // Имена компонента и поля handle-команда берёт из таблицы полей мира —
    // запись выглядит ровно как у строковой (DIAG-2).
    expect(byHandle[0]).toMatchObject({
      outcome: 'overwritten',
      data: { cmd: 'setField', component: 'Health', field: 'current', value: 41 },
    });
    expect(byHandle[1]).toMatchObject({ outcome: 'applied', data: { value: 42 } });
    expect(byHandle).toEqual(traceOf(false));
  });
});

describe('выборка в буферы вызывающего (QUERY-2, QUERY-3, SYS-10)', () => {
  /** Мир с переиспользованным слотом: порядок QUERY-2 — по возрастанию слота. */
  function populated(): { state: WorldState; alive: EntityId[] } {
    const state = world();
    const first = spawn(state, 'hero');
    const second = spawn(state, 'hero');
    const third = spawn(state, 'hero');
    destroy(state, second);
    // Новая сущность занимает освободившийся слот 1 — и обходится на его месте.
    const reused = spawn(state, 'hero');
    return { state, alive: [first, reused, third] };
  }

  it('состав и порядок совпадают с `query` (QUERY-2)', () => {
    const { state, alive } = populated();
    const expected = query(state, { all: ['Health'] });
    const ids = new Float64Array(8);
    const indices = new Int32Array(8);
    const count = queryInto(state, { all: ['Health'] }, ids, indices);

    expect(count).toBe(expected.length);
    expect([...ids.subarray(0, count)]).toEqual([...expected]);
    expect([...ids.subarray(0, count)]).toEqual(alive);
    // Индексы — слоты этих же сущностей, по возрастанию (QUERY-2).
    expect([...indices.subarray(0, count)]).toEqual([0, 1, 2]);
  });

  it('фильтр `not` и неизвестное имя отвечают так же, как у `query`', () => {
    const { state } = populated();
    spawn(state, 'rock');
    const ids = new Float64Array(8);
    const indices = new Int32Array(8);

    const withoutHealth = queryInto(state, { all: ['Position'], not: ['Health'] }, ids, indices);
    expect(withoutHealth).toBe(query(state, { all: ['Position'], not: ['Health'] }).length);

    expect(queryInto(state, { all: ['Ghost'] }, ids, indices)).toBe(0);
  });

  it('буфер короче отбора — префикс и ПОЛНОЕ число совпавших', () => {
    const { state } = populated();
    const ids = new Float64Array(2);
    const indices = new Int32Array(2);
    const count = queryInto(state, { all: ['Health'] }, ids, indices);

    // Ответ — сколько совпало, а не сколько записано: по нему вызывающий
    // растит буфер и повторяет запрос.
    expect(count).toBe(3);
    expect([...ids]).toEqual([...query(state, { all: ['Health'] }).subarray(0, 2)]);

    const grown = new Float64Array(count);
    const grownIndices = new Int32Array(count);
    expect(queryInto(state, { all: ['Health'] }, grown, grownIndices)).toBe(3);
    expect([...grown]).toEqual([...query(state, { all: ['Health'] })]);
  });

  it('без буфера индексов отбор тот же: второй массив не обязателен', () => {
    // Вызывающему, который читает поля по id (воркер рендера, REND-26), буфер
    // слотов не нужен вовсе, и требовать его значило бы навязывать аллокацию
    // размером в мир ради выброшенных чисел.
    const { state, alive } = populated();
    const ids = new Float64Array(8);
    const count = queryInto(state, { all: ['Health'] }, ids);

    expect(count).toBe(alive.length);
    expect([...ids.subarray(0, count)]).toEqual(alive);
  });

  it('ctx.getByIndex отвечает то же, что ctx.getByHandle (SYS-10)', () => {
    const { state } = populated();
    spawn(state, 'note');
    const seen = { checked: 0, mismatches: 0 };
    const registry = new SystemRegistry();
    let handle: FieldHandle | undefined;
    registry.register({
      name: 'Parity',
      order: 10,
      run: (ctx: SystemContext) => {
        handle ??= ctx.resolveField('Health', 'current');
        const ids = new Float64Array(8);
        const indices = new Int32Array(8);
        const count = ctx.queryInto({ all: ['Health'] }, ids, indices);
        expect(count).toBe(ctx.query({ all: ['Health'] }).length);
        for (let slot = 0; slot < count; slot++) {
          const entity = ids[slot]!;
          if (ctx.getByIndex(indices[slot]!, handle) !== ctx.getByHandle(entity, handle)) {
            seen.mismatches++;
          }
          if (ctx.getByIndex(indices[slot]!, handle) !== getFieldByHandle(state, entity, handle)) {
            seen.mismatches++;
          }
          seen.checked++;
        }
      },
    });
    tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(state, 1));
    expect(seen.checked).toBe(3);
    expect(seen.mismatches).toBe(0);
  });
});
