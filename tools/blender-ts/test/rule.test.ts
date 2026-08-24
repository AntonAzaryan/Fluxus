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
  decodeDocument,
  type ContentPath,
  type ContentTreeHost,
  type ContributionReader,
  type EditorSession,
  type JsonValue,
  type ValidationIssue,
  type ValidationRule,
} from '@fluxus/editor-core';
import {
  DEFAULT_DECORATIONS_PATH,
  DEFAULT_INITIAL_PATH,
  SPATIAL_LAYER_SYNC_RULE,
  createSourceCache,
  generateSpatialLayer,
  spatialLayerSyncRule,
} from '../src/index.js';
import { runImport } from '../src/importer.js';
import {
  CURVATURE_GRID,
  CURVATURE_ID,
  CURVATURE_ROWS,
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  TERRAIN_ASSET,
  TERRAIN_FLAGS,
  TERRAIN_GRID,
  TERRAIN_LEVELS,
  context,
  contentFiles,
  curvatureDocument,
  fixtureBytes,
  gridGlb,
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
  fixture: string | Uint8Array = 'placements.gltf',
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

describe('BLND-2: правило сверяет ровно то представление, которое пишет импорт', () => {
  it('сразу после импорта и сохранения находок нет — сравнение идёт по записанным байтам', async () => {
    // Прежние проверки сверяют слой с теми же объектами в памяти, что построил
    // импортёр, и потому не увидели бы расхождения, вносимого КАНОНИЧЕСКИМ
    // сохранением (ED-21): порядок ключей записи, форма чисел. Здесь документы
    // приходят с «диска» — байтами, которые записал импорт.
    const memory = createMemoryHost({ files: withSource() });
    const host = memory.content;

    const imported = await runImport({ host, source: SOURCE_ID, manifest: MANIFEST_ID });
    expect(imported.ok).toBe(true);
    expect([...imported.written].sort()).toEqual([PRESENTATION_ID, SCENE_ID].sort());

    const read = async (id: string): Promise<JsonValue> => decodeDocument(await host.read(id));
    const editor = session(
      (await read(SCENE_ID)) as unknown as Record<string, unknown>,
      (await read(PRESENTATION_ID)) as unknown as Record<string, unknown>,
    );
    const sources = createSourceCache(host);
    // Молчание правила обязано означать «сверено и сошлось», а не «сверять было
    // нечем»: источник прочитан, слой непустой.
    expect((await sources.refresh(SCENE_ID)).status).toBe('ready');
    expect(imported.layer.initial.length + imported.layer.decorations.length).toBeGreaterThan(0);

    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toEqual([]);
  });
});

/** Дерево цели вовсе без источника: ни `.glb`, ни `.gltf` рядом со сценой. */
function withoutSource(): Record<string, string | Uint8Array> {
  const files = contentFiles();
  delete files['scenes/duel.gltf'];
  return files;
}

describe('BLND-2: сцена без источника живёт как прежде', () => {
  it('ни находки, ни попытки чтения', async () => {
    const { host, reads } = tree(withoutSource());
    const sources = createSourceCache(host);

    const state = await sources.refresh(SCENE_ID);
    const editor = session(sceneDocument([{ prefab: 'Rock', overrides: {} }]), presentationDocument());

    expect(state.status).toBe('none');
    expect(reads).toEqual([]);
    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toEqual([]);
  });
});

describe('BLND-3: источник парен сцене форматом, а не контейнером', () => {
  it('текстовый экспорт рядом со сценой сверяется так же, как контейнер', async () => {
    // Импорт принимает обе формы (`SOURCE_EXTENSIONS`), и правило обязано
    // принимать те же: знай оно только про `.glb`, сцена с текстовым экспортом
    // молча считалась бы несопряжённой.
    const { host } = tree(contentFiles());
    const sources = createSourceCache(host);
    const state = await sources.refresh(SCENE_ID);

    expect(state.status).toBe('ready');
    expect(state.status === 'ready' ? state.path : '').toBe('scenes/duel.gltf');
    const editor = session(sceneDocument(), presentationDocument());
    expect(issuesOf(editor, spatialLayerSyncRule({ sources })).length).toBeGreaterThan(0);
  });
});

describe('BLND-2: «не читан» и «источника нет» — разные ответы', () => {
  it('кэш, которого никто не обновил, отвечает «не читан», а не молчанием', () => {
    const { host, reads } = tree(withoutSource());
    const sources = createSourceCache(host);
    const editor = session(sceneDocument(), presentationDocument());

    // Ни одного `refresh`: ровно то состояние, в котором находится собранный
    // редактор, забывший обновить источники до прогона валидации.
    expect(sources.stateOf(SCENE_ID).status).toBe('unknown');
    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.reasonKey).toBe('validation.reason.blender.spatialLayerSync.sourceUnread');
    expect(issues[0]!.severity).toBe('warning');
    // Читать правило при этом не пробовало: чтение — дело кэша (ED-8, ED-12).
    expect(reads).toEqual([]);
  });

  it('после обновления кэша ответ становится определённым', async () => {
    const { host } = tree(withoutSource());
    const sources = createSourceCache(host);
    const editor = session(sceneDocument(), presentationDocument());
    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toHaveLength(1);

    await sources.refresh(SCENE_ID);

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
    expect(issues[0]!.reasonParams.reason).toContain('двоичные');
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
    expect(issues[0]!.reasonParams.reason).toContain('gamma-ghost');
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

describe('BLND-2: производные данные — это и карты ассетов (BLND-9, BLND-10)', () => {
  /**
   * Сцена, сопряжённая с источником, у которого есть оба grid-объекта, и
   * документ карты кривизны рядом. Карты в документах — «до импорта»: ровно тот
   * случай, ради которого правило и заводилось (забытый пере-импорт).
   */
  function terrainSession(
    scene: Record<string, unknown>,
    curvature: Record<string, unknown> | null = curvatureDocument(),
  ): EditorSession {
    const editor = session(scene, presentationDocument());
    if (curvature !== null) {
      editor.openDocument({ id: CURVATURE_ID, kind: 'curvature', value: curvature as JsonValue });
    }
    return editor;
  }

  const gridSource = (): Record<string, string | Uint8Array> =>
    withSource(gridGlb([TERRAIN_GRID, CURVATURE_GRID]), sceneDocument([], TERRAIN_ASSET));

  it('карта уровней, разошедшаяся с источником, подсвечена рядом, а не файлом целиком', async () => {
    const { host } = tree(gridSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    // Автор поднял ряд кистью ED-10: правка законна, но её перезапишет импорт.
    const stale = { ...TERRAIN_ASSET, levels: ['0000', '0000', '1111', '1110'], flags: [...TERRAIN_FLAGS] };
    const editor = terrainSession(sceneDocument([], stale), curvatureDocument(CURVATURE_ROWS));

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.documentId).toBe(SCENE_ID);
    expect(issues[0]!.path).toEqual(['terrain', 'levels', 3]);
    expect(issues[0]!.reasonParams).toMatchObject({ slot: 'terrain.levels' });
  });

  it('карта вида клеток сверяется той же сверкой', async () => {
    const { host } = tree(gridSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const stale = { ...TERRAIN_ASSET, levels: [...TERRAIN_LEVELS], flags: ['....', '....', '....', '....'] };
    const editor = terrainSession(sceneDocument([], stale), curvatureDocument(CURVATURE_ROWS));

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues.map((issue) => issue.reasonParams.slot)).toEqual(['terrain.flags', 'terrain.flags']);
    expect(issues[0]!.path).toEqual(['terrain', 'flags', 0]);
  });

  it('карта кривизны разошлась — находка стоит на её документе (ASSET-7)', async () => {
    const { host } = tree(gridSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const scene = sceneDocument([], {
      ...TERRAIN_ASSET,
      levels: [...TERRAIN_LEVELS],
      flags: [...TERRAIN_FLAGS],
    });
    const editor = terrainSession(scene, curvatureDocument());

    const issues = issuesOf(editor, spatialLayerSyncRule({ sources }));

    expect(issues.every((issue) => issue.documentId === CURVATURE_ID)).toBe(true);
    expect(issues.map((issue) => issue.path)).toEqual([
      ['rows', 0],
      ['rows', 1],
      ['rows', 2],
      ['rows', 3],
    ]);
    expect(issues[0]!.reasonParams).toMatchObject({ slot: 'curvature.rows' });
  });

  it('документы, совпадающие с источником целиком, находок не дают', async () => {
    const { host } = tree(gridSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const scene = sceneDocument([], {
      ...TERRAIN_ASSET,
      levels: [...TERRAIN_LEVELS],
      flags: [...TERRAIN_FLAGS],
    });

    const issues = issuesOf(
      terrainSession(scene, curvatureDocument(CURVATURE_ROWS)),
      spatialLayerSyncRule({ sources }),
    );

    expect(issues).toEqual([]);
  });

  it('источник без grid-объектов ассеты не сверяет: они не производные (BLND-2)', async () => {
    const { host } = tree(withSource('placements.gltf', sceneDocument([], TERRAIN_ASSET)));
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    // Ассет террейна намеренно не тот, что дал бы grid-объект: раз объекта в
    // источнике нет, ассет остаётся за редактором и руками — и молчание правила
    // об этом обязано быть полным.
    const layer = derived();
    const editor = session(
      sceneDocument([...layer.initial], { ...TERRAIN_ASSET, levels: ['1111', '1111', '1111', '1111'] }),
      presentationDocument([...layer.decorations]),
    );
    editor.openDocument({ id: CURVATURE_ID, kind: 'curvature', value: curvatureDocument() as JsonValue });

    expect(issuesOf(editor, spatialLayerSyncRule({ sources }))).toEqual([]);
  });

  it('документ карты не открыт — правило о нём молчит, как и о парном', async () => {
    const { host } = tree(gridSource());
    const sources = createSourceCache(host);
    await sources.refresh(SCENE_ID);
    const scene = sceneDocument([], {
      ...TERRAIN_ASSET,
      levels: [...TERRAIN_LEVELS],
      flags: [...TERRAIN_FLAGS],
    });

    const issues = issuesOf(terrainSession(scene, null), spatialLayerSyncRule({ sources }));

    expect(issues).toEqual([]);
  });
});
