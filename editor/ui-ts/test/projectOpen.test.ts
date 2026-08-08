/**
 * Открытие проекта (ED-12) и каноническое сохранение (ED-21) — на настоящей
 * сборке приложения (`app/assembly.ts`), а не на её пересказе.
 *
 * Проверяется здесь ровно то, что до W4-1 держалось на вписанном в код пути:
 *
 * - корень спрашивается у среды, а документы ИЩУТСЯ в дереве, причём по
 *   содержимому: пути и имена файлов фикстуры нарочно не совпадают с
 *   соглашением репозитория, и опознание по имени провалилось бы на них;
 * - среда без перечисления (статическая выкладка — см. шапку `src/host/web.ts`)
 *   отказывает с ПРИЧИНОЙ, а не показывает пустой проект;
 * - сохранение пишет только то, в чём есть правки, а отказ доходит до автора
 *   строкой каркаса, а не теряется в обработчике нажатия.
 *
 * DOM и WebGL не нужны: `canRender()` в headless-прогоне ложен, и области
 * собираются без единого обращения к рендеру.
 */
import { createMemoryHost, type MemoryHost } from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { createEditorApp } from '../app/assembly.js';
import { collectTexts, findAll } from '../src/dom/node.js';
import { SHELL_COMMANDS } from '../src/palette/commands.js';
import { ASSETS_AREA_ID, type AssetAreaState } from '../src/areas/assets.js';
import { findAssetNode } from '../src/areas/assetTree.js';
import { VISUALS_OPERATIONS } from '../src/areas/assetVisuals.js';
import { SCENE_AREA_ID, type SceneAreaState } from '../src/areas/scene.js';
import { PREFAB_LIST } from '../src/areas/objectsPrefabs.js';
import { OBJECTS_AREA_ID, type ObjectsAreaState } from '../src/areas/objects.js';
import { SYSTEMS_AREA_ID, type SystemsAreaState } from '../src/areas/systems.js';
import { discoverProject } from '../src/areas/sceneDiscovery.js';
import { attr, zoneOf } from './support/frame.js';
import { FIXTURE_CURVATURE, FIXTURE_SCENE, settle } from './support/project.js';
import type { WorkspaceFrame } from '../src/frame/frame.js';

/**
 * Пути фикстуры нарочно не следуют соглашению репозитория (`scenes/*.scene.json`,
 * `visuals/manifest.json`): опознание по имени файла на них не работает, а
 * значит зелёный тест означает опознание по содержимому.
 */
const CONFIG = 'levels/arena.json';
const VISUALS = 'art/looks.json';
const CURVATURE = 'art/arena.curve.json';

const MANIFEST = {
  entities: { Hero: { model: 'art/models/hero.mdx', scale: 1.6 }, Crate: { model: 'art/models/crate.mdx' } },
  terrain: { curvatureMap: CURVATURE },
};

function projectHost(scene: unknown = FIXTURE_SCENE): MemoryHost {
  return createMemoryHost({
    name: 'project',
    root: { label: 'дерево фикстуры' },
    // Корень отдаёт диалог среды, а не поле хоста: ED-12 требует спросить его,
    // и фикстура обязана позволить проверить, что спросили.
    choices: { root: { label: 'дерево фикстуры' } },
    files: {
      [CONFIG]: JSON.stringify(scene),
      [VISUALS]: JSON.stringify(MANIFEST),
      [CURVATURE]: JSON.stringify(FIXTURE_CURVATURE),
      // Ни сцена, ни манифест: JSON в дереве бывает и не документом проекта.
      'notes/plan.json': JSON.stringify({ note: 'заметка, а не документ проекта' }),
      // Не JSON вовсе — обход до него даже не доходит.
      'notes/plan.md': '# план',
    },
  });
}

/** Хост, у которого перечисления нет: так ведёт себя статическая выкладка (ED-12). */
function hostWithoutListing(reason: string): MemoryHost {
  const host = projectHost();
  const list = (): Promise<never> => Promise.reject(new Error(reason));
  return { ...host, content: { ...host.content, list } };
}

/**
 * Переименовать ОДНУ половину пары ED-19 — prefab конфига, не тронув запись
 * манифеста. Записи `prefabs` отслеживаются (их правит область объектов),
 * поэтому запись адресуется дескриптором, а не индексом (ED-29).
 */
function renameHalfOfPair(frame: WorkspaceFrame): void {
  const { session } = frame;
  session.applyOperation('document.list.setValue', {
    document: CONFIG,
    record: session.descriptors(CONFIG, PREFAB_LIST)[0] ?? '',
    path: ['name'],
    value: 'Villain',
  });
}

/** Строка палитры по её id: команда исполняется тем же путём, что у автора. */
function runCommand(frame: WorkspaceFrame, id: string): void {
  const entry = frame.paletteEntries().find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`команды "${id}" нет в палитре`);
  entry.run();
}

describe('ED-12: проект ищется в дереве, а не берётся по вписанному пути', () => {
  it('корень спрашивается у среды, а документы опознаются по содержимому', async () => {
    const host = projectHost();
    const found = await discoverProject(host);

    expect(found.failure).toBeNull();
    expect(found.root?.label).toBe('дерево фикстуры');
    // Корень взят у хоста среды, а не выведен редактором (ED-12).
    expect(host.choiceRequests.map((request) => request.kind)).toContain('root');
    // Пара найдена, и найдена не по имени файла: имена фикстуры соглашению не
    // следуют вовсе.
    expect(found.scenes).toEqual([{ config: CONFIG, visuals: VISUALS }]);
    expect(found.manifests).toEqual([VISUALS]);
  });

  it('сборка открывает найденное, и открытое — то, что лежит в дереве', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    await settle();

    expect(state.failure).toBeNull();
    expect(state.project?.configId).toBe(CONFIG);
    expect(state.project?.visualsId).toBe(VISUALS);
    // Карта кривизны названа манифестом (ASSET-7), а не найдена обходом:
    // документ, на который ссылается открытый, редактор берёт по ссылке.
    expect(state.project?.curvatureId).toBe(CURVATURE);
  });

  it('сцена без террейна и без prefab-ов — такая же сцена', async () => {
    // Оба поля SER-7 объявляет необязательными: арена без рельефа и сцена, чьи
    // сущности спавнит рантайм, — законные документы. Не найти их значило бы
    // завести в редакторе своё требование к формату, причём молча.
    const bare = { components: [{ name: 'Position', fields: { x: 'fixed' } }] };
    const host = createMemoryHost({
      name: 'bare',
      root: { label: 'дерево без рельефа' },
      files: {
        'levels/flat.json': JSON.stringify(bare),
        [VISUALS]: JSON.stringify(MANIFEST),
      },
    });
    const found = await discoverProject(host);
    expect(found.failure).toBeNull();
    expect(found.scenes).toEqual([{ config: 'levels/flat.json', visuals: VISUALS }]);
  });

  it('дерево без сцены — пустой проект без причины: искать было чем', async () => {
    const host = createMemoryHost({
      name: 'empty',
      root: { label: 'пусто' },
      files: { 'notes/plan.json': JSON.stringify({ note: 'ничего' }) },
    });
    const app = await createEditorApp({ host });
    const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    await settle();

    expect(app.project.failure).toBeNull();
    expect(app.project.scenes).toEqual([]);
    expect(state.project).toBeNull();
    expect(state.failure).toBeNull();
  });
});

describe('ED-12: среда без перечисления отказывает причиной, а не пустым проектом', () => {
  it('обход возвращает причину и ни одной сцены', async () => {
    const reason = 'перечисления в этой сборке нет';
    const found = await discoverProject(hostWithoutListing(reason));
    expect(found.scenes).toEqual([]);
    // «Сцен не найдено» и «искать нечем» — разные утверждения, и второе не
    // выражается пустым списком.
    expect(found.failure).toContain(reason);
  });

  it('причина доходит до автора: область показывает её на поверхности правки', async () => {
    const reason = 'перечисления в этой сборке нет';
    const app = await createEditorApp({ host: hostWithoutListing(reason) });
    const state = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    await settle();

    expect(state.project).toBeNull();
    expect(state.failure).toContain(reason);
    // Показана она иконкой, положением и текстом (ED-8, ED-22), а не только
    // оттенком: находка стоит на элементе с признаком важности.
    const marked = findAll(app.frame.view(), (node) => attr(node, 'data-severity') === 'error');
    expect(marked.length).toBeGreaterThan(0);
    expect(
      marked.flatMap((node) => collectTexts(node)).some((text) => text.value.includes(reason)),
    ).toBe(true);
  });
});

/**
 * Второй проект, появившийся в дереве извне. Лежит в каталоге, который обход
 * встречает раньше остальных, поэтому переоткрытие находит именно его: порядок
 * обхода нормирован, и «первая найденная пара» — это утверждение о дереве, а не
 * о везении.
 */
const ALPHA_CONFIG = 'alpha/level.json';
const ALPHA_VISUALS = 'alpha/looks.json';
const ALPHA_SCENE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [{ name: 'Ghost', tags: ['Ghost'], components: { Position: { x: 0, y: 0 } } }],
};
const ALPHA_MANIFEST = { entities: { Ghost: { model: 'alpha/models/ghost.mdx' } } };

describe('ED-12/ED-24: переоткрытие проекта переоткрывает обе области', () => {
  it('просмотрщик перевязывается на манифест нового проекта и перечитывает дерево', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    const scene = app.frame.stateOf(SCENE_AREA_ID) as SceneAreaState;
    const viewer = app.frame.stateOf(ASSETS_AREA_ID) as AssetAreaState;
    await settle();
    expect(viewer.visualsId).toBe(VISUALS);
    expect(findAssetNode(viewer.tree, ALPHA_CONFIG)).toBeUndefined();

    // Проект появился в дереве извне — ровно тот случай, ради которого
    // переоткрытие идёт в дерево заново (ED-12).
    host.set(ALPHA_CONFIG, JSON.stringify(ALPHA_SCENE));
    host.set(ALPHA_VISUALS, JSON.stringify(ALPHA_MANIFEST));
    runCommand(app.frame, SHELL_COMMANDS.openProject);
    await settle();

    // Обе области открыли ОДИН проект: пара «конфиг + манифест» (ED-19) не
    // распалась на две находки двух обходов.
    expect(scene.project?.configId).toBe(ALPHA_CONFIG);
    expect(scene.project?.visualsId).toBe(ALPHA_VISUALS);
    expect(viewer.visualsId).toBe(ALPHA_VISUALS);
    // Запись выбрана из НОВОГО манифеста: запись прежнего проекта в нём не
    // значит ничего.
    expect(viewer.entry).toBe('Ghost');
    // И дерево перечитано: появившийся извне файл в нём есть (ED-12, ED-20).
    expect(findAssetNode(viewer.tree, ALPHA_CONFIG)).toBeDefined();
  });

  it('правка после переоткрытия уходит в манифест нового проекта (ED-21)', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    app.frame.stateOf(SCENE_AREA_ID);
    const viewer = app.frame.stateOf(ASSETS_AREA_ID) as AssetAreaState;
    await settle();

    host.set(ALPHA_CONFIG, JSON.stringify(ALPHA_SCENE));
    host.set(ALPHA_VISUALS, JSON.stringify(ALPHA_MANIFEST));
    runCommand(app.frame, SHELL_COMMANDS.openProject);
    await settle();

    // Тот же путь, которым пишет кнопка назначения просмотрщика (ED-20, ED-29).
    app.frame.session.applyOperation(VISUALS_OPERATIONS.setModel, {
      document: viewer.visualsId ?? '',
      entry: viewer.entry,
      asset: 'alpha/models/spectre.mdx',
    });
    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();

    // Записано ровно то, что автор правил, и записалось оно: манифест прежнего
    // проекта в группе записи нового не состоит, и правка в нём осталась бы
    // несохранимой парой (ED-19, ED-21).
    expect(app.frame.notice()).toBeNull();
    expect(host.writes).toEqual([ALPHA_VISUALS]);
    expect(JSON.parse(host.text(ALPHA_VISUALS))).toEqual({
      entities: { Ghost: { model: 'alpha/models/spectre.mdx' } },
    });
    // Манифест прежнего проекта не тронут ни правкой, ни записью.
    expect(JSON.parse(host.text(VISUALS))).toEqual(MANIFEST);
  });
});

/**
 * ED-23, ED-25: объекты и системы — РАЗНЫЕ рабочие области, и обе собраны тем
 * же вкладом, что и соседние. Проверяется здесь то, что видно только на
 * настоящей сборке и ни на одной области по отдельности:
 *
 * - конфиг сцены открывается ОДИН раз и сразу со всеми отслеживаемыми списками
 *   проекта (`PROJECT_LISTS`). Дописать список вторым открытием нельзя, поэтому
 *   область, чей список не отследили, не показывает пустой перечень, а называет
 *   причину — и различить одно от другого можно только здесь;
 * - наборы операций обеих областей лежат в том же реестре, что расстановка и
 *   кисти: правка идёт операцией и без интерфейса (ED-29, ED-30);
 * - история одна на сессию (ED-18): правка в одной области отменяется из любой.
 */
describe('ED-23, ED-25: области объектов и систем в собранном редакторе', () => {
  it('обе стоят на том же конфиге, и их списки записей отслежены открытием', async () => {
    const app = await createEditorApp({ host: projectHost() });
    const systems = app.frame.stateOf(SYSTEMS_AREA_ID) as SystemsAreaState;
    const objects = app.frame.stateOf(OBJECTS_AREA_ID) as ObjectsAreaState;
    await settle();

    expect(systems.configId).toBe(CONFIG);
    expect(objects.configId).toBe(CONFIG);
    // Вторая половина пары ED-19 — тот же манифест, что у просмотрщика.
    expect(objects.visualsId).toBe(VISUALS);
    expect(systems.failure).toBeNull();
    expect(objects.failure).toBeNull();
    // То самое, ради чего перечень списков собран в одном месте: отследи
    // открытие только свои — и соседи остались бы без адресуемых записей.
    expect(systems.tracked).toBe(true);
    expect(objects.tracked).toBe(true);
    expect(app.frame.session.document(CONFIG).lists).toEqual([
      ['initial'],
      ['components'],
      ['prefabs'],
      ['systems'],
    ]);
  });

  it('операции обеих областей — в том же реестре, и их правки в одной истории', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    const objects = app.frame.stateOf(OBJECTS_AREA_ID) as ObjectsAreaState;
    await settle();
    const { session } = app.frame;

    // Юнит заводится одним действием и по двум документам сразу (ED-19).
    session.applyOperation('objects.prefab.create', {
      document: CONFIG,
      list: ['prefabs'],
      name: 'Turret',
      visuals: VISUALS,
      model: 'art/models/turret.mdx',
    });
    // Система — в том же реестре и в том же документе (ED-4).
    session.applyOperation('systems.system.create', {
      document: CONFIG,
      list: ['systems'],
      name: 'Regen',
    });

    const config = session.documentValue(CONFIG) as {
      prefabs: readonly { name: string }[];
      systems: readonly { name: string }[];
    };
    expect(config.prefabs.map((prefab) => prefab.name)).toContain('Turret');
    expect(config.systems.map((system) => system.name)).toEqual(['Regen']);
    expect(
      (session.documentValue(VISUALS) as { entities: Record<string, unknown> }).entities['Turret'],
    ).toEqual({ model: 'art/models/turret.mdx' });

    // История одна на сессию (ED-18, ED-23): обе правки снимаются подряд, и
    // снимаются целиком — обе половины пары вместе.
    session.undo();
    session.undo();
    expect(session.documentValue(CONFIG)).toEqual(FIXTURE_SCENE);
    expect(session.documentValue(VISUALS)).toEqual(MANIFEST);
    expect(objects.failure).toBeNull();
  });

  it('переоткрытие переводит обе на документы нового проекта (ED-24)', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    const systems = app.frame.stateOf(SYSTEMS_AREA_ID) as SystemsAreaState;
    const objects = app.frame.stateOf(OBJECTS_AREA_ID) as ObjectsAreaState;
    await settle();

    host.set(ALPHA_CONFIG, JSON.stringify(ALPHA_SCENE));
    host.set(ALPHA_VISUALS, JSON.stringify(ALPHA_MANIFEST));
    runCommand(app.frame, SHELL_COMMANDS.openProject);
    await settle();

    expect(systems.configId).toBe(ALPHA_CONFIG);
    expect(objects.configId).toBe(ALPHA_CONFIG);
    expect(objects.visualsId).toBe(ALPHA_VISUALS);
    // Списки нового документа отслежены так же, как у прежнего: переоткрытие —
    // то же открытие, а не второй его способ (ED-24).
    expect(systems.tracked).toBe(true);
    expect(objects.tracked).toBe(true);
  });
});

describe('ED-21: сохранение трогает только документы с правками', () => {
  it('«открыл — сохранил» без правок не пишет ничего', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    app.frame.stateOf(SCENE_AREA_ID);
    await settle();

    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();
    // Пустой дифф получается не совпадением байтов, а отсутствием записи.
    expect(host.writes).toEqual([]);
  });

  it('правка одного документа уходит на диск одна', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    app.frame.stateOf(SCENE_AREA_ID);
    await settle();

    app.frame.session.applyOperation('document.setValue', {
      document: CONFIG,
      path: ['capacity'],
      value: 32,
    });
    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();

    expect(host.writes).toEqual([CONFIG]);
    expect(JSON.parse(host.text(CONFIG)) as { capacity: number }).toMatchObject({ capacity: 32 });
    // Манифест правок не имел и на диск не уходил — иначе «затрагивает только
    // документы с правками» было бы неправдой.
    expect(JSON.parse(host.text(VISUALS))).toEqual(MANIFEST);
    // Записанное — уже не несохранённое: снаружи окна это видно (ED-21).
    expect(host.windowState.unsaved).toBe(false);
  });

  it('отказ показывается причиной и не пишет ни байта', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    app.frame.stateOf(SCENE_AREA_ID);
    await settle();

    // Переименование prefab'а рвёт пару ED-19 и ссылку расстановки: на диске
    // расхождения не было, вносит его именно это сохранение — ровно тот случай,
    // который ED-21 запрещает записывать. Переименовано оно нарочно ПОЛОВИНОЙ:
    // операция пары (`objects.prefab.rename`) правит обе стороны сразу, и
    // расхождения бы не случилось.
    renameHalfOfPair(app.frame);
    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();

    expect(host.writes).toEqual([]);
    const notice = app.frame.notice();
    expect(notice).not.toBeNull();
    // Текст причины принадлежит правилу и приходит ресурсом (ED-27, ED-30):
    // сборка его не сочиняет.
    expect(notice?.origin).toBe('resource');
    expect(notice?.key).toContain('validation.reason.');
    // И он же виден в баре каркаса, а не только в возвращённом значении.
    expect(
      collectTexts(app.frame.view()).some((text) => text.value === notice?.value),
    ).toBe(true);
    // Строка отказа — про действие, а само нарушение остаётся видимым состоянием
    // документов (ED-8): она погаснет от следующей правки, отчёт валидации — нет.
    const marked = findAll(
      zoneOf(app.frame.view(), 'navigator'),
      (node) => attr(node, 'data-severity') === 'error',
    );
    expect(marked.length).toBeGreaterThan(0);
  });

  it('правка гасит прежнюю причину, а следующее сохранение проходит', async () => {
    const host = projectHost();
    const app = await createEditorApp({ host });
    app.frame.stateOf(SCENE_AREA_ID);
    await settle();

    renameHalfOfPair(app.frame);
    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();
    expect(app.frame.notice()).not.toBeNull();

    // Отмена — правка документов, и прежний отказ перестаёт быть утверждением
    // о настоящем: оставленный на виду, он отправлял бы автора чинить
    // починенное (ED-8).
    app.frame.session.undo();
    expect(app.frame.notice()).toBeNull();

    app.frame.session.applyOperation('document.setValue', {
      document: CONFIG,
      path: ['capacity'],
      value: 32,
    });
    runCommand(app.frame, SHELL_COMMANDS.save);
    await settle();
    expect(app.frame.notice()).toBeNull();
    expect(host.writes).toEqual([CONFIG]);
  });
});
