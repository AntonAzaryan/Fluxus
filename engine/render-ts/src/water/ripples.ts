/**
 * Источники ряби воды (`rendering` REND-36) — чистая производная
 * presentation-состояния рендера.
 *
 * Источник — сущность, чья интерполированная позиция лежит в клетках тела воды
 * (или в кольце в одну клетку вокруг) и чья скорость выше порога. Новых входов
 * рендера для этого не появляется (REND-1): читается ровно то же
 * presentation-состояние, по которому подсистема моделей ставит позы. Канала
 * обратно в симуляцию нет — тот же паттерн, что вертикальное смещение инстанса
 * (REND-12).
 *
 * ## Отбор детерминирован от состояния, а не от порядка обхода
 *
 * При переполнении предела берутся БЛИЖАЙШИЕ К ЦЕНТРУ ТЕЛА — по квадрату
 * расстояния, а равные расстояния разводит ID сущности. Центр тела, а не
 * камера: камера — не вход этой подсистемы, и её дрожание мигало бы набором
 * источников на стоящем мире. Два кадра над одним состоянием дают один набор
 * (REND-36), и это проверяется тестом, а не подразумевается.
 *
 * ## Возраст идёт по презентационным часам и ЗАМЫКАЕТСЯ в период
 *
 * Кольцо стареет на `dt` покадрового обновления — со ЗНАКОМ хода мира (REND-25):
 * пауза замораживает возраст, скраб перемотки ведёт его назад вместе с
 * остальной картинкой. Разрыв непрерывности (REND-2) сбрасывает накопленное:
 * рябь не переезжает телепорт.
 *
 * Возраст при этом живёт по кругу `[0, decaySeconds)`: источник не стареет
 * НАСОВСЕМ, он ПЕРЕИЗЛУЧАЕТ. Иначе плывущий юнит рябил бы ровно один период и
 * дальше шёл по стеклу — а REND-36 требует колец от сущности, пока она движется
 * в воде, а не однократной вспышки. Один период — одно расходящееся и гаснущее
 * кольцо; замыкание же снимает и вторую беду: на перемотке возраст уходил бы в
 * минус, а множитель затухания `1 − возраст/период` — выше единицы, то есть
 * кольца в скрабе РОСЛИ бы вместо того, чтобы гаснуть.
 *
 * Хвоста у остановившегося источника нет намеренно: сущность, покинувшая
 * доставленное состояние (ушла в туман, NET-12), обязана исчезнуть из воды
 * НЕМЕДЛЕННО — догорающее кольцо на её месте было бы ровно тем каналом мимо
 * тумана, который REND-36 запрещает (`render-quality` QUAL-2).
 *
 * Сущности, скрытой фильтром видимости, в presentation-состоянии нет вовсе
 * (`netcode` NET-12), поэтому ряби от невидимого не существует ПО ПОСТРОЕНИЮ —
 * рябь не может стать каналом информации мимо тумана (`render-quality` QUAL-2).
 */
import type { EntityId } from '@fluxus/core';
import type { EntityView, TickView } from '../types.js';

/**
 * Один действующий источник ряби — то, что уезжает в униформу материала.
 * Запись ПЕРЕИСПОЛЬЗУЕТСЯ между кадрами (REND-26): кадровый путь не должен
 * аллоцировать пропорционально числу источников, а держать ссылку на источник
 * между кадрами некому — набор пересчитывается каждым кадром целиком.
 */
export interface WaterRippleSource {
  id: EntityId;
  x: number;
  y: number;
  /** Возраст кольца в секундах презентационных часов (REND-25). */
  age: number;
  /** Амплитуда: авторская величина тела, взвешенная скоростью источника. */
  amplitude: number;
}

/** Что отбору нужно знать о теле воды и его авторских числах. */
export interface WaterRippleOptions {
  /** Действующий предел источников — авторский под потолком пресета; 0 — ряби нет. */
  readonly limit: number;
  /** Порог скорости, мировых единиц за тик (REND-36). */
  readonly minSpeed: number;
  /** Авторская амплитуда тела. */
  readonly amplitude: number;
  /**
   * Период кольца в секундах — он же время его затухания: возраст источника
   * замыкается в `[0, decaySeconds)`, и каждый период источник излучает новое
   * кольцо (см. шапку). Ноль и отрицательное значения периодом не бывают —
   * валидация секции их не пропускает (REND-35), — но выборка их переживает
   * нулевым возрастом, а не делением на ноль.
   */
  readonly decaySeconds: number;
  /** Сторона клетки в мировых единицах — по ней позиция ложится на карту. */
  readonly tile: number;
  /** Лежит ли клетка (с кольцом в одну клетку) в теле воды. */
  readonly nearWater: (cellX: number, cellY: number) => boolean;
  /** Центр тела в мировых единицах — опора детерминированного отбора. */
  readonly centerX: number;
  readonly centerY: number;
}

/**
 * Во сколько раз выше порога скорость даёт ПОЛНУЮ амплитуду. Восьмикратный
 * порог привязывает шкалу к единственному авторскому числу (`minSpeed`): у
 * дизайнера один рычаг на «когда рябь появляется» и «когда она в полную силу»,
 * а не два, которые надо согласовывать между собой.
 */
const FULL_AMPLITUDE_FACTOR = 8;

export class WaterRippleField {
  /** Возраст кольца по сущности: переживает кадры, пока источник жив. */
  private readonly ages = new Map<EntityId, number>();
  /**
   * Отобранный ПРЕФИКС кандидатов — параллельные массивы длиной с потолок
   * (REND-26). Отбор идёт вставкой прямо в них: потолок мал (≤16, REND-36), и
   * это дешевле сортировки всех кандидатов — а главное, НЕ АЛЛОЦИРУЕТ. Тем же
   * приёмом и по той же причине отбирает активные источники света пул REND-33
   * (`lighting/localLights.ts`), где сортировка отвергнута этими же словами.
   *
   * Кандидатов на кадре столько, сколько движущихся сущностей стоит в воде, —
   * то есть их число растёт составом доставки, и `Array.prototype.sort` по ним
   * был бы покадровой аллокацией пропорционально числу инстансов.
   */
  private readonly selId: number[] = [];
  private readonly selX: number[] = [];
  private readonly selY: number[] = [];
  private readonly selSpeed: number[] = [];
  private readonly selScore: number[] = [];
  /** Сколько мест префикса занято на этом кадре. */
  private selected = 0;
  /** Пул записей источников: кадр берёт из него, а не создаёт (REND-26). */
  private readonly pool: WaterRippleSource[] = [];
  private readonly active: WaterRippleSource[] = [];
  private readonly seen = new Set<EntityId>();
  private readonly expired: EntityId[] = [];

  /** Действующие источники последнего кадра. */
  get sources(): readonly WaterRippleSource[] {
    return this.active;
  }

  /**
   * Разрыв непрерывности всего мира (REND-2, `TickView.snapAll`): накопленные
   * кольца сбрасываются — рябь начинается заново там, где картинка появилась.
   */
  reset(): void {
    this.ages.clear();
    this.active.length = 0;
  }

  /**
   * Кадр отбора: возраст живых колец растёт на `dt` (REND-25), набор источников
   * пересчитывается от состояния. Возвращает действующие источники.
   */
  update(
    view: TickView | null,
    alpha: number,
    dt: number,
    options: WaterRippleOptions,
  ): readonly WaterRippleSource[] {
    this.active.length = 0;
    if (view === null || options.limit <= 0) {
      if (options.limit <= 0) this.ages.clear();
      return this.active;
    }
    // Отбор идёт ВНУТРИ обхода состояния: ближайшие к центру тела встают в
    // префикс вставкой, равные расстояния разводит ID (REND-36).
    this.collect(view, alpha, options);
    const reference = Math.max(options.minSpeed, 1e-4) * FULL_AMPLITUDE_FACTOR;
    this.seen.clear();
    for (let i = 0; i < this.selected; i++) {
      const id = this.selId[i]!;
      // Возраст по кругу периода: источник переизлучает, а не выгорает (см.
      // шапку), и на перемотке (`dt < 0`) он остаётся в тех же пределах.
      const age = wrapAge((this.ages.get(id) ?? 0) + dt, options.decaySeconds);
      this.ages.set(id, age);
      this.seen.add(id);
      const record = this.record(i);
      record.id = id;
      record.x = this.selX[i]!;
      record.y = this.selY[i]!;
      record.age = age;
      record.amplitude = Math.min(1, this.selSpeed[i]! / reference) * options.amplitude;
      this.active.push(record);
    }
    this.prune();
    return this.active;
  }

  /**
   * Источники в униформу материала (REND-36): по вектору `(x, y, возраст,
   * амплитуда)` на источник, хвост — нули (амплитуда 0 — источника нет).
   */
  writeUniform(target: Float32Array, limit: number): number {
    const count = Math.min(this.active.length, limit);
    target.fill(0);
    for (let i = 0; i < count; i++) {
      const source = this.active[i]!;
      target[i * 4] = source.x;
      target[i * 4 + 1] = source.y;
      target[i * 4 + 2] = source.age;
      target[i * 4 + 3] = source.amplitude;
    }
    return count;
  }

  /** Запись пула по месту в наборе; создаётся один раз на глубину набора. */
  private record(index: number): WaterRippleSource {
    let record = this.pool[index];
    if (record === undefined) {
      record = { id: 0, x: 0, y: 0, age: 0, amplitude: 0 };
      this.pool[index] = record;
    }
    return record;
  }

  /**
   * Кандидаты кадра: движущиеся сущности состояния, стоящие в воде. Отобранный
   * префикс складывается прямо здесь — второго прохода и второго массива под
   * него не заводится (REND-26).
   */
  private collect(view: TickView, alpha: number, options: WaterRippleOptions): void {
    this.selected = 0;
    for (const entity of view.entities.values()) {
      // Разрыв непрерывности сущности (REND-2): кольцо не «проезжает» озеро,
      // накопленный возраст этой сущности снимается вместе с интерполяцией.
      if (entity.snap) this.ages.delete(entity.id);
      const speed = speedOf(entity);
      if (speed < options.minSpeed || speed <= 0) continue;
      // Snap-тик рисуется БЕЗ интерполяции (REND-2) — тот же `t`, что у позы
      // инстанса (`subsystems/models.ts`) и оболочки эффекта (`shellSupport.ts`).
      // Иначе кольцо телепортированной сущности шло бы по линии прыжка через
      // всё озеро, пока модель уже стоит на том берегу (REND-36).
      const t = entity.snap ? 1 : alpha;
      const x = entity.prevX + (entity.currX - entity.prevX) * t;
      const y = entity.prevY + (entity.currY - entity.prevY) * t;
      const cellX = Math.floor(x / options.tile);
      const cellY = Math.floor(y / options.tile);
      if (!options.nearWater(cellX, cellY)) continue;
      const dx = x - options.centerX;
      const dy = y - options.centerY;
      this.insert(entity.id, x, y, speed, dx * dx + dy * dy, options.limit);
    }
  }

  /**
   * Кандидат в отобранный префикс вставкой (REND-26): место ищется с конца, а
   * кандидат хуже последнего отобранного не попадает вовсе. Ни аллокации, ни
   * второго прохода — та же механика, что у отбора активных источников света
   * (`lighting/localLights.ts`, REND-33).
   */
  private insert(
    id: EntityId,
    x: number,
    y: number,
    speed: number,
    score: number,
    ceiling: number,
  ): void {
    let i = this.selected < ceiling ? this.selected : ceiling - 1;
    if (this.selected === ceiling && !closer(score, id, this.selScore[i]!, this.selId[i]!)) return;
    while (i > 0 && closer(score, id, this.selScore[i - 1]!, this.selId[i - 1]!)) {
      this.selScore[i] = this.selScore[i - 1]!;
      this.selId[i] = this.selId[i - 1]!;
      this.selX[i] = this.selX[i - 1]!;
      this.selY[i] = this.selY[i - 1]!;
      this.selSpeed[i] = this.selSpeed[i - 1]!;
      i--;
    }
    this.selScore[i] = score;
    this.selId[i] = id;
    this.selX[i] = x;
    this.selY[i] = y;
    this.selSpeed[i] = speed;
    if (this.selected < ceiling) this.selected++;
  }

  /** Возраст сущности, переставшей быть источником, не копится между заплывами. */
  private prune(): void {
    if (this.ages.size === this.seen.size) return;
    this.expired.length = 0;
    for (const id of this.ages.keys()) {
      if (!this.seen.has(id)) this.expired.push(id);
    }
    for (const id of this.expired) this.ages.delete(id);
  }
}

/**
 * Скорость сущности — путь ЗА ТИК между двумя доставленными позициями (REND-2).
 * Второй величины у рендера нет: длительность тика знает буфер кадров, а не
 * подсистема, и вводить её сюда значило бы завести ещё один вход (REND-1).
 */
/**
 * Кто важнее как источник ряби: ближе к центру тела, а при в точности равном
 * расстоянии — меньший ID. Функция уровня модуля, а не замыкание отбора: её
 * создание на каждый кадр было бы той же покадровой аллокацией (REND-26).
 */
function closer(score: number, id: EntityId, other: number, otherId: EntityId): boolean {
  if (score !== other) return score < other;
  return id < otherId;
}

function speedOf(entity: EntityView): number {
  const dx = entity.currX - entity.prevX;
  const dy = entity.currY - entity.prevY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Возраст кольца в пределах периода `[0, period)`. Замыкание, а не насыщение:
 * источник, идущий по воде, обязан излучать кольца всё это время (REND-36), а
 * не выгореть за один период. Отрицательный остаток (перемотка, REND-25)
 * доводится в тот же полуинтервал — множитель затухания шейдера тогда никогда
 * не выходит за `(0, 1]`.
 */
function wrapAge(age: number, period: number): number {
  if (!(period > 0)) return 0;
  const wrapped = age % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}
