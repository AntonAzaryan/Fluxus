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
 *
 * Сам механизм набора — общий с документным источником (`keyedInstanceSet.ts`):
 * жизненный цикл инстанса нормирован один раз (REND-3), и реализация у него
 * тоже одна. Своё у набора — поля, которые он пишет, и вход сцены.
 */
import type { DecorationRecord } from '@game-mvp/assets';
import type { EntityId } from '@game-mvp/core';
import type { EntityView } from './types.js';
import { KeyedInstanceSet } from './keyedInstanceSet.js';
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
  /**
   * Поверхность меша входит в единое поле высот (REND-9) — флаг `walkable`
   * записи парного документа (PRES-2); нет — false, и отсутствие с явным false
   * неразличимы. Правка флага — обновление инстанса, а не пересоздание: ключ
   * тот же, объект в кадре не мигает (REND-18).
   */
  readonly walkable?: boolean;
}

/** Полный оборот в радианах: курс документа — доля оборота, `yaw` — радианы (REND-1). */
const TURN_RADIANS = Math.PI * 2;

/**
 * Запись `decorations` парного документа → decoration-инстанс (PRES-2 →
 * REND-18). Правило конверсии — перевод курса в радианы и дефолты
 * необязательных полей — живёт ровно здесь: его зовут и вьюпорт редактора, и
 * демо, а второе описание того же перевода разъехалось бы молча (ED-30).
 */
export function decorationInstanceOf(record: DecorationRecord, key: string): DecorationInstance {
  return {
    key,
    kind: record.visual,
    x: record.x,
    y: record.y,
    yaw: (record.yaw ?? 0) * TURN_RADIANS,
    ...(record.scale === undefined ? {} : { scale: record.scale }),
    ...(record.skin === undefined ? {} : { skin: record.skin }),
    ...(record.walkable === undefined ? {} : { walkable: record.walkable }),
  };
}

export class DecorationSet {
  private readonly stage: PresentationStage;
  /** Инстансы набора и их сведение — общий механизм (REND-3). */
  private readonly set = new KeyedInstanceSet<DecorationInstance>({
    owner: 'DecorationSet',
    requirement: 'REND-18',
    write: (view, instance) => { writeDecoration(view, instance); },
  });

  constructor(stage: PresentationStage) {
    this.stage = stage;
  }

  /** Сколько decoration-инстансов в текущем наборе. */
  get size(): number {
    return this.set.size;
  }

  /** ID инстанса набора по ключу документа; undefined — ключа в наборе нет. */
  entityOf(key: string): EntityId | undefined {
    return this.set.entityOf(key);
  }

  /**
   * Обратное отображение — ключ документа по ID инстанса. Им picking редактора
   * (ED-17) переводит попадание по изображению в запись парного документа.
   */
  keyOf(entity: EntityId): string | undefined {
    return this.set.keyOf(entity);
  }

  /**
   * Сводит полный набор с текущим и отдаёт его подсистемам (REND-18). В матче
   * зовётся один раз из загруженного документа, в режиме правки — на каждую
   * правку, и результат виден не позже следующего кадра (ED-15).
   */
  apply(instances: Iterable<DecorationInstance>): void {
    this.set.apply(instances);
    this.stage.publishDecorations(this.set.entities);
  }

  /** Пустой набор: все decoration-инстансы убираются штатным правилом REND-3. */
  clear(): void {
    this.apply([]);
  }
}

/**
 * Поля инстанса из записи набора; prev = curr — интерполировать нечего
 * (REND-18). Уровень пришпилен к нулю: ступени уровня декорации взять неоткуда,
 * а сажает инстанс визуальная поверхность (REND-9, REND-10).
 */
function writeDecoration(view: EntityView, instance: DecorationInstance): void {
  view.prevX = view.currX = instance.x;
  view.prevY = view.currY = instance.y;
  view.prevLevel = view.currLevel = 0;
  view.facingYaw = instance.yaw ?? 0;
  view.snap = true;
  view.skin = instance.skin;
  view.scale = instance.scale;
  // Walkable-вклад поля (REND-9) ведёт подсистема моделей по этому полю:
  // у неё запись манифеста и готовность модели, а идентичность инстанса
  // при правке флага сохраняется — сведение выше её не пересоздало.
  view.walkable = instance.walkable;
}
