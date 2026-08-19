/**
 * Схемы компонентов платформы способностей (ABIL-1, ABIL-7, ABIL-9).
 *
 * Слот способности — обычная сущность мира, поэтому снапшот (SNAP-1),
 * перемотка (REW-2), реплей и персональная фильтрация достаются способности
 * даром: ни одной нормы, написанной про способности отдельно, для этого не
 * требуется. Поля только числовые (ECS-3), состояние автомата целиком лежит в
 * них — структур платформы вне мира не существует (ABIL-1).
 *
 * Остаток кулдауна вынесен ОТДЕЛЬНЫМ компонентом той же сущности намеренно
 * (ABIL-1, ABIL-7): exempt-механизм перемотки работает над компонентом целиком
 * (REW-9), и останься кулдаун полем `AbilitySlot`, он вывел бы из-под отката
 * заодно фазу, её счётчик и накопленное прицеливание.
 *
 * Префикс `Ability` в именах не украшение: у демо-сцены уже есть собственные
 * `Projectile` и `Lifetime`, и они остаются компонентами сцены — полезной
 * нагрузкой и презентационной фазой полёта.
 */
import { NO_ENTITY, type ComponentSchema, type FieldType } from '../../types.js';

export const ABILITY_SLOT_COMPONENT = 'AbilitySlot';
export const ABILITY_COOLDOWN_COMPONENT = 'AbilityCooldown';
export const ABILITY_PROJECTILE_COMPONENT = 'AbilityProjectile';
export const ABILITY_DURATION_COMPONENT = 'AbilityDuration';

/**
 * Число шагов прицеливания (ABIL-1). Именованная константа платформы и часть
 * формата: состав полей `AbilitySlot` есть функция от неё, а состав полей
 * компонентов входит в снапшот (SER-7). Параметром сборки быть не может —
 * реализация с другим числом дала бы другой состав полей при формально том же
 * конфиге сцены (CLI-6).
 */
export const ABILITY_STEPS = 3;

/** Зарезервированное значение поля `phase` — «каста нет» (ABIL-1). */
export const NO_PHASE = -1;

/** Значение поля `lastInterrupt` — «прерывания не было» (ABIL-6). */
export const NO_INTERRUPT = 0;

/**
 * Имена полей шага по правилу имён нумерованных полей (SER-6): при трёх шагах
 * достаточно одной цифры, и дополнять нулями нечего — `step0`…`step2`
 * сортируются лексикографически в том же порядке, что и числовой индекс.
 */
export function stepFieldX(index: number): string {
  return `step${index}x`;
}

export function stepFieldY(index: number): string {
  return `step${index}y`;
}

export function stepFieldEntity(index: number): string {
  return `step${index}e`;
}

function slotFields(): { fields: Record<string, FieldType>; defaults: Record<string, number> } {
  const fields: Record<string, FieldType> = {
    abilityId: 'i32',
    lastInterrupt: 'i32',
    level: 'i32',
    owner: 'entity',
    phase: 'i32',
    phaseTicks: 'i32',
    slotIndex: 'i32',
    staged: 'i32',
  };
  const defaults: Record<string, number> = { owner: NO_ENTITY, phase: NO_PHASE };
  for (let i = 0; i < ABILITY_STEPS; i++) {
    fields[stepFieldX(i)] = 'fixed';
    fields[stepFieldY(i)] = 'fixed';
    fields[stepFieldEntity(i)] = 'entity';
    defaults[stepFieldEntity(i)] = NO_ENTITY;
  }
  return { fields, defaults };
}

const SLOT = slotFields();

/** Состояние автомата и накопленные шаги (ABIL-1). */
export const ABILITY_SLOT_SCHEMA: ComponentSchema = {
  name: ABILITY_SLOT_COMPONENT,
  fields: SLOT.fields,
  defaults: SLOT.defaults,
};

/**
 * Остаток кулдауна и его полная длительность (ABIL-1, ABIL-7). `total` пишется
 * тем же взведением, что и остаток: полную длительность обязан доставлять стат
 * HUD (HUD-8), а вычислять её на клиенте значило бы вычислять там выражение
 * определения.
 */
export const ABILITY_COOLDOWN_SCHEMA: ComponentSchema = {
  name: ABILITY_COOLDOWN_COMPONENT,
  fields: { remaining: 'i32', total: 'i32' },
};

/**
 * Снаряд платформы (ABIL-9): разбор столкновений и конец жизни. Полёт как
 * таковой платформа не считает — его интегрирует разрешение движения (PHYS-8),
 * а скорость снаряда лежит обычным компонентом сцены.
 *
 * `range` ≤ 0 и `ticksLeft` ≤ 0 означают «предела нет»: убывание и проверка
 * дальности включаются только положительным значением, поэтому «без предела» и
 * «предел исчерпан» не путаются.
 */
export const ABILITY_PROJECTILE_SCHEMA: ComponentSchema = {
  name: ABILITY_PROJECTILE_COMPONENT,
  fields: {
    abilityId: 'i32',
    originX: 'fixed',
    originY: 'fixed',
    owner: 'entity',
    range: 'fixed',
    ticksLeft: 'i32',
  },
  defaults: { owner: NO_ENTITY },
};

/** Эффект с собственной длительностью — купол, зона, оболочка (ABIL-9). */
export const ABILITY_DURATION_SCHEMA: ComponentSchema = {
  name: ABILITY_DURATION_COMPONENT,
  fields: { abilityId: 'i32', owner: 'entity', remaining: 'i32' },
  defaults: { owner: NO_ENTITY },
};

/**
 * Компоненты платформы разом — загрузчику подключать их одним спредом.
 * Порядок внутри группы нормативен наравне с порядком групп (SER-7): он задаёт
 * битовые id, то есть представление масок в снапшоте.
 */
export const ABILITY_COMPONENTS: readonly ComponentSchema[] = [
  ABILITY_SLOT_SCHEMA,
  ABILITY_COOLDOWN_SCHEMA,
  ABILITY_PROJECTILE_SCHEMA,
  ABILITY_DURATION_SCHEMA,
];
