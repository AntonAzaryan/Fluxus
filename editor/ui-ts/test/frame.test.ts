/**
 * Каркас рабочих областей (ED-23), скелет области (ED-24) и путь оповещений, по
 * которому правка доходит до страницы (ED-15).
 *
 * Проверяется то, что оба требования называют прямо: переключение горячей
 * клавишей и явным элементом; одинаковые места зон во всех областях;
 * переживание состояния области при уходе и возврате; сквозные выделение и
 * история — «история одна на сессию, а не своя в каждой области».
 *
 * Чего здесь нет и почему. Отстыковку области в отдельное окно ED-23 разрешает
 * как удобство хоста среды и запрещает делать условием доступности операции.
 * Проверять нечего: каркас отдаёт одну страницу, область кладёт три узла в
 * зоны одного скелета, и способа потребовать второе окно у неё нет — ни в
 * поверхности `WorkspaceArea`, ни в `WorkspaceFrame`. Требование выполнено
 * отсутствием механизма, а не проверкой его поведения.
 */
import { describe, expect, it } from 'vitest';
import { findAll, type UiNode } from '../src/dom/node.js';
import type { WorkspaceArea } from '../src/frame/area.js';
import { RAIL_ITEM_CLASS } from '../src/frame/rail.js';
import { createCoalescingRedraw, type CoalescingRedraw } from '../src/frame/redraw.js';
import { ZONE_ORDER } from '../src/frame/skeleton.js';
import { sceneArea, type SceneAreaState } from '../src/areas/scene.js';
import { stubArea, type StubAreaState } from './support/stubArea.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import {
  attr,
  buildFrame,
  buildLoadedFrame,
  buttonByKey,
  keydown,
  press,
  withAttr,
} from './support/frame.js';
import { FIXTURE_IDS } from './support/project.js';

/** Область без содержимого: нужна там, где проверяется каркас, а не вклад. */
const blankArea: WorkspaceArea = {
  id: 'area.blank',
  descriptionKey: 'blank.description',
  labelKey: 'blank.label',
  icon: 'search',
  editableTypes: [{ id: 'blank', descriptionKey: 'blank.editable' }],
  createState: () => ({}),
  render: () => ({
    navigator: { tag: 'div' },
    surface: { tag: 'div' },
    inspector: { tag: 'div' },
  }),
};

function zoneNames(view: UiNode): string[] {
  return withAttr(view, 'data-zone').map((node) => attr(node, 'data-zone') ?? '');
}

function railItems(view: UiNode): string[] {
  return findAll(view, (node) => node.classes?.includes(RAIL_ITEM_CLASS) === true).map(
    (node) => attr(node, 'data-area') ?? '',
  );
}

describe('ED-24: скелет области одинаков во всех областях', () => {
  it('зон ровно три и они идут навигатором, поверхностью и инспектором', () => {
    const { frame } = buildFrame();
    expect(zoneNames(frame.view())).toEqual([...ZONE_ORDER]);
  });

  it('переход в другую область не меняет ни порядка зон, ни их числа', () => {
    const { frame } = buildFrame();
    const before = zoneNames(frame.view());
    frame.activate(stubArea.id);
    expect(zoneNames(frame.view())).toEqual(before);
  });

  it('содержимое зон у двух областей разное — скелет один, области не одинаковые', () => {
    const { frame } = buildFrame();
    const scene = withAttr(frame.view(), 'data-zone');
    frame.activate(stubArea.id);
    const systems = withAttr(frame.view(), 'data-zone');
    for (const [index, zone] of scene.entries()) {
      const other = systems[index];
      expect(other).toBeDefined();
      expect(JSON.stringify(zone.children)).not.toBe(JSON.stringify(other?.children));
    }
  });

  it('навигатор — дерево в одной области и плоский список в другой', async () => {
    const { frame } = await buildLoadedFrame();
    const navigatorOf = (): string[] => {
      const zone = withAttr(frame.view(), 'data-zone').find(
        (node) => attr(node, 'data-zone') === 'navigator',
      );
      return findAll(zone ?? { tag: 'div' }, (node) => attr(node, 'role') !== undefined).map(
        (node) => attr(node, 'role') ?? '',
      );
    };
    expect(navigatorOf()).toContain('tree');
    frame.activate(stubArea.id);
    expect(navigatorOf()).toContain('listbox');
  });
});

describe('ED-23: рельс есть представление реестра областей', () => {
  it('знаков в рельсе столько же, сколько вкладов в реестре, и в том же порядке', () => {
    const { frame } = buildFrame();
    expect(railItems(frame.view())).toEqual(frame.areas.all().map((area) => area.id));
  });

  it('активная область помечена в рельсе, и ровно одна', () => {
    const { frame } = buildFrame();
    const active = (): string[] =>
      findAll(frame.view(), (node) => attr(node, 'aria-selected') === 'true')
        .filter((node) => attr(node, 'data-area') !== undefined)
        .map((node) => attr(node, 'data-area') ?? '');
    expect(active()).toEqual([sceneArea.id]);
    frame.activate(stubArea.id);
    expect(active()).toEqual([stubArea.id]);
  });
});

describe('ED-23: переключение горячей клавишей и явным элементом', () => {
  it('горячая клавиша вклада переключает область', () => {
    const { frame } = buildFrame();
    expect(stubArea.hotkey).toBe('F6');
    expect(frame.handleKey({ key: 'F6', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(stubArea.id);
    expect(frame.handleKey({ key: 'F1', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(sceneArea.id);
  });

  it('нажатие на знак рельса переключает ту же область', () => {
    const { frame } = buildFrame();
    const item = findAll(
      frame.view(),
      (node) => attr(node, 'data-area') === stubArea.id,
    )[0];
    press(item);
    expect(frame.activeAreaId()).toBe(stubArea.id);
  });

  it('чужое сочетание каркас не забирает', () => {
    const { frame } = buildFrame();
    expect(frame.handleKey({ key: 'F9', ctrl: false, shift: false, alt: false })).toBe(false);
  });
});

describe('ED-23: состояние области переживает переключение', () => {
  it('запись состояния — та же самая, а не равная ей', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id);
    frame.activate(stubArea.id);
    frame.activate(sceneArea.id);
    expect(frame.stateOf(sceneArea.id)).toBe(state);
  });

  it('камера, раскрытые узлы и строка под фокусом — те же, что были до ухода', async () => {
    // Поза камеры живёт в конвейере вьюпорта (ED-13), а вьюпорт — в записи
    // состояния области: пережить переключение обязан именно он, иначе автор
    // возвращался бы к сцене с другого ракурса.
    const { frame, area, stage, state } = await buildLoadedFrame();
    press(buttonByKey(frame.view(), 'ui.area.scene.zoomIn'));
    expect(stage.zooms).toHaveLength(1);
    state.expanded.add('вложенный узел');
    state.focusId = FIXTURE_IDS.visuals;

    frame.activate(stubArea.id);
    frame.view();
    frame.activate(area.id);
    frame.view();

    const returned = frame.stateOf(area.id) as SceneAreaState;
    expect(returned.stage).toBe(stage);
    expect(returned.expanded.has('вложенный узел')).toBe(true);
    expect(returned.focusId).toBe(FIXTURE_IDS.visuals);
  });

  it('запись заводится один раз и не пересоздаётся отрисовкой', () => {
    const { frame } = buildFrame();
    const first = frame.stateOf(sceneArea.id);
    frame.view();
    frame.view();
    expect(frame.stateOf(sceneArea.id)).toBe(first);
  });

  it('запись заводится лениво: непосещённая область своей не имеет', () => {
    // Область может заводить в записи что угодно дорогое — открывать документ,
    // читать дерево контента. Каркас, заводящий записи всем при сборке, платил
    // бы за области, в которые автор не заходил.
    let created = 0;
    const counted: WorkspaceArea<{ readonly mark: number }> = {
      ...blankArea,
      id: 'area.unvisited',
      hotkey: 'F7',
      createState: () => {
        created++;
        return { mark: created };
      },
    };
    const { frame } = buildFrame([sceneArea, counted]);
    frame.view();
    expect(created).toBe(0);
    frame.activate(counted.id);
    frame.view();
    frame.view();
    expect(created).toBe(1);
  });

  it('подмена вклада по id заводит новую запись, а не отдаёт чужую', () => {
    // Реестр умеет подмену (`override`) — так проект перекрывает вклад
    // редактора. Подменивший — другая область: её `render` ждёт своих полей, и
    // запись предшественника означала бы ложь в единственном приведении типа,
    // которым каркас отдаёт запись владельцу.
    const fixture = buildFrame();
    const before = fixture.frame.stateOf(sceneArea.id);
    const replacement: WorkspaceArea<{ readonly own: true }> = {
      ...blankArea,
      id: sceneArea.id,
      hotkey: sceneArea.hotkey,
      createState: () => ({ own: true }),
    };
    fixture.areas.override(replacement);
    const after = fixture.frame.stateOf(sceneArea.id);
    expect(after).not.toBe(before);
    expect(after).toEqual({ own: true });
  });
});

describe('ED-23: выделение сквозное', () => {
  it('выделение области ставится снаружи, когда область не показана', async () => {
    const { frame, area, session } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.activate(stubArea.id);
    frame.selection.set(area.id, [key]);
    frame.activate(area.id);
    const selected = findAll(frame.view(), (node) => attr(node, 'data-id') === key)[0];
    expect(attr(selected ?? { tag: 'div' }, 'aria-selected')).toBe('true');
  });

  it('выделение, поставленное в области, находится на месте после возврата', async () => {
    const { frame, area, session } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[1] ?? '';
    press(findAll(frame.view(), (node) => attr(node, 'data-id') === key)[0]);
    frame.activate(stubArea.id);
    frame.activate(area.id);
    expect(frame.selection.get(area.id)).toEqual([key]);
  });

  it('выделения областей не смешиваются: модель одна, запись в ней — на область', () => {
    const { frame } = buildFrame();
    frame.selection.set(sceneArea.id, ['hero']);
    frame.selection.set(stubArea.id, ['content/systems/regen.system.json']);
    expect(frame.selection.get(sceneArea.id)).toEqual(['hero']);
    expect(frame.selection.get(stubArea.id)).toEqual([
      'content/systems/regen.system.json',
    ]);
  });
});

describe('ED-23, ED-18: история одна на сессию, а не своя в каждой области', () => {
  /** Переключатель флага в инспекторе области систем — правка настоящего документа. */
  function toggleFlag(frame: ReturnType<typeof buildFrame>['frame']): void {
    const control = findAll(frame.view(), (node) => attr(node, 'role') === 'switch')[0];
    press(control);
  }

  it('правка сделана операцией авторинга, а не записью в документ', () => {
    const { frame, session } = buildFrame();
    frame.activate(stubArea.id);
    const state = frame.stateOf(stubArea.id) as StubAreaState;
    expect(session.isOpen(state.documentId)).toBe(true);
    expect(session.canUndo()).toBe(false);

    toggleFlag(frame);
    expect(session.canUndo()).toBe(true);
    expect(session.history().undo.at(-1)?.operationId).toBe('document.setValue');
  });

  it('правка, сделанная в одной области, отменяется из другой', () => {
    const { frame, session } = buildFrame();
    frame.activate(stubArea.id);
    const state = frame.stateOf(stubArea.id) as StubAreaState;
    const before = JSON.stringify(session.documentValue(state.documentId));

    toggleFlag(frame);
    expect(JSON.stringify(session.documentValue(state.documentId))).not.toBe(before);

    frame.activate(sceneArea.id);
    expect(frame.handleKey({ key: 'z', ctrl: true, shift: false, alt: false })).toBe(true);
    expect(JSON.stringify(session.documentValue(state.documentId))).toBe(before);
    expect(frame.activeAreaId()).toBe(sceneArea.id);
  });

  it('повтор возвращает отменённое и тоже не спрашивает, где это было', () => {
    const { frame, session } = buildFrame();
    frame.activate(stubArea.id);
    const state = frame.stateOf(stubArea.id) as StubAreaState;
    toggleFlag(frame);
    const after = JSON.stringify(session.documentValue(state.documentId));

    frame.activate(sceneArea.id);
    frame.handleKey({ key: 'z', ctrl: true, shift: false, alt: false });
    expect(frame.handleKey({ key: 'z', ctrl: true, shift: true, alt: false })).toBe(true);
    expect(JSON.stringify(session.documentValue(state.documentId))).toBe(after);
  });

  it('правка, пришедшая без интерфейса, доходит до страницы (ED-29, ED-15)', () => {
    const { frame, session } = buildFrame();
    frame.activate(stubArea.id);
    const state = frame.stateOf(stubArea.id) as StubAreaState;
    frame.view();

    let redraws = 0;
    frame.subscribe(() => {
      redraws++;
    });
    // Внешний потребитель правит документ той же операцией и мимо интерфейса.
    session.applyOperation('document.setValue', {
      document: state.documentId,
      path: ['flags', 'enabled'],
      value: false,
    });
    expect(redraws).toBeGreaterThan(0);
  });

  it('кнопки отмены и повтора видимо недоступны, пока отменять нечего (ED-26)', () => {
    const { frame } = buildFrame();
    const undo = buttonByKey(frame.view(), 'ui.frame.undo');
    expect(attr(undo ?? { tag: 'div' }, 'aria-disabled')).toBe('true');
    frame.activate(stubArea.id);
    toggleFlag(frame);
    expect(attr(buttonByKey(frame.view(), 'ui.frame.undo') ?? { tag: 'div' }, 'aria-disabled')).toBe(
      'false',
    );
  });
});

describe('ED-23, ED-24: поиск по проекту — сквозной', () => {
  it('запрос переживает переключение области', () => {
    const { frame } = buildFrame();
    frame.setSearchQuery('skeleton');
    frame.activate(stubArea.id);
    expect(frame.searchQuery()).toBe('skeleton');
    const search = findAll(frame.view(), (node) => attr(node, 'type') === 'search')[0];
    expect(search?.labels?.value?.value).toBe('skeleton');
  });
});

describe('каркас без единой области', () => {
  it('отказывается собираться, а не показывает пустое окно', () => {
    expect(() => buildFrame([])).toThrow();
  });
});

describe('ED-15: просьбы перерисовать сводятся в одну отрисовку', () => {
  /** Очередь вместо микрозадачи: момент отрисовки в тесте обязан быть точкой. */
  function queued(): { readonly run: () => void; readonly redraw: CoalescingRedraw; draws: number } {
    const pending: (() => void)[] = [];
    const box = {
      draws: 0,
      redraw: createCoalescingRedraw(
        () => {
          box.draws++;
        },
        (draw) => pending.push(draw),
      ),
      run: () => {
        for (const draw of pending.splice(0)) draw();
      },
    };
    return box;
  }

  it('несколько просьб подряд дают одну отрисовку, а следующая — новую', () => {
    const box = queued();
    box.redraw.request();
    box.redraw.request();
    box.redraw.request();
    expect(box.redraw.pending).toBe(true);
    // Синхронно не нарисовано ничего: сведение и есть отсрочка.
    expect(box.draws).toBe(0);

    box.run();
    expect(box.draws).toBe(1);
    expect(box.redraw.pending).toBe(false);

    // Следующая порция работы — следующая отрисовка, а не пропущенная.
    box.redraw.request();
    box.run();
    expect(box.draws).toBe(2);
  });

  it('снос страницы отменяет запланированное', () => {
    const box = queued();
    box.redraw.request();
    box.redraw.cancel();
    box.run();
    expect(box.draws).toBe(0);
  });

  it('пакет по мультивыделению перерисовывает страницу один раз, а не по записи', async () => {
    // Пакет — это `beginOperation`, `extend` на каждую запись и `commit` в одном
    // синхронном вызове, и каждое из них сессия объявляет честно: состояние
    // документов между ними разное (ED-18). Сводит их отрисовка — ED-15 даёт
    // на это ровно тот зазор, в котором сведение законно.
    const fixture = await buildLoadedFrame();
    const keys = fixture.session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    fixture.frame.selection.set(fixture.area.id, [...keys]);
    fixture.frame.view();

    let notices = 0;
    const box = queued();
    fixture.frame.subscribe(() => {
      notices++;
      box.redraw.request();
    });
    fixture.state.tool.remove();
    box.run();

    // Оповещений действительно несколько — иначе сводить было бы нечего.
    expect(keys.length).toBe(2);
    expect(notices).toBeGreaterThan(2);
    expect(box.draws).toBe(1);
  });
});

describe('клавиатура рельса', () => {
  it('стрелки водят по знакам и сразу переключают область', () => {
    const { frame } = buildFrame();
    const rail = findAll(frame.view(), (node) => node.classes?.includes('fx-rail') === true)[0];
    expect(keydown(rail, 'ArrowDown')).toBe(true);
    expect(frame.activeAreaId()).toBe(stubArea.id);
  });
});
