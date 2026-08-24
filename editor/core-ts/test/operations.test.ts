/**
 * Реестр операций и его само-описание: ED-25 (вклад добавляется регистрацией и
 * не правит уже зарегистрированное), ED-29 (набор операций один), ED-30
 * (машинный каталог строится из того же реестра и объявляет сессионность
 * дескрипторов), ED-28 (описания приходят ключом ресурса, а не текстом).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_OPERATIONS,
  OPERATION_PARAM_TYPES,
  OperationError,
  SESSION_SCOPED_TYPES,
  createOperationRegistry,
  describeOperations,
  registerBuiltinOperations,
  type AuthoringOperation,
  type OperationParams,
} from '../src/operations/index.js';
import { createEditorSession, DESCRIPTOR_SCOPE, type EditorSession } from '../src/document/index.js';
import { encodeDocument } from '../src/project/index.js';

const noop: AuthoringOperation = {
  id: 'test.noop',
  descriptionKey: 'test.noop',
  params: {},
  apply: () => undefined,
};

describe('ED-25: реестр вкладов', () => {
  it('повторная регистрация того же id — отказ, а не замена', () => {
    const registry = createOperationRegistry();
    registry.register(noop);
    expect(() => { registry.register({ ...noop }); }).toThrow(/уже зарегистрирована/);
  });

  it('операция и её параметр без ключа описания не регистрируются', () => {
    const registry = createOperationRegistry();
    expect(() => { registry.register({ ...noop, id: 'a.op', descriptionKey: '' }); }).toThrow(
      /пустой ключ описания/,
    );
    expect(() =>
      { registry.register({
        ...noop,
        id: 'b.op',
        params: { value: { type: 'json', descriptionKey: '  ' } },
      }); },
    ).toThrow(/пустой ключ описания параметра "value"/);
  });

  it('перечень упорядочен по id, а не по порядку регистрации', () => {
    const registry = createOperationRegistry();
    registry.register({ ...noop, id: 'z.op' });
    registry.register({ ...noop, id: 'a.op' });
    expect(registry.list().map((operation) => operation.id)).toEqual(['a.op', 'z.op']);
  });
});

describe('ED-30: машинный каталог операций', () => {
  const catalog = describeOperations(registerBuiltinOperations(createOperationRegistry()));

  it('перечисляет все зарегистрированные операции и ничего сверх них', () => {
    expect(catalog.map((entry) => entry.id).sort()).toEqual(BUILTIN_OPERATIONS.map((op) => op.id).sort());
  });

  it('у каждого параметра есть тип из закрытого набора и ключ описания (ED-28)', () => {
    for (const entry of catalog) {
      expect(entry.descriptionKey).not.toBe('');
      for (const param of entry.params) {
        expect(OPERATION_PARAM_TYPES).toContain(param.type);
        expect(param.descriptionKey).not.toBe('');
      }
    }
  });

  it('параметр-дескриптор помечен сессионным, остальные — нет', () => {
    expect([...SESSION_SCOPED_TYPES]).toEqual(['descriptor']);
    expect(DESCRIPTOR_SCOPE).toBe('session');
    for (const entry of catalog) {
      for (const param of entry.params) {
        expect(param.sessionScoped).toBe(param.type === 'descriptor');
      }
    }
    const remove = catalog.find((entry) => entry.id === 'document.list.remove')!;
    expect(remove.params.find((param) => param.name === 'record')?.sessionScoped).toBe(true);
  });

  it('каталог сериализуем: внешний потребитель получает его как есть', () => {
    expect(JSON.parse(JSON.stringify(catalog)) as unknown).toEqual(catalog);
  });
});

describe('ED-29/ED-30: параметры проверяются по схеме, отказ структурный', () => {
  const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
  editor.openDocument({ id: 'content/x.json', kind: 'any', value: {}, lists: [['items']] });

  it('обязательный параметр не пропускается молча', () => {
    try {
      editor.applyOperation('document.setValue', { document: 'content/x.json', path: ['a'] });
      expect.unreachable('операция без обязательного параметра применилась');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).param).toBe('value');
      expect((error as OperationError).operationId).toBe('document.setValue');
    }
  });

  it('неизвестный параметр — отказ: опечатка внешнего вызова обязана быть видна', () => {
    expect(() =>
      editor.applyOperation('document.setValue', { document: 'content/x.json', path: ['a'], value: 1, extra: 2 }),
    ).toThrow(/неизвестный параметр "extra"/);
  });

  it('неизвестный параметр с именем из Object.prototype — тот же отказ, а не «не заметили»', () => {
    // `'toString' in схема` истинно через цепочку прототипов у любого объекта:
    // проверка обязана смотреть собственные ключи схемы, иначе опечатка с таким
    // именем прошла бы молча документом, в котором ничего не изменилось.
    expect(() =>
      editor.applyOperation('document.setValue', {
        document: 'content/x.json',
        path: ['a'],
        value: 1,
        toString: 2,
      }),
    ).toThrow(/неизвестный параметр "toString"/);
  });

  it('несовпадение типа называет полученное значение', () => {
    try {
      editor.applyOperation('document.setValue', { document: 'content/x.json', path: 'a', value: 1 });
      expect.unreachable('путь строкой прошёл проверку');
    } catch (error) {
      expect((error as OperationError).received).toBe('a');
    }
  });

  it('неизвестный дескриптор не применяется и не оставляет полуправки', () => {
    expect(() => editor.applyOperation('document.list.remove', { document: 'content/x.json', record: 'sd:999' })).toThrow(
      /не найдена/,
    );
    expect(editor.canUndo()).toBe(false);
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });
});

describe('ED-21: переименование ключа не двигает его с места', () => {
  const MANIFEST = 'content/visuals/manifest.json';
  const decoder = new TextDecoder();

  /** Документ в той же канонической форме, в какой он ложится на диск (ED-21). */
  const lines = (editor: EditorSession): readonly string[] =>
    decoder.decode(encodeDocument(editor.documentValue(MANIFEST))).split('\n');

  /** Строки, которых нет в другом наборе на том же месте, — то же, что покажет дифф. */
  const changedLines = (before: readonly string[], after: readonly string[]): readonly string[] => {
    const changed: string[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] !== after[i]) changed.push(after[i] ?? `<строка ${i} исчезла>`);
    }
    return changed;
  };

  function openManifest(): EditorSession {
    const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
    editor.openDocument({
      id: MANIFEST,
      kind: 'visuals',
      value: {
        entities: {
          scout: { model: 'models/scout.glb' },
          grunt: { model: 'models/grunt.glb' },
          tower: { model: 'models/tower.glb' },
        },
      },
    });
    return editor;
  }

  it('средний ключ из трёх остаётся средним', () => {
    const editor = openManifest();
    editor.applyOperation('document.renameKey', {
      document: MANIFEST,
      path: ['entities'],
      from: 'grunt',
      to: 'raider',
    });
    const entities = (editor.documentValue(MANIFEST) as { entities: Record<string, unknown> }).entities;
    expect(Object.keys(entities)).toEqual(['scout', 'raider', 'tower']);
    // Значение переезжает вместе с ключом: переименование — это имя, а не
    // содержимое записи.
    expect(entities.raider).toEqual({ model: 'models/grunt.glb' });
  });

  it('дифф канонической формы — ровно одна строка', () => {
    const editor = openManifest();
    const before = lines(editor);
    editor.applyOperation('document.renameKey', {
      document: MANIFEST,
      path: ['entities'],
      from: 'grunt',
      to: 'raider',
    });
    const changed = changedLines(before, lines(editor));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"raider"');
  });

  it('снять и записать заново — не то же самое: две операции дают дифф на два блока', () => {
    // Проверка непуста ровно этим: без своей операции переименование
    // выражалось бы этой парой, и позиция ключа терялась бы (ED-21).
    const editor = openManifest();
    const before = lines(editor);
    const value = (editor.documentValue(MANIFEST) as { entities: Record<string, unknown> }).entities.grunt!;
    editor.applyOperation('document.removeValue', { document: MANIFEST, path: ['entities', 'grunt'] });
    editor.applyOperation('document.setValue', {
      document: MANIFEST,
      path: ['entities', 'raider'],
      value: value as never,
    });
    const entities = (editor.documentValue(MANIFEST) as { entities: Record<string, unknown> }).entities;
    expect(Object.keys(entities)).toEqual(['scout', 'tower', 'raider']);
    expect(changedLines(before, lines(editor)).length).toBeGreaterThan(1);
  });

  it('отмена возвращает и имя ключа, и его место — байт в байт', () => {
    const editor = openManifest();
    const before = lines(editor);
    editor.applyOperation('document.renameKey', {
      document: MANIFEST,
      path: ['entities'],
      from: 'scout',
      to: 'ranger',
    });
    editor.undo();
    expect(lines(editor)).toEqual(before);
  });

  it('переименование корневого ключа адресуется пустым путём', () => {
    const editor = openManifest();
    editor.applyOperation('document.renameKey', { document: MANIFEST, path: [], from: 'entities', to: 'units' });
    expect(Object.keys(editor.documentValue(MANIFEST) as object)).toEqual(['units']);
  });
});

describe('ED-29/ED-30: переименование ключа отказывает структурно', () => {
  const DOC = 'content/visuals/refusals.json';

  function opened(): EditorSession {
    const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
    editor.openDocument({
      id: DOC,
      kind: 'visuals',
      value: { entities: { scout: { model: 'a.glb' }, grunt: { model: 'b.glb' } }, version: 1 },
      lists: [['models']],
    });
    return editor;
  }

  const refusal = (editor: EditorSession, params: OperationParams): OperationError => {
    try {
      editor.applyOperation('document.renameKey', params);
      return expect.unreachable('переименование прошло');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      return error as OperationError;
    }
  };

  it('ключа "from" нет — отказ называет параметр и полученное имя', () => {
    const editor = opened();
    const error = refusal(editor, { document: DOC, path: ['entities'], from: 'ghost', to: 'raider' });
    expect(error.param).toBe('from');
    expect(error.received).toBe('ghost');
    expect(error.message).toMatch(/ключа "ghost" здесь нет/);
    expect(editor.dirtyDocumentIds()).toEqual([]);
    expect(editor.canUndo()).toBe(false);
  });

  it('ключ "to" уже занят — отказ, а не молчаливая потеря записи', () => {
    const editor = opened();
    const error = refusal(editor, { document: DOC, path: ['entities'], from: 'scout', to: 'grunt' });
    expect(error.param).toBe('to');
    expect(error.received).toBe('grunt');
    expect(editor.documentValue(DOC)).toEqual({
      entities: { scout: { model: 'a.glb' }, grunt: { model: 'b.glb' } },
      version: 1,
    });
  });

  it('переименование в себя — тот же занятый ключ, а не пустая правка', () => {
    const editor = opened();
    const error = refusal(editor, { document: DOC, path: ['entities'], from: 'scout', to: 'scout' });
    expect(error.param).toBe('to');
    expect(editor.canUndo()).toBe(false);
  });

  it('по пути не объект — отказ называет путь', () => {
    const editor = opened();
    const error = refusal(editor, { document: DOC, path: ['version'], from: 'a', to: 'b' });
    expect(error.param).toBe('path');
    expect(error.received).toEqual(['version']);
    expect(error.message).toMatch(/объекта нет/);
  });

  it('отслеживаемый список закрыт тем же запретом, что и для записи по пути', () => {
    const editor = opened();
    // Список отслеживается, значит его записи адресуются дескриптором; корень
    // документа — предок списка, и переименование ключа в нём прошло бы мимо
    // таблицы дескрипторов (ED-29).
    const error = refusal(editor, { document: DOC, path: [], from: 'version', to: 'revision' });
    expect(error.message).toMatch(/адресуются дескриптором/);
  });
});

describe('ED-29: второго пути правки не существует', () => {
  it('сессия не выдаёт наружу ничего, чем можно записать в документ помимо операции', () => {
    const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
    editor.openDocument({ id: 'content/x.json', kind: 'any', value: { a: 1 } });
    // Список методов сессии — часть требования, а не деталь: любой новый
    // мутирующий метод здесь и был бы тем самым вторым путём.
    const writers = Object.keys(editor).filter((name) => /^(set|write|update|patch|replace|mutate)/.test(name));
    expect(writers).toEqual([]);
    expect(typeof editor.applyOperation).toBe('function');
    expect(typeof editor.beginOperation).toBe('function');
  });
});
