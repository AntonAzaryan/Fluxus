/**
 * Проверка ED-29 по всему реестру: «применить операцию, отменить, сравнить
 * документ с исходным» проходит для каждой зарегистрированной операции.
 *
 * Тест табличный по реестру, а не по списку, написанному здесь: набор
 * операций растёт (расстановка — W3-3, кисти — W3-2), и перечисленный руками
 * список отстал бы от реестра на первой же новой операции. Отсутствие
 * заготовки у зарегистрированной операции — красный тест, а не пропуск: иначе
 * операцию можно было бы добавить и не проверить.
 *
 * Инструмент, пишущий в документ мимо слоя операций, в реестр не попадает —
 * значит, и в эту таблицу тоже. Это и есть способ его обнаружить.
 */
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession } from '../src/document/index.js';
import {
  createOperationRegistry,
  registerBuiltinOperations,
  runOperationRoundTrip,
  type OperationParams,
} from '../src/operations/index.js';

const SCENE = 'content/scenes/conformance.json';
const PREFAB = 'content/prefabs/hero.json';

/** Заготовка: открытые документы плюс параметры, с которыми операция вызывается. */
interface Fixture {
  readonly params: (editor: EditorSession) => OperationParams;
}

function prepared(): EditorSession {
  const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
  editor.openDocument({
    id: SCENE,
    kind: 'scene',
    value: {
      components: [{ name: 'Pos', fields: { x: 'i32', y: 'i32' } }],
      capacity: 16,
      initial: [
        { prefab: 'a', overrides: { Pos: { x: 1, y: 2 } } },
        { prefab: 'b' },
        { prefab: 'a', overrides: { Pos: { x: 3, y: 4 } } },
      ],
    },
    lists: [['initial']],
  });
  editor.openDocument({ id: PREFAB, kind: 'prefab', value: { hp: 10, tags: ['unit'] } });
  return editor;
}

const record = (editor: EditorSession, index: number): string => editor.descriptors(SCENE, ['initial'])[index]!;

const fixtures: Readonly<Record<string, Fixture>> = {
  'document.setValue': {
    params: () => ({ document: PREFAB, path: ['hp'], value: 25 }),
  },
  'document.removeValue': {
    params: () => ({ document: PREFAB, path: ['tags'] }),
  },
  'document.list.append': {
    params: () => ({ document: SCENE, list: ['initial'], item: { prefab: 'b', overrides: { Pos: { x: 9, y: 9 } } } }),
  },
  'document.list.remove': {
    params: (editor) => ({ document: SCENE, record: record(editor, 1) }),
  },
  'document.list.setValue': {
    params: (editor) => ({ document: SCENE, record: record(editor, 0), path: ['overrides', 'Pos', 'x'], value: 42 }),
  },
  'document.list.removeValue': {
    params: (editor) => ({ document: SCENE, record: record(editor, 2), path: ['overrides'] }),
  },
};

describe('ED-29: применить → отменить → сравнить с исходным', () => {
  const registry = registerBuiltinOperations(createOperationRegistry());

  it('у каждой зарегистрированной операции есть заготовка проверки', () => {
    const registered = registry.list().map((operation) => operation.id);
    const covered = Object.keys(fixtures);
    expect(registered.filter((id) => !covered.includes(id))).toEqual([]);
    expect(covered.filter((id) => !registered.includes(id))).toEqual([]);
  });

  for (const operation of registry.list()) {
    it(`${operation.id} обратима без следа`, () => {
      const editor = prepared();
      const result = runOperationRoundTrip(editor, operation.id, fixtures[operation.id]!.params(editor));
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      // Операция, которая ничего не изменила, обратима тривиально и о слое
      // ничего не говорит: заготовка обязана быть содержательной.
      expect(result.recorded).toBe(true);
    });
  }

  it('проверка не пуста: несостоявшаяся отмена даёт структурную находку', () => {
    // Правку, не дошедшую до истории, в этом слое не написать: писать в
    // документ нечем, кроме контекста операции. Поэтому непустоту проверки
    // показываем с другой стороны — сессией, чей undo ничего не возвращает.
    const editor = prepared();
    const deaf: EditorSession = { ...editor, undo: () => false };
    const result = runOperationRoundTrip(deaf, 'document.setValue', { document: PREFAB, path: ['hp'], value: 25 });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatchObject({ documentId: PREFAB, stage: 'undo', subject: 'value' });
  });
});
