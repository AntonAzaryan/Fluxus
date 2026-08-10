/**
 * ED-20: просмотрщик presentation-ассетов — навигация по дереву контента,
 * превью моделей ТЕМ ЖЕ рендером, что вьюпорт (ED-1), выбор модели, текстуры и
 * скина для записи манифеста (ED-14) и ассет с отказом, показанный причиной
 * (ASSET-4) и не роняющий просмотрщик.
 *
 * Прогон headless: ни WebGL, ни DOM. Проверяется поэтому не картинка, а то, что
 * от неё зависит и что в картинке потом не разглядеть:
 *
 * - набор, отданный рендеру, — вырожденный случай REND-11 буквально: один
 *   инстанс, `grid === null`, `curvature === null`;
 * - манифест превью переподаётся (REND-17), а не собирается второй сборкой
 *   рендера: подсистемам отдаётся документ целиком;
 * - выбор пишется зарегистрированной операцией (ED-29) и отменяется историей
 *   сессии (ED-18);
 * - отсутствие перечисления у среды названо причиной, а не показано пустым
 *   деревом (ED-12).
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryHost,
  runOperationRoundTrip,
  type EditorSession,
  type MemoryHost,
} from '@game-mvp/editor-core';
import { collectTexts, findAll, type UiNode } from '../src/dom/node.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import {
  ASSETS_VIEWPORT_ID,
  assetStageOptions,
  createAssetArea,
  type AssetAreaState,
} from '../src/areas/assets.js';
import {
  PREVIEW_ENTRY,
  PREVIEW_KEY,
  previewDraft,
  previewEntry,
  previewManifest,
} from '../src/areas/assetPreview.js';
import { createAssetModule } from '../src/areas/assetModule.js';
import { assetKindOf, loadAssetTree } from '../src/areas/assetTree.js';
import { VISUALS_AUTHORING_OPERATIONS, VISUALS_OPERATIONS } from '../src/areas/assetVisuals.js';
import { buildFrame, buttonByKey, press } from './support/frame.js';
import {
  ASSET_IDS,
  ASSET_VISUALS,
  HERO_MODEL,
  assetHost,
  buildAssetFrame,
  fakeAssets,
  hostWithoutListing,
  hostWithoutWatching,
} from './support/assets.js';
import { settle } from './support/project.js';

type Fixture = Awaited<ReturnType<typeof buildAssetFrame>>;

/** Строка дерева по её пути: узлы навигатора адресуются путём (ASSET-2). */
function row(page: UiNode, path: string): UiNode | undefined {
  return findAll(page, (node) => node.attrs?.['data-id'] === path)[0];
}

/** Нажатие по строке — тот же обработчик, каким её выбирает автор. */
function clickRow(fixture: Fixture, path: string): void {
  const found = row(fixture.frame.view(), path);
  if (found === undefined) throw new Error(`в дереве нет строки "${path}"`);
  const handler = found.on?.click;
  if (handler === undefined) throw new Error(`строка "${path}" не выбирается`);
  handler(new Event('click'));
}

/**
 * Выбор файла: сперва раскрываются каталоги по пути к нему. Ровно так до него
 * и добирается автор — дерево показывает раскрытое, а не всё сразу.
 */
function selectRow(fixture: Fixture, path: string): void {
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join('/');
    if (!fixture.state.expanded.has(directory)) clickRow(fixture, directory);
  }
  clickRow(fixture, path);
}

describe('ED-20/REND-11: превью — вырожденный случай документного источника', () => {
  it('кадр просмотрщика поднимается без террейна', () => {
    const options = assetStageOptions(createAssetModule(assetHost()), {
      announce: () => undefined,
    });
    // Ни сцены, ни террейна: REND-11 называет превью «набором из одного
    // инстанса без сцены и террейна», и начинается это с самого кадра.
    expect(options.terrain).toBe(false);
    expect(options.hostId).toBe(ASSETS_VIEWPORT_ID);
    // Манифест кадра пуст до первой переподачи (REND-17): записи собираются в
    // памяти и ассетом не являются.
    expect(Object.keys(options.visuals.entities)).toEqual([]);
  });

  it('набор — ровно один инстанс, без сетки и без кривизны', () => {
    const draft = previewDraft(previewEntry(null, ASSET_IDS.hero));
    expect(draft.grid).toBeNull();
    expect(draft.curvature).toBeNull();
    expect(draft.placements).toHaveLength(1);
    expect(draft.placements[0]?.key).toBe(PREVIEW_KEY);
    expect(draft.placements[0]?.kind).toBe(PREVIEW_ENTRY);
    // Сажать инстанс не на что — визуальной поверхности в этом кадре нет.
    expect(draft.placements[0]?.level).toBe(0);
  });

  it('манифест превью — одна запись с выбранной моделью поверх записи', () => {
    const record = { model: 'visuals/models/old.mdx', defaultSkin: 'blue' };
    const entry = previewEntry(record, ASSET_IDS.hero);
    expect(entry?.model).toBe(ASSET_IDS.hero);
    // Всё остальное записи сохранено: превью показывает ЕЁ, а не голую модель.
    expect(entry?.defaultSkin).toBe('blue');
    expect(Object.keys(previewManifest(entry).entities)).toEqual([PREVIEW_ENTRY]);
    // Документ при этом не тронут: подмена живёт в памяти до назначения (ED-20).
    expect(record.model).toBe('visuals/models/old.mdx');
  });

  it('клип и скин уезжают набором инстансов, а не правкой записи (REND-11)', () => {
    const draft = previewDraft(previewEntry(null, ASSET_IDS.hero), { clip: 'Walk', skin: 'blue' });
    expect(draft.placements[0]?.clip).toBe('Walk');
    expect(draft.placements[0]?.skin).toBe('blue');
    // Не выбран — поля нет вовсе: клип состояния покоя назначает манифест.
    expect(previewDraft(previewEntry(null, ASSET_IDS.hero)).placements[0]?.clip).toBeUndefined();
  });

  it('выбор модели в дереве отдаёт рендеру набор и манифест', async () => {
    const fixture = await buildAssetFrame();
    const before = fixture.stage.submitted.length;
    selectRow(fixture, ASSET_IDS.hero);
    const draft = fixture.stage.last;
    expect(fixture.stage.submitted.length).toBeGreaterThan(before);
    expect(draft?.grid).toBeNull();
    expect(draft?.placements).toHaveLength(1);
    // Тот же рендер, что вьюпорт: подсистеме моделей отдан манифест целиком
    // (REND-17), а инстанс — документным набором (REND-11).
    const manifest = fixture.stage.visuals.at(-1);
    expect(manifest?.entities[PREVIEW_ENTRY]?.model).toBe(ASSET_IDS.hero);
  });

  it('правка манифеста доезжает до кадра переподачей, а не пересборкой', async () => {
    const fixture = await buildAssetFrame();
    const supplied = fixture.stage.visuals.length;
    fixture.session.applyOperation(VISUALS_OPERATIONS.setModel, {
      document: ASSET_IDS.visuals,
      entry: 'Hero',
      asset: ASSET_IDS.broken,
    });
    expect(fixture.stage.visuals.length).toBeGreaterThan(supplied);
    expect(fixture.stage.visuals.at(-1)?.entities[PREVIEW_ENTRY]?.model).toBe(ASSET_IDS.broken);
  });
});

describe('ED-20: ассет с отказом показан причиной и просмотрщик жив', () => {
  it('причина отказа приходит от модуля ассетов и стоит в дереве и в баре', async () => {
    const reason = 'ассет "visuals/models/broken.mdx": не разбирается как MDX';
    const assets = fakeAssets({ [ASSET_IDS.broken]: { status: 'failed', reason } });
    const fixture = await buildAssetFrame({ assets });
    selectRow(fixture, ASSET_IDS.broken);
    const page = fixture.frame.view();
    const texts = collectTexts(page).map((text) => text.value);
    // Причина — та самая, что назвал модуль ассетов (ASSET-4), а не пересказ.
    expect(texts).toContain(reason);
    // И различима она не оттенком: иконка и текст причины стоят вместе (ED-22).
    expect(findAll(page, (node) => node.attrs?.['data-severity'] === 'error').length).toBeGreaterThan(0);
  });

  it('остальные ассеты после отказа открываются как ни в чём не бывало', async () => {
    const assets = fakeAssets({
      [ASSET_IDS.broken]: { status: 'failed', reason: 'не разбирается' },
      [ASSET_IDS.hero]: { status: 'ready', data: HERO_MODEL },
    });
    const fixture = await buildAssetFrame({ assets });
    selectRow(fixture, ASSET_IDS.broken);
    selectRow(fixture, ASSET_IDS.hero);
    expect(fixture.state.probe.stateOf(ASSET_IDS.broken)?.status).toBe('failed');
    expect(fixture.state.probe.stateOf(ASSET_IDS.hero)?.status).toBe('ready');
    // Кадр показывает целую модель, а не остаётся в отказавшем ассете.
    expect(fixture.stage.visuals.at(-1)?.entities[PREVIEW_ENTRY]?.model).toBe(ASSET_IDS.hero);
    // И клипы целой модели доехали до выбора автора (ED-20).
    const options = findAll(fixture.frame.view(), (node) => node.tag === 'option').map(
      (node) => node.attrs?.value,
    );
    expect(options).toContain('Walk');
  });

  it('готовность ассета доезжает подпиской: страница перерисуется сама (ASSET-4)', async () => {
    const assets = fakeAssets();
    const fixture = await buildAssetFrame({ assets });
    selectRow(fixture, ASSET_IDS.hero);
    expect(fixture.state.probe.stateOf(ASSET_IDS.hero)?.status).toBe('loading');
    assets.settle(ASSET_IDS.hero, { status: 'ready', data: HERO_MODEL });
    expect(fixture.state.probe.stateOf(ASSET_IDS.hero)?.status).toBe('ready');
    // Повторный выбор того же ассета второй загрузки не запускает (ASSET-2).
    const requests = assets.requests.length;
    selectRow(fixture, ASSET_IDS.hero);
    expect(assets.requests.length).toBe(requests);
  });
});

/**
 * Свежесть кэша (ASSET-2, ASSET-4) — на НАСТОЯЩЕМ модуле, а не на дубле: дубль
 * не имеет ни кэша, ни источника байтов, и «повторная попытка прочитала файл
 * заново» на нём проверить нечего. Формат взят тот, что разбирается headless, —
 * манифест визуалов (ASSET-6): WebGL и парсеры моделей тут ни при чём.
 */
describe('ASSET-4: починенный ассет загружается заново', () => {
  const ID = 'visuals/looks.json';
  const MANIFEST = JSON.stringify({ entities: {} });

  /** Дерево с одним отсутствующим файлом: первая попытка обязана отказать. */
  const emptyTree = (): MemoryHost =>
    createMemoryHost({ name: 'fresh', root: { label: 'дерево' }, files: {} });

  it('повторная попытка автора читает файл заново, а не отдаёт прежний отказ', async () => {
    // Среда без наблюдения за деревом (ED-12 её прямо допускает): узнать о
    // починке иначе как просьбой автора здесь неоткуда.
    const tree = emptyTree();
    const assets = createAssetModule(hostWithoutWatching(tree));
    const handle = assets.request('manifest', ID);
    await settle();
    expect(assets.state(handle).status).toBe('failed');

    tree.set(ID, MANIFEST);
    // Кэш от появления файла сам не обновился — источник о нём и не сообщал.
    expect(assets.state(handle).status).toBe('failed');

    assets.retry(handle);
    await settle();
    expect(assets.state(handle).status).toBe('ready');
  });

  it('правка в дереве выбрасывает кэш, а не оставляет его старым', async () => {
    const tree = createMemoryHost({
      name: 'watched',
      root: { label: 'дерево' },
      files: { [ID]: 'не json вовсе' },
    });
    const assets = createAssetModule(tree);
    const first = assets.request('manifest', ID);
    await settle();
    expect(assets.state(first).status).toBe('failed');

    const service = assets.service;
    const generation = assets.generation;
    let invalidations = 0;
    assets.onInvalidate(() => {
      invalidations += 1;
    });

    // Правка «извне» — то самое изменение дерева, о котором говорит шов
    // (`HostAssetSource`): держатель сервиса выбрасывает кэш целиком.
    tree.set(ID, MANIFEST);
    expect(invalidations).toBe(1);
    expect(assets.service).not.toBe(service);
    expect(assets.generation).toBeGreaterThan(generation);

    // Тот же ID у того же модуля — и он читает свежие байты.
    const second = assets.request('manifest', ID);
    await settle();
    expect(assets.state(second).status).toBe('ready');
  });

  it('файл, которого модуль не читал, кэша не трогает', async () => {
    const tree = createMemoryHost({
      name: 'watched',
      root: { label: 'дерево' },
      files: { [ID]: MANIFEST },
    });
    const assets = createAssetModule(tree);
    const handle = assets.request('manifest', ID);
    await settle();
    expect(assets.state(handle).status).toBe('ready');

    const service = assets.service;
    // Дерево уведомляет и о записи самого редактора: сохранение сцены не имеет
    // права перезагружать все модели, которых оно не касалось.
    tree.set('levels/arena.json', '{}');
    expect(assets.service).toBe(service);
    // Разделяемый ассет остался тем же — и handle остался действительным
    // (ASSET-2).
    expect(assets.state(handle).status).toBe('ready');
  });
});

describe('ED-20: отказ ассета показан не навсегда', () => {
  it('автор просит попробовать снова — и просмотрщик показывает загруженное', async () => {
    const reason = 'ассет "visuals/models/broken.mdx": не разбирается как MDX';
    const assets = fakeAssets({ [ASSET_IDS.broken]: { status: 'failed', reason } });
    const fixture = await buildAssetFrame({ assets });
    selectRow(fixture, ASSET_IDS.broken);
    expect(fixture.state.probe.stateOf(ASSET_IDS.broken)?.status).toBe('failed');

    // Автор починил файл в дереве: следующая попытка кончится иначе (ASSET-4).
    assets.onRetry(ASSET_IDS.broken, { status: 'ready', data: HERO_MODEL });
    press(buttonByKey(fixture.frame.view(), 'ui.area.assets.retry'));

    expect(assets.retries).toEqual([ASSET_IDS.broken]);
    expect(fixture.state.probe.stateOf(ASSET_IDS.broken)?.status).toBe('ready');
    // Причина ушла со страницы вместе с отказом — она была утверждением о том,
    // чего уже нет (ED-8).
    expect(collectTexts(fixture.frame.view()).map((text) => text.value)).not.toContain(reason);
  });

  it('повторять нечего — кнопка показана недоступной, а не молчит (ED-26)', async () => {
    const assets = fakeAssets({ [ASSET_IDS.hero]: { status: 'ready', data: HERO_MODEL } });
    const fixture = await buildAssetFrame({ assets });
    const disabled = (): string | undefined =>
      buttonByKey(fixture.frame.view(), 'ui.area.assets.retry')?.attrs?.['aria-disabled'];
    // Ничего не выбрано — повторять нечего.
    expect(disabled()).toBe('true');
    selectRow(fixture, ASSET_IDS.hero);
    // Загруженное второй попытки не требует.
    expect(disabled()).toBe('true');
  });

  it('выброшенный кэш переоткрывает то, что просмотрщик уже показывал (ASSET-2)', async () => {
    const assets = fakeAssets({ [ASSET_IDS.hero]: { status: 'failed', reason: 'не читается' } });
    const fixture = await buildAssetFrame({ assets });
    selectRow(fixture, ASSET_IDS.hero);
    expect(fixture.state.probe.stateOf(ASSET_IDS.hero)?.status).toBe('failed');
    const requests = assets.requests.length;

    // Дерево изменилось извне, держатель сервиса выбросил кэш: прежние хэндлы
    // ему больше не принадлежат, и держаться за прежнее состояние значило бы
    // показывать ответ, которого никто уже не даёт.
    assets.settle(ASSET_IDS.hero, { status: 'ready', data: HERO_MODEL });
    assets.invalidate();

    expect(assets.requests.length).toBeGreaterThan(requests);
    expect(fixture.state.probe.stateOf(ASSET_IDS.hero)?.status).toBe('ready');
  });
});

describe('ED-20/ED-29: выбор пишется операцией и отменяется', () => {
  it('выбор модели кладёт в запись манифеста ID ассета', async () => {
    const assets = fakeAssets({ [ASSET_IDS.hero]: { status: 'ready', data: HERO_MODEL } });
    const fixture = await buildAssetFrame({ assets });
    const model = (): unknown =>
      (
        (fixture.session.documentValue(ASSET_IDS.visuals) as { entities: Record<string, { model: string }> })
          .entities.Hero
      )?.model;

    selectRow(fixture, ASSET_IDS.hero);
    // Запись выбрана первой же — назначать есть куда, и путь руками не вводится.
    expect(fixture.state.entry).toBe('Hero');
    fixture.session.applyOperation(VISUALS_OPERATIONS.setModel, {
      document: ASSET_IDS.visuals,
      entry: 'Hero',
      asset: ASSET_IDS.broken,
    });
    expect(model()).toBe(ASSET_IDS.broken);

    press(buttonByKey(fixture.frame.view(), 'ui.area.assets.assignModel'));
    expect(model()).toBe(ASSET_IDS.hero);
    // История одна на сессию (ED-18, ED-23): отмена возвращает прежний ID.
    expect(fixture.frame.canUndo()).toBe(true);
    fixture.frame.undo();
    expect(model()).toBe(ASSET_IDS.broken);
    fixture.frame.redo();
    expect(model()).toBe(ASSET_IDS.hero);
  });

  it('операция — единственный путь: она же исполнима без интерфейса (ED-29)', () => {
    const { session } = buildFrame([createAssetArea()]);
    session.openDocument({
      id: ASSET_IDS.visuals,
      kind: 'visuals',
      value: { entities: { Hero: { model: 'visuals/models/old.mdx' } } },
    });
    session.applyOperation(VISUALS_OPERATIONS.setSkinTexture, {
      document: ASSET_IDS.visuals,
      entry: 'Hero',
      skin: 'red',
      slot: '0',
      asset: ASSET_IDS.skin,
    });
    const entities = (
      session.documentValue(ASSET_IDS.visuals) as {
        entities: Record<string, { skins?: Record<string, Record<string, string>> }>;
      }
    ).entities;
    expect(entities.Hero?.skins?.red?.['0']).toBe(ASSET_IDS.skin);
    // Скин, которого нет, скином по умолчанию не становится: подменять нечего.
    expect(() =>
      session.applyOperation(VISUALS_OPERATIONS.setDefaultSkin, {
        document: ASSET_IDS.visuals,
        entry: 'Hero',
        skin: 'green',
      }),
    ).toThrow(/green/);
    // Записи операция не заводит: пара «prefab + запись» (ED-19) не собирается
    // побочным эффектом выбора модели.
    expect(() =>
      session.applyOperation(VISUALS_OPERATIONS.setModel, {
        document: ASSET_IDS.visuals,
        entry: 'Missing',
        asset: ASSET_IDS.hero,
      }),
    ).toThrow(/Missing/);
    // ID ассета — путь от корня дерева контента (ASSET-2), а не что попало.
    expect(() =>
      session.applyOperation(VISUALS_OPERATIONS.setModel, {
        document: ASSET_IDS.visuals,
        entry: 'Hero',
        asset: 'https://example.com/hero.mdx',
      }),
    ).toThrow(/ASSET-2/);
  });

  it('назначать нечего — кнопка показана недоступной, а не молчит (ED-26)', async () => {
    const fixture = await buildAssetFrame();
    const disabled = (key: string): string | undefined =>
      buttonByKey(fixture.frame.view(), key)?.attrs?.['aria-disabled'];
    // Ассет не выбран: назначать нечего ни моделью, ни текстурой.
    expect(disabled('ui.area.assets.assignModel')).toBe('true');
    expect(disabled('ui.area.assets.assignTexture')).toBe('true');
    selectRow(fixture, ASSET_IDS.hero);
    expect(disabled('ui.area.assets.assignModel')).toBe('false');
    // Текстурой модель не назначается — вид ассета решает, а не кнопка.
    expect(disabled('ui.area.assets.assignTexture')).toBe('true');
  });
});

describe('ED-29: каждая операция записи манифеста обратима', () => {
  /** Сессия с открытым манифестом-фикстурой и тем же реестром, что у приложения. */
  const scratch = (): EditorSession => {
    const { session } = buildFrame([createAssetArea()]);
    session.openDocument({
      id: ASSET_IDS.visuals,
      kind: 'visuals',
      value: ASSET_VISUALS,
    });
    return session;
  };

  it.each([
    [VISUALS_OPERATIONS.setModel, { asset: ASSET_IDS.broken }],
    [VISUALS_OPERATIONS.setDefaultSkin, { skin: 'blue' }],
    [VISUALS_OPERATIONS.setSkinTexture, { skin: 'red', slot: '1', asset: ASSET_IDS.skin }],
  ])('«применить, отменить, сравнить» проходит для %s', (operationId, params) => {
    const result = runOperationRoundTrip(scratch(), operationId, {
      document: ASSET_IDS.visuals,
      entry: 'Hero',
      ...params,
    });
    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });

  it('в наборе ровно три операции — по одной на назначение ED-20', () => {
    expect(VISUALS_AUTHORING_OPERATIONS.map((operation) => operation.id)).toEqual([
      VISUALS_OPERATIONS.setModel,
      VISUALS_OPERATIONS.setDefaultSkin,
      VISUALS_OPERATIONS.setSkinTexture,
    ]);
  });
});

describe('ED-1: правила формата спрашиваются у модуля ассетов', () => {
  const opened = (): EditorSession => {
    const { session } = buildFrame([createAssetArea()]);
    session.openDocument({
      id: ASSET_IDS.visuals,
      kind: 'visuals',
      value: ASSET_VISUALS,
    });
    return session;
  };

  const skinsOf = (session: EditorSession): Record<string, unknown> | undefined =>
    (
      session.documentValue(ASSET_IDS.visuals) as {
        entities: Record<string, { skins?: Record<string, unknown> }>;
      }
    ).entities.Hero?.skins;

  it('номер слота отвергает валидатор манифеста, а не копия его правила', () => {
    const session = opened();
    // Причина — словами владельца правила (ASSET-5, REND-6): своей копии этой
    // проверки у операции нет, и разойтись с ней ей нечем (CORE-3).
    expect(() =>
      session.applyOperation(VISUALS_OPERATIONS.setSkinTexture, {
        document: ASSET_IDS.visuals,
        entry: 'Hero',
        skin: 'red',
        slot: 'diffuse',
        asset: ASSET_IDS.skin,
      }),
    ).toThrow(/textureSlot/);
    // Отказ не оставил полуправки: скина, который заводила упавшая операция, нет.
    expect(skinsOf(session)?.red).toBeUndefined();
  });

  it('скин по умолчанию сверяет с подменами тот же валидатор', () => {
    const session = opened();
    expect(() =>
      session.applyOperation(VISUALS_OPERATIONS.setDefaultSkin, {
        document: ASSET_IDS.visuals,
        entry: 'Hero',
        skin: 'green',
      }),
    ).toThrow(/не описан в entities\.Hero\.skins/);
  });

  it('нарушение, бывшее в записи до операции, чужой правке не мешает', () => {
    // Отказ операции — за то, что сломала она (ED-30). Иначе сломанную кем-то
    // запись нельзя было бы починить выбором модели из просмотрщика (ED-20).
    const { session } = buildFrame([createAssetArea()]);
    session.openDocument({
      id: ASSET_IDS.visuals,
      kind: 'visuals',
      // `defaultSkin` без единой подмены — нарушение ASSET-6, уже лежащее в документе.
      value: { entities: { Hero: { model: ASSET_IDS.hero, defaultSkin: 'blue' } } },
    });
    session.applyOperation(VISUALS_OPERATIONS.setModel, {
      document: ASSET_IDS.visuals,
      entry: 'Hero',
      asset: ASSET_IDS.broken,
    });
    const entities = (
      session.documentValue(ASSET_IDS.visuals) as { entities: Record<string, { model: string }> }
    ).entities;
    expect(entities.Hero?.model).toBe(ASSET_IDS.broken);
  });
});

describe('ED-12/ED-20: дерево контента и его честные границы', () => {
  it('обход даёт дерево, а вид ассета — сами загрузчики (ASSET-3)', async () => {
    const host = assetHost();
    const tree = await loadAssetTree(host.content);
    expect(tree.failure).toBeNull();
    const names = tree.nodes.map((node) => node.name);
    expect(names).toContain('visuals');
    expect(assetKindOf(ASSET_IDS.hero)).toBe('model');
    expect(assetKindOf(ASSET_IDS.skin)).toBe('texture');
    // Формат без загрузчика в дереве виден — ED-20 требует дерева, а не
    // перечня моделей, — но открыть его нечем.
    expect(assetKindOf('visuals/notes.txt')).toBeNull();
  });

  it('перечисления в среде нет — названа причина, а не пустое дерево', async () => {
    const reason = 'дерево контента: "" — HTTP 404; похоже, эта среда перечисления не предоставляет';
    const fixture = await buildAssetFrame({ host: hostWithoutListing(reason) });
    expect(fixture.state.tree.failure).toBe(reason);
    expect(fixture.state.tree.nodes).toEqual([]);
    const texts = collectTexts(fixture.frame.view()).map((text) => text.value);
    // Причина видна автору целиком: «ассетов нет» и «перечислить нечем» —
    // разные утверждения, и второе он обязан прочитать (ED-12).
    expect(texts).toContain(reason);
    expect(texts).toContain(uiResources('ru').text('ui.area.assets.noListing'));
    // И не сказано вторым сообщением, что ассетов нет: это другое утверждение.
    expect(texts).not.toContain(uiResources('ru').text('ui.area.assets.emptyTree'));
  });
});

describe('ED-27: причину, которой у модуля ассетов нет, называет ресурс', () => {
  it('среда без превью — отказ без прозы в коде', async () => {
    // Ни WebGL, ни дубля: сервиса ассетов у просмотрщика нет вовсе, и сказать
    // что-либо о загрузке некому. Утверждение об этом — интерфейса, значит из
    // ресурсов (ED-27), а не литералом рядом с местом показа.
    const area = createAssetArea({ host: assetHost(), visuals: ASSET_IDS.visuals });
    const fixture = buildFrame([area], 'ru');
    const state = fixture.frame.stateOf(area.id) as AssetAreaState;
    await settle();
    const opened = state.probe.open('model', ASSET_IDS.hero);
    expect(opened.status).toBe('failed');
    expect(opened.reason).toBeNull();

    state.selected = ASSET_IDS.hero;
    const texts = collectTexts(fixture.frame.view()).map((text) => text.value);
    expect(texts).toContain(uiResources('ru').text('ui.area.assets.noAssets'));
  });
});

describe('ED-27: строки просмотрщика приходят из ресурсов', () => {
  it.each(['ru', 'en'])('на локали %s каждый ключ области разрешается', async (locale) => {
    const fixture = await buildAssetFrame({ locale });
    const resources = uiResources(locale);
    fixture.state.selected = ASSET_IDS.hero;
    for (const text of collectTexts(fixture.frame.view())) {
      if (text.origin !== 'resource') continue;
      expect(resources.lookup(text.key ?? ''), `не разрешился: ${text.key ?? ''}`).toBeDefined();
    }
  });

  it('ключи описаний вклада разрешаются: каталог ED-30 читает те же строки', () => {
    const resources = uiResources('en');
    const area = createAssetArea();
    expect(resources.lookup(area.descriptionKey)).toBeDefined();
    expect(resources.lookup(area.labelKey)).toBeDefined();
    for (const editable of area.editableTypes) {
      expect(resources.lookup(editable.descriptionKey)).toBeDefined();
    }
  });

  it.each(['ru', 'en'])(
    'на локали %s описания операций и их параметров разрешаются (ED-28, ED-30)',
    (locale) => {
      // Текст каталога и текст интерфейса — один и тот же (ED-30), поэтому
      // ключ без строки означает пустое описание в обоих сразу.
      const resources = uiResources(locale);
      for (const operation of VISUALS_AUTHORING_OPERATIONS) {
        expect(resources.lookup(operation.descriptionKey), operation.id).toBeDefined();
        for (const [name, spec] of Object.entries(operation.params)) {
          expect(resources.lookup(spec.descriptionKey), `${operation.id}: ${name}`).toBeDefined();
        }
      }
    },
  );
});
