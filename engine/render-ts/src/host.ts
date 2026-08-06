/**
 * RenderHost — рендер как внешний наблюдатель симуляции (REND-1) в
 * однопоточной сборке: `Extractor` и `ViewBuffer` соединены прямым вызовом.
 *
 * `onTick` — единственное место контакта с ядром: Extractor копирует минимум
 * из `TickResult` в плоскую форму (OBS-3, конверсия Q16.16 → float — REND-1),
 * ViewBuffer ведёт интерполяционный буфер, хост зовёт подсистемы. Та же пара,
 * разнесённая по потокам каналом оболочки, — воркер-сборка (`client-shell`
 * SHELL-2); подсистемы разницы не видят.
 *
 * Кадр отвязан от тика (REND-2): `frame(now)` считает альфу интерполяции и
 * зовёт подсистемы. Подсистемы (REND-8) вызываются строго в порядке
 * регистрации. Обратного канала нет: хост не вызывает ни одного мутирующего
 * API мира и не является зависимостью ядра.
 */
import { world, type EntityId, type TickObserver, type TickResult, type WorldState } from '@game-mvp/core';
import { Extractor } from './extractor.js';
import { ViewBuffer } from './viewBuffer.js';
import type { RenderContext, RenderHostConfig, RenderSubsystem, TickView } from './types.js';

/**
 * Резолвер визуального типа по тегам сущности: ядро не хранит имя prefab'а,
 * но теги prefab'а копируются на сущность при спавне. Кандидаты — ключи
 * манифеста визуалов (связь «манифест → sim-идентификатор», ASSET-6).
 */
export function kindByTags(
  kinds: readonly string[],
): (state: WorldState, entity: EntityId) => string | null {
  return (state, entity) => {
    for (const kind of kinds) {
      if (world.hasTag(state, entity, kind)) return kind;
    }
    return null;
  };
}

export class RenderHost implements TickObserver {
  readonly name = 'render';

  private readonly context: RenderContext;
  private readonly subsystems: RenderSubsystem[] = [];
  private readonly extractor: Extractor;
  private readonly buffer: ViewBuffer;

  constructor(context: RenderContext, config: RenderHostConfig) {
    this.context = context;
    this.extractor = new Extractor({
      kindOf: config.kindOf,
      ...(config.velocityComponent !== undefined
        ? { velocityComponent: config.velocityComponent }
        : {}),
      ...(config.moveEpsilon !== undefined ? { moveEpsilon: config.moveEpsilon } : {}),
      ...(config.terrainGrid !== undefined ? { terrainGrid: config.terrainGrid } : {}),
      ...(config.aimEvents !== undefined ? { aimEvents: config.aimEvents } : {}),
      ...(config.aimHoldTicks !== undefined ? { aimHoldTicks: config.aimHoldTicks } : {}),
      ...(config.stateComponents !== undefined
        ? { stateComponents: config.stateComponents }
        : {}),
    });
    this.buffer = new ViewBuffer({
      tickSeconds: config.tickSeconds,
      ...(config.snapDistance !== undefined ? { snapDistance: config.snapDistance } : {}),
      ...(config.terrainGrid !== undefined
        ? { floorBits: new Uint8Array(config.terrainGrid.floor) }
        : {}),
      ...(config.clock !== undefined ? { clock: config.clock } : {}),
    });
  }

  /** Presentation-состояние последнего тика; подсистемы получают его в syncTick. */
  get view(): TickView {
    return this.buffer.view;
  }

  /** Регистрирует подсистему; порядок регистрации = порядок вызовов (REND-8). */
  register(subsystem: RenderSubsystem): this {
    this.subsystems.push(subsystem);
    subsystem.init(this.context);
    return this;
  }

  onTick(result: TickResult): void {
    this.buffer.apply(this.extractor.extract(result));
    for (const subsystem of this.subsystems) subsystem.syncTick(this.buffer.view);
  }

  /**
   * Кадр: dt и альфа между двумя последними тиками, затем `updateFrame`
   * подсистем в порядке регистрации (REND-2, REND-8). `now` — миллисекунды
   * тех же часов, что `config.clock`.
   */
  frame(now?: number): void {
    const timing = now === undefined ? this.buffer.frame() : this.buffer.frame(now);
    if (timing === null) return;
    for (const subsystem of this.subsystems) subsystem.updateFrame(timing.dt, timing.alpha);
  }
}
