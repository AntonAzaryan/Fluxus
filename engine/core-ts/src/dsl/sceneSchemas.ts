/**
 * Схемы ассетных блоков сцены (SER-5, SER-7, SER-8): вектор Q16.16, ассет
 * арены, определение твина и запись начальной расстановки — вынесены из
 * `schemas.ts` отдельным модулем по той же причине, что схемы способностей и
 * NPC: назначение у них одно и читаются они вместе.
 *
 * Структуру описывает схема, перекрёстные ссылки — загрузчик, и он строго
 * строже: существование prefab'а, компонента и поля в JSON Schema не
 * выражаются (SER-5).
 */
type Json = Record<string, unknown>;

export const vec2: Json = {
  $comment: 'Компоненты в Q16.16 (FP-1).',
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
};

export const arena: Json = {
  title: 'Ассет арены (ARENA-1)',
  type: 'object',
  additionalProperties: false,
  required: ['center', 'radius'],
  properties: {
    center: { $comment: 'Иммутабельный центр в Q16.16.', $ref: '#/$defs/vec2' },
    radius: { $comment: 'Стартовый радиус в Q16.16; дальше живёт в компоненте (ARENA-4).', type: 'integer' },
  },
};

export const tweenDef: Json = {
  title: 'Определение твина (TWEEN-1, TWEEN-3)',
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: { $comment: 'Путь к полю компонента, например "Health.value" (TWEEN-3).', type: 'string', minLength: 1 },
    onComplete: { $comment: 'Исполняется по завершении твина (TWEEN-4).', type: 'array', items: { $ref: '#/$defs/action' } },
  },
};

export const spawnEntry: Json = {
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
export const placement: Json = { type: 'array', items: { $ref: '#/$defs/spawnEntry' } };
