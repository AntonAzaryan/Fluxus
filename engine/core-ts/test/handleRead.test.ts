/**
 * Handle-чтение: разрешение имён и побитовая эквивалентность строковому пути
 * (`data-driven-systems` SYS-10).
 *
 * Тест — ВОРОТА эквивалентности двух путей чтения (design D4). Проверяется то,
 * что наблюдаемо: значение каждого поля каждой сущности совпадает у `get` и у
 * `getByHandle` побитово, случай без владения даёт ту же нейтраль и ту же
 * находку ECS-7, а handle переживает и перемотку, и занятие новых слотов
 * хранилища. Плюс отказ разрешения: неизвестное имя — ошибка НА РАЗРЕШЕНИИ, с
 * именем в тексте, а не ноль посреди матча.
 *
 * Чего здесь нет: замера выигрыша — он диагностика (`bench.test.ts`), а не
 * поведение. И теста «через handle нельзя писать»: канала записи не существует
 * по построению — в контракте нет ни одного метода, который отдал бы колонку
 * (ниже это закреплено перечнем поверхности, а не попыткой записи).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  componentNames,
  componentSchema,
  createWorld,
  destroy,
  getField,
  getFieldByHandle,
  hasComponent,
  hasComponentByHandle,
  removeComponent,
  resolveComponentHandle,
  resolveFieldHandle,
  spawn,
  type PrefabDef,
} from '../src/ecs/world.js';
import { withDiagnostics } from '../src/debug.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  NO_ENTITY,
  type ComponentSchema,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type EntityId,
  type SystemContext,
  type WorldState,
} from '../src/types.js';

const Position: ComponentSchema = { name: 'Position', fields: { x: 'fixed', y: 'fixed' } };
const Health: ComponentSchema = { name: 'Health', fields: { current: 'i32', max: 'i32' } };
/** Носитель ссылки: `target` — поле типа `entity`, его нейтраль не ноль (ECS-6). */
const Seeker: ComponentSchema = { name: 'Seeker', fields: { target: 'entity', hits: 'i32' } };
const Note: ComponentSchema = { name: 'Note', fields: { value: 'i32' } };

const SCHEMAS: readonly ComponentSchema[] = [Position, Health, Seeker, Note];

const PREFABS: readonly PrefabDef[] = [
  {
    name: 'hero',
    components: {
      Position: { x: 7, y: -13 },
      Health: { current: 500, max: 640 },
      Seeker: { target: NO_ENTITY, hits: 3 },
      Note: { value: 1 },
    },
  },
  // Ни `Health`, ни `Seeker`: единственный, кем читают «без владения» (ECS-7).
  { name: 'rock', components: { Position: { x: -1, y: 2 }, Note: { value: 0 } } },
];

function world(capacity = 64): WorldState {
  return createWorld(SCHEMAS, PREFABS, capacity);
}

function collector(): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace: 'off', record: (entry) => entries.push(entry) }, entries };
}

/**
 * Сверяет ВСЕ поля ВСЕХ компонентов мира у перечисленных сущностей: строковое
 * чтение против handle-чтения, `Object.is` — чтобы `-0` и `NaN` не проскочили
 * мимо обычного равенства.
 */
function expectParity(state: WorldState, entities: readonly EntityId[]): number {
  let checked = 0;
  for (const component of componentNames(state)) {
    const schema = componentSchema(state, component)!;
    const owner = resolveComponentHandle(state, component);
    for (const field of Object.keys(schema.fields)) {
      const handle = resolveFieldHandle(state, component, field);
      for (const entity of entities) {
        expect(Object.is(getFieldByHandle(state, entity, handle), getField(state, entity, component, field))).toBe(true);
        expect(hasComponentByHandle(state, entity, owner)).toBe(hasComponent(state, entity, component));
        checked++;
      }
    }
  }
  return checked;
}

describe('разрешение имени в handle (SYS-10)', () => {
  it('неизвестный компонент — ошибка на разрешении, с именем в тексте', () => {
    const state = world();
    expect(() => resolveComponentHandle(state, 'Halth')).toThrow(
      /resolveComponent: компонент "Halth" не зарегистрирован/,
    );
    expect(() => resolveFieldHandle(state, 'Halth', 'current')).toThrow(
      /resolveField: компонент "Halth" не зарегистрирован/,
    );
  });

  it('неизвестное поле — ошибка на разрешении, с именем поля в тексте', () => {
    const state = world();
    expect(() => resolveFieldHandle(state, 'Health', 'currnt')).toThrow(
      /resolveField: у компонента "Health" нет поля "currnt"/,
    );
  });

  it('разрешение не зависит ни от сущности, ни от населённости мира', () => {
    const empty = world();
    const populated = world();
    spawn(populated, 'hero');
    spawn(populated, 'rock');
    expect(resolveFieldHandle(empty, 'Health', 'max')).toBe(resolveFieldHandle(populated, 'Health', 'max'));
    // Разные поля — разные адреса; иначе таблица склеила бы колонки.
    expect(resolveFieldHandle(empty, 'Health', 'max')).not.toBe(resolveFieldHandle(empty, 'Health', 'current'));
    expect(resolveFieldHandle(empty, 'Health', 'max')).not.toBe(resolveFieldHandle(empty, 'Position', 'x'));
  });

  it('handle компонента — то же самое, что его битовый id: маску спрашивают им', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    const health = resolveComponentHandle(state, 'Health');
    expect(hasComponentByHandle(state, hero, health)).toBe(true);
    expect(hasComponentByHandle(state, rock, health)).toBe(false);
    // Строковый `has` на незарегистрированном имени отвечает «нет», а не бросает
    // (это вопрос контента), — расхождение с резолвом намеренное и объяснено в
    // `world.ts`: резолв случается один раз до тика, где опечатке и место.
    expect(hasComponent(state, hero, 'Halth')).toBe(false);
  });
});

describe('handle-чтение побитово равно строковому (SYS-10, D4)', () => {
  it('все поля всех компонентов у владельца и у не-владельца', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    // Анти-вакуумность: сверка правда проходит по всем полям всех компонентов.
    expect(expectParity(state, [hero, rock])).toBe(7 * 2);
    // И правда покрывает обе стороны ECS-7.
    expect(getFieldByHandle(state, rock, resolveFieldHandle(state, 'Health', 'current'))).toBe(0);
    expect(getFieldByHandle(state, hero, resolveFieldHandle(state, 'Health', 'current'))).toBe(500);
  });

  it('нейтраль не-владельца — своя у каждого типа поля (ECS-6)', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    expect(getFieldByHandle(state, rock, resolveFieldHandle(state, 'Seeker', 'target'))).toBe(NO_ENTITY);
    expect(getFieldByHandle(state, rock, resolveFieldHandle(state, 'Seeker', 'hits'))).toBe(0);
  });

  it('снятый компонент, мёртвая сущность и мусорный идентификатор — тот же ответ', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const rock = spawn(state, 'rock');
    addComponent(state, rock, 'Health', { current: 777, max: 777 });
    removeComponent(state, rock, 'Health');
    destroy(state, hero);
    expectParity(state, [hero, rock, 999999, -1, 2 ** 47 + 3, 0.5]);
  });

  it('находка ECS-7 у обоих путей одна и та же — код и текст', () => {
    const state = world();
    const rock = spawn(state, 'rock');
    const handle = resolveFieldHandle(state, 'Health', 'current');

    const viaString = collector();
    withDiagnostics(viaString.sink, 5, () => {
      expect(getField(state, rock, 'Health', 'current')).toBe(0);
    });
    const viaHandle = collector();
    withDiagnostics(viaHandle.sink, 5, () => {
      expect(getFieldByHandle(state, rock, handle)).toBe(0);
    });

    expect(viaString.entries).toHaveLength(1);
    expect(viaString.entries[0]!.code).toBe('COMPONENT_READ_WITHOUT_OWNERSHIP');
    // Побитовая эквивалентность включает и диагностику: два пути после
    // разрешения имён — одна функция, а не две согласованных.
    expect(viaHandle.entries).toEqual(viaString.entries);
  });

  it('владеющее чтение по handle записей не порождает — канал не шумит (FP-4)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const handle = resolveFieldHandle(state, 'Health', 'current');
    const { sink, entries } = collector();
    withDiagnostics(sink, 6, () => {
      expect(getFieldByHandle(state, hero, handle)).toBe(500);
    });
    expect(entries).toHaveLength(0);
  });
});

describe('handle переживает жизнь мира (SYS-10)', () => {
  it('занятие новых слотов хранилища не сдвигает адрес поля', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const handle = resolveFieldHandle(state, 'Health', 'current');
    const before = getFieldByHandle(state, hero, handle);

    const spawned: EntityId[] = [];
    for (let i = 0; i < 40; i++) spawned.push(spawn(state, i % 2 === 0 ? 'hero' : 'rock'));

    expect(getFieldByHandle(state, hero, handle)).toBe(before);
    expectParity(state, [hero, ...spawned]);
  });

  it('переиспользование слота читается тем же handle верно (ID-6)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const handle = resolveFieldHandle(state, 'Health', 'current');
    destroy(state, hero);
    const rock = spawn(state, 'rock');
    expect(getFieldByHandle(state, rock, handle)).toBe(0);
    expectParity(state, [hero, rock]);
  });

  it('перемотка под живым handle: он ссылается на поле, а не на буфер (REW-2)', () => {
    const state = world();
    const hero = spawn(state, 'hero');
    const sim: Simulation = { systems: new SystemRegistry(), worldSeed: 1, math: mathApi };
    const simState = initialState(state, 1);

    const handle = resolveFieldHandle(state, 'Health', 'current');
    const snapshot = takeSnapshot(simState);
    expect(getFieldByHandle(state, hero, handle)).toBe(500);

    // Мир уезжает вперёд: новое значение, новая сущность, снятый компонент.
    addComponent(state, hero, 'Health', { current: 42, max: 640 });
    const late = spawn(state, 'rock');
    tick(sim, simState);
    expect(getFieldByHandle(state, hero, handle)).toBe(42);

    restoreSnapshot(simState, snapshot);
    // Тот же handle, разрешённый ДО отката, читает восстановленные данные.
    expect(getFieldByHandle(state, hero, handle)).toBe(500);
    expect(getField(state, hero, 'Health', 'current')).toBe(500);
    expectParity(state, [hero, late]);
  });
});

describe('handle-путь внутри тика (SYS-5, SYS-10)', () => {
  /** Система читает оба пути и кладёт расхождение в `Note.value`. */
  function paritySystem(seen: { checked: number; mismatches: number }): {
    name: string;
    order: number;
    run: (ctx: SystemContext) => void;
  } {
    let handles: { health: ReturnType<SystemContext['resolveField']>; note: ReturnType<SystemContext['resolveComponent']> } | undefined;
    return {
      name: 'Parity',
      order: 10,
      run: (ctx) => {
        // Разрешение — на первом входе в систему, один раз на имя (SYS-10):
        // внутри обхода `resolveField` не зовётся ни разу.
        handles ??= { health: ctx.resolveField('Health', 'current'), note: ctx.resolveComponent('Note') };
        for (const entity of ctx.query({ all: ['Note'] })) {
          if (ctx.hasByHandle(entity, handles.note) !== ctx.has(entity, 'Note')) seen.mismatches++;
          if (ctx.getByHandle(entity, handles.health) !== ctx.get(entity, 'Health', 'current')) seen.mismatches++;
          seen.checked++;
        }
      },
    };
  }

  it('ctx.getByHandle отвечает то же, что ctx.get, и в тике тоже', () => {
    const state = world();
    spawn(state, 'hero');
    spawn(state, 'rock');
    const seen = { checked: 0, mismatches: 0 };
    const registry = new SystemRegistry();
    registry.register(paritySystem(seen));
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    const simState = initialState(state, 1);
    tick(sim, simState);
    tick(sim, simState);
    expect(seen.checked).toBe(4);
    expect(seen.mismatches).toBe(0);
  });

  it('канала записи по handle в контракте нет (TICK-3, CMD-1)', () => {
    const state = world();
    spawn(state, 'hero');
    let surface: string[] = [];
    const registry = new SystemRegistry();
    registry.register({
      name: 'Probe',
      order: 10,
      run: (ctx) => {
        surface = Object.keys(ctx).filter((key) => /handle|resolve/i.test(key));
      },
    });
    tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(state, 1));
    // Ровно четыре: два разрешения и два ЧТЕНИЯ. Ни `setByHandle`, ни выдачи
    // колонки — мутации идут только Command Buffer'ом.
    expect(surface.sort()).toEqual(['getByHandle', 'hasByHandle', 'resolveComponent', 'resolveField']);
  });
});
