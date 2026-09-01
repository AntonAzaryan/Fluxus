/**
 * Time scale (TIME-1..9): сведение списка источников замедления в компонент
 * `TimeScale`, который читает `getEffectiveDelta` (TIME-3).
 *
 * Tick rate здесь не участвует вовсе (TIME-1): частота тика фиксирована, а
 * замедление целиком живёт в данных. Кто из систем его учитывает — решает
 * каждая система сама (TIME-4), ядро за них не решает.
 *
 * TimeScale (TIME-5): игнорирует — сама `TimeScaleSystem` его и вычисляет, а
 * опора на прошлое значение при вычислении нового означала бы экспоненту за
 * несколько тиков.
 */
import * as fixed from '../math/fixed.js';
import {
  FIXED_ONE,
  TIME_SCALE_COMPONENT,
  type ComponentSchema,
  type Fixed,
  type ModifierList,
  type System,
  type SystemContext,
} from '../types.js';

/**
 * Техническая защита от вырожденного множителя, не балансный кап (TIME-7):
 * `getEffectiveDelta` — чистое умножение, и множитель, усечённый в ноль,
 * остановил бы потребителя навсегда. Баланс живёт в том, что
 * система-владелец кладёт в `sources`.
 *
 * Границы нормированы сырым Q16.16 (`3276` ≈ 0.049988…, `262144` = 4.0), а не
 * десятичной записью: `0.05 · 65536 = 3276.8`, и реализация с округлением дала
 * бы `3277`, то есть другие байты в снапшоте при том же тексте требования
 * (FP-3, CLI-6). Поэтому здесь целое, а не `fromFloat(0.05)`.
 */
export const TIME_SCALE_MIN: Fixed = 3276;
export const TIME_SCALE_MAX: Fixed = fixed.fromInt(4);

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = -900;

/** Компонент множителя (TIME-2). Дефолт `1.0`: сущность без источников идёт в обычном темпе. */
export const TIME_SCALE_SCHEMA: ComponentSchema = {
  name: TIME_SCALE_COMPONENT,
  fields: { value: 'fixed' },
  defaults: { value: FIXED_ONE },
};

/** Имя компонента списка источников замедления (TIME-7); экземпляр списка создаёт сцена. */
export const TIME_SCALE_MODIFIERS_COMPONENT = 'TimeScaleModifiers';

/**
 * Оба компонента для секции `components` сцены — порядок задаёт их битовые id
 * (SER-7), поэтому список источников обязан остаться вторым. Функция, а не
 * константа: схема списка — функция от числа слотов, то есть от конфига сцены.
 */
export function timeComponents(modifiers: ModifierList): readonly ComponentSchema[] {
  return [TIME_SCALE_SCHEMA, modifiers.schema];
}

export interface TimeScaleSystemOptions {
  readonly name?: string;
}

export class TimeScaleSystem implements System {
  readonly name: string;
  readonly order = ANCHOR_ORDER;
  // Явное поле вместо parameter property — по той же причине, что в
  // `VisibilitySystem`: strip-only режим Node не поддерживает этот сахар, а ядро
  // исполняется прямо из исходников, без шага сборки (CLI-1).
  private readonly modifiers: ModifierList;

  /** Список источников приходит извне (DI-1): своего модульного у системы нет. */
  constructor(modifiers: ModifierList, options: TimeScaleSystemOptions = {}) {
    this.modifiers = modifiers;
    this.name = options.name ?? 'TimeScale';
  }

  run(ctx: SystemContext): void {
    // Обход только по результату запроса (DET-6): порядок здесь — порядок
    // индексов сущностей, а не обхода какой-нибудь карты.
    for (const entity of ctx.query({ all: [this.modifiers.component] })) {
      const value = this.modifiers.product(ctx, entity, TIME_SCALE_MIN, TIME_SCALE_MAX);
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
