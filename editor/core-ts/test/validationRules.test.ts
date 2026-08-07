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
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession, type JsonValue } from '../src/document/index.js';
import { ContributionRegistry } from '../src/registry/index.js';
import {
  createValidator,
  crossDocumentRules,
  engineValidationRules,
  registerValidationRules,
  CREATE_TERRAIN_GRID,
  CURVATURE_GRID_RULE,
  CURVATURE_RULE,
  LOAD_SCENE,
  MANIFEST_RULE,
  PLACEMENT_PREFAB_RULE,
  PREFAB_FOR_VISUAL_RULE,
  SCENE_RULE,
  SYSTEM_RULE,
  TERRAIN_RULE,
  VALIDATE_SYSTEM,
  VISUAL_FOR_PREFAB_RULE,
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

function check(documents: Readonly<Record<string, { kind: string; value: JsonValue }>>): ValidationReport {
  const editor: EditorSession = createEditorSession();
  for (const [id, document] of Object.entries(documents)) {
    editor.openDocument({ id, kind: document.kind, value: document.value });
  }
  const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(registry, ALL_RULES);
  return createValidator({ rules: registry }).run(editor);
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
