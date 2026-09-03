/**
 * Источники величин, которые сборка ОБЪЯВЛЯЕТ, а не выводит из конвенций ядра:
 * фаза полёта снаряда (`rendering` REND-12) и именованные геймплейные статы
 * (`match-hud` HUD-8).
 *
 * Живут они рядом с `Extractor` и читаются им, но вынесены сюда потому, что это
 * ДАННЫЕ сборки: какой компонент считает оставшийся путь снаряда и под каким
 * именем едет здоровье — знание контента, а не пайплайна рендера. Пайплайну
 * остаётся механизм: прочитать поле и положить в плоскую форму.
 *
 * Читатели — воркер-сторона границы потоков (SHELL-2), поэтому доступ к миру
 * здесь законен ровно так же, как в `Extractor`, и точка конверсии Q16.16 →
 * float у статов тоже здесь (REND-1): дальше границы fixed-point не идёт.
 */
import {
  ABILITY_SLOT_COMPONENT,
  FIXED_ONE,
  queryInto,
  world,
  type EntityId,
  type QuerySpec,
  type WorldState,
} from '@fluxus/core';

/** Откуда сборка берёт фазу полёта (REND-12): компонент, поле и полный путь. */
export interface FlightPhaseSource {
  readonly component: string;
  /** Поле с ОСТАВШИМИСЯ единицами пути (тиками жизни снаряда). */
  readonly field: string;
  /** Полное число тех же единиц — знаменатель фазы; <= 0 отключает фазу. */
  readonly total: number;
}

/** Одна запись конфигурации статов (HUD-8): имя доставки и его источник в мире. */
export interface StatSource {
  /** Имя, под которым стат едет к виджетам; на него они и биндятся. */
  readonly name: string;
  readonly component: string;
  readonly field: string;
  /**
   * Номер слота способности владельца (`ability-system` ABIL-1). Задан — стат
   * читается не у самой сущности, а у её сущности-слота с этим `slotIndex`:
   * состояние способности живёт на спутнике, а доставляется НА ВЛАДЕЛЬЦЕ,
   * потому что `Extractor` копирует сущности с `Position`, а спутники её не
   * несут по построению (`netcode` NET-12).
   *
   * Слот адресуется номером, а не именем способности: имя — авторская подпись
   * определения (ABIL-2), а в мире способность различает индекс, и второго
   * словаря «имя → слот» сборке заводить незачем.
   */
  readonly slotIndex?: number;
}

/** Сколько статов вмещает колонка `statCount` (u8) на одну сущность. */
export const MAX_STATS = 255;

/**
 * Выборка сущностей-слотов способностей (ABIL-1) — константа модуля, а не
 * литерал на кадр: индекс слотов строится каждый тик, и объект спецификации на
 * вызов был бы аллокацией, которую REND-26 запрещает пути извлечения.
 */
const SLOT_SPEC: QuerySpec = { all: [ABILITY_SLOT_COMPONENT] };

/**
 * Фаза полёта сущности (REND-12): `(total − оставшееся) / total` по записи
 * конфигурации сборки. Нет записи, нет компонента или вырожденный полный путь —
 * `NaN`: «фазы нет», и рендер дуги не нарисует.
 */
export function flightPhaseOf(
  state: WorldState,
  entity: EntityId,
  flight: FlightPhaseSource | undefined,
): number {
  if (flight === undefined || flight.total <= 0) return Number.NaN;
  if (!world.hasComponent(state, entity, flight.component)) return Number.NaN;
  const left = world.getField(state, entity, flight.component, flight.field);
  const phase = (flight.total - left) / flight.total;
  return phase < 0 ? 0 : phase > 1 ? 1 : phase;
}

/** Куда читатель статов складывает разреженные пары — секции плоской формы. */
export interface StatColumns {
  statIndex: Int32Array;
  statValue: Float64Array;
  statCount: Uint8Array;
  statPairs: number;
}

/**
 * Читатель статов (HUD-8): по записям конфигурации кладёт в плоскую форму пары
 * «индекс имени → значение» — только там, где источник у сущности есть.
 * Компонента нет — стата нет, и виджет увидит «нет данных», а не ноль,
 * выдуманный кодом.
 */
export class StatReader {
  readonly names: readonly string[];

  private readonly sources: readonly StatSource[];
  /**
   * Слоты способностей кадра: «владелец → номер слота → сущность-слот».
   * Строится ОДИН раз за кадр (`beginFrame`), а не на каждый стат каждой
   * сущности: слот адресуется парой полей своего компонента, и поиск по ним
   * стоил бы обхода всех слотов на каждую запись конфигурации.
   */
  private readonly slots = new Map<number, Map<number, EntityId>>();
  /**
   * Запас внутренних словарей: `beginFrame` возвращает их сюда очищенными и
   * берёт обратно вместо создания новых. Плоский ключ «владелец × 256 + слот»
   * не годится — упакованный `EntityId` доходит до 2^48 (`ecs/entityIndex.ts`),
   * и произведение вышло бы за точную целочисленную область double, молча
   * слив двух владельцев в один ключ. Словарь на владельца НА КАДР был именно
   * той аллокацией, которую REND-26 запрещает; переиспользованный не стоит
   * ничего.
   */
  private readonly spareSlots: Map<number, EntityId>[] = [];
  /** Буфер выборки слотов: растёт только вместе со сценой (REND-26). */
  private slotIds = new Float64Array(0);
  /** Объявлен ли хоть один стат слотовой формы — иначе индекс не нужен вовсе. */
  private readonly usesSlots: boolean;
  /**
   * Множитель поля ПО ИНДЕКСУ ЗАПИСИ конфигурации: `fixed` приезжает в Q16.16
   * и делится на границе (REND-1), `i32`/`entity` — целое и едет как есть. Тип
   * берётся из СХЕМЫ компонента (ECS-3), а не из конфигурации: спрашивать
   * автора сборки о том, что уже написано в схеме, значило бы завести второй
   * источник правды.
   *
   * Массив, а не словарь по строковому ключу `компонент.поле`: ключ собирался
   * бы на каждую пару «сущность × запись» каждый тик — строка на величину, то
   * есть мусор, растущий с числом сущностей (REND-26). Индекс записи известен
   * обходу и так. `NaN` — множитель ещё не разрешён: схема читается на первом
   * чтении, когда мир уже собран.
   */
  private readonly scale: Float64Array;

  constructor(sources: readonly StatSource[]) {
    if (sources.length > MAX_STATS) {
      throw new Error(
        `Extractor: статов — ${sources.length} записей, колонка statCount вмещает ${MAX_STATS}`,
      );
    }
    this.sources = sources;
    this.names = sources.map((source) => source.name);
    this.usesSlots = sources.some((source) => source.slotIndex !== undefined);
    this.scale = new Float64Array(sources.length).fill(Number.NaN);
  }

  /**
   * Индекс слотов способностей на кадр (ABIL-1). Зовётся перед обходом
   * сущностей; сцена без слотов не платит за это ничем — обход не начинается.
   */
  beginFrame(state: WorldState): void {
    if (!this.usesSlots) return;
    // Внутренние словари уходят в запас очищенными — на устоявшейся сцене
    // индекс не заводит ни одного объекта (REND-26).
    for (const byIndex of this.slots.values()) {
      byIndex.clear();
      this.spareSlots.push(byIndex);
    }
    this.slots.clear();
    if (world.componentSchema(state, ABILITY_SLOT_COMPONENT) === undefined) return;
    const found = this.listSlots(state);
    for (let i = 0; i < found; i++) {
      const slot = this.slotIds[i]!;
      const owner = world.getField(state, slot, ABILITY_SLOT_COMPONENT, 'owner');
      const index = world.getField(state, slot, ABILITY_SLOT_COMPONENT, 'slotIndex');
      let byIndex = this.slots.get(owner);
      if (byIndex === undefined) {
        byIndex = this.spareSlots.pop() ?? new Map<number, EntityId>();
        this.slots.set(owner, byIndex);
      }
      byIndex.set(index, slot);
    }
  }

  /** Слоты способностей в переиспользуемый буфер; растёт только со сценой. */
  private listSlots(state: WorldState): number {
    const count = queryInto(state, SLOT_SPEC, this.slotIds);
    if (count <= this.slotIds.length) return count;
    this.slotIds = new Float64Array(Math.max(8, Math.ceil(count * 1.5)));
    return queryInto(state, SLOT_SPEC, this.slotIds);
  }

  /** Сколько записей объявлено — по ним считается ёмкость секций пар. */
  get size(): number {
    return this.sources.length;
  }

  /** Читает статы сущности в колонки; `index` — её позиция в кадре. */
  read(state: WorldState, entity: EntityId, index: number, out: StatColumns): void {
    let count = 0;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i]!;
      // Слотовая форма: величина лежит на спутнике владельца, а едет на нём
      // самом. Слота нет — стата нет, ровно как и у отсутствующего компонента.
      const host =
        source.slotIndex === undefined
          ? entity
          : this.slots.get(entity)?.get(source.slotIndex);
      if (host === undefined) continue;
      if (!world.hasComponent(state, host, source.component)) continue;
      out.statIndex[out.statPairs] = i;
      out.statValue[out.statPairs] =
        world.getField(state, host, source.component, source.field) * this.scaleOf(state, i);
      out.statPairs++;
      count++;
    }
    out.statCount[index] = count;
  }

  /** Множитель записи `i` по типу её поля в схеме компонента (ECS-3): `fixed` → мировые единицы. */
  private scaleOf(state: WorldState, i: number): number {
    const cached = this.scale[i]!;
    if (!Number.isNaN(cached)) return cached;
    const source = this.sources[i]!;
    const type = world.componentSchema(state, source.component)?.fields[source.field];
    const scale = type === 'fixed' ? 1 / FIXED_ONE : 1;
    this.scale[i] = scale;
    return scale;
  }
}
