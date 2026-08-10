/**
 * Единый интерфейс виджета и сменяемость композиции (задача 2.3, HUD-4,
 * сценарий «другой арене — другой HUD»): меняется только значение композиции —
 * код виджета и исполнитель не правятся.
 */
import { describe, expect, it } from 'vitest';
import { HudRegistry, type HudComposition } from '../src/index.js';
import { captureKind, makeRuntime, makeView, type CaptureWidget } from './support/hud.js';

/** Один и тот же вид виджета — «код виджета» — на обе арены. */
function bench(): { created: CaptureWidget[]; registry: HudRegistry } {
  const created: CaptureWidget[] = [];
  const registry = new HudRegistry();
  registry.registerWidget(captureKind('statusPanel', created));
  registry.registerSelector('tickNumber', (state) => state.tick);
  registry.registerSelector('entityCount', (state) => state.entities.size);
  return { created, registry };
}

const arenaA: HudComposition = {
  entries: [{ widget: 'statusPanel', zone: 'top-left', bindings: { value: 'tickNumber' } }],
};

/** Другая арена: другой набор панелей, зон и биндингов — то же значение-форма. */
const arenaB: HudComposition = {
  entries: [
    {
      widget: 'statusPanel',
      zone: 'bottom-right',
      params: { compact: true },
      bindings: { value: 'entityCount' },
    },
    { widget: 'statusPanel', zone: 'top', bindings: { value: 'tickNumber' } },
  ],
};

describe('другой арене — другой HUD (HUD-4)', () => {
  it('смена значения композиции пересобирает HUD без правки кода виджета', () => {
    const { created, registry } = bench();
    const { runtime, host } = makeRuntime(registry);
    const view = makeView({
      tick: 7,
      entities: new Map([
        [1, { id: 1, kind: 'hero', currX: 0, currY: 0, currLevel: 0, snap: false, spawned: false, moving: false }],
        [2, { id: 2, kind: 'creep', currX: 1, currY: 1, currLevel: 0, snap: false, spawned: false, moving: true }],
      ]),
    });

    runtime.apply(arenaA);
    runtime.subsystem.syncTick(view);
    expect(created).toHaveLength(1);
    expect(created[0]!.updates[0]!.values).toEqual({ value: 7 });

    runtime.apply(arenaB);
    // Прежний виджет снят и его элемент убран из зоны.
    expect(created[0]!.disposed).toBe(true);
    expect((host.zone('top-left') as unknown as { childElements: unknown[] }).childElements).toHaveLength(0);

    runtime.subsystem.syncTick(view);
    expect(created).toHaveLength(3);
    // Тот же вид виджета читает другой селектор и другие параметры — по данным.
    expect(created[1]!.params).toEqual({ compact: true });
    expect(created[1]!.updates[0]!.values).toEqual({ value: 2 });
    expect(created[2]!.updates[0]!.values).toEqual({ value: 7 });
    expect((host.zone('bottom-right') as unknown as { childElements: unknown[] }).childElements).toHaveLength(1);
    expect((host.zone('top') as unknown as { childElements: unknown[] }).childElements).toHaveLength(1);
  });

  it('clear снимает все виджеты', () => {
    const { created, registry } = bench();
    const { runtime } = makeRuntime(registry);
    runtime.apply(arenaA);
    runtime.clear();
    expect(created[0]!.disposed).toBe(true);
    runtime.subsystem.syncTick(makeView({ tick: 1 }));
    expect(created[0]!.updates).toHaveLength(0);
  });

  it('слот действия вне композиции — ошибка с именем слота', () => {
    const { created, registry } = bench();
    const { runtime } = makeRuntime(registry);
    runtime.apply(arenaA);
    expect(() => { created[0]!.port!.trigger('cast'); }).toThrow('слот действия "cast" не объявлен');
  });
});
