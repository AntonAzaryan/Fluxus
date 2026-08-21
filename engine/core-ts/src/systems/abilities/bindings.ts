/**
 * Биндинги сцены (ABIL-8): то, что понятия игрока, здоровья, урона, команды и
 * смерти значат в конкретной сцене. Ядро этих понятий не приобретает — оно
 * читает имена, которые сцена объявила, ровно так же, как локомоушен читает имя
 * компонента ввода (LOC-1).
 *
 * Каждый биндинг необязателен, и его отсутствие делает недоступной ровно ту
 * часть платформы, которая на нём стоит; определение, называющее недоступный
 * источник, отвергается на загрузке (проверка живёт в `catalog.ts`, рядом с
 * разбором блока прерываний).
 */
import { componentSchema } from '../../ecs/world.js';
import { asObject, fail, literalName } from './parse.js';
import { INPUT_TARGET_X_FIELD, INPUT_TARGET_Y_FIELD, type AbilityCatalogDef, type CompiledBindings } from './model.js';
import type { SystemDef } from '../../dsl/evaluatedSystem.js';
import type { WorldState } from '../../types.js';

/** Место системы прерываний в шкале (DET-9) — граница для проверки ABIL-6. */
const CAST_INTERRUPT_ORDER = 830;

/** Имя компонента ввода по умолчанию — то же, что у `InputSystem` (TICK-4). */
const DEFAULT_INPUT_COMPONENT = 'Input';

export function compileBindings(def: AbilityCatalogDef, world: WorldState): CompiledBindings {
  const runtime = def.abilityRuntime;
  const path = 'abilityRuntime';
  const component = (value: unknown, key: string): string => {
    const name = literalName(value, `${path}.${key}`);
    if (componentSchema(world, name) === undefined) {
      fail(`${path}.${key}`, `компонент "${name}" не зарегистрирован`);
    }
    return name;
  };

  const deadMarker = runtime?.deadMarker === undefined ? undefined : component(runtime.deadMarker, 'deadMarker');
  const actionLock = runtime?.actionLock === undefined ? undefined : component(runtime.actionLock, 'actionLock');

  let teamComponent: string | undefined;
  let teamFieldName: string | undefined;
  if (runtime?.teamField !== undefined) {
    const pair = runtime.teamField as readonly unknown[];
    if (pair.length !== 2) fail(`${path}.teamField`, 'ожидалась пара ["Компонент", "поле"]');
    teamComponent = component(pair[0], 'teamField[0]');
    teamFieldName = literalName(pair[1], `${path}.teamField[1]`);
    if (componentSchema(world, teamComponent)!.fields[teamFieldName] === undefined) {
      fail(`${path}.teamField[1]`, `у компонента "${teamComponent}" нет поля "${teamFieldName}"`);
    }
  }

  let damageType: string | undefined;
  let damageEntityField: string | undefined;
  let damageAmountField: string | undefined;
  if (runtime?.damageEvent !== undefined) {
    const event = asObject(runtime.damageEvent, `${path}.damageEvent`);
    damageType = literalName(event.type, `${path}.damageEvent.type`);
    damageEntityField = literalName(event.entityField, `${path}.damageEvent.entityField`);
    damageAmountField = literalName(event.amountField, `${path}.damageEvent.amountField`);
    checkDamageEventOrder(def.systems, damageType, path);
  }

  const inputComponent =
    runtime?.inputComponent === undefined
      ? DEFAULT_INPUT_COMPONENT
      : literalName(runtime.inputComponent, `${path}.inputComponent`);
  const inputSchema = componentSchema(world, inputComponent);

  return {
    deadMarker,
    actionLock,
    teamComponent,
    teamFieldName,
    damageType,
    damageEntityField,
    damageAmountField,
    inputComponent,
    hasInput: inputSchema !== undefined,
    hasAimPoint:
      inputSchema?.fields[INPUT_TARGET_X_FIELD] !== undefined &&
      inputSchema.fields[INPUT_TARGET_Y_FIELD] !== undefined,
  };
}

/**
 * Система сцены, публикующая событие урона, обязана стоять раньше системы
 * прерываний (ABIL-6): шина видна системе только от систем с меньшим `order`
 * (EVT-2), и позже неё событие не сработало бы никогда — молча. Проверка
 * покрывает только JSON-системы; событие, публикуемое сборкой, остаётся на
 * совести сборки.
 */
function checkDamageEventOrder(
  systems: readonly SystemDef[] | undefined,
  damageType: string,
  path: string,
): void {
  for (const system of systems ?? []) {
    if (system.order < CAST_INTERRUPT_ORDER) continue;
    if (!emitsEvent(system.do, damageType)) continue;
    fail(
      `${path}.damageEvent.type`,
      `система "${system.name}" публикует "${damageType}" на order ${system.order}, ` +
        `а прерывания читают шину на ${CAST_INTERRUPT_ORDER} — событие не сработает никогда (ABIL-6)`,
    );
  }
}

/** Обход дерева действий в поисках `emitEvent` названного типа. */
function emitsEvent(node: unknown, type: string): boolean {
  if (Array.isArray(node)) return (node as readonly unknown[]).some((child) => emitsEvent(child, type));
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  const emit = record.emitEvent;
  if (typeof emit === 'object' && emit !== null && (emit as Record<string, unknown>).type === type) {
    return true;
  }
  return Object.values(record).some((child) => emitsEvent(child, type));
}
