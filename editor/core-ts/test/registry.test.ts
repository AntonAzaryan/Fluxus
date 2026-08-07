/**
 * ED-25 «Расширяемость через реестры вкладов»: пять реестров и требование
 * «добавление вклада MUST NOT требовать изменений в уже зарегистрированных
 * вкладах и в каркасе».
 *
 * Доменные имена («террейн», «префаб», «сцена») в этом файле есть и должны
 * быть: фикстуры играют роль вкладов, а вклад — единственное место, где
 * доменное знание живёт по ED-25. Каркас проверяет `registryFrame.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ContributionRegistry } from '../src/registry/contribution.js';
import { createEditorContributions } from '../src/registry/contributions.js';
import type {
  FieldEditorContribution,
  PaletteCommandContribution,
  ValidationRuleContribution,
  ViewportToolContribution,
  WorkspaceAreaContribution,
} from '../src/registry/kinds.js';

const sceneArea: WorkspaceAreaContribution = {
  id: 'scene',
  descriptionKey: 'ui.area.scene',
  hotkey: 'F1',
  editableTypes: [{ id: 'scene', descriptionKey: 'schema.scene', schemaId: 'scene' }],
};
const objectsArea: WorkspaceAreaContribution = {
  id: 'objects',
  descriptionKey: 'ui.area.objects',
  hotkey: 'F2',
  editableTypes: [{ id: 'prefab', descriptionKey: 'schema.prefab', schemaId: 'prefab' }],
};

const raiseTool: ViewportToolContribution = {
  id: 'terrain.raise',
  descriptionKey: 'ui.tool.terrain.raise',
  areas: ['scene'],
  operations: ['terrain.raise'],
};
const placeTool: ViewportToolContribution = {
  id: 'placement',
  descriptionKey: 'ui.tool.placement',
  areas: ['scene'],
};

const numberField: FieldEditorContribution = {
  id: 'field.number',
  descriptionKey: 'ui.field.number',
  fieldType: 'number',
};
const vectorField: FieldEditorContribution = {
  id: 'field.vector',
  descriptionKey: 'ui.field.vector',
  fieldType: 'vector2',
};

const saveCommand: PaletteCommandContribution = {
  id: 'project.save',
  descriptionKey: 'ui.command.save',
  keybinding: 'Ctrl+S',
};
const searchCommand: PaletteCommandContribution = {
  id: 'project.search',
  descriptionKey: 'ui.command.search',
  keybinding: 'Ctrl+P',
};

const refRule: ValidationRuleContribution = {
  id: 'component.exists',
  descriptionKey: 'ui.rule.componentExists',
  appliesTo: ['system'],
};
const heightRule: ValidationRuleContribution = {
  id: 'height.range',
  descriptionKey: 'ui.rule.heightRange',
  appliesTo: ['scene'],
};

describe('ED-25: реестры вкладов', () => {
  it('заводит реестр на каждый из пяти видов вклада', () => {
    const contributions = createEditorContributions();
    const kinds = [
      contributions.areas.kind,
      contributions.viewportTools.kind,
      contributions.fieldEditors.kind,
      contributions.commands.kind,
      contributions.validationRules.kind,
    ];
    expect(kinds).toEqual(['area', 'tool', 'field', 'command', 'rule']);
  });

  it('второй вклад каждого вида не трогает первый', () => {
    const contributions = createEditorContributions();
    contributions.areas.register(sceneArea);
    contributions.viewportTools.register(raiseTool);
    contributions.fieldEditors.register(numberField);
    contributions.commands.register(saveCommand);
    contributions.validationRules.register(refRule);

    const before = structuredClone({
      area: contributions.areas.get('scene'),
      tool: contributions.viewportTools.get('terrain.raise'),
      field: contributions.fieldEditors.get('field.number'),
      command: contributions.commands.get('project.save'),
      rule: contributions.validationRules.get('component.exists'),
    });

    contributions.areas.register(objectsArea);
    contributions.viewportTools.register(placeTool);
    contributions.fieldEditors.register(vectorField);
    contributions.commands.register(searchCommand);
    contributions.validationRules.register(heightRule);

    expect({
      area: contributions.areas.get('scene'),
      tool: contributions.viewportTools.get('terrain.raise'),
      field: contributions.fieldEditors.get('field.number'),
      command: contributions.commands.get('project.save'),
      rule: contributions.validationRules.get('component.exists'),
    }).toEqual(before);
    // Тот же объект, а не только равный: реестр не переписывает вклады.
    expect(contributions.areas.get('scene')).toBe(sceneArea);
    expect(contributions.areas.all()).toEqual([objectsArea, sceneArea]);
  });

  it('перечисляет вклады независимо от порядка регистрации', () => {
    const forward = createEditorContributions();
    forward.areas.register(sceneArea);
    forward.areas.register(objectsArea);
    const backward = createEditorContributions();
    backward.areas.register(objectsArea);
    backward.areas.register(sceneArea);

    expect(forward.areas.all()).toEqual(backward.areas.all());
  });

  it('отвергает второй вклад с тем же id', () => {
    const contributions = createEditorContributions();
    contributions.areas.register(sceneArea);
    expect(() => contributions.areas.register({ ...sceneArea, hotkey: 'F9' })).toThrow(
      /уже зарегистрирован/,
    );
  });

  it('отвергает двух претендентов на один единоличный ресурс', () => {
    const contributions = createEditorContributions();
    contributions.fieldEditors.register(numberField);
    expect(() =>
      contributions.fieldEditors.register({ ...vectorField, fieldType: 'number' }),
    ).toThrow(/тип поля "number" — за вкладом "field.number"/);

    contributions.areas.register(sceneArea);
    expect(() => contributions.areas.register({ ...objectsArea, hotkey: 'F1' })).toThrow(
      /горячая клавиша "F1" — за вкладом "scene"/,
    );
  });

  it('подменяет вклад по id и отвергает подмену незарегистрированного', () => {
    const contributions = createEditorContributions();
    contributions.fieldEditors.register(numberField);
    const replacement: FieldEditorContribution = { ...numberField, descriptionKey: 'ui.field.int' };
    contributions.fieldEditors.override(replacement);
    expect(contributions.fieldEditors.get('field.number')).toBe(replacement);
    expect(contributions.fieldEditors.all()).toHaveLength(1);

    expect(() => contributions.fieldEditors.override(vectorField)).toThrow(/не зарегистрирован/);
  });

  it('принимает вклад, расширенный слоем выше, без второго реестра', () => {
    interface MountedArea extends WorkspaceAreaContribution {
      mount(): string;
    }
    const registry = new ContributionRegistry<MountedArea>({ kind: 'area' });
    registry.register({ ...sceneArea, mount: () => 'смонтирована' });
    expect(registry.get('scene')?.mount()).toBe('смонтирована');
  });
});
