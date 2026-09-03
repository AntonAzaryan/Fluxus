/**
 * Вспышки подсистемы эффектов (REND-23) — эффекты, проигрывающие свою
 * длительность по часам КАДРА (SHELL-7) и уходящие в пул один раз.
 *
 * Вынесены из подсистемы по той же причине, что узлы и прогрев: «какие эффекты
 * существуют» и «как проигрывается момент» — разные вопросы. Оболочка живёт
 * доставленным состоянием и сводится набором (`shellSupport.ts`); вспышка живёт
 * своей длительностью и не сводится ни с чем.
 *
 * Своё у вспышки против оболочки — концы. Точка, второй конец луча и курс
 * фигуры фиксируются СПАВНОМ: вспышка есть образ момента мира, и двигаться ему
 * некуда — сущность-источник вправе не пережить тик своего события (REND-38).
 */
import type { VisualEffect } from '@fluxus/assets';
import type { TickView } from '../types.js';
import type { VisualSurface } from '../visualSurface.js';
import type { WarnOnce } from '../warnOnce.js';
import {
  eventAgeSeconds,
  eventEndOf,
  eventPointOf,
  eventYawOf,
  type EventPoint,
} from './shellSupport.js';
import type { EffectNode } from './effectNodes.js';
import { PRIMITIVE_BEAM, drawBeam, drawGround, isGroundPrimitive, radiusOf } from './effectDraw.js';

/** Длительность вспышки, если запись её не назвала: короткая, но видимая. */
const DEFAULT_FLASH_MS = 300;

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

/** Фаза жизни по кривой записи: `linear` как есть, `easeOut` — с замедлением. */
function curveOf(curve: string | undefined, t: number): number {
  if (curve === undefined || curve === CURVE_LINEAR) return t;
  if (curve === CURVE_EASE_OUT) return 1 - (1 - t) * (1 - t);
  return t;
}

/** Значение параметра по фазе: `from` → `to`, если конец назван. */
function lerpParam(from: number, to: number | undefined, phase: number): number {
  return to === undefined ? from : from + (to - from) * phase;
}

/** Вспышка: эффект, проигрывающий свою длительность по часам кадра. */
interface Flash {
  readonly node: EffectNode;
  readonly record: VisualEffect;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * Второй конец луча (REND-23) и опорная высота под ним. У вспышки концы
   * ФИКСИРУЮТСЯ спавном: она есть образ момента мира, и двигаться ему некуда —
   * сущность-источник вправе не пережить тик своего события.
   */
  readonly x2: number;
  readonly y2: number;
  readonly base2: number;
  /** Курс фигуры: наземный сектор и полоса развёрнуты им. */
  readonly yaw: number;
  /** Опорная высота под точкой вспышки — вход наземной фигуры (REND-43). */
  readonly base: number;
  /** Сколько миллисекунд кадров прожито; `durationMs` — конец жизни. */
  ageMs: number;
  readonly durationMs: number;
}

/**
 * Чем вспышка пользуется у подсистемы: её пул, её поверхность и её счётчик
 * кадра. Инжекцией, а не ссылкой на подсистему: набор вспышек о ней не знает.
 */
export interface FlashHooks {
  /** Узел под запись; null — примитив рендеру неизвестен (сказано один раз). */
  acquire(record: VisualEffect): EffectNode | null;
  release(node: EffectNode): void;
  /** Визуальная поверхность кадра; null — опорной высотой служит ноль (REND-7). */
  surface(): VisualSurface | null;
  /** Вершины фигуры, переписанные вспышкой, — в счёт кадра владельца (PERF-3). */
  countVertices(vertices: number): void;
  /**
   * Видна ли наземная фигура в этом кадре (REND-43): отсечённая вершин не
   * переписывает. Хуком владельца, потому что пирамида кадра принадлежит
   * подсистеме — у набора вспышек камеры нет и знать о ней ему нечего.
   */
  shapeVisible(record: VisualEffect, x: number, y: number, z: number, scale: number): boolean;
  readonly warnOnce: WarnOnce;
  /** Шаг симуляционного тика — знаменатель возраста события (SHELL-4). */
  readonly tickSeconds: number;
}

/** Набор проигрываемых вспышек: спавн, ход по часам кадра и гашение разрывом. */
export class FlashSet {
  private readonly hooks: FlashHooks;
  private flashes: Flash[] = [];
  /** Точка и второй конец разбираемого события: аллокаций на вспышку нет. */
  private readonly eventPoint: EventPoint = { x: 0, y: 0 };
  private readonly eventEnd: EventPoint = { x: 0, y: 0 };

  constructor(hooks: FlashHooks) {
    this.hooks = hooks;
  }

  get size(): number {
    return this.flashes.length;
  }

  /**
   * Вспышка по событию (REND-23). Точка — координатные поля события, уже
   * приведённые к float на входной границе рендера (REND-1, `eventData.ts`):
   * делить здесь нечего. Нет координат — берётся позиция сущности события, а
   * нет и её — играть вспышку негде, и об этом сказано один раз.
   *
   * Возраст СОБЫТИЯ (SHELL-4): доставка вправе привезти события нескольких
   * тиков, и вспышка стартует уже прожившей своё расстояние до тика доставки.
   * Отжившая к этому моменту не заводится вовсе — она уже кончилась в мире.
   */
  spawn(
    record: VisualEffect,
    type: string,
    data: Readonly<Record<string, number>>,
    tick: number | undefined,
    view: TickView,
  ): void {
    const durationMs = record.durationMs ?? DEFAULT_FLASH_MS;
    const ageMs = eventAgeSeconds(view, tick, this.hooks.tickSeconds) * 1000;
    if (durationMs > 0 && ageMs >= durationMs) return;
    const point = this.eventPoint;
    if (!eventPointOf(type, data, view, point, this.hooks.warnOnce, 'REND-23')) return;
    const x = point.x;
    const y = point.y;
    // Второй конец луча и курс фигуры — из полей того же события; вспышка есть
    // образ момента, и оба они фиксируются здесь (design D5).
    const end = this.eventEnd;
    const hasEnd = eventEndOf(data, view, end);
    if (record.primitive === PRIMITIVE_BEAM && !hasEnd) {
      // Луч по событию без цели — отрезок из точки в ту же точку: узел под него
      // не берётся вовсе, а несовпадение записи с событием названо один раз.
      this.hooks.warnOnce(
        `beam-target:${type}`,
        `render: событие "${type}" не несёт цели (target/other) — луч записи играть не из чего (REND-23)`,
      );
      return;
    }
    const node = this.hooks.acquire(record);
    if (node === null) return;
    const surface = this.hooks.surface();
    const base = surface === null ? 0 : surface.heightAt(x, y);
    const flash: Flash = {
      node,
      record,
      x,
      y,
      z: base + (record.height ?? 0),
      x2: hasEnd ? end.x : x,
      y2: hasEnd ? end.y : y,
      base2: hasEnd && surface !== null ? surface.heightAt(end.x, end.y) : base,
      yaw: hasEnd ? Math.atan2(end.y - y, end.x - x) : eventYawOf(data),
      base,
      ageMs,
      durationMs,
    };
    flash.node.mesh.position.set(x, y, flash.z);
    this.flashes.push(flash);
    this.applyPhase(flash, durationMs <= 0 ? 1 : ageMs / durationMs);
  }

  /**
   * Фаза жизни вспышек — по часам КАДРА (SHELL-7): доставки конвертов идут
   * своим темпом, а вспышка обязана дожить свою длительность и умереть один
   * раз. Отжившие возвращаются в пул тем же проходом.
   */
  advance(dt: number): void {
    if (this.flashes.length === 0) return;
    let alive = 0;
    for (const flash of this.flashes) {
      flash.ageMs += dt * 1000;
      const phase = flash.durationMs <= 0 ? 1 : flash.ageMs / flash.durationMs;
      if (phase >= 1) {
        this.hooks.release(flash.node);
        continue;
      }
      this.applyPhase(flash, phase);
      this.flashes[alive++] = flash;
    }
    this.flashes.length = alive;
  }

  dropAll(): void {
    for (const flash of this.flashes) this.hooks.release(flash.node);
    this.flashes.length = 0;
  }

  /**
   * Радиус и альфа по фазе жизни: `radius → radiusTo`, `alpha → alphaTo`. У
   * фигуры радиус живёт в вершинах, поэтому фаза переписывает их (REND-43):
   * растущее кольцо взрыва — та же анимация, что растущая сфера.
   */
  private applyPhase(flash: Flash, phase: number): void {
    const record = flash.record;
    const node = flash.node;
    const curved = curveOf(record.curve, phase);
    const size = lerpParam(radiusOf(record), record.radiusTo, curved);
    node.material.opacity = lerpParam(record.alpha ?? 1, record.alphaTo, curved);
    const shape = node.shape;
    if (shape === null) {
      node.mesh.scale.setScalar(size);
      return;
    }
    // Множитель, а не радиус: у полосы и луча размер живёт в длине и ширине, и
    // фаза обязана вести их тем же числом, что радиус круга.
    const own = radiusOf(record);
    const scale = own > 0 ? size / own : 1;
    if (isGroundPrimitive(record.primitive)) {
      if (!this.hooks.shapeVisible(record, flash.x, flash.y, flash.base, scale)) {
        // За кромкой кадра: вершины не переписываются, а жизнь вспышки идёт
        // своим ходом — вернувшись в кадр, она продолжится с той же фазы.
        node.mesh.visible = false;
        return;
      }
      node.mesh.visible = true;
      this.hooks.countVertices(shape.vertices);
      drawGround(
        shape,
        record,
        this.hooks.surface(),
        flash.x,
        flash.y,
        flash.yaw,
        scale,
        flash.base,
      );
      return;
    }
    this.hooks.countVertices(shape.vertices);
    const lift = record.height ?? 0;
    drawBeam(shape, record, flash.x, flash.y, flash.base + lift, flash.x2, flash.y2, flash.base2 + lift);
  }
}
