/**
 * Схемы компонентов платформы поведения NPC (`npc-behavior` NPC-1, NPC-4,
 * NPC-5, NPC-6, NPC-8).
 *
 * NPC — обычная сущность мира, поэтому снапшот (SNAP-1), перемотка (REW-2),
 * реплей и персональная фильтрация достаются поведению даром: ни одной нормы,
 * написанной про NPC отдельно, для этого не требуется. Состояние агента целиком
 * лежит в полях компонентов — структур платформы вне мира не существует, и
 * собственных записываемых вводов у NPC нет (NPC-1).
 *
 * Поля только числовые (ECS-3), формы фиксированные: threat-таблица — top-K
 * плоскими полями, а не растущей структурой (NPC-5), прогресс маршрута — индекс
 * точки (NPC-6). Ни одной аллокации на агента в тике из этого состава не
 * следует по построению.
 */
import { NO_ENTITY, type ComponentSchema, type FieldType } from '../../types.js';

export const NPC_AGENT_COMPONENT = 'NpcAgent';
export const NPC_THREAT_COMPONENT = 'NpcThreat';
export const NPC_ROUTE_COMPONENT = 'NpcRoute';
export const WAYPOINT_COMPONENT = 'Waypoint';
export const NPC_DIRECTOR_COMPONENT = 'NpcDirector';

/**
 * Ёмкость threat-таблицы — top-K источников на агента (NPC-5). Именованная
 * константа платформы и часть формата: состав полей `NpcThreat` есть её
 * функция, а состав полей компонентов входит в снапшот (SER-7). Параметром
 * сборки быть не может — реализация с другим K дала бы другой состав полей при
 * формально том же конфиге сцены (CLI-6).
 *
 * Четыре, а не «сколько понадобится»: таблица нужна, чтобы решать «кого бить»,
 * а не вести бухгалтерию боя, и вытеснение минимума (NPC-5) делает пятого
 * источника не потерей, а понижением. Величина подбиралась на стресс-сценарии
 * (design, открытые вопросы) и живёт здесь, потому что это форма, а не баланс.
 */
export const NPC_THREAT_SLOTS = 4;

/** Значение поля `state`, означающее «состояние ещё не выбрано» (NPC-1). */
export const NPC_STATE_NONE = -1;

/** Значение поля `action`, означающее «действие на этом тике не выбрано» (NPC-4). */
export const NPC_ACTION_NONE = -1;

/** Значение поля `wave` режиссёра, означающее «волны кончились» (NPC-8). */
export const NPC_WAVE_DONE = -1;

/**
 * Значение поля `released`, означающее «пауза перед волной ещё не взведена»
 * (NPC-8). Отдельное значение, а не второе поле: пауза взводится ровно один раз
 * на волну, и признак «уже взвели» есть свойство того же счётчика выпущенных.
 */
export const NPC_WAVE_UNARMED = -1;

/** Имена полей слота threat-таблицы по правилу имён нумерованных полей (SER-6). */
export function threatSourceField(index: number): string {
  return `source${index}`;
}

export function threatValueField(index: number): string {
  return `value${index}`;
}

function threatSchema(): ComponentSchema {
  const fields: Record<string, FieldType> = {};
  const defaults: Record<string, number> = {};
  for (let i = 0; i < NPC_THREAT_SLOTS; i++) {
    fields[threatSourceField(i)] = 'entity';
    fields[threatValueField(i)] = 'fixed';
    defaults[threatSourceField(i)] = NO_ENTITY;
  }
  return { name: NPC_THREAT_COMPONENT, fields, defaults };
}

/**
 * Агент: чем он себя ведёт и что решил. `behavior` — индекс документа в таблице
 * сцены (NPC-2), `state` — индекс состояния HFSM в этом документе, `action` —
 * индекс выбранного действия внутри состояния (NPC-4).
 *
 * `enteredTick` и `decidedTick` — номера тиков, а не обратные счётчики:
 * перемотка возвращает и их вместе с миром (SNAP-1), поэтому «сколько тиков в
 * состоянии» после отката считается от восстановленного номера, а не от
 * счётчика, переживающего откат.
 */
export const NPC_AGENT_SCHEMA: ComponentSchema = {
  name: NPC_AGENT_COMPONENT,
  fields: {
    action: 'i32',
    behavior: 'i32',
    decidedTick: 'i32',
    enteredTick: 'i32',
    state: 'i32',
    target: 'entity',
  },
  defaults: {
    action: NPC_ACTION_NONE,
    behavior: 0,
    decidedTick: -1,
    enteredTick: 0,
    state: NPC_STATE_NONE,
    target: NO_ENTITY,
  },
};

/** Threat-таблица фиксированной ёмкости (NPC-5): top-K источников плоскими полями. */
export const NPC_THREAT_SCHEMA: ComponentSchema = threatSchema();

/** Прогресс по маршруту волны (NPC-6): номер маршрута и индекс текущей точки. */
export const NPC_ROUTE_SCHEMA: ComponentSchema = {
  name: NPC_ROUTE_COMPONENT,
  fields: { index: 'i32', route: 'i32' },
  defaults: { index: 0, route: 0 },
};

/**
 * Точка маршрута (NPC-6) — обычная сущность начального состояния сцены рядом с
 * `Position`. Схемы сцены это не расширяет: маршрут описывается расстановкой,
 * а не новым полем документа.
 */
export const WAYPOINT_SCHEMA: ComponentSchema = {
  name: WAYPOINT_COMPONENT,
  fields: { index: 'i32', route: 'i32' },
  defaults: { index: 0, route: 0 },
};

/**
 * Состояние режиссёра волн (NPC-8): какая волна идёт, сколько тиков до
 * следующего выпуска и сколько её бойцов уже выпущено. Носитель — обычная
 * сущность расстановки сцены, как носитель радиуса арены (ARENA-4).
 */
export const NPC_DIRECTOR_SCHEMA: ComponentSchema = {
  name: NPC_DIRECTOR_COMPONENT,
  fields: { released: 'i32', timer: 'i32', wave: 'i32' },
  defaults: { released: NPC_WAVE_UNARMED, timer: 0, wave: 0 },
};

/**
 * Компоненты платформы в нормативном порядке (SER-7): порядок задаёт битовые id,
 * то есть представление масок в снапшоте.
 */
export const NPC_COMPONENTS: readonly ComponentSchema[] = [
  NPC_AGENT_SCHEMA,
  NPC_THREAT_SCHEMA,
  NPC_ROUTE_SCHEMA,
  WAYPOINT_SCHEMA,
  NPC_DIRECTOR_SCHEMA,
];
