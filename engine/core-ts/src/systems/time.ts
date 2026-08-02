/**
 * Time scale (TIME-1..9): сведение списка источников замедления в компонент
 * `TimeScale`, который читает `getEffectiveDelta` (TIME-3).
 *
 * Tick rate здесь не участвует вовсе (TIME-1): частота тика фиксирована, а
 * замедление целиком живёт в данных. Кто из систем его учитывает — решает
 * каждая система сама (TIME-4), ядро за них не решает.
 *
 * Сама `TimeScaleSystem` TimeScale, разумеется, не учитывает (TIME-5,
 * требование явной документации): она его вычисляет, и опираться на прошлое
 * значение при вычислении нового означало бы экспоненту за несколько тиков.
 */
import * as fixed from '../math/fixed.js';
import { modifierList } from './modifiers.js';
import { FIXED_ONE, TIME_SCALE_COMPONENT, type ComponentSchema, type System, type SystemContext } from '../types.js';

/**
 * Техническая защита от деления на ~0 в `getEffectiveDelta`, не балансный кап
 * (TIME-7): баланс живёт в том, что система-владелец кладёт в `sources`.
 */
export const TIME_SCALE_MIN = fixed.fromFloat(0.05);
export const TIME_SCALE_MAX = fixed.fromInt(4);

/** Раньше всех потребителей, но позже `InputSystem` (order −1000). */
const DEFAULT_ORDER = -900;

/** Компонент множителя (TIME-2). Дефолт `1.0`: сущность без источников идёт в обычном темпе. */
export const TIME_SCALE_SCHEMA: ComponentSchema = {
  name: TIME_SCALE_COMPONENT,
  fields: { value: 'fixed' },
  defaults: { value: FIXED_ONE },
};

/** Список источников замедления (TIME-7); наполняют его геймплейные системы (TIME-8). */
export const TIME_SCALE_MODIFIERS = modifierList('TimeScaleModifiers');

/** Оба компонента для секции `components` сцены — порядок задаёт их битовые id (SER-7). */
export const TIME_COMPONENTS: readonly ComponentSchema[] = [TIME_SCALE_SCHEMA, TIME_SCALE_MODIFIERS.schema];

export interface TimeScaleSystemOptions {
  readonly name?: string;
  readonly order?: number;
}

export class TimeScaleSystem implements System {
  readonly name: string;
  readonly order: number;

  constructor(options: TimeScaleSystemOptions = {}) {
    this.name = options.name ?? 'TimeScale';
    this.order = options.order ?? DEFAULT_ORDER;
  }

  run(ctx: SystemContext): void {
    // Обход только по результату запроса (DET-6): порядок здесь — порядок
    // индексов сущностей, а не обхода какой-нибудь карты.
    for (const entity of ctx.query({ all: [TIME_SCALE_MODIFIERS.component] })) {
      const value = TIME_SCALE_MODIFIERS.product(ctx, entity, TIME_SCALE_MIN, TIME_SCALE_MAX);
      if (!ctx.has(entity, TIME_SCALE_COMPONENT)) {
        // Нейтральное значение компонента не требует: `getEffectiveDelta` без
        // него и так вернёт `globalDelta` (TIME-3).
        if (value !== FIXED_ONE) ctx.commands.addComponent(entity, TIME_SCALE_COMPONENT, { value });
        continue;
      }
      // Запись неизменившегося значения пометила бы сущность dirty и попала бы
      // в сетевую дельту пустышкой — тот же довод, что в FOW-6/SNAP-5.
      if (ctx.get(entity, TIME_SCALE_COMPONENT, 'value') === value) continue;
      ctx.commands.setField(entity, TIME_SCALE_COMPONENT, 'value', value);
    }
  }
}
