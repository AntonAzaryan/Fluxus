// Экранный интерфейс идущего матча (capability match-hud): DOM-слой поверх
// вьюпорта в главном потоке, чистый наблюдатель доставленного состояния
// оболочки (client-shell SHELL-2).

// Лёгкая узловая абстракция: описания узлов и тонкая граница «описание → DOM».
export { children, el, findAll, hasClass, walk } from './dom/node.js';
export type { HudHandler, HudNode, HudNodeSpec } from './dom/node.js';
export { renderInto, renderNode, setAttr, setText, toggleClass } from './dom/render.js';

// Зоны экрана — фиксированный словарь хоста (design Decision 5).
export { HUD_ZONES, isHudZone } from './zones.js';
export type { HudZoneName } from './zones.js';

// Композиция — JSON-сериализуемое значение со ссылками-именами (HUD-4).
export type {
  HudComposition,
  HudCompositionEntry,
  HudJsonValue,
  HudParams,
} from './composition.js';

// Доставленное состояние глазами HUD (HUD-1, HUD-5) и чтение статов (HUD-8).
export { entityStat } from './delivery.js';
export type {
  HudDeliveredEvent,
  HudDeliveredState,
  HudDeliverySubsystem,
  HudEntityView,
  HudPauseState,
  HudWorldMode,
} from './delivery.js';

// Фасад действий с двумя адресатами: мир — обратным каналом, камера — локально (HUD-2).
export { HudActionsFacade } from './actions.js';
export type {
  HudActionDecl,
  HudActionPayload,
  HudActionSource,
  HudActionsFacadeOptions,
  HudCameraContract,
  HudControlChannel,
} from './actions.js';

// Единый интерфейс виджета (HUD-4).
export type {
  HudActionsPort,
  HudBindingValues,
  HudUpdate,
  HudWidget,
  HudWidgetKind,
} from './widget.js';

// Реестры видов, селекторов и действий; резолв композиции по именам (HUD-4).
export { HudRegistry, resolveComposition } from './registry.js';
export type {
  HudSelector,
  ResolvedHudAction,
  ResolvedHudBinding,
  ResolvedHudComposition,
  ResolvedHudEntry,
} from './registry.js';

// Оверлей-хост поверх canvas: зоны и прохождение указателя (HUD-3).
export { HUD_ZONE_ATTR, HudOverlayHost, interactive, overlayNode } from './host.js';

// Исполнитель композиции и подписка на доставку (HUD-4, HUD-5).
export { HudRuntime } from './runtime.js';
export type { HudRuntimeOptions } from './runtime.js';

// Иконки: asset ID контента, резолв ТЕМ ЖЕ сервисом ассетов, что у рендера
// (HUD-4, HUD-7, ASSET-2).
export { HUD_ICON_ASSET_KIND, HudIcons, assetIdParam, hudIconLoader, iconAssetId } from './icons.js';
export type { HudIconImage, HudIconTable } from './icons.js';

// Первые виджеты: статус матча и панель способностей (HUD-2, HUD-4).
export * from './widgets/index.js';

// Миникарта: canvas-2D виджет и таблица маркеров — данные (HUD-6).
export * from './minimap/index.js';

// Живой портрет: изолированный стенд модели на render-ts (HUD-7).
export * from './portrait/index.js';
