/**
 * Словарь наложений редактора (REND-16) — ЧТО инструмент кладёт в подсистему и
 * когда набор считается неизменившимся.
 *
 * Отдельно от самой подсистемы, потому что это её ВХОД: набор наложений —
 * состояние инструмента (что выделено, какой gizmo активен), и составляет его
 * редактор, ничего не зная о сценовых объектах, которыми подсистема это
 * рисует. Здесь же живёт сравнение записей: «то же самое наложение» — свойство
 * записи, а не узла сцены, и решает его тот, кто запись описывает.
 */
import type { EntityId } from '@fluxus/core';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { InstanceProxySource } from '../picking.js';

/** Ось наложения в мировых осях сцены. */
export type OverlayAxis = 'x' | 'y' | 'z';

/** Форма ручки gizmo: перемещение вдоль оси либо поворот вокруг неё. */
export type OverlayHandleForm = 'translate' | 'rotate';

/**
 * Ручка gizmo. `id` — её идентичность: им же picking называет попадание
 * (REND-15). Что произойдёт при захвате, рендеру неизвестно (ED-16, ED-29).
 */
export interface OverlayHandle {
  readonly id: string;
  readonly axis: OverlayAxis;
  readonly form: OverlayHandleForm;
  /** Курсор наведён на ручку. */
  readonly hovered?: boolean;
  /** Ручка захвачена. */
  readonly active?: boolean;
}

/** Подсветка инстанса в его видимой позе. */
export interface OverlayHighlight {
  readonly kind: 'highlight';
  readonly key: string;
  readonly entity: EntityId;
  /**
   * Подсвечивается decoration-инстанс (REND-18), а не сущность
   * presentation-состояния. Признак, а не отдельный вид наложения: подсветка у
   * сим-объекта и у декорации одна и та же — этого требует единообразие
   * выделения (`editor` ED-17), — а различаются только наборы, в которых
   * ищется инстанс.
   */
  readonly decoration?: boolean;
}

/** Ручки gizmo в заданной позе. */
export interface OverlayGizmo {
  readonly kind: 'gizmo';
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Разворот набора ручек вокруг вертикали, радианы; нет — мировые оси. */
  readonly yaw?: number;
  /**
   * Множитель размера ручек поверх размера подсистемы; нет — 1. Поле набора, а
   * не настройка сборки: экранно-постоянный gizmo — состояние инструмента,
   * зависящее от дистанции камеры, и держать его в конструкторе значило бы
   * лишить редактора (ED-16) единственного способа его назначить.
   */
  readonly scale?: number;
  readonly handles: readonly OverlayHandle[];
}

/** Набор клеток, лежащий на визуальной поверхности. */
export interface OverlayCells {
  readonly kind: 'cells';
  readonly key: string;
  /** Индексы клеток сетки (row-major), как их называет picking (REND-15). */
  readonly cells: readonly number[];
}

/** Сетка по визуальной поверхности; без прямоугольника — вся арена. */
export interface OverlayGrid {
  readonly kind: 'grid';
  readonly key: string;
  readonly x0?: number;
  readonly y0?: number;
  /** Включительно. */
  readonly x1?: number;
  readonly y1?: number;
}

export type OverlayItem = OverlayHighlight | OverlayGizmo | OverlayCells | OverlayGrid;

// ------------------------------------------------------------------ опции

/** Цвета наложений — настройка вьюпорта, а не норма: словарь видов закрыт, палитра нет. */
export interface OverlayColors {
  readonly highlight: number;
  readonly cells: number;
  readonly grid: number;
  readonly axisX: number;
  readonly axisY: number;
  readonly axisZ: number;
  readonly hovered: number;
  readonly active: number;
}

export const DEFAULT_COLORS: OverlayColors = {
  highlight: 0xffffff,
  cells: 0x9fd0ff,
  grid: 0x8fa0b0,
  axisX: 0xd05050,
  axisY: 0x50c050,
  axisZ: 0x5080d0,
  hovered: 0xffffff,
  active: 0xffe070,
};

export interface OverlayOptions {
  /** Визуальная поверхность (REND-9): на неё ложатся клетки и сетка. */
  readonly surface?: VisualSurfaceSource;
  /** Прокси инстансов — по ним рисуется подсветка в видимой позе (REND-16). */
  readonly instances?: InstanceProxySource;
  readonly colors?: Partial<OverlayColors>;
  /** Базовый размер ручек gizmo в мировых единицах; набор множит его своим `scale`. */
  readonly handleSize?: number;
  /** Подъём наложений над поверхностью, чтобы они не спорили с полом по глубине. */
  readonly lift?: number;
}

export const DEFAULT_HANDLE_SIZE = 1;
export const DEFAULT_LIFT = 0.02;

/** Наложение не изменилось — сценовые объекты пересобирать нечего. */
export function sameItem(a: OverlayItem, b: OverlayItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'highlight' && b.kind === 'highlight') {
    return a.entity === b.entity && (a.decoration ?? false) === (b.decoration ?? false);
  }
  if (a.kind === 'gizmo' && b.kind === 'gizmo') return sameGizmo(a, b);
  if (a.kind === 'cells' && b.kind === 'cells') {
    return a.cells.length === b.cells.length && a.cells.every((cell, i) => cell === b.cells[i]);
  }
  if (a.kind === 'grid' && b.kind === 'grid') {
    return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
  }
  return false;
}

/** Тот же gizmo: место, курс, масштаб и весь набор ручек в том же порядке. */
function sameGizmo(a: OverlayGizmo, b: OverlayGizmo): boolean {
  if (a.x !== b.x || a.y !== b.y || a.z !== b.z || (a.yaw ?? 0) !== (b.yaw ?? 0)) return false;
  if ((a.scale ?? 1) !== (b.scale ?? 1)) return false;
  if (a.handles.length !== b.handles.length) return false;
  return a.handles.every((handle, i) => sameHandle(handle, b.handles[i]));
}

/** Та же ручка: адрес, ось, форма и оба её состояния подсветки. */
function sameHandle(handle: OverlayHandle, other: OverlayHandle | undefined): boolean {
  if (other === undefined) return false;
  return (
    handle.id === other.id &&
    handle.axis === other.axis &&
    handle.form === other.form &&
    (handle.hovered ?? false) === (other.hovered ?? false) &&
    (handle.active ?? false) === (other.active ?? false)
  );
}
