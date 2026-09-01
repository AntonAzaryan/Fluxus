/**
 * Схемы блоков платформы способностей (SER-5, ABIL-2, ABIL-8) — вынесены из
 * `schemas.ts` отдельным модулем: там они составляли половину файла, а
 * назначение у них одно и читаются они вместе.
 *
 * Структуру описывает схема, перекрёстные ссылки — загрузчик, и он строго
 * строже: существование компонента, связанность имени и доступность источника
 * прерывания в JSON Schema не выражаются (SER-5, ABIL-10).
 */
type Json = Record<string, unknown>;

export const abilityTrigger: Json = {
  $comment: 'Ровно один из трёх видов: ввод, событие, каждый тик (ABIL-3).',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['bit'],
      properties: {
        bit: {
          $comment: 'Индекс бита маски кнопок; смысл битов — данные сцены (INP-4).',
          type: 'integer',
          minimum: 0,
          maximum: 31,
        },
      },
    },
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { type: 'string', minLength: 1 },
        as: { $comment: 'Имя, которым событие связано в списках действий (EXPR-2).', type: 'string', minLength: 1 },
      },
    },
    always: { $comment: 'Каждый тик, пока слот жив (ABIL-3).' },
  },
};

export const abilityShape: Json = {
  $comment:
    'Словарь фигур общий со словарём форм коллайдера (PHYS-2); круг с полууглом — конус (ABIL-5). Размеры — ЛИТЕРАЛЫ, а не выражения: фигуру читает и превью, которому мира не дано (REND-28).',
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['aabb', 'circle'] },
    radius: { type: 'number' },
    halfX: { type: 'number' },
    halfY: { type: 'number' },
    halfAngle: { $comment: 'Полуугол — доля оборота в Q16.16 (FP-7).', type: 'number' },
  },
};

export const abilityStep: Json = {
  title: 'Шаг прицеливания (ABIL-5)',
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['none', 'point', 'unit', 'vector'] },
    filter: { $comment: 'Предикат над сущностью-кандидатом (EXPR-3).', $ref: '#/$defs/expression' },
    range: { $comment: 'Предел расстояния от начала шага.', $ref: '#/$defs/expression' },
    shape: { $ref: '#/$defs/abilityShape' },
  },
};

export const abilityInterrupt: Json = {
  title: 'Исход прерывания и данные распознавания источника (ABIL-6)',
  type: 'object',
  additionalProperties: false,
  properties: {
    cooldown: { enum: ['full', 'partial', 'refund'] },
    refund: { $comment: 'Доля кулдауна для исхода partial, Q16.16.', $ref: '#/$defs/expression' },
    staged: { enum: ['keep', 'reset'] },
    mask: { $comment: 'Маска лока для источника disable (LOC-7).', type: 'integer' },
    when: { $comment: 'Предикат владельца для источника displacement.', $ref: '#/$defs/expression' },
    threshold: { $comment: 'Порог урона за тик для источника damaged.', $ref: '#/$defs/expression' },
  },
};

export const abilityInterrupts: Json = {
  $comment: 'Карта «источник → исход»; словарь источников закрыт (ABIL-6).',
  type: 'object',
  additionalProperties: { $ref: '#/$defs/abilityInterrupt' },
};

export const abilityPhase: Json = {
  title: 'Фаза каста (ABIL-4)',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'trigger'],
  properties: {
    id: { type: 'string', minLength: 1 },
    trigger: { enum: ['auto', 'commit', 'hold', 'release'] },
    durationTicks: { $comment: 'Число тиков — сырое целое (EXPR-2).', $ref: '#/$defs/expression' },
    onEnter: { type: 'array', items: { $ref: '#/$defs/action' } },
    onExit: { type: 'array', items: { $ref: '#/$defs/action' } },
    onCancel: { type: 'array', items: { $ref: '#/$defs/action' } },
    timeout: {
      $comment: 'Исход истечения durationTicks: идентификатор фазы, commit либо cancel (ABIL-4).',
      type: 'object',
      additionalProperties: false,
      required: ['then'],
      properties: { then: { type: 'string', minLength: 1 } },
    },
    interrupts: { $ref: '#/$defs/abilityInterrupts' },
  },
};

export const abilityDef: Json = {
  title: 'Определение способности (ABIL-2)',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'trigger', 'effects'],
  properties: {
    id: { $comment: 'Человеко-читаемое имя; в мире способность адресует индекс (ABIL-2).', type: 'string', minLength: 1 },
    trigger: { $ref: '#/$defs/abilityTrigger' },
    condition: { $comment: 'Условие сверх триггера (ABIL-3).', $ref: '#/$defs/expression' },
    confirmBit: { type: 'integer', minimum: 0, maximum: 31 },
    cancelBit: { type: 'integer', minimum: 0, maximum: 31 },
    phases: { type: 'array', items: { $ref: '#/$defs/abilityPhase' } },
    targeting: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: { steps: { type: 'array', items: { $ref: '#/$defs/abilityStep' } } },
    },
    interrupts: { $ref: '#/$defs/abilityInterrupts' },
    cooldownTicks: { $ref: '#/$defs/expression' },
    effects: { type: 'array', items: { $ref: '#/$defs/action' } },
    projectile: {
      $comment: 'Блок доставки «снаряд» (ABIL-9): полёт интегрирует физика, платформа разбирает исходы.',
      type: 'object',
      additionalProperties: false,
      properties: {
        onHit: { type: 'array', items: { $ref: '#/$defs/action' } },
        onFade: { type: 'array', items: { $ref: '#/$defs/action' } },
      },
    },
    duration: {
      $comment: 'Блок доставки «эффект с длительностью» (ABIL-9).',
      type: 'object',
      additionalProperties: false,
      properties: { onExpire: { type: 'array', items: { $ref: '#/$defs/action' } } },
    },
  },
};

export const buffStatMod: Json = {
  $comment: 'Статовая правка: список источников-модификаторов и значение-выражение (BUFF-4, TIME-7).',
  type: 'object',
  additionalProperties: false,
  required: ['component', 'value'],
  properties: {
    component: { type: 'string', minLength: 1 },
    value: { $ref: '#/$defs/expression' },
  },
};

export const buffTrigger: Json = {
  title: 'Реакция баффа на событие (BUFF-5)',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'do'],
  properties: {
    type: { type: 'string', minLength: 1 },
    as: { $comment: 'Имя, которым событие связано в списке действий (EXPR-2).', type: 'string', minLength: 1 },
    do: { type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

export const buffDef: Json = {
  title: 'Определение баффа (BUFF-2)',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'class', 'stacking'],
  properties: {
    id: { $comment: 'Человеко-читаемое имя; в мире определение адресует индекс (BUFF-1).', type: 'string', minLength: 1 },
    class: { enum: ['negative', 'positive'] },
    durationTicks: {
      $comment: 'Отсутствие поля либо неположительное значение — постоянный бафф (BUFF-2, BUFF-6).',
      $ref: '#/$defs/expression',
    },
    stacking: {
      $comment: 'Политика стакинга обязательна: умолчания у неё нет (BUFF-3).',
      enum: ['independent', 'refresh', 'stack'],
    },
    maxStacks: { $comment: 'Потолок стаков; обязателен при политике stack (BUFF-3).', $ref: '#/$defs/expression' },
    statMods: { type: 'array', items: { $ref: '#/$defs/buffStatMod' } },
    periodic: {
      $comment: 'Периодика: период в тиках и список действий, считая от тика наложения (BUFF-5).',
      type: 'object',
      additionalProperties: false,
      required: ['everyTicks', 'do'],
      properties: {
        everyTicks: { $ref: '#/$defs/expression' },
        do: { type: 'array', items: { $ref: '#/$defs/action' } },
      },
    },
    triggers: { type: 'array', items: { $ref: '#/$defs/buffTrigger' } },
    onExpire: { type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

export const abilityRuntime: Json = {
  title: 'Биндинги сцены для платформы способностей (ABIL-8)',
  type: 'object',
  additionalProperties: false,
  properties: {
    deadMarker: { type: 'string', minLength: 1 },
    actionLock: { $comment: 'Компонент-маска лока действий, поле `mask` (LOC-7).', type: 'string', minLength: 1 },
    teamField: {
      $comment: 'Пара «компонент, поле», значение которого есть сторона сущности (FOW-2).',
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'string', minLength: 1 },
    },
    damageEvent: {
      $comment: 'Тип события урона и имена его полей: конвенции имён у ядра нет (ABIL-8).',
      type: 'object',
      additionalProperties: false,
      required: ['type', 'entityField', 'amountField'],
      properties: {
        type: { type: 'string', minLength: 1 },
        entityField: { type: 'string', minLength: 1 },
        amountField: { type: 'string', minLength: 1 },
      },
    },
    inputComponent: {
      $comment: 'Имя компонента ввода; по умолчанию Input. Биндингом ABIL-8 не является (TICK-4).',
      type: 'string',
      minLength: 1,
    },
  },
};
