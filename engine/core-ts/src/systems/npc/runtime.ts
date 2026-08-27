/**
 * Чтение мира системами платформы NPC (`npc-behavior` NPC-1): восприятие — это
 * ПРЯМОЕ чтение состояния мира средствами системы, без снапшота и без фильтра
 * видимости. Тумана войны NPC не читает намеренно: он часть авторитетной
 * симуляции, а не её участник, и «честность» ему не нужна.
 *
 * Здесь же — операции над threat-таблицей фиксированной ёмкости (NPC-5).
 * Накопление читает СНАЧАЛА уже поставленные команды буфера, потом мир (CMD-5):
 * мир до flush не видит собственных записей системы, и два события по одному
 * агенту на одном тике иначе перетёрли бы друг друга.
 */
import { div, mul } from '../../math/fixed.js';
import {
  threatSourceField,
  threatValueField,
  NPC_AGENT_COMPONENT,
  NPC_THREAT_COMPONENT,
  NPC_THREAT_SLOTS,
} from './components.js';
import type { CompiledNpcBindings } from './model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type Fixed,
  type QuerySpec,
  type SystemContext,
} from '../../types.js';

/**
 * Выборка живых агентов: `all` объявлен обязательным, чтобы система, которой
 * нужно дописать к нему свои компоненты, делала это без утверждений о типе.
 */
export interface LivingAgentsSpec extends QuerySpec {
  readonly all: readonly string[];
}

/**
 * Спецификация выборки ЖИВЫХ агентов (NPC-1). Мёртвый агент не решает, не
 * двигается и не занимает предела волн: тело на арене — это тело, а не боец.
 * Одна функция на все системы платформы затем, чтобы «живой» значило у них
 * буквально одно и то же: разойдись они, корпус ходил бы по арене ровно у той
 * системы, которую забыли поправить.
 *
 * Сцена без маркера мёртвых понятия смерти не имеет вовсе (`isDead`), и запрет
 * тогда не выражается ничем — выборка остаётся прежней.
 */
export function livingAgents(catalog: {
  readonly bindings: CompiledNpcBindings;
}): LivingAgentsSpec {
  const all = [NPC_AGENT_COMPONENT];
  return catalog.bindings.deadMarker === ''
    ? { all }
    : { all, not: [catalog.bindings.deadMarker] };
}

export function posX(ctx: SystemContext, bindings: CompiledNpcBindings, entity: EntityId): Fixed {
  return ctx.get(entity, bindings.position, 'x');
}

export function posY(ctx: SystemContext, bindings: CompiledNpcBindings, entity: EntityId): Fixed {
  return ctx.get(entity, bindings.position, 'y');
}

/**
 * Мёртв ли — по маркеру сцены (биндинг NPC-1). Сцена без маркера мёртвых не
 * знает вовсе, и тогда живой считается всякая живая сущность: понятия смерти
 * ядро не приобретает.
 */
export function isDead(ctx: SystemContext, bindings: CompiledNpcBindings, entity: EntityId): boolean {
  return bindings.deadMarker !== '' && ctx.has(entity, bindings.deadMarker);
}

/** Сторона сущности; `undefined` — сцена стороны не объявила либо её у сущности нет. */
export function teamOf(
  ctx: SystemContext,
  bindings: CompiledNpcBindings,
  entity: EntityId,
): number | undefined {
  if (!bindings.hasTeam || !ctx.has(entity, bindings.teamComponent)) return undefined;
  return ctx.get(entity, bindings.teamComponent, bindings.teamField);
}

/**
 * Доля здоровья в [0, 1] (NPC-7). Сцена без биндинга здоровья читается как
 * полное здоровье: порог по доле в таком документе не сработает никогда, и это
 * честнее молчаливого нуля, который перевёл бы босса в последнюю фазу сразу.
 */
export function healthFraction(
  ctx: SystemContext,
  bindings: CompiledNpcBindings,
  entity: EntityId,
): Fixed {
  if (!bindings.hasHealth) return FIXED_ONE;
  const max = ctx.get(entity, bindings.healthMaxComponent, bindings.healthMaxField);
  if (max <= 0) return FIXED_ONE;
  const hp = ctx.get(entity, bindings.healthComponent, bindings.healthField);
  if (hp <= 0) return 0;
  if (hp >= max) return FIXED_ONE;
  // Поля здоровья — обычные счётчики сцены (i32), поэтому доля считается
  // делением целых в Q16.16, а не делением уже-долей.
  return div(hp * FIXED_ONE, max * FIXED_ONE);
}

/**
 * Потолок накопленной угрозы (NPC-5). Не баланс, а граница представления:
 * значения таблицы — Q16.16 в i32, и без потолка бой без забывания
 * (`decayPerTick` = 1) рано или поздно переполнил бы сложение и увёл угрозу в
 * минус — то есть молча сломал бы выбор цели. Насыщение вместо переполнения
 * сохраняет ПОРЯДОК источников, а порядок — это всё, что таблица значит.
 *
 * Четверть диапазона i32: суммы и произведение на порог смены цели
 * (`switchMargin`) остаются в i32 с запасом.
 */
const THREAT_CEILING = 0x1fffffff;

/** Сложение с насыщением: угроза копится, но за потолок не выходит (NPC-5). */
function addSaturating(accumulated: Fixed, amount: Fixed): Fixed {
  const sum = accumulated + amount;
  return sum >= THREAT_CEILING ? THREAT_CEILING : sum;
}

/** Значение поля таблицы с учётом уже поставленных команд буфера (CMD-5). */
function pending(ctx: SystemContext, entity: EntityId, field: string): number {
  return ctx.commands.peekField(entity, NPC_THREAT_COMPONENT, field) ?? ctx.get(entity, NPC_THREAT_COMPONENT, field);
}

export function threatSourceAt(ctx: SystemContext, entity: EntityId, slot: number): EntityId {
  return pending(ctx, entity, threatSourceField(slot));
}

export function threatValueAt(ctx: SystemContext, entity: EntityId, slot: number): Fixed {
  return pending(ctx, entity, threatValueField(slot));
}

/**
 * Начисление угрозы источнику (NPC-5): свой слот, свободный слот либо
 * вытеснение НАИМЕНЬШЕЙ угрозы. Таблица не растёт и тик не аллоцирует.
 *
 * Вытеснение сравнивает накопленную угрозу с ПРИБАВКОЙ: новый источник
 * вытесняет минимум, только если сам весит больше него, — иначе слабый шум
 * выбивал бы из таблицы того, кто её и заполнил.
 */
export function threatAdd(
  ctx: SystemContext,
  entity: EntityId,
  source: EntityId,
  rawAmount: Fixed,
): void {
  if (rawAmount <= 0 || source === NO_ENTITY || source === entity) return;
  // Прибавка приходит из данных СОБЫТИЯ, помноженных на вес документа, и
  // ограничить её обязан механизм: величина события — число сцены, а не
  // проверенное поле документа (NPC-5).
  const amount = rawAmount >= THREAT_CEILING ? THREAT_CEILING : rawAmount;
  let freeSlot = -1;
  let minSlot = 0;
  let minValue = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    const holder = threatSourceAt(ctx, entity, slot);
    if (holder === source) {
      ctx.commands.setField(
        entity,
        NPC_THREAT_COMPONENT,
        threatValueField(slot),
        addSaturating(threatValueAt(ctx, entity, slot), amount),
      );
      return;
    }
    if (holder === NO_ENTITY) {
      if (freeSlot < 0) freeSlot = slot;
      continue;
    }
    const value = threatValueAt(ctx, entity, slot);
    if (value < minValue) {
      minValue = value;
      minSlot = slot;
    }
  }
  const slot = freeSlot >= 0 ? freeSlot : minValue < amount ? minSlot : -1;
  if (slot < 0) return;
  ctx.commands.setField(entity, NPC_THREAT_COMPONENT, threatSourceField(slot), source);
  ctx.commands.setField(entity, NPC_THREAT_COMPONENT, threatValueField(slot), amount);
}

/** Забывание: умножение накопленного на множитель документа (NPC-5). */
export function threatDecay(ctx: SystemContext, entity: EntityId, factor: Fixed): void {
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    if (threatSourceAt(ctx, entity, slot) === NO_ENTITY) continue;
    const value = mul(threatValueAt(ctx, entity, slot), factor);
    if (value <= 0) {
      // Забытый источник освобождает слот: иначе таблица навсегда занята
      // нулями, и вытеснять было бы нечего.
      ctx.commands.setField(entity, NPC_THREAT_COMPONENT, threatSourceField(slot), NO_ENTITY);
      ctx.commands.setField(entity, NPC_THREAT_COMPONENT, threatValueField(slot), 0);
      continue;
    }
    ctx.commands.setField(entity, NPC_THREAT_COMPONENT, threatValueField(slot), value);
  }
}

/** Угроза конкретного источника; ноль — источника в таблице нет. */
export function threatOf(ctx: SystemContext, entity: EntityId, source: EntityId): Fixed {
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    if (threatSourceAt(ctx, entity, slot) === source) return threatValueAt(ctx, entity, slot);
  }
  return 0;
}
