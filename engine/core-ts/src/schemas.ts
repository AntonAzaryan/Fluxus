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
import { FIELD_TYPES } from './types.js';

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
    order: { $comment: 'Равные order недопустимы (DET-3).', type: 'integer' },
    query: { $comment: 'Сахар над действием forEach (SYS-1).', $ref: '#/$defs/query' },
    as: { type: 'string', minLength: 1 },
    do: { type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

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
  },
};

const vec2: Json = {
  $comment: 'Компоненты в Q16.16 (FP-1).',
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
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
    buttons: { type: 'integer' },
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
      $comment: 'Начальная расстановка; порядок задаёт выданные ID (ID-2, DET-6).',
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prefab'],
        properties: {
          prefab: { type: 'string', minLength: 1 },
          overrides: {
            type: 'object',
            additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
      },
    },
    inputs: { type: 'array', items: { $ref: '#/$defs/inputFrame' } },
    players: {
      $comment: 'Порядок задаёт слоты игроков (TICK-5); обязателен вместе с inputs.',
      type: 'array',
      items: { type: 'string', minLength: 1 },
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
  'scene.schema.json': document('scene.schema.json', scene, {
    action,
    component,
    expression,
    prefab,
    query,
    system,
  }),
  'scenario.schema.json': document('scenario.schema.json', scenario, {
    action,
    component,
    expression,
    inputFrame,
    prefab,
    query,
    scene,
    system,
    vec2,
  }),
};

/** Ровно то, что должно лежать в файле, — и то, с чем сверяется тест. */
export function schemaFileContent(name: string): string {
  const doc = schemaFiles[name];
  if (doc === undefined) throw new Error(`неизвестная схема "${name}"`);
  return `${JSON.stringify(doc, null, 2)}\n`;
}
