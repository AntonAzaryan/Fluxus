/**
 * Правило-вклад «слой разошёлся с источником» (BLND-2, задача 3.5): что оно
 * подсвечивает, о чём молчит и что отвечает среда, которая источник прочитать не
 * может (ED-12, ED-20).
 *
 * Дерево здесь в памяти (`createMemoryHost`) и обёрнуто счётчиком чтений: у
 * сцены без источника проверяется не только отсутствие находки, но и отсутствие
 * самой попытки чтения — иначе правило платило бы чтением за файл, которого нет.
 */
import { describe, expect, it } from 'vitest';
import {
  createEditorSession,
  createMemoryHost,
  createValidator,
  type ContentPath,
  type ContentTreeHost,
  type ContributionReader,
  type EditorSession,
  type JsonValue,
  type ValidationIssue,
  type ValidationRule,
} from '@game-mvp/editor-core';
import {
  DEFAULT_DECORATIONS_PATH,
  DEFAULT_INITIAL_PATH,
  SPATIAL_LAYER_SYNC_RULE,
  createSourceCache,
  generateSpatialLayer,
  spatialLayerSyncRule,
} from '../src/index.js';
import {
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  context,
  contentFiles,
  fixtureBytes,
  manifestDocument,
  objectsOf,
  presentationDocument,
  sceneDocument,
} from './support.js';

/** Источник парен сцене по имени (BLND-2): `duel.scene.json` → `duel.glb`. */
const SOURCE_ID = 'scenes/duel.glb';

interface Tree {
  readonly host: ContentTreeHost;
  readonly reads: ContentPath[];
}

/**
 * Дерево со счётчиком чтений. Отказ чтения (`refuse`) изображает среду без
 * бинарного чтения — ту самую, которая обязана назвать причину, а не отдать
 * пустой результат (ED-12, ED-20).
 */
function tree(files: Record<string, string | Uint8Array>, refuse = false): Tree {
  const memory = createMemoryHost({ files });
  const reads: ContentPath[] = [];
  return {
    reads,
    host: {
      ...memory.content,
      read(path) {
        reads.push(path);
        if (refuse) throw new Error('среда не умеет читать двоичные файлы дерева');
        return memory.content.read(path);
      },
    },
  };
}

function session(scene: Record<string, unknown>, presentation: Record<string, unknown>): EditorSession {
  const editor = createEditorSession();
  editor.openDocument({ id: SCENE_ID, kind: 'scene', value: scene as JsonValue, lists: [DEFAULT_INITIAL_PATH] });
  editor.openDocument({
    id: PRESENTATION_ID,
    kind: 'presentation',
    value: presentation as JsonValue,
    lists: [DEFAULT_DECORATIONS_PATH],
  });
  editor.openDocument({ id: MANIFEST_ID, kind: 'manifest', value: manifestDocument() as JsonValue });
  return editor;
}

function reader(rule: ValidationRule): ContributionReader<ValidationRule> {
  const all = Object.freeze([rule]);
  return { get: (id) => (id === rule.id ? rule : undefined), has: (id) => id === rule.id, all: () => all };
}

function issuesOf(editor: EditorSession, rule: ValidationRule): readonly ValidationIssue[] {
  return createValidator({ rules: reader(rule) }).run({
    documentIds: () => editor.documentIds(),
    document: (id) => editor.document(id),
  }).issues;
}

/** Дерево цели, где источник лежит под парным именем `.glb`. */
function withSource(
  fixture = 'placements.gltf',
  scene = sceneDocument(),
  presentation = presentationDocument(),
): Record<string, string | Uint8Array> {
  const files = contentFiles(fixture, scene, presentation);
  const source = files['scenes/duel.gltf']!;
  delete files['scenes/duel.gltf'];
  return { ...files, [SOURCE_ID]: source };
}

/** Слой, который дал бы импорт этой фикстуры, — то, с чем правило сверяет документы. */
function derived(fixture = 'placements.gltf'): ReturnType<typeof generateSpatialLayer> {
  return generateSpatialLayer(objectsOf(fixture), context());
}

describe('BLND-2: правка производного слоя сопряжённой сцены подсвечена', () => {
  it('запись расстановки, которой источник не даёт, — предупреждение с адресом записи', async () => {
    const layer = derived();
    const edited = [...layer.initial];
    // Автор подвинул объект инструментом редактора: запись законна, но следующий
    // импорт её перезапишет — ровно то, о чём правило обязано предупредить.
    edited[0] = { prefab: 'Hero', overrides: { Position: { x: 1, y: 2 } } };
    const { host } = tree(withSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument(edited), presentationDocument([...layer.decorations]));

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.ruleId).toBe(SPATIAL_LAYER_SYNC_RULE);
    // Предупреждение, а не ошибка: документ валиден, расхождение процессное.
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.documentId).toBe(SCENE_ID);
    expect(issues[0]!.path).toEqual(['initial', 0]);
    expect(issues[0]!.reasonKey).toBe('validation.reason.blender.spatialLayerSync.layerDiverged');
    expect(issues[0]!.expected).toEqual({ kind: 'oneOf', values: [layer.initial[0]] });
  });

  it('расхождение состава адресует список целиком: «записей стало другое число»', async () => {
    const layer = derived();
    const { host } = tree(withSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument(), presentationDocument([...layer.decorations]));

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['initial']);
    expect(issues[0]!.reasonParams).toMatchObject({ slot: 'initial', actual: 0, wanted: 2 });
  });

  it('расхождение decorations стоит на парном документе (PRES-1)', async () => {
    const layer = derived();
    const { host } = tree(withSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument([...layer.initial]), presentationDocument());

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.documentId).toBe(PRESENTATION_ID);
    expect(issues[0]!.path).toEqual(['decorations']);
  });

  it('слой, совпадающий с источником, находок не даёт', async () => {
    const layer = derived();
    const { host } = tree(withSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument([...layer.initial]), presentationDocument([...layer.decorations]));

    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toEqual([]);
  });
});

describe('BLND-2: сцена без источника живёт как прежде', () => {
  it('ни находки, ни попытки чтения', async () => {
    const { host, reads } = tree(contentFiles());
    const sources = createSourceCache(host);

    const state = await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument([{ prefab: 'Rock', overrides: {} }]), presentationDocument());

    expect(state.status).toBe('none');
    expect(reads).toEqual([]);
    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toEqual([]);
  });
});

describe('ED-12, ED-20: среда без бинарного чтения отвечает причиной, а не пустотой', () => {
  it('источник есть, прочитать нечем — предупреждение называет причину дословно', async () => {
    const { host } = tree(withSource(), true);
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument(), presentationDocument());

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.reasonKey).toBe('validation.reason.blender.spatialLayerSync.sourceUnreadable');
    expect(issues[0]!.reasonParams['reason']).toContain('двоичные');
    expect(issues[0]!.expected).toMatchObject({ kind: 'accepted' });
  });

  it('источник, который импорт отверг бы, назван отказом, а не «расхождения нет»', async () => {
    const { host } = tree(withSource('mixed.gltf'));
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument(), presentationDocument());

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.reasonKey).toBe('validation.reason.blender.spatialLayerSync.sourceRejected');
    expect(issues[0]!.reasonParams['reason']).toContain('gamma-ghost');
  });
});

describe('ED-8: кэш по байтам источника', () => {
  it('те же байты — то же разобранное состояние, новые байты — новое', async () => {
    const files = withSource();
    const { host } = tree(files);
    const sources = createSourceCache(host);

    const first = await sources.refresh(SCENE_ID);
    const again = await sources.refresh(SCENE_ID);
    expect(again).toBe(first);

    await host.write(SOURCE_ID, fixtureBytes('warnings.gltf'));
    const changed = await sources.refresh(SCENE_ID);
    expect(changed).not.toBe(first);
    expect(changed.status).toBe('ready');
  });
});
