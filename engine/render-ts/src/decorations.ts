/**
 * DecorationSet — набор decoration-инстансов (REND-18): третий набор рядом с
 * двумя продюсерами presentation-состояния, а не третий продюсер.
 *
 * Декорация обязана быть в кадре и там, где presentation-состояние наполняет
 * поток тиков, — то есть в матче, где документного источника (REND-11) нет
 * вовсе. Отдать её `DocumentSource` мешает взаимоисключающесть продюсеров:
 * игровой клиент, заведя документный источник ради декораций, прямо нарушил бы
 * «в каждый момент presentation-состояние наполняет ровно один». Поэтому набор
 * СОСУЩЕСТВУЕТ с любым продюсером и сменой режима не гасится — удваивать нечего:
 * decoration в снапшоте не появляется никогда (`presentation-scene` PRES-4).
 *
 * Всё остальное набор берёт у REND-11 без изменений: он ДЕКЛАРАТИВЕН —
 * потребитель отдаёт полный набор с устойчивыми ключами, а сведение делает
 * набор; императивного создания и удаления инстанса здесь нет и быть не может,
 * потому что жизненный цикл инстанса нормирован один раз (REND-3). Ключ —
 * идентичность размещённого в документе: правка позиции, курса, масштаба или
 * скина обновляет существующий инстанс и объектом в кадре не мигает.
 *
 * Чего у decoration нет и почему (REND-18): интерполяции — двух последовательных
 * тиков не существует, поза ровно документная, наклон применяется snap'ом
 * (REND-2, REND-10); событий тика и всего производного от них — one-shot клипов
 * и доворота костей к цели (REND-4, REND-5), а клип — состояние покоя записи
 * манифеста; вертикального смещения (REND-12) — манёвров у декорации не бывает;
 * фильтра видимости (`fog-of-war` FOW-7..9) — decoration'а нет в снапшоте,
 * фильтровать нечего.
 *
 * Нумерация сущностей набора своя и с нумерацией presentation-состояния НЕ
 * пересекается по смыслу: это не ссылки на сущности мира, а адреса инстансов
 * второго набора подсистемы. Спутать их подсистеме не на чем — наборы у неё
 * разные, — а наружу (picking REND-15, наложения REND-16) они выходят вместе с
 * признаком `decoration`.
 */
import type { EntityId } from '@game-mvp/core';
import { LOCOMOTION_NORMAL } from '@game-mvp/core';
import type { EntityView } from './types.js';
import type { PresentationStage } from './stage.js';

/**
 * Размещённая декорация в наборе (REND-18) — производная записи парного
 * presentation-документа (PRES-2). Величины десятичные и конверсии не требуют:
 * fixed-point за этим документом нет по построению (REND-1, PRES-3).
 */
export interface DecorationInstance {
  /**
   * Идентичность размещённого в документе. Устойчивость ключа между наборами —
   * единственное, что набор требует от формата: позиция в массиве ключом быть
   * не может (удаление соседа сдвинуло бы ключи всего хвоста).
   */
  readonly key: string;
  /** Визуальный вид — ключ манифеста визуалов, любого из разделов (ASSET-9). */
  readonly kind: string | null;
  /** Позиция в мировых единицах. */
  readonly x: number;
  readonly y: number;
  /** Курс, радианы. */
  readonly yaw?: number;
  /** Скин записи вида (REND-6); нет — скин по умолчанию из записи. */
  readonly skin?: string;
  /** Множитель масштаба поверх масштаба записи манифеста; нет — 1. */
  readonly scale?: number;
}

export class DecorationSet {
  private readonly stage: PresentationStage;
  /** Инстансы набора — тот же контейнер, что видят подсистемы. */
  private readonly entities = new Map<EntityId, EntityView>();
  private readonly idByKey = new Map<string, EntityId>();
  private readonly keyById = new Map<EntityId, string>();
  private readonly seen = new Set<string>();
  private nextId: EntityId = 1;

  constructor(stage: PresentationStage) {
    this.stage = stage;
  }

  /** Сколько decoration-инстансов в текущем наборе. */
  get size(): number {
    return this.entities.size;
  }

  /** ID инстанса набора по ключу документа; undefined — ключа в наборе нет. */
  entityOf(key: string): EntityId | undefined {
    return this.idByKey.get(key);
  }

  /**
   * Обратное отображение — ключ документа по ID инстанса. Им picking редактора
   * (ED-17) переводит попадание по изображению в запись парного документа.
   */
  keyOf(entity: EntityId): string | undefined {
    return this.keyById.get(entity);
  }

  /**
   * Сводит полный набор с текущим и отдаёт его подсистемам (REND-18). В матче
   * зовётся один раз из загруженного документа, в режиме правки — на каждую
   * правку, и результат виден не позже следующего кадра (ED-15).
   */
  apply(instances: Iterable<DecorationInstance>): void {
    const seen = this.seen;
    seen.clear();

    for (const instance of instances) {
      if (seen.has(instance.key)) {
        throw new Error(`DecorationSet: ключ "${instance.key}" встречается в наборе дважды (REND-18)`);
      }
      seen.add(instance.key);

      const id = this.idByKey.get(instance.key);
      let view = id === undefined ? undefined : this.entities.get(id);
      // Смена вида — другая модель и другая запись манифеста: пересоздание тут
      // не «мигание объектом», а единственно верное поведение. Ключ при этом
      // остаётся ключом того же размещённого.
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

    this.stage.publishDecorations(this.entities);
  }

  /** Пустой набор: все decoration-инстансы убираются штатным правилом REND-3. */
  clear(): void {
    this.apply([]);
  }

  private create(instance: DecorationInstance): EntityView {
    const id = this.nextId++;
    const view: EntityView = {
      id,
      kind: instance.kind,
      prevX: instance.x,
      prevY: instance.y,
      currX: instance.x,
      currY: instance.y,
      // Уровень производен от позиции: сажает инстанс визуальная поверхность
      // (REND-9, REND-10), а ступени уровня декорации взять неоткуда.
      prevLevel: 0,
      currLevel: 0,
      snap: true,
      spawned: true,
      // Скорости у декорации нет: состояние анимации — покой (REND-4), и клипом
      // служит клип состояния покоя записи манифеста (REND-18).
      moving: false,
      // Манёвров у декорации не бывает — отсюда же отсутствие дуги прыжка.
      motion: LOCOMOTION_NORMAL,
      prevMotionPhase: Number.NaN,
      currMotionPhase: Number.NaN,
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

  /** Поля инстанса из набора; prev = curr — интерполировать нечего (REND-18). */
  private write(view: EntityView, instance: DecorationInstance): void {
    view.prevX = view.currX = instance.x;
    view.prevY = view.currY = instance.y;
    view.prevLevel = view.currLevel = 0;
    view.facingYaw = instance.yaw ?? 0;
    view.snap = true;
    view.skin = instance.skin;
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
