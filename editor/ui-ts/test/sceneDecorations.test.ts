/**
 * Слой декораций редактора (ED-16, ED-17, ED-19, `presentation-scene` PRES-2,
 * PRES-3, PRES-5): что уезжает в парный документ и как оно адресуется.
 *
 * Документ здесь — черновой проект в памяти, а не сцена репозитория: правка
 * контента тестом была бы правкой контента (CONT-1), а не проверкой редактора.
 *
 * Инварианты, которые здесь пиннятся:
 *
 * - порядок записей сохраняется: новое дописывается в конец (PRES-2);
 * - квантование делает операция и делает его ВЫЗОВОМ модуля формата (PRES-3);
 * - выделение сим-объекта и декорации единообразно, а удаление обоих — одна
 *   операция и одна запись истории (ED-16, ED-17, ED-18);
 * - перевод между слоями переносит объект и не оставляет его в обоих
 *   документах сразу, а погрешности двух направлений разные (PRES-5).
 */
import { fixed } from '@game-mvp/core';
import {
  createEditorSession,
  createOperationRegistry,
  getAtPath,
  registerBuiltinOperations,
  runOperationRoundTrip,
  type EditorSession,
  type JsonValue,
} from '@game-mvp/editor-core';
import {
  DECORATION_POSITION_STEP,
  DECORATION_YAW_STEP,
  presentationPathOf,
} from '@game-mvp/assets';
import { describe, expect, it } from 'vitest';
import {
  DECORATION_AUTHORING_OPERATIONS,
  DECORATION_OPERATIONS,
  registerDecorationOperations,
} from '../src/areas/sceneDecorations.js';
import {
  PLACEMENT_OPERATIONS,
  bindingParam,
  registerPlacementOperations,
} from '../src/areas/scenePlacement.js';
import { decorationsOf, type PositionBinding } from '../src/areas/sceneDocuments.js';
import { DECORATION_LIST, PLACEMENT_LIST, SCENE_KINDS } from '../src/areas/sceneProject.js';
import {
  FIXTURE_IDS,
  FIXTURE_PRESENTATION,
  FIXTURE_PRESENTATION_ID,
  FIXTURE_SCENE,
} from './support/project.js';

const BINDING: PositionBinding = {
  component: 'Position',
  x: 'x',
  y: 'y',
  rotation: { component: 'Position', field: 'turns' },
};

const SCRATCH_SCENE = {
  ...FIXTURE_SCENE,
  initial: [
    { prefab: 'Hero', overrides: { Position: { x: 65536, y: 131072, turns: 16384 } } },
    { prefab: 'Crate' },
  ],
};

function scratch(): EditorSession {
  const session = createEditorSession({
    operations: registerDecorationOperations(
      registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
    ),
  });
  session.openDocument({
    id: FIXTURE_IDS.config,
    kind: SCENE_KINDS.config,
    value: SCRATCH_SCENE as unknown as JsonValue,
    lists: [PLACEMENT_LIST],
  });
  session.openDocument({
    id: FIXTURE_PRESENTATION_ID,
    kind: SCENE_KINDS.presentation,
    value: structuredClone(FIXTURE_PRESENTATION) as unknown as JsonValue,
    lists: [DECORATION_LIST],
  });
  return session;
}

const layerOf = (session: EditorSession): readonly JsonValue[] =>
  getAtPath(session.documentValue(FIXTURE_PRESENTATION_ID), DECORATION_LIST) as readonly JsonValue[];

const fieldAt = (session: EditorSession, index: number, field: string): JsonValue | undefined =>
  getAtPath(session.documentValue(FIXTURE_PRESENTATION_ID), [...DECORATION_LIST, index, field]);

const decorationKeys = (session: EditorSession): readonly string[] =>
  session.descriptors(FIXTURE_PRESENTATION_ID, DECORATION_LIST);

const placementKeys = (session: EditorSession): readonly string[] =>
  session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);

// ------------------------------------------------------------ PRES-1, PRES-2

describe('PRES-1: парный документ — сосед по имени', () => {
  it('его путь выводится из пути сцены, а не берётся из ссылки', () => {
    expect(presentationPathOf(FIXTURE_IDS.config)).toBe(FIXTURE_PRESENTATION_ID);
    // Конфиг сцены о парном документе не знает: состав его полей закрыт (SER-7).
    expect(JSON.stringify(SCRATCH_SCENE)).not.toContain('presentation');
  });
});

describe('PRES-2: порядок записей и состав', () => {
  it('новая декорация дописывается в конец, соседи не двигаются', () => {
    const session = scratch();
    const before = decorationKeys(session);
    const outcome = session.applyOperation(DECORATION_OPERATIONS.add, {
      document: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
      x: 3.25,
      y: 0.5,
    });

    const list = layerOf(session);
    expect(list).toHaveLength(3);
    expect(getAtPath(list[2] ?? null, ['visual'])).toBe('Statue');
    // Прежние записи целы и на прежних местах.
    expect(getAtPath(list[0] ?? null, ['visual'])).toBe('Statue');
    expect(getAtPath(list[1] ?? null, ['scale'])).toBe(1.5);
    // Дескрипторы соседей те же, у новой записи — свой (ED-29).
    expect(decorationKeys(session).slice(0, 2)).toEqual([...before]);
    expect(outcome.result).toBe(decorationKeys(session)[2]);
  });

  it('нулевой курс полем не пишется: умолчание формата и есть ноль', () => {
    const session = scratch();
    session.applyOperation(DECORATION_OPERATIONS.add, {
      document: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
      x: 1,
      y: 1,
      turns: 0,
    });
    expect(fieldAt(session, 2, 'yaw')).toBeUndefined();
  });

  it('сим-полей в записи не появляется ни под каким именем (ED-19)', () => {
    const session = scratch();
    session.applyOperation(DECORATION_OPERATIONS.add, {
      document: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
      x: 1,
      y: 1,
    });
    const written = JSON.stringify(layerOf(session)[2]);
    expect(written).not.toContain('prefab');
    expect(written).not.toContain('overrides');
  });

  it('удаление соседа порядок остальных не трогает', () => {
    const session = scratch();
    const keys = decorationKeys(session);
    session.applyOperation(DECORATION_OPERATIONS.remove, {
      document: FIXTURE_PRESENTATION_ID,
      record: keys[0]!,
    });
    const list = layerOf(session);
    expect(list).toHaveLength(1);
    expect(getAtPath(list[0] ?? null, ['visual'])).toBe('Hero');
    expect(decorationKeys(session)).toEqual([keys[1]]);
  });
});

// ------------------------------------------------------------------- PRES-3

describe('PRES-3: квантование делает операция', () => {
  it('позиция уходит на шаг 10⁻³, курс — на 10⁻⁴ оборота', () => {
    const session = scratch();
    session.applyOperation(DECORATION_OPERATIONS.add, {
      document: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
      x: 3.14159265,
      y: -2.00149,
      turns: 0.123456789,
    });
    expect(fieldAt(session, 2, 'x')).toBe(3.142);
    expect(fieldAt(session, 2, 'y')).toBe(-2.001);
    expect(fieldAt(session, 2, 'yaw')).toBe(0.1235);
  });

  it('повторный жест в ту же точку даёт тот же документ', () => {
    const session = scratch();
    const key = decorationKeys(session)[0]!;
    const move = (x: number, y: number): void => {
      session.applyOperation(PLACEMENT_OPERATIONS.move, {
        document: FIXTURE_PRESENTATION_ID,
        record: key,
        x,
        y,
        layer: 'decoration',
      });
    };
    move(1.2345678, 4.7654321);
    const once = JSON.stringify(session.documentValue(FIXTURE_PRESENTATION_ID));
    move(1.23456789, 4.76543211);
    expect(JSON.stringify(session.documentValue(FIXTURE_PRESENTATION_ID))).toBe(once);
  });

  it('нечисловая величина в документ не попадает', () => {
    // Бесконечность отвергает уже схема параметров операции (ED-30) — до
    // `apply`; своей проверки квантователь тут не дублирует, а вот запись в
    // документ не случается ни при каком из двух отказов.
    const session = scratch();
    const key = decorationKeys(session)[0]!;
    expect(() =>
      session.applyOperation(PLACEMENT_OPERATIONS.move, {
        document: FIXTURE_PRESENTATION_ID,
        record: key,
        x: Number.POSITIVE_INFINITY,
        y: 0,
        layer: 'decoration',
      }),
    ).toThrow(/конечное число/);
    expect(fieldAt(session, 0, 'x')).toBe(1.5);
  });

  it('неизвестный слой отвергается, а не толкуется как сим-объект', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(PLACEMENT_OPERATIONS.move, {
        document: FIXTURE_PRESENTATION_ID,
        record: decorationKeys(session)[0]!,
        x: 1,
        y: 1,
        layer: 'props',
      }),
    ).toThrow(/layer/);
  });

  it('масштаб не превышающий нуля отвергается (PRES-2)', () => {
    const session = scratch();
    const key = decorationKeys(session)[0]!;
    expect(() =>
      session.applyOperation(DECORATION_OPERATIONS.scale, {
        document: FIXTURE_PRESENTATION_ID,
        record: key,
        scale: 0,
      }),
    ).toThrow(/превышать ноль/);
    session.applyOperation(DECORATION_OPERATIONS.scale, {
      document: FIXTURE_PRESENTATION_ID,
      record: key,
      scale: 2.0004,
    });
    expect(fieldAt(session, 0, 'scale')).toBe(2);
  });

  it('квантуется записываемое, а не прочитанное (ED-21)', () => {
    // Документ, написанный руками с большей точностью, «открыл — сохранил»
    // переживает байт-в-байт: правка одной записи чужих не касается.
    const session = createEditorSession({
      operations: registerDecorationOperations(
        registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
      ),
    });
    const handwritten = {
      decorations: [
        { visual: 'Statue', x: 1.23456789, y: 0.000000001 },
        { visual: 'Statue', x: 2, y: 2 },
      ],
    };
    session.openDocument({
      id: FIXTURE_PRESENTATION_ID,
      kind: SCENE_KINDS.presentation,
      value: handwritten,
      lists: [DECORATION_LIST],
    });
    session.applyOperation(PLACEMENT_OPERATIONS.move, {
      document: FIXTURE_PRESENTATION_ID,
      record: session.descriptors(FIXTURE_PRESENTATION_ID, DECORATION_LIST)[1]!,
      x: 5,
      y: 5,
      layer: 'decoration',
    });
    // Нетронутая запись — с прежней точностью, до последнего разряда.
    expect(fieldAt(session, 0, 'x')).toBe(1.23456789);
    expect(fieldAt(session, 0, 'y')).toBe(0.000000001);
  });
});

// ------------------------------------------------------------------- ED-29

describe('ED-29: каждая операция слоя обратима без следа', () => {
  const fixtures: Readonly<Record<string, (session: EditorSession) => Record<string, JsonValue>>> = {
    [DECORATION_OPERATIONS.add]: () => ({
      document: FIXTURE_PRESENTATION_ID,
      list: [...DECORATION_LIST],
      visual: 'Statue',
      x: 4.5,
      y: 6.5,
    }),
    [DECORATION_OPERATIONS.scale]: (session) => ({
      document: FIXTURE_PRESENTATION_ID,
      record: decorationKeys(session)[0]!,
      scale: 3,
    }),
    [DECORATION_OPERATIONS.toProp]: (session) => ({
      ...bindingParam(BINDING),
      document: FIXTURE_PRESENTATION_ID,
      record: decorationKeys(session)[0]!,
      target: FIXTURE_IDS.config,
      list: [...PLACEMENT_LIST],
      prefab: 'Crate',
    }),
    [DECORATION_OPERATIONS.fromProp]: (session) => ({
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: placementKeys(session)[0]!,
      target: FIXTURE_PRESENTATION_ID,
      list: [...DECORATION_LIST],
      visual: 'Statue',
    }),
  };

  it('у каждой зарегистрированной операции слоя есть заготовка', () => {
    // Табличный тест по набору, а не по списку здесь: операция, добавленная в
    // модуль и не проверенная, — красный тест, а не пропуск.
    expect(
      DECORATION_AUTHORING_OPERATIONS.map((operation) => operation.id).filter(
        (id) => !(id in fixtures),
      ),
    ).toEqual([]);
  });

  for (const operation of DECORATION_AUTHORING_OPERATIONS) {
    it(`${operation.id} обратима без следа`, () => {
      const session = scratch();
      const result = runOperationRoundTrip(session, operation.id, fixtures[operation.id]!(session));
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.recorded).toBe(true);
    });
  }

  /*
   * Перемещение и поворот — операции РАЗМЕЩЁННОГО, общие на оба слоя
   * (`proposal.md`, «Отступление реализации»), и слой у них параметр. Заготовка
   * сим-слоя стоит в `scenePlacement.test.ts`; здесь пиннится вторая ветка той
   * же операции — иначе «у каждой операции есть заготовка» держалось бы на
   * половине её кода.
   */
  it.each([
    [PLACEMENT_OPERATIONS.move, { x: 2.125, y: -3.75 }],
    [PLACEMENT_OPERATIONS.rotate, { turns: 0.375 }],
  ])('%s на слое decoration обратима без следа', (operationId, params) => {
    const session = scratch();
    const result = runOperationRoundTrip(session, operationId, {
      document: FIXTURE_PRESENTATION_ID,
      record: decorationKeys(session)[0]!,
      layer: 'decoration',
      ...params,
    });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(true);
  });
});

// ------------------------------------------- обязательные поля записи (PRES-2)

describe('PRES-2: `visual` — обязательная непустая строка', () => {
  it('постановка без вида в документ не пишется', () => {
    const session = scratch();
    expect(() =>
      session.applyOperation(DECORATION_OPERATIONS.add, {
        document: FIXTURE_PRESENTATION_ID,
        list: DECORATION_LIST,
        visual: '',
        x: 1,
        y: 1,
      }),
    ).toThrow(/непустая строка/);
    expect(layerOf(session)).toHaveLength(2);
  });

  it('prop без записи манифеста в декорацию не разжаловывается', () => {
    // У сим-объекта, чей prefab в манифесте не описан, вида нет вовсе, и
    // назвать его в записи decoration нечем: операция отказывает, а не пишет
    // пустой ключ, который её же формат отвергает.
    const session = scratch();
    expect(() =>
      session.applyOperation(DECORATION_OPERATIONS.fromProp, {
        ...bindingParam(BINDING),
        document: FIXTURE_IDS.config,
        record: placementKeys(session)[1]!,
        target: FIXTURE_PRESENTATION_ID,
        list: DECORATION_LIST,
        visual: '',
      }),
    ).toThrow(/непустая строка/);
    expect(layerOf(session)).toHaveLength(2);
    expect(
      getAtPath(session.documentValue(FIXTURE_IDS.config), PLACEMENT_LIST) as readonly JsonValue[],
    ).toHaveLength(2);
  });
});

// ------------------------------------------------------------------- PRES-5

describe('PRES-5: перевод между документами пары', () => {
  it('decoration → prop объект не двигает вовсе', () => {
    const session = scratch();
    const key = decorationKeys(session)[0]!;
    const before = { x: fieldAt(session, 0, 'x') as number, y: fieldAt(session, 0, 'y') as number };

    session.applyOperation(DECORATION_OPERATIONS.toProp, {
      ...bindingParam(BINDING),
      document: FIXTURE_PRESENTATION_ID,
      record: key,
      target: FIXTURE_IDS.config,
      list: PLACEMENT_LIST,
      prefab: 'Crate',
    });

    // Из парного документа запись исчезла, в расстановке — появилась в конец.
    expect(layerOf(session)).toHaveLength(1);
    const placements = getAtPath(
      session.documentValue(FIXTURE_IDS.config),
      PLACEMENT_LIST,
    ) as readonly JsonValue[];
    expect(placements).toHaveLength(3);
    const moved = placements[2]!;
    expect(getAtPath(moved, ['prefab'])).toBe('Crate');

    // Погрешность приведения ниже разрешения самой симуляции: обратное чтение
    // даёт ту же величину с точностью до половины кванта Q16.16.
    const rawX = getAtPath(moved, ['overrides', 'Position', 'x']) as number;
    const rawY = getAtPath(moved, ['overrides', 'Position', 'y']) as number;
    expect(Math.abs(fixed.toFloat(rawX) - before.x)).toBeLessThan(1 / 65536);
    expect(Math.abs(fixed.toFloat(rawY) - before.y)).toBeLessThan(1 / 65536);
  });

  it('prop → decoration смещает не больше чем на половину шага PRES-3', () => {
    const session = scratch();
    const key = placementKeys(session)[0]!;
    const raw = (field: string): number =>
      getAtPath(session.documentValue(FIXTURE_IDS.config), [
        ...PLACEMENT_LIST,
        0,
        'overrides',
        'Position',
        field,
      ]) as number;
    const before = { x: fixed.toFloat(raw('x')), y: fixed.toFloat(raw('y')), turns: fixed.toFloat(raw('turns')) };

    session.applyOperation(DECORATION_OPERATIONS.fromProp, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: key,
      target: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
    });

    const placements = getAtPath(
      session.documentValue(FIXTURE_IDS.config),
      PLACEMENT_LIST,
    ) as readonly JsonValue[];
    expect(placements).toHaveLength(1);
    const list = layerOf(session);
    expect(list).toHaveLength(3);
    const moved = list[2]!;
    expect(getAtPath(moved, ['visual'])).toBe('Statue');
    expect(Math.abs((getAtPath(moved, ['x']) as number) - before.x)).toBeLessThanOrEqual(
      DECORATION_POSITION_STEP / 2 + 1e-12,
    );
    expect(Math.abs((getAtPath(moved, ['y']) as number) - before.y)).toBeLessThanOrEqual(
      DECORATION_POSITION_STEP / 2 + 1e-12,
    );
    expect(Math.abs((getAtPath(moved, ['yaw']) as number) - before.turns)).toBeLessThanOrEqual(
      DECORATION_YAW_STEP / 2 + 1e-12,
    );
  });

  it('объект не остаётся в обоих документах сразу: перенос — одна операция', () => {
    const session = scratch();
    const outcome = session.applyOperation(DECORATION_OPERATIONS.toProp, {
      ...bindingParam(BINDING),
      document: FIXTURE_PRESENTATION_ID,
      record: decorationKeys(session)[0]!,
      target: FIXTURE_IDS.config,
      list: PLACEMENT_LIST,
      prefab: 'Crate',
    });
    // Одна запись истории на оба документа: отмена возвращает их вместе.
    expect(outcome.recorded).toBe(true);
    expect([...outcome.documentIds].sort()).toEqual(
      [FIXTURE_IDS.config, FIXTURE_PRESENTATION_ID].sort(),
    );
    expect(session.undo()).toBe(true);
    expect(layerOf(session)).toHaveLength(2);
    expect(
      (getAtPath(session.documentValue(FIXTURE_IDS.config), PLACEMENT_LIST) as readonly JsonValue[]),
    ).toHaveLength(2);
  });

  it('круговой перевод побайтового возврата не обещает — и тест его не требует', () => {
    // Обещание держалось бы на хранении неквантованного значения помимо
    // документов пары, то есть на третьем, невидимом носителе (PRES-5).
    const session = scratch();
    const key = placementKeys(session)[0]!;
    session.applyOperation(DECORATION_OPERATIONS.fromProp, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: key,
      target: FIXTURE_PRESENTATION_ID,
      list: DECORATION_LIST,
      visual: 'Statue',
    });
    const back = decorationKeys(session)[2]!;
    session.applyOperation(DECORATION_OPERATIONS.toProp, {
      ...bindingParam(BINDING),
      document: FIXTURE_PRESENTATION_ID,
      record: back,
      target: FIXTURE_IDS.config,
      list: PLACEMENT_LIST,
      prefab: 'Hero',
    });
    // Проверяется место на арене, а не байты: смещение круга — не больше
    // половины шага слоя, и это допустимо.
    const placements = getAtPath(
      session.documentValue(FIXTURE_IDS.config),
      PLACEMENT_LIST,
    ) as readonly JsonValue[];
    const restored = fixed.toFloat(
      getAtPath(placements.at(-1) ?? null, ['overrides', 'Position', 'x']) as number,
    );
    expect(Math.abs(restored - 1)).toBeLessThanOrEqual(DECORATION_POSITION_STEP / 2 + 1e-12);
  });
});

// -------------------------------------------------------------- производная

describe('ED-15: набор декораций — производная документа', () => {
  it('ключи записей — дескрипторы сессии, курс отдаётся и в оборотах, и в радианах', () => {
    const session = scratch();
    const keys = decorationKeys(session);
    const set = decorationsOf({
      config: session.documentValue(FIXTURE_IDS.config),
      presentation: session.documentValue(FIXTURE_PRESENTATION_ID),
      decorationKeys: keys,
    });
    expect(set.map((item) => item.key)).toEqual([...keys]);
    expect(set[0]).toMatchObject({ visual: 'Statue', kind: 'Statue', x: 1.5, y: 1.5, turns: 0 });
    expect(set[1]!.turns).toBe(0.25);
    expect(set[1]!.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(set[1]!.scale).toBe(1.5);
  });

  it('отсутствие парного документа — пустой набор, а не отказ (PRES-1)', () => {
    expect(decorationsOf({ config: SCRATCH_SCENE })).toEqual([]);
    expect(decorationsOf({ config: SCRATCH_SCENE, presentation: null })).toEqual([]);
    // Пустой и отсутствующий список неразличимы (PRES-2).
    expect(decorationsOf({ config: SCRATCH_SCENE, presentation: {} })).toEqual([]);
  });

  it('неразрешимая ссылка набор не гасит: рендер рисует заглушку (PRES-2)', () => {
    const set = decorationsOf({
      config: SCRATCH_SCENE,
      presentation: { decorations: [{ visual: 'Ghost', x: 0, y: 0 }] },
    });
    expect(set).toHaveLength(1);
    expect(set[0]!.kind).toBe('Ghost');
  });

  it('сломанный документ называет причину, а не роняет производную', () => {
    expect(() =>
      decorationsOf({ config: SCRATCH_SCENE, presentation: { decorations: [{ x: 1 }] } }),
    ).toThrow(/decorations\[0\]\.visual/);
  });
});
