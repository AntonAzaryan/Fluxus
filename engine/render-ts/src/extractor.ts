/**
 * Extractor — воркер-половина бывшего `RenderHost.onTick` (SHELL-2).
 *
 * Единственный читатель `WorldState` в рендер-пайплайне: реализует
 * `TickObserver`-совместимый вход `extract(TickResult)` и копирует нужный
 * минимум в плоскую SoA-форму `ExtractedTick`. Здесь же — входная граница
 * ПОТОКА ТИКОВ, то есть его точка конверсии Q16.16 → float (REND-1; прочие
 * точки границы — приём сетки террейна в `subsystems/terrain.ts`,
 * `visualSurface.ts` и `camera/rig.ts`, полный перечень входов — `types.ts`),
 * и всё, чему нужен доступ к миру: резолв визуального типа по тегам, чтение
 * скорости, направление каста из событий (цель может быть сущностью — нужна её
 * позиция), зеркало карты пола.
 *
 * Плоская форма — граница потоков: она либо скармливается `ViewBuffer`
 * прямым вызовом (однопоточная сборка), либо сериализуется каналом
 * оболочки. Колонки переиспользуются между тиками (аллокация только при
 * росте сцены); возвращённый объект валиден до следующего `extract`.
 */
import {
  FIXED_ONE,
  LEVEL_OVERRIDE_COMPONENT,
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_NORMAL,
  LOCOMOTION_ROLL,
  POSITION_COMPONENT,
  TIME_SCALE_COMPONENT,
  cellAtXY,
  queryInto,
  world,
  type EntityId,
  type QuerySpec,
  type TerrainGrid,
  type TickResult,
  type WorldMode,
  type WorldState,
} from '@fluxus/core';
import { costSink } from './cost.js';
import { FloorMirror } from './floorMirror.js';
import {
  StatReader,
  flightPhaseOf,
  type FlightPhaseSource,
  type StatSource,
} from './statSources.js';
import {
  channelBytes,
  channelColumns,
  growChannelColumns,
  CHANNEL_COLUMNS,
  ENTITY_LEVEL_OVERRIDE,
  ENTITY_MOVING,
  MAX_STATE_COMPONENTS,
  STATE_BITS_SHIFT,
  type ChannelArrayValue,
} from './channelLayout.js';
import { AimTracker, DEFAULT_AIM_HOLD_TICKS } from './aimTracker.js';
import { FrameMirror, grownIds } from './frameMirror.js';
import { peak } from './footprint.js';
import { renderEventData } from './eventData.js';
import type { RenderEvent } from './types.js';

/** Конвенция физики ядра: компонент скорости с полями `x`/`y` (Q16.16 за тик). */
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
/** Порог скорости (единиц за тик) состояния `move`; ниже — дрожание стоящих не считается бегом. */
const DEFAULT_MOVE_EPSILON = 1e-3;
/** Дефолты имён компонентов локомоушена — те же, что у `LocomotionSystem` (LOC-1). */
const DEFAULT_LOCOMOTION_STATE_COMPONENT = 'LocomotionState';
const DEFAULT_LOCOMOTION_CONFIG_COMPONENT = 'Locomotion';

/**
 * Поле полной длительности манёвра в конфиг-компоненте — по его состоянию
 * (LOC-3). Имена ПОЛЕЙ, в отличие от имён компонентов, параметром не являются:
 * у самой системы ядра они тоже зашиты — это её контракт, а не конвенция ядра.
 * Состояния вне таблицы (`Normal`, окно даблтапа) манёвром не являются, фазы
 * у них нет.
 */
const MANEUVER_DURATION_FIELD: Readonly<Record<number, string>> = {
  [LOCOMOTION_DODGE]: 'dodgeTicks',
  [LOCOMOTION_ROLL]: 'rollTicks',
  [LOCOMOTION_AIRBORNE]: 'jumpTicks',
};

/**
 * Спецификация обхода живых сущностей: фильтров нет вовсе — отбор идёт по
 * слотам мира в порядке QUERY-2, то есть в точности порядком `listAlive`.
 * Константа модуля, а не литерал на тик: объект на извлечение был бы ровно той
 * аллокацией, которую REND-26 запрещает пути извлечения.
 */
const ALIVE_SPEC: QuerySpec = {};

/**
 * Плоское presentation-состояние одного тика — то, что пересекает границу
 * потоков (SHELL-2). Колонки длиной >= `count`; `NaN` в `facingYaw` — сущность
 * стоит (курс не обновлять), `NaN` в `aimYaw` — цели нет. `kind` — индекс в
 * `kindTable`, −1 — сущность не рисуется. `floorDelta` — плоские пары
 * (клетка, бит пола): значения, а не переключения, чтобы переживать
 * conflation (SHELL-4).
 */
export interface ExtractedTick {
  tick: number;
  mode: WorldMode;
  isReplay: boolean;
  /** Разрыв непрерывности мира (rewind/смена режима): всем сущностям snap (REND-2). */
  snapAll: boolean;
  /**
   * Сменилась ВЕТВЬ истории: реплеевый проход, рост эпохи (SHELL-7). Уже
   * `snapAll` — но не наоборот: смена режима (пауза NTR-20, вход в перемотку)
   * разрывает картинку, а ветвь оставляет ту же.
   *
   * Признак отдельный потому, что вопросы разные. `snapAll` спрашивает «рисовать
   * ли этот тик без интерполяции» (REND-2), а этот — «принадлежит ли упакованный
   * id той же сущности, что раньше»: перемотка откатывает счётчик поколений
   * (NTR-16), и за стёртой ветвью тот же id достаётся ДРУГОЙ сущности. Всё, что
   * помнит сущность по id между доставками (память курсов буфера, кэши видов и
   * прицела здесь), гасится по нему, а не по всякому snap'у: пауза матча — не
   * повод забыть, куда смотрел юнит.
   */
  branchChanged: boolean;
  /** Первый честный проход тика: события можно проигрывать (OBS-5). */
  freshEvents: boolean;
  count: number;
  /** EntityId — 48-битный generational; Float64 хранит его точно. */
  id: Float64Array;
  kind: Int32Array;
  x: Float32Array;
  y: Float32Array;
  level: Uint8Array;
  /**
   * Уровень СУЩНОСТИ — тот, которым её видит симуляция (TERR-4, `levelOf`):
   * значение `LevelOverride`, если он есть, иначе уровень клетки под позицией.
   * Отличается от `level` ровно у тех, у кого override и стоит: прыгающий
   * (LOC-5) и летящий (LOC-6) остаются на уровне взлёта до приземления.
   *
   * Колонка вторая, а не вместо `level`, потому что потребители разные: картинке
   * нужен уровень КЛЕТКИ — по нему инстанс садится на поверхность (REND-7),
   * считает наклон (REND-10) и высоту дуги (REND-12); маске тумана нужен
   * уровень наблюдателя — по нему режется reveal и решают тени рёбер (FOW-9,
   * PHYS-13). Кормить маску клеточным уровнем значило бы светить с плато,
   * которого симуляция наблюдателю не отдала.
   */
  simLevel: Uint8Array;
  flags: Uint8Array;
  facingYaw: Float32Array;
  aimYaw: Float32Array;
  /**
   * Состояние машины локомоушена (LOC-3) последнего тика — значение поля
   * `state`; вне манёвра и у сущностей без локомоушена — `LOCOMOTION_NORMAL`.
   * Потребитель — выбор состояния анимации (REND-4).
   */
  motion: Uint8Array;
  /**
   * Фаза манёвра — доля пройденных тиков от их полного числа, `[0..1)`;
   * `NaN` — манёвра нет. Считается здесь, в воркере: длительность манёвра
   * лежит в конфиг-компоненте, а conflation (SHELL-4) вправе съесть тик входа
   * в манёвр, и главному потоку не от чего было бы её отсчитать (REND-12).
   */
  motionPhase: Float32Array;
  /**
   * Фаза полёта — доля пройденного пути `[0..1]`; `NaN` — сущность не летит
   * (или сборка фазы не объявила). Вход полётной дуги (REND-12): считается
   * здесь, в воркере, потому что источник — компонент мира, а рендер фазу
   * MUST NOT вычислять сам.
   */
  flightPhase: Float32Array;
  /**
   * Персональная шкала времени сущности — `TimeScale.value` мира (`time-system`
   * TIME-2), множитель её часов презентации (REND-38). Единица — обычный темп:
   * сущности без компонента шкалы едут ею же (семантика умолчания TIME-3), и
   * «нет шкалы» от «шкала ноль» отличается значением, а не отсутствием колонки.
   * Значение приезжает уже сведённым и клампленным (TIME-7) — рендер его не
   * переклампливает.
   */
  timeScale: Float32Array;
  /**
   * Имена статов доставки (`match-hud` HUD-8) — словарь конфигурации сборки,
   * общий на все сущности и НЕИЗМЕННЫЙ за сессию: индексы пар ниже — позиции в
   * нём. Пустой список — сборка статов не объявила.
   */
  statNames: readonly string[];
  /**
   * Сколько пар «индекс имени → значение» у сущности `i`. Форма разреженная:
   * стат, которого у сущности нет, не едет вовсе, а не едет нулём (HUD-8 —
   * «нет данных» и «ноль» обязаны различаться).
   */
  statCount: Uint8Array;
  /** Индексы имён подряд по сущностям, длиной `statPairs`. */
  statIndex: Int32Array;
  /** Значения в том же порядке, длиной `statPairs`. */
  statValue: Float64Array;
  /** Сколько пар всего в этом тике — длина двух секций выше. */
  statPairs: number;
  /** События этого тика (копии, OBS-3), с номером тика — для reliable-доставки (SHELL-4). */
  events: readonly RenderEvent[];
  /**
   * Кадр ПОЛНЫЙ: набор строк авторитетен, и запись без строки у приёмника
   * удаляется (SHELL-3). Объявляется полным разрыв непрерывности, смена ветви и
   * первая доставка сессии — то есть ровно те случаи, когда приёмнику не
   * известно ничего.
   *
   * Частичный кадр (`false`) несёт только изменившиеся строки; отсутствие
   * сущности в нём означает «не менялась», а не «умерла».
   */
  full: boolean;
  /**
   * Идентификаторы ИСЧЕЗНУВШИХ с прошлой доставки — единственный способ узнать
   * о смерти в частичном кадре. На полном кадре список пуст: там о смерти
   * говорит само отсутствие строки.
   */
  removed: Float64Array;
  /** Сколько идентификаторов занято в `removed`. */
  removedCount: number;
  /** Пары (клетка, бит) реально изменившихся клеток пола (TERR-6 → REND-7). ArrayLike — читатель канала подставляет view в буфер доставки. */
  floorDelta: ArrayLike<number>;
  /** Живой словарь визуальных типов; растёт append-only (SHELL-5). */
  kindTable: readonly string[];
}

export interface ExtractorConfig {
  /** Визуальный тип сущности — ключ манифеста визуалов; null — не рисовать. */
  readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  /** Компонент скорости; конвенция физики ядра — 'Velocity' с полями x/y. */
  readonly velocityComponent?: string;
  /** Порог скорости (мировых единиц за тик) для состояния `move` (REND-4). */
  readonly moveEpsilon?: number;
  /** Сетка террейна сцены — уровень под сущностями и зеркало карты пола (REND-7). */
  readonly terrainGrid?: TerrainGrid;
  /** Типы событий, несущие направление атаки/каста для bone-контроля (REND-5). */
  readonly aimEvents?: readonly string[];
  /** Сколько тиков держится направление каста, прежде чем цель протухнет. */
  readonly aimHoldTicks?: number;
  /**
   * Компоненты, чьё присутствие на сущности зеркалируется битами в
   * `EntityView.states` (по порядку списка): вход длящихся эффектов камеры
   * (CAM-6). Не больше MAX_STATE_COMPONENTS.
   */
  readonly stateComponents?: readonly string[];
  /**
   * Компоненты локомоушена (LOC-1): состояние машины манёвров и конфигурация
   * с длительностями. Имена — параметры системы ядра, а значит и наши;
   * сборка без локомоушена просто не найдёт компонента и не заметит разницы.
   */
  readonly locomotion?: {
    readonly stateComponent?: string;
    readonly configComponent?: string;
  };
  /**
   * Источник фазы полёта (REND-12) — конфигурация СБОРКИ, а не конвенция ядра:
   * какой компонент считает оставшийся путь снаряда и сколько его всего.
   * Компонента у сущности нет — фазы нет (`NaN`), и полётной дуги не будет.
   *
   * Поле названо оставшимся ресурсом, а не пройденным, потому что именно так
   * его ведут системы контента (счётчик вниз до нуля); фаза — производная
   * `(total − left) / total`.
   */
  readonly flight?: FlightPhaseSource;
  /**
   * Геймплейные статы доставки (`match-hud` HUD-8): какие компоненты и поля
   * мира едут в плоскую форму и под какими именами. Объявление — данные
   * СБОРКИ: имена компонентов принадлежат контенту, и ни кодек, ни HUD их
   * смысла не знают. Новый стат — запись этого списка, а не правка кода.
   */
  readonly stats?: readonly StatSource[];
}

/**
 * Поля формы, которыми владеет таблица колонок (`channelLayout.ts`): тип
 * выводится ИЗ САМОЙ формы — второго списка имён здесь нет. Секции статов
 * попадают в него вместе с колонками, но заводит их сам `Extractor` — по числу
 * объявленных статов, а не по таблице.
 */
type ChannelColumnFields = {
  [K in keyof ExtractedTick as ExtractedTick[K] extends ChannelArrayValue ? K : never]: ExtractedTick[K];
};

const EMPTY_EVENTS: readonly RenderEvent[] = [];
const EMPTY_DELTA: readonly number[] = [];

export class Extractor {
  private readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  private readonly velocityComponent: string;
  private readonly moveEpsilonSq: number;
  private readonly stateComponents: readonly string[];
  private readonly locomotionState: string;
  private readonly locomotionConfig: string;
  private readonly flight: FlightPhaseSource | undefined;
  /** Читатель статов сборки (HUD-8); порядок записей задаёт индексы имён. */
  private readonly stats: StatReader;
  private readonly grid: TerrainGrid | undefined;
  private readonly mirror: FloorMirror | null;

  /** Словарь kind'ов: растёт append-only, индексы стабильны (SHELL-5). */
  private readonly kindTable: string[] = [];
  private readonly kindIndexOf = new Map<string, number>();
  /** Тип сущности вычисляется один раз: generation в ID делает кэш безопасным. */
  private readonly kinds = new Map<EntityId, number>();
  /** Направление последнего каста по сущностям (REND-5) — своё владение. */
  private readonly aim: AimTracker;
  private readonly seen = new Set<EntityId>();
  /** Буфер обхода живых сущностей: растёт только вместе со сценой (REND-26). */
  private alive = new Float64Array(0);
  /**
   * Зеркало последнего ДОСТАВЛЕННОГО кадра (SHELL-3): по нему кадр становится
   * частичным. Двигает его `markDelivered`, а не извлечение, — так конфляция
   * (SHELL-4) остаётся корректной без накопителя изменений.
   */
  private readonly frameMirror: FrameMirror;
  /** Идентификаторы исчезнувших этой доставки; растёт только со сценой. */
  private removed = new Float64Array(0);

  private hasTick = false;
  /** Клеток пола, просмотренных последним `syncFloor` — вход счётчика (PERF-3). */
  private floorCells = 0;
  /** Строк, сравнённых с зеркалом последним обходом, — вход счётчика (PERF-3). */
  private comparedRows = 0;
  /**
   * Байты ёмкости колонок плоской формы и буферов обхода — вход величины
   * памяти извлечения (PERF-8). Кэшируется РОСТОМ, а не считается на каждом
   * извлечении: рост ёмкости — событие сцены, а обход четырнадцати колонок на
   * тик был бы работой учёта в горячем пути (PERF-3).
   */
  private columnBytes = 0;
  private prevTick = 0;
  private prevMode: WorldMode = 'Running';

  /** Переиспользуемый выход: колонки перевыделяются только при росте сцены. */
  private readonly out: ExtractedTick;

  constructor(config: ExtractorConfig) {
    this.kindOf = config.kindOf;
    this.velocityComponent = config.velocityComponent ?? DEFAULT_VELOCITY_COMPONENT;
    const moveEpsilon = config.moveEpsilon ?? DEFAULT_MOVE_EPSILON;
    this.moveEpsilonSq = moveEpsilon * moveEpsilon;
    this.aim = new AimTracker(config.aimEvents ?? [], config.aimHoldTicks ?? DEFAULT_AIM_HOLD_TICKS);
    this.stateComponents = config.stateComponents ?? [];
    if (this.stateComponents.length > MAX_STATE_COMPONENTS) {
      throw new Error(
        `Extractor: stateComponents — ${this.stateComponents.length} компонент, колонка flags вмещает ${MAX_STATE_COMPONENTS}`,
      );
    }
    this.locomotionState =
      config.locomotion?.stateComponent ?? DEFAULT_LOCOMOTION_STATE_COMPONENT;
    this.locomotionConfig =
      config.locomotion?.configComponent ?? DEFAULT_LOCOMOTION_CONFIG_COMPONENT;
    this.flight = config.flight;
    this.stats = new StatReader(config.stats ?? []);
    this.frameMirror = new FrameMirror(this.stats.size);
    this.grid = config.terrainGrid;
    this.mirror = this.grid === undefined ? null : new FloorMirror(this.grid);
    this.out = {
      // Колонки заводятся ПУСТЫМИ по таблице (`channelLayout.ts`) — тем же
      // перечнем, каким их растит `ensureCapacity`: второго списка имён нет.
      ...(channelColumns(0) as unknown as ChannelColumnFields),
      tick: 0,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      branchChanged: false,
      freshEvents: false,
      full: true,
      removed: new Float64Array(0),
      removedCount: 0,
      count: 0,
      statNames: this.stats.names,
      statIndex: new Int32Array(0),
      statValue: new Float64Array(0),
      statPairs: 0,
      events: EMPTY_EVENTS,
      floorDelta: EMPTY_DELTA,
      kindTable: this.kindTable,
    };
  }

  /**
   * Имена статов сборки (HUD-8) — то, что оболочка кладёт в handshake (SHELL-5):
   * словарь неизменен за сессию, и возить его в каждом кадре незачем.
   */
  get statNames(): readonly string[] {
    return this.out.statNames;
  }

  /** Читает `TickResult` и возвращает плоскую форму; валидна до следующего вызова. */
  extract(result: TickResult): ExtractedTick {
    const state = result.state.world;
    const out = this.out;

    const tickAdvanced = !this.hasTick || result.tick !== this.prevTick;
    const modeChanged = this.hasTick && result.mode !== this.prevMode;
    // Разрыв непрерывности мира: replay, смена ветви истории (`isReplay`
    // оболочки — рост эпохи, SHELL-7) и смена режима — вход в перемотку и
    // выход из неё (REND-2). Скраб ВНУТРИ `Rewinding` разрывом не является:
    // режим тот же, состояния соседних исторических тиков идут подряд, и их
    // ViewBuffer интерполирует как живые — обратный ход обязан выглядеть
    // движением, а не чередой телепортов (REND-2, REND-25). Убывающий номер
    // тика сам по себе snap'а не даёт и давать не должен.
    const snapAll = result.isReplay || modeChanged;
    // Смена ВЕТВИ истории — только реплеевый проход (рост эпохи оболочки,
    // SHELL-7): за стёртой ветвью перемотка откатывает счётчик поколений
    // (NTR-16), и упакованный id достаётся другой сущности. Смена режима ветвь
    // не меняет — пауза матча (NTR-20) память по id обнулять не повод.
    const branchChanged = result.isReplay;
    const freshEvents = tickAdvanced && !result.isReplay && result.mode === 'Running';

    // Кэши, ключённые по id, переживают ровно одну ветвь истории: за стёртой
    // тот же id — уже другая сущность, и унаследованный вид (в том числе `−1`,
    // «не рисуется») или чужое направление каста держались бы до её смерти.
    // Снаряды спавнятся постоянно, и слот переиспользуется на первых же тиках.
    if (branchChanged) {
      this.kinds.clear();
      this.aim.clear();
    }

    const events = this.copyEvents(result);
    if (freshEvents) this.aim.capture(state, result.tick, events);

    // Приёмнику не известно ничего: разрыв непрерывности и смена ветви стирают
    // зеркало, и кадр объявляет себя ПОЛНЫМ (SHELL-3, design D5). Пустое
    // зеркало держится до фактической доставки, поэтому «полный» переживает и
    // конфляцию: не уехавший полный кадр не превращается в частичный.
    if (snapAll) this.frameMirror.clear();
    const full = this.frameMirror.size === 0;
    out.full = full;

    const scanned = this.copyEntities(state, result.tick, full);

    // Зеркало пола (TERR-6 → REND-7) перечитывается только по дельте компонента
    // либо на разрыве; просмотренные клетки уезжают полем — сток стоимости
    // читается один раз на вызов, а не внутри (PERF-3).
    const floorDelta =
      this.mirror === null
        ? EMPTY_DELTA
        : this.mirror.delta(state, result, snapAll || !this.hasTick);
    this.floorCells = this.mirror?.lastScanned ?? 0;

    out.tick = result.tick;
    out.mode = result.mode;
    out.isReplay = result.isReplay;
    out.snapAll = snapAll;
    out.branchChanged = branchChanged;
    out.freshEvents = freshEvents;
    out.events = events;
    out.floorDelta = floorDelta;

    // Счётчики стадии `extract` (PERF-2, PERF-3) — ОДИН раз на вызов, по уже
    // посчитанным величинам: сток читается на границе операции, а не на
    // сущности, и без стока экстракция не делает ни одного действия учёта.
    const cost = costSink();
    if (cost !== undefined) {
      cost.extractCalls++;
      cost.extractEntitiesScanned += scanned;
      cost.extractEntitiesCopied += out.count;
      cost.extractRowsCompared += this.comparedRows;
      cost.extractStatPairs += out.statPairs;
      cost.extractEvents += events.length;
      cost.extractFloorCellsScanned += this.floorCells;
      // Объём, ОТДАННЫЙ каналу (PERF-2): строки частичного кадра, их пары
      // статов, пары клеток пола и идентификаторы исчезнувших. Просмотренные на
      // изменение, но не уехавшие строки сюда не входят — их цена видна
      // `extractEntitiesScanned`, и в этом разрыве и виден смысл change'а.
      cost.extractChannelValues +=
        out.count * CHANNEL_COLUMNS + out.statPairs * 2 + floorDelta.length + out.removedCount;
    }

    // Величина памяти воркер-половины доставки (PERF-8): ёмкость колонок и
    // зеркала доставленного кадра. Обе величины кэшированы ростом — здесь одно
    // сложение, и без стока проба не делает даже его (`peak` инертен).
    peak('extractStateBytes', this.columnBytes + this.frameMirror.byteLength);

    this.prevTick = result.tick;
    this.prevMode = result.mode;
    this.hasTick = true;
    return out;
  }

  /**
   * Кадр ДОСТАВЛЕН: зеркало последнего доставленного состояния двигается на
   * него (SHELL-3, design D4). Зовут это ровно те, кто знает про факт доставки:
   * однопоточная сборка — сразу после `apply` буфера, оболочка — из отправителя
   * после записи кадра в буфер канала.
   *
   * Не позвать — не ошибка, а «кадр не уехал»: зеркало остаётся прежним, и та
   * же строка снова отличается на следующем тике. Так конфляция (SHELL-4)
   * остаётся корректной без накопителя изменений.
   */
  markDelivered(): void {
    this.frameMirror.commit(this.out, this.out.removed, this.out.removedCount);
  }

  /**
   * Кадр обязан приехать ПОЛНЫМ: приёмник начал слушать заново (SHELL-5).
   * Зеркало стирается, и ближайшее извлечение отдаёт все строки.
   */
  forgetDelivered(): void {
    this.frameMirror.clear();
  }

  /** Копирует сущности в колонки; возвращает, сколько живых просмотрел обход. */
  private copyEntities(state: WorldState, tick: number, full: boolean): number {
    const out = this.out;
    const seen = this.seen;
    seen.clear();

    const scanned = this.listAlive(state);
    this.ensureCapacity(scanned);
    let count = 0;
    let compared = 0;
    out.statPairs = 0;
    // Индекс слотов способностей на кадр (ABIL-1): статы слотовой формы
    // адресуют спутника владельца, и искать его на каждую запись каждой
    // сущности значило бы обходить слоты по разу на стат.
    this.stats.beginFrame(state);
    for (let i = 0; i < scanned; i++) {
      const entity = this.alive[i]!;
      if (!world.hasComponent(state, entity, POSITION_COMPONENT)) continue;
      seen.add(entity);
      // Строка пишется в кадр ВСЕГДА — сравнить её иначе не с чем, — но место
      // за собой оставляет, только если отличается от доставленного (SHELL-3).
      // Не отличилась — курсор статов возвращается, и следующая строка ложится
      // поверх неё.
      const statAt = out.statPairs;
      this.copyEntity(state, entity, count, tick);
      if (full) {
        count++;
        continue;
      }
      compared++;
      if (this.frameMirror.differs(out, count, entity, statAt)) count++;
      else out.statPairs = statAt;
    }
    out.count = count;
    this.comparedRows = compared;
    out.removedCount = full ? 0 : this.collectRemoved(seen);

    for (const id of this.kinds.keys()) {
      if (seen.has(id)) continue;
      this.kinds.delete(id);
      this.aim.forget(id);
    }
    return scanned;
  }

  /**
   * Исчезнувшие: те, кого приёмник знает, а обход больше не встретил. На полном
   * кадре список не нужен — там о смерти говорит отсутствие строки (SHELL-3).
   */
  private collectRemoved(seen: ReadonlySet<EntityId>): number {
    const out = this.out;
    let count = 0;
    for (const id of this.frameMirror.ids()) {
      if (seen.has(id)) continue;
      if (count >= this.removed.length) {
        this.removed = grownIds(this.removed, count + 1);
        this.measureColumns();
      }
      this.removed[count] = id;
      count++;
    }
    out.removed = this.removed;
    return count;
  }

  /**
   * Живые сущности в ПЕРЕИСПОЛЬЗУЕМЫЙ буфер, порядком QUERY-2 — тем же, каким
   * их отдаёт `listAlive` ядра. Именно `listAlive` здесь и стоял: он выделяет
   * массив размером в мир на КАЖДОЕ извлечение, то есть ровно ту аллокацию,
   * которую REND-26 запрещает пути извлечения. Отбор без фильтров даёт тот же
   * состав и тот же порядок, а буфер растёт только при росте сцены (×1.5,
   * как колонки).
   */
  private listAlive(state: WorldState): number {
    const count = queryInto(state, ALIVE_SPEC, this.alive);
    if (count <= this.alive.length) return count;
    this.alive = new Float64Array(Math.max(16, Math.ceil(count * 1.5)));
    this.measureColumns();
    return queryInto(state, ALIVE_SPEC, this.alive);
  }

  /** Одна сущность в колонки плоской формы под индексом `count`. */
  private copyEntity(state: WorldState, entity: EntityId, count: number, tick: number): void {
    const out = this.out;
    const fx = world.getField(state, entity, POSITION_COMPONENT, 'x');
    const fy = world.getField(state, entity, POSITION_COMPONENT, 'y');
    // Точка конверсии Q16.16 → float для потока тиков — его входная граница
    // (REND-1). Глубже fixed-point не проникает: всё presentation-состояние
    // ниже — float в мировых единицах.
    out.id[count] = entity;
    out.kind[count] = this.resolveKind(state, entity);
    out.x[count] = fx / FIXED_ONE;
    out.y[count] = fy / FIXED_ONE;
    // Уровень КЛЕТКИ под сущностью — вход посадки и наклона (REND-7, REND-10).
    // Клетка спрашивается раздёрнутыми координатами: `Vec2` здесь был бы
    // объектом на сущность на тик (REND-26).
    const cellLevel = this.grid === undefined ? 0 : this.grid.levels[cellAtXY(this.grid, fx, fy)]!;
    out.level[count] = cellLevel;
    // Уровень СУЩНОСТИ — тот, которым её видит симуляция: правило `levelOf`
    // ядра (TERR-4, ARENA-6) — override приоритетнее клетки. Повторено здесь
    // одной строкой намеренно: мира на main-стороне нет (SHELL-1), а тащить
    // `TerrainApi` через границу потоков ради одного `hasComponent` дороже, чем
    // повторить его условие. Читает эту колонку маска тумана (FOW-9).
    out.simLevel[count] = world.hasComponent(state, entity, LEVEL_OVERRIDE_COMPONENT)
      ? world.getField(state, entity, LEVEL_OVERRIDE_COMPONENT, 'level')
      : cellLevel;

    let moving = false;
    let yaw = Number.NaN;
    if (world.hasComponent(state, entity, this.velocityComponent)) {
      const vx = world.getField(state, entity, this.velocityComponent, 'x') / FIXED_ONE;
      const vy = world.getField(state, entity, this.velocityComponent, 'y') / FIXED_ONE;
      moving = vx * vx + vy * vy > this.moveEpsilonSq;
      if (moving) yaw = Math.atan2(vy, vx);
    }
    out.flags[count] = this.entityFlags(state, entity, moving);
    out.facingYaw[count] = yaw;
    this.readMotion(state, entity, count);
    out.flightPhase[count] = flightPhaseOf(state, entity, this.flight);
    // Персональная шкала времени (REND-38): множитель часов презентации этой
    // сущности. Читается СТРОГО через `hasComponent` — компонент есть только у
    // тех, кому его завела `TimeScaleSystem` (TIME-7), а тотальное чтение
    // несуществующего дало бы ноль и заморозило бы всех, у кого шкалы нет.
    // Умолчание — единица, ровно как у `getEffectiveDelta` (TIME-3).
    out.timeScale[count] = world.hasComponent(state, entity, TIME_SCALE_COMPONENT)
      ? world.getField(state, entity, TIME_SCALE_COMPONENT, 'value') / FIXED_ONE
      : 1;
    this.stats.read(state, entity, count, out);

    out.aimYaw[count] = this.aim.yawOf(entity, tick);
  }

  /**
   * Колонка флагов сущности: движение, override уровня и биты компонентов
   * состояния по порядку их списка (CAM-6).
   */
  private entityFlags(state: WorldState, entity: EntityId, moving: boolean): number {
    let flags = moving ? ENTITY_MOVING : 0;
    if (world.hasComponent(state, entity, LEVEL_OVERRIDE_COMPONENT)) {
      flags |= ENTITY_LEVEL_OVERRIDE;
    }
    for (let bit = 0; bit < this.stateComponents.length; bit++) {
      if (world.hasComponent(state, entity, this.stateComponents[bit]!)) {
        flags |= 1 << (bit + STATE_BITS_SHIFT);
      }
    }
    return flags;
  }

  /** Рост колонок — по таблице плоской формы (`channelLayout.ts`), не строкой на колонку. */
  private ensureCapacity(n: number): void {
    const out = this.out;
    if (out.id.length >= n) return;
    const capacity = Math.max(16, Math.ceil(n * 1.5));
    growChannelColumns(out as unknown as Record<string, ChannelArrayValue>, capacity);
    // Худший случай — все статы у всех сущностей; перевыделение идёт вместе с
    // прочими колонками, то есть только при росте сцены (SHELL-3).
    out.statIndex = new Int32Array(capacity * this.stats.size);
    out.statValue = new Float64Array(capacity * this.stats.size);
    this.measureColumns();
  }

  /** Байты ёмкости воркер-половины доставки (PERF-8); зовётся ростом ёмкости. */
  private measureColumns(): void {
    this.columnBytes =
      channelBytes(this.out as unknown as Record<string, ChannelArrayValue>) +
      this.out.statCount.byteLength +
      this.out.statIndex.byteLength +
      this.out.statValue.byteLength +
      this.alive.byteLength +
      this.removed.byteLength;
  }

  /**
   * Состояние манёвра и его фаза (REND-4, REND-12). Сущность без компонента
   * состояния — `Normal` без фазы: участие определяется наличием данных, как и
   * в самой симуляции (LOC-1). Незаполненная длительность манёвра даёт `NaN`,
   * то есть «дуги нет», а не деление на ноль.
   */
  private readMotion(state: WorldState, entity: EntityId, index: number): void {
    const out = this.out;
    if (!world.hasComponent(state, entity, this.locomotionState)) {
      out.motion[index] = LOCOMOTION_NORMAL;
      out.motionPhase[index] = Number.NaN;
      return;
    }
    const motion = world.getField(state, entity, this.locomotionState, 'state');
    out.motion[index] = motion;

    const durationField = MANEUVER_DURATION_FIELD[motion];
    let phase = Number.NaN;
    if (
      durationField !== undefined &&
      world.hasComponent(state, entity, this.locomotionConfig)
    ) {
      const total = world.getField(state, entity, this.locomotionConfig, durationField);
      if (total > 0) {
        const left = world.getField(state, entity, this.locomotionState, 'ticksLeft');
        phase = (total - left) / total;
      }
    }
    out.motionPhase[index] = phase;
  }

  private resolveKind(state: WorldState, entity: EntityId): number {
    let index = this.kinds.get(entity);
    if (index === undefined) {
      const kind = this.kindOf(state, entity);
      if (kind === null) {
        index = -1;
      } else {
        let interned = this.kindIndexOf.get(kind);
        if (interned === undefined) {
          interned = this.kindTable.length;
          this.kindTable.push(kind);
          this.kindIndexOf.set(kind, interned);
        }
        index = interned;
      }
      this.kinds.set(entity, index);
    }
    return index;
  }

  private copyEvents(result: TickResult): readonly RenderEvent[] {
    // Копия переживает dispatch (OBS-3): view ядра дальше не удерживается.
    // Массив на тик новый: view.events прошлого тика не мутируется под
    // подсистемой, удерживающей его до следующего syncTick.
    //
    // Здесь же — входная граница нагрузки (REND-1): координатные поля события
    // уходят дальше float'ами в мировых единицах, как всё остальное в пакете
    // рендера (`eventData.ts`).
    let events: RenderEvent[] | null = null;
    for (const event of result.events) {
      (events ??= []).push({ type: event.type, tick: result.tick, data: renderEventData(event.data) });
    }
    return events ?? EMPTY_EVENTS;
  }

}
