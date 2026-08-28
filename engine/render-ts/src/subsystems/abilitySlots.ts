/**
 * Имена статов доставки слотов способностей (HUD-8, ABIL-1) и чтение их у
 * доставленной сущности — то, ЧЕМ превью цепочки узнаёт идущий каст.
 *
 * Отдельно от самой подсистемы, потому что это её ВХОД, а не устройство: какое
 * имя стата несёт фазу каста — знание сборки (SHELL-2), и оно объявляется
 * снаружи, вместе со списком статов экстрактора. Подсистема эти имена только
 * читает, ничего о их происхождении не зная.
 */
import type { EntityView } from '../types.js';

/**
 * Имена статов доставки одного подтверждённого шага (HUD-8): точка шага и
 * сущность шага — те же три поля слота, что называет ABIL-1
 * (`step{N}x`/`step{N}y`/`step{N}e`).
 */
export interface AbilityStepStatNames {
  readonly x: string;
  readonly y: string;
  readonly entity: string;
}

/**
 * Имена статов доставки одного слота способности (HUD-8). Объявляет их сборка:
 * какое имя несёт фазу каста — знание контента, а не рендера.
 */
export interface AbilitySlotStatNames {
  /** Индекс определения в каталоге — поле `abilityId` слота (ABIL-1). */
  readonly ability: string;
  /** Индекс фазы; отрицательное значение либо отсутствие стата — каста нет. */
  readonly phase: string;
  /** Сколько шагов уже подтверждено — поле `staged` (ABIL-5). */
  readonly staged: string;
  /** Имена статов шагов по их индексу; не более `ABILITY_STEPS` записей. */
  readonly steps: readonly AbilityStepStatNames[];
}

/** Стат сущности по имени; нет стата — `NaN`, то есть «нет данных», а не ноль. */
export function statOf(view: EntityView, name: string): number {
  return view.stats?.get(name) ?? Number.NaN;
}
