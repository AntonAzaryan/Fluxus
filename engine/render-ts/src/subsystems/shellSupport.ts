/**
 * Общая опора подсистем-оболочек (REND-23, REND-24): чтение бита состояния,
 * поза оболочки в кадре и «сказать один раз».
 *
 * Подсистемы транзиентных эффектов и частиц остаются разными — у них разные
 * ассеты, разные конвейеры отрисовки и разные наборы оболочек, — но источники
 * они делят один-в-один (см. шапку `particles.ts`), и производное от источников
 * тоже: бит состояния расшифровывается ОДНИМ списком `stateComponents` сборки
 * (CAM-6, SHELL-2), а поза оболочки — той же интерполяцией двух доставленных
 * тиков и той же опорной высотой (REND-2, REND-7, REND-9). Второго ответа на
 * эти вопросы рендер не заводит, поэтому и кода здесь один.
 *
 * Тексты предупреждений остаются у вызывающих: требование, на которое ссылается
 * сообщение, у каждой подсистемы своё, а «эффект-оболочка» и «эмиттер» — разные
 * вещи для того, кто это предупреждение читает. Сам приём «сказать один раз» —
 * `warnOnce.ts`: им пользуется и камера, подсистемой не являющаяся.
 */
import type { EntityView } from '../types.js';
import type { VisualSurface } from '../visualSurface.js';

/**
 * Читатель бита состояния: несёт ли доставленное состояние сущности названное
 * состояние. Бит ищется в списке `stateComponents` сборки — том же, которым
 * Extractor их и зеркалировал (SHELL-2, CAM-6); имени вне списка соответствовать
 * нечему, и об этом говорится один раз, а не молча — текстом вызывающего.
 */
export function createStateReader(
  stateComponents: readonly string[],
  onUnmirrored: (name: string) => void,
): (view: EntityView, name: string) => boolean {
  return (view: EntityView, name: string): boolean => {
    const bit = stateComponents.indexOf(name);
    if (bit < 0) {
      onUnmirrored(name);
      return false;
    }
    return ((view.states >>> bit) & 1) === 1;
  };
}

/** Поза оболочки в кадре; переиспользуется — аллокаций на оболочку на кадр нет. */
export interface ShellPose {
  x: number;
  y: number;
  /** Опорная высота под оболочкой: поверхность либо ступень уровня. */
  base: number;
}

/** Переиспользуемая поза для одного места вызова. */
export function createShellPose(): ShellPose {
  return { x: 0, y: 0, base: 0 };
}

/**
 * Поза оболочки в кадре: горизонталь — интерполяция двух доставленных тиков
 * (REND-2), опорная высота — визуальная поверхность (REND-9), а без неё либо при
 * override уровня — ступень уровня (REND-7). Что подсистема добавит сверх
 * опорной высоты — подъём записи, дуга полёта (REND-12), — её дело.
 */
export function poseShell(
  view: EntityView,
  alpha: number,
  heightStep: number,
  surface: VisualSurface | null,
  out: ShellPose,
): void {
  const t = view.snap ? 1 : alpha;
  const x = view.prevX + (view.currX - view.prevX) * t;
  const y = view.prevY + (view.currY - view.prevY) * t;
  out.x = x;
  out.y = y;
  out.base =
    surface !== null && !view.levelOverride
      ? surface.heightAt(x, y)
      : (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
}
