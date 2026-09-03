/**
 * Направление последнего каста сущности (`rendering` REND-5) — память ПО
 * СОБЫТИЯМ тика, живущая рядом с извлечением, но не его частью: событий,
 * которыми доворачивается торс, экстрактор не знает — их называет конфигурация
 * сборки (`aimEvents`), а сроком годности управляет она же (`aimHoldTicks`).
 *
 * Врозь с `Extractor` потому, что это отдельное владение: словарь по сущностям,
 * своя политика устаревания и свои конвенции полей события. Экстрактор кладёт
 * в колонку `aimYaw` то, что помнит этот словарь, и чистит его вместе со своими
 * кэшами на смене ветви истории (NTR-16).
 */
import { FIXED_ONE, POSITION_COMPONENT, world, type EntityId, type WorldState } from '@fluxus/core';
import type { RenderEvent } from './types.js';

/** Направление каста держится ~0.75 с при 60 тиках, дальше торс возвращается к движению. */
export const DEFAULT_AIM_HOLD_TICKS = 45;

export class AimTracker {
  private readonly events: ReadonlySet<string>;
  private readonly holdTicks: number;
  /** Направление последнего каста сущности и тик, на котором оно поставлено. */
  private readonly entries = new Map<EntityId, { yaw: number; tick: number }>();

  constructor(events: readonly string[], holdTicks: number) {
    this.events = new Set(events);
    this.holdTicks = holdTicks;
  }

  /**
   * Направление каста сущности на этом тике; `NaN` — цели нет либо она
   * протухла. `NaN`, а не отсутствие: так плоская форма выражает «значения
   * нет» во всех своих колонках (SHELL-3).
   */
  yawOf(entity: EntityId, tick: number): number {
    const entry = this.entries.get(entity);
    return entry !== undefined && tick - entry.tick <= this.holdTicks ? entry.yaw : Number.NaN;
  }

  /** Сущность ушла из доставки — её направление больше не нужно. */
  forget(entity: EntityId): void {
    this.entries.delete(entity);
  }

  /** Смена ветви истории: за стёртой ветвью id принадлежит другой сущности. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Направление атаки/каста для bone-контроля (REND-5) из событий тика.
   * Конвенции полей события: `entity`/`source` — кастующий (EVENT_ENTITY_FIELDS
   * ядра); направление — `dirX`/`dirY` (вектор), иначе `x`/`y` (точка мира),
   * иначе `target` (сущность — берём её позицию).
   *
   * Координаты события здесь УЖЕ float: события приезжают сюда после
   * `copyEvents`, то есть за входной границей (REND-1). Делится на `FIXED_ONE`
   * только читаемое прямо из мира — позиции сущностей.
   */
  capture(state: WorldState, tick: number, events: readonly RenderEvent[]): void {
    for (const event of events) {
      if (!this.events.has(event.type)) continue;
      const caster = event.data.entity ?? event.data.source;
      if (caster === undefined) continue;
      if (!world.isAlive(state, caster) || !world.hasComponent(state, caster, POSITION_COMPONENT)) {
        continue;
      }
      const yaw = this.yawFromEvent(state, event, caster);
      if (yaw === null) continue;
      const entry = this.entries.get(caster);
      if (entry === undefined) {
        this.entries.set(caster, { yaw, tick });
      } else {
        entry.yaw = yaw;
        entry.tick = tick;
      }
    }
  }

  private yawFromEvent(state: WorldState, event: RenderEvent, caster: EntityId): number | null {
    const dirX = event.data.dirX;
    const dirY = event.data.dirY;
    if (dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0)) {
      return Math.atan2(dirY, dirX);
    }
    const cx = world.getField(state, caster, POSITION_COMPONENT, 'x') / FIXED_ONE;
    const cy = world.getField(state, caster, POSITION_COMPONENT, 'y') / FIXED_ONE;
    const px = event.data.x;
    const py = event.data.y;
    if (px !== undefined && py !== undefined) {
      return Math.atan2(py - cy, px - cx);
    }
    const target = event.data.target;
    if (
      target !== undefined &&
      world.isAlive(state, target) &&
      world.hasComponent(state, target, POSITION_COMPONENT)
    ) {
      const tx = world.getField(state, target, POSITION_COMPONENT, 'x') / FIXED_ONE;
      const ty = world.getField(state, target, POSITION_COMPONENT, 'y') / FIXED_ONE;
      return Math.atan2(ty - cy, tx - cx);
    }
    return null;
  }
}
