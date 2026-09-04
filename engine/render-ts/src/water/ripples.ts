/**
 * Кольца ряби воды (`rendering` REND-36) — чистая производная
 * presentation-состояния рендера.
 *
 * ## Кольцо рождается в точке и в ней остаётся
 *
 * Идущая по воде сущность ИЗЛУЧАЕТ кольца: каждое рождается там, где сущность
 * была в момент излучения, и дальше живёт само — расходится и гаснет на своём
 * месте, пока источник уходит вперёд и роняет следующее. Отсюда след колец за
 * идущим юнитом вместо нимба, едущего вместе с ним: у кольца, чей центр
 * переписывается каждым кадром позицией сущности, расхождения от ТОЧКИ касания
 * нет вовсе — узор стоит на месте относительно юнита, а физика воды обещает
 * ровно обратное.
 *
 * Кандидат в излучатели — сущность, чья интерполированная позиция лежит в
 * клетках тела воды (или в кольце в одну клетку вокруг), чья скорость выше
 * порога и которая не в воздухе: прыжок (LOC-3) и полётная дуга (REND-12) колец
 * не роняют — рябь рождает касание поверхности, а не пролёт над ней (REND-36).
 * Новых входов рендера для этого не появляется (REND-1): читается ровно то же
 * presentation-состояние, по которому подсистема моделей ставит позы. Канала
 * обратно в симуляцию нет — тот же паттерн, что вертикальное смещение инстанса
 * (REND-12).
 *
 * ## Предел — это пул КОЛЕЦ, и стоимость фрагмента меряется им же
 *
 * `limit` — размер пула колец; он же длина униформы `uRipples` и `#define
 * WATER_RIPPLES` материала. Каждое кольцо считается на КАЖДОМ фрагменте воды
 * своего тела, поэтому счётная величина — оно, а не число сущностей в воде:
 * след из четырёх колец за одним юнитом стоит фрагменту ровно столько же,
 * сколько четыре юнита с одним кольцом каждый, и переход к следу не прибавил
 * фрагменту ни одной итерации.
 *
 * ## Отбор излучателей детерминирован от состояния, а не от порядка обхода
 *
 * Кандидатов на кадре может быть больше предела. Тогда берутся БЛИЖАЙШИЕ К
 * ЦЕНТРУ ТЕЛА — по квадрату расстояния, а равные расстояния разводит ID
 * сущности. Центр тела, а не камера: камера — не вход этой подсистемы, и её
 * дрожание мигало бы набором источников на стоящем мире. Два кадра над одним
 * состоянием дают один набор (REND-36), и это проверяется тестом, а не
 * подразумевается.
 *
 * Занятый пул кольца не рождает и живущего ради него НЕ ГАСИТ: обход префикса
 * идёт по рангу, поэтому свободные места достаются ближайшим — ровно то, чего
 * REND-36 требует «при избытке кандидатов». Вытеснение же гасило бы кольцо
 * посреди жизни, и рябь мигала бы от одного шага соседнего юнита.
 *
 * ## Часы презентационные, и ход мира у них со знаком (REND-25)
 *
 * Кольцо стареет на `dt` покадрового обновления — со ЗНАКОМ хода мира: пауза
 * замораживает возраст, скраб перемотки ведёт его назад вместе с остальной
 * картинкой. Возраст `>= decaySeconds` — кольцо отжило и освободило место в
 * пуле; возраст ниже нуля на перемотке означает «в этой ветке истории ещё не
 * излучено», и кольцо исчезает. Поэтому множитель затухания шейдера
 * `1 − возраст/период` никогда не выходит за `(0, 1]`: в скрабе кольца гаснут,
 * а не РАСТУТ.
 *
 * Часы излучения свои у каждой сущности: сущность, которой в них ещё нет,
 * роняет кольцо НЕМЕДЛЕННО (REND-36 — приземлившаяся в воде сущность рябит
 * «новым кольцом, а не с возрастом, накопленным до полёта»), дальше — раз в
 * `decaySeconds / RINGS_PER_SOURCE`. Часы замыкаются вычитанием интервала, а не
 * обнулением: каденс тогда не плывёт длиной кадра. Разрыв непрерывности
 * сущности (REND-2) снимает и её часы, и её ЖИВЫЕ кольца: рябь не переезжает
 * телепорт.
 *
 * ## Кольца переживают источник — и каналом мимо тумана не становятся
 *
 * Сущность, ушедшая из доставленного состояния (туман NET-12, смерть), больше
 * не излучает, а уже рождённые кольца доживают свой период и гаснут сами — тем
 * же правилом, каким доживают частицы погасшего эмиттера (REND-24: «живые
 * частицы SHALL доживать своё время и гаснуть сами») и растворяется труп после
 * смерти (REND-4). Информации сверх уже увиденной в них нет ПО ПОСТРОЕНИЮ:
 * кольцо рождается только в той точке, которая БЫЛА в доставленном состоянии, и
 * говорит о прошлом наблюдавшегося места, а не о том, где сущность сейчас.
 * QUAL-2 запрещает ряби быть каналом, обходящим туман, — прошлый факт в точке,
 * которая была видна, таким каналом не является, а дольше периода
 * `decaySeconds` кольцо не живёт вовсе.
 *
 * Сущности, скрытой фильтром видимости, в presentation-состоянии нет вовсе
 * (`netcode` NET-12), поэтому ряби от невидимого не существует ПО ПОСТРОЕНИЮ.
 *
 * ## Кадровый путь не аллоцирует (REND-26)
 *
 * Записи колец переиспользуются: отжившее кольцо уходит в запас поля, а не в
 * сборщик, снятие кольца — обмен с последним живым, а не вырезка из середины,
 * а отбор кандидатов идёт вставкой в префикс фиксированной длины.
 */
import { LOCOMOTION_AIRBORNE, type EntityId } from '@fluxus/core';
import type { EntityView, TickView } from '../types.js';

/**
 * Одно живое кольцо — то, что уезжает в униформу материала.
 *
 * Имя типа — то же, что у униформы `uRipples` и счётчика стоимости
 * (`waterRippleSources`): смысл счётчика «сколько колец считает фрагмент» от
 * перехода к следу не изменился, а переименование стоило бы строк эталонов
 * стоимости ни за чем. `id` — сущность, КОТОРАЯ КОЛЬЦО УРОНИЛА (по нему кольца
 * снимаются при разрыве непрерывности, REND-2); `x`, `y` — точка рождения, и
 * до конца жизни кольца она не меняется.
 *
 * Запись ПЕРЕИСПОЛЬЗУЕТСЯ (REND-26): кадровый путь не должен аллоцировать
 * пропорционально числу колец, а отжившее кольцо уходит в запас поля.
 */
export interface WaterRippleSource {
  id: EntityId;
  x: number;
  y: number;
  /** Возраст кольца в секундах презентационных часов (REND-25). */
  age: number;
  /** Амплитуда: авторская величина тела, взвешенная скоростью в момент рождения. */
  amplitude: number;
}

/** Что отбору нужно знать о теле воды и его авторских числах. */
export interface WaterRippleOptions {
  /**
   * Размер пула колец — авторский под потолком пресета; 0 — ряби нет. Он же
   * потолок отбора излучателей на кадре и длина униформы `uRipples`.
   */
  readonly limit: number;
  /** Порог скорости, мировых единиц за тик (REND-36). */
  readonly minSpeed: number;
  /** Авторская амплитуда тела. */
  readonly amplitude: number;
  /**
   * Время жизни кольца в секундах — оно же задаёт каденс излучения
   * (`decaySeconds / RINGS_PER_SOURCE`, см. шапку): у дизайнера один рычаг
   * вместо двух, которые надо согласовывать между собой. Ноль и отрицательные
   * значения периодом не бывают — валидация секции их не пропускает (REND-35),
   * — но выборка их переживает: кольцо с непорождающим периодом не рождается и
   * не живёт, деления на ноль при этом нет.
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

/**
 * Сколько колец источник роняет за время жизни кольца — тем же приёмом и по
 * тому же основанию, что `FULL_AMPLITUDE_FACTOR`: каденс излучения привязан к
 * единственному авторскому числу (`decaySeconds`), и у дизайнера один рычаг на
 * «как долго кольцо живёт» и «как часто они появляются», а не два, которые
 * надо согласовывать между собой. Четыре — столько одновременно живых колец
 * даёт один непрерывно идущий источник: след читается следом, а не пунктиром
 * из одиночных всплесков.
 */
const RINGS_PER_SOURCE = 4;

export class WaterRippleField {
  /** Часы излучения по сущности: секунды с её последнего кольца. */
  private readonly clocks = new Map<EntityId, number>();
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
  /** Живые кольца — они же то, что уезжает в униформу. Длина ≤ предела. */
  private readonly rings: WaterRippleSource[] = [];
  /** Запас записей: снятое кольцо возвращается сюда, а не в сборщик (REND-26). */
  private readonly spare: WaterRippleSource[] = [];
  private readonly seen = new Set<EntityId>();
  private readonly expired: EntityId[] = [];

  /** Живые кольца последнего кадра. */
  get sources(): readonly WaterRippleSource[] {
    return this.rings;
  }

  /**
   * Разрыв непрерывности всего мира (REND-2, `TickView.snapAll`): живые кольца
   * и часы излучения сбрасываются — рябь начинается заново там, где картинка
   * появилась.
   */
  reset(): void {
    this.clocks.clear();
    for (let i = this.rings.length - 1; i >= 0; i--) this.spare.push(this.rings[i]!);
    this.rings.length = 0;
  }

  /**
   * Кадр: живые кольца стареют на `dt` (REND-25) и отжившие уходят, движущиеся
   * в воде сущности роняют новые. Возвращает живые кольца.
   */
  update(
    view: TickView | null,
    alpha: number,
    dt: number,
    options: WaterRippleOptions,
  ): readonly WaterRippleSource[] {
    if (options.limit <= 0) {
      this.reset();
      return this.rings;
    }
    this.age(dt, options.decaySeconds);
    this.seen.clear();
    if (view !== null) {
      // Отбор идёт ВНУТРИ обхода состояния: ближайшие к центру тела встают в
      // префикс вставкой, равные расстояния разводит ID (REND-36).
      this.collect(view, alpha, options);
      this.emit(dt, options);
    }
    // Состояния нет вовсе — излучателей на кадре ноль, и часы снимает тот же
    // проход, что снимает их у сущности, переставшей быть кандидатом.
    this.prune();
    return this.rings;
  }

  /**
   * Кольца в униформу материала (REND-36): по вектору `(x, y, возраст,
   * амплитуда)` на кольцо, хвост — нули (амплитуда 0 — кольца нет).
   */
  writeUniform(target: Float32Array, limit: number): number {
    const count = Math.min(this.rings.length, limit);
    target.fill(0);
    for (let i = 0; i < count; i++) {
      const ring = this.rings[i]!;
      target[i * 4] = ring.x;
      target[i * 4 + 1] = ring.y;
      target[i * 4 + 2] = ring.age;
      target[i * 4 + 3] = ring.amplitude;
    }
    return count;
  }

  /**
   * Ход презентационных часов по живым кольцам (REND-25). Отжившее и ушедшее в
   * минус уходят одинаково: второе на перемотке означает «в этой ветке истории
   * ещё не излучено», и рисовать его не из чего.
   */
  private age(dt: number, decaySeconds: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i]!;
      const age = ring.age + dt;
      if (age >= decaySeconds || age < 0) this.release(i);
      else ring.age = age;
    }
  }

  /**
   * Кандидаты кадра: движущиеся сущности состояния, стоящие в воде. Отобранный
   * префикс складывается прямо здесь — второго прохода и второго массива под
   * него не заводится (REND-26).
   */
  private collect(view: TickView, alpha: number, options: WaterRippleOptions): void {
    this.selected = 0;
    for (const entity of view.entities.values()) {
      // Разрыв непрерывности сущности (REND-2): кольца не «проезжают» озеро —
      // рождённые до телепорта снимаются вместе с часами излучения, и рябь
      // начинается заново в точке появления.
      if (entity.snap) this.forget(entity.id);
      // Сущность в воздухе рябь не поднимает (REND-36): прыжок (LOC-3) и
      // полётная дуга (REND-12) идут НАД водой, а кольцо рождает касание
      // поверхности. Часы пропущенной снимет prune — приземление уронит новое
      // кольцо, а не докрутит каденс, накопленный до полёта.
      if (entity.motion === LOCOMOTION_AIRBORNE || !Number.isNaN(entity.flightPhase)) continue;
      const speed = speedOf(entity);
      if (speed < options.minSpeed || speed <= 0) continue;
      // Snap-тик рисуется БЕЗ интерполяции (REND-2) — тот же `t`, что у позы
      // инстанса (`subsystems/models.ts`) и оболочки эффекта (`shellSupport.ts`).
      // Иначе кольцо телепортированной сущности рождалось бы на линии прыжка
      // посреди озера, пока модель уже стоит на том берегу (REND-36).
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
   * Излучение кадра: отобранный префикс обходится ПО РАНГУ, поэтому свободные
   * места пула достаются ближайшим к центру тела (REND-36).
   */
  private emit(dt: number, options: WaterRippleOptions): void {
    const period = options.decaySeconds;
    const interval = period / RINGS_PER_SOURCE;
    const reference = Math.max(options.minSpeed, 1e-4) * FULL_AMPLITUDE_FACTOR;
    for (let i = 0; i < this.selected; i++) {
      const id = this.selId[i]!;
      this.seen.add(id);
      const previous = this.clocks.get(id);
      if (previous === undefined) {
        // Сущности в часах ещё нет: кольцо НЕМЕДЛЕННО (REND-36) — вошедшая в
        // воду и приземлившаяся в ней рябят новым кольцом, а не ждут каденса.
        this.clocks.set(id, 0);
        this.spawn(i, 0, reference, options);
        continue;
      }
      const clock = previous + dt;
      if (clock < 0) {
        // Ход мира назад (REND-25): часы идут назад вместе с картинкой и
        // замыкаются в интервал — назад не излучается ничего.
        this.clocks.set(id, wrapClock(clock, interval));
        continue;
      }
      if (!(interval > 0) || clock < interval) {
        this.clocks.set(id, clock);
        continue;
      }
      // Часы замыкаются ВЫЧИТАНИЕМ интервала: каденс не плывёт длиной кадра, а
      // остаток кадра сверх интервала становится возрастом кольца — оно
      // рождается ровно тогда, когда его срок настал, а не в начале кадра.
      const overshoot = clock - interval;
      this.clocks.set(id, overshoot);
      // Кадр длиннее всей жизни кольца — остановка презентационных часов, а не
      // каденс: кольцо рождается свежим, а не мёртвым.
      this.spawn(i, overshoot < period ? overshoot : 0, reference, options);
    }
  }

  /**
   * Кольцо от кандидата префикса. Занятый пул кольца НЕ рождает и живущего ради
   * него не гасит: обход идёт по рангу, поэтому места достаются ближайшим
   * (REND-36), а вытеснение гасило бы кольцо посреди жизни.
   */
  private spawn(index: number, age: number, reference: number, options: WaterRippleOptions): void {
    if (this.rings.length >= options.limit) return;
    const ring = this.spare.pop() ?? { id: 0, x: 0, y: 0, age: 0, amplitude: 0 };
    ring.id = this.selId[index]!;
    ring.x = this.selX[index]!;
    ring.y = this.selY[index]!;
    ring.age = age;
    ring.amplitude = Math.min(1, this.selSpeed[index]! / reference) * options.amplitude;
    this.rings.push(ring);
  }

  /** Снятие кольца обменом с последним живым: ни сдвига, ни аллокации (REND-26). */
  private release(index: number): void {
    const ring = this.rings[index]!;
    const last = this.rings.pop()!;
    if (last !== ring) this.rings[index] = last;
    this.spare.push(ring);
  }

  /** Сущность начинает с чистого листа: её часы и её живые кольца сняты (REND-2). */
  private forget(id: EntityId): void {
    this.clocks.delete(id);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      if (this.rings[i]!.id === id) this.release(i);
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

  /**
   * Часы сущности, переставшей быть излучателем, не копятся между заплывами.
   * Живых её колец это не касается — они доживают свой период сами (см. шапку).
   */
  private prune(): void {
    if (this.clocks.size === this.seen.size) return;
    this.expired.length = 0;
    for (const id of this.clocks.keys()) {
      if (!this.seen.has(id)) this.expired.push(id);
    }
    for (const id of this.expired) this.clocks.delete(id);
  }
}

/**
 * Кто важнее как излучатель: ближе к центру тела, а при в точности равном
 * расстоянии — меньший ID. Функция уровня модуля, а не замыкание отбора: её
 * создание на каждый кадр было бы той же покадровой аллокацией (REND-26).
 */
function closer(score: number, id: EntityId, other: number, otherId: EntityId): boolean {
  if (score !== other) return score < other;
  return id < otherId;
}

/**
 * Скорость сущности — путь ЗА ТИК между двумя доставленными позициями (REND-2).
 * Второй величины у рендера нет: длительность тика знает буфер кадров, а не
 * подсистема, и вводить её сюда значило бы завести ещё один вход (REND-1).
 */
function speedOf(entity: EntityView): number {
  const dx = entity.currX - entity.prevX;
  const dy = entity.currY - entity.prevY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Часы излучения в пределах интервала `[0, interval)`. Нужны на перемотке
 * (REND-25): ушедшие в минус часы возвращаются в тот же полуинтервал, из
 * которого пришли, — назад кольца не излучаются, но и каденс хода вперёд после
 * скраба не сбивается. Непорождающий интервал даёт нулевые часы, а не деление
 * на ноль.
 */
function wrapClock(clock: number, interval: number): number {
  if (!(interval > 0)) return 0;
  const wrapped = clock % interval;
  return wrapped < 0 ? wrapped + interval : wrapped;
}
