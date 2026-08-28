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
import { NPC_AGENT_COMPONENT, NPC_THREAT_COMPONENT, NPC_THREAT_SLOTS } from './components.js';
import type { NpcHandles } from './handles.js';
import type { CompiledNpcBindings } from './model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type FieldHandle,
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

export function posX(ctx: SystemContext, handles: NpcHandles, entity: EntityId): Fixed {
  return ctx.getByHandle(entity, handles.posX);
}

export function posY(ctx: SystemContext, handles: NpcHandles, entity: EntityId): Fixed {
  return ctx.getByHandle(entity, handles.posY);
}

/**
 * Мёртв ли — по маркеру сцены (биндинг NPC-1). Сцена без маркера мёртвых не
 * знает вовсе, и тогда живой считается всякая живая сущность: понятия смерти
 * ядро не приобретает.
 */
export function isDead(ctx: SystemContext, handles: NpcHandles, entity: EntityId): boolean {
  const marker = handles.deadMarker;
  return marker !== undefined && ctx.hasByHandle(entity, marker);
}

/** Сторона сущности; `undefined` — сцена стороны не объявила либо её у сущности нет. */
export function teamOf(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
): number | undefined {
  const team = handles.team;
  if (team === undefined || !ctx.hasByHandle(entity, team.component)) return undefined;
  return ctx.getByHandle(entity, team.field);
}

/**
 * Доля здоровья в [0, 1] (NPC-7). Сцена без биндинга здоровья читается как
 * полное здоровье: порог по доле в таком документе не сработает никогда, и это
 * честнее молчаливого нуля, который перевёл бы босса в последнюю фазу сразу.
 */
export function healthFraction(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
): Fixed {
  const health = handles.health;
  if (health === undefined) return FIXED_ONE;
  const max = ctx.getByHandle(entity, health.max);
  if (max <= 0) return FIXED_ONE;
  const hp = ctx.getByHandle(entity, health.value);
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

/**
 * Значение поля таблицы с учётом уже поставленных команд буфера (CMD-5).
 * Буферу нужно ИМЯ поля (адрес команды — строка, CMD-1), миру — handle: обе
 * величины разрешены заранее и лежат в слоте рядом (SYS-10).
 */
function pending(ctx: SystemContext, entity: EntityId, field: string, handle: FieldHandle): number {
  return ctx.commands.peekField(entity, NPC_THREAT_COMPONENT, field) ?? ctx.getByHandle(entity, handle);
}

export function threatSourceAt(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
  slot: number,
): EntityId {
  const entry = handles.threatSlots[slot]!;
  return pending(ctx, entity, entry.sourceField, entry.source);
}

export function threatValueAt(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
  slot: number,
): Fixed {
  const entry = handles.threatSlots[slot]!;
  return pending(ctx, entity, entry.valueField, entry.value);
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
  handles: NpcHandles,
  entity: EntityId,
  source: EntityId,
  rawAmount: Fixed,
): void {
  if (rawAmount <= 0 || source === NO_ENTITY || source === entity) return;
  // Прибавка приходит из данных СОБЫТИЯ, помноженных на вес документа, и
  // ограничить её обязан механизм: величина события — число сцены, а не
  // проверенное поле документа (NPC-5).
  const amount = rawAmount >= THREAT_CEILING ? THREAT_CEILING : rawAmount;
  placeThreat(ctx, handles, entity, source, amount);
}

/**
 * Размещение уже ограниченной прибавки в таблице (NPC-5): свой слот, свободный
 * слот либо вытеснение НАИМЕНЬШЕЙ угрозы. Один проход по таблице, без
 * аллокаций.
 */
function placeThreat(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
  source: EntityId,
  amount: Fixed,
): void {
  let freeSlot = -1;
  let minSlot = 0;
  let minValue = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    const holder = threatSourceAt(ctx, handles, entity, slot);
    if (holder === source) {
      ctx.commands.setField(
        entity,
        NPC_THREAT_COMPONENT,
        handles.threatSlots[slot]!.valueField,
        addSaturating(threatValueAt(ctx, handles, entity, slot), amount),
      );
      return;
    }
    if (holder === NO_ENTITY) {
      if (freeSlot < 0) freeSlot = slot;
      continue;
    }
    const value = threatValueAt(ctx, handles, entity, slot);
    if (value < minValue) {
      minValue = value;
      minSlot = slot;
    }
  }
  const slot = freeSlot >= 0 ? freeSlot : minValue < amount ? minSlot : -1;
  if (slot < 0) return;
  const entry = handles.threatSlots[slot]!;
  ctx.commands.setField(entity, NPC_THREAT_COMPONENT, entry.sourceField, source);
  ctx.commands.setField(entity, NPC_THREAT_COMPONENT, entry.valueField, amount);
}

/** Забывание: умножение накопленного на множитель документа (NPC-5). */
export function threatDecay(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
  factor: Fixed,
): void {
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    if (threatSourceAt(ctx, handles, entity, slot) === NO_ENTITY) continue;
    const entry = handles.threatSlots[slot]!;
    const value = mul(threatValueAt(ctx, handles, entity, slot), factor);
    if (value <= 0) {
      // Забытый источник освобождает слот: иначе таблица навсегда занята
      // нулями, и вытеснять было бы нечего.
      ctx.commands.setField(entity, NPC_THREAT_COMPONENT, entry.sourceField, NO_ENTITY);
      ctx.commands.setField(entity, NPC_THREAT_COMPONENT, entry.valueField, 0);
      continue;
    }
    ctx.commands.setField(entity, NPC_THREAT_COMPONENT, entry.valueField, value);
  }
}

/** Угроза конкретного источника; ноль — источника в таблице нет. */
export function threatOf(
  ctx: SystemContext,
  handles: NpcHandles,
  entity: EntityId,
  source: EntityId,
): Fixed {
  for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
    if (threatSourceAt(ctx, handles, entity, slot) === source) {
      return threatValueAt(ctx, handles, entity, slot);
    }
  }
  return 0;
}
