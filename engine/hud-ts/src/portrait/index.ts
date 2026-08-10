/**
 * Публичная поверхность виджета живого портрета (HUD-7): вид виджета и его
 * шов инъекции, шов стенда для тестов и THREE-реализация стенда. Подключение
 * к `src/index.ts` пакета — забота сборки экспорта, здесь только фолдерный
 * барель.
 */
export {
  PORTRAIT_CLASS,
  PORTRAIT_DEAD_CLASS,
  PORTRAIT_EMPTY_CLASS,
  PORTRAIT_HERO_SLOT,
  PORTRAIT_HIT_CLASS,
  PORTRAIT_WIDGET_NAME,
  createPortraitKind,
  type PortraitSetup,
} from './widget.js';
export type { PortraitStage, PortraitStageFactory, PortraitStageOptions } from './stage.js';
export { createThreePortraitStage } from './threeStage.js';
