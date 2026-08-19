/**
 * Подсистема превью каста (REND-28): изображение того, что заденет способность,
 * если подтвердить её прямо сейчас.
 *
 * ## Два входа и только два
 *
 * 1. **Скомпилированный каталог определений** (`AbilityCatalog` ядра) —
 *    доезжает вместе со сценой при инициализации подсистем (REND-1, REND-8):
 *    клиент резолвит сцену локально, и таблица строится той же
 *    `compileAbilityCatalog` над тем же документом, что у симуляции. Второго
 *    описания способности у рендера не появляется (`ability-system` ABIL-5):
 *    фигуры шагов принадлежат определению, и подсистема рисует ЕГО словарь.
 * 2. **Локальный сэмпл ввода** (`applyLocalInput`, `LocalInputSample`) — ещё не
 *    подтверждённое прицеливание текущего кадра. Он нужен здесь по построению,
 *    а не для удобства: до подтверждения фазы в симуляции не происходит ничего
 *    (ABIL-5), поэтому неподтверждённого прицеливания в `TickResult` нет и быть
 *    не может.
 *
 * Подтверждённая часть цепочки приходит ОБЫЧНЫМ доставленным состоянием — тем
 * самым `syncTick`, который получают все подсистемы, — и третьим входом не
 * является. Отсюда изображение цепочки: подтверждённые шаги рисуются по
 * состоянию мира, текущий — по локальному вводу.
 *
 * ## Откуда берётся состояние своего слота
 *
 * Сущность-слот своего игрока ему видна (`netcode` NET-12), но потоком тиков до
 * рендера не доезжает: `Extractor` копирует сущности с `Position`, а спутники
 * платформы её не несут по построению. Поэтому состояние своего слота приезжает
 * СТАТАМИ доставки (`match-hud` HUD-8) на сущности владельца, а имена статов
 * объявляет сборка — ровно так же, как наблюдателей объявляет туман (`stats`
 * `FogSubsystem`). Смысла именам рендер не придаёт: он читает по ним числа,
 * поля же называет ядро (ABIL-1).
 *
 * ## Только свой игрок
 *
 * Превью рисуется для сущности, названной сэмплом, и ни для какой другой
 * (`netcode` NET-15): чужого неподтверждённого прицеливания у клиента нет
 * физически. Идущая фаза каста противника — состояние мира и рисуется на общих
 * основаниях (REND-23, REND-24), а не здесь.
 *
 * ## Чего у превью нет
 *
 * Обратного канала в мир (REND-1): подсистема ничего не пишет, `float → fixed`
 * не делает, в picking не участвует (REND-15) — превью есть изображение, а не
 * сущность. Наложением вьюпорта редактора (REND-16) она тоже не является и в
 * его словарь не входит: наложения — состояние инструмента авторинга, а превью
 * — часть игрового кадра. Кадр игрока, не начавшего каст, — тот же, что без
 * этой подсистемы: рисовать нечего, и группа в сцене не висит.
 *
 * ## Что подсистема НЕ считает
 *
 * Размеры фигур — выражения определения (ABIL-2), а мира у рендера нет и
 * вычислять их нечем (REND-1). Литеральное число превращается во float в точке
 * приёма (конструктор), вычисляемое остаётся невычисленным, и такая фигура не
 * рисуется вовсе: превью, показавшее выдуманный радиус, врало бы игроку.
 * Расхождение картинки с решением симуляции возможно и в остальном (превью
 * считает во float, проверка — в Q16.16 на подтверждении): превью советует,
 * решает симуляция.
 */
import * as THREE from 'three';
import {
  ABILITY_STEPS,
  FIXED_ONE,
  NO_ENTITY,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STEP_NONE,
  STEP_VECTOR,
  type AbilityCatalog,
  type EntityId,
  type Expression,
} from '@game-mvp/core';
import type {
  EntityView,
  LocalInputSample,
  QualityDeclaration,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import type { DebugSource } from '../debug/contract.js';
import {
  abilityPreviewChainDebugSource,
  type DebugPreviewState,
} from '../debug/abilityPreviewSource.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { createShellPose, poseShell } from './shellSupport.js';

/** Разбиение единичной окружности: круглая на глаз и дешёвая — фигур в кадре единицы. */
const CIRCLE_SEGMENTS = 64;
/**
 * Шаг дуги сектора, радианы. Дуга — вписанная ломаная, то есть НЕМНОГО у́же
 * настоящего круга; знак ошибки выбран «внутрь»: превью, обещающее меньше
 * настоящей зоны, игроку не врёт.
 */
const SECTOR_ARC_STEP = Math.PI / 90;
/** Подъём контура над полем: без него он тонет в ступени террейна (REND-7). */
const DEFAULT_LIFT = 0.05;
/** Фигуры у шага нет — рисовать нечем (`CompiledStep.shapeKind`). */
const NO_SHAPE = -1;

/** Цвета превью — настройка сборки, а не норма: нормирован смысл, не палитра. */
export interface AbilityPreviewColors {
  /** Уже подтверждённый шаг: он состояние мира, и цвет у него спокойнее. */
  readonly confirmed: number;
  /** Текущий шаг — то, что игрок двигает прямо сейчас. */
  readonly current: number;
}

const DEFAULT_COLORS: AbilityPreviewColors = { confirmed: 0x6fa8ff, current: 0x8affc8 };

/**
 * Имена статов доставки одного подтверждённого шага (HUD-8): точка шага и
 * сущность шага — те же три поля слота, что называет ABIL-1
 * (`step{N}x`/`step{N}y`/`step{N}e`).
 */
export interface AbilityStepStatNames {
  readonly x: string;
  readonly y: string;
  readonly entity: string;
}

/**
 * Имена статов доставки одного слота способности (HUD-8). Объявляет их сборка:
 * какое имя несёт фазу каста — знание контента, а не рендера.
 */
export interface AbilitySlotStatNames {
  /** Индекс определения в каталоге — поле `abilityId` слота (ABIL-1). */
  readonly ability: string;
  /** Индекс фазы; отрицательное значение либо отсутствие стата — каста нет. */
  readonly phase: string;
  /** Сколько шагов уже подтверждено — поле `staged` (ABIL-5). */
  readonly staged: string;
  /** Имена статов шагов по их индексу; не более `ABILITY_STEPS` записей. */
  readonly steps: readonly AbilityStepStatNames[];
}

export interface AbilityPreviewOptions {
  /**
   * Слоты своего игрока в том виде, в каком их доставляет сборка. Пустой список
   * — доставки состояния слотов нет, и превью не рисуется вовсе.
   */
  readonly slots: readonly AbilitySlotStatNames[];
  /**
   * Источник визуальной поверхности (REND-9): по нему контур ложится на рельеф.
   * Не задан — контур лежит на нулевой высоте.
   */
  readonly surface?: VisualSurfaceSource;
  readonly colors?: Partial<AbilityPreviewColors>;
  /** Подъём над поверхностью; не задан — `DEFAULT_LIFT`. */
  readonly lift?: number;
}

/**
 * Фигура шага во float — разобранная ОДИН раз, в точке приёма каталога
 * (REND-1). `NaN` в размере означает «вычислить нечем»: выражение определения
 * не литерал, а мира у рендера нет.
 */
interface PreviewShape {
  /** Код формы из словаря коллайдеров (PHYS-2) либо `NO_SHAPE`. */
  readonly kind: number;
  /** Радиус круга либо полуось X прямоугольника, мировые единицы. */
  readonly a: number;
  /** Полуось Y прямоугольника. */
  readonly b: number;
  /** Полуугол сектора в радианах; `NaN` — не литерал. */
  readonly halfAngle: number;
  /** Полуугол объявлен: круг с ним — это конус (design Decision 10). */
  readonly sector: boolean;
  /** У фигуры есть направление: сектор либо прямоугольник шага-вектора. */
  readonly directed: boolean;
}

/**
 * Фигура шага рисуема: форма из словаря объявлена, а её размеры — литералы
 * определения (REND-28). Предикат ОДИН на кадр и на пробу отладки: разойдись
 * они, дамп отвечал бы «рисуется» о том, чего в кадре нет (RDBG-2).
 */
function drawableShape(shape: PreviewShape | undefined): shape is PreviewShape {
  if (shape === undefined || shape.kind === NO_SHAPE) return false;
  if (shape.kind === SHAPE_CIRCLE) {
    return Number.isFinite(shape.a) && (!shape.sector || Number.isFinite(shape.halfAngle));
  }
  if (shape.kind !== SHAPE_AABB) return false;
  return Number.isFinite(shape.a) && Number.isFinite(shape.b);
}

/** Литерал длины определения (Q16.16) во float; не литерал — `NaN`. */
function literalWorld(expr: Expression | undefined): number {
  return typeof expr === 'number' ? expr / FIXED_ONE : Number.NaN;
}

/**
 * Литерал угла определения во float-радианы. Угол ядра — доля оборота в Q16.16
 * (FP-7), поэтому оборот здесь один и тот же множитель, а не второе соглашение.
 */
function literalRadians(expr: Expression | undefined): number {
  return typeof expr === 'number' ? (expr / FIXED_ONE) * Math.PI * 2 : Number.NaN;
}

/** Стат сущности по имени; нет стата — `NaN`, то есть «нет данных», а не ноль. */
function statOf(view: EntityView, name: string): number {
  return view.stats?.get(name) ?? Number.NaN;
}

/** Единичная окружность ломаной: замкнутый контур радиуса 1 в плоскости XY. */
function circleGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(CIRCLE_SEGMENTS * 3);
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    positions[i * 3] = Math.cos(angle);
    positions[i * 3 + 1] = Math.sin(angle);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Единичный прямоугольник: контур с полуосями 1 вокруг начала координат. */
function squareGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Сектор единичного радиуса: вершина в начале координат, раствор `2 · halfAngle`
 * вокруг оси +X. Это и есть «круг с полууглом» словаря определения — конус
 * (ABIL-5, design Decision 10), а не отдельная форма коллайдера.
 */
function sectorGeometry(halfAngle: number): THREE.BufferGeometry {
  const segments = Math.max(4, Math.ceil((2 * halfAngle) / SECTOR_ARC_STEP));
  const positions: number[] = [0, 0, 0];
  for (let i = 0; i <= segments; i++) {
    const angle = -halfAngle + (2 * halfAngle * i) / segments;
    positions.push(Math.cos(angle), Math.sin(angle), 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export class AbilityPreviewSubsystem implements RenderSubsystem {
  readonly name = 'abilityPreview';

  private readonly catalog: AbilityCatalog;
  /** Фигуры шагов во float, индекс в индекс с `catalog.steps` (REND-1). */
  private readonly shapes: readonly PreviewShape[];
  private readonly slots: readonly AbilitySlotStatNames[];
  private readonly options: AbilityPreviewOptions;
  private readonly colors: AbilityPreviewColors;
  private readonly lift: number;

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  private attached = false;

  /** Разделяемые геометрии и материалы: пер-фигурны только поза и масштаб (REND-3). */
  private circle: THREE.BufferGeometry | null = null;
  private square: THREE.BufferGeometry | null = null;
  /** Геометрии секторов по индексу шага: строятся один раз на шаг, не на кадр. */
  private readonly sectors = new Map<number, THREE.BufferGeometry>();
  private confirmedMaterial: THREE.LineBasicMaterial | null = null;
  private currentMaterial: THREE.LineBasicMaterial | null = null;

  /**
   * Пул контуров: их не больше, чем шагов у слота плюс текущий, и растёт он
   * только до этого потолка — установившийся кадр не аллоцирует (REND-26).
   */
  private readonly lines: THREE.LineLoop[] = [];
  private used = 0;

  private view: TickView | null = null;
  /**
   * Локальный сэмпл во float — переиспользуемая запись, а не объект на кадр
   * (REND-26). `entity === NO_ENTITY` — сэмпла не было вовсе.
   */
  private readonly local = { entity: NO_ENTITY as EntityId, x: 0, y: 0, aiming: false };
  /** Активный слот текущего кадра; та же причина держать запись — аллокации. */
  private readonly active = { ability: -1, staged: 0, names: null as AbilitySlotStatNames | null };
  /**
   * Решение ЭТОГО кадра: идущий каст найден. Записью `active` его не заменить —
   * она переживает кадр, на котором каста не нашлось, и отладка приняла бы
   * прошлый каст за идущий.
   */
  private casting = false;

  /** Переиспользуемые позы: начала шага (владелец) и сущности шага. */
  private readonly originPose = createShellPose();
  private readonly targetPose = createShellPose();

  constructor(catalog: AbilityCatalog, options: AbilityPreviewOptions) {
    for (const slot of options.slots) {
      if (slot.steps.length > ABILITY_STEPS) {
        throw new Error(
          `AbilityPreviewSubsystem: слот объявил ${slot.steps.length} шагов, у слота их ${ABILITY_STEPS} (ABIL-1)`,
        );
      }
    }
    this.catalog = catalog;
    this.options = options;
    this.slots = options.slots;
    this.colors = { ...DEFAULT_COLORS, ...options.colors };
    this.lift = options.lift ?? DEFAULT_LIFT;
    // Точка приёма каталога (REND-1): литералы определения становятся float
    // здесь и только здесь, глубже fixed-point в подсистеме нет.
    this.shapes = catalog.steps.map((step) => ({
      kind: step.shapeKind,
      a: literalWorld(step.shapeA),
      b: literalWorld(step.shapeB),
      halfAngle: literalRadians(step.halfAngle),
      sector: step.halfAngle !== undefined,
      directed: step.halfAngle !== undefined || step.kind === STEP_VECTOR,
    }));
    this.group.name = 'abilityPreview';
  }

  // --------------------------------------------------------------- REND-8

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    this.circle ??= circleGeometry();
    this.square ??= squareGeometry();
    this.confirmedMaterial ??= new THREE.LineBasicMaterial({
      color: this.colors.confirmed,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this.currentMaterial ??= new THREE.LineBasicMaterial({
      color: this.colors.current,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    // Группа в сцену не добавляется: пустое превью не меняет кадр ничем (REND-28).
  }

  /** Доставленное состояние: из него берутся подтверждённые шаги (REND-28). */
  syncTick(view: TickView): void {
    this.view = view;
  }

  /**
   * Стоимость подсистемы объявлена КОНСТАНТНОЙ (`render-quality` QUAL-3, второй
   * сценарий), и ручек у неё нет.
   *
   * Превью рисуется одному игроку и одному его идущему касту: контуров в кадре
   * не больше, чем шагов у слота плюс текущий (`ABILITY_STEPS` + 1), сколько бы
   * сущностей, способностей и игроков ни было в сцене. Геометрии разделяются
   * всеми фигурами, материалов два на подсистему, а пул контуров растёт до того
   * же потолка и переиспользуется. Снижать превью пресетом нельзя и по второму
   * основанию: это состав информации игрока — то, что заденет его способность,
   * — а он от качества картинки не зависит (QUAL-2).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [],
      constantCost:
        'превью рисуется одному игроку и одному его касту: контуров не больше ' +
        `${ABILITY_STEPS + 1} независимо от объёма контента, геометрии и материалы разделяемые; ` +
        'снижать превью пресетом нельзя — это информация игрока (QUAL-2)',
    };
  }

  /**
   * Кадр превью (REND-2): цепочка перестраивается по последнему доставленному
   * состоянию и последнему локальному сэмплу. Собственного хода времени у
   * превью нет — оно функция двух своих входов, а не истории вызовов.
   */
  updateFrame(_dt: number, alpha: number): void {
    this.used = 0;
    this.casting = false;
    const owner = this.owner();
    if (owner !== null && this.findActive(owner)) {
      this.casting = true;
      this.drawChain(owner, alpha);
    }
    for (let i = this.used; i < this.lines.length; i++) this.lines[i]!.visible = false;
    this.syncAttachment();
  }

  /**
   * Отладочный источник цепочки (`render-debug` RDBG-1, REND-27): подсистема
   * объявляет его в точке своей регистрации — решение кадра принадлежит ей, и
   * никто, кроме неё, не знает, почему в кадре нарисовано именно это.
   *
   * Доступ узкий и только на чтение: своей работы источник не заказывает и
   * счётчиков стоимости не двигает (RDBG-8) — он читает уже посчитанное кадром.
   */
  debugSources(): readonly DebugSource[] {
    return [
      abilityPreviewChainDebugSource({
        state: (out) => {
          this.fillDebugState(out);
        },
      }),
    ];
  }

  // ------------------------------------------------------ вход сэмпла ввода

  /**
   * Локальный сэмпл ввода (REND-1) — точка приёма второго входа. `null` гасит
   * превью: сэмпла нет, показывать нечего.
   *
   * Здесь и только здесь Q16.16 становится float (REND-1): дальше по коду
   * подсистемы fixed-point значений не остаётся. Обратно ничего не уезжает —
   * метод только читает переданную запись и копирует из неё числа.
   */
  applyLocalInput(sample: LocalInputSample | null): void {
    if (sample === null) {
      this.local.entity = NO_ENTITY;
      this.local.aiming = false;
      return;
    }
    this.local.entity = sample.entity;
    this.local.aiming = sample.target !== null;
    if (sample.target !== null) {
      this.local.x = sample.target.x / FIXED_ONE;
      this.local.y = sample.target.y / FIXED_ONE;
    }
  }

  /** Сколько фигур нарисовано в кадре — вход отладки и тестов. */
  get shapeCount(): number {
    return this.used;
  }

  /** Сценовых объектов подсистемы; 0 — кадр тот же, что без подсистемы вовсе. */
  get objectCount(): number {
    return this.attached ? this.group.children.length : 0;
  }

  // ------------------------------------------------------------- внутреннее

  /** Сущность своего игрока в доставленном состоянии; null — рисовать не для кого. */
  private owner(): EntityView | null {
    if (this.local.entity === NO_ENTITY || this.view === null) return null;
    return this.view.entities.get(this.local.entity) ?? null;
  }

  /**
   * Идущий каст своего игрока: первый слот, чья доставленная фаза не
   * отрицательна (ABIL-1). Владелец кастует одну способность за раз —
   * старт другой прерывает идущую (ABIL-6 `supersede`).
   */
  private findActive(owner: EntityView): boolean {
    for (const names of this.slots) {
      // Одно сравнение отсекает и «каста нет» (`NO_PHASE`), и «стата нет» (NaN).
      if (!(statOf(owner, names.phase) >= 0)) continue;
      const ability = statOf(owner, names.ability);
      if (!Number.isInteger(ability) || ability < 0 || ability >= this.catalog.abilities.length) {
        continue;
      }
      const staged = statOf(owner, names.staged);
      this.active.names = names;
      this.active.ability = ability;
      this.active.staged = Number.isFinite(staged) && staged > 0 ? Math.floor(staged) : 0;
      return true;
    }
    return false;
  }

  /**
   * Цепочка шагов (REND-28): подтверждённые — по доставленному состоянию своего
   * слота, текущий — по локальному вводу. Два входа встречаются в одном
   * изображении и никуда больше не идут.
   */
  private drawChain(owner: EntityView, alpha: number): void {
    const names = this.active.names!;
    const ability = this.catalog.abilities[this.active.ability]!;
    const view = this.view!;
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    // Начало шага — владелец: от него считается направление и им же
    // заякорены направленные фигуры (design Decision 10).
    poseShell(owner, alpha, heightStep, surface, this.originPose);
    const origin = this.originPose;
    const count = Math.min(ability.stepCount, names.steps.length);
    const staged = Math.min(this.active.staged, count);

    for (let i = 0; i < staged; i++) {
      const step = names.steps[i]!;
      // Сущность шага важнее записанной точки: цель могла сдвинуться с тика
      // подтверждения, а превью рисует ЕЁ доставленное состояние.
      const entity = statOf(owner, step.entity);
      const target =
        Number.isInteger(entity) && entity !== NO_ENTITY ? view.entities.get(entity) : undefined;
      let x: number;
      let y: number;
      if (target === undefined) {
        x = statOf(owner, step.x);
        y = statOf(owner, step.y);
      } else {
        poseShell(target, alpha, heightStep, surface, this.targetPose);
        x = this.targetPose.x;
        y = this.targetPose.y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this.drawStep(ability.stepStart + i, origin.x, origin.y, x, y, false);
    }

    if (staged < count && this.local.aiming) {
      this.drawStep(ability.stepStart + staged, origin.x, origin.y, this.local.x, this.local.y, true);
    }
  }

  /**
   * Фигура одного шага. Правило привязки одно на все виды: фигура С
   * НАПРАВЛЕНИЕМ заякорена в начале шага и развёрнута на точку (конус, вектор),
   * фигура без направления — центрирована НА точке (круг области).
   */
  private drawStep(
    index: number,
    originX: number,
    originY: number,
    pointX: number,
    pointY: number,
    current: boolean,
  ): void {
    const shape = this.shapes[index];
    if (!drawableShape(shape)) return;
    const material = (current ? this.currentMaterial : this.confirmedMaterial)!;
    const yaw = Math.atan2(pointY - originY, pointX - originX);
    if (shape.kind === SHAPE_CIRCLE) {
      if (!shape.sector) {
        this.place(this.circle!, material, pointX, pointY, 0, shape.a, shape.a);
        return;
      }
      this.place(this.sector(index, shape.halfAngle), material, originX, originY, yaw, shape.a, shape.a);
      return;
    }
    if (!shape.directed) {
      this.place(this.square!, material, pointX, pointY, 0, shape.a, shape.b);
      return;
    }
    // Прямоугольник шага-вектора вытянут ВДОЛЬ направления, ближней гранью у
    // начала шага: так он читается отрезком от кастера, а не рамкой вокруг него.
    this.place(
      this.square!,
      material,
      originX + Math.cos(yaw) * shape.a,
      originY + Math.sin(yaw) * shape.a,
      yaw,
      shape.a,
      shape.b,
    );
  }

  /** Геометрия сектора шага: строится один раз на шаг, а не на кадр (REND-26). */
  private sector(index: number, halfAngle: number): THREE.BufferGeometry {
    let geometry = this.sectors.get(index);
    if (geometry === undefined) {
      geometry = sectorGeometry(halfAngle);
      this.sectors.set(index, geometry);
    }
    return geometry;
  }

  /** Контур из пула в заданную позу: аллокаций на кадр нет (REND-26). */
  private place(
    geometry: THREE.BufferGeometry,
    material: THREE.LineBasicMaterial,
    x: number,
    y: number,
    yaw: number,
    scaleX: number,
    scaleY: number,
  ): void {
    const line = this.next();
    line.geometry = geometry;
    line.material = material;
    line.position.set(x, y, this.groundAt(x, y) + this.lift);
    line.rotation.set(0, 0, yaw);
    line.scale.set(scaleX, scaleY, 1);
    line.visible = true;
  }

  /** Опорная высота под точкой: визуальная поверхность (REND-9), без неё — ноль. */
  private groundAt(x: number, y: number): number {
    const surface = this.options.surface?.current ?? null;
    return surface === null ? 0 : surface.heightAt(x, y);
  }

  private next(): THREE.LineLoop {
    let line = this.lines[this.used];
    if (line === undefined) {
      line = new THREE.LineLoop(this.circle!, this.currentMaterial!);
      line.name = 'preview';
      // Превью — изображение, а не сущность: в picking оно не участвует
      // (REND-15), и луч сцены его не видит.
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
      line.raycast = () => {};
      this.lines.push(line);
      this.group.add(line);
    }
    this.used++;
    return line;
  }

  /**
   * Решение кадра в переиспользуемую запись отладки (RDBG-2). Читается ровно то,
   * чем нарисован кадр, — активный слот, локальный сэмпл и пул контуров; ни
   * одного повторного вывода здесь нет, и «нет данных» источник различает по
   * числу объявленных сборкой слотов (RDBG-6).
   */
  private fillDebugState(out: DebugPreviewState): void {
    out.slotCount = this.slots.length;
    out.ownerEntity = this.local.entity;
    out.ownerDelivered = this.owner() !== null;
    out.casting = this.casting;
    out.aiming = this.local.aiming;
    out.aimWorldX = this.local.aiming ? this.local.x : Number.NaN;
    out.aimWorldY = this.local.aiming ? this.local.y : Number.NaN;
    out.shapeCount = this.used;
    out.objectCount = this.objectCount;
    const names = this.active.names;
    const ability = this.catalog.abilities[this.active.ability];
    if (!this.casting || names === null || ability === undefined) {
      out.abilityId = '';
      out.slotIndex = -1;
      out.stepCount = 0;
      out.stagedSteps = 0;
      out.currentStepIndex = -1;
      out.currentStepKind = STEP_NONE;
      out.currentStepDrawable = false;
      return;
    }
    // Те же два усечения, которыми цепочку строит кадр: сборка вправе объявить
    // меньше шагов, чем их у определения, и показывать надо объявленное.
    const count = Math.min(ability.stepCount, names.steps.length);
    const staged = Math.min(this.active.staged, count);
    const current = staged < count ? ability.stepStart + staged : -1;
    out.abilityId = ability.id;
    out.slotIndex = this.slots.indexOf(names);
    out.stepCount = count;
    out.stagedSteps = staged;
    out.currentStepIndex = staged < count ? staged : -1;
    out.currentStepKind = current < 0 ? STEP_NONE : (this.catalog.steps[current]?.kind ?? STEP_NONE);
    out.currentStepDrawable = current >= 0 && drawableShape(this.shapes[current]);
  }

  /** Группа висит в сцене, только пока в ней есть что рисовать (REND-28). */
  private syncAttachment(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const wanted = this.used > 0;
    if (wanted === this.attached) return;
    if (wanted) ctx.scene.add(this.group);
    else ctx.scene.remove(this.group);
    this.attached = wanted;
  }
}
