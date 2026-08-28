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
 * ## Заливка и контур
 *
 * Фигура шага рисуется ДВУМЯ объектами в одной позе: полупрозрачной заливкой и
 * контуром поверх неё. Заливка отвечает на вопрос «что накроет», контур — на
 * «где ровно граница»: дуга рисуется вписанной ломаной, то есть немного у́же
 * настоящего круга, и знак этой ошибки выбран «внутрь» — превью, обещающее
 * меньше настоящей зоны, игроку не врёт. Обе половины строятся по одним и тем
 * же точкам и встают в одну позу: разойдись они, граница фигуры двоилась бы.
 * Сами фигуры — разбор из определения и геометрия обеих половин — живут в
 * соседнем модуле (`abilityPreviewShape.ts`); подсистеме принадлежит кадр.
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
  SHAPE_CIRCLE,
  STEP_NONE,
  type AbilityCatalog,
  type CompiledAbility,
  type EntityId,
} from '@fluxus/core';
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
import { statOf, type AbilitySlotStatNames } from './abilitySlots.js';
import {
  circleGeometry,
  drawableShape,
  previewShapes,
  sectorGeometry,
  squareGeometry,
  type PreviewShape,
  type ShapeGeometry,
} from './abilityPreviewShape.js';

/** Подъём фигуры над полем: без него она тонет в ступени террейна (REND-7). */
const DEFAULT_LIFT = 0.05;
/**
 * Непрозрачность заливки по умолчанию: сквозь неё видно и поле, и то, что на
 * нём стоит, — превью накрывает зону, а не закрашивает её.
 */
const DEFAULT_FILL_OPACITY = 0.22;

/** Цвета превью — настройка сборки, а не норма: нормирован смысл, не палитра. */
export interface AbilityPreviewColors {
  /** Уже подтверждённый шаг: он состояние мира, и цвет у него спокойнее. */
  readonly confirmed: number;
  /** Текущий шаг — то, что игрок двигает прямо сейчас. */
  readonly current: number;
}

const DEFAULT_COLORS: AbilityPreviewColors = { confirmed: 0x6fa8ff, current: 0x8affc8 };

export interface AbilityPreviewOptions {
  /**
   * Слоты своего игрока в том виде, в каком их доставляет сборка. Пустой список
   * — доставки состояния слотов нет, и превью не рисуется вовсе.
   */
  readonly slots: readonly AbilitySlotStatNames[];
  /**
   * Источник визуальной поверхности (REND-9): по нему фигура ложится на рельеф.
   * Не задан — фигура лежит на нулевой высоте.
   */
  readonly surface?: VisualSurfaceSource;
  readonly colors?: Partial<AbilityPreviewColors>;
  /** Подъём над поверхностью; не задан — `DEFAULT_LIFT`. */
  readonly lift?: number;
  /** Непрозрачность заливки фигур; не задана — `DEFAULT_FILL_OPACITY`. */
  readonly fillOpacity?: number;
}

/**
 * Активный слот кадра: имена статов слота, РАЗРЕШЁННОЕ определение способности
 * и число подтверждённых шагов (ABIL-1). `null` в обоих полях — каста в этом
 * кадре не нашлось; запись переиспользуется и переживает такой кадр, поэтому
 * «идёт ли каст» отвечает `casting`, а не она.
 */
interface ActiveCast {
  names: AbilitySlotStatNames | null;
  ability: CompiledAbility | null;
  staged: number;
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
  private readonly fillOpacity: number;

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  private attached = false;

  /** Разделяемые геометрии и материалы: пер-фигурны только поза и масштаб (REND-3). */
  private circle: ShapeGeometry | null = null;
  private square: ShapeGeometry | null = null;
  /** Геометрии секторов по индексу шага: строятся один раз на шаг, не на кадр. */
  private readonly sectors = new Map<number, ShapeGeometry>();
  private confirmedMaterial: THREE.LineBasicMaterial | null = null;
  private currentMaterial: THREE.LineBasicMaterial | null = null;
  private confirmedFill: THREE.MeshBasicMaterial | null = null;
  private currentFill: THREE.MeshBasicMaterial | null = null;

  /**
   * Пулы фигур: заливок и контуров поровну — на индекс приходится пара, — и их
   * не больше, чем шагов у слота плюс текущий. Растут пулы только до этого
   * потолка: установившийся кадр не аллоцирует (REND-26).
   */
  private readonly lines: THREE.LineLoop[] = [];
  private readonly fills: THREE.Mesh[] = [];
  private used = 0;

  private view: TickView | null = null;
  /**
   * Локальный сэмпл во float — переиспользуемая запись, а не объект на кадр
   * (REND-26). `entity === NO_ENTITY` — сэмпла не было вовсе.
   */
  private readonly local = { entity: NO_ENTITY as EntityId, x: 0, y: 0, aiming: false };
  /**
   * Активный слот текущего кадра; та же причина держать запись — аллокации.
   * Определение способности лежит здесь РАЗРЕШЁННЫМ: индекс из доставленного
   * стата проверяется один раз, при поиске слота, а не при каждом чтении.
   */
  private readonly active: ActiveCast = { ability: null, staged: 0, names: null };
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
    this.fillOpacity = options.fillOpacity ?? DEFAULT_FILL_OPACITY;
    // Точка приёма каталога (REND-1): литералы определения становятся float
    // здесь и только здесь, глубже fixed-point в подсистеме нет.
    this.shapes = previewShapes(catalog);
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
    this.confirmedFill ??= this.fillMaterial(this.colors.confirmed);
    this.currentFill ??= this.fillMaterial(this.colors.current);
    // Группа в сцену не добавляется: пустое превью не меняет кадр ничем (REND-28).
  }

  /**
   * Снос подсистемы (REND-31): разделяемые геометрии фигур — круг, квадрат и
   * секторы шагов, построенные по одному разу на шаг, — и четыре общих
   * материала контуров и заливок. Пулы фигур своих ресурсов не держат: у меша
   * пула и геометрия, и материал разделяемые (REND-28).
   */
  dispose(): void {
    for (const shape of [this.circle, this.square, ...this.sectors.values()]) {
      shape?.fill.dispose();
      shape?.outline.dispose();
    }
    this.circle = null;
    this.square = null;
    this.sectors.clear();
    for (const material of [
      this.confirmedMaterial,
      this.currentMaterial,
      this.confirmedFill,
      this.currentFill,
    ]) {
      material?.dispose();
    }
    this.confirmedMaterial = null;
    this.currentMaterial = null;
    this.confirmedFill = null;
    this.currentFill = null;
    this.group.clear();
    this.lines.length = 0;
    this.fills.length = 0;
    this.used = 0;
    this.group.removeFromParent();
    this.attached = false;
  }

  /**
   * Материал заливки: та же палитра, что у контура (`this.colors`), — меняется
   * только плотность. Стороны обе: фигура лежит на рельефе, и с любой стороны
   * камеры это одна и та же зона; глубину заливка не пишет, чтобы не резать
   * ни контур над собой, ни то, что стоит в зоне.
   */
  private fillMaterial(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: this.fillOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  /** Доставленное состояние: из него берутся подтверждённые шаги (REND-28). */
  syncTick(view: TickView): void {
    this.view = view;
  }

  /**
   * Стоимость подсистемы объявлена КОНСТАНТНОЙ (`render-quality` QUAL-3, второй
   * сценарий), и ручек у неё нет.
   *
   * Превью рисуется одному игроку и одному его идущему касту: фигур в кадре не
   * больше, чем шагов у слота плюс текущий (`ABILITY_STEPS` + 1), сколько бы
   * сущностей, способностей и игроков ни было в сцене, и у каждой ровно две
   * половины — заливка и контур. Геометрии разделяются всеми фигурами,
   * материалов четыре на подсистему, а пулы растут до того же потолка и
   * переиспользуются. Снижать превью пресетом нельзя и по второму
   * основанию: это состав информации игрока — то, что заденет его способность,
   * — а он от качества картинки не зависит (QUAL-2).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [],
      constantCost:
        'превью рисуется одному игроку и одному его касту: фигур не больше ' +
        `${ABILITY_STEPS + 1} (заливка и контур у каждой) независимо от объёма контента, ` +
        'геометрии и материалы разделяемые; ' +
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
    // Пулы растут парами, поэтому индекс один и тот же на заливку и контур.
    for (let i = this.used; i < this.lines.length; i++) {
      this.fills[i]!.visible = false;
      this.lines[i]!.visible = false;
    }
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
      const index = statOf(owner, names.ability);
      // Отсутствие определения по индексу покрывает разом и «не целое», и
      // «вне таблицы»: каталог плотный, и другого способа не найтись у него нет.
      const ability = Number.isInteger(index) ? this.catalog.abilities[index] : undefined;
      if (ability === undefined) continue;
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
    const { names, ability } = this.active;
    const view = this.view;
    // Втроём они и есть условие рисования, проверенное `updateFrame`; читается
    // это здесь ещё раз потому, что сужение типов через вызов не переносится.
    if (names === null || ability === null || view === null) return;
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
    const yaw = Math.atan2(pointY - originY, pointX - originX);
    if (shape.kind === SHAPE_CIRCLE) {
      if (!shape.sector) {
        this.place(this.circle!, current, pointX, pointY, 0, shape.a, shape.a);
        return;
      }
      this.place(this.sector(index, shape.halfAngle), current, originX, originY, yaw, shape.a, shape.a);
      return;
    }
    if (!shape.directed) {
      this.place(this.square!, current, pointX, pointY, 0, shape.a, shape.b);
      return;
    }
    // Прямоугольник шага-вектора вытянут ВДОЛЬ направления, ближней гранью у
    // начала шага: так он читается отрезком от кастера, а не рамкой вокруг него.
    this.place(
      this.square!,
      current,
      originX + Math.cos(yaw) * shape.a,
      originY + Math.sin(yaw) * shape.a,
      yaw,
      shape.a,
      shape.b,
    );
  }

  /** Геометрии сектора шага: строятся один раз на шаг, а не на кадр (REND-26). */
  private sector(index: number, halfAngle: number): ShapeGeometry {
    let geometry = this.sectors.get(index);
    if (geometry === undefined) {
      geometry = sectorGeometry(halfAngle);
      this.sectors.set(index, geometry);
    }
    return geometry;
  }

  /**
   * Фигура из пулов в заданную позу: аллокаций на кадр нет (REND-26). Заливка и
   * контур встают в ОДНУ позу и берут один масштаб — расхождение читалось бы
   * двойной границей и обещало бы игроку не ту зону.
   */
  private place(
    geometry: ShapeGeometry,
    current: boolean,
    x: number,
    y: number,
    yaw: number,
    scaleX: number,
    scaleY: number,
  ): void {
    const slot = this.used++;
    if (this.lines[slot] === undefined) this.grow();
    const z = this.groundAt(x, y) + this.lift;
    const fill = this.fills[slot]!;
    fill.geometry = geometry.fill;
    fill.material = (current ? this.currentFill : this.confirmedFill)!;
    fill.position.set(x, y, z);
    fill.rotation.set(0, 0, yaw);
    fill.scale.set(scaleX, scaleY, 1);
    fill.visible = true;
    const line = this.lines[slot]!;
    line.geometry = geometry.outline;
    line.material = (current ? this.currentMaterial : this.confirmedMaterial)!;
    line.position.set(x, y, z);
    line.rotation.set(0, 0, yaw);
    line.scale.set(scaleX, scaleY, 1);
    line.visible = true;
  }

  /** Опорная высота под точкой: визуальная поверхность (REND-9), без неё — ноль. */
  private groundAt(x: number, y: number): number {
    const surface = this.options.surface?.current ?? null;
    return surface === null ? 0 : surface.heightAt(x, y);
  }

  /**
   * Ещё одна пара «заливка + контур» в пулы. Пулы растут только до потолка
   * цепочки — шагов слота плюс текущий, — и дальше кадр их переиспользует
   * (REND-26).
   */
  private grow(): void {
    const fill = new THREE.Mesh(this.circle!.fill, this.currentFill!);
    fill.name = 'previewFill';
    const line = new THREE.LineLoop(this.circle!.outline, this.currentMaterial!);
    line.name = 'preview';
    // Заливка рисуется ПЕРЕД контуром, и порядком всё и решается: глубину ни
    // та ни другой не пишут (`depthWrite: false`), так что z-борьбы между
    // половинами одной фигуры нет вовсе. Опускать заливку ниже контура
    // подъёмом было бы хуже — подъём выбран так, чтобы фигура не тонула в
    // ступени террейна (REND-7), и заниженная заливка ушла бы в поле.
    fill.renderOrder = 0;
    line.renderOrder = 1;
    // Превью — изображение, а не сущность: в picking оно не участвует
    // (REND-15), и луч сцены не видит ни заливки, ни контура.
    /* eslint-disable @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит» */
    fill.raycast = () => {};
    line.raycast = () => {};
    /* eslint-enable @typescript-eslint/no-empty-function */
    this.fills.push(fill);
    this.lines.push(line);
    this.group.add(fill, line);
  }

  /**
   * Решение кадра в переиспользуемую запись отладки (RDBG-2). Читается ровно то,
   * чем нарисован кадр, — активный слот, локальный сэмпл и пулы фигур; ни
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
    const { names, ability } = this.active;
    if (!this.casting || names === null || ability === null) {
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
