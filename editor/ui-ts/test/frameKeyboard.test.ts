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
 */
import { describe, expect, it } from 'vitest';
import { findAll, type UiNode } from '../src/dom/node.js';
import { ROVING_ATTR, rovingTarget } from '../src/dom/roving.js';
import { RAIL_ROVING_ID } from '../src/frame/rail.js';
import { sceneArea, type SceneAreaState } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';
import { attr, buildFrame, keydown, withAttr } from './support/frame.js';

function tabStops(view: UiNode): string[] {
  return findAll(view, (node) => attr(node, 'tabindex') === '0').map(
    (node) => attr(node, 'data-area') ?? attr(node, 'data-id') ?? node.tag,
  );
}

function treeOf(view: UiNode): UiNode | undefined {
  return withAttr(view, ROVING_ATTR).find((node) => attr(node, ROVING_ATTR) === 'scene-tree');
}

describe('обход скелета: одна остановка Tab на список, а не сотня', () => {
  it('в дереве навигатора ровно одна строка достижима табуляцией', () => {
    const { frame } = buildFrame();
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

  it('остановок Tab в области немного, и они не растут с числом строк', () => {
    const { frame } = buildFrame();
    // Рельс, строка дерева, поле поиска и кнопки бара — но не каждая запись.
    expect(tabStops(frame.view()).length).toBeLessThanOrEqual(4);
  });
});

describe('roving-фокус в дереве навигатора', () => {
  it('стрелка вниз переводит фокус на следующую видимую строку', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
    const before = state.focusId;
    expect(keydown(treeOf(frame.view()), 'ArrowDown')).toBe(true);
    expect(state.focusId).not.toBe(before);
  });

  it('стрелка влево сворачивает раскрытый узел, а не уводит фокус', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
    const root = state.focusId;
    expect(state.expanded.has(root)).toBe(true);
    keydown(treeOf(frame.view()), 'ArrowLeft');
    expect(state.expanded.has(root)).toBe(false);
    expect(state.focusId).toBe(root);
  });

  it('стрелка вправо раскрывает свёрнутый узел', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
    const root = state.focusId;
    keydown(treeOf(frame.view()), 'ArrowLeft');
    keydown(treeOf(frame.view()), 'ArrowRight');
    expect(state.expanded.has(root)).toBe(true);
  });

  it('свёрнутый узел прячет своих детей и из обхода тоже', () => {
    const { frame } = buildFrame();
    const visible = (): number =>
      findAll(frame.view(), (node) => attr(node, 'role') === 'treeitem').length;
    const before = visible();
    keydown(treeOf(frame.view()), 'ArrowLeft');
    expect(visible()).toBeLessThan(before);
  });

  it('Enter выделяет строку под фокусом', () => {
    const { frame } = buildFrame();
    keydown(treeOf(frame.view()), 'ArrowDown');
    keydown(treeOf(frame.view()), 'Enter');
    expect(frame.selection.get(sceneArea.id)).toHaveLength(1);
  });

  it('End и Home доходят до краёв и за них не уходят', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
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

  it('клавиша не про перемещение остаётся вызывающему', () => {
    expect(rovingTarget('KeyA', 0, 5)).toBeUndefined();
    expect(keydown(treeOf(buildFrame().frame.view()), 'KeyA')).toBe(false);
  });
});

describe('возврат фокуса и Escape', () => {
  it('контейнеры помечены — по пометке фокус и возвращается после перерисовки', () => {
    const { frame } = buildFrame();
    const containers = withAttr(frame.view(), ROVING_ATTR).map((node) => attr(node, ROVING_ATTR));
    expect(containers).toContain(RAIL_ROVING_ID);
    expect(containers).toContain('scene-tree');
    // Пометка ставится вместе с остановкой Tab: контейнер без неё нечем найти.
    for (const container of withAttr(frame.view(), ROVING_ATTR)) {
      expect(findAll(container, (node) => attr(node, 'tabindex') === '0').length).toBe(1);
    }
  });

  it('свёрнутый узел не уносит с собой единственную остановку Tab', () => {
    const { frame } = buildFrame();
    const state = frame.stateOf(sceneArea.id) as SceneAreaState;
    // Фокус уходит вглубь, а потом узел над ним сворачивается извне — нажатием
    // на треугольник, а не стрелкой. Строка под фокусом перестаёт быть видимой.
    keydown(treeOf(frame.view()), 'End');
    expect(state.expanded.delete('initial')).toBe(true);
    const tree = treeOf(frame.view());
    expect(findAll(tree ?? { tag: 'div' }, (node) => attr(node, 'tabindex') === '0')).toHaveLength(1);
  });

  it('Escape просит вернуть фокус к рельсу — единственному месту, одинаковому во всех областях', () => {
    const { frame } = buildFrame();
    expect(frame.takeFocusRequest()).toBeUndefined();
    expect(frame.handleKey({ key: 'Escape', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.takeFocusRequest()).toBe(RAIL_ROVING_ID);
    // Просьба одноразовая: иначе фокус уезжал бы на каждую перерисовку.
    expect(frame.takeFocusRequest()).toBeUndefined();
  });
});
