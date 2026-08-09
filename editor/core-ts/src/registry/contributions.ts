/**
 * Набор реестров редактора — то, из чего собирается и интерфейс, и машинный
 * каталог (ED-25, ED-30). Пять реестров заводятся сразу, до появления второго
 * вклада: множественное число стоит уже в тексте ED-25, а запрет доменных
 * ветвлений в каркасе действует и при единственном вкладе — именно он не даёт
 * первому вкладу врасти в каркас.
 *
 * Параметры типов позволяют слою выше подставить свои, расширенные, вклады
 * (см. `kinds.ts`), не заводя второго набора реестров.
 */
import { ContributionRegistry } from './contribution.js';
import type {
  FieldEditorContribution,
  PaletteCommandContribution,
  ValidationRuleContribution,
  ViewportToolContribution,
  WorkspaceAreaContribution,
} from './kinds.js';

export interface EditorContributions<
  Area extends WorkspaceAreaContribution = WorkspaceAreaContribution,
  Tool extends ViewportToolContribution = ViewportToolContribution,
  Field extends FieldEditorContribution = FieldEditorContribution,
  Command extends PaletteCommandContribution = PaletteCommandContribution,
  Rule extends ValidationRuleContribution = ValidationRuleContribution,
> {
  readonly areas: ContributionRegistry<Area>;
  readonly viewportTools: ContributionRegistry<Tool>;
  readonly fieldEditors: ContributionRegistry<Field>;
  readonly commands: ContributionRegistry<Command>;
  readonly validationRules: ContributionRegistry<Rule>;
}

export function createEditorContributions<
  Area extends WorkspaceAreaContribution = WorkspaceAreaContribution,
  Tool extends ViewportToolContribution = ViewportToolContribution,
  Field extends FieldEditorContribution = FieldEditorContribution,
  Command extends PaletteCommandContribution = PaletteCommandContribution,
  Rule extends ValidationRuleContribution = ValidationRuleContribution,
>(): EditorContributions<Area, Tool, Field, Command, Rule> {
  return {
    areas: new ContributionRegistry<Area>({
      kind: 'area',
      claimName: 'горячая клавиша',
      claimOf: (area) => area.hotkey,
    }),
    viewportTools: new ContributionRegistry<Tool>({ kind: 'tool' }),
    fieldEditors: new ContributionRegistry<Field>({
      kind: 'field',
      claimName: 'тип поля',
      // Двое на одном типе поля — неоднозначность, которую разрешил бы порядок
      // регистрации, то есть реализация. Перекрытие делается `override`, и оно
      // видно в коде сборки.
      claimOf: (editor) => editor.fieldType,
    }),
    commands: new ContributionRegistry<Command>({
      kind: 'command',
      claimName: 'сочетание клавиш',
      claimOf: (command) => command.keybinding,
    }),
    validationRules: new ContributionRegistry<Rule>({ kind: 'rule' }),
  };
}
