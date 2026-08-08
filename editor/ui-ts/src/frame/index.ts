/**
 * Публичная поверхность каркаса рабочих областей (ED-23, ED-24, ED-25).
 *
 * Наружу выходит ровно то, чем пользуются вклады и оболочка приложения: тип
 * области, три её зоны, сквозное выделение, сам каркас и его монтирование.
 * Хранилище записей состояния публичным не делается намеренно — доступ к
 * чужой записи мимо `stateOf` был бы вторым путём к состоянию области, а
 * значит и вторым местом, где решается, кто им владеет.
 */
export type {
  AreaContext,
  AreaSetup,
  AreaState,
  AreaZones,
  WorkspaceArea,
} from './area.js';
export { createWorkspaceFrame } from './frame.js';
export type { WorkspaceFrame, WorkspaceFrameOptions } from './frame.js';
export {
  DISMISS_KEY,
  REDO_BINDING,
  UNDO_BINDING,
  bindingOf,
  keyStrokeOf,
  matchesBinding,
} from './keys.js';
export type { KeyStroke } from './keys.js';
export { mountWorkspaceFrame } from './mount.js';
export type { MountedFrame } from './mount.js';
export { RAIL_ITEM_CLASS, RAIL_ROVING_ID, areaRail } from './rail.js';
export type { AreaRailSpec } from './rail.js';
export { createSelectionModel } from './selection.js';
export type { AreaSelection, SelectionModel, SelectionRef } from './selection.js';
export { ZONE_ORDER, areaSkeleton } from './skeleton.js';
export type { ZoneName } from './skeleton.js';
export {
  FRAME_RULES,
  INSPECTOR_ZONE_CLASS,
  NAVIGATOR_ZONE_CLASS,
  SCROLL_CLASS,
  SURFACE_ZONE_CLASS,
} from './styles.js';
export { frameTopBar } from './topBar.js';
export type { TopBarSpec } from './topBar.js';
