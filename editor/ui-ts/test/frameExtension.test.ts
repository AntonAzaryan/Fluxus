/**
 * ED-25: «Добавление вклада MUST NOT требовать изменений в уже
 * зарегистрированных вкладах и в каркасе».
 *
 * Утверждение это проверяемое, и проверяется оно единственным честным
 * способом: в тесте объявляется рабочая область, о которой пакет ничего не
 * знает — её нет ни в исходниках, ни в ресурсах, ни в приложении, — и она
 * регистрируется в тот же реестр. Если каркас где-то знает набор областей
 * помимо реестра, эта область до рельса не доедет; если скелет собран под
 * известные области, её зоны встанут не так.
 *
 * Второй половиной того же требования служит `frameDomain.test.ts`: каркас, в
 * котором нет доменных имён, не может ветвиться по виду редактируемого, даже
 * если бы захотел.
 */
import { describe, expect, it } from 'vitest';
import { documentValue, el, findAll } from '../src/dom/node.js';
import type { AreaZones, WorkspaceArea } from '../src/frame/area.js';
import { RAIL_ITEM_CLASS } from '../src/frame/rail.js';
import { ZONE_ORDER } from '../src/frame/skeleton.js';
import { sceneArea } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';
import { attr, buildFrame, press, withAttr } from './support/frame.js';

/** Состояние чужой области: каркас его не читает и прочесть не может. */
interface OutsiderState {
  visits: number;
}

/**
 * Область, которой в пакете нет. Ключ описания и подпись указывают на ресурсы,
 * которых тоже нет: ED-28 требует показывать сам ключ, и это здесь кстати —
 * область не одалживает у пакета даже строк.
 */
const outsiderArea: WorkspaceArea<OutsiderState> = {
  id: 'area.outsider',
  descriptionKey: 'outsider.description',
  labelKey: 'outsider.label',
  hotkey: 'F8',
  icon: 'search',
  editableTypes: [{ id: 'outsider', descriptionKey: 'outsider.editable' }],
  createState: () => ({ visits: 0 }),
  render(context): AreaZones {
    context.state.visits++;
    const mark = (zone: string): ReturnType<typeof el> =>
      el('div', { attrs: { 'data-outsider': zone }, text: documentValue(zone) });
    return { navigator: mark('nav'), surface: mark('surface'), inspector: mark('inspector') };
  },
};

const withOutsider = (): ReturnType<typeof buildFrame> =>
  buildFrame([sceneArea, systemsArea, outsiderArea]);

describe('ED-25: новая рабочая область не правит ни каркас, ни соседние вклады', () => {
  it('регистрация добавляет знак в рельс — и ничего больше не требует', () => {
    const before = buildFrame().frame.view();
    const after = withOutsider().frame.view();
    const items = (view: typeof before): string[] =>
      findAll(view, (node) => node.classes?.includes(RAIL_ITEM_CLASS) === true).map(
        (node) => attr(node, 'data-area') ?? '',
      );
    expect(items(before)).not.toContain(outsiderArea.id);
    expect(items(after)).toContain(outsiderArea.id);
  });

  it('чужая область получает тот же скелет, что и свои', () => {
    const { frame } = withOutsider();
    frame.activate(outsiderArea.id);
    const zones = withAttr(frame.view(), 'data-zone');
    expect(zones.map((zone) => attr(zone, 'data-zone'))).toEqual([...ZONE_ORDER]);
    // И содержимое каждой зоны — то, что положила область, а не что-то ещё.
    expect(withAttr(frame.view(), 'data-outsider').map((node) => attr(node, 'data-outsider'))).toEqual([
      'nav',
      'surface',
      'inspector',
    ]);
  });

  it('её горячая клавиша работает так же, как у своих', () => {
    const { frame } = withOutsider();
    expect(frame.handleKey({ key: 'F8', ctrl: false, shift: false, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(outsiderArea.id);
  });

  it('её состояние живёт по тем же правилам: заводится раз и переживает уход', () => {
    const { frame } = withOutsider();
    frame.activate(outsiderArea.id);
    frame.view();
    const state = frame.stateOf(outsiderArea.id) as OutsiderState;
    const visits = state.visits;
    frame.activate(sceneArea.id);
    frame.view();
    frame.activate(outsiderArea.id);
    frame.view();
    expect(frame.stateOf(outsiderArea.id)).toBe(state);
    expect(state.visits).toBeGreaterThan(visits);
  });

  it('её выделение живёт в той же сквозной модели', () => {
    const { frame } = withOutsider();
    frame.selection.set(outsiderArea.id, ['whatever']);
    expect(frame.selection.get(outsiderArea.id)).toEqual(['whatever']);
    expect(frame.selection.get(sceneArea.id)).toEqual([]);
  });

  it('соседние вклады о ней не знают и не меняются от её появления', () => {
    const alone = buildFrame([sceneArea]);
    const crowded = withOutsider();
    alone.frame.activate(sceneArea.id);
    crowded.frame.activate(sceneArea.id);
    const zoneOf = (fixture: typeof alone, name: string): unknown =>
      withAttr(fixture.frame.view(), 'data-zone').find(
        (zone) => attr(zone, 'data-zone') === name,
      )?.children;
    for (const name of ZONE_ORDER) {
      expect(JSON.stringify(zoneOf(alone, name))).toBe(JSON.stringify(zoneOf(crowded, name)));
    }
  });

  it('переключение на неё и обратно ничего не ломает в истории сессии', () => {
    const { frame, session } = withOutsider();
    frame.activate(systemsArea.id);
    press(findAll(frame.view(), (node) => attr(node, 'role') === 'switch')[0]);
    frame.activate(outsiderArea.id);
    expect(frame.canUndo()).toBe(true);
    frame.undo();
    expect(session.canUndo()).toBe(false);
  });
});

describe('ED-25: реестр не пускает двоих на одну горячую клавишу', () => {
  it('вторая область с той же клавишей не регистрируется', () => {
    expect(() => buildFrame([sceneArea, { ...outsiderArea, id: 'area.twin', hotkey: 'F1' }])).toThrow();
  });

  /**
   * Сочетания каркаса вкладом не объявлены, и реестр про них не знает: он
   * сравнивает вклады между собой. Каркас разбирает своё раньше вкладов
   * (ED-18, ED-23: история сквозная и область не должна уметь её отобрать), и
   * область, объявившая отмену, не получила бы ни одного нажатия. Молчание
   * здесь хуже отказа: неработающая клавиша выглядит как сломанная клавиатура,
   * а не как непринятый вклад.
   */
  it.each(['Ctrl+Z', 'Shift+Ctrl+Z', 'Escape'])('область не забирает сочетание каркаса: %s', (hotkey) => {
    expect(() => buildFrame([sceneArea, { ...outsiderArea, hotkey }])).toThrow(/каркас/);
  });

  it('а не занятое каркасом сочетание принимается как есть', () => {
    const { frame } = buildFrame([sceneArea, { ...outsiderArea, hotkey: 'Ctrl+Shift+O' }]);
    expect(frame.handleKey({ key: 'o', ctrl: true, shift: true, alt: false })).toBe(true);
    expect(frame.activeAreaId()).toBe(outsiderArea.id);
  });
});
