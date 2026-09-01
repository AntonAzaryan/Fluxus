/**
 * Правило существования ассета в СОБРАННОМ редакторе (ED-14: «ссылка на
 * отсутствующий ассет… подсвечивается сразу в редакторе — до диска»).
 *
 * Тесты самого правила и индекса под ним живут в ядре редактора
 * (`editor/core-ts/test/assetRefs.test.ts`). Здесь проверяется ровно то, чего
 * они не видят: что правило ЗАРЕГИСТРИРОВАНО сборкой, что дерево ему подано до
 * первого прогона и что правка дерева извне доезжает до находок (ED-12) — тем
 * же каналом, которым едет hot-reload импорта.
 */
import {
  createMemoryHost,
  ASSET_REFERENCE_RULE,
  type ContentChange,
  type ContentTreeHost,
  type ContentWatcher,
  type EnvironmentHost,
  type MemoryHost,
} from '@fluxus/editor-core';
import { describe, expect, it } from 'vitest';
import { createEditorApp } from '../app/assembly.js';
import { SCENE_AREA_ID, type SceneAreaState } from '../src/areas/scene.js';
import { settle } from './support/project.js';

const CONFIG = 'levels/arena.json';
const VISUALS = 'art/looks.json';
const HERO_MODEL = 'art/models/hero.mdx';

const SCENE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [{ name: 'Hero', tags: ['Hero'], components: { Position: { x: 0, y: 0 } } }],
  initial: [{ prefab: 'Hero' }],
  capacity: 16,
};

const MANIFEST = { entities: { Hero: { model: HERO_MODEL } } };

function projectHost(files: Readonly<Record<string, string>> = {}): MemoryHost {
  return createMemoryHost({
    name: 'project',
    root: { label: 'дерево фикстуры' },
    choices: { root: { label: 'дерево фикстуры' } },
    files: { [CONFIG]: JSON.stringify(SCENE), [VISUALS]: JSON.stringify(MANIFEST), ...files },
  });
}

async function opened(files: Readonly<Record<string, string>> = {}): Promise<{
  host: MemoryHost;
  state: SceneAreaState;
}> {
  const host = projectHost(files);
  const app = await createEditorApp({ host });
  const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
  await settle();
  return { host, state };
}

/**
 * Хост, чей канал изменений держит тест. Нужен затем, чтобы воспроизвести
 * событие, которого хост в памяти сам не порождает: удаление КАТАЛОГА одним
 * событием на сам каталог — так о нём сообщает десктопный мост
 * (`desktop/shell-ts/src/host/root.ts`), и файла с таким путём в индексе нет.
 */
function watchable(host: MemoryHost): {
  readonly host: EnvironmentHost;
  emit: (change: ContentChange) => void;
} {
  const watchers = new Set<ContentWatcher>();
  const content: ContentTreeHost = {
    ...host.content,
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  return {
    host: { ...host, content },
    emit: (change) => {
      for (const watcher of [...watchers]) watcher(change);
    },
  };
}

const assetIssues = (state: SceneAreaState) =>
  (state.report?.issues ?? []).filter((issue) => issue.ruleId === ASSET_REFERENCE_RULE);

describe('ED-14: ссылка манифеста в никуда подсвечена собранным редактором', () => {
  it('модели, которой нет в дереве, соответствует находка с адресом записи', async () => {
    const { state } = await opened();

    const issues = assetIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.documentId).toBe(VISUALS);
    expect(issues[0]!.path).toEqual(['entities', 'Hero', 'model']);
    expect(issues[0]!.reasonParams.asset).toBe(HERO_MODEL);
  });

  it('лежащая в дереве модель находок не даёт: дерево перечислено до первого прогона', async () => {
    const { state } = await opened({ [HERO_MODEL]: 'модель-фикстура' });

    expect(assetIssues(state)).toEqual([]);
    // Молчание — не «правило не сработало»: отчёт собран, и правило в нём есть.
    expect(state.report).not.toBeNull();
  });

  it('удаление каталога одним событием доходит до индекса (ED-12)', async () => {
    const memory = projectHost({ [HERO_MODEL]: 'модель-фикстура' });
    const { host, emit } = watchable(memory);
    const app = await createEditorApp({ host });
    const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    await settle();
    expect(assetIssues(state)).toEqual([]);

    // Каталог с моделью исчез: файлов под ним больше нет, а событие пришло одно
    // — на сам каталог, пути которого индекс не знает.
    memory.remove(HERO_MODEL);
    emit({ path: 'art/models', kind: 'removed' });
    await settle();

    expect(assetIssues(state)).toHaveLength(1);
    expect(assetIssues(state)[0]!.reasonParams.asset).toBe(HERO_MODEL);
  });

  it('появившийся в дереве файл снимает находку тем же каналом, что hot-reload (ED-12)', async () => {
    const { host, state } = await opened();
    expect(assetIssues(state)).toHaveLength(1);

    await host.content.write(HERO_MODEL, new TextEncoder().encode('модель-фикстура'));
    await settle();

    expect(assetIssues(state)).toEqual([]);
  });
});
