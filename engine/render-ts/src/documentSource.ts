/**
 * DocumentSource — документный источник инстансов (REND-11): второй продюсер
 * того же presentation-состояния, что поток тиков, для вьюпорта редактора
 * (`editor` ED-15) и просмотрщика ассетов (ED-20).
 *
 * Источник декларативный: потребитель отдаёт полный набор инстансов с
 * устойчивыми ключами, а сведение с текущим набором делает источник — ключ,
 * которого не было, создаёт инстанс, исчезнувший ключ убирает, сохранившийся
 * обновляет. Императивного API создания и удаления инстанса здесь нет и быть не
 * может: правило жизненного цикла нормировано один раз (REND-3), а картинка
 * обязана быть функцией документа, а не истории вызовов, — иначе undo/redo
 * авторинга (ED-18) требовал бы обратного проигрывания вызовов рендера.
 *
 * Ключ — идентичность размещённого в документе, а не хеш его полей: правка
 * позиции, поворота, масштаба, скина или клипа обновляет существующий инстанс.
 * Пересоздание сбрасывало бы всё, чем владеют подсистемы, — материалы скина
 * (REND-6), фазу анимации, сглаженный наклон (REND-10), — и правка одного числа
 * мигала бы объектом в кадре.
 *
 * Чего в документном режиме нет (REND-11): интерполяции — двух последовательных
 * тиков не существует, поза ровно документная, а правило разрыва непрерывности
 * вырождается в snap на каждое обновление (REND-2); событий тика и всего
 * производного от них — one-shot клипов и доворота костей к цели (REND-4,
 * REND-5); фильтра видимости (`fog-of-war` FOW-7..9) — видимость часть
 * симуляции, а симуляции в режиме правки нет.
 *
 * Что применяется без изменений: запись манифеста визуалов целиком (ASSET-6) —
 * модель, скин, параметры наклона, — кривизна террейна (REND-9) и посадка по
 * нормали визуальной поверхности (REND-10). Всё это делают те же подсистемы:
 * источник не владеет ни одним сценовым объектом и ни одним материалом.
 *
 * Превью ассета (ED-20) — вырожденный случай: набор из одного инстанса без
 * сцены и террейна, а не третий продюсер.
 *
 * ## Чего этому источнику не принадлежит: декорации
 *
 * Декорации парного presentation-документа сцены (`presentation-scene` PRES-1)
 * идут ОТДЕЛЬНЫМ набором (`decorations.ts`, REND-18), а не этим источником, и
 * это не разделение по вкусу. Продюсеры взаимоисключающи, а декорация обязана
 * быть в кадре и в матче — там, где presentation-состояние наполняет поток
 * тиков и документного источника нет вовсе. Отдай их сюда, и игровому клиенту
 * пришлось бы завести документный источник ради декораций, то есть нарушить
 * «в каждый момент presentation-состояние наполняет ровно один» (REND-11).
 */
import { LOCOMOTION_NORMAL, type EntityId } from '@game-mvp/core';
import type { EntityView, TickView } from './types.js';
import type { PresentationProducer, PresentationStage } from './stage.js';

/**
 * Размещённый объект документа в наборе (REND-11). Из какого JSON потребитель
 * его собрал — начальная расстановка конфига сцены или запись манифеста в
 * просмотрщике (ED-20) — источнику неизвестно и неважно. Парный
 * presentation-документ в этот перечень не входит: его декорации идут набором
 * REND-18, см. шапку модуля.
 */
export interface DocumentInstance {
  /**
   * Идентичность размещённого в документе. Устойчивость ключа между наборами —
   * единственное, что источник требует от формата: позиция в массиве ключом
   * быть не может (удаление соседа сдвинуло бы ключи всего хвоста).
   */
  readonly key: string;
  /** Визуальный тип — ключ манифеста визуалов (ASSET-6); null — не рисуется. */
  readonly kind: string | null;
  /** Позиция в мировых единицах (float: документные величины уже за входной границей, REND-1). */
  readonly x: number;
  readonly y: number;
  /**
   * Уровень террейна под объектом. Работает только там, где визуальной
   * поверхности нет (превью ED-20): во вьюпорте инстанс сажает на поверхность
   * подсистема моделей по кривизне и рампам (REND-9, REND-10).
   */
  readonly level?: number;
  /** Курс, радианы. */
  readonly yaw?: number;
  /** Скин записи манифеста (REND-6); нет — скин по умолчанию из манифеста. */
  readonly skin?: string;
  /**
   * Клип, который играет инстанс (REND-11). Разрешается по тем же правилам, что
   * запись манифеста (REND-4); нет — клип состояния покоя из манифеста.
   */
  readonly clip?: string;
  /** Множитель масштаба поверх масштаба записи манифеста; нет — 1. */
  readonly scale?: number;
}

export interface DocumentSourceOptions {
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
}

export class DocumentSource implements PresentationProducer {
  readonly name = 'document';

  /** Presentation-состояние набора; подсистемы получают его в `syncTick`. */
  private readonly state: TickView;

  private readonly stage: PresentationStage;
  private readonly clock: () => number;
  /** Сущности набора — тот же контейнер, что видят подсистемы в `view.entities`. */
  private readonly entities = new Map<EntityId, EntityView>();
  private readonly idByKey = new Map<string, EntityId>();
  private readonly keyById = new Map<EntityId, string>();
  private readonly seen = new Set<string>();
  /**
   * Нумерация сущностей набора — собственная. Это НЕ ссылки на сущности мира:
   * мира в режиме правки нет, а продюсеры взаимоисключающи — набор
   * противоположного к моменту публикации погашен, и спутать одинаковые числа
   * подсистеме не на чем. Возврат ключа даёт новый номер: инстанс создаётся
   * заново, как и требует REND-11.
   */
  private nextId: EntityId = 1;
  private lastFrameAtMs: number | null = null;

  constructor(stage: PresentationStage, options: DocumentSourceOptions = {}) {
    this.stage = stage;
    this.clock = options.clock ?? (() => performance.now());
    this.state = {
      tick: 0,
      mode: 'Running',
      isReplay: false,
      // Разрыв непрерывности на каждом обновлении: интерполировать нечего (REND-11).
      snapAll: true,
      // Событий тика нет — one-shot клипы и доворот костей не проигрываются.
      freshEvents: false,
      entities: this.entities,
      // Геймплейных статов у документного набора нет (HUD-8): их источник —
      // компоненты мира, а мира в режиме правки не идёт.
      statNames: [],
      events: [],
      // Террейн приезжает подсистеме сеткой (REND-8), а не набором инстансов:
      // документная правка уровней и пола идёт через `TerrainSubsystem.applyGrid`.
      floorBits: null,
      floorChangedCells: [],
    };
  }

  /**
   * Presentation-состояние набора — только на чтение. Тип держит отсутствующее
   * отсутствующим по построению (REND-11): `events`, `freshEvents`, `snapAll` и
   * `floorBits` документному режиму присвоить неоткуда — не «пока никто не
   * присвоил», а нечем, включая будущего потребителя.
   */
  get view(): Readonly<TickView> {
    return this.state;
  }

  /** Сколько инстансов в текущем наборе. */
  get size(): number {
    return this.entities.size;
  }

  /** ID сущности presentation-состояния по ключу документа; undefined — ключа в наборе нет. */
  entityOf(key: string): EntityId | undefined {
    return this.idByKey.get(key);
  }

  /**
   * Обратное отображение — ключ документа по ID сущности. Им picking редактора
   * (ED-17) переводит попадание по изображению в размещённый объект документа.
   */
  keyOf(entity: EntityId): string | undefined {
    return this.keyById.get(entity);
  }

  /**
   * Сводит полный набор с текущим и публикует presentation-состояние (REND-11).
   * Обновление инкрементально по отношению к кадру: правка одного размещённого
   * объекта трогает его инстанс и не пересобирает сцену (ED-15).
   */
  apply(instances: Iterable<DocumentInstance>): void {
    const seen = this.seen;
    seen.clear();

    for (const instance of instances) {
      if (seen.has(instance.key)) {
        throw new Error(`DocumentSource: ключ "${instance.key}" встречается в наборе дважды (REND-11)`);
      }
      seen.add(instance.key);

      const id = this.idByKey.get(instance.key);
      let view = id === undefined ? undefined : this.entities.get(id);
      // Смена визуального типа — другая модель и другая запись манифеста: тут
      // пересоздание не «мигание объектом», а единственно верное поведение.
      // Ключ при этом остаётся ключом того же размещённого объекта.
      if (view !== undefined && view.kind !== instance.kind) {
        this.drop(instance.key);
        view = undefined;
      }
      if (view === undefined) {
        this.write(this.create(instance), instance);
      } else {
        view.spawned = false;
        this.write(view, instance);
      }
    }

    for (const key of this.idByKey.keys()) {
      if (!seen.has(key)) this.drop(key);
    }

    this.stage.publish(this, this.state);
  }

  /** Пустой набор: все инстансы убираются штатным правилом REND-3. */
  clear(): void {
    this.apply([]);
  }

  /**
   * Кадр документного режима. Альфа всегда 1: интерполировать нечего (REND-11),
   * поза инстанса — ровно документная. Кадр рисует только активный продюсер —
   * оставшийся цикл кадров неактивного подсистемы не трогает.
   */
  frame(now: number = this.clock()): void {
    if (!this.stage.isActive(this)) {
      this.lastFrameAtMs = null;
      return;
    }
    const dtMs = this.lastFrameAtMs === null ? 0 : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // Тот же кламп dt, что у потока тиков: после паузы вкладки первый кадр не
    // должен «доигрывать» минуты сглаживаний.
    const dt = Math.min(Math.max(dtMs / 1000, 0), 0.25);
    this.stage.frame(dt, 1);
  }

  private create(instance: DocumentInstance): EntityView {
    const id = this.nextId++;
    const view: EntityView = {
      id,
      kind: instance.kind,
      prevX: instance.x,
      prevY: instance.y,
      currX: instance.x,
      currY: instance.y,
      prevLevel: 0,
      currLevel: 0,
      snap: true,
      spawned: true,
      // Скорости в документе нет: состояние анимации — покой (REND-4), поверх
      // него набор может назвать клип явно (`clip`).
      moving: false,
      // Машина локомоушена — часть симуляции; манёвра в наборе быть не может.
      motion: LOCOMOTION_NORMAL,
      prevMotion: LOCOMOTION_NORMAL,
      prevMotionPhase: Number.NaN,
      currMotionPhase: Number.NaN,
      // Полёт — состояние идущего мира: у документного инстанса его нет (REND-12).
      flightPhase: Number.NaN,
      // Уровень производен от позиции: посадку делает визуальная поверхность (REND-10).
      levelOverride: false,
      facingYaw: 0,
      // Цели атаки/каста нет — доворот костей к ней не проигрывается (REND-5).
      aimYaw: null,
      states: 0,
    };
    this.entities.set(id, view);
    this.idByKey.set(instance.key, id);
    this.keyById.set(id, instance.key);
    return view;
  }

  /** Поля инстанса из набора; prev = curr — интерполировать нечего (REND-11). */
  private write(view: EntityView, instance: DocumentInstance): void {
    const level = instance.level ?? 0;
    view.prevX = view.currX = instance.x;
    view.prevY = view.currY = instance.y;
    view.prevLevel = view.currLevel = level;
    view.facingYaw = instance.yaw ?? 0;
    view.snap = true;
    view.skin = instance.skin;
    view.clip = instance.clip;
    view.scale = instance.scale;
  }

  private drop(key: string): void {
    const id = this.idByKey.get(key);
    if (id === undefined) return;
    this.idByKey.delete(key);
    this.keyById.delete(id);
    this.entities.delete(id);
  }
}
