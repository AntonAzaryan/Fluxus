/**
 * Подписка на доставку (задача 3.2, HUD-5): состояние — по каденсу доставки,
 * reliable-события — ровно один раз со своими тиками, признак разрыва — снап.
 * Сценарии спеки: «пять пропущенных тиков» и «перемотка».
 */
import { describe, expect, it } from 'vitest';
import {
  HudRegistry,
  entityStat,
  type HudComposition,
  type HudDeliveredEvent,
  type HudEntityView,
} from '../src/index.js';
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

describe('вытеснение событий наблюдаемо (SHELL-4, HUD-5)', () => {
  /** Стенд с биндингом на число вытесненных событий доставки. */
  function gapBench(): { widget: () => CaptureWidget; runtime: ReturnType<typeof makeRuntime>['runtime'] } {
    const created: CaptureWidget[] = [];
    const registry = new HudRegistry();
    registry.registerWidget(captureKind('statusPanel', created));
    registry.registerSelector('missedEvents', (state) => state.expiredEvents);
    const { runtime } = makeRuntime(registry);
    runtime.apply({
      entries: [{ widget: 'statusPanel', zone: 'top-left', bindings: { gap: 'missedEvents' } }],
    });
    return { widget: () => created[0]!, runtime };
  }

  it('число вытесненных с прошлой доставки событий видно селектору', () => {
    const { widget, runtime } = gapBench();
    // Вкладка была свёрнута: оболочка вытеснила 300 событий границей глубины
    // аккумулятора и сказала об этом ТОЙ ЖЕ доставкой (SHELL-4).
    runtime.subsystem.syncTick(makeView({ tick: 120, events: [], expiredEvents: 300 }));

    expect(widget().updates).toHaveLength(1);
    expect(widget().updates[0]!.values.gap).toBe(300);
  });

  it('ноль — это «ничего не вытеснено», а не «неизвестно»', () => {
    const { widget, runtime } = gapBench();
    runtime.subsystem.syncTick(makeView({ tick: 120, expiredEvents: 300 }));
    // Следующая доставка ничего не потеряла: разрыв показывать не на чем, и
    // прежнее число НЕ залипает — величина принадлежит доставке.
    runtime.subsystem.syncTick(makeView({ tick: 121 }));

    expect(widget().updates.map((update) => update.values.gap)).toEqual([300, 0]);
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

  it('пер-сущностный снап доходит до потребителя селектора', () => {
    const created: CaptureWidget[] = [];
    const registry = new HudRegistry();
    registry.registerWidget(captureKind('heroPanel', created));
    // Селектор отдаёт запись сущности целиком — виджет читает её поля сам.
    registry.registerSelector('hero', (state) => state.entities.get(1));
    const { runtime } = makeRuntime(registry);
    runtime.apply({
      entries: [{ widget: 'heroPanel', zone: 'left', bindings: { hero: 'hero' } }],
    });

    const heroAt = (snap: boolean): Map<number, HudEntityView> =>
      new Map([
        [1, { id: 1, kind: 'hero', currX: 2, currY: 3, currLevel: 0, snap, spawned: false, moving: false }],
      ]);
    runtime.subsystem.syncTick(makeView({ tick: 100, entities: heroAt(false) }));
    // Доставка после перемотки: запись сущности несёт пер-сущностный снап —
    // и он виден потребителю селектора, а не только полю snap всей доставки.
    runtime.subsystem.syncTick(
      makeView({ tick: 40, mode: 'Rewinding', snapAll: true, freshEvents: false, entities: heroAt(true) }),
    );

    const seen = created[0]!.updates.map((update) => (update.values.hero as HudEntityView).snap);
    expect(seen).toEqual([false, true]);
  });

  it('статы сущности видны селектору, скрытых сущностей в доставке нет (HUD-8, HUD-1)', () => {
    const created: CaptureWidget[] = [];
    const registry = new HudRegistry();
    registry.registerWidget(captureKind('heroPanel', created));
    registry.registerSelector('hero', (state) => state.entities.get(1));
    registry.registerSelector('enemy', (state) => state.entities.get(2));
    const { runtime } = makeRuntime(registry);
    runtime.apply({
      entries: [{ widget: 'heroPanel', zone: 'left', bindings: { hero: 'hero', enemy: 'enemy' } }],
    });

    const hero: HudEntityView = {
      id: 1,
      kind: 'hero',
      currX: 0,
      currY: 0,
      currLevel: 0,
      snap: false,
      spawned: false,
      moving: false,
      stats: new Map([['hp', 7]]),
    };
    runtime.subsystem.syncTick(
      makeView({ tick: 1, statNames: ['hp', 'hpMax'], entities: new Map([[1, hero]]) }),
    );

    const update = created[0]!.updates[0]!;
    expect(entityStat(update.values.hero as HudEntityView, 'hp')).toBe(7);
    // Объявленный, но не доехавший стат — «нет данных», а не ноль (HUD-8).
    expect(entityStat(update.values.hero as HudEntityView, 'hpMax')).toBeUndefined();
    // Сущность противника не доставлена (туман войны): статов у неё нет по
    // построению — утечь через них нечему (HUD-1).
    expect(entityStat(update.values.enemy as HudEntityView | undefined, 'hp')).toBeUndefined();
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
