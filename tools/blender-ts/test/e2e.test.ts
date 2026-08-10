/**
 * Сквозная проверка конвейера (задача 10.2): полная фикстура экспорта →
 * импорт во временное дерево контента → НАСТОЯЩИЕ загрузчики движка →
 * `worldInit` и прогон.
 *
 * Что здесь проверяется такого, чего не видит ни один тест по отдельности.
 *
 * Тесты импорта проверяют, что документ записан и что записано в нём то, что
 * ожидал автор теста. Кто эти документы потом ГРУЗИТ, они не спрашивают: и
 * `loadScene`, и модуль ассетов остались бы недовольны молча. BLND-1 требует
 * обратного — «импортированная сцена SHALL быть неотличима от написанной
 * редактором для всех потребителей — загрузчика сцены, рендера, netcode,
 * golden-прогонов», — и единственный способ это утверждать: взять то, что
 * записал импорт, и подать в те самые загрузчики.
 *
 * Второе утверждение — детерминизм в терминах ДВИЖКА, а не диффа файлов:
 * `worldInitHash` (DET-1) от двух независимых импортов одного источника совпадает.
 * Дифф документов это подразумевает, но не доказывает: канонические байты и
 * канонический `worldInit` — разные вещи, и порядок записей `initial` (BLND-4)
 * влияет на выданные ID, то есть ровно на хеш.
 *
 * Третье — PRES-4 на импортированной сцене: парный документ, который импорт
 * только что написал, симуляции не касается ни байтом.
 *
 * Blender не зовётся ни в какой форме (BLND-7): источник — закоммиченная
 * фикстура `full.glb`, дерево — временный каталог.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadScene,
  runScenario,
  runScenarioBytes,
  world,
  worldInitHash,
  type SceneDef,
} from '@game-mvp/core';
import {
  presentationPathOf,
  validateCurvatureMap,
  validateManifest,
  validatePresentationScene,
} from '@game-mvp/assets';
import { runImport } from '../src/importer.js';
import { createNodeHost } from '../src/nodeHost.js';
import {
  CURVATURE_ID,
  CURVATURE_ROWS,
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  TERRAIN_ASSET,
  TERRAIN_FLAGS,
  TERRAIN_LEVELS,
  contentFiles,
  curvatureDocument,
  fixtureBytes,
  sceneDocument,
} from './support.js';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Полный источник: размещения, decoration, terrain- и curvature-объекты (см. README фикстур). */
const SOURCE = 'scenes/duel.glb';

/**
 * Дерево цели: сцена с ассетом террейна 4×4, парный документ, манифест, карта
 * кривизны «до импорта» и источник рядом со сценой (BLND-2 — парность по имени).
 */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'blender-e2e-'));
  created.push(root);
  const files = contentFiles(fixtureBytes('full.glb'), sceneDocument([], TERRAIN_ASSET));
  // Источник переезжает под парное имя контейнера, а карта кривизны кладётся
  // рядом: обе — цель импорта, и обе обязаны приехать из источника.
  delete files['scenes/duel.gltf'];
  files[SOURCE] = fixtureBytes('full.glb');
  files[CURVATURE_ID] = JSON.stringify(curvatureDocument(), null, 2);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, 'content', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const readJson = async (root: string, path: string): Promise<unknown> =>
  JSON.parse(await readFile(join(root, 'content', path), 'utf8'));

/** Один прогон конвейера: дерево → импорт → документы с диска. */
async function imported(): Promise<{
  readonly root: string;
  readonly scene: SceneDef;
  readonly presentation: unknown;
  readonly curvature: unknown;
  readonly manifest: unknown;
}> {
  const root = await tree();
  const host = createNodeHost({ root: join(root, 'content') });
  const result = await runImport({ host: host.content, source: SOURCE, manifest: MANIFEST_ID });
  expect(result.refusal, result.refusal ?? '').toBeNull();
  expect(result.ok).toBe(true);
  // Записаны все три документа производных данных: конфиг сцены (с ассетом
  // террейна полем), парный документ и карта кривизны (BLND-2).
  expect([...result.written].sort()).toEqual([CURVATURE_ID, PRESENTATION_ID, SCENE_ID].sort());

  return {
    root,
    scene: (await readJson(root, SCENE_ID)) as SceneDef,
    presentation: await readJson(root, PRESENTATION_ID),
    curvature: await readJson(root, CURVATURE_ID),
    manifest: await readJson(root, MANIFEST_ID),
  };
}

/** Сценарий прогона: та же сцена, тот же ввод, те же тики. */
const scenario = (scene: SceneDef): Parameters<typeof runScenarioBytes>[0] => ({
  name: 'blender-e2e',
  scene,
  ticks: 8,
  seed: 20260809,
});

describe('BLND-1: импортированная сцена грузится настоящими загрузчиками', () => {
  it('конфиг сцены проходит loadScene и даёт мир с расстановкой и террейном', async () => {
    const { scene } = await imported();

    const loaded = loadScene(scene);

    // Расстановка приехала из источника: две сим-записи (BLND-3). Живых
    // сущностей считается больше — террейн и прочие служебные prefab'ы ядра
    // тоже сущности, — поэтому проверяется нижняя граница.
    expect(world.listAlive(loaded.world).length).toBeGreaterThanOrEqual(2);
    // Ассет террейна приехал картами, а не размерами: сетка — цель (BLND-9).
    expect(loaded.terrain).toBeDefined();
    expect(loaded.terrain?.grid.width).toBe(4);
    expect(loaded.terrain?.grid.height).toBe(4);
    // И хеш `worldInit` считается — то есть мир до первого тика собран (DET-1).
    expect(
      worldInitHash({
        world: loaded.world,
        mode: 'Running',
        ...(loaded.terrain === undefined ? {} : { terrain: loaded.terrain }),
      }),
    ).toMatch(/^[0-9a-f]{8}$/);
  });

  it('карты террейна в конфиге — те, что дал источник (BLND-9)', async () => {
    const { scene } = await imported();

    expect((scene as unknown as { terrain: { levels: string[]; flags: string[] } }).terrain).toMatchObject({
      levels: [...TERRAIN_LEVELS],
      flags: [...TERRAIN_FLAGS],
    });
  });

  it('парный документ, карта кривизны и манифест проходят модуль ассетов', async () => {
    const { presentation, curvature, manifest } = await imported();

    const layer = validatePresentationScene(presentation);
    expect(layer.ok ? '' : layer.errors.join('; ')).toBe('');
    // Проверка не о пустоте: decoration в слое есть, и он приехал из источника.
    expect(layer.ok && layer.scene.decorations.length).toBe(1);

    const map = validateCurvatureMap(curvature);
    expect(map.ok ? '' : map.errors.join('; ')).toBe('');
    expect((curvature as { rows: string[] }).rows).toEqual([...CURVATURE_ROWS]);

    // Манифест импорт не трогает вовсе (BLND-2), и валиден он как прежде.
    const visuals = validateManifest(manifest);
    expect(visuals.ok ? '' : visuals.errors.join('; ')).toBe('');
  });

  it('парный документ находится ПРАВИЛОМ ИМЕНИ, а не ссылкой (PRES-1)', async () => {
    const { scene } = await imported();

    expect(presentationPathOf(SCENE_ID)).toBe(PRESENTATION_ID);
    // Ссылки на парный документ в конфиге нет и быть не должно: состав его
    // полей закрыт (SER-7), и конвейер его не расширяет (BLND-2).
    expect(JSON.stringify(scene)).not.toContain('presentation');
    expect(JSON.stringify(scene)).not.toContain('duel.glb');
  });
});

describe('BLND-4, DET-1: два независимых импорта дают один и тот же worldInit', () => {
  it('хеш и байты документов совпадают между прогонами', async () => {
    const first = await imported();
    const second = await imported();

    expect(JSON.stringify(second.scene)).toBe(JSON.stringify(first.scene));
    expect(JSON.stringify(second.presentation)).toBe(JSON.stringify(first.presentation));
    expect(JSON.stringify(second.curvature)).toBe(JSON.stringify(first.curvature));

    // Хеш считает ядро тем же способом, что CLI (CLI-3): второй его реализации
    // тест не заводит.
    const hashOf = (scene: SceneDef): string => runScenario(scenario(scene)).worldInitHash;
    expect(hashOf(second.scene)).toBe(hashOf(first.scene));
    // И прогон целиком совпадает побитово: расхождение порядка записей (BLND-4)
    // видно здесь, а не на десинке.
    expect(
      Buffer.from(runScenarioBytes(scenario(second.scene))).equals(
        Buffer.from(runScenarioBytes(scenario(first.scene))),
      ),
    ).toBe(true);
  });

  it('повторный импорт в то же дерево не меняет ни байта (BLND-4)', async () => {
    const { root, scene, presentation, curvature } = await imported();
    const host = createNodeHost({ root: join(root, 'content') });

    const again = await runImport({ host: host.content, source: SOURCE, manifest: MANIFEST_ID });

    expect(again.ok).toBe(true);
    // Пустой дифф получается не совпадением байтов, а отсутствием записи:
    // операция не нашла, что менять (BLND-4).
    expect(again.written).toEqual([]);
    expect(await readJson(root, SCENE_ID)).toEqual(scene);
    expect(await readJson(root, PRESENTATION_ID)).toEqual(presentation);
    expect(await readJson(root, CURVATURE_ID)).toEqual(curvature);
  });
});

describe('PRES-4: парный документ импортированной сцены симуляции не касается', () => {
  it('прогон с ним и без него побитово один и тот же', async () => {
    const { root, scene, presentation } = await imported();

    // Слой поднят по-настоящему, а не лежит на диске: он разобран, и в нём есть
    // записи — иначе утверждение об изоляции было бы про пустоту.
    const parsed = validatePresentationScene(presentation);
    expect(parsed.ok && parsed.scene.decorations.length).toBeGreaterThan(0);
    const decorated = runScenarioBytes(scenario(scene));

    // Парного документа рядом со сценой больше нет — законное состояние (PRES-1).
    await rm(join(root, 'content', PRESENTATION_ID));
    const bare = runScenarioBytes(scenario((await readJson(root, SCENE_ID)) as SceneDef));

    expect(Buffer.from(decorated).equals(Buffer.from(bare))).toBe(true);
  });

  it('импорт кривизны не меняет ни байта сим-документов (BLND-10)', async () => {
    const { root, scene } = await imported();
    const host = createNodeHost({ root: join(root, 'content') });

    // Карту кривизны правят руками — так, как её правила бы кисть ED-11.
    await writeFile(
      join(root, 'content', CURVATURE_ID),
      JSON.stringify(curvatureDocument(), null, 2),
    );
    const again = await runImport({ host: host.content, source: SOURCE, manifest: MANIFEST_ID });

    expect(again.ok).toBe(true);
    // Переписана ровно карта: конфиг сцены байт-в-байт прежний.
    expect(again.written).toEqual([CURVATURE_ID]);
    expect(await readJson(root, SCENE_ID)).toEqual(scene);
    expect(runScenario(scenario(scene)).worldInitHash).toBe(
      runScenario(scenario((await readJson(root, SCENE_ID)) as SceneDef)).worldInitHash,
    );
  });
});
