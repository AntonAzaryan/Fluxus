/**
 * Правила-вклады: вызовы валидаторов движка (ED-1, ED-10, ED-11, ED-14) и
 * междокументные правила пары (ED-19).
 *
 * Главное, что здесь проверяется про правила движка, — что редактор именно
 * спрашивает ядро: сообщение находки сверяется с тем, что бросает сам
 * валидатор, вызванный в тесте напрямую. Совпадение дословно — признак того,
 * что второй реализации правила в редакторе нет (ED-1, CORE-3); разойтись эти
 * две строки могут только если редактор начнёт проверять сам.
 */
import {
  createTerrainGrid,
  loadScene,
  validateSystem,
  type SceneDef,
  type SystemDef,
  type TerrainDef,
} from '@game-mvp/core';
import type { CameraEffectsDescription } from '@game-mvp/assets';
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession, type JsonValue } from '../src/document/index.js';
import { createOperationRegistry, registerBuiltinOperations } from '../src/operations/index.js';
import { ContributionRegistry } from '../src/registry/index.js';
import {
  createValidator,
  crossDocumentRules,
  engineValidationRules,
  registerValidationRules,
  CAMERA_EFFECT_STATE_RULE,
  CREATE_TERRAIN_GRID,
  CURVATURE_GRID_RULE,
  CURVATURE_RULE,
  DEFAULT_ENGINE_KINDS,
  DEFAULT_PAIR_KINDS,
  DEFAULT_PLACEMENT_SITES,
  DEFAULT_SYSTEM_SITES,
  DECORATION_VISUAL_RULE,
  LOAD_SCENE,
  MANIFEST_RULE,
  PLACEMENT_PREFAB_RULE,
  PREFAB_FOR_VISUAL_RULE,
  SCENE_RULE,
  SYSTEM_RULE,
  TERRAIN_RULE,
  VALIDATE_SYSTEM,
  VISUAL_FOR_PREFAB_RULE,
  type SystemSite,
  type TerrainSite,
  type ValidationIssue,
  type ValidationReport,
  type ValidationRule,
} from '../src/validation/index.js';

const SCENE = 'content/scenes/arena.json';
const MANIFEST = 'content/visuals/manifest.json';
const TERRAIN = 'content/visuals/terrain.json';
const CURVATURE = 'content/visuals/curvature.json';
const SYSTEM = 'content/systems/move.json';

const SCENE_VALUE = {
  components: [{ name: 'Pos', fields: { x: 'i32', y: 'i32' } }],
  prefabs: [{ name: 'grunt', components: { Pos: { x: 0, y: 0 } } }],
  capacity: 16,
  initial: [{ prefab: 'grunt' }],
};

const MANIFEST_VALUE = { entities: { grunt: { model: 'models/grunt.mdx' } } };

const TERRAIN_VALUE = {
  width: 2,
  height: 2,
  tileSize: 65536,
  levels: ['00', '00'],
  flags: ['..', '..'],
};

const CURVATURE_VALUE = { width: 2, height: 2, rows: ['..', '..'] };

const ALL_RULES: readonly ValidationRule[] = [...engineValidationRules(), ...crossDocumentRules()];

function sessionOf(documents: Readonly<Record<string, { kind: string; value: JsonValue }>>): EditorSession {
  // Операции нужны не всякому тесту, но правка документа идёт только ими
  // (ED-29), а прогон валидации от их наличия не зависит.
  const editor: EditorSession = createEditorSession({
    operations: registerBuiltinOperations(createOperationRegistry()),
  });
  for (const [id, document] of Object.entries(documents)) {
    editor.openDocument({ id, kind: document.kind, value: document.value });
  }
  return editor;
}

function validatorOf(rules: readonly ValidationRule[]) {
  const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(registry, rules);
  return createValidator({ rules: registry });
}

function check(
  documents: Readonly<Record<string, { kind: string; value: JsonValue }>>,
  rules: readonly ValidationRule[] = ALL_RULES,
): ValidationReport {
  return validatorOf(rules).run(sessionOf(documents));
}

/** Дословное сообщение валидатора из находки — с проверкой вида ожидания. */
function detailOf(issue: ValidationIssue): string {
  const { expected } = issue;
  if (expected.kind !== 'accepted') throw new Error(`ожидание "${expected.kind}", а не ответ валидатора`);
  return expected.detail;
}

/** Известное по ссылочному ожиданию — с той же проверкой вида. */
function knownOf(issue: ValidationIssue): readonly string[] {
  const { expected } = issue;
  if (expected.kind !== 'reference') throw new Error(`ожидание "${expected.kind}", а не ссылка`);
  return expected.known;
}

/** Сообщение, которое бросает сам валидатор ядра, — эталон для сверки. */
function thrownBy(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('валидатор ничего не бросил — сверять нечего');
}

describe('ED-1: правило ядра применяется вызовом ядра', () => {
  it('конфиг сцены отвергает loadScene, и находка несёт его сообщение дословно', () => {
    const broken = { ...SCENE_VALUE, initial: [{ prefab: 'ghost' }] };
    const report = check({ [SCENE]: { kind: 'scene', value: broken } });
    const issue = report.forDocument(SCENE).find((found) => found.ruleId === SCENE_RULE)!;
    expect(issue.expected).toEqual({
      kind: 'accepted',
      by: LOAD_SCENE,
      detail: thrownBy(() => loadScene(broken as unknown as SceneDef)),
    });
    // Путь — сам документ: `loadScene` бросает на первом нарушении и адреса не
    // возвращает. Место называет дословное сообщение ядра.
    expect(issue.path).toEqual([]);
  });

  it('валидная сцена находок не даёт', () => {
    expect(check({ [SCENE]: { kind: 'scene', value: SCENE_VALUE } }).ok).toBe(true);
  });
});

describe('ED-10: ассет террейна проверяет createTerrainGrid', () => {
  it('рампа в одну клетку подсвечивается сразу (TERR-7)', () => {
    const value = { ...TERRAIN_VALUE, flags: ['^.', '..'] };
    const report = check({ [TERRAIN]: { kind: 'terrain', value } });
    const issue = report.forDocument(TERRAIN)[0]!;
    expect(issue.ruleId).toBe(TERRAIN_RULE);
    expect(issue.expected).toEqual({
      kind: 'accepted',
      by: CREATE_TERRAIN_GRID,
      detail: thrownBy(() => createTerrainGrid(value as unknown as TerrainDef)),
    });
  });

  it('символ вне алфавита карты — то же правило (TERR-3)', () => {
    const value = { ...TERRAIN_VALUE, levels: ['0Z', '00'] };
    const report = check({ [TERRAIN]: { kind: 'terrain', value } });
    expect(report.forDocument(TERRAIN)[0]?.expected).toMatchObject({ by: CREATE_TERRAIN_GRID });
  });

  it('валидный ассет находок не даёт', () => {
    expect(check({ [TERRAIN]: { kind: 'terrain', value: TERRAIN_VALUE } }).ok).toBe(true);
  });
});

describe('ED-8: JSON-система проверяется против мира открытой сцены', () => {
  const good = {
    name: 'move',
    order: 1,
    query: { all: ['Pos'] },
    do: [{ modifyComponent: { entity: { var: 'entity' }, component: 'Pos', values: { x: 1 } } }],
  };
  const bad = {
    ...good,
    do: [{ modifyComponent: { entity: { var: 'entity' }, component: 'Nope', values: {} } }],
  };

  it('ссылка на компонент вне реестра подсвечивается сразу, а не при загрузке в ядро', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [SYSTEM]: { kind: 'system', value: bad },
    });
    const issue = report.forDocument(SYSTEM).find((found) => found.ruleId === SYSTEM_RULE)!;
    expect(issue.expected).toEqual({
      kind: 'accepted',
      by: VALIDATE_SYSTEM,
      detail: thrownBy(() => validateSystem(bad as unknown as SystemDef, loadScene(SCENE_VALUE as unknown as SceneDef).world)),
    });
    // Против какой сцены проверялось — часть находки: система бывает годной для
    // одной сцены и негодной для другой.
    expect(issue.reasonParams['against']).toBe(SCENE);
  });

  it('годная система находок не даёт', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [SYSTEM]: { kind: 'system', value: good },
    });
    expect(report.forDocument(SYSTEM)).toHaveLength(0);
  });

  it('без открытой сцены о системе не судят: мира, который знает компоненты, нет', () => {
    expect(check({ [SYSTEM]: { kind: 'system', value: bad } }).issues).toHaveLength(0);
  });
});

/**
 * ED-8, ED-30: системы лежат полем конфига сцены (SYS-1, SER-7), а не
 * документами, и раскладку правилу приносит сборка (ED-25) — тем же
 * `DocumentSite`, каким её приносят междокументные правила.
 *
 * Проверяется здесь одно: находка адресует ЗАПИСЬ системы. До этого сломанная
 * система гасила весь конфиг одним сообщением `loadScene`, и цикл «правка →
 * находка → исправление» работал на уровне файла, в котором систем шесть.
 * Вердикт при этом остаётся за ядром — сообщение сверяется с тем, что бросает
 * сам `validateSystem`, вызванный в тесте напрямую (ED-1).
 */
describe('ED-30: система адресуется своей записью в документе-носителе', () => {
  const MATCH = 'content/matches/duel.match.json';
  const IN_SCENE: readonly SystemSite[] = [{ kind: 'scene', path: ['systems'] }];

  const good = {
    name: 'move',
    order: 1,
    query: { all: ['Pos'] },
    do: [{ modifyComponent: { entity: { var: 'entity' }, component: 'Pos', values: { x: 1 } } }],
  };
  const bad = {
    name: 'haunt',
    order: 2,
    query: { all: ['Pos'] },
    do: [{ modifyComponent: { entity: { var: 'entity' }, component: 'Nope', values: {} } }],
  };

  /** Мир, в котором ядро судит систему: та же сцена, список систем пуст. */
  const world = () => loadScene(SCENE_VALUE as unknown as SceneDef).world;

  const rulesFor = (sites: readonly SystemSite[]): readonly ValidationRule[] =>
    engineValidationRules(DEFAULT_ENGINE_KINDS, {}, sites);

  it('сломанная система внутри конфига подсвечивается на своей записи, а не на документе', () => {
    const value = { ...SCENE_VALUE, systems: [good, bad] };
    const report = check({ [SCENE]: { kind: 'scene', value } }, rulesFor(IN_SCENE));
    const issues = report.forDocument(SCENE).filter((found) => found.ruleId === SYSTEM_RULE);
    // Ровно одна находка: годная запись рядом молчит, хотя лежит в том же поле.
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.path).toEqual(['systems', 1]);
    // Полученное — сама запись: адрес указывает на неё, а не на её окрестность.
    expect(issue.received).toEqual(bad);
    expect(issue.expected).toEqual({
      kind: 'accepted',
      by: VALIDATE_SYSTEM,
      detail: thrownBy(() => validateSystem(bad as unknown as SystemDef, world())),
    });
    expect(issue.reasonParams['against']).toBe(SCENE);
    // Находка спрашивается по адресу записи — то, ради чего ED-30 требует путь.
    expect(report.at(SCENE, ['systems', 1])).toHaveLength(1);
  });

  it('годный список систем внутри конфига находок не даёт', () => {
    const value = { ...SCENE_VALUE, systems: [good] };
    const report = check({ [SCENE]: { kind: 'scene', value } }, rulesFor(IN_SCENE));
    expect(report.issues).toHaveLength(0);
  });

  it('вид документа-носителя — тоже параметр: список систем конфига матча', () => {
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: SCENE_VALUE },
        [MATCH]: { kind: 'match', value: { systems: [bad] } },
      },
      rulesFor([{ kind: 'match', path: ['systems'] }]),
    );
    const issue = report.forDocument(MATCH).find((found) => found.ruleId === SYSTEM_RULE)!;
    expect(issue.path).toEqual(['systems', 0]);
    // Мир по-прежнему берётся у сцены: систему судит тот, кто знает компоненты.
    expect(issue.reasonParams['against']).toBe(SCENE);
  });

  it('раскладки складываются: и список внутри конфига, и системы отдельными документами', () => {
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: { ...SCENE_VALUE, systems: [bad] } },
        [SYSTEM]: { kind: 'system', value: { ...bad, name: 'lonely', order: 7 } },
      },
      rulesFor([...IN_SCENE, ...DEFAULT_SYSTEM_SITES]),
    );
    expect(report.at(SCENE, ['systems', 0])).toHaveLength(1);
    // У отдельного документа адрес прежний — корень: документ и есть система.
    expect(report.at(SYSTEM, [])).toHaveLength(1);
  });

  it('умолчание — система отдельным документом: правило встаёт на свой вид и адресует корень', () => {
    const rule = engineValidationRules().find((found) => found.id === SYSTEM_RULE)!;
    expect(rule.appliesTo).toEqual(['system']);
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [SYSTEM]: { kind: 'system', value: bad },
    });
    expect(report.forDocument(SYSTEM).find((found) => found.ruleId === SYSTEM_RULE)?.path).toEqual([]);
  });

  it('сцена, сломанная не системой, молчит правилом систем: мира нет, судить нечем', () => {
    const value = { ...SCENE_VALUE, initial: [{ prefab: 'ghost' }], systems: [bad] };
    const report = check({ [SCENE]: { kind: 'scene', value } }, rulesFor(IN_SCENE));
    expect(report.forDocument(SCENE).filter((found) => found.ruleId === SYSTEM_RULE)).toHaveLength(0);
    // Отчитывается о ней её собственное правило — и на документе целиком.
    const issue = report.forDocument(SCENE).find((found) => found.ruleId === SCENE_RULE)!;
    expect(issue.path).toEqual([]);
    expect(detailOf(issue)).toBe(thrownBy(() => loadScene(value as unknown as SceneDef)));
  });

  it('система, сломавшая сцену, названа дважды: документом и своей записью', () => {
    // Два сообщения об одном нарушении не противоречат друг другу, а называют
    // его с разной точностью — то же, что у пары `loadScene` и правила
    // расстановки. Ради второго, точного, правило и получило адреса.
    const value = { ...SCENE_VALUE, systems: [bad] };
    const report = check({ [SCENE]: { kind: 'scene', value } }, rulesFor(IN_SCENE));
    expect(report.forDocument(SCENE).map((found) => found.ruleId).sort()).toEqual([SCENE_RULE, SYSTEM_RULE]);
  });

  it('поля `systems` нет или оно не список — правило молчит: форму проверяет ядро', () => {
    expect(check({ [SCENE]: { kind: 'scene', value: SCENE_VALUE } }, rulesFor(IN_SCENE)).issues).toHaveLength(0);
    const report = check({ [SCENE]: { kind: 'scene', value: { ...SCENE_VALUE, systems: 7 } } }, rulesFor(IN_SCENE));
    expect(report.forDocument(SCENE).filter((found) => found.ruleId === SYSTEM_RULE)).toHaveLength(0);
  });

  it('ED-8: правка одной записи возвращает правило в работу и переносит находку', () => {
    // Имя и `order` у систем разные: равные ядро отвергает само (DET-9), и это
    // проверка списка целиком, а не одной записи — её и делает правило сцены.
    const chase = { ...good, name: 'chase', order: 3 };
    const editor = sessionOf({ [SCENE]: { kind: 'scene', value: { ...SCENE_VALUE, systems: [good, chase] } } });
    const validator = validatorOf(rulesFor(IN_SCENE));
    expect(validator.run(editor).issues).toHaveLength(0);
    validator.run(editor);
    // Прогон без правок не исполняет ничего: подъём мира — дорогая операция, и
    // ED-8 «в реальном времени» держится именно на этом.
    expect(validator.lastRun.executed).toBe(0);

    editor.applyOperation('document.setValue', {
      document: SCENE,
      path: ['systems', 1, 'do', 0, 'modifyComponent', 'component'],
      value: 'Nope',
    });
    const report = validator.run(editor);
    expect(validator.lastRun.executed).toBeGreaterThan(0);
    expect(report.at(SCENE, ['systems', 1]).map((found) => found.ruleId)).toEqual([SYSTEM_RULE]);
  });
});

describe('ED-14: манифест визуалов — все нарушения разом и с адресом', () => {
  it('несколько нарушений в одном документе дают несколько находок с путями', () => {
    const value = {
      entities: {
        grunt: { model: 'models/grunt.mdx', scale: -1 },
        tower: { model: 42 },
      },
    };
    const report = check({ [MANIFEST]: { kind: 'manifest', value } });
    const issues = report.forDocument(MANIFEST).filter((found) => found.ruleId === MANIFEST_RULE);
    expect(issues).toHaveLength(2);
    const scale = report.at(MANIFEST, ['entities', 'grunt', 'scale'])[0]!;
    expect(scale.received).toBe(-1);
    expect(scale.expected).toMatchObject({ kind: 'accepted' });
    // Вторая находка адресована своим полем, а не свалена в один узел с первой.
    expect(report.at(MANIFEST, ['entities', 'tower', 'model'])[0]?.received).toBe(42);
  });

  it('адрес отсутствующего поля усекается до места, которое в документе есть', () => {
    // Адрес из сообщения прикладывается к документу шаг за шагом, и в находку
    // попадает только сошедшаяся часть: `model` в записи нет, поэтому находка
    // адресует саму запись, а какого поля не хватает, говорит сообщение.
    const report = check({ [MANIFEST]: { kind: 'manifest', value: { entities: { tower: {} } } } });
    const issue = report.forDocument(MANIFEST).find((found) => found.ruleId === MANIFEST_RULE)!;
    expect(issue.path).toEqual(['entities', 'tower']);
    expect(detailOf(issue)).toContain('entities.tower.model');
  });

  it('валидный манифест находок не даёт', () => {
    expect(
      check({
        [SCENE]: { kind: 'scene', value: SCENE_VALUE },
        [MANIFEST]: { kind: 'manifest', value: MANIFEST_VALUE },
      }).ok,
    ).toBe(true);
  });
});

/**
 * ED-14, ASSET-8: секция эффектов проверяется тем же правилом, что остальной
 * манифест, — но только если сборка подала правилам описание типов (CAM-9).
 * Описание здесь выдуманное: своего перечня типов у редактора нет и быть не
 * должно, а «правило берёт то, что дали» проверяется как раз чужим набором.
 */
describe('ED-14: секция эффектов камеры по описанию типов (CAM-9)', () => {
  const description: CameraEffectsDescription = {
    types: [
      { id: 'shake', kind: 'impulse', params: [{ name: 'decay', defaultValue: 1.4, min: 0, max: 10 }] },
      { id: 'sway', kind: 'lasting', params: [{ name: 'rollAmp', defaultValue: 0.05, min: 0 }] },
    ],
    binding: { impulse: [{ name: 'amplitude', defaultValue: 0.6, min: 0 }], lasting: [] },
  };

  const withEffects = (section: JsonValue): JsonValue => ({ ...MANIFEST_VALUE, cameraEffects: section });

  const described = (section: JsonValue): ValidationReport =>
    check({ [MANIFEST]: { kind: 'manifest', value: withEffects(section) } }, [
      ...engineValidationRules(DEFAULT_ENGINE_KINDS, { cameraEffects: description }),
    ]);

  it('без описания правило о типах молчит: перечня типов у него нет', () => {
    const report = check(
      { [MANIFEST]: { kind: 'manifest', value: withEffects({ events: { Boom: { effect: 'nope' } } }) } },
      [...engineValidationRules()],
    );
    expect(report.forDocument(MANIFEST)).toHaveLength(0);
  });

  it('неизвестный тип — находка важности warning, и она не запрещает сохранение (ED-3)', () => {
    const report = described({ events: { Boom: { effect: 'wobble-3000' } } });
    const issue = report.forDocument(MANIFEST).find((found) => found.ruleId === MANIFEST_RULE)!;
    expect(issue.severity).toBe('warning');
    expect(issue.path).toEqual(['cameraEffects', 'events', 'Boom', 'effect']);
    expect(detailOf(issue)).toContain('wobble-3000');
    // Предупреждения `ok` не отменяют: документ с типом из будущей сборки
    // камеры остаётся сохраняемым (ASSET-8).
    expect(report.ok).toBe(true);
  });

  it('значение вне диапазона — ошибка с адресом до поля', () => {
    const report = described({ events: { Boom: { effect: 'shake', decay: 99 } } });
    const issue = report.at(MANIFEST, ['cameraEffects', 'events', 'Boom', 'decay'])[0]!;
    expect(issue.ruleId).toBe(MANIFEST_RULE);
    expect(issue.severity).toBe('error');
    expect(issue.received).toBe(99);
    expect(report.ok).toBe(false);
  });

  it('законная запись находок не даёт', () => {
    const report = described({ events: { Boom: { effect: 'shake', decay: 2, amplitude: 0.5 } } });
    expect(report.forDocument(MANIFEST)).toHaveLength(0);
  });
});

/**
 * ED-8, CAM-6: ключ таблицы длящихся эффектов — имя компоненты-состояния, и
 * выводится оно из открытой сцены (SER-7). Правило междокументное, поэтому и
 * живёт рядом с соседями по паре, а не в правилах движка.
 */
describe('ED-8: имя состояния в таблице длящихся эффектов', () => {
  const manifestWith = (states: JsonValue): JsonValue => ({ ...MANIFEST_VALUE, cameraEffects: { states } });

  it('имя, которого не объявляет ни одна сцена, — предупреждение с адресом записи', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: manifestWith({ Drunk: { effect: 'sway' } }) },
    });
    const issue = report.forDocument(MANIFEST).find((found) => found.ruleId === CAMERA_EFFECT_STATE_RULE)!;
    expect(issue.severity).toBe('warning');
    expect(issue.path).toEqual(['cameraEffects', 'states', 'Drunk']);
    expect(knownOf(issue)).toEqual(['Pos']);
    // Предупреждение сохранению не мешает (ED-3).
    expect(report.ok).toBe(true);
  });

  it('объявленная сценой компонента находок не даёт', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: manifestWith({ Pos: { effect: 'sway' } }) },
    });
    expect(report.forDocument(MANIFEST).filter((f) => f.ruleId === CAMERA_EFFECT_STATE_RULE)).toHaveLength(0);
  });

  it('без открытой сцены правило молчит: незагруженная сцена — не привязка в никуда', () => {
    const report = check({
      [MANIFEST]: { kind: 'manifest', value: manifestWith({ Drunk: { effect: 'sway' } }) },
    });
    expect(report.issues.filter((f) => f.ruleId === CAMERA_EFFECT_STATE_RULE)).toHaveLength(0);
  });
});

describe('ED-11: карта кривизны', () => {
  it('символ вне алфавита адресуется рядом карты', () => {
    const value = { ...CURVATURE_VALUE, rows: ['.z', '..'] };
    const report = check({ [CURVATURE]: { kind: 'curvature', value } });
    const issue = report.forDocument(CURVATURE)[0]!;
    expect(issue.ruleId).toBe(CURVATURE_RULE);
    expect(issue.path).toEqual(['rows', 0]);
    expect(issue.received).toBe('.z');
  });

  it('несовпадение сетки с террейном видно сразу и является предупреждением', () => {
    const report = check({
      [TERRAIN]: { kind: 'terrain', value: TERRAIN_VALUE },
      [CURVATURE]: { kind: 'curvature', value: { width: 3, height: 2, rows: ['...', '...'] } },
    });
    const issue = report.forDocument(CURVATURE).find((found) => found.ruleId === CURVATURE_GRID_RULE)!;
    expect(issue.path).toEqual(['width']);
    expect(issue.received).toBe(3);
    expect(issue.expected).toEqual({ kind: 'oneOf', values: [2] });
    expect(issue.severity).toBe('warning');
  });

  it('без открытого террейна о сетке не судят', () => {
    const report = check({
      [CURVATURE]: { kind: 'curvature', value: { width: 3, height: 2, rows: ['...', '...'] } },
    });
    expect(report.issues).toHaveLength(0);
  });
});

/**
 * Раскладка реального проекта: отдельного документа террейна нет вовсе — ассет
 * лежит полем конфига сцены (SER-7, TERR-2), и кисть уровня (ED-10) правит его
 * там же. Правило, выводившее адрес из вида документа, на таком проекте не
 * срабатывало никогда, и сравнение двух чисел приходилось писать потребителю у
 * себя — вторая реализация правила с одним источником истины (ED-1, ED-30).
 */
describe('ED-11: ассет террейна внутри конфига сцены', () => {
  const TERRAIN_IN_SCENE: readonly TerrainSite[] = [{ kind: 'scene', path: ['terrain'] }];
  const RULES = crossDocumentRules(DEFAULT_PAIR_KINDS, DEFAULT_PLACEMENT_SITES, TERRAIN_IN_SCENE);
  const NESTED_SCENE = { ...SCENE_VALUE, terrain: TERRAIN_VALUE };
  const WIDER_CURVATURE = { width: 3, height: 2, rows: ['...', '...'] };

  it('несовпадение сетки видно, хотя документа вида terrain в проекте нет', () => {
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: NESTED_SCENE },
        [CURVATURE]: { kind: 'curvature', value: WIDER_CURVATURE },
      },
      RULES,
    );
    const issue = report.forDocument(CURVATURE).find((found) => found.ruleId === CURVATURE_GRID_RULE)!;
    expect(issue.path).toEqual(['width']);
    expect(issue.received).toBe(3);
    expect(issue.expected).toEqual({ kind: 'oneOf', values: [2] });
    // Важность прежняя: рантайм переживает несовпадение игнором (ASSET-7).
    expect(issue.severity).toBe('warning');
    // С чем не совпало — документ-носитель сетки, то есть сам конфиг сцены.
    expect(issue.reasonParams['against']).toBe(SCENE);
  });

  it('совпавшая сетка находок не даёт', () => {
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: NESTED_SCENE },
        [CURVATURE]: { kind: 'curvature', value: CURVATURE_VALUE },
      },
      RULES,
    );
    expect(report.issues).toHaveLength(0);
  });

  it('сцена без ассета террейна по адресу молчит, как молчит незагруженный документ', () => {
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: SCENE_VALUE },
        [CURVATURE]: { kind: 'curvature', value: WIDER_CURVATURE },
      },
      RULES,
    );
    expect(report.issues).toHaveLength(0);
  });

  it('ED-8: прогон без правок ничего не исполняет, а правка сетки в сцене возвращает правило в работу', () => {
    const editor = sessionOf({
      [SCENE]: { kind: 'scene', value: NESTED_SCENE },
      [CURVATURE]: { kind: 'curvature', value: CURVATURE_VALUE },
    });
    const validator = validatorOf(RULES);
    expect(validator.run(editor).issues).toHaveLength(0);
    validator.run(editor);
    expect(validator.lastRun.executed).toBe(0);

    editor.applyOperation('document.setValue', { document: SCENE, path: ['terrain', 'width'], value: 3 });
    const report = validator.run(editor);
    expect(validator.lastRun.executed).toBeGreaterThan(0);
    expect(report.forDocument(CURVATURE).map((found) => found.ruleId)).toContain(CURVATURE_GRID_RULE);
  });
});

describe('ED-19: рассинхронизация пары «prefab — запись манифеста»', () => {
  it('prefab без записи манифеста адресуется именем в списке prefabs', () => {
    const value = {
      ...SCENE_VALUE,
      prefabs: [...SCENE_VALUE.prefabs, { name: 'tower', components: {} }],
    };
    const report = check({
      [SCENE]: { kind: 'scene', value },
      [MANIFEST]: { kind: 'manifest', value: MANIFEST_VALUE },
    });
    const issue = report.forDocument(SCENE).find((found) => found.ruleId === VISUAL_FOR_PREFAB_RULE)!;
    expect(issue.path).toEqual(['prefabs', 1, 'name']);
    expect(issue.received).toBe('tower');
    expect(issue.expected).toEqual({
      kind: 'reference',
      targets: [{ documentId: MANIFEST, path: ['entities'] }],
      known: ['grunt'],
    });
  });

  it('запись манифеста без prefab’а адресуется ключом записи', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: { entities: { ...MANIFEST_VALUE.entities, ghost: { model: 'm' } } } },
    });
    const issue = report.forDocument(MANIFEST).find((found) => found.ruleId === PREFAB_FOR_VISUAL_RULE)!;
    expect(issue.path).toEqual(['entities', 'ghost']);
    expect(knownOf(issue)).toContain('grunt');
  });

  it('носители, которые синтезирует загрузчик сцены, записью манифеста не сиротеют', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: { entities: { ...MANIFEST_VALUE.entities, Terrain: { model: 'm' } } } },
    });
    expect(report.forDocument(MANIFEST).filter((found) => found.ruleId === PREFAB_FOR_VISUAL_RULE)).toHaveLength(0);
  });

  it('без открытого манифеста пара не судится', () => {
    const report = check({ [SCENE]: { kind: 'scene', value: SCENE_VALUE } });
    expect(report.issues.filter((found) => found.ruleId === VISUAL_FOR_PREFAB_RULE)).toHaveLength(0);
  });
});

describe('ED-19: запись расстановки на несуществующий prefab', () => {
  it('адресуется сама запись, а не документ целиком', () => {
    const value = { ...SCENE_VALUE, initial: [{ prefab: 'grunt' }, { prefab: 'ghost' }] };
    const report = check({
      [SCENE]: { kind: 'scene', value },
      [MANIFEST]: { kind: 'manifest', value: MANIFEST_VALUE },
    });
    const issue = report.forDocument(SCENE).find((found) => found.ruleId === PLACEMENT_PREFAB_RULE)!;
    expect(issue.path).toEqual(['initial', 1, 'prefab']);
    expect(issue.received).toBe('ghost');
    expect(issue.expected).toMatchObject({ kind: 'reference', known: ['Arena', 'Terrain', 'grunt'] });
    // Ядро о том же нарушении отчитывается своим правилом и без адреса записи:
    // два сообщения не противоречат друг другу, а называют одно нарушение с
    // разной точностью.
    expect(report.forDocument(SCENE).some((found) => found.ruleId === SCENE_RULE)).toBe(true);
  });

  it('валидная расстановка находок не даёт', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: MANIFEST_VALUE },
    });
    expect(report.issues).toHaveLength(0);
  });
});

describe('PRES-2: ссылка decoration на запись манифеста', () => {
  const PRESENTATION = 'content/scenes/arena.presentation.json';
  const WITH_DECORATIONS = {
    entities: { grunt: { model: 'models/grunt.mdx' } },
    decorations: { grass: { model: 'models/grass.mdx' } },
  };

  it('неразрешимый `visual` подсвечивается адресно и с именем в причине', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: WITH_DECORATIONS },
      [PRESENTATION]: {
        kind: 'presentation',
        value: { decorations: [{ visual: 'grass', x: 0, y: 0 }, { visual: 'ghost', x: 1, y: 1 }] },
      },
    });
    const issue = report
      .forDocument(PRESENTATION)
      .find((found) => found.ruleId === DECORATION_VISUAL_RULE)!;
    expect(issue.path).toEqual(['decorations', 1, 'visual']);
    expect(issue.received).toBe('ghost');
    expect(issue.reasonParams['name']).toBe('ghost');
    // Рантайм переживает это заглушкой (ASSET-6) — значит предупреждение, а не
    // запрет сохранять.
    expect(issue.severity).toBe('warning');
    // Известное — оба раздела в одном пространстве ключей (ASSET-9).
    expect(knownOf(issue)).toEqual(['grass', 'grunt']);
  });

  it('вид из раздела сущностей ссылке годится: копии в decoration-виды не требуется', () => {
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: WITH_DECORATIONS },
      [PRESENTATION]: { kind: 'presentation', value: { decorations: [{ visual: 'grunt', x: 0, y: 0 }] } },
    });
    expect(report.forDocument(PRESENTATION)).toHaveLength(0);
  });

  it('незагруженный манифест правило молчит, а не объявляет все ссылки битыми', () => {
    const report = check({
      [PRESENTATION]: { kind: 'presentation', value: { decorations: [{ visual: 'ghost', x: 0, y: 0 }] } },
    });
    expect(report.issues).toHaveLength(0);
  });

  it('запись decoration-вида рассинхронизацией пары «prefab — запись» не считается (ASSET-9)', () => {
    // ED-19 нормирует пару для сим-сущностей; у decoration сим-стороны нет, и
    // раздел decoration-видов в находки `prefabForVisual` попадать не должен.
    const report = check({
      [SCENE]: { kind: 'scene', value: SCENE_VALUE },
      [MANIFEST]: { kind: 'manifest', value: WITH_DECORATIONS },
    });
    expect(report.issues.filter((found) => found.ruleId === PREFAB_FOR_VISUAL_RULE)).toEqual([]);
  });

  it('адрес списка — параметр правила, а не его знание (ED-25)', () => {
    const rules = crossDocumentRules(DEFAULT_PAIR_KINDS, DEFAULT_PLACEMENT_SITES, undefined, [
      { kind: 'presentation', path: ['props'] },
    ]);
    const report = check(
      {
        [SCENE]: { kind: 'scene', value: SCENE_VALUE },
        [MANIFEST]: { kind: 'manifest', value: WITH_DECORATIONS },
        [PRESENTATION]: { kind: 'presentation', value: { props: [{ visual: 'ghost', x: 0, y: 0 }] } },
      },
      rules,
    );
    const issue = report
      .forDocument(PRESENTATION)
      .find((found) => found.ruleId === DECORATION_VISUAL_RULE)!;
    expect(issue.path).toEqual(['props', 0, 'visual']);
  });
});
