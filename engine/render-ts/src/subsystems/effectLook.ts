/**
 * Как выглядит оболочка эффекта в кадре (REND-23): её размер, цвет и альфа —
 * и ничего о том, где она стоит и какие оболочки существуют.
 *
 * Вынесено из подсистемы по той же причине, что узлы, вспышки и прогрев: «чем
 * эффект нарисован» и «какие эффекты существуют» — разные вопросы. Здесь —
 * ровно перевод ЗАПИСИ и доставленного стата (`match-hud` HUD-8) в три числа
 * материала и меша.
 *
 * Часы презентации приходят параметром, а не полем: мигание — величина
 * периодическая, и владеет ею подсистема (REND-25), которой они и принадлежат.
 */
import type { VisualEffect } from '@fluxus/assets';
import type { EntityView } from '../types.js';
import type { EffectNode } from './effectNodes.js';
import { radiusOf } from './effectDraw.js';
import type { Shell } from './shellSupport.js';

/**
 * Оболочка эффекта: узел пула плюс запись, которой он нарисован. Своего сверх
 * общей оболочки (`shellSupport.ts`) у неё одно поле — взят ли второй цвет
 * порога: `Color.set` разбирает строку, и звать его каждый кадр на каждую
 * оболочку значило бы аллоцировать пропорционально числу эффектов (REND-26).
 */
export interface EffectShell extends Shell<VisualEffect, EffectNode> {
  colorAtTaken: boolean;
}

/**
 * Фаза окна стата записи (REND-23): доля пройденного окна `radiusFromStat`,
 * зажатая в [0..1]. `NaN` — вести нечем: стата в доставленном состоянии нет.
 */
function statPhase(record: VisualEffect, view: EntityView): number {
  const range = record.radiusFromStat;
  if (range === undefined) return Number.NaN;
  const value = view.stats?.get(range.stat);
  if (value === undefined) return Number.NaN;
  const min = range.min ?? 0;
  const span = range.max - min;
  if (!(span > 0)) return Number.NaN;
  const t = (value - min) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Тёмная половина цикла мигания по часам презентации подсистемы (REND-25).
 * Общая точка: с окном стата это предупреждение о передержке, без окна — пульс
 * луча и ленты, и цикл у них один и тот же.
 */
function blinkDark(clockMs: number, periodMs: number): boolean {
  return periodMs > 0 && Math.floor(clockMs / (periodMs / 2)) % 2 === 0;
}

/**
 * Альфа записи под пульсом: запись БЕЗ окна стата, назвавшая мигание,
 * пульсирует всегда — так живёт луч и лента (REND-23).
 */
function pulsed(record: VisualEffect, alpha: number, clockMs: number): number {
  const blink = record.blink;
  // С окном стата мигание принадлежит ЕГО концу (передержка), и запись без
  // доехавшего стата рисуется числами записи без ведения — в том числе без
  // мигания: выдумывать передержку там, где величины нет, рендер не вправе.
  if (blink === undefined || record.radiusFromStat !== undefined) return alpha;
  return blinkDark(clockMs, blink.periodMs) ? alpha * blink.alpha : alpha;
}

/**
 * Второй цвет порога — только на СМЕНЕ состояния: `Color.set` разбирает строку,
 * и вызов на каждую оболочку каждого кадра аллоцировал бы пропорционально числу
 * эффектов (REND-26).
 */
function applyColorAt(shell: EffectShell, taken: boolean): void {
  if (taken === shell.colorAtTaken) return;
  shell.colorAtTaken = taken;
  const color = taken ? shell.record.colorAt?.color : undefined;
  shell.instance.material.color.set(color ?? shell.record.color);
}

/**
 * Размер, цвет и альфа оболочки в кадре (REND-23). Масштаб размещения
 * (REND-11, REND-18) учитывается наравне с эмиттером частиц: у размера
 * изображения сущности один ответ, а не два разных у двух подсистем.
 *
 * Ведение статом (`radiusFromStat`) правит те же три числа фазой окна: радиус —
 * множителем, цвет — порогом `colorAt`, альфа — миганием за концом окна. Стата
 * в доставленном состоянии нет — оболочка рисуется числами записи без ведения:
 * выдумывать значение рендер не вправе.
 *
 * Возвращает множитель размера кадра: сфере он уже записан в масштаб меша, а
 * фигуре нужен позже — её размер живёт в мировых вершинах (REND-43).
 */
export function applyShellLook(shell: EffectShell, clockMs: number): number {
  const record = shell.record;
  const node = shell.instance;
  const placement = shell.view.scale ?? 1;
  const alpha = record.alpha ?? 1;
  const phase = statPhase(record, shell.view);
  if (Number.isNaN(phase)) {
    if (node.shape === null) node.mesh.scale.setScalar(radiusOf(record) * placement);
    node.material.opacity = pulsed(record, alpha, clockMs);
    applyColorAt(shell, false);
    return placement;
  }
  const range = record.radiusFromStat!;
  const from = range.from ?? 1;
  const scale = (from + (range.to - from) * phase) * placement;
  // Сфере множитель идёт в масштаб меша, фигуре — в её мировые вершины.
  if (node.shape === null) node.mesh.scale.setScalar(radiusOf(record) * scale);
  const colorAt = record.colorAt;
  applyColorAt(shell, colorAt !== undefined && phase >= colorAt.phase);
  // Мигание — ЗА концом окна: заряд перезрел и рванёт в самом кастере.
  const blink = record.blink;
  const value = shell.view.stats?.get(range.stat) ?? 0;
  const overcharged = blink !== undefined && value >= range.max;
  const dark = overcharged && blinkDark(clockMs, blink.periodMs);
  node.material.opacity = dark ? alpha * blink.alpha : alpha;
  return scale;
}
