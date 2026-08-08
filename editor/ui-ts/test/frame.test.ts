/**
 * Каркас рабочих областей (ED-23) и скелет области (ED-24).
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
import { ZONE_ORDER } from '../src/frame/skeleton.js';
import { sceneArea, type SceneAreaState } from '../src/areas/scene.js';
import { systemsArea, type SystemsAreaState } from '../src/areas/systems.js';
import { attr, buildFrame, buttonByKey, keydown, press, withAttr } from './support/frame.js';

/** Область без содержимого: нужна там, где проверяется каркас, а не вклад. */
const blankArea: WorkspaceArea<object> = {
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
    frame.activate(systemsArea.id);
    expect(zoneNames(frame.view())).toEqual(before);
  });

  it('содержимое зон у двух областей разное — скелет один, области не одинаковые', () => {
    const { frame } = buildFrame();
    const scene = withAttr(frame.view(), 'data-zone');
    frame.activate(systemsArea.id);
    const systems = withAttr(frame.view(), 'data-zone');
    for (const [index, zone] of scene.entries()) {
      const other = systems[index];
      expect(other).toBeDefined();
      expect(JSON.stringify(zone.children)).not.toBe(JSON.stringify(other?.children));
    }
  });

  it('навигатор — дерево в одной области и плоский список в другой', () => {
    const { frame } = buildFrame();
    const navigatorOf = (): string[] => {
      const zone = withAttr(frame.view(), 'data-zone').find(
        (node) => attr(node, 'data-zone') === 'navigator',
      );
      return findAll(zone ?? { tag: 'div' }, (node) => attr(node, 'role') !== undefined).map(
        (node) => attr(node, 'role') ?? '',
      );
    };
    expect(navigatorOf()).toContain('tree');
    frame.activate(systemsArea.id);
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
    frame.activate(systemsArea.id);
    expect(active()).toEqual([systemsArea.id]);
  });
});

describe('ED-23: переключение горячей клавишей и явным элементом', () => {
  it('горячая клавиша вклада переключает область', () => {
    const { frame } = buildFrame();
    expect(systemsArea.hotkey).toBe('F2');
    expect(frame.handleKey({ key: 'F2', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(systemsArea.id);
    expect(frame.handleKey({ key: 'F1', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(sceneArea.id);
  });

  it('нажатие на знак рельса переключает ту же область', () => {
    const { frame } = buildFrame();
    const item = findAll(
      frame.view(),
      (node) => attr(node, 'data-area') === systemsArea.id,
    )[0];
    press(item);
    expect(frame.activeAreaId()).toBe(systemsArea.id);
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
    frame.activate(systemsArea.id);
    frame.activate(sceneArea.id);
    expect(frame.stateOf(sceneArea.id)).toBe(state);
  });

  it('поза камеры, раскрытые узлы и строка под фокусом — те же, что были до ухода', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
    // Поза меняется тем же способом, что и у автора: кнопкой на поверхности.
    press(buttonByKey(frame.view(), 'ui.area.scene.zoomIn'));
    const distance = state.camera.distance;
    expect(distance).toBeLessThan(24);
    state.expanded.add('hero');
    state.focusId = 'skeleton_02';

    frame.activate(systemsArea.id);
    frame.view();
    frame.activate(sceneArea.id);
    frame.view();

    const returned = frame.stateOf(sceneArea.id) as SceneAreaState;
    expect(returned.camera.distance).toBe(distance);
    expect(returned.expanded.has('hero')).toBe(true);
    expect(returned.focusId).toBe('skeleton_02');
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
  it('выделение области ставится снаружи, когда область не показана', () => {
    const { frame } = buildFrame();
    frame.activate(systemsArea.id);
    frame.selection.set(sceneArea.id, ['hero']);
    frame.activate(sceneArea.id);
    const selected = findAll(
      frame.view(),
      (node) => attr(node, 'data-id') === 'hero',
    )[0];
    expect(attr(selected ?? { tag: 'div' }, 'aria-selected')).toBe('true');
  });

  it('выделение, поставленное в области, находится на месте после возврата', () => {
    const { frame } = buildFrame();
    const row = findAll(frame.view(), (node) => attr(node, 'data-id') === 'skeleton_02')[0];
    press(row);
    frame.activate(systemsArea.id);
    frame.activate(sceneArea.id);
    expect(frame.selection.get(sceneArea.id)).toEqual(['skeleton_02']);
  });

  it('выделения областей не смешиваются: модель одна, запись в ней — на область', () => {
    const { frame } = buildFrame();
    frame.selection.set(sceneArea.id, ['hero']);
    frame.selection.set(systemsArea.id, ['content/systems/regen.system.json']);
    expect(frame.selection.get(sceneArea.id)).toEqual(['hero']);
    expect(frame.selection.get(systemsArea.id)).toEqual([
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
    frame.activate(systemsArea.id);
    const state = frame.stateOf(systemsArea.id) as SystemsAreaState;
    expect(session.isOpen(state.documentId)).toBe(true);
    expect(session.canUndo()).toBe(false);

    toggleFlag(frame);
    expect(session.canUndo()).toBe(true);
    expect(session.history().undo.at(-1)?.operationId).toBe('document.setValue');
  });

  it('правка, сделанная в одной области, отменяется из другой', () => {
    const { frame, session } = buildFrame();
    frame.activate(systemsArea.id);
    const state = frame.stateOf(systemsArea.id) as SystemsAreaState;
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
    frame.activate(systemsArea.id);
    const state = frame.stateOf(systemsArea.id) as SystemsAreaState;
    toggleFlag(frame);
    const after = JSON.stringify(session.documentValue(state.documentId));

    frame.activate(sceneArea.id);
    frame.handleKey({ key: 'z', ctrl: true, shift: false, alt: false });
    expect(frame.handleKey({ key: 'z', ctrl: true, shift: true, alt: false })).toBe(true);
    expect(JSON.stringify(session.documentValue(state.documentId))).toBe(after);
  });

  it('правка, пришедшая без интерфейса, доходит до страницы (ED-29, ED-15)', () => {
    const { frame, session } = buildFrame();
    frame.activate(systemsArea.id);
    const state = frame.stateOf(systemsArea.id) as SystemsAreaState;
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
    frame.activate(systemsArea.id);
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
    frame.activate(systemsArea.id);
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

describe('клавиатура рельса', () => {
  it('стрелки водят по знакам и сразу переключают область', () => {
    const { frame } = buildFrame();
    const rail = findAll(frame.view(), (node) => node.classes?.includes('fx-rail') === true)[0];
    expect(keydown(rail, 'ArrowDown')).toBe(true);
    expect(frame.activeAreaId()).toBe(systemsArea.id);
  });
});
