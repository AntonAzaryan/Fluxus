/**
 * Модель блоков DSL (ED-4, ED-5) — материал редактора триггеров и конструктора
 * выражений.
 *
 * Проверяется здесь одно, но с разных сторон: **в редакторе нет ни одного
 * правила DSL** (ED-1). Каждое утверждение о том, что автору можно предложить,
 * сверяется с тем, что принимает ядро, — вызовом самого ядра в тесте, а не
 * вторым перечнем в ожидании. Поэтому «пикер предлагает ровно то, что
 * принимает `componentSchema`» здесь не читается как список имён: для каждого
 * предложенного имени собирается система, и её судит `validateSystem`.
 *
 * Так же проверена и конвенция слотов (SYS-3): вместо сверки с таблицей —
 * зонд на каждый слот, показывающий, что ядро этот аргумент действительно
 * обходит, и контрольный зонд на аргумент вне конвенции, о содержимом которого
 * ядро не говорит ничего. Разъехаться модель и ядро могут только вместе с этим
 * тестом.
 */
import {
  actions,
  expr,
  loadScene,
  validateSystem,
  world as coreWorld,
  type SceneDef,
  type SystemDef,
} from '@game-mvp/core';
import { describe, expect, it } from 'vitest';
import {
  actionBlock,
  actionCatalog,
  boundNamesAt,
  buildAction,
  buildExpression,
  conventionSlot,
  dslCatalog,
  dslWorldView,
  loadDslWorld,
  operatorBlock,
  operatorCatalog,
  readActionNode,
  readExpressionNode,
  CONVENTION_SLOTS,
  QUERY_SLOTS,
} from '../src/dsl/index.js';
import { descriptionKey } from '../src/i18n/keys.js';
import { EDITOR_BUNDLES } from '../src/i18n/editorBundles.js';
import type { JsonObject, JsonValue } from '../src/document/json.js';

/**
 * Сцена-фикстура: минимум, на котором различимы все четыре пикера. `fog`
 * включён ради компонентов, которых в документе нет вовсе, — их дописывает
 * загрузчик (FOW-1..3), и мир знает о них, а разбор документа не знал бы.
 */
const SCENE_VALUE = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { hp: 'i32', max: 'i32' } },
    { name: 'Dead', fields: { atTick: 'i32' } },
  ],
  prefabs: [
    { name: 'grunt', components: { Position: { x: 0, y: 0 }, Health: { hp: 10, max: 10 } } },
    { name: 'boom', components: { Position: { x: 0, y: 0 } } },
  ],
  capacity: 16,
  fog: true,
  // Туман войны без террейна загрузчик отвергает (SER-7): фильтру по уровню
  // (FOW-5) не у кого спросить уровень сущности. Сетка ровная и минимальная —
  // предмет теста в пикерах, а не в рельефе.
  terrain: {
    width: 2,
    height: 2,
    tileSize: 65536,
    levels: ['00', '00'],
    flags: ['..', '..'],
  },
};

const world = (): ReturnType<typeof loadScene>['world'] =>
  loadScene(SCENE_VALUE as unknown as SceneDef).world;

const view = () => loadDslWorld(SCENE_VALUE as unknown as JsonValue)!;

/** Годна ли система по мнению ядра — единственный судья во всём этом файле. */
function accepted(def: JsonValue): boolean {
  try {
    validateSystem(def as unknown as SystemDef, world());
    return true;
  } catch {
    return false;
  }
}

/** Сообщение отказа ядра; пусто — ядро приняло. */
function rejection(def: JsonValue): string {
  try {
    validateSystem(def as unknown as SystemDef, world());
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Система из одного действия — оболочка зондов. */
function systemOf(action: JsonValue, extra: JsonObject = {}): JsonValue {
  return { name: 'probe', order: 1, ...extra, do: [action] };
}

describe('ED-5: каталог блоков — закрытые наборы ядра и ничего больше', () => {
  const catalog = dslCatalog();

  it('действия каталога — ровно `actionNames` ядра, в обе стороны', () => {
    expect(catalog.actions.map((block) => block.name)).toEqual([...actions.actionNames].sort());
  });

  it('операторы каталога — ровно `operators` ядра, в обе стороны', () => {
    expect(catalog.operators.map((block) => block.name)).toEqual([...expr.operators].sort());
  });

  it('у каждого имени есть ключ описания, и он выведен из пути (ED-28)', () => {
    const en = EDITOR_BUNDLES.en!;
    const ru = EDITOR_BUNDLES.ru!;
    for (const block of catalog.actions) {
      expect(block.descriptionKey).toBe(descriptionKey(['action', block.name]));
      expect(en[block.descriptionKey], block.name).toBeDefined();
      expect(ru[block.descriptionKey], block.name).toBeDefined();
    }
    for (const block of catalog.operators) {
      expect(block.descriptionKey).toBe(descriptionKey(['operator', block.name]));
      expect(en[block.descriptionKey], block.name).toBeDefined();
      expect(ru[block.descriptionKey], block.name).toBeDefined();
    }
  });

  it('точка в имени оператора экранирована ключом, а не съедена им', () => {
    const block = catalog.operators.find((found) => found.name === 'vec.add')!;
    expect(block.descriptionKey).toBe('operator.vec\\.add');
  });

  it('форму имеют ровно те операторы, у которых ядро называет литеральные позиции', () => {
    const structured = catalog.operators.filter((block) => !block.variadic).map((block) => block.name);
    expect(structured).toEqual([
      'eventField',
      'getComponent',
      'hasComponent',
      'raycastEntity',
      'raycastHit',
      'raycastPoint',
      'var',
    ]);
    // Необязательная литеральная позиция формы не отменяет: маска луча —
    // четвёртый аргумент, а первые три остаются выражениями (EXPR-8).
    expect(catalog.operators.find((block) => block.name === 'raycastHit')?.args).toEqual([
      'expression',
      'expression',
      'expression',
      'tag',
    ]);
    expect(catalog.operators.find((block) => block.name === 'getComponent')?.args).toEqual([
      'expression',
      'component',
      'field',
    ]);
    // У остальных литеральных позиций нет: структурировать в списке нечего, и
    // автор собирает выражения сам. Число их рассудит регистрация (SYS-3).
    expect(catalog.operators.find((block) => block.name === 'clamp')?.args).toEqual([]);
  });

  it('позиции имён берутся из сигнатуры ядра, а не из перечня в редакторе (EXPR-8)', () => {
    // Перечня позиций в каталоге нет вовсе: каждая форма обязана сойтись с тем,
    // что публикует `signatureOf`, — иначе редактор подсказывал бы своё.
    for (const block of catalog.operators) {
      const signature = expr.signatureOf(block.name)!;
      expect(signature, block.name).toBeDefined();
      if (block.variadic) {
        expect(signature.literals, block.name).toEqual([]);
        continue;
      }
      expect(block.args.length, block.name).toBe(signature.max);
      const named = block.args
        .map((arg, index) => (arg === 'expression' ? -1 : index))
        .filter((index) => index >= 0);
      expect(named, block.name).toEqual([...signature.literals]);
    }
  });

  it('слоты у всех действий одни и те же: персонального набора аргументов нет (ED-1)', () => {
    for (const block of catalog.actions) expect(block.slots).toBe(CONVENTION_SLOTS);
  });

  it('блок ищется по имени, а неизвестное имя блока не имеет — и вердиктом это не является', () => {
    expect(actionCatalog()).toBe(catalog.actions);
    expect(operatorCatalog()).toBe(catalog.operators);
    expect(actionBlock('spawnEntity')?.descriptionKey).toBe('action.spawnEntity');
    expect(operatorBlock('clamp')?.variadic).toBe(true);
    expect(actionBlock('nope')).toBeUndefined();
    expect(operatorBlock('nope')).toBeUndefined();
  });
});

/**
 * ED-1: конвенция SYS-3 — не таблица в редакторе, а то, как ядро обходит
 * аргумент этого имени. Каждый зонд ломает содержимое одного слота и требует,
 * чтобы отказ ядра назвал этот слот путём. Слот, который ядро не обходит, зонда
 * бы не прошёл.
 */
describe('ED-1: слоты блока — те аргументы, которые обходит ядро', () => {
  const PROBES: Readonly<Record<string, JsonObject>> = {
    do: { do: [{ nope: {} }] },
    then: { then: [{ nope: {} }] },
    else: { else: [{ nope: {} }] },
    values: { values: { f: { nope: [] } } },
    data: { data: { f: { nope: [] } } },
    bindings: { bindings: { f: { nope: [] } } },
    entity: { entity: { nope: [] } },
    cond: { cond: { nope: [] } },
    bound: { bound: { nope: [] } },
    value: { value: { nope: [] } },
    nearestTo: { nearestTo: { nope: [] } },
    limit: { limit: { nope: [] } },
    name: { name: 42 },
    query: { query: { all: ['Nope'] } },
    overrides: { prefab: 'grunt', overrides: { Nope: {} } },
    component: { component: 'Nope' },
    field: { field: 42 },
    prefab: { prefab: 'nope' },
    type: { type: 42 },
    as: { as: 42 },
    subStream: { subStream: 42 },
  };

  it('зонд есть на каждый слот конвенции и слот — на каждый зонд', () => {
    expect(Object.keys(PROBES).sort()).toEqual(CONVENTION_SLOTS.map((slot) => slot.name).sort());
  });

  for (const slot of CONVENTION_SLOTS) {
    it(`слот "${slot.name}" ядро обходит и называет путём`, () => {
      // Имя действия зонду безразлично: `checkAction` ветвится по имени
      // аргумента, а не по имени действия, — в этом и состоит конвенция.
      const message = rejection(systemOf({ let: PROBES[slot.name]! }));
      expect(message).toContain(`.${slot.name}`);
    });
  }

  it('аргумент вне конвенции ядро содержимым не проверяет — и модель его не знает', () => {
    // Предел, зафиксированный в SYS-3. Именно поэтому таблицы «действие → его
    // аргументы» в редакторе нет: проверять по ней было бы строже ядра.
    expect(accepted(systemOf({ let: { do: [], nope: { alsoNope: [] } } }))).toBe(true);
    expect(conventionSlot('nope')).toBeUndefined();
    expect(conventionSlot('cond')).toEqual({ name: 'cond', kind: 'expression' });
  });

  it('поля запроса — вторая половина той же конвенции', () => {
    expect(QUERY_SLOTS.map((slot) => slot.name)).toEqual(['all', 'any', 'not', 'withTag', 'withinRadius']);
    for (const key of ['all', 'any', 'not']) {
      expect(rejection(systemOf({ let: { query: { [key]: ['Nope'] } } }))).toContain(`.query.${key}[0]`);
    }
    expect(rejection(systemOf({ let: { query: { withinRadius: { center: { nope: [] }, radius: 1 } } } }))).toContain(
      '.query.withinRadius.center',
    );
  });
});

describe('ED-4: реакция на событие собирается блоками и проходит `validateSystem`', () => {
  /** Сценарий требования: «при смерти сущности заспавнить взрыв в её позиции». */
  const trigger = buildAction({
    name: 'forEachEvent',
    slots: {
      type: 'EntityDied',
      as: 'died',
      do: [
        buildAction({
          name: 'spawnEntity',
          slots: {
            prefab: 'boom',
            overrides: {
              Position: {
                x: buildExpression('eventField', [buildExpression('var', ['died']), 'x']),
                y: buildExpression('eventField', [buildExpression('var', ['died']), 'y']),
              },
            },
          },
        }),
      ],
    },
  });

  it('собранная система принимается ядром — ни строки JSON автор не набирал', () => {
    expect(accepted({ name: 'onDeath', order: 10, do: [trigger] })).toBe(true);
  });

  it('вторая форма события — запрос по компоненту — принимается так же', () => {
    const system = {
      name: 'onDead',
      order: 11,
      query: { all: ['Dead'] },
      do: [
        buildAction({
          name: 'destroyEntity',
          slots: { entity: buildExpression('var', ['entity']) },
        }),
      ],
    };
    expect(accepted(system)).toBe(true);
  });

  it('у собранного узла ровно один ключ (ACT-1, EXPR-1)', () => {
    expect(Object.keys(trigger)).toEqual(['forEachEvent']);
    expect(Object.keys(buildExpression('tick'))).toEqual(['tick']);
  });

  it('пустой блок собирается, а незаполненный слот называет ядро (ACT-1, SYS-3)', () => {
    // Редактор блок не судит (ED-1): узел без слотов — законный документ, автор
    // его ещё заполняет. Вердикт об обязательном аргументе — ядра, и он адресный.
    expect(buildAction({ name: 'spawnEntity' })).toEqual({ spawnEntity: {} });
    expect(rejection(systemOf(buildAction({ name: 'spawnEntity' })))).toContain(
      'не задан обязательный аргумент "prefab"',
    );
  });
});

describe('ED-5: незаполненный слот в документ не уходит', () => {
  it('слот со значением `undefined` не появляется в JSON', () => {
    const node = buildAction({
      name: 'spawnEntity',
      slots: { prefab: 'boom', cond: undefined, overrides: undefined },
    });
    expect(JSON.stringify(node)).toBe('{"spawnEntity":{"prefab":"boom"}}');
  });

  it('пустая строка и пустой список — значения, а не пустота', () => {
    const node = buildAction({ name: 'if', slots: { then: [], as: '' } });
    expect(node).toEqual({ if: { then: [], as: '' } });
  });

  it('порядок ключей — порядок конвенции, а не порядок заполнения (ED-21)', () => {
    const filled = buildAction({
      name: 'modifyComponent',
      slots: { component: 'Health', values: { hp: 0 }, entity: buildExpression('var', ['e']) },
    });
    expect(Object.keys(filled.modifyComponent as JsonObject)).toEqual(['values', 'entity', 'component']);
    // Тот же блок, заполненный в другом порядке, даёт тот же JSON.
    const other = buildAction({
      name: 'modifyComponent',
      slots: { entity: buildExpression('var', ['e']), component: 'Health', values: { hp: 0 } },
    });
    expect(JSON.stringify(other)).toBe(JSON.stringify(filled));
  });

  it('аргумент вне конвенции пишется следом и не теряется', () => {
    const node = buildAction({ name: 'addTween', slots: { duration: 60, entity: 0, def: 0 } });
    expect(Object.keys(node.addTween as JsonObject)).toEqual(['entity', 'duration', 'def']);
  });

  it('аргументы выражения пишутся списком всегда, а читаются в обеих формах', () => {
    expect(buildExpression('var', ['e'])).toEqual({ var: ['e'] });
    expect(accepted(systemOf({ let: { bindings: { v: buildExpression('tick') }, do: [] } }))).toBe(true);
    // Краткая форма из документа, написанного руками, разворачивается тем же
    // правилом, каким её разворачивает ядро.
    expect(readExpressionNode({ var: 'e' })).toEqual({ operator: 'var', args: ['e'] });
    expect(readExpressionNode({ var: ['e'] })).toEqual({ operator: 'var', args: ['e'] });
    expect(readExpressionNode({ a: 1, b: 2 })).toBeUndefined();
    expect(readExpressionNode(42)).toBeUndefined();
  });

  it('узел действия разбирается обратно в имя и аргументы', () => {
    expect(readActionNode({ spawnEntity: { prefab: 'boom' } })).toEqual({
      name: 'spawnEntity',
      args: { prefab: 'boom' },
    });
    expect(readActionNode({ destroyEntity: 42 })).toEqual({ name: 'destroyEntity', args: {} });
    expect(readActionNode([])).toBeUndefined();
  });

  it('узел без имени не собирается: это не вердикт о DSL, а отсутствие блока', () => {
    expect(() => buildAction({ name: '' })).toThrow();
    expect(() => buildExpression('')).toThrow();
  });
});

describe('ED-5: кандидаты пикеров — ровно то, что принимает ядро', () => {
  it('пикер компонентов предлагает ровно то, что принимает `componentSchema`', () => {
    const offered = view().componentNames;
    for (const name of offered) {
      expect(coreWorld.componentSchema(world(), name), name).toBeDefined();
      // И то же самое вердиктом ядра: имя годится там, где его спросят.
      expect(accepted({ name: 'q', order: 1, query: { all: [name] }, do: [] }), name).toBe(true);
    }
    expect(coreWorld.componentSchema(world(), 'Nope')).toBeUndefined();
    expect(offered).not.toContain('Nope');
    expect(accepted({ name: 'q', order: 1, query: { all: ['Nope'] }, do: [] })).toBe(false);
  });

  it('в перечне есть и то, чего в документе нет: компоненты дописывает загрузчик', () => {
    // Решение 1 design'а: схемы тумана войны синтезирует `loadScene` по флагу
    // `fog`, и система вправе называть их наравне с объявленными. Разбор
    // документа их не увидел бы.
    const offered = view().componentNames;
    expect(offered).toContain('Health');
    expect(offered).toContain('Vision');
    expect(SCENE_VALUE.components.map((schema) => schema.name)).not.toContain('Vision');
  });

  it('пикер полей предлагает ровно то, что принимает `checkFields`', () => {
    const fields = view().fieldNames('Health');
    expect(fields).toEqual(['hp', 'max']);
    for (const field of fields) {
      const node = buildAction({
        name: 'modifyComponent',
        slots: { entity: buildExpression('var', ['entity']), component: 'Health', values: { [field]: 0 } },
      });
      expect(accepted({ name: 'f', order: 1, query: { all: ['Health'] }, do: [node] }), field).toBe(true);
    }
    const stranger = buildAction({
      name: 'modifyComponent',
      slots: { entity: buildExpression('var', ['entity']), component: 'Health', values: { armor: 0 } },
    });
    expect(rejection({ name: 'f', order: 1, query: { all: ['Health'] }, do: [stranger] })).toContain('armor');
    expect(view().fieldNames('Nope')).toEqual([]);
  });

  it('пикер prefab’ов предлагает ровно то, что принимает `prefabOf`', () => {
    const offered = view().prefabNames;
    expect(offered).toContain('grunt');
    for (const prefab of offered) {
      expect(accepted(systemOf(buildAction({ name: 'spawnEntity', slots: { prefab } }))), prefab).toBe(true);
    }
    expect(accepted(systemOf(buildAction({ name: 'spawnEntity', slots: { prefab: 'ghost' } })))).toBe(false);
  });

  it('пикер переопределений предлагает то, что prefab уже содержит (CMD-6)', () => {
    const offered = view().prefabComponentNames('boom');
    expect(offered).toEqual(['Position']);
    for (const component of offered) {
      const node = buildAction({
        name: 'spawnEntity',
        slots: { prefab: 'boom', overrides: { [component]: {} } },
      });
      expect(accepted(systemOf(node)), component).toBe(true);
    }
    const stranger = buildAction({
      name: 'spawnEntity',
      slots: { prefab: 'boom', overrides: { Health: {} } },
    });
    expect(rejection(systemOf(stranger))).toContain('Health');
    expect(view().prefabComponentNames('ghost')).toEqual([]);
  });

  it('мир для пикеров поднимается и тогда, когда одна из систем ещё не собрана', () => {
    // Ровно то состояние, в котором автор и работает: система в списке уже
    // есть, а её блок ещё не заполнен. `loadScene` целиком на ней падает —
    // пикеры при этом гаснуть не должны.
    const broken = {
      ...SCENE_VALUE,
      systems: [{ name: 'half', order: 1, do: [{ modifyComponent: { entity: 0, component: 'Nope', values: {} } }] }],
    };
    expect(() => loadScene(broken as unknown as SceneDef)).toThrow();
    expect(loadDslWorld(broken as unknown as JsonValue)?.componentNames).toContain('Health');
  });

  it('уже поднятый мир спрашивается напрямую: второго `loadScene` на ту же правку не нужно', () => {
    // Так пикеры читают мир, который правило валидации уже подняло за этот
    // прогон (`run.derive` в `engineRules.ts`).
    expect(dslWorldView(world()).prefabNames).toEqual(view().prefabNames);
  });

  it('сцена, которая не поднимается вовсе, кандидатов не даёт и причины не выдумывает', () => {
    // Причину называет правило сцены находкой на документе (ED-30); второго
    // сообщения о том же нарушении здесь нет.
    expect(loadDslWorld({ components: [{ name: 'Dup', fields: {} }, { name: 'Dup', fields: {} }] })).toBeUndefined();
    expect(loadDslWorld(42)).toBeUndefined();
  });
});

describe('ED-5: область видимости переменных — подсказка, а вердикт за ядром', () => {
  const SYSTEM: JsonValue = {
    name: 'chase',
    order: 1,
    query: { all: ['Position'] },
    do: [
      {
        let: {
          bindings: { speed: { tick: [] } },
          do: [
            {
              forEachEvent: {
                type: 'Collision',
                as: 'hit',
                do: [
                  {
                    if: {
                      cond: true,
                      then: [{ destroyEntity: { entity: { var: 'entity' } } }],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  it('переменная итерации системы связана в теле и не связана в запросе', () => {
    expect(boundNamesAt(SYSTEM, ['do', 0])).toEqual(['entity']);
    expect(boundNamesAt(SYSTEM, ['query', 'all'])).toEqual([]);
  });

  it('имя итерации берётся из `as`, а без него — умолчание ядра', () => {
    const named = { ...SYSTEM, as: 'e' };
    expect(boundNamesAt(named, ['do', 0])).toEqual(['e']);
    const noQuery = { name: 'x', order: 1, as: 'e', do: [] };
    // Без `query` система в `forEach` не разворачивается — и связывать нечего.
    expect(boundNamesAt(noQuery, ['do', 0])).toEqual([]);
  });

  it('биндинги `let` видны телу и не видны самим себе (параллельное связывание ACT-1)', () => {
    expect(boundNamesAt(SYSTEM, ['do', 0, 'let', 'do', 0])).toEqual(['entity', 'speed']);
    expect(boundNamesAt(SYSTEM, ['do', 0, 'let', 'bindings', 'speed'])).toEqual(['entity']);
  });

  it('имена копятся от внешнего к внутреннему', () => {
    expect(boundNamesAt(SYSTEM, ['do', 0, 'let', 'do', 0, 'forEachEvent', 'do', 0])).toEqual([
      'entity',
      'speed',
      'hit',
    ]);
    // Условие `if` вычисляется в области самого `if`, а не его ветки.
    expect(
      boundNamesAt(SYSTEM, ['do', 0, 'let', 'do', 0, 'forEachEvent', 'do', 0, 'if', 'cond']),
    ).toEqual(['entity', 'speed', 'hit']);
  });

  it('имена, связанные снаружи, идут первыми и не повторяются', () => {
    expect(boundNamesAt(SYSTEM, ['do', 0], ['arg', 'entity'])).toEqual(['arg', 'entity']);
  });

  it('`var` вне области видимости отвергает ядро, а не редактор', () => {
    const ghost = buildAction({
      name: 'destroyEntity',
      slots: { entity: buildExpression('var', ['ghost']) },
    });
    // Модель молчит: пикер просто не предложит имени, и это не вердикт.
    expect(boundNamesAt(SYSTEM, ['do', 0])).not.toContain('ghost');
    // Вердикт — ядра, и он адресный.
    expect(rejection({ name: 'g', order: 1, query: { all: ['Position'] }, do: [ghost] })).toContain('ghost');
  });
});
