/**
 * Рабочая область объектов (ED-7, ED-6, ED-23, ED-24, ED-25, ED-32).
 *
 * Что здесь пиннится и почему именно так:
 *
 * - **ED-7** проверяется сборкой prefab'а ЧЕРЕЗ ИНТЕРФЕЙС — нажатиями и вводом
 *   в поля, — а результат сверяется загрузкой ядром: «набор компонентов и
 *   начальные значения задаются визуально» держится ровно тогда, когда JSON,
 *   которого автор не набирал, ядро принимает;
 * - **ED-6** — двумя утверждениями сразу: поле, дописанное в схему, появляется
 *   в инспекторе со своим типом (это же ED-2), а схемы, синтезируемые
 *   загрузчиком, показаны и не правятся — операции, которая писала бы `Vision`,
 *   в наборе нет вовсе;
 * - **порядок схем** — перебором ВСЕГО реестра операций, а не списком «этих
 *   операций»: «перестановка MUST NOT быть побочным эффектом» проверяемо только
 *   тем, что переставить нечем ни одной зарегистрированной операцией;
 * - **ED-23/ED-24** — скелетом и живучестью записи состояния: зоны те же, что у
 *   соседей, а раздел навигатора переживает уход в другую область и возврат.
 */
import { describe, expect, it } from 'vitest';
import { loadScene, world, type SceneDef } from '@fluxus/core';
import {
  createEditorSession,
  createMemoryHost,
  createOperationRegistry,
  getAtPath,
  isJsonArray,
  isJsonObject,
  registerBuiltinOperations,
  type EditorSession,
  type JsonPath,
  type JsonValue,
} from '@fluxus/editor-core';
import { findAll, type UiNode } from '../src/dom/node.js';
import { placementSubject } from '../src/areas/sceneSchema.js';
import {
  OBJECTS_AREA_ID,
  OBJECTS_AREA_KEYS,
  OBJECT_LISTS,
  OBJECT_NODES,
  createObjectsArea,
  derivedKey,
  objectsArea,
  type ObjectsAreaState,
} from '../src/areas/objects.js';
import {
  COMPONENT_LIST,
  componentRecords,
  componentSubject,
  derivedComponentFields,
  derivedComponentSubject,
  derivedComponents,
  fieldTypeNames,
  registerSchemaOperations,
} from '../src/areas/objectsSchemas.js';
import { PREFAB_LIST, prefabRecords } from '../src/areas/objectsPrefabs.js';
import { registerPairOperations } from '../src/areas/objectsOperations.js';
import { buildFrame, buttonByKey, press, zoneOf } from './support/frame.js';
import { stubArea } from './support/stubArea.js';
import { settle } from './support/project.js';

const CONFIG = 'scenes/objects.scene.json';
const VISUALS = 'visuals/objects.manifest.json';
const INITIAL: JsonPath = ['initial'];

/**
 * Сцена-фикстура настоящая: она проходит `loadScene`. Флаг тумана войны здесь
 * не для полноты — он и есть то, чем загрузчик синтезирует схемы, которых в
 * документе нет (FOW-1..FOW-3), а без них проверять «производные показаны и не
 * правятся» было бы не на чем.
 */
const SCENE = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { hp: 'i32' } },
  ],
  prefabs: [{ name: 'Hero', components: { Position: { x: 0, y: 0 }, Health: { hp: 10 } } }],
  initial: [{ prefab: 'Hero' }],
  terrain: { width: 2, height: 2, tileSize: 65536, levels: ['00', '00'], flags: ['..', '..'] },
  fog: true,
  capacity: 32,
};

const MANIFEST = { entities: { Hero: { model: 'visuals/models/hero.mdx' } } };

interface Opened {
  readonly frame: ReturnType<typeof buildFrame>['frame'];
  readonly session: EditorSession;
  readonly state: ObjectsAreaState;
  readonly areaId: string;
}

/**
 * Область с открытым проектом. Документы читаются НАСТОЯЩИМ хостом среды
 * (ED-12) — дерево в памяти и есть его тестовый дубль, — а набор операций
 * приносится тем же реестром, что у сборки: без него область правит документы
 * нечем (ED-25, ED-29).
 */
async function opened(scene: unknown = SCENE): Promise<Opened> {
  const host = createMemoryHost({
    name: 'objects',
    root: { label: 'objects' },
    files: { [CONFIG]: JSON.stringify(scene), [VISUALS]: JSON.stringify(MANIFEST) },
  });
  const area = createObjectsArea({ host, ids: { config: CONFIG, visuals: VISUALS } });
  const fixture = buildFrame([area, stubArea]);
  registerSchemaOperations(fixture.session.operations);
  registerPairOperations(fixture.session.operations);
  const state = fixture.frame.stateOf(area.id) as ObjectsAreaState;
  await settle();
  fixture.frame.view();
  return { frame: fixture.frame, session: fixture.session, state, areaId: area.id };
}

/** Поле бара по ключу его подписи: подпись приходит из ресурса (ED-27). */
function fieldByKey(root: UiNode, key: string): UiNode | undefined {
  return findAll(
    root,
    (node) =>
      (node.tag === 'input' || node.tag === 'select') && node.labels?.ariaLabel?.key === key,
  )[0];
}

/** Строка инспектора по имени поля: её подпись — значение документа, а не ресурс. */
function rowInput(root: UiNode, name: string): UiNode | undefined {
  return findAll(
    root,
    (node) =>
      node.tag === 'input' &&
      node.labels?.ariaLabel?.origin === 'value' &&
      node.labels.ariaLabel.value === name,
  )[0];
}

/** Ввод: контрол отдаёт значение по `change` — от фокуса до подтверждения (ED-18). */
function commit(node: UiNode | undefined, value: string): void {
  const handler = node?.on?.change;
  if (handler === undefined) throw new Error(`контрол не принимает ввод: ${String(node?.tag)}`);
  handler({ target: { value } } as unknown as Event);
}

const configOf = (session: EditorSession): JsonValue => session.documentValue(CONFIG);

const prefabsOf = (session: EditorSession): readonly string[] =>
  prefabRecords(configOf(session), session.descriptors(CONFIG, PREFAB_LIST)).map(
    (record) => record.name,
  );

const componentsOf = (session: EditorSession): readonly string[] =>
  componentRecords(configOf(session), session.descriptors(CONFIG, COMPONENT_LIST)).map(
    (record) => record.name,
  );

describe('ED-7: новый prefab снаряда собирается визуально', () => {
  it('от пустого имени до документа, который принимает ядро, — без единой строки JSON', async () => {
    const { frame, session, state, areaId } = await opened();

    // Раздел prefab'ов — клавишей раскладки (ED-32), а не полем состояния:
    // переключение объявлено вкладом и разбирается порядком каркаса.
    expect(frame.handleAreaKey({ code: 'KeyP', phase: 'down', repeat: false })).toBe(true);
    expect(state.section).toBe('prefabs');

    const bar = () => zoneOf(frame.view(), 'surface');
    commit(fieldByKey(bar(), 'ui.area.objects.prefabName'), 'Bolt');
    commit(fieldByKey(bar(), 'ui.area.objects.model'), 'visuals/models/bolt.mdx');
    press(buttonByKey(bar(), 'ui.area.objects.createPrefab'));

    // Созданное выделено: дескриптор дописанной записи отдаёт сама операция.
    expect(prefabsOf(session)).toEqual(['Hero', 'Bolt']);
    const created = prefabRecords(configOf(session), session.descriptors(CONFIG, PREFAB_LIST))[1];
    expect(frame.selection.get(areaId)).toEqual([created?.key]);

    // Состав задаётся выбором из компонентов сцены, а не набором имени руками.
    commit(fieldByKey(bar(), 'ui.area.objects.prefabComponent'), 'Position');
    press(buttonByKey(bar(), 'ui.action.addComponent'));
    commit(fieldByKey(bar(), 'ui.area.objects.prefabComponent'), 'Health');
    press(buttonByKey(bar(), 'ui.action.addComponent'));

    // Начальные значения — строки инспектора по схемам компонентов (ED-24).
    const inspector = () => zoneOf(frame.view(), 'inspector');
    commit(rowInput(inspector(), 'x'), '1.5');
    commit(rowInput(inspector(), 'hp'), '7');

    // Вердикт выносит ядро: собранный документ поднимается им как сцена.
    const scene = loadScene(configOf(session) as unknown as SceneDef);
    expect(world.prefabNames(scene.world)).toContain('Bolt');
    expect(getAtPath(configOf(session), [...PREFAB_LIST, 1])).toEqual({
      name: 'Bolt',
      // 1.5 в Q16.16 — перевод делает ядро (`fixed`), а не редактор.
      components: { Position: { x: 98304 }, Health: { hp: 7 } },
    });
  });

  it('ED-29: снятие компонента с prefab\'а идёт базовой операцией и обратимо', async () => {
    const { frame, session, areaId } = await opened();
    const hero = prefabRecords(configOf(session), session.descriptors(CONFIG, PREFAB_LIST))[0];
    frame.selection.set(areaId, [hero?.key ?? '']);
    (frame.stateOf(areaId) as ObjectsAreaState).section = 'prefabs';

    const surface = zoneOf(frame.view(), 'surface');
    // Кнопка снятия стоит в строке состава — она и есть «состав правится здесь».
    const row = findAll(surface, (node) => node.attrs?.['data-part'] === 'Health')[0];
    press(buttonByKey(row ?? surface, 'ui.action.remove'));
    expect(getAtPath(configOf(session), [...PREFAB_LIST, 0, 'components'])).toEqual({
      Position: { x: 0, y: 0 },
    });

    expect(session.undo()).toBe(true);
    expect(getAtPath(configOf(session), [...PREFAB_LIST, 0, 'components', 'Health'])).toEqual({
      hp: 10,
    });
  });
});

describe('ED-6: схема компонента правится там, где она объявлена', () => {
  /** Сессия без интерфейса: ED-29 требует, чтобы операции были исполнимы без него. */
  function scratch(): EditorSession {
    const session = createEditorSession({
      operations: registerPairOperations(
        registerSchemaOperations(registerBuiltinOperations(createOperationRegistry())),
      ),
    });
    session.openDocument({
      id: CONFIG,
      kind: 'scene',
      value: structuredClone(SCENE) as unknown as JsonValue,
      lists: [COMPONENT_LIST, PREFAB_LIST, INITIAL],
    });
    session.openDocument({
      id: VISUALS,
      kind: 'visuals',
      value: structuredClone(MANIFEST),
    });
    return session;
  }

  it('поле, добавленное в схему, появляется в инспекторе расстановки со своим типом', () => {
    const session = scratch();
    session.applyOperation('objects.component.addField', {
      document: CONFIG,
      record: session.descriptors(CONFIG, COMPONENT_LIST)[0] ?? '',
      field: 'z',
      type: 'i32',
    });

    // Инспектор расстановки строит `sceneSchema.ts`, читая тот же перечень
    // схем: правки кода редактора для нового поля не потребовалось (ED-2).
    const subject = placementSubject({
      session,
      documentId: CONFIG,
      record: session.descriptors(CONFIG, INITIAL)[0] ?? '',
      prefab: 'Hero',
      prefabs: ['Hero'],
    });
    const position = subject.groups.find((group) => group.name === 'Position');
    expect(position?.fields.map((field) => [field.name, field.type])).toEqual([
      ['x', 'fixed'],
      ['y', 'fixed'],
      // Дописано в конец: порядок состава — порядок объявления.
      ['z', 'i32'],
    ]);
  });

  it('тип поля берётся из опубликованной схемы формата, а не из списка в редакторе', () => {
    // Перечень типов — тот же, по которому валидирует загрузчик (SER-5, ECS-3).
    expect(fieldTypeNames().length).toBeGreaterThan(1);
    const session = scratch();
    expect(() =>
      session.applyOperation('objects.component.addField', {
        document: CONFIG,
        record: session.descriptors(CONFIG, COMPONENT_LIST)[0] ?? '',
        field: 'z',
        type: 'f64',
      }),
    ).toThrow(/опубликованная схема формата не объявляет/u);
  });

  it('строка состава предлагает ровно закрытый набор типов', () => {
    const session = scratch();
    const record = componentRecords(configOf(session), session.descriptors(CONFIG, COMPONENT_LIST))[0];
    const subject = componentSubject(CONFIG, record!);
    const fields = subject.groups.find((group) => group.name === 'fields');
    expect(fields?.fields.map((field) => field.values)).toEqual([
      [...fieldTypeNames()],
      [...fieldTypeNames()],
    ]);
  });

  it('снятие поля уносит и его значение по умолчанию', () => {
    const session = scratch();
    const record = session.descriptors(CONFIG, COMPONENT_LIST)[0] ?? '';
    session.applyOperation('document.list.setValue', {
      document: CONFIG,
      record,
      path: ['defaults', 'y'],
      value: 65536,
    });
    session.applyOperation('objects.component.removeField', { document: CONFIG, record, field: 'y' });
    expect(getAtPath(configOf(session), [...COMPONENT_LIST, 0])).toEqual({
      name: 'Position',
      fields: { x: 'fixed' },
      defaults: {},
    });
  });

  it('схему можно и снять, и это правка базовой операцией, а не побочный эффект', async () => {
    const { frame, session, areaId } = await opened();
    const record = componentRecords(configOf(session), session.descriptors(CONFIG, COMPONENT_LIST))[0];
    frame.selection.set(areaId, [record?.key ?? '']);

    press(buttonByKey(zoneOf(frame.view(), 'surface'), 'ui.area.objects.deleteComponent'));
    // Снята названная схема, а порядок оставшихся — прежний: перестановки
    // побочным эффектом не случилось (дельта ED-6).
    expect(componentsOf(session)).toEqual(['Health']);
    // Правка идёт через слой операций (ED-29), поэтому обратима целиком —
    // вместе с местом схемы в перечне, то есть с битовыми id (SER-7).
    expect(session.undo()).toBe(true);
    expect(componentsOf(session)).toEqual(['Position', 'Health']);
  });
});

describe('ED-6: синтезированные загрузчиком схемы показаны и не правятся', () => {
  it('они есть в навигаторе отдельной ветвью и их нет среди записей документа', async () => {
    const { frame, session, state } = await opened();
    state.expanded.add(OBJECT_NODES.derived);
    const derived = derivedComponents(configOf(session));

    // Их состав нормируют соседние capability, а сюда их дописал загрузчик по
    // флагу сцены — в документе записи под них нет (ECS-5).
    expect(derived.names).toContain('Vision');
    expect(derived.names).toContain('Visibility');
    expect(derived.names).toContain('Stealth');
    expect(componentsOf(session)).toEqual(['Position', 'Health']);

    const navigator = zoneOf(frame.view(), 'navigator');
    const labels = findAll(navigator, (node) => node.text?.origin === 'value').map(
      (node) => node.text?.value ?? '',
    );
    expect(labels).toContain('Vision');
  });

  it('их поля показаны недоступными: писать туда некуда', async () => {
    const { frame, session, state, areaId } = await opened();
    state.expanded.add(OBJECT_NODES.derived);
    frame.selection.set(areaId, [derivedKey('Vision')]);

    const subject = derivedComponentSubject(
      CONFIG,
      'Vision',
      derivedComponentFields(configOf(session), 'Vision'),
    );
    expect(subject.groups[0]?.fields.length).toBeGreaterThan(0);
    for (const field of subject.groups[0]?.fields ?? []) expect(field.readOnly).toBe(true);

    // И в собранной странице тоже: контрол показан недоступным, а не молча не
    // принимающим ввод (ED-26).
    const input = rowInput(zoneOf(frame.view(), 'inspector'), 'radius');
    expect(input?.attrs?.readonly).toBe('');
    expect(input?.on?.change).toBeUndefined();
  });

  it('операции, которая писала бы синтезированную схему, в наборе нет вовсе', async () => {
    const { session } = await opened();
    // Все операции схем адресуют ЗАПИСЬ документа дескриптором, а у производной
    // схемы записи нет: адреса для неё не существует, и это сильнее запрета.
    const keys = session.descriptors(CONFIG, COMPONENT_LIST);
    expect(keys).toHaveLength(2);
    const names = componentRecords(configOf(session), keys).map((record) => record.name);
    for (const derived of derivedComponents(configOf(session)).names) {
      expect(names).not.toContain(derived);
    }
  });
});

describe('ED-6: порядок схем не переставляется ни одной операцией', () => {
  function prepared(): EditorSession {
    const session = createEditorSession({
      operations: registerPairOperations(
        registerSchemaOperations(registerBuiltinOperations(createOperationRegistry())),
      ),
    });
    session.openDocument({
      id: CONFIG,
      kind: 'scene',
      value: structuredClone(SCENE) as unknown as JsonValue,
      lists: [COMPONENT_LIST, PREFAB_LIST, INITIAL],
    });
    session.openDocument({
      id: VISUALS,
      kind: 'visuals',
      value: structuredClone(MANIFEST),
    });
    return session;
  }

  const schemaRecord = (session: EditorSession, index: number): string =>
    session.descriptors(CONFIG, COMPONENT_LIST)[index] ?? '';
  const prefabRecord = (session: EditorSession, index: number): string =>
    session.descriptors(CONFIG, PREFAB_LIST)[index] ?? '';

  /**
   * Заготовка на каждую зарегистрированную операцию — включая те, что к схемам
   * отношения не имеют: утверждение проверяется про ВЕСЬ реестр, а перечень
   * «этих операций» отстал бы от него на первой же новой.
   */
  const fixtures: Readonly<Record<string, (session: EditorSession) => Record<string, JsonValue>>> = {
    'document.setValue': () => ({ document: CONFIG, path: ['capacity'], value: 64 }),
    'document.removeValue': () => ({ document: CONFIG, path: ['capacity'] }),
    'document.renameKey': () => ({ document: VISUALS, path: ['entities'], from: 'Hero', to: 'Champion' }),
    'document.list.append': () => ({
      document: CONFIG,
      list: [...COMPONENT_LIST],
      item: { name: 'Mana', fields: { mp: 'i32' } },
    }),
    'document.list.remove': (session) => ({ document: CONFIG, record: schemaRecord(session, 0) }),
    'document.list.setValue': (session) => ({
      document: CONFIG,
      record: schemaRecord(session, 1),
      path: ['fields', 'hp'],
      value: 'fixed',
    }),
    'document.list.removeValue': (session) => ({
      document: CONFIG,
      record: schemaRecord(session, 0),
      path: ['fields', 'y'],
    }),
    'objects.component.create': () => ({ document: CONFIG, list: [...COMPONENT_LIST], name: 'Mana' }),
    'objects.component.addField': (session) => ({
      document: CONFIG,
      record: schemaRecord(session, 0),
      field: 'z',
      type: 'fixed',
    }),
    'objects.component.removeField': (session) => ({
      document: CONFIG,
      record: schemaRecord(session, 0),
      field: 'y',
    }),
    'objects.prefab.create': () => ({
      document: CONFIG,
      list: [...PREFAB_LIST],
      name: 'Bolt',
      visuals: VISUALS,
      model: 'visuals/models/bolt.mdx',
    }),
    'objects.prefab.rename': (session) => ({
      document: CONFIG,
      record: prefabRecord(session, 0),
      to: 'Champion',
      visuals: VISUALS,
    }),
    'objects.prefab.delete': (session) => ({
      document: CONFIG,
      record: prefabRecord(session, 0),
      visuals: VISUALS,
    }),
  };

  const namesOf = (session: EditorSession): readonly string[] => {
    const list = getAtPath(configOf(session), COMPONENT_LIST);
    return isJsonArray(list)
      ? list.map((entry) => (isJsonObject(entry) && typeof entry.name === 'string' ? entry.name : ''))
      : [];
  };

  const registry = registerPairOperations(registerSchemaOperations(createOperationRegistry()));
  const registered = [
    ...registerBuiltinOperations(createOperationRegistry()).list(),
    ...registry.list(),
  ].map((operation) => operation.id);

  it('у каждой зарегистрированной операции есть заготовка', () => {
    expect(registered.filter((id) => !(id in fixtures))).toEqual([]);
    expect(Object.keys(fixtures).filter((id) => !registered.includes(id))).toEqual([]);
  });

  for (const operationId of registered) {
    it(`${operationId} не переставляет схемы`, () => {
      const session = prepared();
      const before = namesOf(session);
      session.applyOperation(operationId, fixtures[operationId]!(session));
      const after = namesOf(session);

      // Уцелевшие имена идут в прежнем относительном порядке...
      expect(after.filter((name) => before.includes(name))).toEqual(
        before.filter((name) => after.includes(name)),
      );
      // ...а появившееся стоит строго в конце (SER-7: битовые id → `worldInit`).
      const added = after.filter((name) => !before.includes(name));
      expect(after.slice(after.length - added.length)).toEqual(added);
    });
  }
});

describe('ED-23, ED-24, ED-25: область — такой же вклад с тем же скелетом', () => {
  it('три зоны на месте, а рядом живёт чужая область', async () => {
    const { frame, areaId } = await opened();
    const page = frame.view();
    for (const zone of ['navigator', 'surface', 'inspector'] as const) {
      expect(zoneOf(page, zone)).toBeDefined();
    }
    expect(frame.areas.all().map((area) => area.id)).toContain(areaId);
    expect(frame.areas.all().length).toBe(2);
  });

  it('раздел навигатора переживает уход в другую область и возврат (ED-23)', async () => {
    const { frame, state, areaId } = await opened();
    expect(frame.handleAreaKey({ code: 'KeyP', phase: 'down', repeat: false })).toBe(true);
    expect(state.section).toBe('prefabs');

    frame.activate(stubArea.id);
    frame.view();
    frame.activate(areaId);
    // Запись состояния хранит каркас — та же самая, что была отдана в прошлый раз.
    expect((frame.stateOf(areaId) as ObjectsAreaState).section).toBe('prefabs');
  });

  it('ED-32: раскладка объявлена данными вклада, и по ней же собраны подсказки', () => {
    expect(OBJECTS_AREA_KEYS.map((key) => key.code)).toEqual(['KeyC', 'KeyP']);
    for (const key of OBJECTS_AREA_KEYS) expect(key.labelKey.startsWith('ui.')).toBe(true);
    // Чужая клавиша области не достаётся: своего порядка разбора она не заводит.
    expect(objectsArea.handleKey?.({
      state: { section: 'components', expanded: new Set<string>(), refresh: () => undefined } as unknown as ObjectsAreaState,
      code: 'KeyZ',
      phase: 'down',
      repeat: false,
      mode: 'edit',
    })).toBe(false);
  });

  it('ED-12: без открытого проекта область называет причину, а не показывает пустоту', () => {
    const { frame } = buildFrame([objectsArea, stubArea]);
    const state = frame.stateOf(OBJECTS_AREA_ID) as ObjectsAreaState;
    expect(state.configId).toBeNull();
    const navigator = zoneOf(frame.view(), 'navigator');
    const said = findAll(navigator, (node) => node.text?.key === 'ui.area.objects.noProject');
    expect(said.length).toBeGreaterThan(0);
  });

  it('перечень отслеживаемых списков объявлен один раз — им открывается документ', () => {
    expect(OBJECT_LISTS.map((list) => [...list])).toEqual([['components'], ['prefabs']]);
  });
});
