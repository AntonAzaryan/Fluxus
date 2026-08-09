/**
 * Цикл hot-reload со стороны кадра (`blender-pipeline` BLND-12): документ,
 * переписанный в дереве извне, перечитывается в сессию и доезжает до вьюпорта
 * теми же каналами, что и всякая правка редактора (ED-15, REND-11, REND-14,
 * REND-17, CAM-7).
 *
 * Сокета dev-сервера здесь нет и не должно быть: канал «дерево изменилось»
 * принадлежит среде (ED-12), и в этом прогоне средой служит хост в памяти —
 * тот же тестовый дубль, что и во всех остальных тестах области сцены. Запись
 * в него — это и есть «кто-то переписал файл», а `watch` шва — тот же канал,
 * который в вебе наполняет сокет.
 *
 * Импортёра Blender здесь тоже нет: он пишет ДОКУМЕНТЫ, и с точки зрения кадра
 * его правка неотличима от правки любым другим инструментом — ровно то, чего
 * требует BLND-1.
 */
import { describe, expect, it } from 'vitest';
import {
  refreshDocument,
  watchExternalDocuments,
  type RefreshOutcome,
} from '../app/documentRefresh.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { PREFAB_LIST } from '../src/areas/objectsPrefabs.js';
import { buildLoadedFrame } from './support/frame.js';
import { FIXTURE_IDS, FIXTURE_SCENE, settle } from './support/project.js';

/** Тот же конфиг сцены с переставленным Hero — правка, пришедшая из Blender. */
function movedScene(x: number): string {
  const scene = structuredClone(FIXTURE_SCENE) as {
    prefabs: { name: string; components: { Position: { x: number } } }[];
  };
  scene.prefabs[0]!.components.Position.x = x;
  return JSON.stringify(scene);
}

/** Запись в дерево мимо редактора: так выглядит сохранение чужого инструмента. */
async function writeExternally(
  host: { content: { write(path: string, bytes: Uint8Array): Promise<void> } },
  path: string,
  text: string,
): Promise<void> {
  await host.content.write(path, new TextEncoder().encode(text));
}

describe('BLND-12: правка дерева извне доезжает до кадра', () => {
  it('перечитанный документ переподаётся вьюпорту без перезапуска', async () => {
    const { session, host, stage } = await buildLoadedFrame();
    watchExternalDocuments({ session, host: host.content });
    const before = stage.submitted.length;

    await writeExternally(host, FIXTURE_IDS.config, movedScene(262144));
    await settle();

    expect(stage.submitted.length).toBeGreaterThan(before);
    expect(stage.last?.placements[0]?.x).toBeCloseTo(4, 6);
    // Документ в сессии — тот, что лежит в дереве: снимка рядом не завелось.
    expect(session.isOpen(FIXTURE_IDS.config)).toBe(true);
    expect(session.document(FIXTURE_IDS.config).dirty).toBe(false);
  });

  it('переписанная карта уровней доезжает новой сеткой (REND-14, CAM-7)', async () => {
    const { session, host, stage } = await buildLoadedFrame();
    watchExternalDocuments({ session, host: host.content });
    const before = stage.last?.grid;
    const scene = structuredClone(FIXTURE_SCENE) as { terrain: { levels: string[] } };
    scene.terrain.levels[0] = '1111';

    await writeExternally(host, FIXTURE_IDS.config, JSON.stringify(scene));
    await settle();

    expect(stage.last?.grid).not.toBe(before);
    expect(stage.last?.grid?.levels[0]).toBe(1);
  });

  it('перечитанный документ остаётся адресуемым: списки открыты заново', async () => {
    const { session, host } = await buildLoadedFrame();
    watchExternalDocuments({ session, host: host.content });

    await writeExternally(host, FIXTURE_IDS.config, movedScene(262144));
    await settle();

    // Дескрипторы записей — ключи инстансов кадра (REND-11): документ без них
    // область показала бы как «списков не отслеживают».
    expect(session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)).toHaveLength(2);
    expect(session.descriptors(FIXTURE_IDS.config, PREFAB_LIST)).toHaveLength(2);
  });

  it('совпавшие байты не перечитываются: собственная запись редактора не мигает кадром', async () => {
    const { session, host } = await buildLoadedFrame();
    const keys = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);

    const outcome = await refreshDocument(session, host.content, FIXTURE_IDS.config);

    expect(outcome.kind).toBe('unchanged');
    // Дескрипторы те же самые — то есть инстансы кадра не пересоздавались.
    expect(session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)).toEqual(keys);
  });

  it('документ, которого редактор не открывал, не читается вовсе', async () => {
    const { session, host } = await buildLoadedFrame();

    const outcome = await refreshDocument(session, host.content, 'visuals/models/hero.mdx');

    expect(outcome.kind).toBe('unchanged');
  });
});

describe('BLND-12, ED-21: чужая правка не стирает работу автора', () => {
  it('документ с несохранёнными правками остаётся своим — с названной причиной', async () => {
    const { session, host } = await buildLoadedFrame();
    session.applyOperation('document.list.setValue', {
      document: FIXTURE_IDS.config,
      record: session.descriptors(FIXTURE_IDS.config, PREFAB_LIST)[0] ?? '',
      path: ['components', 'Position', 'x'],
      value: 393216,
    });
    await settle();

    await writeExternally(host, FIXTURE_IDS.config, movedScene(262144));
    const outcome = await refreshDocument(session, host.content, FIXTURE_IDS.config);

    expect(outcome).toEqual({ kind: 'kept', id: FIXTURE_IDS.config, reason: 'dirty' });
    expect(session.document(FIXTURE_IDS.config).dirty).toBe(true);
  });

  it('документ, упомянутый в истории операций, не подменяется под undo (ED-18)', async () => {
    const { session, host } = await buildLoadedFrame();
    session.applyOperation('document.list.setValue', {
      document: FIXTURE_IDS.config,
      record: session.descriptors(FIXTURE_IDS.config, PREFAB_LIST)[0] ?? '',
      path: ['components', 'Position', 'x'],
      value: 393216,
    });
    // Правки сохранены — «несохранённого» больше нет, а история осталась.
    session.markSaved(FIXTURE_IDS.config);
    await settle();

    await writeExternally(host, FIXTURE_IDS.config, movedScene(262144));
    const outcome = await refreshDocument(session, host.content, FIXTURE_IDS.config);

    expect(outcome).toEqual({ kind: 'kept', id: FIXTURE_IDS.config, reason: 'history' });
    expect(session.canUndo()).toBe(true);
  });
});

describe('ED-12: отказ чтения назван, а не проглочен', () => {
  it('неразбираемый документ не гасит кадр и приносит причину', async () => {
    const { session, host, stage } = await buildLoadedFrame();
    const outcomes: RefreshOutcome[] = [];
    watchExternalDocuments({
      session,
      host: host.content,
      report: (outcome) => outcomes.push(outcome),
    });
    const before = stage.last;

    await writeExternally(host, FIXTURE_IDS.config, '{ это не JSON');
    await settle();

    expect(outcomes.map((outcome) => outcome.kind)).toContain('failed');
    // Кадр показывает прежнее состояние: подменять его половиной нечем.
    expect(stage.last).toBe(before);
    expect(session.isOpen(FIXTURE_IDS.config)).toBe(true);
  });

  it('исчезнувший файл открытый документ не отменяет', async () => {
    const { session, host } = await buildLoadedFrame();
    const outcomes: RefreshOutcome[] = [];
    watchExternalDocuments({
      session,
      host: host.content,
      report: (outcome) => outcomes.push(outcome),
    });

    // Хост в памяти объявляет удаление тем же каналом, что и dev-сервер.
    host.remove(FIXTURE_IDS.config);
    await settle();

    expect(outcomes).toEqual([]);
    expect(session.isOpen(FIXTURE_IDS.config)).toBe(true);
  });
});
