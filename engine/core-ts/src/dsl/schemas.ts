/**
 * JSON-схемы конфигов (SER-5). Порождаются из тех же закрытых наборов, по
 * которым валидирует загрузчик: рукописная схема разошлась бы с DSL на первом
 * же новом действии, и разошлась бы молча — расхождение всплыло бы в
 * редакторе, а не в тестах.
 *
 * Схемы описывают структуру. Перекрёстные ссылки — существование компонента,
 * поля, prefab'а, связанность переменной — не выражаются в JSON Schema и
 * остаются за загрузчиком, который строго строже (SER-5).
 */
import { actionNames } from './actions.js';
import { operators } from './expr.js';
import { FIELD_TYPES } from '../types.js';

type Json = Record<string, unknown>;

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const BASE = 'https://game-mvp.local/schemas';

const sorted = (names: readonly string[]): string[] => [...names].sort();

const expression: Json = {
  $comment: 'Узел выражения: объект с одним ключом-оператором (EXPR-1). Арность и типы проверяет загрузчик.',
  oneOf: [
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'object',
      minProperties: 1,
      maxProperties: 1,
      propertyNames: { enum: sorted(operators) },
    },
  ],
};

const action: Json = {
  $comment: 'Узел действия: объект с одним ключом-именем (ACT-1). Состав аргументов проверяет загрузчик.',
  type: 'object',
  minProperties: 1,
  maxProperties: 1,
  propertyNames: { enum: sorted(actionNames) },
};

const componentNames: Json = { type: 'array', items: { type: 'string', minLength: 1 } };

const query: Json = {
  type: 'object',
  additionalProperties: false,
  properties: {
    all: componentNames,
    any: componentNames,
    not: componentNames,
    withTag: { type: 'string', minLength: 1 },
    withinRadius: {
      type: 'object',
      additionalProperties: false,
      required: ['center', 'radius'],
      properties: { center: { $ref: '#/$defs/expression' }, radius: { $ref: '#/$defs/expression' } },
    },
  },
};

const component: Json = {
  title: 'Схема компонента (ECS-3)',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'fields'],
  properties: {
    name: { type: 'string', minLength: 1 },
    fields: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { enum: [...FIELD_TYPES] },
    },
    defaults: {
      $comment: 'Значения в Q16.16 для полей типа fixed (FP-1).',
      type: 'object',
      additionalProperties: { type: 'integer' },
    },
  },
};

const prefab: Json = {
  title: 'Prefab (ECS-4)',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'components'],
  properties: {
    name: { type: 'string', minLength: 1 },
    components: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } },
    },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

const system: Json = {
  title: 'JSON-описание системы (SYS-1)',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'order', 'do'],
  properties: {
    name: { $comment: 'Имя RNG-стрима и ключ подмены (RNG-4, SYS-7).', type: 'string', minLength: 1 },
    order: { $comment: 'Место системы в тике; равные order недопустимы (SYS-2, DET-9).', type: 'integer' },
    query: { $comment: 'Сахар над действием forEach (SYS-1).', $ref: '#/$defs/query' },
    as: { type: 'string', minLength: 1 },
    do: { type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

const terrain: Json = {
  title: 'Ассет террейна (TERR-2, TERR-3)',
  type: 'object',
  additionalProperties: false,
  required: ['width', 'height', 'tileSize', 'levels', 'flags'],
  properties: {
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    tileSize: { $comment: 'Размер клетки в Q16.16 (FP-1, TERR-2).', type: 'integer', minimum: 1 },
    levels: {
      $comment: 'Строка на ряд, шестнадцатеричная цифра в верхнем регистре на клетку (TERR-3).',
      type: 'array',
      items: { type: 'string', pattern: '^[0-9A-F]+$' },
      minItems: 1,
    },
    flags: {
      $comment: '`.` обычная, `^` рампа, `_` нет пола — вне алфавита карты уровней (TERR-3).',
      type: 'array',
      items: { type: 'string', pattern: '^[.^_]+$' },
      minItems: 1,
    },
  },
};

const vec2: Json = {
  $comment: 'Компоненты в Q16.16 (FP-1).',
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
};

const arena: Json = {
  title: 'Ассет арены (ARENA-1)',
  type: 'object',
  additionalProperties: false,
  required: ['center', 'radius'],
  properties: {
    center: { $comment: 'Иммутабельный центр в Q16.16.', $ref: '#/$defs/vec2' },
    radius: { $comment: 'Стартовый радиус в Q16.16; дальше живёт в компоненте (ARENA-4).', type: 'integer' },
  },
};

const tweenDef: Json = {
  title: 'Определение твина (TWEEN-1, TWEEN-3)',
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: { $comment: 'Путь к полю компонента, например "Health.value" (TWEEN-3).', type: 'string', minLength: 1 },
    onComplete: { $comment: 'Исполняется по завершении твина (TWEEN-4).', type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

const spawnEntry: Json = {
  title: 'Запись начальной расстановки (SER-8)',
  type: 'object',
  additionalProperties: false,
  required: ['prefab'],
  properties: {
    prefab: { type: 'string', minLength: 1 },
    overrides: {
      $comment: "Карта «компонент → поле → значение» поверх значений prefab'а (CMD-6).",
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } },
    },
  },
};

/** Список записей — общий формат расстановки конфига сцены и документа прогона (SER-8). */
const placement: Json = { type: 'array', items: { $ref: '#/$defs/spawnEntry' } };

const scene: Json = {
  title: 'Сцена (SER-7)',
  type: 'object',
  additionalProperties: false,
  required: ['components'],
  properties: {
    components: {
      $comment: 'Порядок задаёт битовые id компонентов и является частью формата (SER-7).',
      type: 'array',
      items: { $ref: '#/$defs/component' },
    },
    prefabs: { type: 'array', items: { $ref: '#/$defs/prefab' } },
    systems: { type: 'array', items: { $ref: '#/$defs/system' } },
    capacity: { type: 'integer', minimum: 1 },
    terrain: {
      $comment: 'Компонент карты пола и его prefab порождаются из ассета загрузчиком (TERR-6).',
      $ref: '#/$defs/terrain',
    },
    arena: {
      $comment: 'Компоненты радиуса и состояния границы и prefab порождаются из ассета загрузчиком (ARENA-1).',
      $ref: '#/$defs/arena',
    },
    timeScale: {
      $comment: 'Подключает TimeScale, TimeScaleModifiers и сведение источников (TIME-2, TIME-7).',
      type: 'boolean',
    },
    tweens: {
      $comment: 'Таблица определений твинов (TWEEN-1, TWEEN-3): наличие включает TweenSystem.',
      type: 'array',
      items: { $ref: '#/$defs/tweenDef' },
    },
    fog: {
      $comment: 'Подключает компоненты тумана войны (FOW-1..3).',
      type: 'boolean',
    },
    modifierSlots: {
      $comment: 'Число слотов в списках источников-модификаторов; по умолчанию 4 (TIME-7, SER-7).',
      type: 'integer',
      minimum: 1,
    },
    initial: {
      ...placement,
      $comment: 'Расстановка сцены: после сущностей-носителей и до расстановки прогона (SER-7, SER-8).',
    },
  },
};

const inputFrame: Json = {
  $comment: 'InputFrame на пару (игрок, тик) — TICK-2.',
  type: 'object',
  additionalProperties: false,
  required: ['tick', 'playerId', 'seq', 'move', 'aimDir', 'buttons'],
  properties: {
    tick: { type: 'integer', minimum: 1 },
    playerId: { type: 'string', minLength: 1 },
    seq: { type: 'integer' },
    move: { $ref: '#/$defs/vec2' },
    aimDir: { type: 'integer' },
    buttons: {
      $comment: 'u16-битмаска; ширину поля задаёт TICK-2, схема ей соответствует.',
      type: 'integer',
      minimum: 0,
      maximum: 65535,
    },
  },
};

const scenario: Json = {
  title: 'Сценарий CLI (CLI-2)',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'seed', 'ticks', 'scene'],
  properties: {
    name: { type: 'string', minLength: 1 },
    seed: { type: 'integer' },
    ticks: { type: 'integer', minimum: 0 },
    scene: { $ref: '#/$defs/scene' },
    initial: {
      ...placement,
      $comment: 'Расстановка прогона: применяется после расстановки сцены (SER-8, ID-2, DET-6).',
    },
    inputs: { type: 'array', items: { $ref: '#/$defs/inputFrame' } },
    physics: {
      $comment: 'Включает физику (PHYS-4). Поле сценария, а не сцены: реализация — зависимость сборки (DI-3).',
      type: 'object',
      additionalProperties: false,
      properties: {
        collider: { type: 'string', minLength: 1 },
        velocity: { type: 'string', minLength: 1 },
      },
    },
    players: {
      $comment: 'Порядок задаёт слоты игроков (TICK-5); обязателен вместе с inputs.',
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    visibility: {
      $comment: 'Включает пересчёт видимости (FOW-4). Поле сценария, а не сцены: системе нужен raycast (DI-3).',
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
};

function document(id: string, body: Json, defs: Json): Json {
  return { $schema: DIALECT, $id: `${BASE}/${id}`, ...body, ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}) };
}

/** Имя файла → документ. Единственный источник для `engine/schemas/`. */
export const schemaFiles: Readonly<Record<string, Json>> = {
  'component.schema.json': document('component.schema.json', component, {}),
  'prefab.schema.json': document('prefab.schema.json', prefab, {}),
  'system.schema.json': document('system.schema.json', system, { action, expression, query }),
  'terrain.schema.json': document('terrain.schema.json', terrain, {}),
  'scene.schema.json': document('scene.schema.json', scene, {
    action,
    arena,
    component,
    expression,
    prefab,
    query,
    spawnEntry,
    system,
    terrain,
    tweenDef,
    vec2,
  }),
  'scenario.schema.json': document('scenario.schema.json', scenario, {
    action,
    arena,
    component,
    expression,
    inputFrame,
    prefab,
    query,
    scene,
    spawnEntry,
    system,
    terrain,
    tweenDef,
    vec2,
  }),
};

/** Ровно то, что должно лежать в файле, — и то, с чем сверяется тест. */
export function schemaFileContent(name: string): string {
  const doc = schemaFiles[name];
  if (doc === undefined) throw new Error(`неизвестная схема "${name}"`);
  return `${JSON.stringify(doc, null, 2)}\n`;
}
