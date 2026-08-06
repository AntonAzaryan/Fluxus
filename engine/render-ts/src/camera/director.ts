/**
 * Диспетчер эффектов камеры (CAM-6): связывает данные симуляции со стеком
 * эффектов по таблицам манифеста визуалов (ASSET-8). Механизм — типы
 * эффектов в коде (`effects.ts`); политика — какие события и состояния их
 * вызывают и с какими числами — только манифест.
 *
 * Импульсные эффекты — от событий тика; срабатывают только на «честных»
 * тиках (`freshEvents`): при rewind/replay догоняющий реплей не стреляет
 * очередью накопленных тряск (CAM-5, CAM-6). Длящиеся — от присутствия
 * состояния на сущности-цели в снапшоте (`EntityView.states`).
 */
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import type { CameraEffectDef, CameraEffectsSection } from '@game-mvp/assets';
import type { TickView } from '../types.js';
import { EffectStack, SwayEffect, TraumaShake, type CameraEffect } from './effects.js';

export interface CameraEffectsDirectorOptions {
  /** Таблицы «событие/состояние → эффект» из манифеста (ASSET-8). */
  readonly tables?: CameraEffectsSection | undefined;
  /**
   * Упорядоченный список компонент-состояний, зеркалируемых в
   * `EntityView.states` (конфиг Extractor'а той же сборки): имя из таблицы
   * `states` манифеста ищется в этом списке.
   */
  readonly stateComponents?: readonly string[];
  readonly stack?: EffectStack;
  /** Канал предупреждений; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/** Числовой параметр записи манифеста с дефолтом типа эффекта. */
function num(def: CameraEffectDef, key: string, fallback: number): number {
  const value = def[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class CameraEffectsDirector {
  readonly stack: EffectStack;

  private readonly tables: CameraEffectsSection;
  private readonly stateComponents: readonly string[];
  private readonly warn: (message: string) => void;
  /** Инстансы эффектов по ключу записи; создаются лениво и живут в стеке. */
  private readonly shakes = new Map<string, TraumaShake>();
  private readonly sways = new Map<string, SwayEffect>();
  /** Предупреждение на запись — один раз (ASSET-8). */
  private readonly warned = new Set<string>();

  constructor(options: CameraEffectsDirectorOptions = {}) {
    this.tables = options.tables ?? {};
    this.stateComponents = options.stateComponents ?? [];
    this.stack = options.stack ?? new EffectStack();
    this.warn =
      options.warn ??
      ((message: string): void => {
        console.warn(message);
      });
  }

  /**
   * Синхронизация с тиком: события → импульсы, состояния цели → длящиеся.
   * `focusX/focusY` — точка наблюдения камеры, центр затухания по
   * расстоянию (CAM-6).
   */
  onTick(view: TickView, focusX: number, focusY: number, targetId: EntityId | null): void {
    // Множитель 0 — полное отключение: события и состояния игнорируются (CAM-6).
    if (this.stack.multiplier === 0) return;
    this.applyImpulses(view, focusX, focusY);
    this.applyStates(view, targetId);
  }

  private applyImpulses(view: TickView, focusX: number, focusY: number): void {
    const events = this.tables.events;
    if (events === undefined || !view.freshEvents) return;
    for (const event of view.events) {
      const def = events[event.type];
      if (def === undefined) continue;
      if (def.effect !== 'shake') {
        this.warnOnce(
          `event:${event.type}`,
          `камера: импульсный эффект "${def.effect}" (событие "${event.type}") неизвестен — запись пропущена`,
        );
        continue;
      }
      const shake = this.shakeFor(`event:${event.type}`, def);
      shake.addTrauma(num(def, 'amplitude', 0.6) * this.falloff(view, event.data, focusX, focusY, def));
    }
  }

  private applyStates(view: TickView, targetId: EntityId | null): void {
    const states = this.tables.states;
    if (states === undefined) return;
    const target = targetId === null ? undefined : view.entities.get(targetId);
    for (const [component, def] of Object.entries(states)) {
      if (def.effect !== 'sway') {
        this.warnOnce(
          `state:${component}`,
          `камера: длящийся эффект "${def.effect}" (состояние "${component}") неизвестен — запись пропущена`,
        );
        continue;
      }
      const bit = this.stateComponents.indexOf(component);
      if (bit < 0) {
        this.warnOnce(
          `state-bit:${component}`,
          `камера: состояние "${component}" не зеркалируется Extractor'ом (stateComponents) — эффект не активируется`,
        );
        continue;
      }
      const active = target !== undefined && ((target.states >>> bit) & 1) === 1;
      this.swayFor(`state:${component}`, def).setActive(active);
    }
  }

  /**
   * Ослабление импульса расстоянием от точки наблюдения (CAM-6): позиция
   * события — поля `x`/`y` (Q16.16), иначе позиция сущности `entity`/`source`
   * из снапшота, иначе — без ослабления. `radius` — параметр записи.
   */
  private falloff(
    view: TickView,
    data: Readonly<Record<string, number>>,
    focusX: number,
    focusY: number,
    def: CameraEffectDef,
  ): number {
    const radius = num(def, 'radius', Number.POSITIVE_INFINITY);
    if (!Number.isFinite(radius) || radius <= 0) return 1;
    let x: number | null = null;
    let y: number | null = null;
    if (data['x'] !== undefined && data['y'] !== undefined) {
      x = data['x'] / FIXED_ONE;
      y = data['y'] / FIXED_ONE;
    } else {
      const source = data['entity'] ?? data['source'];
      const entity = source === undefined ? undefined : view.entities.get(source);
      if (entity !== undefined) {
        x = entity.currX;
        y = entity.currY;
      }
    }
    if (x === null || y === null) return 1;
    const distance = Math.hypot(x - focusX, y - focusY);
    return Math.min(Math.max(1 - distance / radius, 0), 1);
  }

  private shakeFor(key: string, def: CameraEffectDef): TraumaShake {
    let shake = this.shakes.get(key);
    if (shake === undefined) {
      shake = new TraumaShake({
        frequency: num(def, 'frequency', 13),
        maxOffset: num(def, 'maxOffset', 0.35),
        maxRoll: num(def, 'maxRoll', 0.05),
        decay: num(def, 'decay', 1.4),
      });
      this.shakes.set(key, shake);
      this.register(shake);
    }
    return shake;
  }

  private swayFor(key: string, def: CameraEffectDef): SwayEffect {
    let sway = this.sways.get(key);
    if (sway === undefined) {
      sway = new SwayEffect({
        rollAmp: num(def, 'rollAmp', 0.05),
        yawAmp: num(def, 'yawAmp', 0.02),
        fovAmp: num(def, 'fovAmp', 2.5),
        frequency: num(def, 'frequency', 0.9),
        fadeSeconds: num(def, 'fadeSeconds', 1.2),
      });
      this.sways.set(key, sway);
      this.register(sway);
    }
    return sway;
  }

  private register(effect: CameraEffect): void {
    this.stack.add(effect);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}
