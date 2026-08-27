/**
 * Handle платформы поведения NPC (`data-driven-systems` SYS-10): имена
 * компонентов и полей, которые системы платформы читают на КАЖДОГО агента
 * КАЖДЫЙ тик, разрешаются здесь один раз — и дальше горячие циклы читают мир
 * числовыми ссылками, без словарного поиска по строкам.
 *
 * Разрешение происходит на первом входе в систему (SYS-10), а не в
 * конструкторе: мир системе даёт `SystemContext`, а конструктор зовётся
 * загрузчиком сцены, у которого своя очередь сборки. Место разрешения от этого
 * не «внутри цикла»: оно один раз на имя за жизнь системы, и обходу агентов
 * достаётся уже готовый набор.
 *
 * Резолв СТРОГИЙ для всего, что системе нужно (позиция, поля агента, таблица
 * угрозы, маршрут, режиссёр): опечатка в имени падает ошибкой сразу, а не
 * нулями посреди матча. Терпимость оставлена ровно там, где она была у
 * строкового пути, — см. `optionalComponentHandle` (`systems/optionalHandle.ts`).
 */
import {
  NPC_AGENT_COMPONENT,
  NPC_DIRECTOR_COMPONENT,
  NPC_ROUTE_COMPONENT,
  NPC_THREAT_COMPONENT,
  NPC_THREAT_SLOTS,
  WAYPOINT_COMPONENT,
  threatSourceField,
  threatValueField,
} from './components.js';
import type { CompiledNpcBindings } from './model.js';
import { optionalComponentHandle } from '../optionalHandle.js';
import type { ComponentHandle, FieldHandle, SystemContext } from '../../types.js';

/** Слот threat-таблицы (NPC-5): handle для чтения и имя поля — для команд и `peekField` (CMD-5). */
export interface NpcThreatSlotHandles {
  readonly sourceField: string;
  readonly source: FieldHandle;
  readonly valueField: string;
  readonly value: FieldHandle;
}

/** Сторона сущности (биндинг NPC-1): компонент и поле разрешаются парой либо не разрешаются вовсе. */
export interface NpcTeamHandles {
  readonly component: ComponentHandle;
  readonly field: FieldHandle;
}

/** Здоровье и его максимум (биндинг NPC-1, NPC-7): доля считается их отношением. */
export interface NpcHealthHandles {
  readonly value: FieldHandle;
  readonly max: FieldHandle;
}

export interface NpcHandles {
  readonly posX: FieldHandle;
  readonly posY: FieldHandle;
  /** Маркер мёртвых; `undefined` — сцена понятия смерти не имеет (NPC-1). */
  readonly deadMarker: ComponentHandle | undefined;
  readonly team: NpcTeamHandles | undefined;
  readonly health: NpcHealthHandles | undefined;

  readonly agent: ComponentHandle;
  readonly agentAction: FieldHandle;
  readonly agentBehavior: FieldHandle;
  readonly agentDecidedTick: FieldHandle;
  readonly agentEnteredTick: FieldHandle;
  readonly agentState: FieldHandle;
  readonly agentTarget: FieldHandle;

  readonly threat: ComponentHandle;
  readonly threatSlots: readonly NpcThreatSlotHandles[];

  readonly route: ComponentHandle;
  readonly routeRoute: FieldHandle;
  readonly routeIndex: FieldHandle;
  readonly waypointRoute: FieldHandle;
  readonly waypointIndex: FieldHandle;

  readonly directorReleased: FieldHandle;
  readonly directorTimer: FieldHandle;
  readonly directorWave: FieldHandle;
}

function threatSlots(ctx: SystemContext): NpcThreatSlotHandles[] {
  const slots: NpcThreatSlotHandles[] = [];
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    const sourceField = threatSourceField(slot);
    const valueField = threatValueField(slot);
    slots.push({
      sourceField,
      source: ctx.resolveField(NPC_THREAT_COMPONENT, sourceField),
      valueField,
      value: ctx.resolveField(NPC_THREAT_COMPONENT, valueField),
    });
  }
  return slots;
}

/**
 * Разрешает имена платформы в handle (SYS-10). Зовётся системой один раз, на
 * первом входе, ПОСЛЕ её ранних выходов: сцена, где системе нечего делать, не
 * должна падать на биндинге, до которого она бы и не дошла.
 */
export function resolveNpcHandles(ctx: SystemContext, bindings: CompiledNpcBindings): NpcHandles {
  const team = optionalComponentHandle(ctx, bindings.teamComponent);
  return {
    posX: ctx.resolveField(bindings.position, 'x'),
    posY: ctx.resolveField(bindings.position, 'y'),
    deadMarker: optionalComponentHandle(ctx, bindings.deadMarker),
    team:
      team === undefined
        ? undefined
        : { component: team, field: ctx.resolveField(bindings.teamComponent, bindings.teamField) },
    health: bindings.hasHealth
      ? {
          value: ctx.resolveField(bindings.healthComponent, bindings.healthField),
          max: ctx.resolveField(bindings.healthMaxComponent, bindings.healthMaxField),
        }
      : undefined,

    agent: ctx.resolveComponent(NPC_AGENT_COMPONENT),
    agentAction: ctx.resolveField(NPC_AGENT_COMPONENT, 'action'),
    agentBehavior: ctx.resolveField(NPC_AGENT_COMPONENT, 'behavior'),
    agentDecidedTick: ctx.resolveField(NPC_AGENT_COMPONENT, 'decidedTick'),
    agentEnteredTick: ctx.resolveField(NPC_AGENT_COMPONENT, 'enteredTick'),
    agentState: ctx.resolveField(NPC_AGENT_COMPONENT, 'state'),
    agentTarget: ctx.resolveField(NPC_AGENT_COMPONENT, 'target'),

    threat: ctx.resolveComponent(NPC_THREAT_COMPONENT),
    threatSlots: threatSlots(ctx),

    route: ctx.resolveComponent(NPC_ROUTE_COMPONENT),
    routeRoute: ctx.resolveField(NPC_ROUTE_COMPONENT, 'route'),
    routeIndex: ctx.resolveField(NPC_ROUTE_COMPONENT, 'index'),
    waypointRoute: ctx.resolveField(WAYPOINT_COMPONENT, 'route'),
    waypointIndex: ctx.resolveField(WAYPOINT_COMPONENT, 'index'),

    directorReleased: ctx.resolveField(NPC_DIRECTOR_COMPONENT, 'released'),
    directorTimer: ctx.resolveField(NPC_DIRECTOR_COMPONENT, 'timer'),
    directorWave: ctx.resolveField(NPC_DIRECTOR_COMPONENT, 'wave'),
  };
}
