/**
 * Импорт от дерева контента до байтов на диске: атомарность (BLND-6),
 * равенство путей «командная строка» и «операция редактора» (BLND-5) и
 * детерминизм повторного импорта (BLND-4).
 *
 * Дерево здесь настоящее — временный каталог файловой системы, — потому что
 * проверяется именно то, чего нет в памяти: записан ли байт. Blender при этом не
 * зовётся ни в какой форме (BLND-7): источники — закоммиченные фикстуры.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryHost,
  encodeDocument,
  saveDocuments,
  type ContentTreeHost,
  type EditorSession,
} from '@game-mvp/editor-core';
import {
  IMPORT_SPATIAL_LAYER,
  generateCellLayer,
  generateSpatialLayer,
  importParams,
  openImportTarget,
  withCellLayer,
} from '../src/index.js';
import { createImportSession, runImport } from '../src/importer.js';
import { normalizeDocument } from '../src/normalize.js';
import { parseGltf } from '../src/gltf.js';
import { createNodeHost } from '../src/nodeHost.js';
import { cliValidationRules, main } from '../src/cli.js';
import {
  CURVATURE_GRID,
  CURVATURE_ID,
  CURVATURE_ROWS,
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  SOURCE_ID,
  TERRAIN_ASSET,
  TERRAIN_FLAGS,
  TERRAIN_GRID,
  TERRAIN_LEVELS,
  contentFiles,
  curvatureDocument,
  fixtureBytes,
  flagCells,
  gridGltf,
  gridSource,
  levelHeights,
  packGlb,
  presentationDocument,
  sceneDocument,
} from './support.js';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Временный «репозиторий»: дерево контента лежит в `content/`, как и в настоящем. */
async function tree(files: Record<string, string | Uint8Array> = contentFiles()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'blender-import-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, 'content', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const contentOf = (root: string, path: string): Promise<Buffer> => readFile(join(root, 'content', path));

function io(): { out: string[]; err: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}

async function runCli(root: string, args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const sink = io();
  const code = await main(args, root, sink.io);
  return { code, out: sink.out, err: sink.err };
}

/**
 * Путь редактора: та же зарегистрированная операция над сессией и то же
 * каноническое сохранение — только собранные вызывающим, а не командной строкой
 * (BLND-5). Это ВТОРОЙ вызывающий, а не второй импорт: своей сериализации и
 * своих правил порядка у него нет.
 */
async function importAsEditor(root: string): Promise<EditorSession> {
  const host = createNodeHost({ root: join(root, 'content') });
  const session = createImportSession();
  const document = parseGltf(new Uint8Array(await host.content.read(SOURCE_ID)));
  const objects = normalizeDocument(document);
  const has = (kind: string): boolean =>
    objects.some((object) => object.semantics.length === 1 && object.semantics[0] === kind);
  const target = await openImportTarget(session, host.content, {
    scene: SCENE_ID,
    manifest: MANIFEST_ID,
    slots: { terrain: has('terrain'), curvature: has('curvature') },
  });
  const layer = withCellLayer(
    generateSpatialLayer(objects, target.context),
    generateCellLayer(document, objects, target.context),
  );
  session.applyOperation(
    IMPORT_SPATIAL_LAYER,
    importParams({
      scene: target.sceneId,
      presentation: target.presentationId,
      curvature: target.curvatureId,
      layer,
      initialPath: target.initialPath,
      decorationsPath: target.decorationsPath,
      terrainPath: target.terrainPath,
    }),
  );
  await saveDocuments({ session, host: host.content, groups: [target.group], rules: cliValidationRules() });
  return session;
}

describe('BLND-5: командная строка и операция дают байт-в-байт одно', () => {
  it('оба пути пишут одни и те же документы', async () => {
    const viaCli = await tree();
    const viaOperation = await tree();

    const run = await runCli(viaCli, [`content/${SOURCE_ID}`]);
    await importAsEditor(viaOperation);

    expect(run.code).toBe(0);
    for (const id of [SCENE_ID, PRESENTATION_ID]) {
      expect(await contentOf(viaCli, id)).toEqual(await contentOf(viaOperation, id));
    }
  });

  it('ассеты обоими путями тоже совпадают байт-в-байт', async () => {
    const files = (): Record<string, string | Uint8Array> =>
      contentFiles(gridGltf([TERRAIN_GRID, CURVATURE_GRID]), sceneDocument([], TERRAIN_ASSET), presentationDocument(), {
        [CURVATURE_ID]: JSON.stringify(curvatureDocument(), null, 2),
      });
    const viaCli = await tree(files());
    const viaOperation = await tree(files());

    const run = await runCli(viaCli, [`content/${SOURCE_ID}`]);
    await importAsEditor(viaOperation);

    expect(run.code).toBe(0);
    for (const id of [SCENE_ID, PRESENTATION_ID, CURVATURE_ID]) {
      expect(await contentOf(viaCli, id), id).toEqual(await contentOf(viaOperation, id));
    }
  });

  it('записанное — каноническая форма сохранения (ED-21), а не своя печать', async () => {
    const root = await tree();
    await runCli(root, [`content/${SOURCE_ID}`]);

    const bytes = await contentOf(root, PRESENTATION_ID);
    const canonical = encodeDocument(JSON.parse(bytes.toString('utf8')) as never);
    expect(new Uint8Array(bytes)).toEqual(canonical);
  });
});

describe('BLND-6: ошибка на середине — на диске ни байта', () => {
  it('отказ импорта не трогает ни один документ дерева', async () => {
    const root = await tree(contentFiles('mixed.gltf', sceneDocument([{ prefab: 'Rock', overrides: {} }])));
    const before = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(1);
    // Имя объекта Blender в отказе — тот адрес, который автор видит в outliner.
    expect(run.err.join('\n')).toContain('gamma-ghost');
    expect(await contentOf(root, SCENE_ID)).toEqual(before.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(before.presentation);
  });

  it('законные объекты того же источника на диск не просачиваются', async () => {
    const root = await tree(contentFiles('mixed.gltf'));
    await runCli(root, [`content/${SOURCE_ID}`]);

    const scene = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as { initial: unknown[] };
    expect(scene.initial).toEqual([]);
  });
});

describe('BLND-6, BLND-8: режим проверки не пишет и отвечает JSON', () => {
  it('--dry-run печатает целевой слой и находки, не записав ни байта', async () => {
    const root = await tree();
    const before = await contentOf(root, SCENE_ID);

    const run = await runCli(root, [`content/${SOURCE_ID}`, '--dry-run']);

    expect(run.code).toBe(0);
    const result = JSON.parse(run.out.join('\n')) as {
      ok: boolean;
      dryRun: boolean;
      written: string[];
      layer: { initial: unknown[]; decorations: unknown[] };
    };
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.layer.initial).toHaveLength(2);
    expect(result.layer.decorations).toHaveLength(1);
    expect(await contentOf(root, SCENE_ID)).toEqual(before);
  });

  it('записи нет НИ ОДНОЙ: ни правки документа, ни нового парного документа', async () => {
    // Дерево в памяти со счётчиком записей: «файл не изменился» доказывает
    // меньше, чем «в дерево не писали». Парного документа в нём нет нарочно —
    // именно его импорт создал бы первым (PRES-1), и режим проверки не вправе.
    const files = contentFiles();
    delete files[PRESENTATION_ID];
    const memory = createMemoryHost({ files });
    const writes: string[] = [];
    const host: ContentTreeHost = {
      ...memory.content,
      write(path, bytes) {
        writes.push(path);
        return memory.content.write(path, bytes);
      },
    };

    const result = await runImport({ host, source: SOURCE_ID, manifest: MANIFEST_ID, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.layer.decorations.length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
    expect(await host.stat(PRESENTATION_ID)).toBeUndefined();
  });

  it('клеточные слои уезжают тем же JSON: живая проверка видит и карты (BLND-9, BLND-10)', async () => {
    const files = contentFiles(
      gridGltf([TERRAIN_GRID, CURVATURE_GRID]),
      sceneDocument([], TERRAIN_ASSET),
      presentationDocument(),
      { [CURVATURE_ID]: JSON.stringify(curvatureDocument(), null, 2) },
    );
    const root = await tree(files);

    const run = await runCli(root, [`content/${SOURCE_ID}`, '--dry-run']);

    expect(run.code).toBe(0);
    const result = JSON.parse(run.out.join('\n')) as {
      layer: {
        terrain?: { levels: string[]; flags: string[] };
        curvature?: { width: number; height: number; rows: string[] };
      };
    };
    expect(result.layer.terrain).toEqual({ levels: [...TERRAIN_LEVELS], flags: [...TERRAIN_FLAGS] });
    expect(result.layer.curvature).toEqual({ width: 4, height: 4, rows: [...CURVATURE_ROWS] });
  });

  it('слота, которого источник не даёт, в JSON нет: «не переписывается» отличимо от «пусто»', async () => {
    const root = await tree();

    const run = await runCli(root, [`content/${SOURCE_ID}`, '--dry-run']);

    const result = JSON.parse(run.out.join('\n')) as { layer: Record<string, unknown> };
    expect(Object.keys(result.layer)).toEqual(['initial', 'decorations']);
  });

  it('источник с ошибкой в режиме проверки — тот же отказ и тот же адрес', async () => {
    const root = await tree(contentFiles('mixed.gltf'));

    const run = await runCli(root, [`content/${SOURCE_ID}`, '--dry-run']);

    expect(run.code).toBe(1);
    const result = JSON.parse(run.out.join('\n')) as { ok: boolean; findings: { object: string }[] };
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.object)).toContain('gamma-ghost');
  });
});

describe('BLND-4: детерминизм импорта', () => {
  it('повторный импорт неизменного источника не пишет ничего — дифф пуст', async () => {
    const root = await tree();
    await runCli(root, [`content/${SOURCE_ID}`]);
    const first = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    const again = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(again.code).toBe(0);
    expect(again.err.join('\n')).toContain('записи не было');
    expect(await contentOf(root, SCENE_ID)).toEqual(first.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(first.presentation);
  });

  it('перемещение объекта меняет только его переопределения', async () => {
    const root = await tree();
    await runCli(root, [`content/${SOURCE_ID}`]);
    const before = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as {
      initial: { prefab: string; overrides: Record<string, Record<string, number>> }[];
    };

    // Двигаем `alpha-hero` — первую запись по имени (BLND-4).
    const source = JSON.parse(new TextDecoder().decode(fixtureBytes('placements.gltf'))) as {
      nodes: { name: string; translation?: number[] }[];
    };
    source.nodes.find((node) => node.name === 'alpha-hero')!.translation = [7, 0, -8];
    await writeFile(join(root, 'content', SOURCE_ID), JSON.stringify(source));

    await runCli(root, [`content/${SOURCE_ID}`]);

    const after = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as typeof before;
    expect(after.initial.map((record) => record.prefab)).toEqual(before.initial.map((record) => record.prefab));
    expect(after.initial[0]!.overrides.Position).not.toEqual(before.initial[0]!.overrides.Position);
    expect(after.initial[1]).toEqual(before.initial[1]);
  });

  it('переименование объекта двигает порядок записей — законно и видно (SER-8)', async () => {
    const root = await tree();
    await runCli(root, [`content/${SOURCE_ID}`]);
    const before = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as {
      initial: { overrides: Record<string, Record<string, number>> }[];
    };

    // `zeta-hero` шёл вторым; под именем `aaa-hero` он идёт первым.
    const source = JSON.parse(new TextDecoder().decode(fixtureBytes('placements.gltf'))) as {
      nodes: { name: string }[];
    };
    source.nodes.find((node) => node.name === 'zeta-hero')!.name = 'aaa-hero';
    await writeFile(join(root, 'content', SOURCE_ID), JSON.stringify(source));

    await runCli(root, [`content/${SOURCE_ID}`]);

    const after = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as typeof before;
    expect(after.initial).toHaveLength(before.initial.length);
    expect(after.initial[0]).toEqual(before.initial[1]);
    expect(after.initial[1]).toEqual(before.initial[0]);
  });
});

describe('BLND-3: мост — terrain-объект и walkable-декорация одним источником', () => {
  /**
   * Источник сценария «Мост в Blender»: перепад задан клетками terrain-объекта,
   * а поверх стоит объект настила с `visual` и `walkable: true` (PRES-2 —
   * пара «уровни ↔ walkable-меш»). Собирается в памяти тем же приёмом, что
   * `full.glb` перечня фикстур.
   */
  const bridgeSource = (): Uint8Array => {
    const grids = gridSource([TERRAIN_GRID]);
    const nodes = [
      ...(grids.json.nodes as Record<string, unknown>[]),
      { name: 'deck', translation: [1, 0, -2], extras: { visual: 'Bridge', walkable: true } },
    ];
    return packGlb(
      { ...grids.json, nodes, scenes: [{ nodes: nodes.map((_, index) => index) }] },
      grids.binary,
    );
  };

  it('импорт переписывает ассет террейна и кладёт запись decoration с walkable: true', async () => {
    const root = await tree(contentFiles(bridgeSource(), sceneDocument([], TERRAIN_ASSET)));

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    const presentation = JSON.parse((await contentOf(root, PRESENTATION_ID)).toString('utf8')) as {
      decorations: unknown[];
    };
    expect(presentation.decorations).toEqual([{ visual: 'Bridge', x: 1, y: 2, walkable: true }]);
    const scene = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as {
      terrain: { levels: string[] };
    };
    expect(scene.terrain.levels).toEqual([...TERRAIN_LEVELS]);
  });

  it('повторный импорт неизменного источника даёт пустой дифф (BLND-4)', async () => {
    const root = await tree(contentFiles(bridgeSource(), sceneDocument([], TERRAIN_ASSET)));
    await runCli(root, [`content/${SOURCE_ID}`]);
    const first = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    const again = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(again.code).toBe(0);
    expect(again.err.join('\n')).toContain('записи не было');
    expect(await contentOf(root, SCENE_ID)).toEqual(first.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(first.presentation);
  });

  it('ошибочный walkable отвергает импорт целиком: на диске ни байта (BLND-6)', async () => {
    const root = await tree(contentFiles('walkable-errors.gltf'));
    const before = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(1);
    // Адрес отказа — имена объектов Blender (BLND-6).
    expect(run.err.join('\n')).toContain('bad-string');
    expect(run.err.join('\n')).toContain('walkable-prefab');
    expect(await contentOf(root, SCENE_ID)).toEqual(before.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(before.presentation);
  });
});

describe('BLND-2, PRES-2: импорт владеет только decorations — секция fog остаётся байт-в-байт', () => {
  /** Секция fog цели (FOW-10): поле вне пространственного слоя импорта. */
  const FOG = {
    strength: 0.65,
    color: '#101623',
    edgeWidth: 2,
    conservatism: 0.92,
    resolution: 4,
    fadeSeconds: 0.45,
  };

  /** Байтовый срез секции fog из канонической формы файла — им и меряется «байт-в-байт». */
  function fogSlice(bytes: Buffer): string {
    const match = /"fog": \{[^}]*\}/.exec(bytes.toString('utf8'));
    if (match === null) throw new Error('в документе нет секции fog');
    return match[0];
  }

  it('перепись decorations импортом оставляет fog байт-в-байт, а файл — канонической формой (ED-21)', async () => {
    // Файл записан канонической формой (ED-21) заранее: тогда изменение любых
    // байтов секции fog — дело импорта, а не переформатирования при сохранении.
    const before = encodeDocument({ decorations: [], fog: FOG });
    const root = await tree(
      contentFiles('placements.gltf', sceneDocument(), presentationDocument(), {
        [PRESENTATION_ID]: before,
      }),
    );

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    const after = await contentOf(root, PRESENTATION_ID);
    // Импорт переписал список decorations (источник даёт запись Statue)…
    const parsed = JSON.parse(after.toString('utf8')) as { decorations: unknown[]; fog: unknown };
    expect(parsed.decorations.length).toBeGreaterThan(0);
    // …а секция fog в файле — тот же байтовый срез, что до импорта (BLND-2).
    expect(fogSlice(after)).toBe(fogSlice(Buffer.from(before)));
    // Round-trip канонического сохранения (ED-21): записанное — каноническая
    // форма самого себя, то есть «открыл — сохранил» не изменит ни байта.
    expect(new Uint8Array(after)).toEqual(encodeDocument(parsed as never));
  });

  it('повторный импорт того же источника не трогает документ с fog вовсе (BLND-4)', async () => {
    const root = await tree(
      contentFiles('placements.gltf', sceneDocument(), presentationDocument(), {
        [PRESENTATION_ID]: encodeDocument({ decorations: [], fog: FOG }),
      }),
    );
    await runCli(root, [`content/${SOURCE_ID}`]);
    const first = await contentOf(root, PRESENTATION_ID);

    const again = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(again.code).toBe(0);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(first);
  });
});

describe('ED-12: командная строка ходит в дерево только хостом среды', () => {
  it('путь вне дерева контента — отказ вызова, а не чтение мимо корня', async () => {
    const root = await tree();

    const run = await runCli(root, ['../elsewhere/duel.glb']);

    expect(run.code).toBe(2);
    expect(run.err.join('\n')).toContain('вне дерева контента');
  });

  it('сцена, которой нет рядом с источником, названа отказом (BLND-2)', async () => {
    const root = await tree({ 'scenes/orphan.gltf': fixtureBytes('placements.gltf') });

    const run = await runCli(root, ['content/scenes/orphan.gltf']);

    expect(run.code).toBe(2);
    expect(run.err.join('\n')).toContain('scenes/orphan.scene.json');
  });

  it('сцена без парного документа получает его первым же импортом (PRES-1)', async () => {
    const files = contentFiles();
    delete files[PRESENTATION_ID];
    const root = await tree(files);

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    const presentation = JSON.parse((await contentOf(root, PRESENTATION_ID)).toString('utf8')) as {
      decorations: unknown[];
    };
    expect(presentation.decorations).toHaveLength(1);
  });
});

describe('BLND-1: импорт — потребитель хоста среды, а не файловой системы', () => {
  it('runImport от подданного хоста делает то же, что командная строка', async () => {
    const root = await tree();
    const host = createNodeHost({ root: join(root, 'content') });

    const result = await runImport({ host: host.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(true);
    expect([...result.written].sort()).toEqual([PRESENTATION_ID, SCENE_ID].sort());
    expect(result.presentation).toBe(PRESENTATION_ID);
  });

  it('сцена без decorations в источнике теряет их и в документе', async () => {
    const root = await tree(
      contentFiles('warnings.gltf', sceneDocument(), presentationDocument([{ visual: 'Statue', x: 1, y: 1 }])),
    );
    const host = createNodeHost({ root: join(root, 'content') });

    const result = await runImport({ host: host.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(true);
    const presentation = JSON.parse((await contentOf(root, PRESENTATION_ID)).toString('utf8')) as {
      decorations: unknown[];
    };
    expect(presentation.decorations).toHaveLength(2);
  });
});

describe('BLND-6: результат импорта прогоняется валидацией на общих основаниях (ED-8)', () => {
  it('запись, которую отверг бы загрузчик сцены, на диск не уходит', async () => {
    // Вместимость мира меньше числа размещений: сам слой законен (записи
    // прошли BLND-3 и BLND-4), а поднять такую сцену ядро не сможет — и это
    // ловит правило движка на состоянии дерева после записи (ED-21), а не
    // импортёр своей проверкой.
    const scene = { ...sceneDocument(), capacity: 1 };
    const root = await tree(contentFiles('placements.gltf', scene));
    const before = await contentOf(root, SCENE_ID);

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(1);
    expect(await contentOf(root, SCENE_ID)).toEqual(before);
  });
});

describe('BLND-9, BLND-10: ассеты в атомарной записи импорта', () => {
  /** Дерево со сценой, у которой есть ассет террейна, и с картой кривизны рядом. */
  const withAssets = (source: Uint8Array): Record<string, string | Uint8Array> =>
    contentFiles(source, sceneDocument([], TERRAIN_ASSET), presentationDocument(), {
      [CURVATURE_ID]: JSON.stringify(curvatureDocument(), null, 2),
    });

  it('terrain-объект переписывает карты ассета, прочие поля конфига — байт-в-байт прежние', async () => {
    const root = await tree(withAssets(gridGltf([TERRAIN_GRID])));
    const before = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as Record<string, unknown>;

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    const after = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as Record<string, unknown>;
    expect((after.terrain as Record<string, unknown>).levels).toEqual([...TERRAIN_LEVELS]);
    expect((after.terrain as Record<string, unknown>).flags).toEqual([...TERRAIN_FLAGS]);
    // Всё, кроме карт: состав ключей, размеры сетки, системы и схемы.
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const stripped = (value: Record<string, unknown>): string =>
      JSON.stringify({ ...value, terrain: { ...(value.terrain as object), levels: [], flags: [] }, initial: [] });
    expect(stripped(after)).toBe(stripped(before));
  });

  it('источник без terrain-объекта ассета не трогает вовсе (BLND-2)', async () => {
    const root = await tree(withAssets(fixtureBytes('placements.gltf')));
    const before = await contentOf(root, SCENE_ID);

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    const after = JSON.parse((await contentOf(root, SCENE_ID)).toString('utf8')) as Record<string, unknown>;
    const wanted = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    expect(after.terrain).toEqual(wanted.terrain);
    // И карта кривизны тоже: у неё в источнике объекта нет — байт в байт.
    expect(JSON.parse((await contentOf(root, CURVATURE_ID)).toString('utf8'))).toEqual(curvatureDocument());
  });

  it('curvature-объект переписывает карту, не меняя ни байта sim-документов (BLND-10)', async () => {
    const root = await tree(withAssets(gridGltf([CURVATURE_GRID])));
    const before = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
    };

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    expect(JSON.parse((await contentOf(root, CURVATURE_ID)).toString('utf8'))).toEqual({
      width: 4,
      height: 4,
      rows: [...CURVATURE_ROWS],
    });
    // Ни ассет террейна, ни расстановка, ни decorations: у кривизны нет ни
    // одного пути внутрь sim-документов, и это видно на диске.
    expect(await contentOf(root, SCENE_ID)).toEqual(before.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(before.presentation);
  });

  it('ошибочный террейн отменяет запись целиком — включая законную карту кривизны (BLND-6)', async () => {
    // Рампа в одну клетку: отказ приходит из `createTerrainGrid` — того же
    // вызова, которым ассет проверяет правило редактора у кисти ED-10 (TERR-7).
    const broken = {
      ...TERRAIN_GRID,
      heights: levelHeights(['0000', '0000', '1111', '1111']),
      ramp: flagCells(['....', '.^..', '....', '....'], '^'),
      noFloor: flagCells(['....', '....', '....', '....'], '_'),
    };
    const root = await tree(withAssets(gridGltf([broken, CURVATURE_GRID])));
    const before = {
      scene: await contentOf(root, SCENE_ID),
      presentation: await contentOf(root, PRESENTATION_ID),
      curvature: await contentOf(root, CURVATURE_ID),
    };

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toContain('TERR-7');
    // Адрес — имя объекта Blender и адрес клетки (BLND-6).
    expect(run.err.join('\n')).toContain('terrain:');
    expect(await contentOf(root, SCENE_ID)).toEqual(before.scene);
    expect(await contentOf(root, PRESENTATION_ID)).toEqual(before.presentation);
    expect(await contentOf(root, CURVATURE_ID)).toEqual(before.curvature);
  });

  it('отказ не оставляет на диске созданной под слой пустой карты кривизны (BLND-6)', async () => {
    // Карты в дереве ещё нет: под curvature-объект источника импорт открывает
    // её пустой (как парный документ), и отказ соседнего слоя обязан унести
    // её с собой — файл, созданный неудавшимся импортом, и есть та самая
    // половина состояния, которой не бывает.
    const broken = { ...TERRAIN_GRID, heights: levelHeights(['0000', '0000', '1111', '1110']) };
    broken.heights[3]![3] = 1.4;
    const root = await tree(
      contentFiles(gridGltf([broken, CURVATURE_GRID]), sceneDocument([], TERRAIN_ASSET), presentationDocument()),
    );

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toContain('высота 1.4');
    await expect(contentOf(root, CURVATURE_ID)).rejects.toThrow();
  });

  it('повторный импорт источника с ассетами не пишет ничего (BLND-4)', async () => {
    const root = await tree(withAssets(gridGltf([TERRAIN_GRID, CURVATURE_GRID])));
    await runCli(root, [`content/${SOURCE_ID}`]);
    const first = {
      scene: await contentOf(root, SCENE_ID),
      curvature: await contentOf(root, CURVATURE_ID),
    };

    const again = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(again.code).toBe(0);
    expect(again.err.join('\n')).toContain('записи не было');
    expect(await contentOf(root, SCENE_ID)).toEqual(first.scene);
    expect(await contentOf(root, CURVATURE_ID)).toEqual(first.curvature);
  });

  it('карты кривизны ещё нет в дереве — первый импорт её создаёт', async () => {
    const files = contentFiles(gridGltf([CURVATURE_GRID]), sceneDocument([], TERRAIN_ASSET));
    const root = await tree(files);

    const run = await runCli(root, [`content/${SOURCE_ID}`]);

    expect(run.code).toBe(0);
    expect(JSON.parse((await contentOf(root, CURVATURE_ID)).toString('utf8'))).toEqual({
      width: 4,
      height: 4,
      rows: [...CURVATURE_ROWS],
    });
  });
});
