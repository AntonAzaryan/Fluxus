/**
 * Модель документа, сессия и история операций.
 *
 * Пиннится не поведение отдельных методов, а свойства требований: ED-29
 * («правка только зарегистрированной операцией», устойчивая адресация), ED-18
 * (обратимость, взаимодействие как граница операции, отбрасывание старейшего),
 * ED-23 (история одна на сессию), ED-21 (несохранённые правки — ровно у тех
 * документов, где они есть).
 */
import { describe, expect, it } from 'vitest';
import {
  createEditorSession,
  DESCRIPTOR_SCOPE,
  type EditorSession,
  type JsonValue,
} from '../src/document/index.js';
import {
  createOperationRegistry,
  registerBuiltinOperations,
  type AuthoringOperation,
  type OperationContext,
} from '../src/operations/index.js';

function session(historyDepth?: number): EditorSession {
  const operations = registerBuiltinOperations(createOperationRegistry());
  return createEditorSession(historyDepth === undefined ? { operations } : { operations, historyDepth });
}

const SCENE = 'content/scenes/demo.json';

function openScene(editor: EditorSession, initial: readonly unknown[] = []): void {
  editor.openDocument({
    id: SCENE,
    kind: 'scene',
    value: { components: [], initial: initial as never },
    // Путь отслеживаемого списка приносит открывающий: имя `initial` — доменное
    // знание конфига сцены (SER-7), а не знание каркаса (ED-25).
    lists: [['initial']],
  });
}

describe('ED-29: править документ можно только зарегистрированной операцией', () => {
  it('значение документа заморожено вглубь', () => {
    const editor = session();
    editor.openDocument({ id: SCENE, kind: 'scene', value: { components: [{ name: 'Pos' }] } });
    const value = editor.documentValue(SCENE) as { components: { name: string }[] };
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      value.components[0]!.name = 'Other';
    }).toThrow();
  });

  it('значение, переданное при открытии, копируется — ссылка у открывающего документ не правит', () => {
    const editor = session();
    const source: { title: string } = { title: 'исходный' };
    editor.openDocument({ id: SCENE, kind: 'scene', value: source });
    source.title = 'подменённый';
    expect(editor.documentValue(SCENE)).toEqual({ title: 'исходный' });
  });

  it('незарегистрированная операция не применяется', () => {
    const editor = session();
    openScene(editor);
    expect(() => editor.applyOperation('document.magic', { document: SCENE })).toThrow(/не зарегистрирована/);
  });

  it('поверхность правки не работает после закрытия взаимодействия', () => {
    const registry = registerBuiltinOperations(createOperationRegistry());
    let stashed: OperationContext | undefined;
    const sneaky: AuthoringOperation = {
      id: 'test.stash',
      descriptionKey: 'test.stash',
      params: { document: { type: 'document', descriptionKey: 'test.document' } },
      apply(ctx, params) {
        stashed = ctx;
        ctx.setValue(params.document as string, ['touched'], true);
        return undefined;
      },
    };
    registry.register(sneaky);
    const editor = createEditorSession({ operations: registry });
    openScene(editor);
    editor.applyOperation('test.stash', { document: SCENE });
    expect(() => stashed!.setValue(SCENE, ['later'], true)).toThrow(/только внутри `apply`/);
    expect((editor.documentValue(SCENE) as Record<string, unknown>).later).toBeUndefined();
  });
});

describe('ED-29: адресация записи переживает правку соседей', () => {
  it('дескриптор указывает на ту же запись после удаления соседа', () => {
    const editor = session();
    openScene(editor, [{ prefab: 'a' }, { prefab: 'b' }, { prefab: 'c' }]);
    const [first, second, third] = editor.descriptors(SCENE, ['initial']);
    expect(editor.resolveDescriptor(SCENE, third!)?.index).toBe(2);
    editor.applyOperation('document.list.remove', { document: SCENE, record: second! });
    // Индекс третьей записи уехал, дескриптор — нет.
    expect(editor.resolveDescriptor(SCENE, third!)?.index).toBe(1);
    expect(editor.resolveDescriptor(SCENE, second!)).toBeUndefined();
    editor.applyOperation('document.list.setValue', {
      document: SCENE,
      record: third!,
      path: ['overrides', 'Pos', 'x'],
      value: 7,
    });
    expect(editor.documentValue(SCENE)).toEqual({
      components: [],
      initial: [{ prefab: 'a' }, { prefab: 'c', overrides: { Pos: { x: 7 } } }],
    });
    expect(editor.resolveDescriptor(SCENE, first!)?.index).toBe(0);
  });

  it('дескрипторы сессионные и восстанавливаются отменой', () => {
    const editor = session();
    openScene(editor, [{ prefab: 'a' }]);
    expect(DESCRIPTOR_SCOPE).toBe('session');
    const before = [...editor.descriptors(SCENE, ['initial'])];
    editor.applyOperation('document.list.append', { document: SCENE, list: ['initial'], item: { prefab: 'b' } });
    expect(editor.descriptors(SCENE, ['initial']).length).toBe(2);
    editor.undo();
    expect([...editor.descriptors(SCENE, ['initial'])]).toEqual(before);
  });

  it('запись отслеживаемого списка не адресуется путём с индексом', () => {
    const editor = session();
    openScene(editor, [{ prefab: 'a' }]);
    expect(() =>
      editor.applyOperation('document.setValue', { document: SCENE, path: ['initial', 0, 'prefab'], value: 'b' }),
    ).toThrow(/адресуются дескриптором/);
    expect(() =>
      editor.applyOperation('document.setValue', { document: SCENE, path: ['initial'], value: [] }),
    ).toThrow(/адресуются дескриптором/);
  });
});

describe('ED-29: обходных путей записи не остаётся', () => {
  it('запись не убирается правкой поля с пустым путём: иначе дескрипторы соседей уехали бы', () => {
    const editor = session();
    openScene(editor, [{ prefab: 'a' }, { prefab: 'b' }, { prefab: 'c' }]);
    const [first, second] = editor.descriptors(SCENE, ['initial']);
    expect(() =>
      editor.applyOperation('document.list.removeValue', { document: SCENE, record: first!, path: [] }),
    ).toThrow(/пустой путь адресует саму запись/);
    // Ни правки, ни сдвига адресации: список и таблица дескрипторов совпадают.
    expect(editor.descriptors(SCENE, ['initial'])).toHaveLength(3);
    expect(editor.resolveDescriptor(SCENE, second!)?.index).toBe(1);
    editor.applyOperation('document.list.remove', { document: SCENE, record: first! });
    expect(editor.descriptors(SCENE, ['initial'])).toHaveLength(2);
    expect(editor.resolveDescriptor(SCENE, second!)?.index).toBe(0);
  });

  it('удаление записи, которой в документе нет, отклоняется, а не убирает один дескриптор', () => {
    const editor = session();
    editor.openDocument({
      id: SCENE,
      kind: 'scene',
      value: { initial: [{ prefab: 'a', children: [{ prefab: 'x' }] }, { prefab: 'b' }] },
      lists: [['initial'], ['initial', 0, 'children']],
    });
    const [outer] = editor.descriptors(SCENE, ['initial']);
    const [inner] = editor.descriptors(SCENE, ['initial', 0, 'children']);
    // Удаление внешней записи уносит с собой и вложенный список: его дескриптор
    // указывает на адрес, по которому в документе больше ничего нет.
    editor.applyOperation('document.list.remove', { document: SCENE, record: outer! });
    expect(editor.resolveDescriptor(SCENE, inner!)).toBeDefined();
    expect(() => editor.applyOperation('document.list.remove', { document: SCENE, record: inner! })).toThrow(
      /ничего нет/,
    );
    // Запись и дескриптор — пара по индексу (ED-29): убрав дескриптор при
    // нетронутом списке, сессия сдвинула бы всех следующих на единицу, и под
    // курсором автора оказалась бы соседняя запись. Отказ не оставляет ни
    // сдвига, ни записи в истории (ED-18).
    expect(editor.descriptors(SCENE, ['initial', 0, 'children'])).toHaveLength(1);
    expect(editor.documentValue(SCENE)).toEqual({ initial: [{ prefab: 'b' }] });
    expect(editor.history().undo).toHaveLength(1);
    expect(editor.pending).toBe(false);
  });

  it('вложенный отслеживаемый список не правится индексом через запись внешнего', () => {
    const editor = session();
    editor.openDocument({
      id: SCENE,
      kind: 'scene',
      value: { initial: [{ prefab: 'a', children: [{ prefab: 'x' }] }] },
      lists: [['initial'], ['initial', 0, 'children']],
    });
    const [outer] = editor.descriptors(SCENE, ['initial']);
    expect(() =>
      editor.applyOperation('document.list.setValue', {
        document: SCENE,
        record: outer!,
        path: ['children', 0, 'prefab'],
        value: 'y',
      }),
    ).toThrow(/адресуются дескриптором/);
  });

  it('путь, переданный операции, не остаётся у вызывающего живой ссылкой', () => {
    const editor = session();
    openScene(editor);
    const path: (string | number)[] = ['capacity'];
    editor.applyOperation('document.setValue', { document: SCENE, path: path as never, value: 1 });
    path.push('дописано после вызова');
    expect(editor.history().undo[0]?.paths[0]?.path).toEqual(['capacity']);
  });

  it('ключ `__proto__` документа не теряется и не подменяет прототип', () => {
    const editor = session();
    // `JSON.parse` кладёт `__proto__` собственным ключом — документ с диска
    // может его нести, и потеря ключа была бы правкой мимо слоя операций.
    const parsed = JSON.parse('{"__proto__":{"a":1},"b":2}') as JsonValue;
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: parsed });
    const value = editor.documentValue('content/x.json') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['__proto__', 'b']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    editor.applyOperation('document.setValue', { document: 'content/x.json', path: ['b'], value: 3 });
    expect(Object.keys(editor.documentValue('content/x.json') as object)).toEqual(['__proto__', 'b']);
  });
});

describe('ED-18: undo/redo над операциями', () => {
  it('операция обратима и повторима', () => {
    const editor = session();
    openScene(editor);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 128 });
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [], capacity: 128 });
    expect(editor.undo()).toBe(true);
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [] });
    expect(editor.redo()).toBe(true);
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [], capacity: 128 });
  });

  it('ограничение глубины отбрасывает старейшие операции, а не ближайшие', () => {
    const editor = session(2);
    openScene(editor);
    for (const value of [1, 2, 3]) {
      editor.applyOperation('document.setValue', { document: SCENE, path: [`step${value}`], value });
    }
    expect(editor.history().dropped).toBe(1);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(false);
    // Отброшена самая старая: её правка осталась, две ближайшие отменены.
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [], step1: 1 });
  });

  it('новая операция обрывает ветку повтора', () => {
    const editor = session();
    openScene(editor);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['a'], value: 1 });
    editor.undo();
    expect(editor.canRedo()).toBe(true);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['b'], value: 2 });
    expect(editor.canRedo()).toBe(false);
  });
});

describe('ED-18: границей операции служит взаимодействие, а не событие ввода', () => {
  it('мазок из двадцати касаний — одна запись истории и одна отмена', () => {
    const editor = session();
    editor.openDocument({ id: 'content/terrain/a.json', kind: 'terrain', value: { levels: [] } });
    const cells = Array.from({ length: 20 }, (_, i) => i);
    const stroke = editor.beginOperation('document.setValue', {
      document: 'content/terrain/a.json',
      path: ['levels', 0],
      value: 1,
    });
    for (const cell of cells.slice(1)) {
      stroke.extend({ document: 'content/terrain/a.json', path: ['levels', cell], value: 1 });
    }
    const outcome = stroke.commit();
    expect(outcome.recorded).toBe(true);
    expect(editor.history().undo.length).toBe(1);
    expect(editor.documentValue('content/terrain/a.json')).toEqual({ levels: cells.map(() => 1) });
    editor.undo();
    expect(editor.documentValue('content/terrain/a.json')).toEqual({ levels: [] });
  });

  it('отменённое взаимодействие не оставляет ни правки, ни записи истории', () => {
    const editor = session();
    openScene(editor);
    const drag = editor.beginOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 1 });
    drag.extend({ document: SCENE, path: ['capacity'], value: 2 });
    drag.cancel();
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [] });
    expect(editor.canUndo()).toBe(false);
    expect(editor.pending).toBe(false);
  });

  it('упавшее применение не оставляет полуправки в незакрытом взаимодействии', () => {
    const registry = registerBuiltinOperations(createOperationRegistry());
    registry.register({
      id: 'test.half',
      descriptionKey: 'test.half',
      params: {
        document: { type: 'document', descriptionKey: 'test.document' },
        tag: { type: 'string', descriptionKey: 'test.tag' },
        boom: { type: 'boolean', descriptionKey: 'test.boom' },
      },
      apply(ctx, params) {
        ctx.setValue(params.document as string, ['half', params.tag as string], 1);
        if (params.boom === true) throw new Error('операция упала посередине');
        ctx.setValue(params.document as string, ['whole', params.tag as string], 2);
        return undefined;
      },
    });
    const editor = createEditorSession({ operations: registry });
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: {} });
    const stroke = editor.beginOperation('test.half', { document: 'content/x.json', tag: 'a', boom: false });
    expect(() => stroke.extend({ document: 'content/x.json', tag: 'b', boom: true })).toThrow(/посередине/);
    // Взаимодействие живо, но его состояние — то, к которому привело последнее
    // целиком применённое действие: половины упавшего в документе нет.
    const applied = { half: { a: 1 }, whole: { a: 2 } };
    expect(editor.documentValue('content/x.json')).toEqual(applied);
    stroke.commit();
    expect(editor.documentValue('content/x.json')).toEqual(applied);
    editor.undo();
    expect(editor.documentValue('content/x.json')).toEqual({});
  });

  it('состав документов и отметка о сохранении не меняются посреди взаимодействия', () => {
    const editor = session();
    openScene(editor);
    const drag = editor.beginOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 1 });
    expect(() => editor.markSaved(SCENE)).toThrow(/во время взаимодействия/);
    expect(() => editor.openDocument({ id: 'content/y.json', kind: 'any', value: {} })).toThrow(
      /во время взаимодействия/,
    );
    drag.cancel();
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });

  it('второе взаимодействие поверх незакрытого не начинается', () => {
    const editor = session();
    openScene(editor);
    const drag = editor.beginOperation('document.setValue', { document: SCENE, path: ['a'], value: 1 });
    expect(() => editor.applyOperation('document.setValue', { document: SCENE, path: ['b'], value: 2 })).toThrow(
      /ещё не закрыто/,
    );
    drag.cancel();
  });

  it('прежнее значение берётся с первого касания места, а не с последнего', () => {
    const editor = session();
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: { field: 'исходное' } });
    const typing = editor.beginOperation('document.setValue', {
      document: 'content/x.json',
      path: ['field'],
      value: 'и',
    });
    typing.extend({ document: 'content/x.json', path: ['field'], value: 'из' });
    typing.extend({ document: 'content/x.json', path: ['field'], value: 'изм' });
    typing.commit();
    editor.undo();
    expect(editor.documentValue('content/x.json')).toEqual({ field: 'исходное' });
  });
});

describe('ED-23: история одна на сессию', () => {
  it('отменяется правка того документа, который правили последним, независимо от области', () => {
    const editor = session();
    openScene(editor);
    editor.openDocument({ id: 'content/prefabs/hero.json', kind: 'prefab', value: { hp: 10 } });
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 64 });
    editor.applyOperation('document.setValue', { document: 'content/prefabs/hero.json', path: ['hp'], value: 20 });
    editor.undo();
    expect(editor.documentValue('content/prefabs/hero.json')).toEqual({ hp: 10 });
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [], capacity: 64 });
    editor.undo();
    expect(editor.documentValue(SCENE)).toEqual({ components: [], initial: [] });
  });
});

describe('ED-21: несохранённые правки', () => {
  it('сохранение касается только правленых документов, и отмена возвращает документ в чистое состояние', () => {
    const editor = session();
    openScene(editor);
    editor.openDocument({ id: 'content/prefabs/hero.json', kind: 'prefab', value: { hp: 10 } });
    expect(editor.dirtyDocumentIds()).toEqual([]);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 64 });
    expect(editor.dirtyDocumentIds()).toEqual([SCENE]);
    editor.undo();
    expect(editor.dirtyDocumentIds()).toEqual([]);
    editor.redo();
    editor.markSaved(SCENE);
    expect(editor.dirtyDocumentIds()).toEqual([]);
    editor.undo();
    expect(editor.dirtyDocumentIds()).toEqual([SCENE]);
  });

  it('запись того же значения правкой не считается', () => {
    const editor = session();
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: { hp: 10 } });
    const outcome = editor.applyOperation('document.setValue', { document: 'content/x.json', path: ['hp'], value: 10 });
    expect(outcome.recorded).toBe(false);
    expect(editor.dirtyDocumentIds()).toEqual([]);
    expect(editor.canUndo()).toBe(false);
  });
});

describe('сессия оповещает о правках (ED-15: изображение производно от документов)', () => {
  const log = (editor: EditorSession, events: string[]): (() => void) =>
    editor.subscribe((event) => {
      events.push(`${event.kind}:${event.paths.map((ref) => ref.path.join('.')).join('|')}`);
    });

  it('подписчик получает документ и путь тронутого места', () => {
    const editor = session();
    openScene(editor);
    const events: string[] = [];
    const off = log(editor, events);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 8 });
    editor.undo();
    off();
    editor.redo();
    // Одношаговый вызов закрывается тем же вызовом: промежуточного состояния,
    // которое кто-то мог бы увидеть, у него нет, и второго события о той же
    // правке он не даёт.
    expect(events).toEqual(['applied:capacity', 'undone:capacity']);
  });

  it('применение внутри незакрытого взаимодействия объявляется, а не ждёт закрытия', () => {
    const editor = session();
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: { pos: 0 } });
    const events: string[] = [];
    const off = log(editor, events);
    // Перетаскивание: правится одно и то же место, и каждое применение обязано
    // быть видно сразу — иначе объект встаёт на новое место только по
    // отпускании кнопки (ED-15).
    const drag = editor.beginOperation('document.setValue', { document: 'content/x.json', path: ['pos'], value: 1 });
    drag.extend({ document: 'content/x.json', path: ['pos'], value: 2 });
    // Применение, ничего не изменившее, события не даёт: то же значение —
    // не правка (ED-21).
    drag.extend({ document: 'content/x.json', path: ['pos'], value: 2 });
    drag.commit();
    off();
    // Вид события отличает провизорное состояние от записанного в историю.
    expect(events).toEqual(['extended:pos', 'extended:pos', 'applied:pos']);
  });

  it('объявленное открытым взаимодействием называется и в отказе', () => {
    const editor = session();
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: { pos: 0 } });
    const events: string[] = [];
    const off = log(editor, events);
    const drag = editor.beginOperation('document.setValue', { document: 'content/x.json', path: ['pos'], value: 1 });
    drag.extend({ document: 'content/x.json', path: ['pos'], value: 0 });
    drag.cancel();
    off();
    expect(events).toEqual(['extended:pos', 'extended:pos', 'cancelled:pos']);
    expect(editor.documentValue('content/x.json')).toEqual({ pos: 0 });
  });

  it('упавшее применение не объявляется: откаченного состояния подписчик не видел', () => {
    const editor = session();
    openScene(editor, [{ prefab: 'a' }]);
    const events: string[] = [];
    const off = log(editor, events);
    const stroke = editor.beginOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 1 });
    expect(() => stroke.extend({ document: SCENE, path: ['initial', 0, 'prefab'], value: 'b' })).toThrow();
    stroke.commit();
    off();
    expect(events).toEqual(['extended:capacity', 'applied:capacity']);
  });
});

describe('закрытие документа', () => {
  it('документ, упомянутый в истории, не закрывается: иначе в истории останется дыра', () => {
    const editor = session();
    openScene(editor);
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 8 });
    editor.markSaved(SCENE);
    expect(() => editor.closeDocument(SCENE)).toThrow(/упомянут в истории/);
  });
});
