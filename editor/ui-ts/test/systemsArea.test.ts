/**
 * Рабочая область систем (ED-4, ED-23, ED-24, ED-25, ED-29, ED-32).
 *
 * Что здесь пиннится и почему именно так:
 *
 * - **ED-4** проверяется сборкой триггера ЧЕРЕЗ ИНТЕРФЕЙС — нажатиями и вводом
 *   в поля, — а результат сверяется ядром: «редактор триггеров» держится ровно
 *   тогда, когда JSON, которого автор не набирал ни строчки, ядро принимает как
 *   систему сцены. Сценарий взят из спеки дословно: «при смерти сущности
 *   заспавнить взрыв»;
 * - **ED-29** — обратимостью каждой правки: у всякого действия автора есть
 *   запись истории, и отмена возвращает документ к прежнему значению целиком;
 * - **ED-23** — тем, что правка, сделанная в области систем, отменяется, когда
 *   автор ушёл в другую область: история одна на сессию, а не на область;
 * - **ED-24** — скелетом и живучестью записи состояния: зоны те же, что у
 *   соседей, поиск находит систему по имени, а без открытого проекта область
 *   называет причину, а не показывает пустой перечень.
 */
import { describe, expect, it } from 'vitest';
import { loadScene, type SceneDef } from '@fluxus/core';
import {
  createEditorSession,
  createMemoryHost,
  createOperationRegistry,
  getAtPath,
  registerBuiltinOperations,
  type EditorSession,
  type JsonValue,
} from '@fluxus/editor-core';
import { findAll, type UiNode } from '../src/dom/node.js';
import {
  SYSTEMS_AREA_ID,
  SYSTEMS_AREA_KEYS,
  SYSTEM_DOCUMENT_KIND,
  SYSTEM_LISTS,
  createSystemsArea,
  systemsArea,
  type SystemsAreaState,
} from '../src/areas/systems.js';
import {
  SYSTEM_LIST,
  systemRecords,
  triggerOf,
  type SystemRecord,
} from '../src/areas/systemsDocuments.js';
import { registerSystemOperations } from '../src/areas/systemsOperations.js';
import { buildFrame, buttonByKey, press, zoneOf } from './support/frame.js';
import { stubArea } from './support/stubArea.js';
import { settle } from './support/project.js';

const CONFIG = 'scenes/systems.scene.json';

/**
 * Сцена-фикстура настоящая: она проходит `loadScene` вместе со своими
 * системами. Иначе проверка «собранное принимает ядро» проверяла бы саму себя.
 */
const SCENE = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { hp: 'i32' } },
  ],
  prefabs: [
    { name: 'Hero', components: { Position: { x: 0, y: 0 }, Health: { hp: 10 } } },
    { name: 'Explosion', components: { Position: { x: 0, y: 0 } } },
  ],
  initial: [{ prefab: 'Hero' }],
  systems: [{ name: 'regen', order: 10, query: { all: ['Health'] }, do: [] }],
  terrain: { width: 2, height: 2, tileSize: 65536, levels: ['00', '00'], flags: ['..', '..'] },
  capacity: 32,
};

interface Opened {
  readonly frame: ReturnType<typeof buildFrame>['frame'];
  readonly session: EditorSession;
  readonly state: SystemsAreaState;
  readonly areaId: string;
}

/**
 * Область с открытым проектом. Документ читается НАСТОЯЩИМ хостом среды
 * (ED-12) — дерево в памяти и есть его тестовый дубль, — а набор операций
 * приносится тем же реестром, что у сборки: без него область правит документ
 * нечем (ED-25, ED-29).
 */
async function opened(scene: unknown = SCENE): Promise<Opened> {
  const host = createMemoryHost({
    name: 'systems',
    root: { label: 'systems' },
    files: { [CONFIG]: JSON.stringify(scene) },
  });
  const area = createSystemsArea({ host, config: CONFIG });
  const fixture = buildFrame([area, stubArea]);
  registerSystemOperations(fixture.session.operations);
  // Активная область — первая по идентификатору, а не первая в списке: рельс
  // показывает реестр в его порядке (ED-23). Область систем выбирается явно.
  fixture.frame.activate(area.id);
  const state = fixture.frame.stateOf(area.id) as SystemsAreaState;
  await settle();
  fixture.frame.view();
  return { frame: fixture.frame, session: fixture.session, state, areaId: area.id };
}

/** Поле по ключу его подписи: подпись приходит из ресурса (ED-27). */
function fieldByKey(root: UiNode, key: string): UiNode | undefined {
  return findAll(
    root,
    (node) =>
      (node.tag === 'input' || node.tag === 'select') && node.labels?.ariaLabel?.key === key,
  )[0];
}

/** Контрол строки слота: строка помечена именем места в документе. */
function slotField(root: UiNode, slot: string, tag = 'select'): UiNode | undefined {
  for (const row of findAll(root, (node) => node.attrs?.['data-slot'] === slot)) {
    const found = findAll(row, (node) => node.tag === tag)[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Ввод: контрол отдаёт значение по `change` — от фокуса до подтверждения (ED-18). */
function commit(node: UiNode | undefined, value: string): void {
  const handler = node?.on?.change;
  if (handler === undefined) throw new Error(`контрол не принимает ввод: ${String(node?.tag)}`);
  handler({ target: { value } } as unknown as Event);
}

const configOf = (session: EditorSession): JsonValue => session.documentValue(CONFIG);

const recordsOf = (session: EditorSession): readonly SystemRecord[] =>
  systemRecords(configOf(session), session.descriptors(CONFIG, SYSTEM_LIST));

const namesOf = (session: EditorSession): readonly string[] =>
  recordsOf(session).map((record) => record.name);

/** Значения опций выбора — то, что автору вообще предлагается. */
function optionsOf(node: UiNode | undefined): readonly string[] {
  return findAll(node ?? { tag: 'none' }, (child) => child.tag === 'option')
    .map((child) => child.attrs?.value ?? '')
    .filter((value) => value !== '');
}

describe('ED-4: реакция на событие собирается из блоков', () => {
  it('«при смерти сущности заспавнить взрыв» — от пустой системы до сцены, которую принимает ядро', async () => {
    const { frame, session, areaId } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');

    // Система заводится именем: место в тике операция берёт свободным (SYS-2).
    commit(fieldByKey(surface(), 'ui.area.systems.systemName'), 'on_death');
    press(buttonByKey(surface(), 'ui.area.systems.createSystem'));
    expect(namesOf(session)).toEqual(['regen', 'on_death']);
    const created = recordsOf(session)[1];
    expect(created?.order).toBe(11);
    // Созданное выделено: дескриптор дописанной записи отдаёт сама операция.
    expect(frame.selection.get(areaId)).toEqual([created?.key]);

    // Блок «событие»: источник — событие, а не тик.
    commit(fieldByKey(surface(), 'ui.area.systems.source'), 'event');
    commit(slotField(surface(), 'type', 'input'), 'EntityDied');
    // Имя ссылки на событие обязательно (ACT-1): без него ядро систему не примет.
    commit(slotField(surface(), 'as', 'input'), 'died');

    // Блок «действия»: имя действия — из закрытого набора ядра, а не из ввода.
    const palette = fieldByKey(surface(), 'ui.area.systems.action');
    expect(optionsOf(palette)).toContain('spawnEntity');
    commit(palette, 'spawnEntity');
    press(buttonByKey(surface(), 'ui.area.systems.addAction'));

    // Слот действия — из конвенции SYS-3, а не из таблицы аргументов.
    commit(fieldByKey(surface(), 'ui.area.systems.slot'), 'prefab');
    press(buttonByKey(surface(), 'ui.area.systems.addSlot'));

    // Пикер prefab'а предлагает ровно то, что принимает ядро (`prefabOf`).
    const prefabs = slotField(surface(), 'prefab');
    expect(optionsOf(prefabs)).toContain('Explosion');
    commit(prefabs, 'Explosion');

    // На диске — JSON-AST, которого автор не набирал ни строчки.
    expect(getAtPath(configOf(session), [...SYSTEM_LIST, 1])).toEqual({
      name: 'on_death',
      order: 11,
      do: [
        {
          forEachEvent: {
            type: 'EntityDied',
            as: 'died',
            do: [{ spawnEntity: { prefab: 'Explosion' } }],
          },
        },
      ],
    });

    // Вердикт выносит ядро: собранная сцена поднимается им целиком.
    expect(() => loadScene(configOf(session) as unknown as SceneDef)).not.toThrow();
  });

  it('переключение источника не теряет собранного тела', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    frame.selection.set(SYSTEMS_AREA_ID, [recordsOf(session)[0]?.key ?? '']);
    frame.view();

    // У фикстурной системы источник — запрос; поставим ей действие в тело.
    commit(fieldByKey(surface(), 'ui.area.systems.action'), 'destroyEntity');
    press(buttonByKey(surface(), 'ui.area.systems.addAction'));
    const body = getAtPath(configOf(session), [...SYSTEM_LIST, 0, 'do']);
    expect(body).toEqual([{ destroyEntity: {} }]);

    // Запрос → событие: тело уезжает внутрь узла события целиком.
    commit(fieldByKey(surface(), 'ui.area.systems.source'), 'event');
    const record = () => getAtPath(configOf(session), [...SYSTEM_LIST, 0]);
    expect(getAtPath(record() ?? null, ['query'])).toBeUndefined();
    expect(triggerOf(record()).source).toBe('event');
    expect(getAtPath(record() ?? null, ['do', 0, 'forEachEvent', 'do'])).toEqual([
      { destroyEntity: {} },
    ]);

    // Событие → тик: тело возвращается на место узла, а не пропадает.
    commit(fieldByKey(surface(), 'ui.area.systems.source'), 'tick');
    expect(triggerOf(record()).source).toBe('tick');
    expect(getAtPath(record() ?? null, ['do'])).toEqual([{ destroyEntity: {} }]);
  });
});

describe('ED-29: каждая правка системы обратима', () => {
  it('у всякого действия автора есть запись истории, и отмена возвращает документ', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    const before = configOf(session);

    commit(fieldByKey(surface(), 'ui.area.systems.systemName'), 'aggro');
    press(buttonByKey(surface(), 'ui.area.systems.createSystem'));
    const afterCreate = configOf(session);
    expect(session.history().undo).toHaveLength(1);

    commit(fieldByKey(surface(), 'ui.area.systems.action'), 'emitEvent');
    press(buttonByKey(surface(), 'ui.area.systems.addAction'));
    expect(session.history().undo).toHaveLength(2);

    expect(session.undo()).toBe(true);
    expect(configOf(session)).toEqual(afterCreate);
    expect(session.undo()).toBe(true);
    expect(configOf(session)).toEqual(before);
    expect(namesOf(session)).toEqual(['regen']);
  });

  it('правка блока идёт зарегистрированной операцией: своего пути записи у области нет', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    frame.selection.set(SYSTEMS_AREA_ID, [recordsOf(session)[0]?.key ?? '']);
    frame.view();

    commit(fieldByKey(surface(), 'ui.area.systems.action'), 'destroyEntity');
    press(buttonByKey(surface(), 'ui.area.systems.addAction'));

    const entry = session.history().undo.at(-1);
    // Имя операции в истории — то же, которым правка исполнима без интерфейса.
    expect(entry?.operationId).toBe('systems.node.append');
  });
});

describe('ED-23: области разные, а история и документ — общие', () => {
  it('правка системы отменяется, когда автор ушёл в другую область', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    commit(fieldByKey(surface(), 'ui.area.systems.systemName'), 'aggro');
    press(buttonByKey(surface(), 'ui.area.systems.createSystem'));
    expect(namesOf(session)).toEqual(['regen', 'aggro']);

    // Уход в соседнюю область: история принадлежит сессии, а не области.
    frame.activate(stubArea.id);
    frame.view();
    expect(session.canUndo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(namesOf(session)).toEqual(['regen']);

    // И возврат: запись состояния области та же, что была (ED-23).
    frame.activate(SYSTEMS_AREA_ID);
    expect(frame.stateOf(SYSTEMS_AREA_ID)).toBe(frame.stateOf(SYSTEMS_AREA_ID));
  });

  it('раскрытый блок триггера переживает уход в другую область и возврат', async () => {
    const { frame, state } = await opened();
    expect(frame.handleAreaKey({ code: 'KeyE', phase: 'down', repeat: false })).toBe(true);
    expect(state.block).toBe('event');

    frame.activate(stubArea.id);
    frame.view();
    frame.activate(SYSTEMS_AREA_ID);
    expect((frame.stateOf(SYSTEMS_AREA_ID) as SystemsAreaState).block).toBe('event');
  });

  it('раскладка клавиш объявлена данными вклада, и каждая клавиша что-то значит (ED-32)', async () => {
    const { frame, state } = await opened();
    expect(SYSTEMS_AREA_KEYS.map((key) => key.code)).toEqual(['KeyE', 'KeyD', 'KeyA']);
    for (const key of SYSTEMS_AREA_KEYS) {
      expect(frame.handleAreaKey({ code: key.code, phase: 'down', repeat: false })).toBe(true);
    }
    expect(state.block).toBe('actions');
    // Чужая клавиша область не забирает: разбор держит каркас (ED-32).
    expect(frame.handleAreaKey({ code: 'KeyZ', phase: 'down', repeat: false })).toBe(false);
  });
});

describe('ED-24: скелет, поиск и отсутствие проекта', () => {
  it('три зоны те же, что у соседей', async () => {
    const { frame } = await opened();
    const page = frame.view();
    for (const zone of ['navigator', 'surface', 'inspector'] as const) {
      expect(zoneOf(page, zone)).toBeDefined();
    }
  });

  it('поиск находит систему по имени и открывает её выделением', async () => {
    const { frame, session, areaId } = await opened();
    const key = recordsOf(session)[0]?.key;
    frame.setSearchQuery('reg');
    // Поиск сквозной (ED-23), и находки соседних областей приходят вместе с
    // нашими: своя опознаётся дескриптором записи, а не порядком в списке.
    const hit = frame.paletteEntries().find((entry) => entry.id === `hit:${SYSTEMS_AREA_ID}/${key ?? ''}`);
    expect(hit?.label.value).toBe('regen');
    hit?.run();
    expect(frame.selection.get(areaId)).toEqual([key]);
  });

  it('без открытого проекта область называет причину, а не показывает пустой перечень', () => {
    const fixture = buildFrame([systemsArea, stubArea]);
    fixture.frame.activate(SYSTEMS_AREA_ID);
    fixture.frame.view();
    const navigator = zoneOf(fixture.frame.view(), 'navigator');
    const reasons = findAll(navigator, (node) => node.attrs?.['data-severity'] !== undefined);
    expect(reasons.length).toBeGreaterThan(0);
    expect(findAll(navigator, (node) => node.attrs?.['data-list'] !== undefined)).toEqual([]);
  });

  it('вид редактируемого объявлен вкладом (ED-30)', () => {
    expect(systemsArea.editableTypes.map((type) => type.id)).toEqual([SYSTEM_DOCUMENT_KIND]);
    expect(systemsArea.id).toBe(SYSTEMS_AREA_ID);
    // Список, без которого записи не адресуются, назван вкладом: сборка обязана
    // открыть документ с ним, и вторым открытием его уже не дописать (ED-29).
    expect(SYSTEM_LISTS).toEqual([SYSTEM_LIST]);
  });
});

/**
 * Перечень систем — такой же порядок документа, как перечень расстановки: место
 * в тике задаёт `order` (SYS-2), а порядок записей — то, в каком виде автор
 * читает файл (ED-21). «Перестановка MUST NOT быть побочным эффектом» (ED-16)
 * проверяемо только тем, что переставить нечем НИ ОДНОЙ зарегистрированной
 * операцией, — поэтому перебирается весь реестр, а не список «этих операций».
 */
describe('ED-16: порядок систем не переставляется ни одной операцией', () => {
  const ORDERED = {
    ...SCENE,
    systems: [
      { name: 'regen', order: 10, query: { all: ['Health'] }, do: [] },
      { name: 'aggro', order: 20, do: [] },
      { name: 'decay', order: 30, do: [] },
    ],
  };

  function prepared(): EditorSession {
    const session = createEditorSession({
      operations: registerSystemOperations(registerBuiltinOperations(createOperationRegistry())),
    });
    session.openDocument({
      id: CONFIG,
      kind: 'scene',
      value: structuredClone(ORDERED),
      lists: [SYSTEM_LIST],
    });
    return session;
  }

  const record = (session: EditorSession, index: number): string =>
    session.descriptors(CONFIG, SYSTEM_LIST)[index] ?? '';

  const fixtures: Readonly<Record<string, (session: EditorSession) => Record<string, JsonValue>>> = {
    'document.setValue': () => ({ document: CONFIG, path: ['capacity'], value: 64 }),
    'document.removeValue': () => ({ document: CONFIG, path: ['capacity'] }),
    'document.renameKey': () => ({ document: CONFIG, path: ['terrain'], from: 'width', to: 'w' }),
    'document.list.append': () => ({
      document: CONFIG,
      list: [...SYSTEM_LIST],
      item: { name: 'extra', order: 40, do: [] },
    }),
    'document.list.remove': (session) => ({ document: CONFIG, record: record(session, 1) }),
    'document.list.setValue': (session) => ({
      document: CONFIG,
      record: record(session, 1),
      path: ['order'],
      value: 5,
    }),
    'document.list.removeValue': (session) => ({
      document: CONFIG,
      record: record(session, 0),
      path: ['query'],
    }),
    'systems.system.create': () => ({ document: CONFIG, list: [...SYSTEM_LIST], name: 'extra' }),
    'systems.node.append': (session) => ({
      document: CONFIG,
      record: record(session, 1),
      path: ['do'],
      node: { destroyEntity: {} },
    }),
    'systems.trigger.setSource': (session) => ({
      document: CONFIG,
      record: record(session, 1),
      source: 'event',
    }),
  };

  const registered = [
    ...registerBuiltinOperations(createOperationRegistry()).list(),
    ...registerSystemOperations(createOperationRegistry()).list(),
  ].map((operation) => operation.id);

  it('у каждой зарегистрированной операции есть заготовка', () => {
    expect(registered.filter((id) => !(id in fixtures))).toEqual([]);
    expect(Object.keys(fixtures).filter((id) => !registered.includes(id))).toEqual([]);
  });

  for (const operationId of registered) {
    it(`${operationId} не переставляет системы`, () => {
      const session = prepared();
      const before = namesOf(session);
      session.applyOperation(operationId, fixtures[operationId]!(session));
      const after = namesOf(session);
      // Уцелевшие имена идут в прежнем относительном порядке, а новое — в конце.
      expect(after.filter((name) => before.includes(name))).toEqual(
        before.filter((name) => after.includes(name)),
      );
      for (const [index, name] of after.entries()) {
        if (!before.includes(name)) expect(index).toBe(after.length - 1);
      }
    });
  }
});

describe('ED-29: без отслеживаемого перечня область называет причину', () => {
  it('конфиг, открытый без списка систем, — не «систем нет», а «список не отслеживают»', async () => {
    const host = createMemoryHost({
      name: 'systems',
      root: { label: 'systems' },
      files: { [CONFIG]: JSON.stringify(SCENE) },
    });
    const area = createSystemsArea({ host, config: CONFIG });
    const fixture = buildFrame([area, stubArea]);
    // Документ открыл кто-то другой и без списка: дописать список вторым
    // открытием нельзя, и сборка обязана открывать конфиг сразу со всеми.
    fixture.session.openDocument({
      id: CONFIG,
      kind: 'scene',
      value: structuredClone(SCENE),
    });
    fixture.frame.activate(area.id);
    const state = fixture.frame.stateOf(area.id) as SystemsAreaState;
    await settle();
    const navigator = zoneOf(fixture.frame.view(), 'navigator');

    expect(state.configId).toBe(CONFIG);
    expect(state.tracked).toBe(false);
    const reasons = findAll(navigator, (node) => node.attrs?.['data-severity'] === 'error');
    expect(reasons.length).toBeGreaterThan(0);
  });
});
