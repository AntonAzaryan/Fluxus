/**
 * Пара ED-19 «prefab + запись манифеста» как одна сущность авторинга.
 *
 * Проверяется здесь ровно то, чего ED-19 требует и чего в редакторе до этого
 * прохода не было: создание заводит ОБЕ половины, переименование меняет обе
 * согласованно, удаление снимает обе, а повисшая после удаления запись
 * расстановки становится находкой валидации — той же, которой подсвечивается
 * рассинхронизация пары.
 *
 * Все проверки идут через слой операций и без интерфейса: ED-29 требует, чтобы
 * операции были исполнимы без него, и именно так пара и проверяется — иначе
 * «одно действие над одной сущностью» держалось бы на том, что кнопка зовёт две
 * операции подряд.
 *
 * Находки считает НАСТОЯЩИЙ слой валидации (`crossDocumentRules`), а не список
 * ожиданий в этом файле: второе описание того же нарушения запрещает ED-30.
 */
import { describe, expect, it } from 'vitest';
import {
  ContributionRegistry,
  PLACEMENT_PREFAB_RULE,
  PREFAB_FOR_VISUAL_RULE,
  VISUAL_FOR_PREFAB_RULE,
  createEditorSession,
  createOperationRegistry,
  createValidator,
  crossDocumentRules,
  getAtPath,
  isJsonArray,
  isJsonObject,
  registerBuiltinOperations,
  registerValidationRules,
  runOperationRoundTrip,
  type EditorSession,
  type JsonPath,
  type JsonValue,
  type ValidationIssue,
  type ValidationRule,
} from '@fluxus/editor-core';
import {
  PAIR_OPERATIONS,
  prefabReferences,
  registerPairOperations,
  type PrefabReferenceSite,
} from '../src/areas/objectsOperations.js';
import { registerSchemaOperations } from '../src/areas/objectsSchemas.js';
import { SPAWN_ACTION } from '../src/areas/objects.js';

const CONFIG = 'scenes/pair.scene.json';
const VISUALS = 'visuals/pair.manifest.json';

const COMPONENTS: JsonPath = ['components'];
const PREFABS: JsonPath = ['prefabs'];
const INITIAL: JsonPath = ['initial'];
const SYSTEMS: JsonPath = ['systems'];
const ENTITIES: JsonPath = ['entities'];

/**
 * Сцена-фикстура настоящая: она проходит `loadScene`, и три размещения одного
 * префаба здесь не для полноты — на них стоит сценарий ED-19 «Один префаб, три
 * размещения» и его продолжение про удаление.
 */
const SCENE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [
    { name: 'Hero', components: { Position: { x: 0, y: 0 } } },
    { name: 'Crate', components: { Position: { x: 65536, y: 0 } } },
  ],
  systems: [
    {
      name: 'spawner',
      order: 1,
      query: { all: ['Position'] },
      do: [{ if: { cond: true, then: [{ spawnEntity: { prefab: 'Crate' } }] } }],
    },
  ],
  initial: [{ prefab: 'Hero' }, { prefab: 'Crate' }, { prefab: 'Crate' }, { prefab: 'Crate' }],
  capacity: 32,
};

/** Порядок ключей здесь значим: на нём стоит проверка «позиция ключа не сдвинулась». */
const MANIFEST = {
  entities: {
    Hero: { model: 'visuals/models/hero.mdx' },
    Crate: { model: 'visuals/models/crate.mdx' },
  },
};

/** Адреса ссылок на имя prefab'а — раскладка этого проекта (решение 7а). */
const SITES: readonly PrefabReferenceSite[] = [
  { document: CONFIG, list: INITIAL, field: 'prefab' },
  { document: CONFIG, list: SYSTEMS, field: 'prefab', action: SPAWN_ACTION },
];

/**
 * Сессия с тем же реестром, что у сборки. Схемы и prefab'ы отслеживаются
 * всегда — их записи адресуются дескрипторами (ED-29), — а списки со ссылками
 * (расстановка и системы) отслеживаются по требованию: раскладка списков есть
 * свойство ДОКУМЕНТА, и операция обязана работать на обеих.
 */
function scratch(trackedReferences = true): EditorSession {
  const session = createEditorSession({
    operations: registerPairOperations(
      registerSchemaOperations(registerBuiltinOperations(createOperationRegistry())),
    ),
  });
  session.openDocument({
    id: CONFIG,
    kind: 'scene',
    value: structuredClone(SCENE),
    lists: trackedReferences ? [COMPONENTS, PREFABS, INITIAL, SYSTEMS] : [COMPONENTS, PREFABS],
  });
  session.openDocument({
    id: VISUALS,
    kind: 'visuals',
    value: structuredClone(MANIFEST),
  });
  return session;
}

const recordOf = (session: EditorSession, list: JsonPath, index: number): string =>
  session.descriptors(CONFIG, list)[index] ?? '';

/** Дескриптор записи prefab'а по имени: адресуют операции им, а не индексом. */
function prefabRecord(session: EditorSession, name: string): string {
  const list = getAtPath(session.documentValue(CONFIG), PREFABS);
  const index = isJsonArray(list)
    ? list.findIndex((entry) => isJsonObject(entry) && entry.name === name)
    : -1;
  return recordOf(session, PREFABS, index);
}

const prefabNames = (session: EditorSession): readonly string[] => {
  const list = getAtPath(session.documentValue(CONFIG), PREFABS);
  return isJsonArray(list)
    ? list.map((entry) => (isJsonObject(entry) && typeof entry.name === 'string' ? entry.name : ''))
    : [];
};

const entityKeys = (session: EditorSession): readonly string[] => {
  const entities = getAtPath(session.documentValue(VISUALS), ENTITIES);
  return isJsonObject(entities) ? Object.keys(entities) : [];
};

const placementPrefabs = (session: EditorSession): readonly string[] => {
  const list = getAtPath(session.documentValue(CONFIG), INITIAL);
  return isJsonArray(list)
    ? list.map((entry) => (isJsonObject(entry) && typeof entry.prefab === 'string' ? entry.prefab : ''))
    : [];
};

/** Литерал `prefab` действия `spawnEntity` внутри тела системы (ACT-1). */
const spawnedPrefab = (session: EditorSession): JsonValue | undefined =>
  getAtPath(session.documentValue(CONFIG), [...SYSTEMS, 0, 'do', 0, 'if', 'then', 0, SPAWN_ACTION, 'prefab']);

/** Настоящий слой валидации: правила пары и повисшей ссылки (ED-8, ED-19). */
function findings(session: EditorSession): readonly ValidationIssue[] {
  const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(
    rules,
    crossDocumentRules(
      { scene: 'scene', manifest: 'visuals', curvature: 'curvature', presentation: 'presentation' },
      [{ kind: 'scene', path: INITIAL }],
    ),
  );
  return createValidator({ rules }).run(session).issues;
}

const byRule = (issues: readonly ValidationIssue[], ruleId: string): readonly ValidationIssue[] =>
  issues.filter((issue) => issue.ruleId === ruleId);

describe('ED-19: создание юнита — одно действие над одной сущностью', () => {
  it('появляются обе половины, и рассинхронизации нет', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.create, {
      document: CONFIG,
      list: PREFABS,
      name: 'Bolt',
      visuals: VISUALS,
      model: 'visuals/models/bolt.mdx',
    });

    expect(prefabNames(session)).toEqual(['Hero', 'Crate', 'Bolt']);
    expect(entityKeys(session)).toEqual(['Hero', 'Crate', 'Bolt']);
    // Ни одна из двух половин пары не осталась одна — это и проверяют правила,
    // а не сравнение двух списков в этом файле (ED-30).
    const issues = findings(session);
    expect(byRule(issues, VISUAL_FOR_PREFAB_RULE)).toEqual([]);
    expect(byRule(issues, PREFAB_FOR_VISUAL_RULE)).toEqual([]);
  });

  it('состав prefab\'а пуст, а модель записи — та, что назвал автор', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.create, {
      document: CONFIG,
      list: PREFABS,
      name: 'Bolt',
      visuals: VISUALS,
      model: 'visuals/models/bolt.mdx',
    });
    expect(getAtPath(session.documentValue(CONFIG), [...PREFABS, 2])).toEqual({
      name: 'Bolt',
      components: {},
    });
    expect(getAtPath(session.documentValue(VISUALS), [...ENTITIES, 'Bolt'])).toEqual({
      model: 'visuals/models/bolt.mdx',
    });
  });

  it('ED-18: пара — одна запись истории, и undo снимает обе половины', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.create, {
      document: CONFIG,
      list: PREFABS,
      name: 'Bolt',
      visuals: VISUALS,
      model: 'visuals/models/bolt.mdx',
    });
    const history = session.history();
    expect(history.undo).toHaveLength(1);
    // Одна запись на ДВА документа: транзакция сессии охватывает оба, и отмена
    // возвращает их вместе, а не по очереди.
    expect([...(history.undo[0]?.documentIds ?? [])].sort()).toEqual([CONFIG, VISUALS].sort());

    expect(session.undo()).toBe(true);
    expect(prefabNames(session)).toEqual(['Hero', 'Crate']);
    expect(entityKeys(session)).toEqual(['Hero', 'Crate']);
  });

  it('половину пары завести нечем: без открытого манифеста операция отказывает', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(PAIR_OPERATIONS.create, {
        document: CONFIG,
        list: PREFABS,
        name: 'Bolt',
        visuals: 'visuals/missing.json',
        model: 'visuals/models/bolt.mdx',
      }),
    ).toThrow(/манифест визуалов не открыт/u);
    expect(prefabNames(session)).toEqual(['Hero', 'Crate']);
  });
});

describe('ED-19: переименование меняет оба согласованно', () => {
  it('пара, расстановка и литерал spawnEntity едут вместе', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.rename, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      to: 'Barrel',
      visuals: VISUALS,
      ...prefabReferences(SITES),
    });

    expect(prefabNames(session)).toEqual(['Hero', 'Barrel']);
    expect(entityKeys(session)).toEqual(['Hero', 'Barrel']);
    expect(placementPrefabs(session)).toEqual(['Hero', 'Barrel', 'Barrel', 'Barrel']);
    expect(spawnedPrefab(session)).toBe('Barrel');
    // Ни одной находки: инструмент не оставляет после себя рассинхронизации,
    // ради недопущения которой он и заведён (ED-19).
    expect(findings(session)).toEqual([]);
  });

  it('ED-21: позиция ключа манифеста не сдвинулась', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.rename, {
      document: CONFIG,
      record: prefabRecord(session, 'Hero'),
      to: 'Champion',
      visuals: VISUALS,
      ...prefabReferences(SITES),
    });
    // `removeValue + setValue` дало бы `['Crate', 'Champion']`: запись уехала бы
    // в конец объекта и дифф пары читался бы как два блока вместо одного.
    expect(entityKeys(session)).toEqual(['Champion', 'Crate']);
  });

  it('ED-18: переименование по трём документным местам — одна запись истории', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.rename, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      to: 'Barrel',
      visuals: VISUALS,
      ...prefabReferences(SITES),
    });
    expect(session.history().undo).toHaveLength(1);
    expect(session.undo()).toBe(true);
    expect(placementPrefabs(session)).toEqual(['Hero', 'Crate', 'Crate', 'Crate']);
    expect(spawnedPrefab(session)).toBe('Crate');
    expect(entityKeys(session)).toEqual(['Hero', 'Crate']);
  });

  it('ссылки переписываются и там, где списки не отслеживаются', () => {
    // Тот же вызов там, где расстановка и системы — обычные поля документа:
    // ED-29 требует, чтобы операция работала и вне собранного редактора, а
    // выбор «дескриптор или путь с индексом» принадлежит документу, не ей.
    const session = scratch(false);
    session.applyOperation(PAIR_OPERATIONS.rename, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      to: 'Barrel',
      visuals: VISUALS,
      ...prefabReferences(SITES),
    });
    expect(placementPrefabs(session)).toEqual(['Hero', 'Barrel', 'Barrel', 'Barrel']);
    expect(spawnedPrefab(session)).toBe('Barrel');
  });

  it('неоткрытый документ не трогается, и молчания об этом не возникает', () => {
    const session = scratch();
    const outside: readonly PrefabReferenceSite[] = [
      ...SITES,
      { document: 'scenes/other.scene.json', list: INITIAL, field: 'prefab' },
    ];
    // Отказа нет: неоткрытый документ — не ошибка вызова, а состояние сессии.
    // Расхождение с ним назовёт правило `editor.placementPrefab`, когда он
    // откроется, — молча оно не пропадает.
    session.applyOperation(PAIR_OPERATIONS.rename, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      to: 'Barrel',
      visuals: VISUALS,
      ...prefabReferences(outside),
    });
    expect(prefabNames(session)).toEqual(['Hero', 'Barrel']);
  });

  it('занятое имя записи манифеста — отказ, и документы остаются нетронутыми', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(PAIR_OPERATIONS.rename, {
        document: CONFIG,
        record: prefabRecord(session, 'Crate'),
        to: 'Hero',
        visuals: VISUALS,
        ...prefabReferences(SITES),
      }),
    ).toThrow(/уже занята/u);
    expect(prefabNames(session)).toEqual(['Hero', 'Crate']);
    expect(placementPrefabs(session)).toEqual(['Hero', 'Crate', 'Crate', 'Crate']);
  });
});

describe('ED-19: один префаб, три размещения', () => {
  it('пара одна, а записей расстановки три — и находок при этом нет', () => {
    const session = scratch();
    expect(placementPrefabs(session).filter((name) => name === 'Crate')).toHaveLength(3);
    expect(prefabNames(session).filter((name) => name === 'Crate')).toHaveLength(1);
    expect(findings(session)).toEqual([]);
  });

  it('удалён префаб, оставшийся в расстановке: находка на каждой записи', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.delete, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      visuals: VISUALS,
    });

    // Обе половины сняты одним вызовом — и это одно действие автора (ED-18).
    expect(prefabNames(session)).toEqual(['Hero']);
    expect(entityKeys(session)).toEqual(['Hero']);
    expect(session.history().undo).toHaveLength(1);

    // Размещения остались, и это норма: сценарий ED-19 требует, чтобы повисшая
    // ссылка ПОДСВЕЧИВАЛАСЬ, то есть чтобы она существовала.
    const dangling = byRule(findings(session), PLACEMENT_PREFAB_RULE);
    expect(dangling).toHaveLength(3);
    // Находка адресует запись, а не документ целиком: три записи — три адреса.
    expect(dangling.map((issue) => issue.path)).toEqual([
      [...INITIAL, 1, 'prefab'],
      [...INITIAL, 2, 'prefab'],
      [...INITIAL, 3, 'prefab'],
    ]);
  });

  it('удаление обратимо целиком: undo возвращает обе половины', () => {
    const session = scratch();
    session.applyOperation(PAIR_OPERATIONS.delete, {
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      visuals: VISUALS,
    });
    expect(session.undo()).toBe(true);
    expect(prefabNames(session)).toEqual(['Hero', 'Crate']);
    expect(entityKeys(session)).toEqual(['Hero', 'Crate']);
    expect(findings(session)).toEqual([]);
  });
});

describe('ED-29: каждая операция области объектов обратима', () => {
  const fixtures: Readonly<Record<string, (session: EditorSession) => Record<string, JsonValue>>> = {
    [PAIR_OPERATIONS.create]: () => ({
      document: CONFIG,
      list: [...PREFABS],
      name: 'Bolt',
      visuals: VISUALS,
      model: 'visuals/models/bolt.mdx',
    }),
    [PAIR_OPERATIONS.rename]: (session) => ({
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      to: 'Barrel',
      visuals: VISUALS,
      ...prefabReferences(SITES),
    }),
    [PAIR_OPERATIONS.delete]: (session) => ({
      document: CONFIG,
      record: prefabRecord(session, 'Crate'),
      visuals: VISUALS,
    }),
    'objects.component.create': () => ({ document: CONFIG, list: [...COMPONENTS], name: 'Health' }),
    'objects.component.addField': (session) => ({
      document: CONFIG,
      record: recordOf(session, COMPONENTS, 0),
      field: 'z',
      type: 'fixed',
    }),
    'objects.component.removeField': (session) => ({
      document: CONFIG,
      record: recordOf(session, COMPONENTS, 0),
      field: 'y',
    }),
  };

  it('у каждой операции набора есть заготовка проверки', () => {
    // Перечень берётся у самих модулей, а не набирается здесь: операция,
    // добавленная и не проверенная, красит тест, а не проходит незамеченной.
    const registered = registerPairOperations(
      registerSchemaOperations(createOperationRegistry()),
    )
      .list()
      .map((operation) => operation.id);
    expect(registered.filter((id) => !(id in fixtures))).toEqual([]);
    expect(Object.keys(fixtures).filter((id) => !registered.includes(id))).toEqual([]);
  });

  for (const operationId of Object.keys(fixtures)) {
    it(`${operationId} обратима без следа`, () => {
      const session = scratch();
      const result = runOperationRoundTrip(session, operationId, fixtures[operationId]!(session));
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      // Операция, ничего не изменившая, обратима тривиально и о слое ничего не
      // говорит: заготовка обязана быть содержательной.
      expect(result.recorded).toBe(true);
    });
  }
});
