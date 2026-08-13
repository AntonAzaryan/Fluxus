/**
 * Первые виджеты HUD (задача 5.1): статус матча и панель действий героя.
 * Оба — обычные виды за единым интерфейсом виджета (HUD-4): регистрируются в
 * реестре видов, параметризуются params записи композиции и действуют только
 * через слоты действий (HUD-2).
 */
export {
  MATCH_STATUS_CONTROLS_PARAM,
  MATCH_STATUS_PAUSE_SLOT,
  MATCH_STATUS_PAUSED_CLASS,
  MATCH_STATUS_RESUME_SLOT,
  MATCH_STATUS_WIDGET,
  matchStatusKind,
} from './status.js';
export {
  ABILITY_BAR_ABILITIES_PARAM,
  ABILITY_BAR_ICONS_PARAM,
  ABILITY_BAR_WIDGET,
  abilityBarKind,
} from './abilities.js';
// Виджеты на доставленных статах (HUD-8) и на величинах главного потока.
export { HP_BAR_EMPTY_CLASS, HP_BAR_ENTITY_SLOT, HP_BAR_WIDGET, hpBarKind } from './hpBar.js';
export {
  COOLDOWNS_ABILITIES_PARAM,
  COOLDOWNS_ENTITY_SLOT,
  COOLDOWNS_WIDGET,
  cooldownModel,
  cooldownsKind,
} from './cooldowns.js';
export type { CooldownModel } from './cooldowns.js';
export { DEATHS_ENTITIES_SLOT, DEATHS_WIDGET, deathsKind, deathsRows } from './deaths.js';
export type { DeathsRow } from './deaths.js';
export {
  FrameRateMeter,
  RUNTIME_ENTITIES_SLOT,
  RUNTIME_WIDGET,
  runtimeKind,
} from './runtimePanel.js';
