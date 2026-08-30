/**
 * Схемы блока платформы поведения NPC (SER-5, `npc-behavior` NPC-2) — вынесены
 * из `schemas.ts` отдельным модулем по той же причине, что схемы способностей:
 * назначение у них одно и читаются они вместе.
 *
 * Структуру описывает схема, перекрёстные ссылки — загрузчик, и он строго
 * строже: существование состояния-адресата перехода, соответствие полей формы
 * кривой и связанность индекса документа с таблицей в JSON Schema не
 * выражаются (SER-5, NPC-2).
 *
 * Словари — те же наборы, по которым валидирует компилятор документа:
 * рукописный список разошёлся бы с реализацией на первом же новом исполнителе,
 * и разошёлся бы молча.
 */
import { SCORING_CURVES, SCORING_CURVE_FIELDS, type ScoringCurveType } from './scoring.js';
import { NPC_CONDITIONS, NPC_EXECUTORS, NPC_INPUTS, NPC_TIERS } from '../systems/npc/model.js';

type Json = Record<string, unknown>;

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** Число Q16.16 целым — тот же контейнер, что у всех величин контента (FP-1). */
const fixed: Json = { type: 'integer' };

/** Доля Q16.16 в [0, 1] — то, что общая модель скоринга помечает полем `unit` (NPC-3). */
const unit: Json = { type: 'integer', minimum: 0, maximum: 65536 };

/**
 * Кривая отклика общей модели скоринга (NPC-3): форма из закрытого набора,
 * параметры — её собственные поля. Ветка на форму порождается из таблицы полей
 * модели, поэтому новая форма приезжает в схему той же одной правкой.
 */
const npcCurve: Json = {
  title: 'Кривая отклика (NPC-3)',
  oneOf: SCORING_CURVES.map((type: ScoringCurveType) => ({
    type: 'object',
    additionalProperties: false,
    required: ['type', ...SCORING_CURVE_FIELDS[type].map((field) => field.key)],
    properties: {
      type: { const: type },
      ...Object.fromEntries(
        SCORING_CURVE_FIELDS[type].map((field) => [field.key, field.unit ? unit : fixed]),
      ),
    },
  })),
};

/**
 * Параметризован ровно один вход словаря (NPC-7), поэтому ветка условная:
 * `abilityReady` слот обязан назвать, любой другой вход — не вправе. Схема
 * повторяет здесь то же правило, которым компилятор документа отвергает лишнее
 * поле, а не смягчает его: `additionalProperties: false` без ветки принимал бы
 * `slot` у входа, которому он бессмыслен (SER-5 — схема не строже загрузчика,
 * но и не слабее там, где может).
 */
const npcConsideration: Json = {
  title: 'Ось полезности (NPC-3)',
  type: 'object',
  additionalProperties: false,
  required: ['input', 'curve', 'weight'],
  properties: {
    input: { $comment: 'Вход закрытого словаря NPC.', enum: sorted(NPC_INPUTS) },
    slot: {
      $comment: 'Индекс слота способности (AbilitySlot.slotIndex, ABIL-1) — только у входа abilityReady (NPC-7).',
      type: 'integer',
      minimum: 0,
    },
    curve: { $ref: '#/$defs/npcCurve' },
    weight: { $comment: 'Доля [0, 1] в Q16.16.', ...unit },
  },
  allOf: [
    {
      if: { required: ['input'], properties: { input: { const: 'abilityReady' } } },
      then: { required: ['slot'] },
      else: { not: { required: ['slot'] } },
    },
  ],
};

const npcAction: Json = {
  title: 'Действие состояния (NPC-2)',
  type: 'object',
  additionalProperties: false,
  required: ['executor', 'considerations'],
  properties: {
    executor: { $comment: 'Исполнитель закрытого словаря кода.', enum: sorted(NPC_EXECUTORS) },
    event: { $comment: 'Тип публикуемого события — только у исполнителя cast (NPC-7).', type: 'string', minLength: 1 },
    considerations: { type: 'array', minItems: 1, items: { $ref: '#/$defs/npcConsideration' } },
  },
};

const npcTransition: Json = {
  title: 'Переход HFSM (NPC-7)',
  type: 'object',
  additionalProperties: false,
  required: ['to', 'when'],
  properties: {
    to: { type: 'string', minLength: 1 },
    when: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { enum: sorted(NPC_CONDITIONS) },
        value: fixed,
        ticks: { type: 'integer', minimum: 0 },
        event: { type: 'string', minLength: 1 },
        entityField: {
          $comment:
            'Поле события с адресатом — у условия event. Без него переход срабатывает на событии типа, кому бы оно ни было адресовано.',
          type: 'string',
          minLength: 1,
        },
      },
    },
  },
};

const npcState: Json = {
  title: 'Состояние HFSM (NPC-2)',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'actions'],
  properties: {
    name: { type: 'string', minLength: 1 },
    actions: { type: 'array', minItems: 1, items: { $ref: '#/$defs/npcAction' } },
    transitions: { type: 'array', items: { $ref: '#/$defs/npcTransition' } },
  },
};

const npcBehavior: Json = {
  title: 'Документ поведения NPC (NPC-2)',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'name', 'tier', 'decision', 'ranges', 'speed', 'states'],
  properties: {
    schema: { $comment: 'Версия формы документа (NPC-2).', type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 },
    tier: { $comment: 'Массовый или особый агент (NPC-4).', enum: sorted(NPC_TIERS) },
    decision: {
      type: 'object',
      additionalProperties: false,
      required: ['intervalTicks'],
      properties: { intervalTicks: { type: 'integer', minimum: 1 } },
    },
    ranges: {
      type: 'object',
      additionalProperties: false,
      required: ['sense', 'attack', 'arrive', 'separation'],
      properties: { sense: fixed, attack: fixed, arrive: fixed, separation: fixed },
    },
    speed: fixed,
    separationWeight: fixed,
    separationIntervalTicks: {
      $comment:
        'Тиков между пересчётами вектора локального расхождения (NPC-6); умолчание — 3 тика (NPC-2).',
      type: 'integer',
      minimum: 1,
    },
    scales: {
      type: 'object',
      additionalProperties: false,
      properties: { elapsedTicks: { type: 'integer', minimum: 0 }, crowd: { type: 'integer', minimum: 0 } },
    },
    threat: {
      $comment: 'Правила накопления угрозы — политика документа (NPC-5).',
      type: 'object',
      additionalProperties: false,
      required: ['switchMargin', 'sources'],
      properties: {
        switchMargin: fixed,
        decayPerTick: fixed,
        sources: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['event', 'victimField', 'sourceField', 'weight'],
            properties: {
              event: { type: 'string', minLength: 1 },
              victimField: { type: 'string', minLength: 1 },
              sourceField: { type: 'string', minLength: 1 },
              amountField: {
                $comment:
                  'Поле события с ЦЕЛЫМ счётчиком (единицы урона, лечения); угроза — вес, помноженный на него. Без поля вес засчитывается как есть.',
                type: 'string',
                minLength: 1,
              },
              weight: fixed,
            },
          },
        },
      },
    },
    states: { type: 'array', minItems: 1, items: { $ref: '#/$defs/npcState' } },
  },
};

const npcWave: Json = {
  title: 'Запись таблицы волн (NPC-8)',
  type: 'object',
  additionalProperties: false,
  required: ['prefab', 'count', 'behavior', 'delayTicks', 'spacingTicks'],
  properties: {
    prefab: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 0 },
    behavior: { $comment: 'Индекс документа поведения в таблице сцены.', type: 'integer', minimum: 0 },
    delayTicks: { type: 'integer', minimum: 0 },
    spacingTicks: { type: 'integer', minimum: 0 },
    route: { type: 'integer', minimum: 0 },
    x: fixed,
    y: fixed,
  },
};

/** Блок платформы в конфиге сцены (SER-7, NPC-2). */
export const npc: Json = {
  title: 'Платформа поведения NPC (NPC-2)',
  type: 'object',
  additionalProperties: false,
  required: ['behaviors'],
  properties: {
    behaviors: { type: 'array', minItems: 1, items: { $ref: '#/$defs/npcBehavior' } },
    bindings: {
      $comment: 'Что в этой сцене значат позиция, скорость, здоровье и сторона (NPC-1).',
      type: 'object',
      additionalProperties: false,
      properties: {
        position: { type: 'string', minLength: 1 },
        velocity: { type: 'string', minLength: 1 },
        health: { $ref: '#/$defs/npcFieldRef' },
        healthMax: { $ref: '#/$defs/npcFieldRef' },
        team: { $ref: '#/$defs/npcFieldRef' },
        deadMarker: { type: 'string', minLength: 1 },
      },
    },
    decisionBudget: {
      $comment: 'Предел дорогих пересмотров решений на тик (NPC-4).',
      type: 'integer',
      minimum: 1,
    },
    waves: {
      $comment: 'Таблица волн режиссёра (NPC-8); cap — предел активных NPC.',
      type: 'object',
      additionalProperties: false,
      required: ['cap', 'entries'],
      properties: {
        cap: { type: 'integer', minimum: 0 },
        entries: { type: 'array', minItems: 1, items: { $ref: '#/$defs/npcWave' } },
      },
    },
  },
};

export const npcFieldRef: Json = {
  $comment: 'Пара «компонент, поле».',
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'string', minLength: 1 },
};

export { npcAction, npcBehavior, npcConsideration, npcCurve, npcState, npcTransition, npcWave };
