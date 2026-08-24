/**
 * Вклады конвейера Blender в СОБРАННОМ редакторе (`blender-pipeline` BLND-5,
 * BLND-2) — на настоящей сборке приложения (`app/assembly.ts`), а не на вызове
 * правила руками.
 *
 * Тесты самого правила и самой операции живут в пакете конвейера
 * (`tools/blender-ts/test/`), и повторять их здесь незачем. Здесь проверяется
 * ровно то, чего они не видят и видеть не могут, — что вклады ЗАРЕГИСТРИРОВАНЫ:
 *
 * - BLND-5: «импорт запускают командой workspace и операцией из работающего
 *   редактора — оба пути исполняют одну и ту же зарегистрированную операцию», и
 *   в машинном каталоге (ED-30) операция одна. Незарегистрированная в сборке,
 *   она была бы видна командной строке и не видна редактору;
 * - BLND-2: «правка производных данных мимо импорта SHALL подсвечиваться
 *   валидацией редактора на общих основаниях (ED-8) правилом-вкладом (ED-25)» —
 *   то есть находка обязана появляться в ОТЧЁТЕ ОБЛАСТИ, который собирает
 *   прогон редактора, а не в результате прямого вызова `check`;
 * - ED-27: причина находки и описание операции приходят строкой бандла вклада,
 *   а не голым ключом: бандл вливается в ресурсы там же, где регистрируются
 *   вклады.
 *
 * Источник здесь — текстовый glTF: рукописная фикстура читается в ревью,
 * бинарная нет, а форматом BLND-3 называет glTF 2.0, а не контейнер. Blender не
 * зовётся ни в какой форме (BLND-7).
 */
import { createMemoryHost, type MemoryHost } from '@fluxus/editor-core';
import { IMPORT_SPATIAL_LAYER, SPATIAL_LAYER_SYNC_RULE } from '@fluxus/blender-ts';
import { describe, expect, it } from 'vitest';
import { createEditorApp } from '../app/assembly.js';
import { findAll, issueText } from '../src/dom/node.js';
import { SCENE_AREA_ID, type SceneAreaState } from '../src/areas/scene.js';
import { attr, zoneOf } from './support/frame.js';
import { settle } from './support/project.js';

const CONFIG = 'levels/arena.json';
const VISUALS = 'art/looks.json';
/** Экспорт источника парен сцене по имени (BLND-2), а не по ссылке. */
const SOURCE = 'levels/arena.gltf';

const MANIFEST = {
  entities: {
    Hero: { model: 'art/models/hero.mdx' },
    Crate: { model: 'art/models/crate.mdx' },
  },
};

/**
 * Источник: два сим-размещения. Соответствие осей — конвенция конвейера
 * (BLND-3, `CONVENTIONS.md`): мировые `(x, y)` ← glTF `(x, −z)`. Координаты
 * целые нарочно — тогда Q16.16 читается глазом (1 → 65536), и ожидание ниже не
 * повторяет квантование второй реализацией.
 */
const SOURCE_GLTF = JSON.stringify({
  asset: { version: '2.0', generator: 'рукописная фикстура конвейера (BLND-7)' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    { name: 'a-hero', translation: [1, 0, -2], extras: { prefab: 'Hero' } },
    { name: 'b-crate', translation: [3, 0, -1], extras: { prefab: 'Crate' } },
  ],
});

/** Тот же источник, но герой сдвинут: правка `.blend` без пере-импорта. */
const MOVED_GLTF = JSON.stringify({
  asset: { version: '2.0', generator: 'рукописная фикстура конвейера (BLND-7)' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    { name: 'a-hero', translation: [7, 0, -2], extras: { prefab: 'Hero' } },
    { name: 'b-crate', translation: [3, 0, -1], extras: { prefab: 'Crate' } },
  ],
});

const FIXED = 65536;

/** Расстановка, которую даёт импорт этого источника: порядок — по имени объекта (BLND-4). */
const SYNCED_INITIAL = [
  { prefab: 'Hero', overrides: { Position: { x: 1 * FIXED, y: 2 * FIXED } } },
  { prefab: 'Crate', overrides: { Position: { x: 3 * FIXED, y: 1 * FIXED } } },
];

/** Она же с подвинутым в РЕДАКТОРЕ героем: запись законна, импорт её перезапишет. */
const EDITED_INITIAL = [
  { prefab: 'Hero', overrides: { Position: { x: 5 * FIXED, y: 2 * FIXED } } },
  { prefab: 'Crate', overrides: { Position: { x: 3 * FIXED, y: 1 * FIXED } } },
];

function scene(initial: readonly unknown[]): Record<string, unknown> {
  return {
    components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
    prefabs: [
      { name: 'Hero', tags: ['Hero'], components: { Position: { x: 0, y: 0 } } },
      { name: 'Crate', tags: ['Crate'], components: { Position: { x: 0, y: 0 } } },
    ],
    initial: [...initial],
    capacity: 16,
  };
}

/**
 * Дерево проекта. Источник кладётся рядом со сценой по правилу имени — ссылок
 * между ним и документами нет ни в одну сторону (BLND-2).
 */
function projectHost(
  initial: readonly unknown[] = SYNCED_INITIAL,
  source: string | null = SOURCE_GLTF,
): MemoryHost {
  return createMemoryHost({
    name: 'project',
    root: { label: 'дерево фикстуры' },
    choices: { root: { label: 'дерево фикстуры' } },
    files: {
      [CONFIG]: JSON.stringify(scene(initial)),
      [VISUALS]: JSON.stringify(MANIFEST),
      ...(source === null ? {} : { [SOURCE]: source }),
    },
  });
}

interface Opened {
  readonly host: MemoryHost;
  readonly app: Awaited<ReturnType<typeof createEditorApp>>;
  readonly state: SceneAreaState;
}

async function opened(
  initial: readonly unknown[] = SYNCED_INITIAL,
  source: string | null = SOURCE_GLTF,
): Promise<Opened> {
  const host = projectHost(initial, source);
  const app = await createEditorApp({ host });
  const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
  await settle();
  return { host, app, state };
}

/** Находки правила синхронизации в отчёте ОБЛАСТИ — то есть в прогоне редактора. */
const syncIssues = (state: SceneAreaState) =>
  (state.report?.issues ?? []).filter((issue) => issue.ruleId === SPATIAL_LAYER_SYNC_RULE);

describe('BLND-2: правка производного слоя подсвечена валидацией собранного редактора', () => {
  it('расхождение с источником — предупреждение с адресом записи в отчёте области', async () => {
    const { state } = await opened(EDITED_INITIAL);

    const issues = syncIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.documentId).toBe(CONFIG);
    expect(issues[0]!.path).toEqual(['initial', 0]);
    expect(issues[0]!.expected).toEqual({ kind: 'oneOf', values: [SYNCED_INITIAL[0]] });
  });

  it('слой, совпадающий с источником, находок не даёт', async () => {
    const { state } = await opened();

    expect(syncIssues(state)).toEqual([]);
    // И это молчание — не «правило не сработало»: правило в реестре есть и на
    // документ сцены встало (проверка каталога ниже), а расхождения нет.
    expect(state.report).not.toBeNull();
  });

  it('сцена без источника молчит: конвейер к ней отношения не имеет', async () => {
    const { state } = await opened(EDITED_INITIAL, null);

    // Ни расхождения, ни «источник не читан»: кэш обновлён открытием проекта, и
    // ответ у него определённый — источника нет.
    expect(syncIssues(state)).toEqual([]);
  });

  it('находка видна на странице причиной из бандла вклада, а не ключом (ED-27)', async () => {
    const { app, state } = await opened(EDITED_INITIAL);
    const issue = syncIssues(state)[0];
    expect(issue).toBeDefined();

    // Причину показывает та же поверхность, что и прочие находки (ED-8, ED-22):
    // навигатор помечает запись важностью.
    const marked = findAll(
      zoneOf(app.frame.view(), 'navigator'),
      (node) => attr(node, 'data-severity') === 'warning',
    );
    expect(marked.length).toBeGreaterThan(0);

    // Строка приходит из бандла конвейера: не разрешись она, автор увидел бы
    // голый ключ, а бандл — второй набор формулировок в пакете редактора.
    const resolved = app.resources.lookup(issue!.reasonKey);
    expect(resolved, issue!.reasonKey).toBeDefined();
    expect(resolved?.text).toContain('BLND-2');
  });
});

describe('BLND-5: операция импорта зарегистрирована сборкой и видна каталогом (ED-30)', () => {
  it('реестр операций сессии знает её — тем же id, которым её зовёт командная строка', async () => {
    const { app } = await opened();

    expect(app.frame.session.operations.has(IMPORT_SPATIAL_LAYER)).toBe(true);
  });

  it('она есть в палитре — представлении того же каталога — и подписана строкой бандла', async () => {
    const { app } = await opened();

    const entry = app.frame
      .paletteEntries()
      .find((candidate) => candidate.kind === 'operation' && candidate.id === IMPORT_SPATIAL_LAYER);
    expect(entry).toBeDefined();
    // Подпись — описание операции из каталога (ED-30) на локали автора. Ключ
    // вместо текста означал бы, что бандл вклада в ресурсы не влит.
    expect(entry?.label.origin).toBe('resource');
    expect(entry?.label.value).not.toBe(entry?.label.key);
    expect(entry?.label.value).toContain('BLND-2');
  });

  it('правило синхронизации — такой же вклад того же реестра', async () => {
    const { state } = await opened(EDITED_INITIAL);

    // Отчёт собран прогоном области поверх ОБЩЕГО реестра правил сборки: если
    // бы правило туда не попало, область прогнала бы только свои.
    expect(syncIssues(state)).toHaveLength(1);
  });
});

describe('BLND-12: правка источника в дереве переподнимает находку без правки документа', () => {
  it('пере-экспорт мимо импорта делает расхождение видимым', async () => {
    const { host, state } = await opened();
    expect(syncIssues(state)).toEqual([]);

    // Автор подвинул объект в Blender и сохранил: экспорт обновился, импорт не
    // запускался. Правки документов при этом нет вовсе — и без явного
    // пере-прогона отчёт остался бы утверждением о прошлом.
    host.set(SOURCE, MOVED_GLTF);
    await settle();

    const issues = syncIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['initial', 0]);
  });

  it('исчезнувшее расхождение гаснет тем же путём', async () => {
    const { host, state } = await opened(EDITED_INITIAL);
    expect(syncIssues(state)).toHaveLength(1);

    // Источник привели к тому, что лежит в документах: находке больше не о чем.
    host.set(
      SOURCE,
      JSON.stringify({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { name: 'a-hero', translation: [5, 0, -2], extras: { prefab: 'Hero' } },
          { name: 'b-crate', translation: [3, 0, -1], extras: { prefab: 'Crate' } },
        ],
      }),
    );
    await settle();

    expect(syncIssues(state)).toEqual([]);
  });
});

describe('ED-12: среда, не прочитавшая источник, отвечает причиной, а не молчанием', () => {
  it('отказ чтения дерева виден находкой с причиной дословно', async () => {
    const base = projectHost(SYNCED_INITIAL);
    const reason = 'эта среда двоичных файлов дерева не читает';
    const host: MemoryHost = {
      ...base,
      content: {
        ...base.content,
        read: (path: string) =>
          path === SOURCE ? Promise.reject(new Error(reason)) : base.content.read(path),
      },
    };
    const app = await createEditorApp({ host });
    const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    await settle();

    const issues = syncIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reasonKey).toContain('sourceUnreadable');
    expect(issues[0]!.reasonParams.reason).toContain(reason);
    // Причина доходит до автора текстом, с подставленным параметром: «прочитать
    // не удалось» и «расхождения нет» обязаны различаться на странице, а не
    // только в коде находки.
    expect(issueText(app.resources, issues[0]!).value).toContain(reason);
  });
});
