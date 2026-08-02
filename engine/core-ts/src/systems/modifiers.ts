/**
 * Списки источников-модификаторов (TIME-7, FOW-3): `{ sources: [{id, value}] }`
 * как core-контракт стакинга. Reducer — произведение; композиционная политика
 * («сильнейший», аддитив, стак) живёт вне ядра и выражается тем, что именно
 * система-владелец кладёт в список (TIME-8).
 *
 * Поля компонента скалярные (ECS-3), массивов в ECS нет — поэтому список
 * разворачивается в фиксированное число слотов `id0/value0 … idN/valueN`, тем
 * же приёмом, что карта пола в `terrain.ts`. Слот свободен, когда `id == 0`:
 * нулевой идентификатор источника запрещён, и «пусто» не путается с
 * «множитель ноль».
 *
 * ponytail: слотов фиксированное число, переполнение — ошибка, а не рост
 * массива. Динамический список потребовал бы массивных полей в ECS; вводить их
 * до того, как известно реальное число одновременных эффектов, незачем.
 */
import { FIXED_ONE, type ComponentSchema, type EntityId, type Fixed, type SystemContext } from '../types.js';

/** Слотов на сущность по умолчанию: столько независимых эффектов держится без ошибки. */
const DEFAULT_SLOTS = 4;

/** Имена дополнены нулями до одной длины — иначе plain-форма сортирует id10 перед id2 (SER-6). */
function slotName(prefix: string, index: number, total: number): string {
  return `${prefix}${String(index).padStart(String(total - 1).length, '0')}`;
}

export interface ModifierList {
  readonly component: string;
  readonly slots: number;
  readonly schema: ComponentSchema;
  /**
   * Произведение значений занятых слотов, клампленное в `[lo, hi]`. У
   * сущности без компонента источников — `FIXED_ONE`.
   */
  product(ctx: SystemContext, entity: EntityId, lo: Fixed, hi: Fixed): Fixed;
  /** Добавляет или обновляет источник по `id`. Бросает, если свободных слотов нет. */
  add(ctx: SystemContext, entity: EntityId, id: number, value: Fixed): void;
  /** Снимает источник по `id`; отсутствующий id — не ошибка (TIME-8). */
  remove(ctx: SystemContext, entity: EntityId, id: number): void;
}

export function modifierList(component: string, slots: number = DEFAULT_SLOTS): ModifierList {
  if (!Number.isInteger(slots) || slots < 1) throw new Error(`${component}: слотов должно быть ≥ 1`);

  const ids: string[] = [];
  const values: string[] = [];
  const fields: Record<string, 'i32' | 'fixed'> = {};
  const defaults: Record<string, number> = {};
  for (let i = 0; i < slots; i++) {
    const id = slotName('id', i, slots);
    const value = slotName('value', i, slots);
    ids.push(id);
    values.push(value);
    fields[id] = 'i32';
    fields[value] = 'fixed';
    defaults[value] = FIXED_ONE;
  }

  /**
   * Слоты, занятые командами этого тика. Мир до `flush` их ещё не видит
   * (CMD-5), поэтому два `add` подряд без него сели бы в один слот и первый
   * источник молча пропал бы. Оверлей живёт ровно один тик и сбрасывается по
   * смене `ctx.tick` — в том числе при откате, который тик меняет (REW-2).
   */
  let pendingTick = -1;
  const pending = new Map<string, number>();

  const slotId = (ctx: SystemContext, entity: EntityId, slot: number): number => {
    if (ctx.tick !== pendingTick) {
      pending.clear();
      pendingTick = ctx.tick;
    }
    return pending.get(`${entity}:${slot}`) ?? ctx.get(entity, component, ids[slot]!);
  };

  const claim = (ctx: SystemContext, entity: EntityId, slot: number, id: number): void => {
    slotId(ctx, entity, slot); // сбрасывает оверлей на смене тика
    pending.set(`${entity}:${slot}`, id);
  };

  const findSlot = (ctx: SystemContext, entity: EntityId, id: number): number => {
    for (let i = 0; i < slots; i++) {
      if (slotId(ctx, entity, i) === id) return i;
    }
    return -1;
  };

  return {
    component,
    slots,
    schema: { name: component, fields, defaults },

    product(ctx, entity, lo, hi) {
      if (!ctx.has(entity, component)) return FIXED_ONE;
      let acc = FIXED_ONE;
      for (let i = 0; i < slots; i++) {
        if (ctx.get(entity, component, ids[i]!) === 0) continue;
        acc = ctx.math.mul(acc, ctx.get(entity, component, values[i]!));
      }
      return ctx.math.clamp(acc, lo, hi);
    },

    add(ctx, entity, id, value) {
      if (id === 0) throw new Error(`${component}: id источника не может быть нулём`);
      const existing = findSlot(ctx, entity, id);
      const slot = existing >= 0 ? existing : findSlot(ctx, entity, 0);
      if (slot < 0) throw new Error(`${component}: все ${slots} слотов заняты`);
      claim(ctx, entity, slot, id);
      ctx.commands.setField(entity, component, ids[slot]!, id);
      ctx.commands.setField(entity, component, values[slot]!, value);
    },

    remove(ctx, entity, id) {
      const slot = findSlot(ctx, entity, id);
      if (slot < 0) return;
      claim(ctx, entity, slot, 0);
      ctx.commands.setField(entity, component, ids[slot]!, 0);
      ctx.commands.setField(entity, component, values[slot]!, FIXED_ONE);
    },
  };
}
