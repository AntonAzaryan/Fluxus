/**
 * Списки источников-модификаторов (TIME-7, FOW-3): `{ sources: [{id, value}] }`
 * как core-контракт стакинга. Редьюсеров два — произведение для множителей и
 * OR для масок каналов (FOW-3); композиционная политика («сильнейший»,
 * аддитив, стак) живёт вне ядра и выражается тем, что именно система-владелец
 * кладёт в список (TIME-8).
 *
 * Поля компонента скалярные (ECS-3), массивов в ECS нет — поэтому список
 * разворачивается в фиксированное число слотов `id0/value0 … idN/valueN`, тем
 * же приёмом, что карта пола в `terrain.ts`. Слот свободен, когда `id == 0`:
 * нулевой идентификатор источника запрещён, и «пусто» не путается с
 * «множитель ноль».
 *
 * Экземпляр создаётся на сцену (`sim/scene.ts`, SER-7), а не на уровне модуля:
 * модульный синглтон разделили бы две симуляции в одном процессе (DI-1).
 * Собственного состояния у экземпляра нет вовсе — коллизия слотов внутри тика
 * решается чтением уже поставленных команд буфера (CMD-5), потому что оверлей
 * вне мира не восстанавливается снапшотом (TICK-4).
 *
 * ponytail: слотов фиксированное число, переполнение — ошибка, а не рост
 * массива. Динамический список потребовал бы массивных полей в ECS; вводить их
 * до того, как известно реальное число одновременных эффектов, незачем.
 */
import {
  FIXED_ONE,
  type EntityId,
  type ModifierList,
  type ModifierRegistry,
  type SystemContext,
} from '../types.js';

/** Слотов на сущность по умолчанию (SER-7): столько независимых эффектов держится без ошибки. */
export const DEFAULT_MODIFIER_SLOTS = 4;

/** Имена дополнены нулями до одной длины — иначе plain-форма сортирует id10 перед id2 (SER-6). */
function slotName(prefix: string, index: number, total: number): string {
  return `${prefix}${String(index).padStart(String(total - 1).length, '0')}`;
}

/**
 * Вид значения слота (FOW-3): `scale` — множитель Q16.16 с нейтралью `65536`,
 * `mask` — маска каналов `i32` с нейтралью `0`. Раскладка слотов, занятость и
 * имена от вида не зависят — третьего формата TIME-7 запрещает.
 */
export type ModifierValueKind = 'scale' | 'mask';

export function modifierList(
  component: string,
  slots: number = DEFAULT_MODIFIER_SLOTS,
  valueKind: ModifierValueKind = 'scale',
): ModifierList {
  if (!Number.isInteger(slots) || slots < 1) throw new Error(`${component}: слотов должно быть ≥ 1`);

  const neutral = valueKind === 'mask' ? 0 : FIXED_ONE;
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
    fields[value] = valueKind === 'mask' ? 'i32' : 'fixed';
    defaults[value] = neutral;
  }

  /**
   * Занятость слота: сначала уже поставленная команда этого буфера, потом мир.
   * Мир до flush команд не видит (CMD-5), поэтому два `add` подряд без чтения
   * буфера сели бы в один слот и первый источник молча пропал бы. Буфер живёт
   * ровно один тик и очищается на flush каждой системы — состояния, которое
   * пережило бы тик, здесь нет (TICK-4, REW-7).
   */
  const slotId = (ctx: SystemContext, entity: EntityId, slot: number): number =>
    ctx.commands.peekField(entity, component, ids[slot]!) ?? ctx.get(entity, component, ids[slot]!);

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

    union(ctx, entity) {
      if (!ctx.has(entity, component)) return 0;
      let acc = 0;
      for (let i = 0; i < slots; i++) {
        if (ctx.get(entity, component, ids[i]!) === 0) continue;
        acc |= ctx.get(entity, component, values[i]!);
      }
      return acc;
    },

    add(ctx, entity, id, value) {
      if (id === 0) throw new Error(`${component}: id источника не может быть нулём`);
      const existing = findSlot(ctx, entity, id);
      const slot = existing >= 0 ? existing : findSlot(ctx, entity, 0);
      if (slot < 0) throw new Error(`${component}: все ${slots} слотов заняты`);
      ctx.commands.setField(entity, component, ids[slot]!, id);
      ctx.commands.setField(entity, component, values[slot]!, value);
    },

    remove(ctx, entity, id) {
      const slot = findSlot(ctx, entity, id);
      if (slot < 0) return;
      ctx.commands.setField(entity, component, ids[slot]!, 0);
      ctx.commands.setField(entity, component, values[slot]!, neutral);
    },
  };
}

/**
 * Список по имени компонента или ошибка. Сцена без этого списка управлять им не
 * может (ACT-1): «действие без эффекта» скрыло бы опечатку в конфиге.
 */
export function requireModifierList(registry: ModifierRegistry | undefined, component: string): ModifierList {
  const list = registry?.get(component);
  if (list === undefined) {
    throw new Error(`список источников "${component}" сцена не подключает (TIME-7, SER-7)`);
  }
  return list;
}
