/**
 * Клавиатура и фокус в каркасе: обход скелета, roving-фокус в дереве и
 * списке, возврат фокуса после перерисовки, Escape.
 *
 * Требования, которые здесь пиннятся, не написаны отдельным ED — они следуют
 * из ED-24 и ED-23 и потому сформулированы так:
 *
 * - скелет одинаков во всех областях (ED-24), значит и клавиатурный путь через
 *   него одинаков: три остановки Tab в порядке «навигатор — поверхность —
 *   инспектор», а не сотня остановок на строках дерева;
 * - переключение областей и отмена операции доступны с клавиатуры из любого
 *   места (ED-23, ED-18): каркас слушает клавиатуру документа, а не корня;
 * - перерисовка не должна выбрасывать автора из списка, по которому он идёт
 *   стрелками, — иначе клавиатурный обход не работает после первого же шага.
 *
 * Порядок разбора нажатия (ED-32) пиннится здесь же и без DOM: он записан
 * функцией `areaGetsKey`, а не разбросан по обработчикам, и потому проверяется
 * тем же способом, что и остальное в этом файле, — на описании страницы и на
 * самом каркасе. `mount.ts` поверх этого только подписывается на документ.
 */
import { describe, expect, it } from 'vitest';
import { findAll, type UiNode } from '../src/dom/node.js';
import { ROVING_ATTR, rovingTarget } from '../src/dom/roving.js';
import { RAIL_ROVING_ID } from '../src/frame/rail.js';
import { areaGetsKey, type AreaKeyGate } from '../src/frame/keys.js';
import { SURFACE_FOCUS_ID } from '../src/frame/skeleton.js';
import { CAMERA_KEYS } from '../src/areas/sceneCamera.js';
import { SCENE_AREA_KEYS, SCENE_NODES, sceneArea } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import {
  attr,
  buttonByKey,
  buildFrame,
  buildLoadedFrame,
  keydown,
  press,
  withAttr,
  zoneOf,
} from './support/frame.js';

/** Нажатие голой клавиши, не потреблённое ничем: так его видит последняя ступень. */
const bare = (gate: Partial<AreaKeyGate> = {}): AreaKeyGate => ({
  defaultPrevented: false,
  target: null,
  ctrl: false,
  shift: false,
  alt: false,
  ...gate,
});

const down = (code: string, repeat = false) => ({ code, phase: 'down' as const, repeat });

function tabStops(view: UiNode): string[] {
  return findAll(view, (node) => attr(node, 'tabindex') === '0').map(
    (node) => attr(node, 'data-area') ?? attr(node, 'data-id') ?? node.tag,
  );
}

function treeOf(view: UiNode): UiNode | undefined {
  return withAttr(view, ROVING_ATTR).find((node) => attr(node, ROVING_ATTR) === 'scene-tree');
}

describe('обход скелета: одна остановка Tab на список, а не сотня', () => {
  it('в дереве навигатора ровно одна строка достижима табуляцией', async () => {
    const { frame } = await buildLoadedFrame();
    const rows = findAll(frame.view(), (node) => attr(node, 'role') === 'treeitem');
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.filter((row) => attr(row, 'tabindex') === '0')).toHaveLength(1);
    expect(rows.filter((row) => attr(row, 'tabindex') === '-1').length).toBe(rows.length - 1);
  });

  it('то же в плоском списке другой области — правило обхода одно на оба виджета', () => {
    const { frame } = buildFrame();
    frame.activate(systemsArea.id);
    const rows = findAll(frame.view(), (node) => attr(node, 'role') === 'option');
    expect(rows.filter((row) => attr(row, 'tabindex') === '0')).toHaveLength(1);
  });

  it('в рельсе достижим табуляцией только знак активной области', () => {
    const { frame } = buildFrame();
    const items = findAll(frame.view(), (node) => attr(node, 'data-area') !== undefined);
    const stops = items.filter((item) => attr(item, 'tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(attr(stops[0] ?? { tag: 'div' }, 'data-area')).toBe(frame.activeAreaId());
  });

  it('остановок Tab в области немного, и они не растут с числом строк', async () => {
    const { frame } = await buildLoadedFrame();
    // Рельс, строка дерева, поле поиска и кнопки бара — но не каждая запись.
    expect(tabStops(frame.view()).length).toBeLessThanOrEqual(4);
  });
});

describe('roving-фокус в дереве навигатора', () => {
  it('стрелка вниз переводит фокус на следующую видимую строку', async () => {
    const { frame, state } = await buildLoadedFrame();
    const before = state.focusId;
    expect(keydown(treeOf(frame.view()), 'ArrowDown')).toBe(true);
    expect(state.focusId).not.toBe(before);
  });

  it('стрелка влево сворачивает раскрытый узел, а не уводит фокус', async () => {
    const { frame, state } = await buildLoadedFrame();
    const root = state.focusId;
    expect(state.expanded.has(root)).toBe(true);
    keydown(treeOf(frame.view()), 'ArrowLeft');
    expect(state.expanded.has(root)).toBe(false);
    expect(state.focusId).toBe(root);
  });

  it('стрелка вправо раскрывает свёрнутый узел', async () => {
    const { frame, state } = await buildLoadedFrame();
    const root = state.focusId;
    keydown(treeOf(frame.view()), 'ArrowLeft');
    keydown(treeOf(frame.view()), 'ArrowRight');
    expect(state.expanded.has(root)).toBe(true);
  });

  it('свёрнутый узел прячет своих детей и из обхода тоже', async () => {
    const { frame } = await buildLoadedFrame();
    const visible = (): number =>
      findAll(frame.view(), (node) => attr(node, 'role') === 'treeitem').length;
    const before = visible();
    keydown(treeOf(frame.view()), 'ArrowLeft');
    expect(visible()).toBeLessThan(before);
  });

  it('Enter выделяет строку под фокусом', async () => {
    const { frame, area } = await buildLoadedFrame();
    keydown(treeOf(frame.view()), 'ArrowDown');
    keydown(treeOf(frame.view()), 'Enter');
    expect(frame.selection.get(area.id)).toHaveLength(1);
  });

  it('End и Home доходят до краёв и за них не уходят', async () => {
    const { frame, state } = await buildLoadedFrame();
    const first = state.focusId;

    keydown(treeOf(frame.view()), 'End');
    const last = state.focusId;
    expect(last).not.toBe(first);
    keydown(treeOf(frame.view()), 'ArrowDown');
    expect(state.focusId).toBe(last);

    keydown(treeOf(frame.view()), 'Home');
    expect(state.focusId).toBe(first);
    keydown(treeOf(frame.view()), 'ArrowUp');
    expect(state.focusId).toBe(first);
  });

  it('клавиша не про перемещение остаётся вызывающему', async () => {
    const { frame } = await buildLoadedFrame();
    expect(rovingTarget('KeyA', 0, 5)).toBeUndefined();
    expect(keydown(treeOf(frame.view()), 'KeyA')).toBe(false);
  });
});

describe('возврат фокуса и Escape', () => {
  it('контейнеры помечены — по пометке фокус и возвращается после перерисовки', async () => {
    const { frame } = await buildLoadedFrame();
    const containers = withAttr(frame.view(), ROVING_ATTR).map((node) => attr(node, ROVING_ATTR));
    expect(containers).toContain(RAIL_ROVING_ID);
    expect(containers).toContain('scene-tree');
    // Пометка ставится вместе с остановкой Tab: контейнер без неё нечем найти.
    for (const container of withAttr(frame.view(), ROVING_ATTR)) {
      expect(findAll(container, (node) => attr(node, 'tabindex') === '0').length).toBe(1);
    }
  });

  it('свёрнутый узел не уносит с собой единственную остановку Tab', async () => {
    const { frame, state } = await buildLoadedFrame();
    // Фокус уходит вглубь, а потом узел над ним сворачивается извне — нажатием
    // на треугольник, а не стрелкой. Строка под фокусом перестаёт быть видимой.
    keydown(treeOf(frame.view()), 'End');
    expect(state.expanded.delete(SCENE_NODES.placements)).toBe(true);
    const tree = treeOf(frame.view());
    expect(findAll(tree ?? { tag: 'div' }, (node) => attr(node, 'tabindex') === '0')).toHaveLength(1);
  });

  it('Escape возвращает клавиатуру области, а не рельсу (ED-32)', () => {
    const { frame } = buildFrame();
    expect(frame.takeFocusRequest()).toBeUndefined();
    expect(frame.handleKey({ key: 'Escape', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.takeFocusRequest()).toBe(SURFACE_FOCUS_ID);
    // Просьба одноразовая: иначе фокус уезжал бы на каждую перерисовку.
    expect(frame.takeFocusRequest()).toBeUndefined();
  });

  it('место фокуса по умолчанию есть в скелете и клавиш области не потребляет', () => {
    const { frame } = buildFrame();
    const surface = zoneOf(frame.view(), 'surface');
    expect(attr(surface, 'id')).toBe(SURFACE_FOCUS_ID);
    // Не остановка Tab (обход страницы от него не удлиняется) и не
    // roving-контейнер: контейнер забрал бы стрелки у области.
    expect(attr(surface, 'tabindex')).toBe('-1');
    expect(attr(surface, ROVING_ATTR)).toBeUndefined();
    expect(surface.on?.keydown).toBeUndefined();
  });
});

/**
 * ED-32: «Нажатия SHALL разбираться в одном фиксированном порядке: сквозные
 * сочетания каркаса → виджет, держащий фокус, если он это нажатие потребляет →
 * активная рабочая область и её инструменты».
 */
describe('ED-32: клавиатура принадлежит активной области', () => {
  it('раскладка объявлена данными вклада и кодов в ней не повторяется', () => {
    const codes = SCENE_AREA_KEYS.map((key) => key.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    // Перечень один: он же питает подсказки (ED-31), поэтому в нём обязана
    // быть каждая клавиша, которая работает.
    expect(codes).toContain(CAMERA_KEYS.flyToggle);
    expect(codes).toContain(CAMERA_KEYS.panLeft);
    // Имя действия — ресурс (ED-27): раскладка, которую нечем показать, не
    // может быть единственным источником для подсказок (ED-31).
    for (const locale of ['ru', 'en']) {
      const resources = uiResources(locale);
      for (const key of SCENE_AREA_KEYS) {
        expect(resources.lookup(key.labelKey), `${locale}: ${key.labelKey}`).toBeDefined();
      }
    }
  });

  it('кнопка бара не отбирает стрелки: панорама работает сразу после нажатия', async () => {
    const { frame, state } = await buildLoadedFrame();
    // Нажатие кнопки бара — ровно тот случай, после которого «стрелки
    // переставали работать»: фокус уезжал с холста, и клавиши до камеры не
    // доходили.
    press(buttonByKey(frame.view(), 'ui.area.scene.zoomIn'));
    expect(areaGetsKey(bare())).toBe(true);
    expect(frame.handleAreaKey(down(CAMERA_KEYS.panLeft))).toBe(true);
    // Набор зажатого — то, что вьюпорт спрашивает каждым кадром (CAM-3).
    expect(state.held.has(CAMERA_KEYS.panLeft)).toBe(true);
    frame.handleAreaKey({ code: CAMERA_KEYS.panLeft, phase: 'up', repeat: false });
    expect(state.held.has(CAMERA_KEYS.panLeft)).toBe(false);
  });

  it('стрелка в дереве навигатора двигает подсветку и не двигает камеру', async () => {
    const { frame, state } = await buildLoadedFrame();
    const before = state.focusId;
    // Виджет нажатие потребляет — и «потреблено» здесь буквально
    // `preventDefault`, второго перечня виджетов для этого не заводится.
    expect(keydown(treeOf(frame.view()), 'ArrowDown')).toBe(true);
    expect(state.focusId).not.toBe(before);
    expect(areaGetsKey(bare({ defaultPrevented: true }))).toBe(false);
    expect(state.held.size).toBe(0);
  });

  it('набор текста в инспекторе клавиши области не отдаёт', async () => {
    const { frame, area, state } = await buildLoadedFrame();
    const key = state.draft?.placements[0]?.key;
    frame.selection.set(area.id, [key ?? '']);
    // Поля инспектора — настоящие текстовые цели, а не выдуманные имена тегов.
    const inputs = findAll(zoneOf(frame.view(), 'inspector'), (node) => node.tag === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(areaGetsKey(bare({ target: { tagName: 'INPUT' } }))).toBe(false);
    expect(areaGetsKey(bare({ target: { tagName: 'TEXTAREA' } }))).toBe(false);
    expect(areaGetsKey(bare({ target: { tagName: 'DIV', editable: true } }))).toBe(false);
    // Стрелка и буква инструмента — обе принадлежат набору, а не области.
    expect(areaGetsKey(bare({ target: { tagName: 'DIV' } }))).toBe(true);
  });

  it('сквозное сочетание раньше области: отмену область не получает', () => {
    const { frame } = buildFrame();
    expect(frame.handleKey({ key: 'z', ctrl: true, shift: false, alt: false })).toBe(true);
    // Забранное каркасом нажатие до области не доходит и по второму признаку:
    // сочетание с модификатором ей не достаётся вовсе.
    expect(areaGetsKey(bare({ ctrl: true }))).toBe(false);
    expect(areaGetsKey(bare({ alt: true }))).toBe(false);
    // Shift адресата не меняет: он меняет символ, а не то, кому нажатие.
    expect(areaGetsKey(bare({ shift: true }))).toBe(true);
  });

  it('вход в область горячей клавишей сразу даёт её клавиши', () => {
    const { frame } = buildFrame([sceneArea, systemsArea]);
    frame.activate(systemsArea.id);
    expect(frame.activeAreaId()).toBe(systemsArea.id);
    expect(frame.handleKey({ key: 'F1', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(sceneArea.id);
    // Фокус уходит на поверхность правки: оставленный в рельсе, он забрал бы
    // стрелки себе, и своих клавиш область не получила бы никогда.
    expect(frame.takeFocusRequest()).toBe(SURFACE_FOCUS_ID);
    expect(frame.handleAreaKey(down(CAMERA_KEYS.panLeft))).toBe(true);
  });

  it('потеря фокуса окном отпускает всё зажатое', async () => {
    const { frame, state } = await buildLoadedFrame();
    frame.handleAreaKey(down(CAMERA_KEYS.panRight));
    expect(state.held.size).toBe(1);
    frame.handleAreaKey({ code: '', phase: 'blur', repeat: false });
    expect(state.held.size).toBe(0);
  });

  it('клавиша не из раскладки области остаётся среде', async () => {
    const { frame } = await buildLoadedFrame();
    expect(frame.handleAreaKey(down('KeyZ'))).toBe(false);
  });
});
