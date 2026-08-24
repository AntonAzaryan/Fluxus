/**
 * PresentationStage — общее двух продюсеров presentation-состояния (REND-11):
 * реестр подсистем (REND-8), их порядок и кадр.
 *
 * Подсистема регистрируется один раз и получает presentation-состояние одним и
 * тем же `syncTick` независимо от того, кто его наполнил, — поток тиков
 * (`RenderHost`, REND-1) или документный источник (`DocumentSource`, REND-11).
 * Различить продюсеров подсистеме нечем, и это требование, а не совпадение:
 * второй путь отрисовки, знающий про документы, REND-11 запрещает.
 *
 * Продюсеры взаимоисключающи: presentation-состояние в каждый момент наполняет
 * ровно один. Смена продюсера сперва отдаёт подсистемам пустое состояние —
 * инстансы предыдущего убираются штатным правилом REND-3, а не отдельным
 * «удалить всё» API, — и только затем публикуется набор нового. Отсюда же
 * запрет удвоения при входе в превью (`editor` ED-9): набор противоположного
 * продюсера в этот момент уже пуст.
 *
 * Набор decoration-инстансов (REND-18) идёт мимо этого механизма и своим входом
 * (`publishDecorations`): он не продюсер, взаимоисключающесть на него не
 * распространяется, и смена режима его гасить MUST NOT.
 */
import type { EntityId } from '@fluxus/core';
import { costSink } from './cost.js';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from './types.js';

/**
 * Продюсер presentation-состояния (REND-11). Из продюсера сцене нужно только
 * имя для диагностики: наполнять состояние — его дело, а не сцены.
 */
export interface PresentationProducer {
  readonly name: string;
}

/**
 * Отладочный слой глазами сцены (`render-debug` RDBG-1, REND-27) — ровно две
 * точки, обе ПОСЛЕ обхода подсистем и после счётных величин стоимости:
 *
 * - `deliver` — доставленное presentation-состояние (то же, что уехало
 *   подсистемам);
 * - `frame` — кадровые величины (REND-2, `client-shell` SHELL-7).
 *
 * «После» здесь несущее (REND-27): наложение рисуется по позам, которые
 * подсистема моделей поставила в СВОЁМ покадровом обновлении, и слой вне списка
 * оказывается последним по построению, без отдельного правила о своём месте.
 * Счётчики стоимости (PERF-3) к этому моменту уже посчитаны, и вызов хука их не
 * трогает: без подключённого слоя это одно сравнение с null (RDBG-8).
 */
export interface DebugHook {
  deliver(view: TickView): void;
  frame(dt: number, alpha: number, realDt: number): void;
}

const NO_ENTITIES: ReadonlyMap<EntityId, EntityView> = new Map();

export class PresentationStage {
  private readonly context: RenderContext;
  private readonly subsystems: RenderSubsystem[] = [];
  /**
   * Состояние, которым сцена гасит набор уходящего продюсера. Пустой список
   * сущностей — обычный вход подсистемы моделей: исчезнувший ключ убирает
   * инстанс (REND-3). `floorBits === null` оставляет террейн нетронутым — его
   * геометрия приезжает не presentation-состоянием, а сеткой (REND-8), и гасить
   * её сменой продюсера нечем: пустая сетка — не «нет террейна», а другая арена.
   * Сетку документа возвращает `TerrainSubsystem.applyGrid` — им же уходит пол,
   * выбитый потоком тиков превью (ED-9).
   */
  private readonly emptyView: TickView = {
    tick: 0,
    mode: 'Running',
    isReplay: false,
    snapAll: true,
    freshEvents: false,
    entities: NO_ENTITIES,
    statNames: [],
    events: [],
    floorBits: null,
    floorChangedCells: [],
  };

  private producer: PresentationProducer | null = null;

  /**
   * Наблюдатели регистраций — второе измерение рядом с кадровым путём. Их два
   * вида, и оба не подсистемы: контроллер качества (`render-quality` QUAL-1,
   * design D2) спрашивает у подсистемы декларацию ручек, отладочный слой
   * (`render-debug` RDBG-1) — объявление отладочных источников (REND-27).
   *
   * Список, а не один: измерения независимы, и сцена, державшая одного
   * наблюдателя, молча отключала бы первое при подписке второго. Двух
   * контроллеров качества у сцены по-прежнему не бывает — это правило самого
   * контроллера (два источника значений одной ручки), а не сцены.
   */
  private readonly watchers: ((subsystem: RenderSubsystem) => void)[] = [];

  /**
   * Отладочный слой сцены (`render-debug` RDBG-1) — точка подключения РЯДОМ со
   * списком подсистем (REND-27), а не место в нём. Слой один: две независимые
   * отладочные картинки поверх одной сцены — это два набора сценовых объектов на
   * один кадр, а гарантия «выключено — кадр тот же» держится на одном владельце.
   */
  private debug: DebugHook | null = null;

  /**
   * Сущности последней доставки — знаменатель счётчика инстансов стадии кадра
   * (PERF-2): у `frame` своего состава нет, а тронуть подсистемы могут только
   * то, что им доставили. Стоимости не несёт: одно присваивание на доставку.
   */
  private live = 0;

  constructor(context: RenderContext) {
    this.context = context;
  }

  /** Продюсер, наполняющий presentation-состояние сейчас; null — ни одного. */
  get activeProducer(): PresentationProducer | null {
    return this.producer;
  }

  /** Регистрирует подсистему; порядок регистрации = порядок вызовов (REND-8). */
  register(subsystem: RenderSubsystem): this {
    this.subsystems.push(subsystem);
    subsystem.init(this.context);
    for (const watcher of this.watchers) watcher(subsystem);
    return this;
  }

  /**
   * Подписка на регистрации подсистем (QUAL-1, REND-27). Уже
   * зарегистрированные отдаются наблюдателю НЕМЕДЛЕННО: контроллер качества,
   * созданный после сборки сцены, обязан увидеть их ровно так же, как позднюю
   * регистрацию, — иначе порядок «сперва подсистемы, потом контроллер» молча
   * оставлял бы половину реестра без значений. То же и у отладочного слоя: его
   * заводят по нажатию человека, то есть заведомо после сборки сцены.
   *
   * Наблюдателей несколько (см. `watchers`), и подписка их не заменяет.
   */
  watchRegistrations(watcher: (subsystem: RenderSubsystem) => void): void {
    this.watchers.push(watcher);
    for (const subsystem of this.subsystems) watcher(subsystem);
  }

  /**
   * Подключение отладочного слоя (REND-27): слой получает доставленное состояние
   * и кадровые величины СВОЕЙ точкой, а не местом в списке подсистем. Слой
   * один; повторное подключение его заменяет.
   */
  watchFrames(hook: DebugHook): void {
    this.debug = hook;
  }

  /**
   * Активен ровно тот, кто наполнил presentation-состояние последним. Кадр
   * рисует он один: продюсер, чей цикл кадров ещё крутится после смены режима
   * или после `detach`, не должен гнать подсистемам второй `updateFrame` на том
   * же кадре — иначе dt сглаживаний и снижений удваивался бы.
   *
   * Ничьей сцены (`producer === null`) не рисует никто: продюсеров в этот момент
   * может крутиться два, и «активны оба» — ровно тот случай, который правило
   * закрывает. Первым кадром режима становится первый кадр после `publish`.
   */
  isActive(producer: PresentationProducer): boolean {
    return this.producer === producer;
  }

  /**
   * Публикует presentation-состояние подсистемам. Публикация другим продюсером
   * сперва гасит набор предыдущего (REND-11): смешения нет, объект не может
   * оказаться в кадре дважды.
   */
  publish(producer: PresentationProducer, view: TickView): void {
    if (this.producer !== null && this.producer !== producer) this.flush();
    this.producer = producer;
    this.deliver(view);
  }

  /**
   * Продюсер уходит, не передавая состояние другому: его набор гасится, сцена
   * остаётся ничьей и кадров не получает (`isActive`). Возврат к потоку тиков
   * или к документу — обычный `publish`.
   */
  detach(producer: PresentationProducer): void {
    if (this.producer !== producer) return;
    this.flush();
    this.producer = null;
  }

  /**
   * Полный набор decoration-инстансов подсистемам (REND-18). Продюсера не
   * меняет и набор уходящего не гасит: декорации СОСУЩЕСТВУЮТ с любым
   * продюсером, и вход в превью (`editor` ED-9) их в кадре оставляет — сцена,
   * которую автор украсил, украшена и в прогоне. Удвоить объект при этом
   * нечем: в снапшоте decoration не появляется никогда (PRES-4).
   *
   * Подсистема, которой инстансы не принадлежат, метода не имеет и набора не
   * получает — терять ей нечего, а знать о декорациях незачем.
   */
  publishDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    const cost = costSink();
    for (const subsystem of this.subsystems) {
      if (subsystem.syncDecorations === undefined) continue;
      subsystem.syncDecorations(entities);
      if (cost !== undefined) cost.syncTickDecorationInstances += entities.size;
    }
  }

  /**
   * Покадровое обновление подсистем в порядке регистрации (REND-2, REND-8).
   *
   * `realDt` — часы главного потока без знака: их берут величины самой картинки
   * (счётчик кадров HUD), тогда как мир доигрывает `dt` со знаком хода (REND-25).
   * Умолчание — модуль `dt`: продюсер, который различия не делает (документный
   * источник — мир там не идёт вовсе), передаёт одно число, и подсистемы
   * получают ту же величину, что и раньше.
   */
  frame(dt: number, alpha: number, realDt: number = Math.abs(dt)): void {
    const cost = costSink();
    if (cost !== undefined) {
      cost.frameCalls++;
      cost.frameSubsystems += this.subsystems.length;
      cost.frameInstances += this.live * this.subsystems.length;
    }
    for (const subsystem of this.subsystems) subsystem.updateFrame(dt, alpha, realDt);
    // Отладочный слой — ПОСЛЕ подсистем и после счётных величин (REND-27):
    // позы кадра уже поставлены, а счётчики стоимости он не двигает (RDBG-8).
    this.debug?.frame(dt, alpha, realDt);
  }

  /**
   * Снос сцены (REND-31): подсистемы отдают свои ресурсы GPU и уходят из
   * реестра. Зовёт его потребитель, у которого шов сноса есть, — вьюпорт
   * редактора при открытии другой сцены (ED-15); страница игрового клиента
   * живёт столько же, сколько подсистемы, и звать его ей незачем.
   *
   * Порядок ОБРАТЕН порядку регистрации: порт объявляет владелец, а получает
   * его подсистема, зарегистрированная позже (`shadows`, `sockets`,
   * `instances`), — снос в прямом порядке оставлял бы получателя жить после
   * владельца. Реестр после сноса пуст: сцена без подсистем не рисует и не
   * доставляет, а `register` на снесённой сцене — заведение новой.
   */
  dispose(): void {
    for (let i = this.subsystems.length - 1; i >= 0; i--) this.subsystems[i]?.dispose?.();
    this.subsystems.length = 0;
    this.watchers.length = 0;
    this.debug = null;
    this.producer = null;
    this.live = 0;
  }

  private flush(): void {
    this.deliver(this.emptyView);
  }

  /**
   * Общий шов доставки (PERF-2): и публикация продюсера, и гашение его набора —
   * один и тот же обход подсистем, поэтому и считаются они одним счётчиком.
   * Учёт — четыре целочисленных сложения на доставку и только при подключённом
   * стоке; без стока это одно сравнение на весь обход (PERF-3).
   */
  private deliver(view: TickView): void {
    const cost = costSink();
    if (cost !== undefined) {
      cost.syncTickDeliveries++;
      cost.syncTickSubsystems += this.subsystems.length;
      cost.syncTickInstances += view.entities.size * this.subsystems.length;
    }
    this.live = view.entities.size;
    for (const subsystem of this.subsystems) subsystem.syncTick(view);
    this.debug?.deliver(view);
  }
}
