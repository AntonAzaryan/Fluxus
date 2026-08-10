/**
 * Область сцены как вклад (ED-25) и её три зоны (ED-24) поверх настоящих
 * документов: навигатор показывает то, что открыто, поверхность — кадр
 * вьюпорта (ED-15), инспектор — поля выбранного.
 *
 * Главное, что здесь пиннится, — цепочка ED-15: правка документа операцией
 * авторинга (ED-29) доходит до вьюпорта сама, без перерисовки страницы и без
 * прогона симуляции. Вьюпорт подставлен структурным дублём: проверяется, ЧТО
 * ему отдано, а не как оно нарисовано (WebGL в прогоне нет).
 */
import { describe, expect, it } from 'vitest';
import { findAll, hasClass, type UiNode } from '../src/dom/node.js';
import { VIEWPORT_CLASS } from '../src/tokens/stylesheet.js';
import { SCENE_NODES, SCENE_VIEWPORT_ID, sceneArea } from '../src/areas/scene.js';
import { canRender, signalsChanged, type StageSignals } from '../src/areas/sceneStage.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { PREFAB_LIST } from '../src/areas/objectsPrefabs.js';
import { VISUALS_OPERATIONS } from '../src/areas/assetVisuals.js';
import { attr, buildFrame, buildLoadedFrame, buttonByKey, press, zoneOf } from './support/frame.js';
import { FIXTURE_IDS, settle } from './support/project.js';

describe('ED-15: вьюпорт показывает документы, а не фикстуру интерфейса', () => {
  it('открытые документы сцены попадают в сессию через хост среды', async () => {
    const { session, host } = await buildLoadedFrame();
    expect(session.isOpen(FIXTURE_IDS.config)).toBe(true);
    expect(session.isOpen(FIXTURE_IDS.visuals)).toBe(true);
    // Ни одной записи в дерево контента открытие не сделало (ED-21, CONT-1).
    expect(host.writes).toEqual([]);
  });

  it('первый же кадр получает сетку, кривизну и набор инстансов', async () => {
    const { stage, state } = await buildLoadedFrame();
    const draft = stage.last;
    expect(draft?.grid?.width).toBe(4);
    expect(draft?.curvature?.width).toBe(4);
    // Вьюпорту отдан ТОТ САМЫЙ кадр области, поэтому имена префабов читаются с
    // него: вьюпорту они не видны вовсе — его вход шире кадра сцены (REND-11).
    expect(state.draft).toBe(draft);
    expect(state.draft?.placements.map((item) => item.prefab)).toEqual(['Hero', 'Crate']);
  });

  it('правка документа даёт вьюпорту новый набор — сама, без перерисовки страницы', async () => {
    const { session, stage, state } = await buildLoadedFrame();
    const before = stage.submitted.length;
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0];

    // Prefab'ы конфига — тоже отслеживаемый список (их правит область объектов),
    // поэтому запись адресуется дескриптором, а не индексом (ED-29).
    session.applyOperation('document.list.setValue', {
      document: FIXTURE_IDS.config,
      record: session.descriptors(FIXTURE_IDS.config, PREFAB_LIST)[0] ?? '',
      path: ['components', 'Position', 'x'],
      value: 262144,
    });
    await settle();

    expect(stage.submitted.length).toBeGreaterThan(before);
    expect(stage.last?.placements[0]?.x).toBeCloseTo(4, 6);
    // Ключ тот же — инстанс обновится, а не пересоздастся (REND-11).
    expect(stage.last?.placements[0]?.key).toBe(key);
    expect(state.draft).toBe(stage.last);
  });

  it('правка карты уровней доезжает до вьюпорта новой сеткой (ED-10, REND-14)', async () => {
    const { session, stage } = await buildLoadedFrame();
    const before = stage.last?.grid;
    session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: ['terrain', 'levels', 0],
      value: '1111',
    });
    await settle();
    expect(stage.last?.grid).not.toBe(before);
    expect(stage.last?.grid?.levels[0]).toBe(1);
  });

  it('отмена операции возвращает прежний набор — обратного проигрывания не требуется (ED-18)', async () => {
    const { session, stage } = await buildLoadedFrame();
    const before = stage.last?.placements[0]?.x;
    session.applyOperation('document.list.setValue', {
      document: FIXTURE_IDS.config,
      record: session.descriptors(FIXTURE_IDS.config, PREFAB_LIST)[0] ?? '',
      path: ['components', 'Position', 'x'],
      value: 262144,
    });
    await settle();
    session.undo();
    await settle();
    expect(stage.last?.placements[0]?.x).toBeCloseTo(before ?? -1, 6);
  });

  it('модель, назначенная в записи манифеста, доезжает до вьюпорта переподачей', async () => {
    // ED-14 отдаёт манифест редактору, ED-15 требует показать его правку не
    // позже следующего кадра, REND-17 говорит чем: манифест отдаётся целиком, а
    // сводит поданное с нарисованным подсистема. Переоткрытия проекта здесь нет
    // и быть не должно — оно потеряло бы позу камеры (ED-23).
    const { session, stage } = await buildLoadedFrame();
    const supplied = stage.visuals.length;
    const built = stage.submitted.length;

    session.applyOperation(VISUALS_OPERATIONS.setModel, {
      document: FIXTURE_IDS.visuals,
      entry: 'Hero',
      asset: 'visuals/models/champion.mdx',
    });
    await settle();

    expect(stage.visuals.length).toBeGreaterThan(supplied);
    expect(stage.visuals.at(-1)?.entities.Hero?.model).toBe('visuals/models/champion.mdx');
    // Инстансы при этом подаются по-прежнему набором (REND-11): решение о том,
    // что пересобрать, остаётся у подсистемы, а не размазывается по редактору.
    expect(stage.submitted.length).toBeGreaterThan(built);
  });

  it('запись, заведённая в манифесте, меняет набор инстансов сцены', async () => {
    // Визуальный тип инстанса — производная манифеста (ASSET-6, REND-11): пока
    // записи нет, размещённое рисуется заглушкой. Снимок манифеста, снятый при
    // открытии, оставил бы её заглушкой до перезапуска редактора.
    const { session, stage } = await buildLoadedFrame();
    expect(stage.last?.placements.map((item) => item.kind)).toEqual(['Hero', null]);

    session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.visuals,
      path: ['entities', 'Crate'],
      value: { model: 'visuals/models/crate.mdx' },
    });
    await settle();

    expect(stage.last?.placements.map((item) => item.kind)).toEqual(['Hero', 'Crate']);
    expect(Object.keys(stage.visuals.at(-1)?.entities ?? {})).toEqual(['Hero', 'Crate']);
  });

  it('сломанный манифест не гасит кадр и не переподаётся (ED-8)', async () => {
    const { session, stage, state } = await buildLoadedFrame();
    const supplied = stage.visuals.length;
    session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.visuals,
      path: ['entities', 'Hero', 'model'],
      value: 17,
    });
    await settle();

    // Причина названа, прежний манифест остался у подсистемы: показать автору
    // пустой кадр вместо причины — худшее из двух (ED-8, ED-15).
    expect(state.draft?.failure).toContain('манифест');
    expect(stage.visuals.length).toBe(supplied);
  });

  it('выделение и открытие соседнего документа кадр не пересобирают', async () => {
    const { frame, stage, area } = await buildLoadedFrame();
    const before = stage.submitted.length;
    frame.selection.set(area.id, [FIXTURE_IDS.visuals]);
    frame.view();
    await settle();
    expect(stage.submitted.length).toBe(before);
  });
});

describe('ED-24: три зоны области наполнены документами', () => {
  it('навигатор показывает документы сцены и её расстановку', async () => {
    const { frame, session } = await buildLoadedFrame();
    const ids = findAll(frame.view(), (node) => attr(node, 'data-id') !== undefined).map((node) =>
      attr(node, 'data-id'),
    );
    expect(ids).toContain(FIXTURE_IDS.config);
    expect(ids).toContain(FIXTURE_IDS.visuals);
    expect(ids).toContain(SCENE_NODES.placements);
    for (const key of session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)) {
      expect(ids).toContain(key);
    }
  });

  it('инспектор показывает поля выбранной записи и молчит, пока ничего не выбрано', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const keys = (): string[] =>
      findAll(zoneOf(frame.view(), 'inspector'), (node) => node.text?.key !== undefined).map(
        (node) => node.text?.key ?? '',
      );
    expect(keys()).toContain('ui.inspector.empty');

    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0];
    frame.selection.set(area.id, [key ?? '']);
    // Строки инспектора — поля схемы: запись расстановки по схеме формата
    // (SER-8) и поля компонентов её prefab'а по схемам компонентов (ECS-3).
    const inspector = zoneOf(frame.view(), 'inspector');
    const labels = findAll(inspector, (node) => hasClass(node, 'fx-field-row__label')).flatMap(
      (row) => findAll(row, (node) => node.text?.origin === 'value').map((node) => node.text?.value),
    );
    expect(labels).toContain('prefab');
    expect(labels).toContain('x');
    expect(labels).toContain('turns');
    expect(keys()).not.toContain('ui.inspector.empty');
  });

  it('кадр вьюпорта лежит на поверхности правки и не несёт классов хрома (ED-22)', async () => {
    const { frame } = await buildLoadedFrame();
    const frames = findAll(frame.view(), (node) => hasClass(node, VIEWPORT_CLASS));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.classes).toEqual([VIEWPORT_CLASS]);
    expect(attr(frames[0] ?? { tag: 'div' }, 'id')).toBe(SCENE_VIEWPORT_ID);
  });
});

describe('ED-13, ED-15: режимы камеры доступны с поверхности правки', () => {
  it('переключатель облёта идёт в конвейер, а не считает позу сам', async () => {
    const { frame, stage } = await buildLoadedFrame();
    expect(stage.flying).toBe(false);
    // Просьбу перерисовать приносит вьюпорт, а не нажатие: без неё страница
    // осталась бы с прежней подписью до случайной чужой перерисовки.
    let redraws = 0;
    const stop = frame.subscribe(() => redraws++);
    press(buttonByKey(frame.view(), 'ui.area.scene.cameraFly'));
    expect(redraws).toBeGreaterThan(0);
    stop();
    expect(stage.flying).toBe(true);
    // Имя переключателя от нажатия не меняется, а включённость несёт признак
    // нажатого состояния (ED-31). Объявляет её вьюпорт сменой режима: спросить
    // конвейер сразу после нажатия нельзя — режим применяет его ближайший
    // кадр (CAM-2).
    const fly = buttonByKey(frame.view(), 'ui.area.scene.cameraFly');
    expect(fly).toBeDefined();
    expect(attr(fly ?? { tag: 'div' }, 'aria-pressed')).toBe('true');
  });

  /**
   * ED-26: показанное «недоступно» обязано значить недоступно, а не «интерфейс
   * ещё не спрашивал». Арену заводит первая сетка документа — она приходит
   * позже первой отрисовки бара, — и о её появлении вьюпорт сообщает сам, тем
   * же каналом, что о режиме камеры и о сорвавшемся кадре.
   */
  it('появившаяся арена включает обзорное действие сама, без чужой перерисовки', async () => {
    const { frame, stage } = await buildLoadedFrame();
    const fit = (): UiNode =>
      buttonByKey(zoneOf(frame.view(), 'surface'), 'ui.area.scene.overview') ?? { tag: 'div' };
    stage.arena(false);
    expect(attr(fit(), 'aria-disabled')).toBe('true');

    let redraws = 0;
    const stop = frame.subscribe(() => redraws++);
    stage.arena(true);
    expect(redraws).toBeGreaterThan(0);
    stop();
    expect(attr(fit(), 'aria-disabled')).toBe('false');
  });

  it('объявляемое вьюпортом сравнивается целиком, а не полем на выбор', () => {
    const shown: StageSignals = { flying: false, failure: null, canFrame: false };
    // Каждое поле записи — повод перерисовать: пропущенное в сравнении и есть
    // дефект «действие стало доступным, а показано недоступным».
    expect(signalsChanged(shown, shown)).toBe(false);
    expect(signalsChanged(shown, { ...shown, canFrame: true })).toBe(true);
    expect(signalsChanged(shown, { ...shown, flying: true })).toBe(true);
    expect(signalsChanged(shown, { ...shown, failure: 'кадр не прошёл' })).toBe(true);
  });

  it('зум идёт тем же входом, что колесо мыши (CAM-4)', async () => {
    const { frame, stage } = await buildLoadedFrame();
    press(buttonByKey(frame.view(), 'ui.area.scene.zoomIn'));
    press(buttonByKey(frame.view(), 'ui.area.scene.zoomOut'));
    expect(stage.zooms).toEqual([-1, 1]);
  });
});

describe('ED-8, ED-22: сломанный документ назван причиной, а не оттенком', () => {
  it('правка, ломающая карту уровней, оставляет кадр и показывает причину', async () => {
    const { frame, session, stage } = await buildLoadedFrame();
    const drawn = stage.last?.grid;
    session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: ['terrain', 'levels', 0],
      value: '11',
    });
    await settle();
    // Кадр остаётся последним целым: подать нечего, но и гасить нечего.
    expect(stage.last?.grid).toBeNull();
    expect(drawn).toBeDefined();

    // Смотрим в бар поверхности правки: с W2-3 то же нарушение видно и строкой
    // навигатора (`report.forDocument`), и утверждение о числе показов без
    // зоны стало бы утверждением о том, в скольких местах оно показано.
    const marks = findAll(
      zoneOf(frame.view(), 'surface'),
      (node) => attr(node, 'data-severity') === 'error',
    );
    expect(marks).toHaveLength(1);
    const reason = findAll(marks[0] ?? { tag: 'div' }, (node) => node.text?.origin === 'value');
    expect(reason[0]?.text?.value).toContain('levels');
  });

  it('сорвавшийся кадр вьюпорта называет себя там же, где сломанный документ', async () => {
    // Документы целы, а кадр не прошёл — автор обязан это увидеть, иначе
    // прежняя картинка читается как ответ на его правку (ED-8, ED-15).
    const { frame, stage } = await buildLoadedFrame();
    const errors = (): UiNode[] =>
      findAll(zoneOf(frame.view(), 'surface'), (node) => attr(node, 'data-severity') === 'error');
    expect(errors()).toHaveLength(0);

    let redraws = 0;
    const stop = frame.subscribe(() => redraws++);
    stage.fail('подсистема террейна: чанк не собрался');
    // О причине вьюпорт сообщает сам — ждать чужой перерисовки нечего.
    expect(redraws).toBeGreaterThan(0);
    stop();
    const marks = errors();
    expect(marks).toHaveLength(1);
    const reason = findAll(marks[0] ?? { tag: 'div' }, (node) => node.text?.origin === 'value');
    expect(reason[0]?.text?.value).toContain('чанк');

    stage.fail(null);
    expect(errors()).toHaveLength(0);
  });
});

describe('ED-29: область собирается там, где рисовать нечем', () => {
  it('headless-среда честно отвечает, что кадра в ней не будет', () => {
    // Прогон пакета идёт без DOM и без WebGL, и область обязана это пережить:
    // операции авторинга исполнимы без интерфейса, а значит и без картинки.
    expect(canRender()).toBe(false);
  });
});

describe('ED-12: без открытого проекта область не притворяется, что он есть', () => {
  it('навигатор говорит, что проект не открыт, а вьюпорт остаётся на месте', () => {
    const { frame } = buildFrame([sceneArea]);
    const view = frame.view();
    const keys = findAll(view, (node) => node.text?.key !== undefined).map(
      (node) => node.text?.key ?? '',
    );
    expect(keys).toContain('ui.area.scene.noProject');
    expect(findAll(view, (node) => hasClass(node, VIEWPORT_CLASS))).toHaveLength(1);
  });

  it('кнопки камеры видимо недоступны, а не молча не срабатывают (ED-26)', () => {
    const { frame } = buildFrame([sceneArea]);
    const fly = buttonByKey(frame.view(), 'ui.area.scene.cameraFly');
    expect(attr(fly ?? { tag: 'div' }, 'aria-disabled')).toBe('true');
  });
});
