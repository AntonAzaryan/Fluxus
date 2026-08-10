/**
 * Подписка на доставку (задача 3.2, HUD-5): состояние — по каденсу доставки,
 * reliable-события — ровно один раз со своими тиками, признак разрыва — снап.
 * Сценарии спеки: «пять пропущенных тиков» и «перемотка».
 */
import { describe, expect, it } from 'vitest';
import { HudRegistry, type HudComposition, type HudDeliveredEvent } from '../src/index.js';
import { captureKind, makeRuntime, makeView, type CaptureWidget } from './support/hud.js';

const composition: HudComposition = {
  entries: [{ widget: 'statusPanel', zone: 'top-left', bindings: { tick: 'tickNumber' } }],
};

function bench(): { widget: () => CaptureWidget; runtime: ReturnType<typeof makeRuntime>['runtime'] } {
  const created: CaptureWidget[] = [];
  const registry = new HudRegistry();
  registry.registerWidget(captureKind('statusPanel', created));
  registry.registerSelector('tickNumber', (state) => state.tick);
  const { runtime } = makeRuntime(registry);
  runtime.apply(composition);
  return { widget: () => created[0]!, runtime };
}

describe('пять пропущенных тиков (HUD-5)', () => {
  it('одна доставка: индикаторы — состояние последнего тика, событие — ровно один раз со своим тиком', () => {
    const { widget, runtime } = bench();
    // Main был занят пять тиков; в третьем произошло убийство. Оболочка
    // конфлатировала состояние (SHELL-4): приезжает один конверт с состоянием
    // тика 5 и накопленными reliable-событиями.
    const kill: HudDeliveredEvent = { type: 'kill', tick: 3, data: { target: 2 } };
    runtime.subsystem.syncTick(makeView({ tick: 5, events: [kill] }));

    expect(widget().updates).toHaveLength(1);
    const update = widget().updates[0]!;
    expect(update.values.tick).toBe(5); // состояние — последний тик, вытесненные не нужны
    expect(update.events).toEqual([kill]); // событие вытесненного тика — со своим номером

    // Следующая доставка событий не несёт: эффект не проигрывается второй раз.
    runtime.subsystem.syncTick(makeView({ tick: 6 }));
    const killCount = widget()
      .updates.flatMap((u) => u.events)
      .filter((event) => event.type === 'kill').length;
    expect(killCount).toBe(1);
  });

  it('обновлений ровно столько, сколько доставок: каденс — доставки, не тики', () => {
    const { widget, runtime } = bench();
    runtime.subsystem.syncTick(makeView({ tick: 5 }));
    runtime.subsystem.syncTick(makeView({ tick: 10 }));
    expect(widget().updates.map((u) => u.tick)).toEqual([5, 10]);
  });
});

describe('перемотка (HUD-5)', () => {
  it('признак разрыва доходит до виджетов снапом', () => {
    const { widget, runtime } = bench();
    runtime.subsystem.syncTick(makeView({ tick: 100 }));
    expect(widget().updates[0]!.snap).toBe(false);

    // Перемотка: доставленное состояние несёт признак разрыва (SHELL-7).
    runtime.subsystem.syncTick(makeView({ tick: 40, mode: 'Rewinding', snapAll: true, freshEvents: false }));
    const update = widget().updates[1]!;
    expect(update.snap).toBe(true);
    expect(update.mode).toBe('Rewinding');
  });

  it('нечестный проход (freshEvents=false) не проигрывает события повторно', () => {
    const { widget, runtime } = bench();
    // Догоняющий реплей везёт события уже сыгранных тиков: аккумулятор
    // оболочки помечает конверт нечестным (OBS-5), HUD их не проигрывает.
    runtime.subsystem.syncTick(
      makeView({
        tick: 41,
        snapAll: true,
        freshEvents: false,
        events: [{ type: 'kill', tick: 41, data: {} }],
      }),
    );
    expect(widget().updates[0]!.events).toEqual([]);
  });
});
