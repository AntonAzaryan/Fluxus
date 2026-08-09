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
import type { EntityId } from '@game-mvp/core';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from './types.js';

/**
 * Продюсер presentation-состояния (REND-11). Из продюсера сцене нужно только
 * имя для диагностики: наполнять состояние — его дело, а не сцены.
 */
export interface PresentationProducer {
  readonly name: string;
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
    events: [],
    floorBits: null,
    floorChangedCells: [],
  };

  private producer: PresentationProducer | null = null;

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
    return this;
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
    for (const subsystem of this.subsystems) subsystem.syncTick(view);
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
    for (const subsystem of this.subsystems) subsystem.syncDecorations?.(entities);
  }

  /** Покадровое обновление подсистем в порядке регистрации (REND-2, REND-8). */
  frame(dt: number, alpha: number): void {
    for (const subsystem of this.subsystems) subsystem.updateFrame(dt, alpha);
  }

  private flush(): void {
    for (const subsystem of this.subsystems) subsystem.syncTick(this.emptyView);
  }
}
