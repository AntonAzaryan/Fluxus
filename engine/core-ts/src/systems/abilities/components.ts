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
import { numberedFieldIndex } from '../../ecs/worldSchema.js';
import { NO_ENTITY, type ComponentSchema, type FieldType } from '../../types.js';

export const ABILITY_SLOT_COMPONENT = 'AbilitySlot';
export const ABILITY_COOLDOWN_COMPONENT = 'AbilityCooldown';
export const ABILITY_PROJECTILE_COMPONENT = 'AbilityProjectile';
export const ABILITY_DURATION_COMPONENT = 'AbilityDuration';
export const BUFF_INSTANCE_COMPONENT = 'BuffInstance';

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
 * Значение поля `class` инстанса баффа, означающее «платформа этот инстанс ещё
 * не накладывала» (BUFF-1, BUFF-2). Нормативные коды класса начинаются с
 * единицы, поэтому ноль свободен под то же, подо что он свободен у
 * `lastInterrupt`, — «величины ещё нет».
 *
 * Признак нужен потому, что спавн инстанса — обычное действие контента (BUFF-1),
 * а длительность, класс и статовые правки берутся из ОПРЕДЕЛЕНИЯ (BUFF-2):
 * заполняет их платформа на тике наложения, и отличить свежий инстанс от
 * действующего она обязана по полю мира, а не по структуре вне его (ABIL-1).
 */
export const NO_BUFF_CLASS = 0;

/**
 * Имена полей шага по правилу имён нумерованных полей (SER-6): номер
 * дополняется нулями слева общей функцией ядра, а не склейкой. При трёх шагах
 * ширина равна единице, и имена сегодня те же — `step0`…`step2`; правило стоит
 * здесь ради того дня, когда `ABILITY_STEPS` перевалит за десяток, а не ради
 * сегодняшних имён.
 */
export function stepFieldX(index: number): string {
  return `step${numberedFieldIndex(index, ABILITY_STEPS)}x`;
}

export function stepFieldY(index: number): string {
  return `step${numberedFieldIndex(index, ABILITY_STEPS)}y`;
}

export function stepFieldEntity(index: number): string {
  return `step${numberedFieldIndex(index, ABILITY_STEPS)}e`;
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
 * Инстанс баффа (BUFF-1): бафф, действующий на сущность, — отдельная сущность
 * мира, а её выдача — обычный спавн (ABIL-11, новых имён действий платформа не
 * вводит). Поля только числовые (ECS-3), и класс лежит копией определения
 * намеренно: определения из выражений не читаются, а рассеивание по классу,
 * подсветка в HUD и предикаты контента обязаны отбирать инстансы обычным
 * запросом по полю (BUFF-1, BUFF-6).
 *
 * `remaining` ≤ 0 означает постоянный бафф (BUFF-6): он не истекает сам и
 * снимается только признаком снятия — тем же значением «предела нет», что у
 * дальности снаряда, и по той же причине («без предела» и «предел исчерпан» не
 * путаются).
 */
export const BUFF_INSTANCE_SCHEMA: ComponentSchema = {
  name: BUFF_INSTANCE_COMPONENT,
  fields: {
    buffId: 'i32',
    class: 'i32',
    dispelled: 'i32',
    periodicTicks: 'i32',
    remaining: 'i32',
    source: 'entity',
    stacks: 'i32',
    target: 'entity',
  },
  defaults: { class: NO_BUFF_CLASS, source: NO_ENTITY, target: NO_ENTITY },
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

/**
 * Компоненты платформы баффов — отдельной группой, потому что подключает их
 * отдельное поле конфига: сцена вправе объявить `buffs` без `abilities`
 * (SER-7), и бафф накладывается обычным списком действий, способностей не
 * требуя (BUFF-1). В нормированном порядке групп эта идёт последней.
 */
export const BUFF_COMPONENTS: readonly ComponentSchema[] = [BUFF_INSTANCE_SCHEMA];
