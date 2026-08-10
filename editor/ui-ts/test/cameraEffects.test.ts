/**
 * Секция эффектов камеры в редакторе (ED-14, ASSET-8, CAM-9): операции правки
 * (ED-29), две таблицы в зоне инспектора (ED-24) и оба сценария ED-14.
 *
 * Главное, что здесь пиннится, — что перечня типов у редактора нет: обе
 * таблицы, оба выпадающих списка и поля записи строятся из ОПИСАНИЯ, и
 * подставленное описание с выдуманным типом обязано работать без единой правки
 * кода редактора. Проверить это иначе нельзя: на настоящем описании код с
 * зашитым списком `['shake', 'sway']` вёл бы себя ровно так же.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryHost,
  runOperationRoundTrip,
  type EditorSession,
  type JsonValue,
} from '@game-mvp/editor-core';
import {
  CAMERA_EFFECTS_DESCRIPTION,
  type CameraEffectsCatalog,
} from '@game-mvp/render';
import { validateManifest, type CameraEffectsDescription } from '@game-mvp/assets';
import { findAll, type UiNode } from '../src/dom/node.js';
import {
  CAMERA_EFFECTS_OPERATIONS,
  EVENTS_TABLE,
  STATES_TABLE,
  bindingOf,
  cameraEffectsOperations,
  emittedEventTypes,
} from '../src/areas/assetCameraEffects.js';
import { createAssetArea, type AssetAreaState } from '../src/areas/assets.js';
import { fakeStage, settle } from './support/project.js';
import { buildFrame, buttonByKey, press } from './support/frame.js';

const VISUALS = 'visuals/manifest.json';
const SCENE = 'scenes/duel.scene.json';

/** Манифест фикстуры: настоящий — он проходит `validateManifest`. */
const MANIFEST = {
  entities: { Hero: { model: 'visuals/models/hero.mdx' } },
  cameraEffects: {
    events: { FireballExploded: { effect: 'shake', amplitude: 0.45, radius: 14 } },
  },
};

/** Сцена с событием: из её литералов собирается подсказка имён (ED-14). */
const SCENE_VALUE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [{ name: 'Hero', components: { Position: {} } }],
  systems: [
    {
      name: 'die',
      order: 1,
      query: { all: ['Position'] },
      do: [{ emitEvent: { type: 'EntityDied', data: {} } }],
    },
  ],
};

/** Сессия с открытым манифестом и тем же реестром операций, что у приложения. */
function scratch(value: JsonValue = MANIFEST): EditorSession {
  const { session } = buildFrame([createAssetArea()]);
  session.openDocument({ id: VISUALS, kind: 'visuals', value });
  return session;
}

/** Выдуманное описание: тип, которого в камере нет, — так выглядит новая сборка. */
const INVENTED: CameraEffectsCatalog = {
  types: [
    ...CAMERA_EFFECTS_DESCRIPTION.types,
    {
      id: 'gust',
      kind: 'impulse',
      params: [{ name: 'power', defaultValue: 1, min: 0, max: 5 }],
      create: () => ({ trigger: () => undefined, update: () => true }),
    },
  ],
  binding: CAMERA_EFFECTS_DESCRIPTION.binding,
};

const sectionOf = (session: EditorSession, table: string, name: string) =>
  bindingOf(session.documentValue(VISUALS), table, name);

describe('ED-29: каждая операция секции эффектов обратима', () => {
  it.each([
    [CAMERA_EFFECTS_OPERATIONS.bind, { table: EVENTS_TABLE, name: 'Boom', effect: 'shake' }],
    [
      CAMERA_EFFECTS_OPERATIONS.setParam,
      { table: EVENTS_TABLE, name: 'FireballExploded', param: 'decay', value: 2 },
    ],
  ])('«применить, отменить, сравнить» проходит для %s', (operationId, params) => {
    const result = runOperationRoundTrip(scratch(), operationId, { document: VISUALS, ...params });
    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });

  it('в наборе ровно две операции: удаление делает `document.removeValue`', () => {
    // Отсутствие операции удаления — не пробел, а решение (ED-29): доменная
    // операция ради переименования уже имеющегося действия не заводится.
    expect(cameraEffectsOperations().map((operation) => operation.id)).toEqual([
      CAMERA_EFFECTS_OPERATIONS.bind,
      CAMERA_EFFECTS_OPERATIONS.setParam,
    ]);
    const session = scratch();
    session.applyOperation('document.removeValue', {
      document: VISUALS,
      path: ['cameraEffects', 'events', 'FireballExploded'],
    });
    expect(sectionOf(session, EVENTS_TABLE, 'FireballExploded')).toBeNull();
  });
});

describe('ED-14: привязка пишется операцией и без интерфейса', () => {
  it('привязка пишет только тип: чисел операция не подставляет', () => {
    const session = scratch();
    session.applyOperation(CAMERA_EFFECTS_OPERATIONS.bind, {
      document: VISUALS,
      table: EVENTS_TABLE,
      name: 'Boom',
      effect: 'shake',
    });
    // Умолчания знает код камеры (CAM-9): записанное умолчание раздувает дифф
    // и врёт, если умолчание в коде поменяют (ED-21).
    expect(sectionOf(session, EVENTS_TABLE, 'Boom')).toEqual({ effect: 'shake' });
  });

  it('перетипизация снимает числа, которых новый тип не объявляет', () => {
    // Настоящей второй импульсный тип у сборки один, поэтому перетипизация
    // проверяется на подставленном описании — так же, как её увидит автор в
    // сборке камеры с новым типом (ED-14).
    const { session } = buildFrame([createAssetArea()], 'ru', { cameraEffects: INVENTED });
    session.openDocument({
      id: VISUALS,
      kind: 'visuals',
      value: {
        entities: MANIFEST.entities,
        cameraEffects: {
          events: { Boom: { effect: 'shake', maxOffset: 0.5, amplitude: 0.7 } },
        },
      },
    });
    session.applyOperation(CAMERA_EFFECTS_OPERATIONS.bind, {
      document: VISUALS,
      table: EVENTS_TABLE,
      name: 'Boom',
      effect: 'gust',
    });
    // `maxOffset` новый тип не объявляет — число снято: иначе автор остался бы
    // с числом, на которое валидация тут же ругается (ASSET-8). Параметр
    // привязки общий для вида и потому остаётся.
    expect(sectionOf(session, EVENTS_TABLE, 'Boom')).toEqual({ effect: 'gust', amplitude: 0.7 });
    // Потеря обратима одним undo (ED-18).
    session.undo();
    expect(sectionOf(session, EVENTS_TABLE, 'Boom')).toEqual({
      effect: 'shake',
      maxOffset: 0.5,
      amplitude: 0.7,
    });
  });

  it('незаявленный параметр и значение вне диапазона операция отвергает', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(CAMERA_EFFECTS_OPERATIONS.setParam, {
        document: VISUALS,
        table: EVENTS_TABLE,
        name: 'FireballExploded',
        param: 'loudness',
        value: 1,
      }),
    ).toThrow(/loudness/);
    expect(() =>
      session.applyOperation(CAMERA_EFFECTS_OPERATIONS.setParam, {
        document: VISUALS,
        table: EVENTS_TABLE,
        name: 'FireballExploded',
        param: 'amplitude',
        value: -1,
      }),
    ).toThrow(/диапазон/);
    // Полуправок отказ не оставляет: записанное упавшей операцией откатывает
    // слой операций (ED-29).
    expect(sectionOf(session, EVENTS_TABLE, 'FireballExploded')).toEqual({
      effect: 'shake',
      amplitude: 0.45,
      radius: 14,
    });
  });

  it('тип не того вида, что таблица, и неизвестный тип операция отвергает', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(CAMERA_EFFECTS_OPERATIONS.bind, {
        document: VISUALS,
        table: STATES_TABLE,
        name: 'Drunk',
        effect: 'shake',
      }),
    ).toThrow(/impulse|lasting/);
    expect(() =>
      session.applyOperation(CAMERA_EFFECTS_OPERATIONS.bind, {
        document: VISUALS,
        table: EVENTS_TABLE,
        name: 'Boom',
        effect: 'wobble-3000',
      }),
    ).toThrow(/wobble-3000/);
  });

  it('число назначается только существующей привязке: тип у записи обязателен', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(CAMERA_EFFECTS_OPERATIONS.setParam, {
        document: VISUALS,
        table: EVENTS_TABLE,
        name: 'Missing',
        param: 'amplitude',
        value: 1,
      }),
    ).toThrow(/Missing/);
  });
});

// ------------------------------------------------------------ интерфейс

interface Fixture {
  readonly state: AssetAreaState;
  readonly session: EditorSession;
  view(): UiNode;
}

async function areaWith(description: CameraEffectsDescription): Promise<Fixture> {
  const host = createMemoryHost({
    name: 'camera-effects-fixture',
    root: { label: 'fixture' },
    files: { [VISUALS]: JSON.stringify(MANIFEST) },
  });
  const area = createAssetArea({
    host,
    visuals: VISUALS,
    cameraEffects: description,
    stage: (_host, hooks) => fakeStage(hooks.announce),
  });
  // Описание приносит сборка — и области, и операциям сразу: разными они были
  // бы двумя ответами на вопрос «какие типы бывают» (CAM-9).
  const fixture = buildFrame([area], 'ru', { cameraEffects: description });
  const state = fixture.frame.stateOf(area.id) as AssetAreaState;
  await settle();
  fixture.frame.view();
  // Сцена открыта рядом с манифестом: из неё собираются подсказки имён событий.
  fixture.session.openDocument({ id: SCENE, kind: 'scene', value: SCENE_VALUE });
  return { state, session: fixture.session, view: () => fixture.frame.view() };
}

/** Значения выпадающего списка по подписи ячейки таблицы полей. */
function optionsOf(root: UiNode, label: string): readonly string[] {
  const select = findAll(root, (node) => node.labels?.ariaLabel?.key === label)[0];
  if (select === undefined) throw new Error(`нет списка с подписью "${label}"`);
  return findAll(select, (node) => node.tag === 'option').map(
    (node) => node.attrs?.value ?? '',
  );
}

/** Подписи строк таблицы полей — по ним видно, какие поля показаны. */
function fieldLabels(root: UiNode): readonly string[] {
  return findAll(root, (node) => node.classes?.includes('fx-field-row__label') === true)
    .flatMap((node) => findAll(node, (inner) => inner.tag === 'span'))
    .map((node) => node.text?.value ?? '');
}

describe('ED-14: «Тряска от взрыва без правки JSON»', () => {
  it('автор заводит привязку в таблице событий, и на диск уходит валидная секция', async () => {
    const fixture = await areaWith(CAMERA_EFFECTS_DESCRIPTION);
    fixture.state.effectTable = EVENTS_TABLE;
    fixture.state.effectName = 'Explosion';
    fixture.state.effectType = 'shake';
    press(buttonByKey(fixture.view(), 'ui.area.assets.effectBind'));

    const record = bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'Explosion');
    expect(record).toEqual({ effect: 'shake' });
    // Правка пришла операцией, а значит отменяема историей сессии (ED-18).
    fixture.session.undo();
    expect(bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'Explosion')).toBeNull();
    fixture.session.redo();

    // Сила импульса — тем же путём: одно число одной операцией.
    fixture.session.applyOperation(CAMERA_EFFECTS_OPERATIONS.setParam, {
      document: VISUALS,
      table: EVENTS_TABLE,
      name: 'Explosion',
      param: 'amplitude',
      value: 0.8,
    });
    const checked = validateManifest(fixture.session.documentValue(VISUALS), {
      cameraEffects: CAMERA_EFFECTS_DESCRIPTION,
    });
    expect(checked.ok).toBe(true);
    expect(checked.warnings).toEqual([]);
  });

  it('имена событий подсказываются открытыми сценами, но проверкой не становятся', async () => {
    const fixture = await areaWith(CAMERA_EFFECTS_DESCRIPTION);
    expect(emittedEventTypes(SCENE_VALUE)).toEqual(['EntityDied']);
    expect(optionsOf(fixture.view(), 'ui.area.assets.effectSuggested')).toEqual([
      '',
      'EntityDied',
    ]);
    // Имя, которого в сценах нет, привязать всё равно можно: машинного перечня
    // типов событий тика не существует, и запрещать по подсказке нельзя.
    fixture.state.effectName = 'NeverEmitted';
    fixture.state.effectType = 'shake';
    press(buttonByKey(fixture.view(), 'ui.area.assets.effectBind'));
    expect(fixture.state.failure).toBeNull();
    expect(
      bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'NeverEmitted'),
    ).toEqual({ effect: 'shake' });
  });
});

describe('ED-14: привязка снимается из таблицы, а не правкой JSON', () => {
  it('кнопка выбранной строки снимает запись общей операцией', async () => {
    const fixture = await areaWith(CAMERA_EFFECTS_DESCRIPTION);
    fixture.state.effectTable = EVENTS_TABLE;
    fixture.state.effectBinding = 'FireballExploded';
    press(buttonByKey(fixture.view(), 'ui.area.assets.effectRemove'));

    expect(
      bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'FireballExploded'),
    ).toBeNull();
    expect(fixture.state.failure).toBeNull();
    // Своей операции у снятия нет — значит, оно тоже история сессии (ED-18).
    fixture.session.undo();
    expect(
      bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'FireballExploded'),
    ).toEqual({ effect: 'shake', amplitude: 0.45, radius: 14 });
  });

  it('запись с типом, которого описание не знает, снимается тоже', async () => {
    // Именно её автор и захочет удалить: ED-14 подсвечивает такую запись
    // находкой, а до диска доводить её не следует (ASSET-8).
    const fixture = await areaWith(CAMERA_EFFECTS_DESCRIPTION);
    fixture.session.applyOperation('document.setValue', {
      document: VISUALS,
      path: ['cameraEffects', 'events', 'Stale'],
      value: { effect: 'wobble-3000' },
    });
    fixture.state.effectTable = EVENTS_TABLE;
    fixture.state.effectBinding = 'Stale';
    press(buttonByKey(fixture.view(), 'ui.area.assets.effectRemove'));
    expect(bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'Stale')).toBeNull();
  });
});

describe('ED-14: «Новый тип эффекта в коде камеры»', () => {
  it('тип из подставленного описания появляется в таблице сам — редактор не правится', async () => {
    const fixture = await areaWith(INVENTED);
    // Перечень типов таблицы событий — из описания, отфильтрованного по виду.
    expect(optionsOf(fixture.view(), 'ui.area.assets.effectType')).toEqual(['', 'shake', 'gust']);

    fixture.state.effectName = 'Gale';
    fixture.state.effectType = 'gust';
    press(buttonByKey(fixture.view(), 'ui.area.assets.effectBind'));
    expect(bindingOf(fixture.session.documentValue(VISUALS), EVENTS_TABLE, 'Gale')).toEqual({
      effect: 'gust',
    });

    // Поля записи — параметры типа плюс параметры привязки его вида (CAM-9).
    fixture.state.effectTable = EVENTS_TABLE;
    fixture.state.effectBinding = 'Gale';
    const labels = fieldLabels(fixture.view());
    expect(labels).toContain('power');
    expect(labels).toContain('amplitude');
    expect(labels).toContain('radius');
  });

  it('длящаяся таблица показывает только длящиеся типы: вид фильтрует, а не список', async () => {
    const fixture = await areaWith(INVENTED);
    fixture.state.effectTable = STATES_TABLE;
    expect(optionsOf(fixture.view(), 'ui.area.assets.effectType')).toEqual(['', 'sway']);
  });
});
