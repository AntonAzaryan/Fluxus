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
import { createEditorSession, DESCRIPTOR_SCOPE, type EditorSession } from '../src/document/index.js';
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
  it('подписчик получает документ и путь тронутого места', () => {
    const editor = session();
    openScene(editor);
    const events: string[] = [];
    const off = editor.subscribe((event) => {
      events.push(`${event.kind}:${event.paths.map((ref) => ref.path.join('.')).join('|')}`);
    });
    editor.applyOperation('document.setValue', { document: SCENE, path: ['capacity'], value: 8 });
    editor.undo();
    off();
    editor.redo();
    expect(events).toEqual(['applied:capacity', 'undone:capacity']);
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
