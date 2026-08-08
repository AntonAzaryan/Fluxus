/**
 * Инспектор из схемы редактируемого (ED-24), редактор поля как вклад (ED-25),
 * подсказка по вычисленному ключу (ED-28) и находка валидации на своём месте
 * (ED-8, ED-22, ED-30).
 *
 * Главное, что здесь пиннится: в инспекторе нет списка полей. Проверяется это
 * единственным честным способом — правкой НАСТОЯЩЕГО документа: поле,
 * дописанное в схему компонента, обязано появиться строкой, а код редактора при
 * этом не правится ни на символ.
 */
import { fixed } from '@game-mvp/core';
import {
  StringResources,
  createEditorSession,
  createOperationRegistry,
  registerBuiltinOperations,
  type EditorSession,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { describe, expect, it } from 'vitest';
import { documentValue, findAll, hasClass, type UiNode } from '../src/dom/node.js';
import {
  createFieldEditorRegistry,
  inspectorPanel,
  registerFieldEditors,
  type FieldEditor,
  type SchemaField,
} from '../src/inspector/index.js';
import { textField } from '../src/widgets/field.js';
import { PLACEMENT_LIST } from '../src/areas/sceneProject.js';
import { systemsArea } from '../src/areas/systems.js';
import { attr, buildLoadedFrame, zoneOf } from './support/frame.js';
import { FIXTURE_IDS, FIXTURE_SCENE, fixtureHost, settle } from './support/project.js';

/** Строки таблицы полей зоны инспектора: подпись, признак типа, контрол. */
interface Row {
  readonly label: string;
  readonly note: string;
  readonly node: UiNode;
}

function rowsOf(view: UiNode): Row[] {
  // Панель бывает и сама по себе — там, где проверяется она, а не область:
  // зона скелета тогда не строится вовсе (ED-24 говорит о её месте, а не о её
  // необходимости для сборки самой панели).
  const scope = findAll(view, (node) => attr(node, 'data-zone') === 'inspector')[0] ?? view;
  const table = findAll(scope, (node) => hasClass(node, 'fx-field-row'));
  return table.map((node) => ({
    node,
    label:
      findAll(node, (inner) => hasClass(inner, 'fx-field-row__label')).flatMap((cell) =>
        findAll(cell, (text) => text.text !== undefined).map((text) => text.text?.value ?? ''),
      )[0] ?? '',
    note:
      findAll(node, (inner) => hasClass(inner, 'fx-field-row__note')).flatMap((cell) =>
        findAll(cell, (text) => text.text !== undefined).map((text) => text.text?.value ?? ''),
      )[0] ?? '',
  }));
}

function rowOf(view: UiNode, label: string): Row {
  const found = rowsOf(view).find((row) => row.label === label);
  if (found === undefined) throw new Error(`в инспекторе нет строки ${label}`);
  return found;
}

/** Подсказка строки — `title` кнопки с вопросительным знаком (ED-28). */
function hintOf(row: Row): { readonly key: string; readonly text: string } {
  const hint = findAll(row.node, (node) => hasClass(node, 'fx-hint'))[0];
  return { key: hint?.labels?.title?.key ?? '', text: hint?.labels?.title?.value ?? '' };
}

/** Ввод в поле: контрол отдаёт значение по `change` — от фокуса до подтверждения. */
function commit(row: Row, value: string): void {
  const input = findAll(row.node, (node) => node.tag === 'input')[0];
  const handler = input?.on?.['change'];
  if (handler === undefined) throw new Error(`строка ${row.label} не принимает ввод`);
  handler({ target: Object.assign(new (class {})(), { value }) } as unknown as Event);
}

describe('ED-24, ED-2: набор строк инспектора — это схема, а не список в редакторе', () => {
  it('поле, дописанное в схему компонента, появляется со своим типом', async () => {
    // Схема правится в документе, который читает редактор, а не в структуре,
    // подставленной инспектору: иначе проверка проверяла бы саму себя.
    const scene = {
      ...FIXTURE_SCENE,
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed', turns: 'fixed', hp: 'i32' } },
      ],
      prefabs: [
        { name: 'Hero', tags: ['Hero'], components: { Position: { x: 98304, y: 98304, turns: 0, hp: 7 } } },
        { name: 'Crate', tags: ['Crate'], components: { Position: { x: 163840, y: 98304, turns: 0, hp: 1 } } },
      ],
    };
    const { frame, session, area } = await buildLoadedFrame('ru', { host: fixtureHost(scene) });
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);

    const row = rowOf(frame.view(), 'hp');
    // Тип поля — из схемы, и показан он как есть: локаль его не касается (ED-27).
    expect(row.note).toBe('i32');
    expect(rowOf(frame.view(), 'x').note).toBe('fixed');
  });

  it('строки записи расстановки берутся из схемы формата, а не из имён в коде', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);
    const rows = rowsOf(frame.view()).map((row) => row.label);
    // `prefab` — поле схемы записи (SER-8); `x`, `y`, `turns` — поля схемы
    // компонента, объявленного документом (ECS-3).
    expect(rows).toEqual(['prefab', 'x', 'y', 'turns']);
  });

  it('перечисленные значения показываются в единицах своего типа, а не в машинных', () => {
    // Q16.16 показывается десятичной дробью и в свободном поле, и в списке: одно
    // и то же поле не может выглядеть по-разному оттого, что схема перечислила
    // его значения. В документ при этом уходит то же, что и из свободного поля,
    // — целое число квантов (FP-1).
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({ id: 'doc', kind: 'test', value: { speed: fixed.fromFloat(1) } });
    const view = inspectorPanel({
      resources: resourcesOf({}),
      session,
      fieldEditors: registerFieldEditors(createFieldEditorRegistry()),
      subject: {
        address: { documentId: 'doc' },
        groups: [
          {
            name: 'group',
            fields: [
              {
                name: 'speed',
                type: 'fixed',
                path: ['speed'],
                description: ['test', 'speed'],
                values: [fixed.fromFloat(1), fixed.fromFloat(2.5)],
              },
            ],
          },
        ],
      },
    });
    const row = rowOf(view, 'speed');
    const options = findAll(row.node, (node) => node.tag === 'option');
    expect(options.map((node) => attr(node, 'value'))).toEqual(['1', '2.5']);

    const select = findAll(row.node, (node) => node.tag === 'select')[0];
    select?.on?.['change']?.({ target: { value: '2.5' } } as unknown as Event);
    expect((session.documentValue('doc') as { speed: number }).speed).toBe(fixed.fromFloat(2.5));
  });

  it('допустимые значения ссылки — существующие prefab’ы, а не свободный ввод', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);
    const options = findAll(rowOf(frame.view(), 'prefab').node, (node) => node.tag === 'option').map(
      (node) => attr(node, 'value'),
    );
    expect(options).toEqual(['Hero', 'Crate']);
  });
});

describe('ED-25: редактор поля — вклад, и подхватывают его все области сразу', () => {
  /** Вклад, узнаваемый по классу: чем именно он рисует, проверке не важно. */
  const MARK = 'fx-test-boolean';
  const marked: FieldEditor = {
    id: 'field.boolean',
    fieldType: 'boolean',
    descriptionKey: 'ui.field.boolean.description',
    render: (context) => ({
      ...textField({
        label: context.label,
        value: documentValue(JSON.stringify(context.value)),
        readOnly: true,
      }),
      classes: [MARK],
    }),
  };

  it('одна регистрация — и контрол стоит в инспекторе обеих областей', async () => {
    const fieldEditors = registerFieldEditors(createFieldEditorRegistry());
    // Перекрытие вклада по id — тот же механизм реестра, что и регистрация
    // нового типа: проект подменяет редактор поля, не заводя второго вклада.
    fieldEditors.override(marked);
    const { frame, area } = await buildLoadedFrame('ru', { fieldEditors });

    // Область сцены: булевы поля формата сцены (SER-5) — те же, что показывает
    // схема ядра, и контрол у них теперь от вклада.
    frame.selection.set(area.id, [FIXTURE_IDS.config]);
    expect(findAll(zoneOf(frame.view(), 'inspector'), (node) => hasClass(node, MARK)).length)
      .toBeGreaterThan(0);

    // Область систем: её флаги — тоже булевы поля, и правится реестр один раз.
    frame.activate(systemsArea.id);
    expect(findAll(zoneOf(frame.view(), 'inspector'), (node) => hasClass(node, MARK)).length)
      .toBeGreaterThan(0);
  });

  it('тип поля без вклада показан со своим типом и недоступен правке', () => {
    // Пустой реестр — состояние редактора до того, как для типа написан
    // контрол: строка обязана быть (ED-24), а правки в ней быть не может.
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({ id: 'doc', kind: 'test', value: { odd: 1 } });
    const view = inspectorPanel({
      resources: resourcesOf({}),
      session,
      fieldEditors: createFieldEditorRegistry(),
      subject: {
        address: { documentId: 'doc' },
        groups: [
          { name: 'group', fields: [{ name: 'odd', type: 'quaternion', path: ['odd'], description: ['test', 'odd'] }] },
        ],
      },
    });
    const row = rowOf(view, 'odd');
    expect(row.note).toBe('quaternion');
    expect(findAll(row.node, (node) => node.tag === 'input')[0]?.attrs?.['readonly']).toBe('');
  });
});

/** Ресурсы с заданными бандлами: цепочка ED-28 проверяется на их составе. */
function resourcesOf(
  bundles: Readonly<Record<string, Readonly<Record<string, string>>>>,
  locale = 'ru',
): StringResources {
  return new StringResources({ locale, editor: bundles });
}

describe('ED-24, ED-26, ED-29: адрес субъекта и поле, которое правке не подлежит', () => {
  /** Субъект, у которого корень — место в документе, а не сам документ. */
  const panelOf = (
    field: SchemaField,
  ): { readonly view: UiNode; readonly session: EditorSession } => {
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({ id: 'doc', kind: 'test', value: { nested: { width: 4, derived: 9 } } });
    return {
      session,
      view: inspectorPanel({
        resources: resourcesOf({}),
        session,
        fieldEditors: registerFieldEditors(createFieldEditorRegistry()),
        subject: {
          address: { documentId: 'doc', root: ['nested'] },
          groups: [{ name: 'nested', fields: [field] }],
        },
      }),
    };
  };

  it('правка уходит по адресу от корня субъекта, а не от корня документа', () => {
    const { view, session } = panelOf({
      name: 'width',
      type: 'integer',
      path: ['width'],
      description: ['test', 'width'],
    });
    commit(rowOf(view, 'width'), '7');
    expect((session.documentValue('doc') as { nested: { width: number } }).nested.width).toBe(7);
  });

  it('поле, помеченное схемой как неправимое, показано недоступным, а не молчащим', () => {
    // Производная величина, которую считает ядро, или место со своей операцией:
    // строка у него есть (ED-24), а ввода в ней нет — и это видно (ED-26).
    const { view } = panelOf({
      name: 'derived',
      type: 'integer',
      path: ['derived'],
      description: ['test', 'derived'],
      readOnly: true,
    });
    const input = findAll(rowOf(view, 'derived').node, (node) => node.tag === 'input')[0];
    expect(input?.attrs?.['readonly']).toBe('');
    expect(input?.on?.['change']).toBeUndefined();
  });
});

describe('ED-28: подсказка приходит по вычисленному ключу и не бывает пустой', () => {
  const subject = {
    address: { documentId: 'doc' },
    groups: [
      {
        name: 'Health',
        fields: [{ name: 'max', type: 'i32', path: ['max'], description: ['component', 'Health', 'max'] as const }],
      },
    ],
  };

  const panelWith = (bundles: Readonly<Record<string, Readonly<Record<string, string>>>>): UiNode => {
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({ id: 'doc', kind: 'test', value: { max: 3 } });
    return inspectorPanel({
      resources: resourcesOf(bundles),
      session,
      fieldEditors: registerFieldEditors(createFieldEditorRegistry()),
      subject,
    });
  };

  it('ключ вычислен из пути поля в схеме, а не взят из таблицы', () => {
    expect(hintOf(rowOf(panelWith({}), 'max')).key).toBe('component.Health.max');
  });

  it('на текущей локали показывается её описание', () => {
    const hint = hintOf(
      rowOf(
        panelWith({
          ru: { 'component.Health.max': 'Предел здоровья' },
          en: { 'component.Health.max': 'Health cap' },
        }),
        'max',
      ),
    );
    expect(hint.text).toBe('Предел здоровья');
  });

  it('без описания на текущей локали показывается английское', () => {
    const hint = hintOf(rowOf(panelWith({ en: { 'component.Health.max': 'Health cap' } }), 'max'));
    expect(hint.text).toBe('Health cap');
  });

  it('без описания вовсе показывается сам ключ, а не пустота', () => {
    const hint = hintOf(rowOf(panelWith({}), 'max'));
    expect(hint.text).toBe('component.Health.max');
    expect(hint.text.trim().length).toBeGreaterThan(0);
  });

  it('пустая строка в бандле — это отсутствие ресурса, а не пустая подсказка', () => {
    const hint = hintOf(rowOf(panelWith({ ru: { 'component.Health.max': '   ' } }), 'max'));
    expect(hint.text).toBe('component.Health.max');
  });
});

describe('ED-29, ED-18: правка поля — одна операция и одна запись истории', () => {
  it('от фокуса до подтверждения получается ровно одна запись', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);
    const before = session.history().undo.length;

    commit(rowOf(frame.view(), 'x'), '2.5');

    expect(session.history().undo.length).toBe(before + 1);
    // Значение уходит в документ в единице ядра: Q16.16, а не десятичная дробь
    // (FP-1). Перевод делает ядро, редактор его не повторяет.
    const config = session.documentValue(FIXTURE_IDS.config) as {
      initial: { overrides?: { Position?: { x?: number } } }[];
    };
    expect(config.initial[0]?.overrides?.Position?.x).toBe(fixed.fromFloat(2.5));
    // Отмена — та же одна операция: правка попала в историю целиком (ED-18).
    expect(session.undo()).toBe(true);
    const undone = session.documentValue(FIXTURE_IDS.config) as {
      initial: { overrides?: unknown }[];
    };
    expect(undone.initial[0]?.overrides).toBeUndefined();
  });

  it('ввод, не разбирающийся в значение своего типа, документа не трогает', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);
    const before = session.history().undo.length;
    commit(rowOf(frame.view(), 'x'), 'почти число');
    expect(session.history().undo.length).toBe(before);
  });

  it('в превью поля показаны недоступными: операции авторинга там запрещены', async () => {
    const { frame, session, area } = await buildLoadedFrame();
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);
    frame.togglePreview();
    expect(frame.mode()).toBe('preview');
    const input = findAll(rowOf(frame.view(), 'x').node, (node) => node.tag === 'input')[0];
    expect(input?.attrs?.['readonly']).toBe('');
    expect(input?.on?.['change']).toBeUndefined();
    frame.stopPreview();
  });
});

describe('ED-8, ED-22, ED-30: находка доходит до своего поля и до своего узла', () => {
  /**
   * Правило-вклад (ED-25), сообщающее о месте внутри записи расстановки. Взято
   * своё, а не готовое, чтобы проверялась ДОСТАВКА находки по адресу, а не
   * поведение конкретного правила ядра: индексы отчёта `at` и `under` заведены
   * ровно для двух этих вопросов (ED-30).
   */
  const rule: ValidationRule = {
    id: 'test.placementField',
    descriptionKey: 'ui.inspector.title',
    reasonCodes: ['tooFar'],
    appliesTo: ['scene'],
    check(run) {
      run.report({
        path: [...PLACEMENT_LIST, 0, 'overrides', 'Position', 'x'],
        expected: { kind: 'range', min: 0, max: 1 },
        code: 'tooFar',
      });
    },
  };

  it('строка поля несёт иконку, положение и причину — а не оттенок', async () => {
    const { frame, session, area } = await buildLoadedFrame('ru', { rules: [rule] });
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    frame.selection.set(area.id, [key]);

    const row = rowOf(frame.view(), 'x');
    const mark = findAll(row.node, (node) => attr(node, 'data-severity') !== undefined)[0];
    expect(attr(mark ?? { tag: 'div' }, 'data-severity')).toBe('error');
    // Причина — текст, а не только цвет: без неё показ был бы различим лишь
    // оттенком, чего ED-22 не допускает.
    const reason = findAll(mark ?? { tag: 'div' }, (node) => node.text !== undefined)[0];
    expect((reason?.text?.value ?? '').length).toBeGreaterThan(0);
    // Соседние строки чистые: находка адресована месту, а не записи целиком.
    expect(findAll(rowOf(frame.view(), 'y').node, (node) => attr(node, 'data-severity') !== undefined))
      .toHaveLength(0);
  });

  it('узел навигатора над этим местом помечен той же находкой', async () => {
    const { frame, session } = await buildLoadedFrame('ru', { rules: [rule] });
    const key = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[0] ?? '';
    const navigator = zoneOf(frame.view(), 'navigator');
    const row = findAll(navigator, (node) => attr(node, 'data-id') === key)[0];
    expect(row).toBeDefined();
    expect(findAll(row ?? { tag: 'div' }, (node) => attr(node, 'data-severity') === 'error'))
      .toHaveLength(1);

    // Соседняя запись — без пометки: `under` берёт путь и глубже, а не документ.
    const other = session.descriptors(FIXTURE_IDS.config, PLACEMENT_LIST)[1] ?? '';
    const neighbour = findAll(navigator, (node) => attr(node, 'data-id') === other)[0];
    expect(findAll(neighbour ?? { tag: 'div' }, (node) => attr(node, 'data-severity') !== undefined))
      .toHaveLength(0);
  });

  it('находка правила пары доходит до строки документа сама, без правил области', async () => {
    // Фикстура несогласована по ED-19 с самого начала: у prefab’а `Crate` нет
    // записи манифеста. Это настоящая находка настоящего правила, и видно её на
    // строке того документа, к которому она адресована.
    const { frame } = await buildLoadedFrame();
    await settle();
    const navigator = zoneOf(frame.view(), 'navigator');
    const row = findAll(navigator, (node) => attr(node, 'data-id') === FIXTURE_IDS.config)[0];
    expect(findAll(row ?? { tag: 'div' }, (node) => attr(node, 'data-severity') !== undefined).length)
      .toBeGreaterThan(0);
  });
});
