/**
 * Операция импорта как вклад слоя авторинга (BLND-5): что она пишет, чего не
 * трогает (BLND-2), как отказывает (BLND-6) и чем она обратима (ED-18, ED-29).
 *
 * Дерева здесь нет вовсе: операция правит документы сессии, а на диск они
 * уходят сохранением — атомарность записи проверяется там, где есть диск
 * (`importer.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  OperationError,
  StringResources,
  createEditorSession,
  createOperationRegistry,
  describeOperations,
  encodeDocument,
  registerBuiltinOperations,
  runOperationRoundTrip,
  type EditorSession,
  type JsonValue,
} from '@game-mvp/editor-core';
import {
  BLENDER_BUNDLES,
  DEFAULT_DECORATIONS_PATH,
  DEFAULT_INITIAL_PATH,
  IMPORT_SPATIAL_LAYER,
  generateSpatialLayer,
  importParams,
  importSpatialLayerOperation,
  registerBlenderOperations,
  spatialLayerParam,
  type SpatialLayer,
} from '../src/index.js';
import {
  PRESENTATION_ID,
  SCENE_ID,
  context,
  objectsOf,
  presentationDocument,
  sceneDocument,
} from './support.js';

function session(scene: Record<string, unknown>, presentation: Record<string, unknown>): EditorSession {
  const operations = registerBlenderOperations(registerBuiltinOperations(createOperationRegistry()));
  const editor = createEditorSession({ operations });
  editor.openDocument({
    id: SCENE_ID,
    kind: 'scene',
    value: scene as JsonValue,
    lists: [DEFAULT_INITIAL_PATH],
  });
  editor.openDocument({
    id: PRESENTATION_ID,
    kind: 'presentation',
    value: presentation as JsonValue,
    lists: [DEFAULT_DECORATIONS_PATH],
  });
  return editor;
}

function layerOf(fixture = 'placements.gltf'): SpatialLayer {
  return generateSpatialLayer(objectsOf(fixture), context());
}

function paramsOf(layer: SpatialLayer): ReturnType<typeof importParams> {
  return importParams({ scene: SCENE_ID, presentation: PRESENTATION_ID, layer });
}

const text = (value: JsonValue): string => new TextDecoder().decode(encodeDocument(value));

describe('BLND-2: импорт переписывает производные данные и только их', () => {
  it('записи расстановки и decorations приходят из источника', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = layerOf();
    editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layer));

    expect((editor.documentValue(SCENE_ID) as { initial: unknown }).initial).toEqual(layer.initial);
    expect((editor.documentValue(PRESENTATION_ID) as { decorations: unknown }).decorations).toEqual(
      layer.decorations,
    );
  });

  it('прочие поля конфига сцены — байт-в-байт прежние, включая порядок ключей', () => {
    const editor = session(sceneDocument([{ prefab: 'Rock', overrides: {} }]), presentationDocument());
    const before = editor.documentValue(SCENE_ID) as Record<string, JsonValue>;
    const untouched = (value: JsonValue): string =>
      text(
        Object.fromEntries(
          Object.entries(value as Record<string, JsonValue>).filter(([key]) => key !== 'initial'),
        ),
      );
    const wanted = untouched(before);

    editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layerOf()));

    const after = editor.documentValue(SCENE_ID) as Record<string, JsonValue>;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(untouched(after)).toBe(wanted);
  });

  it('источник, совпадающий с документами, не даёт ни одной правки — дифф пуст по построению (BLND-4)', () => {
    const editor = session(sceneDocument(), presentationDocument());
    editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layerOf()));
    // Первый импорт документы изменил и на диск их отправил бы; второй —
    // повторный импорт неизменного источника, и вот он не меняет ничего.
    for (const id of editor.dirtyDocumentIds()) editor.markSaved(id);
    const scene = editor.documentValue(SCENE_ID);
    const presentation = editor.documentValue(PRESENTATION_ID);

    const again = editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layerOf()));

    expect(again.recorded).toBe(false);
    // Та же ссылка, а не только те же байты: правки не было вовсе, и документ
    // не стал изменённым — сохранение его не коснётся (ED-21).
    expect(editor.documentValue(SCENE_ID)).toBe(scene);
    expect(editor.documentValue(PRESENTATION_ID)).toBe(presentation);
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });

  it('лишние записи снимаются, недостающие дописываются', () => {
    const stale = [
      { prefab: 'Rock', overrides: {} },
      { prefab: 'Rock', overrides: {} },
      { prefab: 'Rock', overrides: {} },
    ];
    const editor = session(sceneDocument(stale), presentationDocument([{ visual: 'Statue', x: 0, y: 0 }]));
    const layer = layerOf();

    const outcome = editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layer));

    expect((editor.documentValue(SCENE_ID) as { initial: unknown[] }).initial).toEqual(layer.initial);
    expect(outcome.result).toEqual({
      initial: { set: 2, appended: 0, removed: 1 },
      decorations: { set: 1, appended: 0, removed: 0 },
    });
  });
});

describe('BLND-6: находки важности «ошибка» отвергают импорт целиком', () => {
  it('отказ называет объект Blender, и ни один документ не тронут', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = generateSpatialLayer(objectsOf('errors.gltf'), context());
    expect(layer.findings.some((finding) => finding.severity === 'error')).toBe(true);

    expect(() => editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layer))).toThrow(OperationError);
    expect(editor.dirtyDocumentIds()).toEqual([]);
    expect(editor.history().undo).toEqual([]);
  });

  it('предупреждения записи не мешают', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = generateSpatialLayer(objectsOf('warnings.gltf'), context());
    expect(layer.findings.every((finding) => finding.severity === 'warning')).toBe(true);

    expect(() => editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layer))).not.toThrow();
  });

  it('слой с decorations без парного документа — отказ, а не молчаливая потеря', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = layerOf();
    expect(layer.decorations.length).toBeGreaterThan(0);

    expect(() =>
      editor.applyOperation(IMPORT_SPATIAL_LAYER, importParams({ scene: SCENE_ID, layer })),
    ).toThrow(/presentation/);
  });

  it('слот, которого операция не пишет, — отказ, а не пропуск (заготовка BLND-9, BLND-10)', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = spatialLayerParam(layerOf()) as Record<string, JsonValue>;

    expect(() =>
      editor.applyOperation(IMPORT_SPATIAL_LAYER, {
        scene: SCENE_ID,
        presentation: PRESENTATION_ID,
        layer: { ...layer, terrain: { width: 4, height: 4 } },
      }),
    ).toThrow(/terrain/);
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });
});

describe('ED-18, ED-29: операция обратима и видна в каталоге', () => {
  it('применить, отменить, повторить — документ возвращается побайтово', () => {
    const editor = session(sceneDocument([{ prefab: 'Rock', overrides: {} }]), presentationDocument());

    const result = runOperationRoundTrip(editor, IMPORT_SPATIAL_LAYER, paramsOf(layerOf()));

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(true);
  });

  it('операция в машинном каталоге одна, и у неё описаны все параметры (ED-30, ED-28)', () => {
    const operations = registerBlenderOperations(registerBuiltinOperations(createOperationRegistry()));
    const described = describeOperations(operations).filter((entry) => entry.id === IMPORT_SPATIAL_LAYER);

    expect(described).toHaveLength(1);
    expect(described[0]!.params.map((param) => param.name)).toEqual([
      'decorationsPath',
      'initialPath',
      'layer',
      'presentation',
      'scene',
    ]);
    for (const locale of ['ru', 'en']) {
      const resources = new StringResources({ locale, editor: BLENDER_BUNDLES });
      expect(resources.text(importSpatialLayerOperation.descriptionKey)).not.toBe(
        importSpatialLayerOperation.descriptionKey,
      );
      for (const param of described[0]!.params) {
        expect(resources.text(param.descriptionKey), `${locale}/${param.name}`).not.toBe(param.descriptionKey);
      }
    }
  });
});
