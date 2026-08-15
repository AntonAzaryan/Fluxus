/**
 * Исполнитель композиции HUD: связывает реестры, оверлей-хост, фасад действий
 * и подписку на доставку. Композиция — данные (HUD-4): `apply` монтирует
 * виджеты по записям, `subsystem` кормит их доставленным состоянием (HUD-5).
 * Смена значения композиции не трогает ни код виджетов, ни этот исполнитель —
 * меняется только план монтирования.
 *
 * Подписка — та же точка доставки, что у подсистем рендера (design Decision
 * 6): `remote.register(runtime.subsystem)`. «Ровно один раз» (HUD-5) держится
 * конструктивно, а не дедупликацией у виджетов, и на двух рубежах: аккумулятор
 * оболочки копит только события честных тиков (`sender.ts` client-ts) — конверт
 * реплеевых дубликатов не несёт; а `freshEvents` доставки гасит переэмиссии
 * нечестного прохода там, где события приезжают прямо из extractor'а без
 * аккумулятора (однопоточная сборка, OBS-5). Каждая доставка несёт события,
 * накопленные с прошлой, каждое со своим тиком.
 *
 * Жизненный цикл: ОДИН `HudRuntime` на всё время жизни `RemoteHost` — у
 * `PresentationStage.register` нет обратного `unregister`, поэтому подписка
 * `subsystem` регистрируется однажды и не снимается. Смена HUD («другой
 * арене — другой HUD») — это `apply()` с другим значением композиции (или
 * `clear()`), а не второй runtime: пересоздание исполнителя оставило бы в
 * сцене мёртвую подписку прежнего.
 */
import type { HudActionsFacade } from './actions.js';
import type { HudComposition } from './composition.js';
import type { HudDeliveredEvent, HudDeliveredState, HudDeliverySubsystem } from './delivery.js';
import type { HudNode } from './dom/node.js';
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
  /**
   * Последнее доставленное состояние — им немедленно кормятся виджеты свежей
   * композиции в `apply()`, не дожидаясь следующей доставки (HUD-5). Это
   * живой объект продюсера (см. `delivery.ts`): между доставками он не
   * меняется, к моменту `apply` равен последней доставке.
   */
  private lastDelivered: HudDeliveredState | null = null;

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
      updateFrame: (_dt, _alpha, realDt) => {
        // Покадровых анимаций у исполнителя нет: HUD живёт каденсом доставки
        // (HUD-5). Кадр он лишь ПЕРЕДАЁТ тем виджетам, которые о нём просили
        // (`HudWidget.frame`), — величинам самого главного потока вроде счётчика
        // кадров; мирового состояния в этом вызове нет и быть не может.
        //
        // Поэтому виджету уезжает `realDt`, а не `dt`: часы презентации несут
        // знак хода мира (REND-25) и в `Paused` стоят, а в `Rewinding` идут
        // назад. Счётчик кадров, которому подсунули такой интервал, замирает на
        // всё время заморозки и выдаёт всплеск на возобновлении — то есть врёт
        // о частоте кадров ровно тогда, когда её и смотрят. Мир при этом
        // виджету по-прежнему виден только доставкой (HUD-5).
        for (const entry of this.mounted) entry.widget.frame?.(realDt);
      },
    };
  }

  /**
   * Применяет значение композиции: резолв целиком (ошибка — до монтирования),
   * снятие прежних виджетов, монтирование новых по зонам. Повторный вызов с
   * другим значением — «другой арене — другой HUD» (HUD-4).
   *
   * Атомарно относительно отказов фабрик и `mount`: сначала все виджеты новой
   * композиции создаются и монтируются в отложенный план, и только когда все
   * удались — прежние снимаются и новые встают в зоны. Упавшая посередине
   * фабрика оставляет прежнюю композицию смонтированной и обновляемой;
   * частично созданные виджеты получают `dispose`, ошибка уходит вызывающему.
   *
   * Свежесмонтированные виджеты немедленно получают последнее доставленное
   * состояние (`snap: true` — монтирование для виджета разрыв, `events` пустые:
   * они уже обработаны прежней композицией, «ровно один раз» HUD-5) — HUD не
   * стоит пустым до следующей доставки.
   */
  apply(composition: HudComposition): void {
    const resolved = resolveComposition(this.options.registry, composition);

    // Отложенный план: создать и смонтировать всё до того, как трогать текущее.
    const created: HudWidget[] = [];
    const staged: { widget: HudWidget; node: HudNode; entry: ResolvedHudEntry }[] = [];
    try {
      for (const entry of resolved.entries) {
        const widget = entry.kind.create(entry.params);
        created.push(widget);
        staged.push({ widget, node: widget.mount(this.portFor(entry)), entry });
      }
    } catch (error) {
      for (const widget of created) widget.dispose();
      throw error;
    }

    this.clear();
    for (const item of staged) {
      const element = this.options.host.place(item.entry.zone, item.node);
      this.mounted.push({ widget: item.widget, element, bindings: item.entry.bindings });
    }

    const view = this.lastDelivered;
    if (view !== null) {
      for (const entry of this.mounted) this.update(entry, view, true, NO_EVENTS);
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
    this.lastDelivered = view;
    const events = view.freshEvents ? view.events : NO_EVENTS;
    for (const entry of this.mounted) this.update(entry, view, view.snapAll, events);
  }

  /** Обновление одного виджета: резолв селекторов записи и вызов `update`. */
  private update(
    entry: MountedEntry,
    view: HudDeliveredState,
    snap: boolean,
    events: readonly HudDeliveredEvent[],
  ): void {
    const values: Record<string, unknown> = {};
    for (const binding of entry.bindings) values[binding.slot] = binding.selector(view);
    entry.widget.update({
      tick: view.tick,
      mode: view.mode,
      snap,
      values,
      events,
    });
  }
}
