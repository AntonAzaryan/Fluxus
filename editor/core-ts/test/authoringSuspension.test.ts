/**
 * Приостановка авторинга: «в превью операции авторинга недоступны, превью MUST
 * NOT записывать что-либо в документы» (ED-9) — держится сессией, а не
 * недоступностью элементов интерфейса (ED-26).
 *
 * Пиннится именно то, что делает запрет структурным: прямой вызов
 * `applyOperation` мимо интерфейса (ED-29 требует исполнимости без него)
 * отклоняется; отказ адресуем наравне с прочими отказами операций (ED-30) и не
 * оставляет ни полуправки, ни отличия в байтах документа; незакрытое
 * взаимодействие приостановку не переживает (ED-18); отмена и повтор — авторинг
 * наравне с операциями; снятие возвращает ровно то, что было доступно до.
 *
 * Байты документа сравниваются сериализатором ядра, как в `conformance.ts`:
 * канонический вид — правило ядра, и второй его реализации в редакторе быть не
 * должно (ED-1, ED-21).
 */
import { jsonSerializer } from '@game-mvp/core';
import { describe, expect, it } from 'vitest';
import {
  createEditorSession,
  type EditorSession,
  type SessionEventKind,
} from '../src/document/index.js';
import {
  AUTHORING_ACTIONS,
  AUTHORING_SUSPENDED,
  AuthoringSuspendedError,
  createOperationRegistry,
  describeOperations,
  registerBuiltinOperations,
} from '../src/operations/index.js';
import { buildEditorCatalog } from '../src/registry/catalog.js';
import { createEditorContributions } from '../src/registry/contributions.js';

const SCENE = 'content/scenes/demo.json';
const decoder = new TextDecoder();

function session(): EditorSession {
  const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
  editor.openDocument({
    id: SCENE,
    kind: 'scene',
    value: { title: 'арена', initial: [{ prefab: 'unit' }] },
    lists: [['initial']],
  });
  return editor;
}

/** Побайтовый снимок документа — то же сравнение, что даёт пустой дифф файла. */
const bytes = (editor: EditorSession): string =>
  decoder.decode(jsonSerializer.encode(editor.documentValue(SCENE)));

const kinds = (editor: EditorSession, into: SessionEventKind[]): (() => void) =>
  editor.subscribe((event) => into.push(event.kind));

describe('ED-9: авторинг отказывает сессия, а не недоступность элемента', () => {
  it('прямой `applyOperation` мимо интерфейса отклоняется, пока авторинг приостановлен', () => {
    const editor = session();
    editor.suspendAuthoring('превью');

    let refusal: unknown;
    try {
      editor.applyOperation('document.setValue', { document: SCENE, path: ['title'], value: 'другая' });
    } catch (error) {
      refusal = error;
    }

    // Отказ адресуем так же, как всякий отказ операции (ED-30): код, отклонённое
    // действие, названные причины и id того, что отклонено.
    expect(refusal).toBeInstanceOf(AuthoringSuspendedError);
    const error = refusal as AuthoringSuspendedError;
    expect(error.code).toBe(AUTHORING_SUSPENDED);
    expect(error.action).toBe('apply');
    expect(error.operationId).toBe('document.setValue');
    expect(error.reasons).toEqual(['превью']);
  });

  it('отказ не оставляет полуправки: документ побайтово тот же, и в истории пусто', () => {
    const editor = session();
    const before = bytes(editor);
    const dirtyBefore = editor.dirtyDocumentIds();
    editor.suspendAuthoring('превью');

    expect(() =>
      editor.applyOperation('document.list.append', {
        document: SCENE,
        list: ['initial'],
        item: { prefab: 'другой' },
      }),
    ).toThrow(AuthoringSuspendedError);

    expect(bytes(editor)).toBe(before);
    expect(editor.descriptors(SCENE, ['initial'])).toHaveLength(1);
    expect(editor.history().undo).toEqual([]);
    // `dirty` — сравнение ссылок: отказ не только не изменил значение, но и не
    // подменил его равным (ED-21).
    expect(editor.dirtyDocumentIds()).toEqual(dirtyBefore);
    expect(editor.pending).toBe(false);
  });

  it('начало взаимодействия отклоняется тем же отказом, названным своим действием', () => {
    const editor = session();
    editor.suspendAuthoring('превью');
    try {
      editor.beginOperation('document.setValue', { document: SCENE, path: ['title'], value: 'другая' });
      expect.unreachable('взаимодействие не должно было начаться');
    } catch (error) {
      expect((error as AuthoringSuspendedError).action).toBe('begin');
    }
  });

  it('состояние читается без попытки написать: приостановлен ли авторинг и почему', () => {
    const editor = session();
    expect(editor.authoringSuspended).toBe(false);
    const suspension = editor.suspendAuthoring('превью');
    expect(editor.authoringSuspended).toBe(true);
    expect(editor.suspensionReasons()).toEqual(['превью']);
    expect(suspension.active).toBe(true);
    suspension.resume();
    expect(editor.authoringSuspended).toBe(false);
    expect(editor.suspensionReasons()).toEqual([]);
    expect(suspension.active).toBe(false);
  });

  it('приостановка без причины не берётся: отказ назвал бы пустое основание', () => {
    const editor = session();
    expect(() => editor.suspendAuthoring('  ')).toThrow(/без причины/);
    expect(editor.authoringSuspended).toBe(false);
  });
});

describe('ED-9, ED-18: незакрытое взаимодействие приостановку не переживает', () => {
  it('открытый мазок снимается самой приостановкой, а не тем, кто её берёт', () => {
    const editor = session();
    const before = bytes(editor);
    const events: SessionEventKind[] = [];

    const stroke = editor.beginOperation('document.setValue', {
      document: SCENE,
      path: ['title'],
      value: 'первый шаг',
    });
    stroke.extend({ document: SCENE, path: ['title'], value: 'второй шаг' });
    expect(editor.pending).toBe(true);

    kinds(editor, events);
    editor.suspendAuthoring('превью');

    // Документы вернулись к состоянию до начала взаимодействия, подписчик узнал
    // об этом обычным `cancelled` (ED-15), в истории записи нет (ED-18).
    expect(bytes(editor)).toBe(before);
    expect(editor.pending).toBe(false);
    expect(editor.history().undo).toEqual([]);
    expect(events).toEqual(['cancelled', 'suspended']);
  });

  it('ведущий взаимодействие узнаёт причину, а его собственная отмена уже ничего не ломает', () => {
    const editor = session();
    const stroke = editor.beginOperation('document.setValue', {
      document: SCENE,
      path: ['title'],
      value: 'шаг',
    });
    editor.suspendAuthoring('превью');

    expect(() => stroke.extend({ document: SCENE, path: ['title'], value: 'ещё шаг' })).toThrow(
      /снято приостановкой авторинга/,
    );
    expect(() => stroke.commit()).toThrow(/снято приостановкой авторинга/);
    // Отмена того, что уже отменено приостановкой, — не ошибка: просят ровно
    // того, что произошло, и держащий транзакцию не обязан помнить про чужую
    // приостановку.
    expect(() => stroke.cancel()).not.toThrow();
    expect(editor.history().undo).toEqual([]);
  });
});

describe('ED-9, ED-18: отмена и повтор — авторинг наравне с операциями', () => {
  it('undo и redo отклоняются, пока авторинг приостановлен, и документ не меняется', () => {
    const editor = session();
    editor.applyOperation('document.setValue', { document: SCENE, path: ['title'], value: 'правка' });
    const applied = bytes(editor);

    const suspension = editor.suspendAuthoring('превью');
    expect(editor.canUndo()).toBe(false);
    expect(() => editor.undo()).toThrow(AuthoringSuspendedError);
    expect(bytes(editor)).toBe(applied);

    suspension.resume();
    editor.undo();
    const undone = bytes(editor);
    editor.suspendAuthoring('превью');
    expect(editor.canRedo()).toBe(false);
    expect(() => editor.redo()).toThrow(AuthoringSuspendedError);
    expect(bytes(editor)).toBe(undone);
  });

  it('отказ отмены называет операцию, которую отменять', () => {
    const editor = session();
    editor.applyOperation('document.setValue', { document: SCENE, path: ['title'], value: 'правка' });
    editor.suspendAuthoring('превью');
    try {
      editor.undo();
      expect.unreachable('отмена не должна была пройти');
    } catch (error) {
      const refusal = error as AuthoringSuspendedError;
      expect(refusal.action).toBe('undo');
      expect(refusal.operationId).toBe('document.setValue');
    }
  });
});

describe('ED-9: снятие возвращает ровно то, что было доступно до', () => {
  it('после снятия проходят и операция, и отмена, и повтор', () => {
    const editor = session();
    editor.applyOperation('document.setValue', { document: SCENE, path: ['title'], value: 'правка' });
    const applied = bytes(editor);

    const suspension = editor.suspendAuthoring('превью');
    suspension.resume();

    expect(editor.authoringSuspended).toBe(false);
    expect(editor.canUndo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.canRedo()).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(bytes(editor)).toBe(applied);
    const outcome = editor.applyOperation('document.setValue', {
      document: SCENE,
      path: ['title'],
      value: 'ещё правка',
    });
    expect(outcome.recorded).toBe(true);
  });

  it('снявший свою приостановку не снимает чужую', () => {
    const editor = session();
    const preview = editor.suspendAuthoring('превью');
    const importer = editor.suspendAuthoring('импорт');

    preview.resume();
    expect(editor.authoringSuspended).toBe(true);
    expect(editor.suspensionReasons()).toEqual(['импорт']);
    expect(() =>
      editor.applyOperation('document.setValue', { document: SCENE, path: ['title'], value: 'правка' }),
    ).toThrow(AuthoringSuspendedError);
    // Повторное снятие тем же правом ничего не делает — в том числе не снимает
    // чужого: назвать чужую приостановку нечем.
    preview.resume();
    expect(editor.authoringSuspended).toBe(true);

    importer.resume();
    expect(editor.authoringSuspended).toBe(false);
  });

  it('о смене состояния оповещается один раз на переход, а не на каждую заявку', () => {
    const editor = session();
    const events: SessionEventKind[] = [];
    kinds(editor, events);
    const first = editor.suspendAuthoring('превью');
    const second = editor.suspendAuthoring('импорт');
    first.resume();
    second.resume();
    expect(events).toEqual(['suspended', 'resumed']);
  });
});

describe('ED-30: каталог объявляет, что такое состояние есть', () => {
  it('каталог называет код отказа и покрываемые им входы, но не живой флаг', () => {
    const contributions = createEditorContributions();
    const operations = registerBuiltinOperations(createOperationRegistry());
    const catalog = buildEditorCatalog({
      contributions,
      operations: () => describeOperations(operations),
      descriptions: { describe: (key) => key },
    });

    expect(catalog.authoringSuspension.refusal).toBe(AUTHORING_SUSPENDED);
    expect(catalog.authoringSuspension.covers).toEqual([...AUTHORING_ACTIONS]);
    // Живого состояния в каталоге нет: каталог строится из реестров и сессии не
    // видит, а снимок протух бы к моменту прочтения.
    expect(Object.keys(catalog.authoringSuspension).sort()).toEqual(['covers', 'refusal']);
  });
});
