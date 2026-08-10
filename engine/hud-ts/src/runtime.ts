/**
 * Исполнитель композиции HUD: связывает реестры, оверлей-хост, фасад действий
 * и подписку на доставку. Композиция — данные (HUD-4): `apply` монтирует
 * виджеты по записям, `subsystem` кормит их доставленным состоянием (HUD-5).
 * Смена значения композиции не трогает ни код виджетов, ни этот исполнитель —
 * меняется только план монтирования.
 *
 * Подписка — та же точка доставки, что у подсистем рендера (design Decision
 * 6): `remote.register(runtime.subsystem)`. События проигрываются только на
 * честных тиках (`freshEvents`, OBS-5) — при rewind/replay догоняющий реплей
 * не стреляет накопленной очередью повторно; каждая доставка несёт события,
 * накопленные с прошлой, поэтому «ровно один раз» держится конструктивно, а
 * не дедупликацией у виджетов (HUD-5).
 */
import type { HudActionsFacade } from './actions.js';
import type { HudComposition } from './composition.js';
import type { HudDeliveredEvent, HudDeliveredState, HudDeliverySubsystem } from './delivery.js';
import type { HudOverlayHost } from './host.js';
import { resolveComposition, type HudRegistry, type ResolvedHudBinding, type ResolvedHudEntry } from './registry.js';
import type { HudActionsPort, HudWidget } from './widget.js';

const NO_EVENTS: readonly HudDeliveredEvent[] = [];

export interface HudRuntimeOptions {
  readonly registry: HudRegistry;
  readonly host: HudOverlayHost;
  readonly actions: HudActionsFacade;
}

/** Смонтированная запись: экземпляр виджета, его элемент и план биндингов. */
interface MountedEntry {
  readonly widget: HudWidget;
  readonly element: Element;
  readonly bindings: readonly ResolvedHudBinding[];
}

export class HudRuntime {
  /**
   * Подписка на доставку — регистрируется в `RemoteHost.register` наравне с
   * подсистемами рендера (HUD-1): второй точки чтения у HUD нет.
   */
  readonly subsystem: HudDeliverySubsystem;

  private readonly options: HudRuntimeOptions;
  private mounted: MountedEntry[] = [];

  constructor(options: HudRuntimeOptions) {
    this.options = options;
    this.subsystem = {
      name: 'match-hud',
      init: () => {
        // Контекст рендера HUD не нужен: его сцена — DOM-оверлей (HUD-3).
      },
      syncTick: (view) => {
        this.deliver(view);
      },
      updateFrame: () => {
        // Покадровых анимаций у исполнителя нет: HUD живёт каденсом доставки
        // (HUD-5); анимации отдельного виджета — его частное дело.
      },
    };
  }

  /**
   * Применяет значение композиции: резолв целиком (ошибка — до монтирования),
   * снятие прежних виджетов, монтирование новых по зонам. Повторный вызов с
   * другим значением — «другой арене — другой HUD» (HUD-4).
   */
  apply(composition: HudComposition): void {
    const resolved = resolveComposition(this.options.registry, composition);
    this.clear();
    for (const entry of resolved.entries) {
      const widget = entry.kind.create(entry.params);
      const element = this.options.host.place(entry.zone, widget.mount(this.portFor(entry)));
      this.mounted.push({ widget, element, bindings: entry.bindings });
    }
  }

  /** Снимает все смонтированные виджеты; композиция становится пустой. */
  clear(): void {
    for (const entry of this.mounted) {
      entry.widget.dispose();
      this.options.host.remove(entry.element);
    }
    this.mounted = [];
  }

  /** Порт действий записи: слот → имя действия из композиции → фасад (HUD-2). */
  private portFor(entry: ResolvedHudEntry): HudActionsPort {
    const names = new Map(entry.actions.map((action) => [action.slot, action.name]));
    return {
      trigger: (slot, payload) => {
        const name = names.get(slot);
        if (name === undefined) {
          throw new Error(
            `виджет "${entry.source.widget}": слот действия "${slot}" не объявлен в композиции`,
          );
        }
        this.options.actions.dispatch(name, payload);
      },
    };
  }

  /** Одна доставка — одно обновление каждого виджета (HUD-5). */
  private deliver(view: HudDeliveredState): void {
    const events = view.freshEvents ? view.events : NO_EVENTS;
    for (const entry of this.mounted) {
      const values: Record<string, unknown> = {};
      for (const binding of entry.bindings) values[binding.slot] = binding.selector(view);
      entry.widget.update({
        tick: view.tick,
        mode: view.mode,
        snap: view.snapAll,
        values,
        events,
      });
    }
  }
}
