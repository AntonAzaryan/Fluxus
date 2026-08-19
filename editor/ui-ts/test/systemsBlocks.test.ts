/**
 * Блочная сборка выражений и действий (ED-5, ED-1, ED-8).
 *
 * Что здесь пиннится и почему именно так:
 *
 * - **ED-5** — сборкой формулы с вложенными условиями ЧЕРЕЗ ИНТЕРФЕЙС и
 *   сверкой того, что уехало в документ: «на диск уходит JSON-AST» проверяемо
 *   только тем, что автор не набрал ни одного символа JSON, а в файле лежит
 *   дерево, которое ядро принимает;
 * - **ED-1** — сканером по исходникам области: таблицы «действие → его
 *   аргументы» в редакторе нет. Проверяется отсутствием имён закрытого набора
 *   ядра в строковых литералах — кроме двух адресов формы, названных
 *   раскладкой ED-4 и объявленных в одном месте с объяснением;
 * - **ED-8** — адресом находки: неизвестный компонент в блоке подсвечивается на
 *   СВОЕЙ записи системы (`['systems', index]`), а не на конфиге сцены целиком.
 *   Правило то же, что у сборки (`core.system`), а раскладку ему приносит
 *   область (`systemSites`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actions, expr, loadScene, validateSystem, world, type SceneDef, type SystemDef } from '@game-mvp/core';
import {
  ContributionRegistry,
  SYSTEM_RULE,
  createEditorSession,
  createMemoryHost,
  createOperationRegistry,
  createValidator,
  engineValidationRules,
  getAtPath,
  pathKey,
  registerBuiltinOperations,
  registerValidationRules,
  type EditorSession,
  type JsonPath,
  type JsonValue,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { findAll, hasClass, type UiNode } from '../src/dom/node.js';
import {
  SYSTEMS_AREA_ID,
  createSystemsArea,
  type SystemsAreaState,
} from '../src/areas/systems.js';
import {
  SYSTEM_LIST,
  systemRecords,
  systemSites,
} from '../src/areas/systemsDocuments.js';
import { registerSystemOperations } from '../src/areas/systemsOperations.js';
import { BLOCK_ROW, actionPalette, operatorPalette } from '../src/areas/systemsBlocks.js';
import { STYLE_RULES } from '../src/tokens/stylesheet.js';
import { buildFrame, buttonByKey, press, zoneOf } from './support/frame.js';
import { stubArea } from './support/stubArea.js';
import { settle } from './support/project.js';

const CONFIG = 'scenes/blocks.scene.json';

const SCENE = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { hp: 'i32', max: 'i32' } },
  ],
  prefabs: [{ name: 'Hero', components: { Position: { x: 0, y: 0 }, Health: { hp: 5, max: 10 } } }],
  initial: [{ prefab: 'Hero' }],
  systems: [{ name: 'regen', order: 1, query: { all: ['Health'] }, do: [] }],
  terrain: { width: 2, height: 2, tileSize: 65536, levels: ['00', '00'], flags: ['..', '..'] },
  capacity: 16,
};

interface Opened {
  readonly frame: ReturnType<typeof buildFrame>['frame'];
  readonly session: EditorSession;
  readonly recordKey: string;
}

async function opened(scene: unknown = SCENE): Promise<Opened> {
  const host = createMemoryHost({
    name: 'blocks',
    root: { label: 'blocks' },
    files: { [CONFIG]: JSON.stringify(scene) },
  });
  const area = createSystemsArea({ host, config: CONFIG });
  const fixture = buildFrame([area, stubArea]);
  registerSystemOperations(fixture.session.operations);
  fixture.frame.activate(area.id);
  fixture.frame.stateOf(area.id) as SystemsAreaState;
  await settle();
  fixture.frame.view();
  const key =
    systemRecords(
      fixture.session.documentValue(CONFIG),
      fixture.session.descriptors(CONFIG, SYSTEM_LIST),
    )[0]?.key ?? '';
  fixture.frame.selection.set(SYSTEMS_AREA_ID, [key]);
  fixture.frame.view();
  return { frame: fixture.frame, session: fixture.session, recordKey: key };
}

function commit(node: UiNode | undefined, value: string): void {
  const handler = node?.on?.change;
  if (handler === undefined) throw new Error(`контрол не принимает ввод: ${String(node?.tag)}`);
  handler({ target: { value } } as unknown as Event);
}

/** Узел разметки, отвечающий за место в документе, — по адресу, а не по порядку. */
function nodeAt(root: UiNode, attribute: string, path: JsonPath): UiNode | undefined {
  return findAll(root, (node) => node.attrs?.[attribute] === pathKey(path))[0];
}

/** Пикер оператора того выражения, что лежит по этому адресу. */
function pickOperator(root: UiNode, path: JsonPath, operator: string): void {
  const picker = nodeAt(root, 'data-picker', path);
  const control = findAll(picker ?? { tag: 'none' }, (node) => node.tag === 'select')[0];
  commit(control, operator);
}

/** Кнопка дописывания аргумента n-арному оператору: адрес — сам список. */
function appendArgument(root: UiNode, path: JsonPath): void {
  const row = nodeAt(root, 'data-append', path);
  if (row === undefined) throw new Error(`дописать в ${pathKey(path)} нечем`);
  press(buttonByKey(row, 'ui.area.systems.addArgument'));
}

/** Кнопка строки аргумента: «дописать следующий» либо снятие. */
function pressAt(root: UiNode, path: JsonPath, key: string): void {
  const row = nodeAt(root, 'data-at', path);
  if (row === undefined) throw new Error(`строки ${pathKey(path)} на странице нет`);
  press(buttonByKey(row, key));
}

/** Контрол строки аргумента. */
function controlAt(root: UiNode, path: JsonPath, tag = 'select'): UiNode | undefined {
  const row = nodeAt(root, 'data-at', path);
  return row === undefined ? undefined : findAll(row, (node) => node.tag === tag)[0];
}

function optionsOf(node: UiNode | undefined): readonly string[] {
  return findAll(node ?? { tag: 'none' }, (child) => child.tag === 'option')
    .map((child) => child.attrs?.value ?? '')
    .filter((value) => value !== '');
}

describe('ED-5: формула строится блоками, а на диск уходит JSON-AST', () => {
  it('вложенное условие над полем компонента собрано выборами, без единого символа JSON', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    const COND: JsonPath = ['do', 0, 'if', 'cond'];

    // Условие триггера — ветвление в теле: такое же действие, как остальные.
    press(buttonByKey(surface(), 'ui.area.systems.addCondition'));
    expect(getAtPath(session.documentValue(CONFIG), [...SYSTEM_LIST, 0, 'do'])).toEqual([
      { if: { cond: 0, then: [] } },
    ]);

    // Внешний узел — оператор `if` выражения: вложенные условия ED-5.
    pickOperator(surface(), COND, 'if');
    // Аргументы n-арного оператора автор добавляет сам: арность — дело
    // вычисления, а не редактора (SYS-3).
    appendArgument(surface(), [...COND, 'if']);

    // Первый аргумент — сравнение поля компонента с числом.
    const TEST: JsonPath = [...COND, 'if', 0];
    pickOperator(surface(), TEST, '<');
    appendArgument(surface(), [...TEST, '<']);

    const READ: JsonPath = [...TEST, '<', 0];
    pickOperator(surface(), READ, 'getComponent');
    // `getComponent` — один из четырёх операторов, чью форму ядро знает:
    // сущность, компонент, поле. Форма пришла из каталога, а не из таблицы.
    pressAt(surface(), [...READ, 'getComponent', 0], 'ui.area.systems.addArgument');
    const ENTITY: JsonPath = [...READ, 'getComponent', 0];
    pickOperator(surface(), ENTITY, 'var');
    pressAt(surface(), [...ENTITY, 'var', 0], 'ui.area.systems.addArgument');

    // Пикер переменной предлагает то, что связано в этом месте (SYS-3): у
    // системы с запросом это переменная итерации.
    const variable = controlAt(surface(), [...ENTITY, 'var', 0]);
    expect(optionsOf(variable)).toEqual(['entity']);
    commit(variable, 'entity');

    pressAt(surface(), [...READ, 'getComponent', 1], 'ui.area.systems.addArgument');
    const component = controlAt(surface(), [...READ, 'getComponent', 1]);
    // Пикер компонентов предлагает ровно то, что принимает `componentSchema`.
    const scene = loadScene(SCENE as unknown as SceneDef);
    expect(optionsOf(component)).toEqual([...world.componentNames(scene.world)]);
    commit(component, 'Health');

    pressAt(surface(), [...READ, 'getComponent', 2], 'ui.area.systems.addArgument');
    const field = controlAt(surface(), [...READ, 'getComponent', 2]);
    // Пикер полей — ровно то, с чем сверяет `checkFields` названного компонента.
    expect(optionsOf(field)).toEqual(['hp', 'max']);
    commit(field, 'hp');

    // Второй аргумент сравнения — числовой литерал.
    appendArgument(surface(), [...TEST, '<']);
    commit(controlAt(surface(), [...TEST, '<', 1], 'input'), '3');

    // Ветви внешнего `if`.
    appendArgument(surface(), [...COND, 'if']);
    commit(controlAt(surface(), [...COND, 'if', 1], 'input'), '1');
    appendArgument(surface(), [...COND, 'if']);
    commit(controlAt(surface(), [...COND, 'if', 2], 'input'), '0');

    expect(getAtPath(session.documentValue(CONFIG), [...SYSTEM_LIST, 0, ...COND])).toEqual({
      if: [{ '<': [{ getComponent: [{ var: ['entity'] }, 'Health', 'hp'] }, 3] }, 1, 0],
    });

    // Вердикт выносит ядро: тот же вызов, которым систему принимает реестр.
    const record = getAtPath(session.documentValue(CONFIG), [...SYSTEM_LIST, 0]);
    expect(() => { validateSystem(record as unknown as SystemDef, scene.world); }).not.toThrow();
    expect(() => loadScene(session.documentValue(CONFIG) as unknown as SceneDef)).not.toThrow();
  });

  it('дробный литерал квантуется ядром: в документ уходит целое число квантов (FP-1)', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    const COND: JsonPath = ['do', 0, 'if', 'cond'];
    press(buttonByKey(surface(), 'ui.area.systems.addCondition'));

    const literal = nodeAt(surface(), 'data-expression', COND);
    commit(findAll(literal ?? { tag: 'none' }, (node) => node.tag === 'input')[0], '1.5');
    // 1.5 в Q16.16 — 98304 квантов; переводит их `fixed`, а не редактор.
    expect(getAtPath(session.documentValue(CONFIG), [...SYSTEM_LIST, 0, ...COND])).toBe(98304);
  });

  it('запрос собирается именами компонентов мира, а не вводом руками', async () => {
    const { frame, session } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    const ALL: JsonPath = ['query', 'all'];
    const picker = controlAt(surface(), ALL);
    const scene = loadScene(SCENE as unknown as SceneDef);
    // Уже названный компонент второй раз не предлагается: он в запросе есть.
    expect(optionsOf(picker)).toEqual(
      world.componentNames(scene.world).filter((name) => name !== 'Health'),
    );
    commit(picker, 'Position');
    press(buttonByKey(nodeAt(surface(), 'data-at', ALL) ?? surface(), 'ui.action.addComponent'));
    expect(getAtPath(session.documentValue(CONFIG), [...SYSTEM_LIST, 0, ...ALL])).toEqual([
      'Health',
      'Position',
    ]);
  });
});

describe('ED-1: правил DSL в редакторе нет', () => {
  const DIRECTORY = fileURLToPath(new URL('../src/areas/', import.meta.url));
  const files = readdirSync(DIRECTORY)
    .filter((name) => name.startsWith('systems') && name.endsWith('.ts'))
    .sort();

  /** Литералы кода без комментариев: сам текст требования цитирует имена. */
  function literalsOf(source: string): readonly string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((found) => found[1] ?? found[2] ?? '');
  }

  it('область систем вообще есть — проверка не пустая', () => {
    expect(files).toEqual(['systems.ts', 'systemsBlocks.ts', 'systemsDocuments.ts', 'systemsOperations.ts']);
  });

  /**
   * Два имени закрытого набора область называет, и оба — АДРЕСА формы, а не
   * правила: раскладка ED-4 говорит, что событие несёт `forEachEvent`, а
   * условие — `cond` действия `if`. Объявлены они в одном месте
   * (`systemsDocuments.ts`) и с объяснением; остальные тридцать имён набора
   * область не называет вовсе — она читает их каталогом.
   */
  const ADDRESSES: readonly string[] = ['forEachEvent', 'if'];

  /**
   * Два литерала, совпадающих с именами ОПЕРАТОРОВ, и ни один оператором не
   * является:
   *
   * - `eventField` — вид аргумента (`OperatorArg` каталога `editor-core`);
   *   совпадение по происхождению — форму `eventField` разбирает тот же
   *   `checkExpression`, — а сам литерал проверяется типом объединения;
   * - `tick` — источник срабатывания триггера (`TriggerSource`, ED-4): «система
   *   без запроса и без события», к оператору `tick` (номер текущего тика,
   *   EXPR-2) отношения не имеющий вовсе.
   */
  const NOT_OPERATORS: readonly string[] = ['eventField', 'tick'];

  it.each(files)('%s: имён закрытого набора действий в коде нет — есть каталог', (name) => {
    const literals = new Set(literalsOf(readFileSync(`${DIRECTORY}${name}`, 'utf8')));
    const named = [...actions.actionNames].filter((action) => literals.has(action));
    expect(named.filter((action) => !ADDRESSES.includes(action))).toEqual([]);
  });

  /**
   * Вторая половина того же утверждения. Без неё сканер молчал бы о таблице
   * «оператор → его аргументы», а именно она и была бы второй реализацией
   * семантики выражений (ED-5, ED-1): форму знает каталог, арность — вычислитель.
   */
  it.each(files)('%s: имён закрытого набора операторов в коде нет — есть каталог', (name) => {
    const literals = new Set(literalsOf(readFileSync(`${DIRECTORY}${name}`, 'utf8')));
    const allowed = [...ADDRESSES, ...NOT_OPERATORS];
    const named = [...expr.operators].filter((operator) => literals.has(operator));
    expect(named.filter((operator) => !allowed.includes(operator))).toEqual([]);
  });

  it('палитра блоков производна от закрытых наборов ядра в обе стороны', () => {
    expect([...actionPalette()].sort()).toEqual([...actions.actionNames].sort());
    expect([...operatorPalette()].sort()).toEqual([...expr.operators].sort());
  });
});

describe('ED-8: находка адресует запись системы, а не документ целиком', () => {
  const KINDS = {
    scene: 'scene',
    terrain: 'terrain',
    curvature: 'terrain-curvature',
    manifest: 'visuals',
    system: 'system',
    presentation: 'presentation',
  } as const;

  function report(config: JsonValue) {
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({ id: CONFIG, kind: KINDS.scene, value: config, lists: [SYSTEM_LIST] });
    const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    // Раскладку правилу приносит область: системы этого проекта лежат списком
    // внутри конфига сцены, а не отдельными документами (ED-25).
    registerValidationRules(rules, [...engineValidationRules(KINDS, {}, systemSites(KINDS.scene))]);
    return createValidator({ rules }).run(session);
  }

  it('неизвестный компонент в блоке подсвечивается на своей записи', () => {
    const broken = {
      ...SCENE,
      systems: [
        SCENE.systems[0],
        { name: 'aggro', order: 2, do: [{ addComponent: { component: 'Aggro', entity: 0 } }] },
      ],
    };
    const found = report(broken as unknown as JsonValue).issues.filter(
      (issue) => issue.ruleId === SYSTEM_RULE,
    );
    expect(found).toHaveLength(1);
    // Адрес — запись, а не документ: цикл ED-8 работает на уровне системы, а не
    // файла, в котором систем шесть.
    expect(found[0]?.path).toEqual([...SYSTEM_LIST, 1]);
    expect(found[0]?.severity).toBe('error');
  });

  it('исправная сцена молчит: находок правила систем нет', () => {
    expect(
      report(SCENE as unknown as JsonValue).issues.filter((issue) => issue.ruleId === SYSTEM_RULE),
    ).toEqual([]);
  });
});

/**
 * ED-22 на поверхности систем: «Хром SHALL оставаться достижимым… элемент
 * управления, не помещающийся в свою полосу… MUST NOT оказываться за границей
 * зоны без следа». Строка блочного редактора держит не подпись, а собранный
 * блок, и потолок высоты плотного списка резал бы его: карточки вложенных
 * операторов наезжали одна на другую, и поверхность переставала читаться.
 *
 * Проверка структурная — раскладку в headless-прогоне не посчитать, — и она о
 * двух вещах сразу: разметка помечает такие строки своим классом, а правило
 * этого класса берёт ту же плотность тем же токеном, но полом, а не потолком.
 */
describe('ED-22, ED-5: строка блока не режет вложенное в неё', () => {
  /** Строки, внутри которых лежит собранный блок, а не одна подпись. */
  function nestingRows(root: UiNode): readonly UiNode[] {
    return findAll(root, (node) => hasClass(node, 'fx-row')).filter(
      (row) =>
        findAll(row, (child) => child !== row && (hasClass(child, 'fx-card') || hasClass(child, 'fx-stack')))
          .length > 0,
    );
  }

  it('каждая строка с вложенным блоком помечена строкой блока', async () => {
    const { frame } = await opened();
    const surface = (): UiNode => zoneOf(frame.view(), 'surface');
    const COND: JsonPath = ['do', 0, 'if', 'cond'];
    press(buttonByKey(surface(), 'ui.area.systems.addCondition'));
    pickOperator(surface(), COND, 'if');
    appendArgument(surface(), [...COND, 'if']);
    // Аргумент-узел и есть вложенная карточка: она лежит в строке слота.
    pickOperator(surface(), [...COND, 'if', 0], '<');

    const nesting = nestingRows(surface());
    expect(nesting.length).toBeGreaterThan(0);
    for (const row of nesting) expect(row.classes).toContain(BLOCK_ROW);
  });

  it('плотность строки блока приходит токеном и остаётся полом, а не потолком', () => {
    const rule = STYLE_RULES.find((entry) => entry.selector.endsWith(`.${BLOCK_ROW}`));
    expect(rule?.declarations).toContain(`min-height: var(--fx-row-dense)`);
    // Потолка нет: `height` из плотной строки снят, иначе `min-height` ничего
    // бы не решил — фиксированная высота обрезает вложенное молча.
    expect(rule?.declarations).toContain('height: auto');
  });
});
