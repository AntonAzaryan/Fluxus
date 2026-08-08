/**
 * Публичная поверхность каркаса рабочих областей (ED-23, ED-24, ED-25).
 *
 * Наружу выходит ровно то, чем пользуются вклады и оболочка приложения: тип
 * области, три её зоны, сквозное выделение, сам каркас и его монтирование.
 * Хранилище записей состояния публичным не делается намеренно — доступ к
 * чужой записи мимо `stateOf` был бы вторым путём к состоянию области, а
 * значит и вторым местом, где решается, кто им владеет.
 *
 * По тому же основанию наружу не выходят части страницы — рельс, скелет и
 * верхний бар. Собрать их можно только каркасом: отданный отдельно `skeleton`
 * позволил бы собрать страницу с зонами в другом порядке, то есть ровно то,
 * что ED-24 запрещает области. Порядок зон при этом публичен (`ZONE_ORDER`) —
 * знание о нём никому не вредит, а вторая сборка вредит.
 *
 * Имена классов, которые вклад ставит своим зонам (прокрутка, блок во всю
 * зону), публичны: вклад бывает и вне этого пакета (ED-25), а без них его
 * зона не умеет ни прокручиваться, ни отдать место кадру.
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
  FRAME_BINDINGS,
  REDO_BINDING,
  UNDO_BINDING,
  keyStrokeOf,
  matchesBinding,
  sameBinding,
} from './keys.js';
export type { KeyStroke } from './keys.js';
export { mountWorkspaceFrame } from './mount.js';
export type { MountedFrame, MountOptions } from './mount.js';
/**
 * Сведение просьб перерисовать наружу не выходит: им пользуется отрисовка
 * страницы, а не вклад. Подменить отсрочку можно параметром монтирования —
 * второго способа перерисовать страницу это не заводит.
 */
export type { RedrawSchedule } from './redraw.js';
export { RAIL_ITEM_CLASS, RAIL_ROVING_ID } from './rail.js';
export { createSelectionModel } from './selection.js';
export type { AreaSelection, SelectionModel, SelectionRef } from './selection.js';
export { ZONE_ORDER } from './skeleton.js';
export type { ZoneName } from './skeleton.js';
export {
  FILL_CLASS,
  FILL_COLUMN_CLASS,
  FRAME_RULES,
  INSPECTOR_ZONE_CLASS,
  NAVIGATOR_ZONE_CLASS,
  SCROLL_CLASS,
  SURFACE_ZONE_CLASS,
} from './styles.js';
