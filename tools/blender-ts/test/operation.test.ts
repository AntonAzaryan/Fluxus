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
} from '@fluxus/editor-core';
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
  CURVATURE_ID,
  CURVATURE_ROWS,
  PRESENTATION_ID,
  SCENE_ID,
  TERRAIN_ASSET,
  TERRAIN_FLAGS,
  TERRAIN_LEVELS,
  context,
  curvatureDocument,
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

  it('слот, которого операция не пишет, — отказ, а не пропуск', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = spatialLayerParam(layerOf()) as Record<string, JsonValue>;

    expect(() =>
      editor.applyOperation(IMPORT_SPATIAL_LAYER, {
        scene: SCENE_ID,
        presentation: PRESENTATION_ID,
        layer: { ...layer, lighting: { probes: [] } },
      }),
    ).toThrow(/lighting/);
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });

  it('слот карты кривизны без названного документа — отказ, а не молчаливая потеря', () => {
    const editor = session(sceneDocument(), presentationDocument());
    const layer = spatialLayerParam(layerOf()) as Record<string, JsonValue>;

    expect(() =>
      editor.applyOperation(IMPORT_SPATIAL_LAYER, {
        scene: SCENE_ID,
        presentation: PRESENTATION_ID,
        layer: { ...layer, curvature: { width: 4, height: 4, rows: [[0, 0, 0, 0, 0]] } },
      }),
    ).toThrow(/кривизн/);
    expect(editor.dirtyDocumentIds()).toEqual([]);
  });
});

describe('BLND-9, BLND-10: карты ассетов пишет та же операция', () => {
  /** Слой с клеточными слотами: сами карты считает `maps.ts`, здесь важна запись. */
  function withMaps(layer: SpatialLayer): SpatialLayer {
    return {
      ...layer,
      terrain: { levels: TERRAIN_LEVELS, flags: TERRAIN_FLAGS },
      curvature: { width: 4, height: 4, rows: CURVATURE_ROWS },
    };
  }

  function mapSession(scene: Record<string, unknown>, curvature: Record<string, unknown> | null): EditorSession {
    const editor = session(scene, presentationDocument());
    if (curvature !== null) {
      editor.openDocument({ id: CURVATURE_ID, kind: 'curvature', value: curvature as JsonValue });
    }
    return editor;
  }

  const paramsWithMaps = (layer: SpatialLayer): ReturnType<typeof importParams> =>
    importParams({
      scene: SCENE_ID,
      presentation: PRESENTATION_ID,
      curvature: CURVATURE_ID,
      layer: withMaps(layer),
    });

  it('карты уровней и вида клеток приходят в ассет, размеры сетки — нет (BLND-9)', () => {
    const editor = mapSession(sceneDocument([], TERRAIN_ASSET), curvatureDocument());

    editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsWithMaps(layerOf()));

    const terrain = (editor.documentValue(SCENE_ID) as { terrain: Record<string, unknown> }).terrain;
    expect(terrain.levels).toEqual([...TERRAIN_LEVELS]);
    expect(terrain.flags).toEqual([...TERRAIN_FLAGS]);
    expect(terrain.width).toBe(4);
    expect(terrain.tileSize).toBe(65536);
    // Порядок ключей ассета прежний: импорт правит ряды карт, а не пересобирает
    // документ (ED-21).
    expect(Object.keys(terrain)).toEqual(Object.keys(TERRAIN_ASSET));
  });

  it('карта кривизны переписывается в своём документе (ASSET-7)', () => {
    const editor = mapSession(sceneDocument([], TERRAIN_ASSET), curvatureDocument());

    editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsWithMaps(layerOf()));

    expect(editor.documentValue(CURVATURE_ID)).toEqual({ width: 4, height: 4, rows: [...CURVATURE_ROWS] });
  });

  it('совпадающие карты правки не дают: дифф пуст по построению (BLND-4)', () => {
    const editor = mapSession(
      sceneDocument([], { ...TERRAIN_ASSET, levels: [...TERRAIN_LEVELS], flags: [...TERRAIN_FLAGS] }),
      curvatureDocument(CURVATURE_ROWS),
    );

    const outcome = editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsWithMaps(layerOf()));

    expect(outcome.result).toMatchObject({
      terrain: { levels: { set: 0 }, flags: { set: 0 } },
      curvature: { size: 0, rows: { set: 0 } },
    });
    expect(editor.dirtyDocumentIds()).toEqual([SCENE_ID, PRESENTATION_ID]);
  });

  it('правка одного ряда карты трогает один ряд, а не весь ассет (ED-21)', () => {
    const stale = ['0000', '0000', '1111', '1110'];
    const editor = mapSession(
      sceneDocument([], { ...TERRAIN_ASSET, levels: stale, flags: [...TERRAIN_FLAGS] }),
      curvatureDocument(CURVATURE_ROWS),
    );

    const outcome = editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsWithMaps(layerOf()));

    expect(outcome.result).toMatchObject({ terrain: { levels: { set: 1 }, flags: { set: 0 } } });
  });

  it('слоя нет — ассет не тронут ни байтом и в отчёте не назван (BLND-2)', () => {
    const editor = mapSession(sceneDocument([], TERRAIN_ASSET), curvatureDocument());
    const before = text(editor.documentValue(SCENE_ID));

    const outcome = editor.applyOperation(IMPORT_SPATIAL_LAYER, paramsOf(layerOf()));

    expect(outcome.result).not.toHaveProperty('terrain');
    expect(outcome.result).not.toHaveProperty('curvature');
    const after = editor.documentValue(SCENE_ID) as Record<string, JsonValue>;
    expect(text({ ...after, initial: [] })).toBe(text({ ...(JSON.parse(before) as object), initial: [] }));
    expect(editor.documentValue(CURVATURE_ID)).toEqual(curvatureDocument());
  });

  it('импорт кривизны не меняет ни байта sim-документов (BLND-10, ED-11)', () => {
    const editor = mapSession(sceneDocument([], TERRAIN_ASSET), curvatureDocument());
    const before = text(editor.documentValue(SCENE_ID));

    editor.applyOperation(
      IMPORT_SPATIAL_LAYER,
      importParams({
        scene: SCENE_ID,
        presentation: PRESENTATION_ID,
        curvature: CURVATURE_ID,
        // Слой без размещений и без террейна: в источнике один curvature-объект.
        layer: { initial: [], decorations: [], curvature: { width: 4, height: 4, rows: CURVATURE_ROWS }, findings: [] },
      }),
    );

    expect(text(editor.documentValue(SCENE_ID))).toBe(before);
    expect(editor.dirtyDocumentIds()).toEqual([CURVATURE_ID]);
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
      'curvature',
      'decorationsPath',
      'initialPath',
      'layer',
      'presentation',
      'scene',
      'terrainPath',
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
