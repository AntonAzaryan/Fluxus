/**
 * Операции расстановки (ED-16) как слой операций авторинга (ED-29): проверяется
 * то, что уезжает в документ, а не то, как оно выглядит на экране.
 *
 * Документ здесь — черновой проект в памяти, а не сцена репозитория: `initial`
 * сцены репозитория задаёт её `worldInit`, и правка его тестом была бы правкой
 * контента (CONT-1), а не проверкой редактора.
 *
 * Главные инварианты, которые здесь пиннятся:
 *
 * - порядок записей нормативен (SER-8): новое дописывается в конец, а
 *   перемещение соседей не переставляет;
 * - перемещение пишет только свои переопределения — чужие поля записи целы;
 * - квантование делает ядро (FP-1), и то, что ядро потом читает из документа,
 *   совпадает с тем, что редактор в него записал;
 * - непрерывное перетаскивание — одна запись истории (ED-18).
 */
import { fixed, FIXED_ONE } from '@game-mvp/core';
import {
  ContributionRegistry,
  createEditorSession,
  createOperationRegistry,
  createValidator,
  getAtPath,
  registerBuiltinOperations,
  registerValidationRules,
  runOperationRoundTrip,
  VISUAL_FOR_PREFAB_RULE,
  type EditorSession,
  type JsonValue,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { PLACEMENT_LIST, SCENE_KINDS, sceneValidationRules } from '../src/areas/sceneProject.js';
import {
  PLACEMENT_AUTHORING_OPERATIONS,
  PLACEMENT_OPERATIONS,
  bindingParam,
  quantized,
  registerPlacementOperations,
} from '../src/areas/scenePlacement.js';
import { placementsOf, type PositionBinding } from '../src/areas/sceneDocuments.js';
import { FIXTURE_IDS, FIXTURE_SCENE, FIXTURE_VISUALS } from './support/project.js';

/** Привязка чернового проекта: та же, что у ядра, плюс поворот (ED-16). */
const BINDING: PositionBinding = {
  component: 'Position',
  x: 'x',
  y: 'y',
  rotation: { component: 'Position', field: 'turns' },
};

/**
 * Черновой конфиг: у первой записи уже есть чужое переопределение — по нему и
 * видно, что перемещение пишет только своё.
 */
const SCRATCH = {
  ...FIXTURE_SCENE,
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed', turns: 'fixed' } }],
  prefabs: [
    { name: 'Hero', tags: ['Hero'], components: { Position: { x: 98304, y: 98304, turns: 0 } } },
    { name: 'Crate', tags: ['Crate'], components: { Position: { x: 163840, y: 98304, turns: 0 } } },
  ],
  initial: [
    { prefab: 'Hero', overrides: { Position: { turns: 16384 } } },
    { prefab: 'Crate' },
  ],
};

function scratchSession(): EditorSession {
  const session = createEditorSession({
    operations: registerPlacementOperations(registerBuiltinOperations(createOperationRegistry())),
  });
  session.openDocument({
    id: FIXTURE_IDS.config,
    kind: SCENE_KINDS.config,
    value: SCRATCH as unknown as JsonValue,
    lists: [PLACEMENT_LIST],
  });
  return session;
}

const listOf = (session: EditorSession): readonly JsonValue[] =>
  getAtPath(session.documentValue(FIXTURE_IDS.config), PLACEMENT_LIST) as readonly JsonValue[];

const overrideAt = (session: EditorSession, index: number, field: string): JsonValue | undefined =>
  getAtPath(session.documentValue(FIXTURE_IDS.config), [
    ...PLACEMENT_LIST,
    index,
    'overrides',
    'Position',
    field,
  ]);

describe('ED-16, SER-8: порядок записей нормативен', () => {
  it('новый инстанс дописывается в конец, а не куда придётся', () => {
    const session = scratchSession();
    const before = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    const outcome = session.applyOperation(PLACEMENT_OPERATIONS.add, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      list: PLACEMENT_LIST,
      prefab: 'Hero',
      x: 3.5,
      y: 2.25,
    });

    const list = listOf(session);
    expect(list).toHaveLength(3);
    expect(getAtPath(list[2] ?? null, ['prefab'])).toBe('Hero');
    // Дескрипторы прежних записей на месте и в том же порядке: ID выданного
    // прежде ничего не сдвинуло.
    const after = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toBe(outcome.result);
  });

  it('перемещение первой записи не переставляет вторую', () => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    const neighbour = listOf(session)[1];

    session.applyOperation(PLACEMENT_OPERATIONS.move, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: first ?? '',
      x: 0.5,
      y: 0.25,
    });

    const list = listOf(session);
    expect(list).toHaveLength(2);
    expect(getAtPath(list[0] ?? null, ['prefab'])).toBe('Hero');
    // Сосед — тот же объект: перемещение не переписало ни его, ни его место.
    expect(list[1]).toBe(neighbour);
  });

  it('операции расстановки не умеют переставлять записи вовсе', () => {
    // Отсутствие такой операции — не пробел, а способ сделать «перестановка
    // MUST NOT быть побочным эффектом» проверяемым: переставить нечем (ED-16).
    const ids = PLACEMENT_AUTHORING_OPERATIONS.map((operation) => operation.id);
    expect(ids).toEqual([
      PLACEMENT_OPERATIONS.add,
      PLACEMENT_OPERATIONS.move,
      PLACEMENT_OPERATIONS.rotate,
    ]);
  });
});

describe('ED-16: перемещение пишет только свои переопределения', () => {
  it('чужое поле записи перемещение не трогает', () => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    session.applyOperation(PLACEMENT_OPERATIONS.move, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: first ?? '',
      x: 1,
      y: 1,
    });

    expect(overrideAt(session, 0, 'x')).toBe(FIXED_ONE);
    expect(overrideAt(session, 0, 'y')).toBe(FIXED_ONE);
    // Поворот, стоявший в записи до перемещения, остался как был.
    expect(overrideAt(session, 0, 'turns')).toBe(16384);
  });

  it('поворот пишет своё поле и не трогает позицию', () => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    session.applyOperation(PLACEMENT_OPERATIONS.move, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: first ?? '',
      x: 2,
      y: 2,
    });
    session.applyOperation(PLACEMENT_OPERATIONS.rotate, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: first ?? '',
      turns: 0.75,
    });

    expect(overrideAt(session, 0, 'x')).toBe(2 * FIXED_ONE);
    expect(overrideAt(session, 0, 'turns')).toBe(fixed.fromFloat(0.75));
  });

  it('проект, не назвавший, где поворот, поворачивать не даёт', () => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    expect(() =>
      session.applyOperation(PLACEMENT_OPERATIONS.rotate, {
        ...bindingParam({ component: 'Position', x: 'x', y: 'y' }),
        document: FIXTURE_IDS.config,
        record: first ?? '',
        turns: 0.25,
      }),
    ).toThrow(/поворот/);
  });
});

describe('FP-1, ED-16: квантование делает ядро', () => {
  it('авторская величина укладывается в Q16.16 и читается обратно ядром', () => {
    const session = scratchSession();
    session.applyOperation(PLACEMENT_OPERATIONS.add, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      list: PLACEMENT_LIST,
      prefab: 'Hero',
      // Величина, точно не представимая в Q16.16: усечение обязано быть
      // ответом ядра, а не редакторским округлением.
      x: 1.1,
      y: 2.5,
    });

    const written = overrideAt(session, 2, 'x');
    expect(written).toBe(fixed.fromFloat(1.1));
    expect(Number.isInteger(written)).toBe(true);

    // Круг замыкается ядром: `loadScene` поднимает мир из записанного документа,
    // и позиция сущности совпадает с тем, что редактор записал (ED-1).
    const placements = placementsOf({
      config: session.documentValue(FIXTURE_IDS.config),
      visuals: null,
      position: BINDING,
    });
    expect(placements[2]?.x).toBe(fixed.toFloat(written as number));
    expect(placements[2]?.y).toBe(2.5);
  });

  it('величина вне представимого отвергается, а не заворачивается молча', () => {
    // Контейнер Q16.16 — i32: без проверки `| 0` увёл бы объект на другой край
    // арены, ничего не сказав (FP-1).
    expect(quantized(1e9)).toBeNull();
    expect(quantized(Number.NaN)).toBeNull();
    expect(quantized(1.5)).toBe(98304);

    const session = scratchSession();
    expect(() =>
      session.applyOperation(PLACEMENT_OPERATIONS.add, {
        ...bindingParam(BINDING),
        document: FIXTURE_IDS.config,
        list: PLACEMENT_LIST,
        prefab: 'Hero',
        x: 1e9,
        y: 0,
      }),
    ).toThrow(/Q16\.16/);
    // Полуправки не осталось: упавшая операция откатывается целиком (ED-29).
    expect(listOf(session)).toHaveLength(2);
  });
});

describe('ED-18: непрерывное взаимодействие — одна запись истории', () => {
  it('перетаскивание из многих кадров отменяется одним шагом', () => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    const started = overrideAt(session, 0, 'x');

    const drag = session.beginOperation(PLACEMENT_OPERATIONS.move, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: first ?? '',
      x: 1,
      y: 1,
    });
    for (const step of [1.25, 1.5, 1.75]) {
      drag.extend({
        ...bindingParam(BINDING),
        document: FIXTURE_IDS.config,
        record: first ?? '',
        x: step,
        y: 1,
      });
    }
    drag.commit();

    expect(overrideAt(session, 0, 'x')).toBe(fixed.fromFloat(1.75));
    expect(session.history().undo).toHaveLength(1);

    session.undo();
    // Прежним считается состояние ДО нажатия, а не предпоследний кадр мазка.
    expect(overrideAt(session, 0, 'x')).toBe(started);
    expect(session.canUndo()).toBe(false);
  });

  it('мультивыделение уходит одной записью и на перемещении, и на удалении', () => {
    const session = scratchSession();
    const keys = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);

    const drag = session.beginOperation(PLACEMENT_OPERATIONS.move, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: keys[0] ?? '',
      x: 3,
      y: 3,
    });
    drag.extend({
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      record: keys[1] ?? '',
      x: 4,
      y: 3,
    });
    drag.commit();
    expect(overrideAt(session, 0, 'x')).toBe(3 * FIXED_ONE);
    expect(overrideAt(session, 1, 'x')).toBe(4 * FIXED_ONE);
    expect(session.history().undo).toHaveLength(1);

    const erase = session.beginOperation(PLACEMENT_OPERATIONS.remove, {
      document: FIXTURE_IDS.config,
      record: keys[0] ?? '',
    });
    erase.extend({ document: FIXTURE_IDS.config, record: keys[1] ?? '' });
    erase.commit();
    expect(listOf(session)).toHaveLength(0);
    expect(session.history().undo).toHaveLength(2);

    session.undo();
    expect(listOf(session)).toHaveLength(2);
  });
});

describe('ED-29: каждая операция расстановки обратима', () => {
  it.each([
    [
      PLACEMENT_OPERATIONS.add,
      {
        list: PLACEMENT_LIST as unknown as JsonValue,
        prefab: 'Hero',
        x: 2.5,
        y: 3.5,
        turns: 0.125,
      },
    ],
    [PLACEMENT_OPERATIONS.move, { record: '', x: 6.25, y: 1.75 }],
    [PLACEMENT_OPERATIONS.rotate, { record: '', turns: 0.5 }],
  ])('«применить, отменить, сравнить» проходит для %s', (operationId, params) => {
    const session = scratchSession();
    const [first] = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST);
    const result = runOperationRoundTrip(session, operationId, {
      ...bindingParam(BINDING),
      document: FIXTURE_IDS.config,
      ...params,
      ...('record' in params ? { record: first ?? '' } : {}),
    });
    expect(result.findings).toEqual([]);
    expect(result.recorded).toBe(true);
  });
});

describe('ED-19: пару «prefab — запись манифеста» проверяет правило, а не инструмент', () => {
  it('рассинхронизация пары находится существующим правилом валидации', () => {
    // Инструмент расстановки своей проверки пары не заводит (ED-1, ED-30):
    // ниже отрабатывает то самое правило `editor.visualForPrefab` из ядра
    // редактора, и второго описания этого нарушения в пакете нет.
    const session = scratchSession();
    session.openDocument({
      id: FIXTURE_IDS.visuals,
      kind: SCENE_KINDS.visuals,
      value: FIXTURE_VISUALS,
    });
    const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    // Раскладка — та же, что у настоящего проекта (`sceneValidationRules`):
    // с умолчаниями правила искали бы стороны в документах видов, которых у
    // этого проекта нет, и ни одно не сработало бы ни разу.
    registerValidationRules(rules, sceneValidationRules());
    const report = createValidator({ rules }).run(session);

    const found = report
      .forDocument(FIXTURE_IDS.config)
      .filter((issue) => issue.ruleId === VISUAL_FOR_PREFAB_RULE);
    // У `Crate` записи манифеста нет — половина пары, и она названа адресом.
    expect(found.map((issue) => issue.reasonParams['name'])).toEqual(['Crate']);
    expect(found[0]?.path).toEqual(['prefabs', 1, 'name']);
  });
});
