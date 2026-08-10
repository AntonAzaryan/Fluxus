/**
 * Поле типа `entity` и закрытый набор типов поля (ECS-3, ECS-6).
 *
 * Проверяется то, что наблюдаемо: ширина контейнера (полный 48-битный
 * `EntityId` переживает запись и чтение, ID-1), кодировка «ссылки нет» (`-1`, а
 * не ноль), судьба ссылки на мёртвую цель (ядро её не трогает), поведение поля
 * в снапшоте и на откате (ID-4, SNAP-1) и отказ на непредставимом значении.
 *
 * Чего здесь нет и быть не может: теста на отсутствие аллокаций в проверке
 * представимости (задача 2.3). Проверка — `Number.isInteger` и два сравнения над
 * числом, без строк на успешном пути и без обхода полей; это свойство кода, а не
 * поведения, и измерять его тестом значило бы мерить сборщик мусора.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  cloneWorld,
  createWorld,
  destroy,
  fromPlain,
  getField,
  isAlive,
  setField,
  spawn,
  toPlain,
  type PrefabDef,
} from '../src/ecs/world.js';
import { createCommandBuffer } from '../src/ecs/commands.js';
import { generationOf, indexOf as rawIndexOf, makeEntityId } from '../src/ecs/entityIndex.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { mathApi } from '../src/math/mathApi.js';
import { NO_ENTITY, type ComponentSchema, type FieldType, type System } from '../src/types.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Носитель ссылки: `target` — поле-ссылка, `hits` — обычный счётчик `i32`. */
const Seeker: ComponentSchema = { name: 'Seeker', fields: { target: 'entity', hits: 'i32' } };
const Mark: ComponentSchema = { name: 'Mark', fields: { id: 'i32', ratio: 'fixed' } };

const SCHEMAS: readonly ComponentSchema[] = [Seeker, Mark];

const PREFABS: readonly PrefabDef[] = [
  // Значения полей не заданы намеренно: их обязаны выдать defaults типа.
  { name: 'seeker', components: { Seeker: {} } },
  { name: 'victim', components: { Mark: { id: 7, ratio: 65536 } } },
];

function world(): ReturnType<typeof createWorld> {
  return createWorld(SCHEMAS, PREFABS, 16);
}

describe('закрытый набор типов поля (ECS-3, ECS-5)', () => {
  it('неизвестное имя типа — ошибка загрузки, называющая компонент, поле и полученное имя', () => {
    const bad: ComponentSchema = { name: 'Flagged', fields: { on: 'bool' as FieldType } };
    expect(() => createWorld([bad])).toThrow(
      /компонент "Flagged", поле "on": неизвестный тип поля "bool"/,
    );
    // Набор перечислен в тексте отказа — иначе автор схемы не знает, из чего выбирать.
    expect(() => createWorld([bad])).toThrow(/i32, fixed, entity/);
  });

  it('entity в наборе есть, и схема с таким полем поднимается', () => {
    expect(() => world()).not.toThrow();
  });
});

describe('«ссылки нет» — -1, а не ноль (ECS-6)', () => {
  it('поле entity, не заданное ни prefab, ни defaults, означает «ссылки нет»', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    expect(getField(state, seeker, 'Seeker', 'target')).toBe(NO_ENTITY);
    // Соседнее поле `i32` при этом получает ноль: нейтральное значение — своё у каждого типа.
    expect(getField(state, seeker, 'Seeker', 'hits')).toBe(0);
  });

  it('первая же аллоцированная сущность имеет EntityId 0 — потому и не он значит «нет ссылки»', () => {
    const state = world();
    const first = spawn(state, 'victim');
    expect(first).toBe(0);
    expect(NO_ENTITY).not.toBe(first);
  });

  it('addComponent без значений тоже даёт «ссылки нет»', () => {
    const state = world();
    const entity = spawn(state, 'victim');
    addComponent(state, entity, 'Seeker');
    expect(getField(state, entity, 'Seeker', 'target')).toBe(NO_ENTITY);
  });

  it('чтение по чужому идентификатору даёт «ссылки нет», а не сущность нулевого слота', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    setField(state, seeker, 'Seeker', 'target', seeker);
    // Идентификатор за пределами мира: слот 999 при capacity 16. Массива под
    // ним нет, и нейтральное значение обязано быть нейтральным для ТИПА поля —
    // иначе мусорная ссылка читалась бы как валидная ссылка на слот 0.
    const foreign = makeEntityId(999, 0);
    expect(rawIndexOf(foreign)).toBeGreaterThan(16);
    expect(getField(state, foreign, 'Seeker', 'target')).toBe(NO_ENTITY);
    expect(getField(state, foreign, 'Seeker', 'hits')).toBe(0);
    // То же для кода «ссылки нет», случайно попавшего в позицию адресата.
    expect(getField(state, NO_ENTITY, 'Seeker', 'target')).toBe(NO_ENTITY);
  });

  it('default схемы поверх типа задаёт своё значение', () => {
    const withDefault: ComponentSchema = {
      name: 'Bound',
      fields: { target: 'entity' },
      defaults: { target: 0 },
    };
    const state = createWorld([withDefault], [{ name: 'bound', components: { Bound: {} } }], 8);
    expect(getField(state, spawn(state, 'bound'), 'Bound', 'target')).toBe(0);
  });
});

describe('ширина контейнера поля entity (ECS-6, ID-1)', () => {
  it('полный EntityId с generation ≥ 256 читается без потерь', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    // generation 300 — за пределами 32 бит вместе с индексом: 2^24 * 300 > 2^32.
    const reference = makeEntityId(5, 300);
    expect(reference).toBeGreaterThan(2 ** 32);

    setField(state, seeker, 'Seeker', 'target', reference);
    const read = getField(state, seeker, 'Seeker', 'target');
    expect(read).toBe(reference);
    // Идентификатор распаковывается в то же, из чего собран, — усечения не было.
    expect(rawIndexOf(read)).toBe(5);
    expect(generationOf(read)).toBe(300);
  });

  it('тот же идентификатор в поле i32 — ошибка записи, а не усечение (ECS-3)', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    const reference = makeEntityId(5, 300);
    expect(() => { setField(state, seeker, 'Seeker', 'hits', reference); }).toThrow(
      /setField: компонент "Seeker", поле "hits" типа i32 — значение \d+ непредставимо \(ECS-3\)/,
    );
    // Мир при отказе не тронут: усечённого значения в поле не осталось.
    expect(getField(state, seeker, 'Seeker', 'hits')).toBe(0);
  });

  it('поле entity принимает предел упаковки и отвергает значение за ним', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    const max = makeEntityId(2 ** 24 - 1, 2 ** 24 - 1);
    setField(state, seeker, 'Seeker', 'target', max);
    expect(getField(state, seeker, 'Seeker', 'target')).toBe(max);
    expect(() => { setField(state, seeker, 'Seeker', 'target', max + 1); }).toThrow(/непредставимо/);
    // Отрицательное значение — только код «ссылки нет»; прочие идентификаторами не бывают (ID-1).
    expect(() => { setField(state, seeker, 'Seeker', 'target', -2); }).toThrow(/непредставимо/);
  });
});

describe('непредставимое значение — ошибка, а не усечение (ECS-3)', () => {
  it('границы i32 и fixed пишутся штатно: завёрнутое по FP-4 значение представимо', () => {
    const state = world();
    const entity = spawn(state, 'victim');
    for (const value of [INT32_MIN, INT32_MAX, 0, -1]) {
      setField(state, entity, 'Mark', 'ratio', value);
      expect(getField(state, entity, 'Mark', 'ratio')).toBe(value);
      setField(state, entity, 'Mark', 'id', value);
      expect(getField(state, entity, 'Mark', 'id')).toBe(value);
    }
  });

  it('значение за границей 32 бит и нецелое отвергаются', () => {
    const state = world();
    const entity = spawn(state, 'victim');
    expect(() => { setField(state, entity, 'Mark', 'id', INT32_MAX + 1); }).toThrow(/непредставимо/);
    expect(() => { setField(state, entity, 'Mark', 'id', INT32_MIN - 1); }).toThrow(/непредставимо/);
    expect(() => { setField(state, entity, 'Mark', 'ratio', 1.5); }).toThrow(/непредставимо/);
  });

  it('буфер команд отказывает до первой мутации мира (SYS-9)', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    const commands = createCommandBuffer(state);
    commands.setField(seeker, 'Seeker', 'hits', 1);
    commands.setField(seeker, 'Seeker', 'hits', makeEntityId(1, 1000));
    expect(() => { commands.flush(); }).toThrow(/непредставимо/);
    // Первая команда буфера тоже не применилась: единица атомарности — весь flush.
    expect(getField(state, seeker, 'Seeker', 'hits')).toBe(0);
  });

  it('непредставимое значение отвергается и в prefab, и в defaults, и в overrides спавна', () => {
    const big = makeEntityId(1, 1000);
    expect(() =>
      createWorld([Seeker], [{ name: 'bad', components: { Seeker: { hits: big } } }]),
    ).toThrow(/prefab "bad".*поле "hits" типа i32/s);
    expect(() =>
      createWorld([{ name: 'Bad', fields: { hits: 'i32' }, defaults: { hits: big } }]),
    ).toThrow(/поле "hits" типа i32: default \d+ непредставим/);

    const state = world();
    expect(() => spawn(state, 'seeker', { Seeker: { hits: big } })).toThrow(/непредставимо/);
  });
});

describe('ссылка — данные, а не адрес (ECS-6)', () => {
  it('цель убита, слот переиспользован: поле не изменилось, живость по полному ID — «невалидна»', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    const victim = spawn(state, 'victim');
    setField(state, seeker, 'Seeker', 'target', victim);

    destroy(state, victim);
    const newborn = spawn(state, 'victim');
    // Слот тот же, поколение другое — именно тот случай, от которого защищают поколения.
    expect(rawIndexOf(newborn)).toBe(rawIndexOf(victim));
    expect(newborn).not.toBe(victim);

    const stored = getField(state, seeker, 'Seeker', 'target');
    expect(stored).toBe(victim);
    expect(isAlive(state, stored)).toBe(false);
    expect(isAlive(state, newborn)).toBe(true);
  });

  it('удаление сущности не чистит ссылающиеся на неё поля', () => {
    const state = world();
    const victim = spawn(state, 'victim');
    const seekers = [spawn(state, 'seeker'), spawn(state, 'seeker'), spawn(state, 'seeker')];
    for (const seeker of seekers) setField(state, seeker, 'Seeker', 'target', victim);

    destroy(state, victim);
    for (const seeker of seekers) {
      expect(getField(state, seeker, 'Seeker', 'target')).toBe(victim);
    }
  });
});

describe('поле entity в снапшоте и на откате (ID-4, SNAP-1)', () => {
  it('plain-форма несёт значение поля целым, и восстановление возвращает его как есть', () => {
    const state = world();
    const seeker = spawn(state, 'seeker');
    const reference = makeEntityId(3, 400);
    setField(state, seeker, 'Seeker', 'target', reference);

    const plain = toPlain(state);
    expect(plain.components.Seeker!.target).toContain(reference);
    // Ни одного нецелого в снапшоте: контейнер 48-битный, значения точные.
    for (const value of plain.components.Seeker!.target!) expect(Number.isInteger(value)).toBe(true);

    const restored = fromPlain(plain, SCHEMAS, PREFABS);
    expect(getField(restored, seeker, 'Seeker', 'target')).toBe(reference);
    expect(getField(cloneWorld(state), seeker, 'Seeker', 'target')).toBe(reference);
  });

  it('откат на тик до смерти цели делает ссылку снова валидной', () => {
    const registry = new SystemRegistry();
    // Убивает цель на тике 2 и на тике 3 спавнит замену в тот же слот.
    const reaper: System = {
      name: 'Reaper',
      order: 10,
      run(ctx) {
        if (ctx.tick === 2) {
          for (const entity of ctx.query({ all: ['Mark'] })) ctx.commands.destroy(entity);
        }
        if (ctx.tick === 3) ctx.commands.spawn('victim');
      },
    };
    registry.register(reaper);

    const state = world();
    const seeker = spawn(state, 'seeker');
    const victim = spawn(state, 'victim');
    setField(state, seeker, 'Seeker', 'target', victim);

    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    const simState = initialState(state, 1);
    const history = new RingHistory({ interval: 1, capacity: 8 });
    const inputs = createInputLog();
    history.record(simState);
    while (simState.tick < 3) {
      inputs.record(simState.tick + 1, []);
      tick(sim, simState);
      history.record(simState);
    }

    // Цель мертва, её слот занят новой сущностью, ссылка невалидна.
    expect(getField(simState.world, seeker, 'Seeker', 'target')).toBe(victim);
    expect(isAlive(simState.world, victim)).toBe(false);

    const controller = createRewindController(sim, simState, { history, inputs });
    controller.pause();
    controller.beginRewind();
    controller.seekTo(1);

    // Поколение слота откатилось вместе с полем — собственного механизма у ссылок нет.
    expect(getField(simState.world, seeker, 'Seeker', 'target')).toBe(victim);
    expect(isAlive(simState.world, victim)).toBe(true);
  });
});

describe('prefab и переопределение полей при спавне (ECS-4, CMD-6)', () => {
  it('prefab задаёт ссылку, а override при спавне её перекрывает', () => {
    const state = world();
    const first = spawn(state, 'victim');
    const second = spawn(state, 'victim');
    const bound = createWorld(
      SCHEMAS,
      [{ name: 'bound', components: { Seeker: { target: first } } }],
      16,
    );
    expect(getField(bound, spawn(bound, 'bound'), 'Seeker', 'target')).toBe(first);

    const overridden = spawn(state, 'seeker', { Seeker: { target: second } });
    expect(getField(state, overridden, 'Seeker', 'target')).toBe(second);
    // Второй спавн того же prefab'а override не наследует.
    expect(getField(state, spawn(state, 'seeker'), 'Seeker', 'target')).toBe(NO_ENTITY);
  });

  it('override «ссылки нет» отличим от отсутствия override', () => {
    const state = world();
    const target = spawn(state, 'victim');
    const bound = createWorld(
      SCHEMAS,
      [{ name: 'bound', components: { Seeker: { target } } }],
      16,
    );
    const cleared = spawn(bound, 'bound', { Seeker: { target: NO_ENTITY } });
    expect(getField(bound, cleared, 'Seeker', 'target')).toBe(NO_ENTITY);
    expect(getField(bound, spawn(bound, 'bound'), 'Seeker', 'target')).toBe(target);
  });
});
