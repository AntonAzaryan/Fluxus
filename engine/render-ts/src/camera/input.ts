/**
 * Сэмпл ввода камеры за кадр и его сборка (CAM-1, CAM-2) — то, что хост
 * заполняет событиями окна и отдаёт `CameraRig.update`.
 *
 * Отдельно от самой камеры, потому что это её ВХОД, а не устройство: сэмпл
 * заполняет DOM-обвязка приложения, ничего о режимах камеры не зная, а рига в
 * этот момент может не быть вовсе (редактор строит его позже вьюпорта). Здесь
 * же живёт edge-pan: он переводит положение указателя в оси сэмпла и к решениям
 * камеры отношения не имеет.
 *
 * Ничто из этого не отправляется в симуляцию (CAM-1).
 */

/**
 * Сэмпл ввода камеры за кадр. Оси — [-1..1], дельты — в пикселях за кадр,
 * фронты (`*Tap`, `*Toggle`) взводятся событием и сбрасываются
 * `resetCameraInput` после `update`. Ничто из этого не отправляется в
 * симуляцию (CAM-1).
 */
export interface CameraInput {
  /** Клавиши панорамирования (стрелки), [-1..1]. */
  panX: number;
  panY: number;
  /** Панорамирование краем экрана, [-1..1]. */
  edgeX: number;
  edgeY: number;
  /** Drag средней кнопкой, px за кадр (положительный — контент тянут вправо/вверх). */
  dragDX: number;
  dragDY: number;
  /** Шаги колеса (+1 — отдалить); в fly управляет скоростью (CAM-4). */
  wheelSteps: number;
  /** Короткое нажатие клавиши центрирования (фронт). */
  centerTap: boolean;
  /** Клавиша центрирования удерживается. */
  centerHeld: boolean;
  /** Переключатель залипающего follow (фронт). */
  followToggle: boolean;
  /**
   * Явное открепление от follow-цели (фронт, CAM-8): переход в free-RTS без
   * движения точки наблюдения и без гашения разовых перелётов.
   *
   * Отдельный вход, а не побочное действие кадрирования: в follow точку
   * наблюдения каждый кадр переписывает цель, и кадрирование там инертно, — а
   * подделывать ради этого ввод панорамирования нельзя, потому что панорама
   * открепляет ЗАОДНО с движением камеры (CAM-2) и гасит те самые перелёты
   * (CAM-3), ради которых её и подделали бы.
   */
  detach: boolean;
  /** Переключатель fly-режима (фронт). */
  flyToggle: boolean;
  /** Fly: осмотр мышью, px за кадр. */
  lookDX: number;
  lookDY: number;
  /** Fly: перемещение [-1..1] — вбок, вперёд, вертикально. */
  moveX: number;
  moveY: number;
  moveZ: number;
}

export function createCameraInput(): CameraInput {
  return {
    panX: 0,
    panY: 0,
    edgeX: 0,
    edgeY: 0,
    dragDX: 0,
    dragDY: 0,
    wheelSteps: 0,
    centerTap: false,
    centerHeld: false,
    followToggle: false,
    detach: false,
    flyToggle: false,
    lookDX: 0,
    lookDY: 0,
    moveX: 0,
    moveY: 0,
    moveZ: 0,
  };
}

/** Сбрасывает фронты и накопленные дельты после `update`; оси-удержания не трогает. */
export function resetCameraInput(input: CameraInput): void {
  input.dragDX = 0;
  input.dragDY = 0;
  input.wheelSteps = 0;
  input.centerTap = false;
  input.followToggle = false;
  input.detach = false;
  input.flyToggle = false;
  input.lookDX = 0;
  input.lookDY = 0;
}

/** Зажим в отрезок — общая мера осей сэмпла: они живут в [-1, 1]. */
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Оси edge-pan — запись вызывающего: она заводится один раз, не на кадр. */
export interface EdgePanAxes {
  x: number;
  y: number;
}

export function createEdgePanAxes(): EdgePanAxes {
  return { x: 0, y: 0 };
}

/**
 * Запись по умолчанию — одна на модуль. Вызывающий, не давший своей, получает
 * ЕЁ, и результат валиден до следующего вызова: тот же контракт, что у
 * переиспользуемых записей рендера (`PickHit`, поза камеры). Своя запись нужна
 * тому, кто держит оси дольше одного выражения.
 */
const SHARED: EdgePanAxes = createEdgePanAxes();

/**
 * Edge-pan по положению указателя относительно прямоугольника канваса:
 * [-1..1] по осям, 0 вне зоны `margin` и за пределами прямоугольника.
 * Ось Y экранная (вниз) конвертируется в мировую (вверх).
 *
 * Пишет в запись и её же возвращает: функция зовётся каждым кадром сборки, и
 * свежий объектный литерал на кадр был бы аллокацией кадрового пути (REND-26) —
 * той самой, которую пул сэмпла ввода и заводился избежать. Запись без
 * аргумента общая (`SHARED`), и результат тогда валиден до следующего вызова.
 */
export function edgePanAxes(
  pointerX: number,
  pointerY: number,
  rect: { left: number; top: number; width: number; height: number },
  margin: number,
  out: EdgePanAxes = SHARED,
): EdgePanAxes {
  out.x = 0;
  out.y = 0;
  const px = pointerX - rect.left;
  const py = pointerY - rect.top;
  if (px < 0 || py < 0 || px > rect.width || py > rect.height || margin <= 0) return out;
  let x = 0;
  let y = 0;
  if (px < margin) x = px / margin - 1;
  else if (px > rect.width - margin) x = 1 - (rect.width - px) / margin;
  if (py < margin) y = 1 - py / margin;
  else if (py > rect.height - margin) y = (rect.height - py) / margin - 1;
  out.x = clamp(x, -1, 1);
  out.y = clamp(y, -1, 1);
  return out;
}
