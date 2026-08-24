import { describe, expect, it } from 'vitest';
import {
  addTag,
  createWorld,
  cloneWorld,
  destroy,
  getField,
  hasComponent,
  hasTag,
  indexOf,
  isAlive,
  listAlive,
  setField,
  spawn,
  toPlain,
  type PrefabDef,
} from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { indexOf as rawIndexOf } from '../src/ecs/entityIndex.js';
import { createCommandBuffer } from '../src/ecs/commands.js';
import * as core from '../src/index.js';
import { NO_ENTITY, type ComponentSchema } from '../src/types.js';

const Position: ComponentSchema = { name: 'Position', fields: { x: 'fixed', y: 'fixed' } };
const Health: ComponentSchema = { name: 'Health', fields: { hp: 'i32' }, defaults: { hp: 100 } };
const Stealth: ComponentSchema = { name: 'Stealth', fields: { flag: 'i32' } };

const schemas = [Position, Health, Stealth];

function prefab(
  name: string,
  components: PrefabDef['components'],
  tags?: readonly string[],
): PrefabDef {
  return { name, components, tags };
}

describe('createWorld: prefab (ECS-5)', () => {
  it('роняет загрузку prefab со ссылкой на несуществующее поле', () => {
    expect(() =>
      createWorld(schemas, [prefab('Bad', { Health: { notAField: 1 } })]),
    ).toThrow(/notAField/);
  });

  it('роняет загрузку prefab со ссылкой на несуществующий компонент', () => {
    expect(() => createWorld(schemas, [prefab('Bad2', { Ghost: {} })])).toThrow(/Ghost/);
  });

  it('роняет загрузку схемы, чей default ссылается на несуществующее поле', () => {
    const Bad: ComponentSchema = { name: 'Bad', fields: { a: 'i32' }, defaults: { b: 1 } };
    expect(() => createWorld([Bad], [])).toThrow(/b/);
  });
});

describe('spawn/destroy: ID-1..3, DET-6', () => {
  it('ID-2/DET-6: последовательный спавн даёт одинаковые ID при повторном прогоне с нуля', () => {
    const scenario = () => {
      const world = createWorld(schemas, [prefab('P', { Health: {} })]);
      return [spawn(world, 'P'), spawn(world, 'P'), spawn(world, 'P')];
    };
    const first = scenario();
    const second = scenario();
    expect(second).toEqual(first);

    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = [spawn(world, 'P'), spawn(world, 'P'), spawn(world, 'P')];
    expect(ids.map((e) => indexOf(world, e))).toEqual([
      indexOf(world, ids[0]!),
      indexOf(world, ids[0]!) + 1,
      indexOf(world, ids[0]!) + 2,
    ]);
  });

  it('ID-1/ID-3: старая ссылка на переиспользованный слот невалидна', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })], 4);
    const a = spawn(world, 'P');
    const indexA = indexOf(world, a);
    destroy(world, a);
    const b = spawn(world, 'P'); // переиспользует слот a

    expect(indexOf(world, b)).toBe(indexA); // слот действительно переиспользован
    expect(a).not.toBe(b); // generation другой — ссылки различны
    expect(isAlive(world, a)).toBe(false); // старая ссылка невалидна
    expect(isAlive(world, b)).toBe(true);
  });
});

describe('Query (QUERY-1..3)', () => {
  it('QUERY-1: all + not + withinRadius + withTag отбирает ровно нужное; граница радиуса включена', () => {
    const prefabs = [
      prefab('Enemy', { Position: {}, Health: {} }, ['enemy']),
      prefab('StealthEnemy', { Position: {}, Health: {}, Stealth: { flag: 1 } }, ['enemy']),
      prefab('Ally', { Position: {}, Health: {} }, ['ally']),
    ];
    const world = createWorld(schemas, prefabs);

    const onBoundary = spawn(world, 'Enemy'); // (3,4) — dist ровно 5
    setField(world, onBoundary, 'Position', 'x', 3);
    setField(world, onBoundary, 'Position', 'y', 4);

    const outside = spawn(world, 'Enemy'); // (3,5) — dist sqrt(34) > 5
    setField(world, outside, 'Position', 'x', 3);
    setField(world, outside, 'Position', 'y', 5);

    const stealthy = spawn(world, 'StealthEnemy'); // в радиусе, но со Stealth — исключён `not`
    setField(world, stealthy, 'Position', 'x', 0);
    setField(world, stealthy, 'Position', 'y', 0);

    const ally = spawn(world, 'Ally'); // в радиусе, но не тот тег
    setField(world, ally, 'Position', 'x', 1);
    setField(world, ally, 'Position', 'y', 1);

    const result = query(world, {
      all: ['Health', 'Position'],
      not: ['Stealth'],
      withTag: 'enemy',
      withinRadius: { center: { x: 0, y: 0 }, radius: 5 },
    });

    expect(Array.from(result)).toEqual([onBoundary]);
  });

  it('QUERY-1: пустой набор компонентов не сужает выборку', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = [spawn(world, 'P'), spawn(world, 'P')];

    expect(Array.from(query(world, {}))).toEqual(ids);
    expect(Array.from(query(world, { all: [], any: [], not: [] }))).toEqual(ids);
    // Пустой `any` эквивалентен отсутствующему, хотя «хотя бы один из ни одного» ложно.
    expect(Array.from(query(world, { all: ['Health'], any: [] }))).toEqual(ids);
  });

  it('QUERY-1: неизвестный компонент — пустой результат в all/any, но не отсеивает в not', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = [spawn(world, 'P'), spawn(world, 'P')];

    // Невыполнимое требование — выборка пуста; ошибкой это не считается: состав
    // компонентов зависит от сцены.
    expect(query(world, { all: ['Ghost'] }).length).toBe(0);
    expect(query(world, { all: ['Health'], any: ['Ghost'] }).length).toBe(0);
    // Невыполнимый запрет — выборка полная.
    expect(Array.from(query(world, { not: ['Ghost'] }))).toEqual(ids);
    expect(Array.from(query(world, { all: ['Health'], not: ['Ghost'] }))).toEqual(ids);
  });

  it('QUERY-2: порядок обхода одинаков при повторных прогонах, включая переиспользование слотов', () => {
    const scenario = () => {
      const world = createWorld(schemas, [prefab('P', { Health: {} })]);
      const a = spawn(world, 'P');
      spawn(world, 'P');
      destroy(world, a);
      spawn(world, 'P'); // переиспользует слот a
      spawn(world, 'P');
      return Array.from(query(world, { all: ['Health'] }));
    };

    const first = scenario();
    const second = scenario();
    expect(second).toEqual(first);

    // QUERY-2: порядок по возрастанию RAW-ИНДЕКСА, а не значения EntityId.
    // Переиспользованный слот 0 несёт бо́льший generation, то есть больший id,
    // но обходится первым — порядок задаётся слотом, а не идентификатором.
    const indices = first.map((id) => rawIndexOf(id));
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
    expect(first[0]).toBeGreaterThan(first[1]!); // именно тот случай, когда id убывает
  });

  it('QUERY-3: система удаляет часть найденных сущностей в цикле — снапшот стабилен', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = [spawn(world, 'P'), spawn(world, 'P'), spawn(world, 'P')];
    const result = query(world, { all: ['Health'] });
    expect(result.length).toBe(3);

    let visited = 0;
    for (const entity of result) {
      destroy(world, entity); // мутация мира прямо во время обхода снапшота
      visited += 1;
    }

    expect(visited).toBe(3); // ни пропусков, ни повторов
    expect(Array.from(result)).toEqual([...ids].sort((a, b) => a - b));
    expect(listAlive(world).length).toBe(0); // мир действительно опустел
  });

  it('QUERY-3: вложенный запрос не портит результат внешнего', () => {
    const world = createWorld(schemas, [
      prefab('P', { Health: {} }),
      prefab('Q', { Health: {}, Stealth: {} }),
    ]);
    const outer = [spawn(world, 'P'), spawn(world, 'P'), spawn(world, 'P')];
    spawn(world, 'Q');

    const result = query(world, { all: ['Health'], not: ['Stealth'] });
    const before = Array.from(result);

    // Регресс на общий переиспользуемый буфер: будь результат общим, внутренний
    // запрос с другой спецификацией затёр бы набор, по которому идёт обход.
    const visited: number[] = [];
    for (const entity of result) {
      query(world, { all: ['Stealth'] });
      visited.push(entity);
    }

    expect(visited).toEqual(outer);
    expect(Array.from(result)).toEqual(before);
  });
});

describe('чтение отложенного из буфера (CMD-5)', () => {
  it('значение видно до flush, а отсутствие команды отличимо от значения', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const commands = createCommandBuffer(world);

    expect(commands.peekField(e, 'Health', 'hp')).toBeUndefined();
    commands.setField(e, 'Health', 'hp', 42);
    expect(commands.peekField(e, 'Health', 'hp')).toBe(42);
    // Мир до flush не тронут — точечное чтение буфера этого не меняет.
    expect(getField(world, e, 'Health', 'hp')).toBe(100);
  });

  it('побеждает последняя команда — то же, что окажется в мире (CMD-3)', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const commands = createCommandBuffer(world);

    commands.setField(e, 'Health', 'hp', 1);
    commands.setField(e, 'Health', 'hp', 2);
    expect(commands.peekField(e, 'Health', 'hp')).toBe(2);

    commands.flush();
    expect(getField(world, e, 'Health', 'hp')).toBe(2);
    // Буфер очищен: отложенного больше нет, читатель падает на состояние мира.
    expect(commands.peekField(e, 'Health', 'hp')).toBeUndefined();
  });

  it('addComponent в буфере тоже определяет поле: чтение совпадает с миром после flush (CMD-5, CMD-3)', () => {
    const Ref: ComponentSchema = { name: 'Ref', fields: { target: 'entity' } };
    const world = createWorld([...schemas, Ref], [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const commands = createCommandBuffer(world);

    // Значение, привезённое самим addComponent, видно до flush.
    commands.addComponent(e, 'Stealth', { flag: 7 });
    expect(commands.peekField(e, 'Stealth', 'flag')).toBe(7);

    // addComponent после setField перекрывает его default'ом схемы (CMD-3).
    commands.setField(e, 'Health', 'hp', 5);
    commands.addComponent(e, 'Health');
    expect(commands.peekField(e, 'Health', 'hp')).toBe(100);

    // Поле без values и без default получает нейтральное значение типа (ECS-6).
    commands.addComponent(e, 'Ref');
    expect(commands.peekField(e, 'Ref', 'target')).toBe(NO_ENTITY);

    // setField после addComponent побеждает как более поздняя команда (CMD-3).
    commands.addComponent(e, 'Position');
    commands.setField(e, 'Position', 'x', 42);
    expect(commands.peekField(e, 'Position', 'x')).toBe(42);

    commands.flush();
    expect(getField(world, e, 'Stealth', 'flag')).toBe(7);
    expect(getField(world, e, 'Health', 'hp')).toBe(100);
    expect(getField(world, e, 'Ref', 'target')).toBe(NO_ENTITY);
    expect(getField(world, e, 'Position', 'x')).toBe(42);
  });
});

describe('Command Buffer (CMD-1..5)', () => {
  it('CMD-5: query видит сущность до flush, даже после команды на её удаление', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const commands = createCommandBuffer(world);

    commands.destroy(e);
    expect(Array.from(query(world, { all: ['Health'] }))).toContain(e);

    commands.flush();
    expect(Array.from(query(world, { all: ['Health'] }))).not.toContain(e);
  });

  it('CMD-3: две команды на одно поле применяются в порядке создания', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const commands = createCommandBuffer(world);

    commands.setField(e, 'Health', 'hp', 10);
    commands.setField(e, 'Health', 'hp', 20);
    commands.flush();
    expect(getField(world, e, 'Health', 'hp')).toBe(20);

    const commands2 = createCommandBuffer(world);
    commands2.setField(e, 'Health', 'hp', 20);
    commands2.setField(e, 'Health', 'hp', 10);
    commands2.flush();
    expect(getField(world, e, 'Health', 'hp')).toBe(10); // порядок, не значение, определяет итог
  });

  it('CMD-2: спавн и структурная команда видны следующей "системе" сразу после flush', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const commands = createCommandBuffer(world);
    commands.spawn('P');
    commands.flush();
    expect(query(world, { all: ['Health'] }).length).toBe(1);
  });

  it('ID-6/CMD-1: порядок освобождения слотов задан порядком применения команд', () => {
    // По CMD-3 порядок применения совпадает с порядком создания, поэтому этот
    // тест сам по себе их не разводит; момент «слот входит в список при flush,
    // а не при постановке» пришпиливает соседний тест с CMD-1.
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = Array.from({ length: 4 }, () => spawn(world, 'P')); // слоты 0..3

    const commands = createCommandBuffer(world);
    commands.destroy(ids[1]!); // применится первым — слот 1 ложится в список
    commands.destroy(ids[3]!); // применится вторым — слот 3 оказывается на вершине
    commands.flush();

    // Стек, а не очередь и не «наименьший свободный»: сперва 3, потом 1.
    expect(rawIndexOf(spawn(world, 'P'))).toBe(3);
    expect(rawIndexOf(spawn(world, 'P'))).toBe(1);
  });

  it('ID-6/CMD-1: слот попадает в список на flush, а не в момент постановки команды', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const ids = Array.from({ length: 3 }, () => spawn(world, 'P')); // слоты 0..2

    // Спавн поставлен ДО destroy, значит и применится раньше: на его момент
    // список свободных слотов ещё пуст, и он берёт очередной новый слот.
    const early = createCommandBuffer(world);
    early.spawn('P');
    early.destroy(ids[0]!);
    early.flush();
    const spawned = Array.from(listAlive(world), rawIndexOf);
    expect(spawned).toEqual([1, 2, 3]); // слот 0 освобождён, новая сущность — в слоте 3

    // Тот же порядок постановки наоборот: destroy применяется первым, и спавн
    // видит уже непустой список — то есть содержимое стека определяет flush.
    const late = createCommandBuffer(world);
    late.destroy(ids[1]!);
    late.spawn('P');
    late.flush();
    expect(Array.from(listAlive(world), rawIndexOf)).toEqual([1, 2, 3]); // слот 1 переиспользован
  });

  it('CMD-7: команда к сущности, убитой в этом же буфере, не достаётся новой сущности того же слота', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');

    const commands = createCommandBuffer(world);
    commands.destroy(e);
    commands.spawn('P'); // на flush займёт освободившийся слот e
    commands.setField(e, 'Health', 'hp', 7);
    commands.flush();

    expect(isAlive(world, e)).toBe(false);
    const alive = listAlive(world);
    expect(alive.length).toBe(1);
    const reused = alive[0]!;
    expect(rawIndexOf(reused)).toBe(rawIndexOf(e)); // тот же слот, другое поколение
    expect(reused).not.toBe(e);
    expect(getField(world, reused, 'Health', 'hp')).toBe(100); // default prefab'а, не 7
  });

  it('CMD-7: команда к сущности, убитой предыдущей системой, отбрасывается молча', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');

    const previousSystem = createCommandBuffer(world);
    previousSystem.destroy(e);
    previousSystem.flush();

    const commands = createCommandBuffer(world);
    commands.setField(e, 'Health', 'hp', 7);
    commands.addComponent(e, 'Stealth', { flag: 1 });
    commands.removeComponent(e, 'Health');
    commands.destroy(e);
    expect(() => { commands.flush(); }).not.toThrow();
    expect(listAlive(world).length).toBe(0);
  });

  it('addComponent/removeComponent через буфер меняют принадлежность компонента', () => {
    const world = createWorld(schemas, [prefab('P', {})]);
    const e = spawn(world, 'P');
    expect(hasComponent(world, e, 'Health')).toBe(false);

    const commands = createCommandBuffer(world);
    commands.addComponent(e, 'Health', { hp: 42 });
    commands.flush();
    expect(hasComponent(world, e, 'Health')).toBe(true);
    expect(getField(world, e, 'Health', 'hp')).toBe(42);

    const commands2 = createCommandBuffer(world);
    commands2.removeComponent(e, 'Health');
    commands2.flush();
    expect(hasComponent(world, e, 'Health')).toBe(false);
  });
});

describe('теги сущности', () => {
  it('первый тег заводит хранилище под индекс, второй ложится в него же', () => {
    // Prefab без тегов хранилища не создаёт вовсе — набор тегов разрежен, и
    // пустое множество на каждую сущность было бы платой ни за что.
    const world = createWorld(schemas, [prefab('Bare', { Health: {} })]);
    const bare = spawn(world, 'Bare');
    expect(hasTag(world, bare, 'lit')).toBe(false);
    expect(toPlain(world).tags).toEqual([]);

    addTag(world, bare, 'lit');
    expect(hasTag(world, bare, 'lit')).toBe(true);

    addTag(world, bare, 'burning');
    expect(hasTag(world, bare, 'burning')).toBe(true);
    // Первый тег не потерян при появлении второго; в форме они отсортированы (SER-6).
    expect(toPlain(world).tags).toEqual([[indexOf(world, bare), ['burning', 'lit']]]);
  });

  it('повторный тег ничего не меняет, а запрос по мёртвой сущности — false', () => {
    const world = createWorld(schemas, [prefab('Bare', { Health: {} })]);
    const bare = spawn(world, 'Bare');
    addTag(world, bare, 'lit');
    addTag(world, bare, 'lit');
    expect(toPlain(world).tags).toEqual([[indexOf(world, bare), ['lit']]]);

    destroy(world, bare);
    expect(hasTag(world, bare, 'lit')).toBe(false);
  });
});

describe('cloneWorld', () => {
  it('клон не делит состояние с оригиналом', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    const e = spawn(world, 'P');
    const copy = cloneWorld(world);

    setField(copy, e, 'Health', 'hp', 999);
    destroy(copy, e);

    expect(getField(world, e, 'Health', 'hp')).toBe(100);
    expect(isAlive(world, e)).toBe(true);
    expect(isAlive(copy, e)).toBe(false);
  });

  it('клон не мешает дальнейшему детерминированному спавну в оригинале', () => {
    const world = createWorld(schemas, [prefab('P', { Health: {} })]);
    spawn(world, 'P');
    const copy = cloneWorld(world);
    spawn(copy, 'P'); // мутирует только копию

    const nextInOriginal = spawn(world, 'P');
    const worldFresh = createWorld(schemas, [prefab('P', { Health: {} })]);
    spawn(worldFresh, 'P');
    const nextInFresh = spawn(worldFresh, 'P');

    expect(nextInOriginal).toBe(nextInFresh); // клон не повлиял на генерацию ID оригинала
  });
});

describe('capacity', () => {
  it('spawn за пределами capacity падает с явной ошибкой, а не портит данные', () => {
    // Свой EntityIndex выдаёт индексы с нуля, поэтому capacity=2 вмещает ровно
    // две сущности. Молчаливая порча тут особенно коварна: запись за границу
    // Int32Array в JS не бросает, а просто теряется.
    const world = createWorld(schemas, [prefab('P', { Health: {} })], 2);
    spawn(world, 'P');
    spawn(world, 'P');
    expect(() => spawn(world, 'P')).toThrow(/capacity/);
  });
});

describe('публичная поверхность пакета (TICK-3)', () => {
  it('наружу уходит только чтение мира плюс явный worldInit-хелпер', () => {
    const mutators = [
      'spawn',
      'destroy',
      'setField',
      'addComponent',
      'removeComponent',
      'addTag',
      'createWorld',
      'fromPlain',
      'copyWorldInto',
      'clearDirty',
      'componentMasks', // отдаёт живой Uint32Array мира — тоже запись
    ];
    for (const name of mutators) {
      expect(core.world).not.toHaveProperty(name);
    }
    expect(typeof core.world.getField).toBe('function');
    expect(typeof core.world.listAlive).toBe('function');
    // Единственный мутатор в поверхности — с назначением в имени (TICK-3, исключение 1).
    expect(typeof core.worldInitSpawn).toBe('function');
  });
});
