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
import { anchorEntityOf, type HudAnchorSource } from './anchors.js';
import type { HudComposition, HudWorldAnchor } from './composition.js';
import type {
  HudDeliveredEvent,
  HudDeliveredState,
  HudDeliverySubsystem,
  HudPauseState,
} from './delivery.js';
import type { HudNode } from './dom/node.js';
import type { HudOverlayHost } from './host.js';
import { resolveComposition, type HudRegistry, type ResolvedHudBinding, type ResolvedHudEntry } from './registry.js';
import type { HudActionsPort, HudWidget } from './widget.js';

const NO_EVENTS: readonly HudDeliveredEvent[] = [];

export interface HudRuntimeOptions {
  readonly registry: HudRegistry;
  readonly host: HudOverlayHost;
  readonly actions: HudActionsFacade;
  /**
   * Источник мировых якорей (HUD-10) — то, что публикует рендер (`rendering`
   * REND-41). Нет источника — якорные виджеты монтируются скрытыми: HUD без
   * рендера (тест, headless-прогон) обязан собираться, а не отказывать.
   */
  readonly anchors?: HudAnchorSource;
}

/** Смонтированная запись: экземпляр виджета, его элемент и план биндингов. */
interface MountedEntry {
  readonly widget: HudWidget;
  readonly element: Element;
  readonly bindings: readonly ResolvedHudBinding[];
  /** Размещение по мировому якорю (HUD-10); null — виджет живёт в зоне. */
  readonly anchor: HudWorldAnchor | null;
  /**
   * Состояние якорного размещения между кадрами: сущность из последней
   * доставки и последняя записанная в DOM позиция. Пишется в DOM только
   * изменившееся — размещение идёт каденсом КАДРА, и пере-запись стиля на
   * каждом дёргала бы layout впустую (HUD-10, тот же довод, что у `setText`).
   */
  entity: number | null;
  placedX: number;
  placedY: number;
  shown: boolean;
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
   * Сколько среди смонтированных якорных (HUD-10). Композиция без них стоит
   * кадру ровно одного сравнения — тот же смысл, в каком инертен выключенный
   * отладочный слой рендера.
   */
  private anchored = 0;
  /**
   * Последнее доставленное состояние — им немедленно кормятся виджеты свежей
   * композиции в `apply()`, не дожидаясь следующей доставки (HUD-5). Это
   * живой объект продюсера (см. `delivery.ts`): между доставками он не
   * меняется, к моменту `apply` равен последней доставке.
   */
  private lastDelivered: HudDeliveredState | null = null;
  /**
   * Последнее объявленное состояние паузы (NTR-20); `null` — не объявляли.
   *
   * Живёт рядом с доставкой тика, а не внутри неё, потому что приезжает другим
   * каденсом: в заморозке доставок тика нет вовсе, и пауза, привязанная к ним,
   * дошла бы до виджета только с возобновлением.
   */
  private pause: HudPauseState | null = null;

  constructor(options: HudRuntimeOptions) {
    this.options = options;
    this.subsystem = {
      name: 'match-hud',
      init: () => {
        // Контекст рендера HUD не нужен: его сцена — DOM-оверлей (HUD-3).
      },
      quality: () => ({
        subsystem: this.subsystem.name,
        knobs: [],
        constantCost:
          'HUD — DOM-оверлей (HUD-3) с каденсом доставок, а не кадров (HUD-5): его работа ' +
          'задана составом композиции, то есть документом игры (HUD-4), а не объёмом контента. ' +
          'Там, где виджет обходит доставленное состояние (маркеры миникарты, HUD-6), объём ' +
          'обхода есть информация игрока — что оставил фильтр видимости (netcode NET-12), — ' +
          'и пресет его MUST NOT менять (QUAL-2)',
      }),
      syncTick: (view) => {
        this.deliver(view);
      },
      updateFrame: (_dt, _alpha, realDt) => {
        // Размещение по мировому якорю — каденсом КАДРА (HUD-10): якорь идёт
        // вместе с камерой, а камера движется между доставками. Данные виджета
        // этим не затронуты — они по-прежнему приезжают доставкой (HUD-5).
        this.layoutAnchors();
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
      const anchor = item.entry.anchor ?? null;
      const element =
        anchor === null
          ? this.options.host.place(item.entry.zone, item.node)
          : this.options.host.placeAnchored(item.node);
      if (anchor !== null) this.anchored += 1;
      this.mounted.push({
        widget: item.widget,
        element,
        bindings: item.entry.bindings,
        anchor,
        entity: null,
        placedX: Number.NaN,
        placedY: Number.NaN,
        shown: false,
      });
    }

    const view = this.lastDelivered;
    if (view !== null) {
      for (const entry of this.mounted) this.update(entry, this.withPause(view), true, NO_EVENTS);
    }
  }

  /**
   * Объявление состояния паузы матча (NTR-20) — вторая точка доставки рядом с
   * `syncTick`, и заводится она не от удобства: в заморозке живых тиков нет, а
   * значит нет и доставок состояния, — привяжи мы паузу к ним, оверлей появился
   * бы на экране только вместе с возобновлением.
   *
   * Виджеты обновляются немедленно и последним доставленным состоянием: события
   * не повторяются («ровно один раз», HUD-5), разрыва здесь нет — пауза
   * непрерывности мира не рвёт, мир просто стоит.
   *
   * До первой доставки тика обновлять нечем: селекторы считаются над
   * доставленным состоянием, а его ещё не было. Объявление при этом не
   * теряется — оно доедет первой же доставкой.
   */
  deliverPause(pause: HudPauseState): void {
    this.pause = pause;
    const view = this.lastDelivered;
    if (view === null) return;
    const state = this.withPause(view);
    for (const entry of this.mounted) this.update(entry, state, false, NO_EVENTS);
  }

  /**
   * Доставленное состояние вместе с объявленной паузой.
   *
   * Копия ПОВЕРХНОСТНАЯ — один объектный литерал на доставку, в темпе рассылки
   * снапшотов, а не кадров: записи сущностей, маска пола и очередь событий
   * остаются живыми объектами продюсера (`delivery.ts`) и не копируются.
   *
   * Платит за неё каждый СЕТЕВОЙ матч, а не только замороженный: сервер шлёт
   * `Pause{running}` уже на входе в идущий матч (NTR-20, решение D8), поэтому
   * `pause` здесь непустая с первой же секунды. Обойти копию можно было бы,
   * только пронеся паузу мимо доставленного состояния — отдельным аргументом
   * `update`, — но тогда её не увидел бы селектор (`HudSelector` считается над
   * доставленным состоянием, HUD-4), и биндинг пришлось бы завести особым
   * случаем. Ветвь без паузы остаётся бесплатной: локальная сборка состояния
   * паузы не получает вовсе.
   */
  private withPause(view: HudDeliveredState): HudDeliveredState {
    return this.pause === null ? view : { ...view, pause: this.pause };
  }

  /** Снимает все смонтированные виджеты; композиция становится пустой. */
  clear(): void {
    for (const entry of this.mounted) {
      entry.widget.dispose();
      this.options.host.remove(entry.element);
    }
    this.mounted = [];
    this.anchored = 0;
  }

  /**
   * Кадровое размещение якорных виджетов (HUD-10) по ОПУБЛИКОВАННОМУ якорю
   * (`rendering` REND-41): проекции экранный слой не считает — он её читает
   * (HUD-3). Композиция без якорных записей стоит ровно одного сравнения.
   *
   * Публичен, потому что кадр приезжает исполнителю подпиской на сцену
   * (`subsystem.updateFrame`), а сборке иногда нужно разместить виджеты вне
   * этой подписки — например сразу после `apply`, чтобы HUD не мигнул пустым
   * до первого кадра.
   */
  layoutAnchors(): void {
    if (this.anchored === 0) return;
    const source = this.options.anchors;
    for (const entry of this.mounted) {
      const anchor = entry.anchor;
      if (anchor === null) continue;
      // Нет источника, нет сущности, инстанс не нарисован либо ушёл за кромку
      // кадра — виджет скрыт, а не оставлен висеть в последней точке (HUD-10).
      const published =
        source === undefined || entry.entity === null ? null : source.anchorOf(entry.entity);
      if (published === null || !published.drawn || !published.onScreen) {
        this.showAnchored(entry, false);
        continue;
      }
      this.placeAnchored(entry, published.x + (anchor.offsetX ?? 0), published.y + (anchor.offsetY ?? 0));
      this.showAnchored(entry, true);
    }
  }

  /** Точка держателя; пишется, только когда изменилась (HUD-10). */
  private placeAnchored(entry: MountedEntry, x: number, y: number): void {
    if (entry.placedX === x && entry.placedY === y) return;
    entry.placedX = x;
    entry.placedY = y;
    // Перенос, а не `left`/`top`: смещение композитингом не трогает раскладку
    // соседей, а `translate(-50%, -100%)` ставит виджет по центру НАД точкой.
    setStyle(
      entry.element,
      'transform',
      `translate(${String(x)}px, ${String(y)}px) translate(-50%, -100%)`,
    );
  }

  /** Показ держателя; пишется, только когда изменился. */
  private showAnchored(entry: MountedEntry, shown: boolean): void {
    if (entry.shown === shown) return;
    entry.shown = shown;
    setStyle(entry.element, 'display', shown ? 'block' : 'none');
  }

  /**
   * Порт действий записи: слот → имя действия из композиции → фасад (HUD-2).
   * Резолв слота один на все три формы — фронт, взятие и отпускание: иначе
   * «слот не объявлен» диагностировалось бы в трёх местах по-разному.
   */
  private portFor(entry: ResolvedHudEntry): HudActionsPort {
    const names = new Map(entry.actions.map((action) => [action.slot, action.name]));
    const nameOf = (slot: string): string => {
      const name = names.get(slot);
      if (name === undefined) {
        throw new Error(
          `виджет "${entry.source.widget}": слот действия "${slot}" не объявлен в композиции`,
        );
      }
      return name;
    };
    return {
      trigger: (slot, payload) => {
        this.options.actions.dispatch(nameOf(slot), payload);
      },
      hold: (slot) => {
        this.options.actions.hold(nameOf(slot));
      },
      release: (slot) => {
        this.options.actions.release(nameOf(slot));
      },
    };
  }

  /** Одна доставка — одно обновление каждого виджета (HUD-5). */
  private deliver(view: HudDeliveredState): void {
    this.lastDelivered = view;
    const events = view.freshEvents ? view.events : NO_EVENTS;
    const state = this.withPause(view);
    for (const entry of this.mounted) this.update(entry, state, view.snapAll, events);
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
    // Сущность якоря — из ТОГО ЖЕ значения биндинга, что уезжает виджету
    // (HUD-10): второго чтения доставленного состояния для неё не заводится.
    if (entry.anchor !== null) entry.entity = anchorEntityOf(values[entry.anchor.entity]);
    entry.widget.update({
      tick: view.tick,
      mode: view.mode,
      snap,
      values,
      events,
    });
  }
}

/**
 * Инлайн-стиль элемента точечно: `style` у DOM-элемента — объект, а описания
 * узлов (`HudNode`) неизменяемы, и пере-рендер держателя на каждый кадр стоил
 * бы дороже самого размещения. Пишется только изменившееся — решает вызывающий.
 */
function setStyle(element: Element, property: string, value: string): void {
  const style = (element as { style?: { setProperty(name: string, value: string): void } }).style;
  style?.setProperty(property, value);
}
