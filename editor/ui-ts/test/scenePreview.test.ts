/**
 * Встроенный runner превью (ED-9) и аффорданс режима (ED-26) — на настоящих
 * документах проекта-фикстуры и на настоящей клиентской оболочке.
 *
 * Подделаны ровно две вещи, и обе по одной причине — в headless-прогоне их не
 * существует: WebGL (дубль вьюпорта) и dedicated Worker (пара синхронных портов
 * вместо `postMessage`, `support/preview.ts`). Ядро, оболочка, кодек и конверты
 * тиков — настоящие: ED-9 обещает автору прогон ТОЙ ЖЕ оболочкой, что у
 * игрового клиента, и проверять это на подделке оболочки было бы проверкой
 * подделки.
 *
 * Правка, которую прогоняет большая часть тестов, — добавленная в документ
 * JSON-система, выбивающая пол арены. Она выбрана не случайно: это буквально
 * сценарий ED-9 («дизайнер правит систему и запускает превью») и одновременно
 * та мутация, ради которой REND-14 требует переподачи сетки на выходе —
 * «в превью взрыв выбивает пол… после выхода документы в том же состоянии».
 */
import { FLOOR_COMPONENT, world, type EntityId } from '@game-mvp/core';
import { describe, expect, it } from 'vitest';
import { findAll, type UiNode } from '../src/dom/node.js';
import { systemsArea } from '../src/areas/systems.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { attr, buildLoadedFrame, buttonByKey, press, type LoadedFrameFixture } from './support/frame.js';
import { FIXTURE_IDS, entityHit, settle, surfaceHit } from './support/project.js';

/**
 * Система, выбивающая пол арены целиком: сетка фикстуры 4×4, то есть одно слово
 * карты пола (`w0`). Пишется она в документ операцией авторинга — как её
 * написал бы автор в области систем.
 */
const FLOOR_BREAKER = {
  name: 'PreviewFloorBreaker',
  order: 40,
  query: { withTag: 'terrain' },
  as: 'e',
  do: [
    {
      modifyComponent: {
        entity: { var: 'e' },
        component: FLOOR_COMPONENT,
        values: { w0: 0 },
      },
    },
  ],
};

/** Несохранённая правка документа сцены: та самая, которую обязан взять прогон. */
function editSystem(fixture: LoadedFrameFixture): void {
  fixture.session.applyOperation('document.setValue', {
    document: FIXTURE_IDS.config,
    path: ['systems', 0],
    value: FLOOR_BREAKER,
  });
}

const previewButton = (fixture: LoadedFrameFixture): UiNode | undefined =>
  buttonByKey(fixture.frame.view(), 'ui.action.preview');

const stopButton = (fixture: LoadedFrameFixture): UiNode | undefined =>
  buttonByKey(fixture.frame.view(), 'ui.action.previewStop');

const disabled = (node: UiNode | undefined): string | undefined =>
  attr(node ?? { tag: 'div' }, 'aria-disabled');

/** Ключи ресурсов, которые показывает текущая страница. */
const shownKeys = (fixture: LoadedFrameFixture): string[] =>
  findAll(fixture.frame.view(), (node) => node.text?.key !== undefined).map(
    (node) => node.text?.key ?? '',
  );

/** Сущность-носитель карты пола в мире прогона (SER-7: она спавнится первой). */
function floorWord(fixture: LoadedFrameFixture): number {
  const state = fixture.preview.simulation?.state;
  if (state === undefined) throw new Error('прогона нет');
  const carrier = world
    .listAlive(state.world)
    .find((entity: EntityId) => world.hasComponent(state.world, entity, FLOOR_COMPONENT));
  if (carrier === undefined) throw new Error('в мире прогона нет носителя карты пола');
  return world.getField(state.world, carrier, FLOOR_COMPONENT, 'w0');
}

describe('ED-9: прогоняется текущее состояние документов, включая несохранённые правки', () => {
  it('правка, не дошедшая до диска, уезжает в воркер вместе со сценой', async () => {
    const fixture = await buildLoadedFrame();
    editSystem(fixture);
    await settle();
    // Сохранения не было: ED-26 запрещает его требовать.
    expect(fixture.session.dirtyDocumentIds()).toContain(FIXTURE_IDS.config);
    expect(fixture.host.writes).toEqual([]);

    fixture.frame.togglePreview();

    const scene = fixture.preview.scenes[0];
    expect(fixture.preview.scenes).toHaveLength(1);
    expect(scene?.def.systems?.[0]).toMatchObject({ name: FLOOR_BREAKER.name });
    // Прогон идёт той же оболочкой: handshake ушёл до первого состояния (SHELL-5).
    expect(fixture.preview.messages[0]).toMatchObject({ from: 'worker', kind: 'hello' });
  });

  it('собственного цикла симуляции у редактора нет: мир двигает воркер', async () => {
    const fixture = await buildLoadedFrame();
    editSystem(fixture);
    await settle();
    fixture.frame.togglePreview();

    expect(fixture.preview.simulation?.state.tick).toBe(0);
    // Пол цел, пока не прошёл ни один тик, и выбивает его именно тик.
    expect(floorWord(fixture)).not.toBe(0);
    fixture.preview.step(1);
    expect(fixture.preview.simulation?.state.tick).toBe(1);
    expect(floorWord(fixture)).toBe(0);
  });

  it('прогон публикуется в ту же presentation-сцену, а не заводит вторую (REND-11)', async () => {
    const fixture = await buildLoadedFrame();
    fixture.frame.togglePreview();
    // Кадр прогона крутит цикл вьюпорта: своего у превью нет (SHELL-1, REND-8).
    expect(fixture.stage.producers).toHaveLength(1);

    fixture.preview.step(1);
    const producer = fixture.stage.presentation.activeProducer;
    expect(producer?.name).toBe('remote');

    fixture.frame.togglePreview();
    // Продюсер ушёл, не передав состояния: сцена ничья до первой подачи документов.
    expect(fixture.stage.presentation.activeProducer).toBeNull();
    expect(fixture.stage.producers).toHaveLength(0);
  });
});

describe('ED-9: превью не записывает ничего в документы и дерево контента', () => {
  it('после выхода документы — те же, что на входе, включая несохранённые правки', async () => {
    const fixture = await buildLoadedFrame();
    editSystem(fixture);
    await settle();
    const before = JSON.stringify(fixture.session.documentValue(FIXTURE_IDS.config));
    const history = fixture.session.history().undo.length;

    fixture.frame.togglePreview();
    fixture.preview.step(5);
    // Мир прогона изменился — значит, сравнение документов не пустое.
    expect(floorWord(fixture)).toBe(0);
    fixture.frame.togglePreview();

    expect(JSON.stringify(fixture.session.documentValue(FIXTURE_IDS.config))).toBe(before);
    expect(fixture.session.history().undo.length).toBe(history);
    expect(fixture.host.writes).toEqual([]);
    // Правка по-прежнему не сохранена: превью её не «зафиксировало» на диске.
    expect(fixture.session.dirtyDocumentIds()).toContain(FIXTURE_IDS.config);
  });

  it('обратный канал несёт только возврат буфера: ввода и команд мира в нём нет', async () => {
    const fixture = await buildLoadedFrame();
    fixture.frame.togglePreview();
    fixture.preview.step(4);
    const fromMain = fixture.preview.messages.filter((message) => message.from === 'main');
    expect(fromMain.length).toBeGreaterThan(0);
    expect([...new Set(fromMain.map((message) => message.kind))]).toEqual(['ret']);
  });
});

describe('ED-9, REND-14: выход возвращает вьюпорту документы, а не только документам покой', () => {
  it('выход переподаёт тот же кадр — иначе выбитый пол дожил бы до режима правки', async () => {
    const fixture = await buildLoadedFrame();
    editSystem(fixture);
    await settle();
    const drawn = fixture.stage.last;
    const submits = fixture.stage.submitted.length;

    fixture.frame.togglePreview();
    fixture.preview.step(3);
    // Пока идёт прогон, документы во вьюпорт не подаются: кадр наполняет он.
    expect(fixture.stage.submitted.length).toBe(submits);

    fixture.frame.togglePreview();
    expect(fixture.stage.submitted.length).toBe(submits + 1);
    // Тот же самый кадр по ссылке: сравнение значений не увидело бы правки
    // вовсе — документы за прогон не менялись, — и без явной переподачи во
    // вьюпорт не доехало бы ничего.
    expect(fixture.stage.last).toBe(drawn);
    expect(fixture.stage.reapplied.at(-1)).toBe(true);
    // Сетка в переподанном кадре — с целой картой пола: клетка без пола ровно
    // одна, та, что размечена в документе.
    expect([...(fixture.stage.last?.grid?.floor ?? [])].filter((bit) => bit === 0)).toHaveLength(1);
  });

  it('правка, сделанная во время прогона, доезжает выходом из него', async () => {
    // Правка приходит не из интерфейса (ED-29) — инструменты в превью
    // недоступны, — но дойти до кадра она обязана: терять её нельзя.
    const fixture = await buildLoadedFrame();
    fixture.frame.togglePreview();
    fixture.session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: ['prefabs', 0, 'components', 'Position', 'x'],
      value: 262144,
    });
    await settle();
    fixture.frame.togglePreview();

    expect(fixture.stage.reapplied.at(-1)).toBe(true);
    expect(fixture.stage.last?.placements[0]?.x).toBeCloseTo(4, 6);
  });
});

describe('ED-26: операции авторинга в превью видимо недоступны', () => {
  it('инструменты, отмена и повтор показаны недоступными', async () => {
    const fixture = await buildLoadedFrame();
    fixture.session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: ['terrain', 'levels', 0],
      value: '1000',
    });
    await settle();
    expect(disabled(buttonByKey(fixture.frame.view(), 'ui.area.scene.toolTerrain'))).toBe('false');
    expect(disabled(buttonByKey(fixture.frame.view(), 'ui.frame.undo'))).toBe('false');

    fixture.frame.togglePreview();
    const view = fixture.frame.view();
    expect(disabled(buttonByKey(view, 'ui.area.scene.toolTerrain'))).toBe('true');
    expect(disabled(buttonByKey(view, 'ui.area.scene.toolPointer'))).toBe('true');
    expect(disabled(buttonByKey(view, 'ui.action.remove'))).toBe('true');
    expect(disabled(buttonByKey(view, 'ui.frame.undo'))).toBe('true');
    expect(disabled(buttonByKey(view, 'ui.frame.redo'))).toBe('true');
    // Камера в превью работает: ED-13 прямо разрешает панорамировать и зумить.
    expect(disabled(buttonByKey(view, 'ui.area.scene.zoomIn'))).toBe('false');

    fixture.frame.togglePreview();
    expect(disabled(buttonByKey(fixture.frame.view(), 'ui.area.scene.toolTerrain'))).toBe('false');
  });

  it('клик по кадру в превью не доходит до инструмента', async () => {
    const fixture = await buildLoadedFrame();
    const key = fixture.session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    fixture.stage.hits.set('10:10', entityHit(key));
    fixture.frame.view();

    fixture.frame.togglePreview();
    fixture.pointer({ phase: 'down', x: 10, y: 10, additive: false });
    fixture.pointer({ phase: 'up', x: 10, y: 10, additive: false });
    expect(fixture.frame.selection.get(fixture.area.id)).toEqual([]);
    expect(fixture.session.pending).toBe(false);
  });

  it('незакрытое взаимодействие закрывается входом в превью, а не переживает его', async () => {
    // Открытая транзакция запрещает сессии и следующую операцию, и undo
    // (ED-18): пережив вход в превью, она заклинила бы сессию до конца сеанса.
    const fixture = await buildLoadedFrame();
    const key = fixture.session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    fixture.stage.hits.set('10:10', entityHit(key));
    fixture.stage.surfaceHits.set('10:10', surfaceHit(1.5, 1.5, 5));
    fixture.stage.surfaceHits.set('30:10', surfaceHit(2.5, 1.5, 6));
    fixture.frame.view();

    fixture.pointer({ phase: 'down', x: 10, y: 10, additive: false });
    fixture.pointer({ phase: 'move', x: 30, y: 10, additive: false });
    expect(fixture.state.tool.dragging).toBe(true);
    expect(fixture.session.pending).toBe(true);

    fixture.frame.togglePreview();
    expect(fixture.frame.mode()).toBe('preview');
    expect(fixture.state.tool.dragging).toBe(false);
    expect(fixture.session.pending).toBe(false);
  });
});

describe('ED-26: режим виден постоянно и переключается из любой области', () => {
  it('пометка режима стоит в верхнем баре и меняется вместе с режимом', async () => {
    const fixture = await buildLoadedFrame();
    expect(shownKeys(fixture)).toContain('ui.chip.editMode');
    expect(shownKeys(fixture)).not.toContain('ui.chip.previewMode');

    fixture.frame.togglePreview();
    expect(shownKeys(fixture)).toContain('ui.chip.previewMode');
    expect(shownKeys(fixture)).not.toContain('ui.chip.editMode');
  });

  it('режим читается из любой области — он один на редактор, а не на область', async () => {
    const fixture = await buildLoadedFrame();
    fixture.frame.togglePreview();
    for (const areaId of [systemsArea.id, fixture.area.id]) {
      fixture.frame.activate(areaId);
      expect(fixture.frame.mode()).toBe('preview');
      expect(shownKeys(fixture)).toContain('ui.chip.previewMode');
    }
  });

  it('запуск и выход доступны из области, которая сцену не показывает', async () => {
    const fixture = await buildLoadedFrame();
    fixture.frame.activate(systemsArea.id);
    expect(fixture.frame.canPreview()).toBe(true);

    press(previewButton(fixture));
    expect(fixture.frame.mode()).toBe('preview');
    expect(fixture.preview.scenes).toHaveLength(1);
    // Сохранения на диск для этого не потребовалось (ED-26).
    expect(fixture.host.writes).toEqual([]);

    press(stopButton(fixture));
    expect(fixture.frame.mode()).toBe('edit');
    expect(fixture.preview.disposals).toBe(1);
  });

  it('без открытого проекта запуск показан недоступным, а не молча инертным', async () => {
    const fixture = await buildLoadedFrame();
    // Проект-фикстура открыт — кнопка доступна; сравнение с областью без
    // проекта делает `sceneArea.test.ts`, здесь важна сама доступность.
    expect(disabled(previewButton(fixture))).toBe('false');
    fixture.state.project = null;
    expect(fixture.frame.canPreview()).toBe(false);
    expect(disabled(previewButton(fixture))).toBe('true');
  });

  it('сломанный документ оставляет автора в правке с названной причиной', async () => {
    const fixture = await buildLoadedFrame();
    fixture.session.applyOperation('document.setValue', {
      document: FIXTURE_IDS.config,
      path: ['terrain', 'levels', 0],
      value: '11',
    });
    await settle();

    fixture.frame.togglePreview();
    expect(fixture.frame.mode()).toBe('edit');
    expect(fixture.preview.scenes).toHaveLength(0);
    const marks = findAll(fixture.frame.view(), (node) => attr(node, 'data-severity') === 'error');
    const reasons = marks.flatMap((mark) =>
      findAll(mark, (node) => node.text?.origin === 'value').map((node) => node.text?.value ?? ''),
    );
    expect(reasons.join(' ')).toContain('levels');
  });
});

describe('ED-13: ввод камеры не пересекает границу воркера', () => {
  /** Один прогон: N тиков с кадрами; `camera` — что автор делает с камерой. */
  async function run(camera: (fixture: LoadedFrameFixture, step: number) => void) {
    const fixture = await buildLoadedFrame();
    editSystem(fixture);
    await settle();
    fixture.frame.togglePreview();
    for (let step = 0; step < 5; step++) {
      camera(fixture, step);
      fixture.preview.step(1);
      // Кадр главного потока: он читает доставленное и возвращает буфер (SHELL-3).
      fixture.stage.frame(step * 16);
    }
    const messages = fixture.preview.messages.map((message) => ({ ...message }));
    fixture.frame.togglePreview();
    return { fixture, messages };
  }

  it('прогон с движениями камеры и без них пересылает ровно одно и то же', async () => {
    const still = await run(() => undefined);
    const moved = await run((fixture, step) => {
      // Зум и облёт — те же входы конвейера, что колесо и клавиша (CAM-2, CAM-4).
      fixture.stage.zoom(step % 2 === 0 ? -1 : 1);
      if (step === 2) fixture.stage.toggleFly();
    });

    expect(moved.fixture.stage.zooms).toHaveLength(5);
    expect(moved.messages.length).toBeGreaterThan(5);
    expect(moved.messages).toEqual(still.messages);
  });
});
