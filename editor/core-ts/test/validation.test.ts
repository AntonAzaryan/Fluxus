/**
 * Каркас валидации: структурный результат (ED-30) и валидация в реальном
 * времени (ED-8), плюс правило как вклад (ED-25).
 *
 * Правила здесь синтетические и ядра не зовут — проверяется форма результата и
 * поведение прогона, а не чьё-либо доменное правило. Вызовы движка пиннит
 * `validationRules.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  createEditorSession,
  getAtPath,
  type EditorSession,
  type JsonValue,
} from '../src/document/index.js';
import { createOperationRegistry, registerBuiltinOperations } from '../src/operations/index.js';
import {
  ContributionRegistry,
  createEditorContributions,
  type FieldEditorContribution,
  type PaletteCommandContribution,
  type ViewportToolContribution,
  type WorkspaceAreaContribution,
} from '../src/registry/index.js';
import {
  createValidator,
  formatIssue,
  registerValidationRules,
  reasonKey,
  ruleDescriptionKey,
  RULE_FAILED,
  type ValidationRule,
} from '../src/validation/index.js';

const NUMBERS = 'content/numbers.json';
const OTHER = 'content/other.json';

/** Нечётное значение поля — нарушение. Доменного смысла нет и не нужно. */
const evenRule: ValidationRule = {
  id: 'test.even',
  descriptionKey: ruleDescriptionKey('test.even'),
  appliesTo: ['numbers'],
  check(run) {
    const value = getAtPath(run.document.value, ['value']);
    if (typeof value !== 'number' || value % 2 === 0) return;
    run.report({
      path: ['value'],
      expected: { kind: 'range', min: 0, integer: true },
      code: 'odd',
      params: { value },
    });
  },
};

/** Правило, читающее соседний документ, — на нём проверяется кэш по прочитанному. */
const echoRule: ValidationRule = {
  id: 'test.echo',
  descriptionKey: ruleDescriptionKey('test.echo'),
  appliesTo: ['numbers'],
  severity: 'warning',
  check(run) {
    for (const document of run.documentsOfKind('other')) {
      if (getAtPath(document.value, ['flag']) !== true) continue;
      run.report({
        path: [],
        expected: { kind: 'presence', present: false },
        code: 'flagged',
        params: { source: document.id },
      });
    }
  },
};

const fallingRule: ValidationRule = {
  id: 'test.falling',
  descriptionKey: ruleDescriptionKey('test.falling'),
  appliesTo: ['numbers'],
  check() {
    throw new Error('правило сломалось');
  },
};

function rulesOf(...rules: readonly ValidationRule[]): ContributionRegistry<ValidationRule> {
  const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(registry, rules);
  return registry;
}

function sessionOf(value: JsonValue = { value: 3 }): EditorSession {
  const editor = createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
  editor.openDocument({ id: NUMBERS, kind: 'numbers', value });
  return editor;
}

describe('ED-30: результат валидации структурный', () => {
  it('находка называет правило, путь, полученное значение и ожидание', () => {
    const validator = createValidator({ rules: rulesOf(evenRule) });
    const report = validator.run(sessionOf({ value: 3 }));
    expect(report.issues).toEqual([
      {
        ruleId: 'test.even',
        severity: 'error',
        documentId: NUMBERS,
        path: ['value'],
        received: 3,
        expected: { kind: 'range', min: 0, integer: true },
        reasonKey: 'validation.reason.test.even.odd',
        reasonParams: { value: 3 },
      },
    ]);
  });

  it('текста причины в находке нет — есть ключ ресурса (ED-27, ED-28)', () => {
    const validator = createValidator({ rules: rulesOf(evenRule) });
    const issue = validator.run(sessionOf()).issues[0]!;
    // Отсутствие ресурса даёт сам ключ, а не пустую строку (ED-28).
    expect(formatIssue(issue, { text: (key) => key })).toBe(issue.reasonKey);
    expect(
      formatIssue(issue, { text: () => 'нечётное {value} по адресу {path}' }),
    ).toBe(`нечётное 3 по адресу ${NUMBERS}:value`);
  });

  it('находки адресуемы: по документу, ровно по пути и по пути с вложенным', () => {
    const deep: ValidationRule = {
      id: 'test.deep',
      descriptionKey: ruleDescriptionKey('test.deep'),
      appliesTo: ['numbers'],
      check(run) {
        run.report({ path: ['list', 10], expected: { kind: 'presence', present: false }, code: 'ten' });
        run.report({ path: ['list', 2], expected: { kind: 'presence', present: false }, code: 'two' });
      },
    };
    const validator = createValidator({ rules: rulesOf(deep) });
    const report = validator.run(sessionOf({ value: 2, list: [] }));
    expect(report.forDocument(NUMBERS)).toHaveLength(2);
    expect(report.at(NUMBERS, ['list', 2])).toHaveLength(1);
    expect(report.at(NUMBERS, ['list'])).toHaveLength(0);
    expect(report.under(NUMBERS, ['list'])).toHaveLength(2);
    // Шаг списка сравнивается как число: иначе десятая запись встала бы между
    // первой и второй.
    expect(report.issues.map((issue) => issue.path[1])).toEqual([2, 10]);
  });

  it('важность различает состояния, а ok считается по ошибкам', () => {
    const editor = sessionOf({ value: 3 });
    editor.openDocument({ id: OTHER, kind: 'other', value: { flag: true } });
    const report = createValidator({ rules: rulesOf(evenRule, echoRule) }).run(editor);
    expect(report.issues.map((issue) => issue.severity).sort()).toEqual(['error', 'warning']);
    expect(report.severityOf(NUMBERS)).toBe('error');
    expect(report.ok).toBe(false);

    const clean = createValidator({ rules: rulesOf(echoRule) }).run(editor);
    expect(clean.severityOf(NUMBERS)).toBe('warning');
    // Предупреждение — состояние, которое надо видеть, но не отказ (ASSET-7).
    expect(clean.ok).toBe(true);
  });

  it('упавшее правило становится собственной находкой, а не молчанием', () => {
    const validator = createValidator({ rules: rulesOf(evenRule, fallingRule) });
    const report = validator.run(sessionOf());
    const failure = report.issues.find((issue) => issue.ruleId === 'test.falling')!;
    expect(failure.reasonKey).toBe(reasonKey('test.falling', RULE_FAILED));
    expect(failure.expected).toEqual({ kind: 'accepted', by: 'test.falling', detail: 'правило сломалось' });
    // Остальные правила прогона при этом отработали.
    expect(report.issues.some((issue) => issue.ruleId === 'test.even')).toBe(true);
  });
});

describe('ED-8: валидация в реальном времени', () => {
  it('нетронутый документ правил не перезапускает', () => {
    const editor = sessionOf();
    const validator = createValidator({ rules: rulesOf(evenRule) });
    validator.run(editor);
    expect(validator.lastRun).toEqual({ executed: 1, reused: 0 });
    validator.run(editor);
    expect(validator.lastRun).toEqual({ executed: 0, reused: 1 });
  });

  it('правка документа перезапускает правила только на нём', () => {
    const editor = sessionOf();
    editor.openDocument({ id: OTHER, kind: 'numbers', value: { value: 2 } });
    const validator = createValidator({ rules: rulesOf(evenRule) });
    validator.run(editor);
    validator.run(editor);
    expect(validator.lastRun.executed).toBe(0);

    editor.applyOperation('document.setValue', { document: NUMBERS, path: ['value'], value: 5 });
    const report = validator.run(editor);
    expect(validator.lastRun).toEqual({ executed: 1, reused: 1 });
    expect(report.at(NUMBERS, ['value'])[0]?.received).toBe(5);
  });

  it('правило, читавшее соседний документ, перезапускается от его правки', () => {
    const editor = sessionOf({ value: 2 });
    editor.openDocument({ id: OTHER, kind: 'other', value: { flag: false } });
    const validator = createValidator({ rules: rulesOf(echoRule) });
    expect(validator.run(editor).issues).toHaveLength(0);

    editor.applyOperation('document.setValue', { document: OTHER, path: ['flag'], value: true });
    const report = validator.run(editor);
    expect(validator.lastRun.executed).toBe(1);
    expect(report.forDocument(NUMBERS)).toHaveLength(1);
  });

  it('появление документа нужного вида перезапускает междокументное правило', () => {
    const editor = sessionOf({ value: 2 });
    const validator = createValidator({ rules: rulesOf(echoRule) });
    validator.run(editor);
    editor.openDocument({ id: OTHER, kind: 'other', value: { flag: true } });
    expect(validator.run(editor).forDocument(NUMBERS)).toHaveLength(1);
  });

  it('снятие запомненного заставляет прогон посчитать заново', () => {
    const editor = sessionOf();
    const validator = createValidator({ rules: rulesOf(evenRule) });
    validator.run(editor);
    validator.invalidate(NUMBERS);
    validator.run(editor);
    expect(validator.lastRun.executed).toBe(1);
  });
});

describe('ED-25: правило валидации — вклад', () => {
  it('правила приходят из реестра вкладов редактора', () => {
    const contributions = createEditorContributions<
      WorkspaceAreaContribution,
      ViewportToolContribution,
      FieldEditorContribution,
      PaletteCommandContribution,
      ValidationRule
    >();
    registerValidationRules(contributions.validationRules, [evenRule]);
    const validator = createValidator({ rules: contributions.validationRules });
    expect(validator.run(sessionOf()).issues).toHaveLength(1);

    // Добавление второго правила — регистрация, и ничего больше: ни каркас, ни
    // первое правило при этом не правятся.
    contributions.validationRules.register(echoRule);
    const editor = sessionOf();
    editor.openDocument({ id: OTHER, kind: 'other', value: { flag: true } });
    expect(validator.run(editor).issues.map((issue) => issue.ruleId)).toEqual(['test.echo', 'test.even']);
  });

  it('правило запускается только на объявленных им видах редактируемого', () => {
    const editor = createEditorSession();
    editor.openDocument({ id: OTHER, kind: 'other', value: { value: 3 } });
    expect(createValidator({ rules: rulesOf(evenRule) }).run(editor).issues).toHaveLength(0);
  });
});
