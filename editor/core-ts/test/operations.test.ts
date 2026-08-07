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
} from '../src/operations/index.js';
import { createEditorSession, DESCRIPTOR_SCOPE } from '../src/document/index.js';

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
    expect(() => registry.register({ ...noop })).toThrow(/уже зарегистрирована/);
  });

  it('операция и её параметр без ключа описания не регистрируются', () => {
    const registry = createOperationRegistry();
    expect(() => registry.register({ ...noop, id: 'a.op', descriptionKey: '' })).toThrow(
      /пустой ключ описания/,
    );
    expect(() =>
      registry.register({
        ...noop,
        id: 'b.op',
        params: { value: { type: 'json', descriptionKey: '  ' } },
      }),
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
