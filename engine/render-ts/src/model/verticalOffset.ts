/**
 * Вертикальное смещение инстанса (REND-12): дуги движения и снижение при
 * провале. Непрерывной вертикали в симуляции нет (PHYS-1, LOC-5) — высота над
 * визуальной поверхностью целиком принадлежит рендеру, а числа приходят из
 * манифеста визуалов (ASSET-6).
 *
 * Здесь только математика: ни THREE, ни состояния инстанса.
 */

/**
 * Дуга по фазе: парабола `4·p·(1−p)·h` — ноль на концах, максимум `h` в
 * середине. `NaN` (фазы нет) и отсутствие высоты дают ноль, поэтому вход в
 * манёвр и выход из него не требуют особых случаев на вызывающем: он просто
 * смешивает вклады двух тиков.
 *
 * Форма одна на все дуги REND-12 — прыжок, наземный манёвр, полёт снаряда:
 * различаются они ВЫСОТОЙ, которую называет запись манифеста на свой вид, и
 * ФАЗОЙ, которую подставляет вызывающий. Второй реализации этой параболы в
 * репозитории нет и заводить её незачем.
 */
export function jumpArc(phase: number, height: number): number {
  if (!Number.isFinite(phase) || height <= 0) return 0;
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  return 4 * p * (1 - p) * height;
}

/** Концы манёвра в мировых координатах — вход опорных высот прыжка (REND-12). */
export interface ManeuverEnds {
  takeoffX: number;
  takeoffY: number;
  landingX: number;
  landingY: number;
}

/**
 * Концы манёвра, выведенные из данных тика (REND-12): движение в `Airborne`
 * равномерно (LOC-3), поэтому по перемещению за тик `stepX/stepY` и шагу фазы
 * за тик `phaseStep` восстанавливаются обе точки — назад на `phase / phaseStep`
 * тиков и вперёд на `(1 − phase) / phaseStep`.
 *
 * Вырожденный вход — нефинитная фаза, неположительный шаг фазы (в том числе
 * схлопнутая интерполяция после разрыва непрерывности, REND-2), нефинитное
 * перемещение — схлопывает оба конца в текущую позицию: выводить траекторию
 * не из чего, и инстанс остаётся на опорной высоте под собой.
 *
 * Пишет в `out` и возвращает его — на кадр не аллоцирует.
 */
export function maneuverEnds(
  x: number,
  y: number,
  stepX: number,
  stepY: number,
  phase: number,
  phaseStep: number,
  out: ManeuverEnds,
): ManeuverEnds {
  out.takeoffX = x;
  out.takeoffY = y;
  out.landingX = x;
  out.landingY = y;
  if (!Number.isFinite(phase) || !Number.isFinite(stepX) || !Number.isFinite(stepY)) return out;
  if (!Number.isFinite(phaseStep) || phaseStep <= 0) return out;
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  const elapsed = p / phaseStep;
  const remaining = (1 - p) / phaseStep;
  out.takeoffX = x - stepX * elapsed;
  out.takeoffY = y - stepY * elapsed;
  out.landingX = x + stepX * remaining;
  out.landingY = y + stepY * remaining;
  return out;
}

/**
 * Основание прыжка (REND-12): переход от опорной высоты отрыва к опорной
 * высоте приземления по фазе манёвра. Дуга кладётся поверх него, так что
 * траектория остаётся параболой — просто над наклонной.
 */
export function jumpBase(takeoffHeight: number, landingHeight: number, phase: number): number {
  if (!Number.isFinite(phase)) return landingHeight;
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  return takeoffHeight + (landingHeight - takeoffHeight) * p;
}

/**
 * Шаг снижения при провале: смещение уходит вниз со скоростью `speed` и
 * упирается в `−depth`, где и удерживается — что случится с провалившейся
 * сущностью дальше, решает геймплейная система (ARENA-5), и рендер её решения
 * не предвосхищает. Возвращает новое смещение (всегда <= 0).
 */
export function advanceFall(offset: number, speed: number, depth: number, dt: number): number {
  if (depth <= 0 || speed <= 0) return 0;
  const next = offset - speed * dt;
  return next < -depth ? -depth : next;
}
