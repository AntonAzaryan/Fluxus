/**
 * Первые виджеты HUD (задача 5.1): статус матча и панель действий героя.
 * Оба — обычные виды за единым интерфейсом виджета (HUD-4): регистрируются в
 * реестре видов, параметризуются params записи композиции и действуют только
 * через слоты действий (HUD-2).
 */
export {
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
