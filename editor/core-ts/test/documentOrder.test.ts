/**
 * Порядок записей начальной расстановки (SER-8, ED-16, ED-21).
 *
 * Порядок нормативен: он задаёт выданные `index`/`generation` (ID-2, DET-6), а
 * через плоскую форму мира — хеш `worldInit` (DET-1). Поэтому проверяется не
 * «список выглядит правильно», а то, ради чего правило существует: хеш
 * `worldInit`, посчитанный ядром по документу редактора. Своего представления о
 * каноническом виде документа редактор не заводит (ED-1) — считает ядро.
 */
import { loadScene, worldInitHash, type SceneDef } from '@fluxus/core';
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession } from '../src/document/index.js';
import {
  BUILTIN_OPERATIONS,
  createOperationRegistry,
  registerBuiltinOperations,
  type OperationParams,
} from '../src/operations/index.js';

const SCENE = 'content/scenes/order.json';

const BASE = {
  components: [{ name: 'Pos', fields: { x: 'i32', y: 'i32' } }],
  // Умолчания разные нарочно: у одинаковых prefab'ов перестановка записей не
  // меняла бы мир, и сверка хеша ниже ничего не проверяла бы.
  prefabs: [
    { name: 'a', components: { Pos: { x: 1, y: 1 } } },
    { name: 'b', components: { Pos: { x: 2, y: 2 } } },
    { name: 'c', components: { Pos: { x: 3, y: 3 } } },
  ],
  capacity: 16,
};

function openOrdered(initial: readonly { prefab: string; overrides?: unknown }[]): EditorSession {
  const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
  editor.openDocument({
    id: SCENE,
    kind: 'scene',
    value: { ...BASE, initial } as never,
    lists: [['initial']],
  });
  return editor;
}

function prefabOrder(editor: EditorSession): readonly string[] {
  const scene = editor.documentValue(SCENE) as unknown as SceneDef;
  return (scene.initial ?? []).map((entry) => entry.prefab);
}

/** Хеш `worldInit` документа — считает ядро, редактор только отдаёт ему документ. */
function hashOf(value: unknown): string {
  const scene = loadScene(value as SceneDef);
  return worldInitHash({ world: scene.world, mode: 'Running' });
}

describe('SER-8: новая запись дописывается в конец', () => {
  it('дописанное оказывается последним, а не отсортированным по имени префаба', () => {
    const editor = openOrdered([{ prefab: 'c' }, { prefab: 'a' }]);
    editor.applyOperation('document.list.append', { document: SCENE, list: ['initial'], item: { prefab: 'b' } });
    expect(prefabOrder(editor)).toEqual(['c', 'a', 'b']);
  });

  it('дописывание возвращает дескриптор новой записи', () => {
    const editor = openOrdered([{ prefab: 'a' }]);
    const outcome = editor.applyOperation('document.list.append', {
      document: SCENE,
      list: ['initial'],
      item: { prefab: 'b' },
    });
    expect(editor.resolveDescriptor(SCENE, outcome.result as string)?.index).toBe(1);
  });
});

describe('ED-16: перестановка записей не бывает побочным эффектом', () => {
  /**
   * Таблица по всем зарегистрированным операциям: каждая либо не трогает
   * список, либо дописывает в конец, либо удаляет одну запись. Перестановки нет
   * ни у одной — и операции перестановки в наборе нет вовсе, поэтому перечень
   * ниже полон по построению.
   */
  const cases: Record<string, { readonly params: (records: readonly string[]) => OperationParams; readonly order: readonly string[] }> = {
    'document.setValue': {
      params: () => ({ document: SCENE, path: ['capacity'], value: 32 }),
      order: ['a', 'b', 'c'],
    },
    'document.removeValue': {
      params: () => ({ document: SCENE, path: ['capacity'] }),
      order: ['a', 'b', 'c'],
    },
    'document.renameKey': {
      // Переименование ключа не трогает списков вовсе: путь ведёт в объект вне
      // отслеживаемого списка, а ключ остаётся на своём месте (ED-21).
      params: () => ({ document: SCENE, path: ['prefabs', 0], from: 'components', to: 'parts' }),
      order: ['a', 'b', 'c'],
    },
    'document.list.append': {
      params: () => ({ document: SCENE, list: ['initial'], item: { prefab: 'a' } }),
      order: ['a', 'b', 'c', 'a'],
    },
    'document.list.remove': {
      params: (records) => ({ document: SCENE, record: records[1]! }),
      order: ['a', 'c'],
    },
    'document.list.setValue': {
      params: (records) => ({
        document: SCENE,
        record: records[0]!,
        path: ['overrides', 'Pos', 'x'],
        value: 5,
      }),
      order: ['a', 'b', 'c'],
    },
    'document.list.removeValue': {
      params: (records) => ({ document: SCENE, record: records[0]!, path: ['overrides'] }),
      order: ['a', 'b', 'c'],
    },
  };

  it('перечень покрывает все зарегистрированные операции', () => {
    expect(BUILTIN_OPERATIONS.map((operation) => operation.id).sort()).toEqual(Object.keys(cases).sort());
  });

  for (const operation of BUILTIN_OPERATIONS) {
    it(`${operation.id} не переставляет записи`, () => {
      const editor = openOrdered([
        { prefab: 'a', overrides: { Pos: { x: 1 } } },
        { prefab: 'b' },
        { prefab: 'c' },
      ]);
      const records = [...editor.descriptors(SCENE, ['initial'])];
      const spec = cases[operation.id]!;
      editor.applyOperation(operation.id, spec.params(records));
      expect(prefabOrder(editor)).toEqual(spec.order);
    });
  }
});

describe('ED-21: правка одного значения не двигает выданные ID', () => {
  const initial = [
    { prefab: 'a', overrides: { Pos: { x: 0, y: 0 } } },
    { prefab: 'b' },
    { prefab: 'a' },
  ];

  it('хеш worldInit чувствителен к порядку — иначе сверка ниже ничего не значит', () => {
    const straight = hashOf({ ...BASE, initial });
    const swapped = hashOf({ ...BASE, initial: [initial[1], initial[0], initial[2]] });
    expect(swapped).not.toBe(straight);
  });

  it('правка переопределения первой записи даёт ровно тот документ, что написан руками', () => {
    const editor = openOrdered(initial);
    const records = [...editor.descriptors(SCENE, ['initial'])];
    editor.applyOperation('document.list.setValue', {
      document: SCENE,
      record: records[0]!,
      path: ['overrides', 'Pos', 'x'],
      value: 7,
    });
    const byHand = {
      ...BASE,
      initial: [{ prefab: 'a', overrides: { Pos: { x: 7, y: 0 } } }, { prefab: 'b' }, { prefab: 'a' }],
    };
    expect(hashOf(editor.documentValue(SCENE))).toBe(hashOf(byHand));
  });

  it('правка и её отмена возвращают исходный хеш worldInit', () => {
    const editor = openOrdered(initial);
    const before = hashOf(editor.documentValue(SCENE));
    const records = [...editor.descriptors(SCENE, ['initial'])];
    editor.applyOperation('document.list.setValue', {
      document: SCENE,
      record: records[0]!,
      path: ['overrides', 'Pos', 'x'],
      value: 7,
    });
    expect(hashOf(editor.documentValue(SCENE))).not.toBe(before);
    editor.undo();
    expect(hashOf(editor.documentValue(SCENE))).toBe(before);
  });

  it('удаление записи сдвигает ID следующих и не трогает порядок остальных', () => {
    const editor = openOrdered(initial);
    const records = [...editor.descriptors(SCENE, ['initial'])];
    editor.applyOperation('document.list.remove', { document: SCENE, record: records[1]! });
    expect(prefabOrder(editor)).toEqual(['a', 'a']);
    expect(hashOf(editor.documentValue(SCENE))).toBe(hashOf({ ...BASE, initial: [initial[0], initial[2]] }));
  });
});
