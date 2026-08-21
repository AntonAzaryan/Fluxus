/**
 * Отладочный источник превью каста (`abilityPreview.chain`, RDBG-1) — объявляет
 * его подсистема превью в точке своей регистрации (REND-27).
 *
 * ## Что он показывает
 *
 * Решение кадра, а не картинку: идёт ли каст своего игрока, какое это
 * определение, сколько шагов цепочки уже подтверждено, какой шаг игрок двигает
 * прямо сейчас, куда указывает локальный сэмпл ввода (REND-28) — и рисуема ли
 * фигура текущего шага вовсе. Последнее и есть ответ на «почему в кадре ничего
 * нет»: размер шага бывает выражением определения (ABIL-2), а мира у рендера нет
 * — такая фигура не рисуется, и превью, показавшее выдуманный радиус, врало бы
 * игроку.
 *
 * ## Границы
 *
 * Данные — те же два входа, что у самой подсистемы (REND-28): доставленное
 * состояние своего слота статами (HUD-8) и локальный сэмпл. Чужого прицеливания
 * здесь нет и быть не может (NET-15, RDBG-6) — у клиента его нет физически.
 * Готовность слота (остаток кулдауна) источник не показывает по той же причине:
 * сборка объявляет превью только `abilityId`, `phase`, `staged` и шаги, и
 * догаданный кулдаун был бы выдуманным значением (RDBG-6).
 *
 * Часовых величин у источника нет ни одной: сэмпл и доставленное состояние — то,
 * что уже лежит в подсистеме, а альфу интерполяции называет сам кадр (RDBG-7).
 * Два дампа на одном доставленном состоянии поэтому совпадают.
 */
import { STEP_NONE, STEP_POINT, STEP_UNIT, STEP_VECTOR } from '@game-mvp/core';
import type { DebugColor, DebugDraw, DebugProbe, DebugSource } from './contract.js';

/** Цвет отметки прицела: тон отладки, а не палитра самого превью. */
const AIM_COLOR: DebugColor = 0xffa040;
/** Радиус отметки, мировые единицы: она метка точки, а не фигура шага. */
const AIM_MARK_RADIUS = 0.25;

/**
 * Имена видов шага прицеливания (ABIL-5). Коды закрыты ядром, а читает дамп
 * человек и модель — поэтому в секции стоит имя, а не число.
 */
const STEP_KIND_NAMES = new Map<number, string>([
  [STEP_NONE, 'none'],
  [STEP_POINT, 'point'],
  [STEP_UNIT, 'unit'],
  [STEP_VECTOR, 'vector'],
]);

/**
 * Состояние превью на кадре — плоская запись, которую заполняет подсистема.
 * Запись ОДНА и переиспользуется между кадрами (RDBG-2): свежая на кадр была бы
 * мусором ради данных, которые дамп всё равно копирует.
 */
export interface DebugPreviewState {
  /** Слотов, объявленных сборкой (HUD-8); 0 — состояния слотов у превью нет. */
  slotCount: number;
  /** Сущность своего игрока из локального сэмпла; `NO_ENTITY` — сэмпла не было. */
  ownerEntity: number;
  /** Владелец найден в доставленном состоянии: без него рисовать не для кого. */
  ownerDelivered: boolean;
  /** Идущий каст своего игрока найден этим кадром (ABIL-1). */
  casting: boolean;
  /** `id` определения идущего каста; пусто — каста нет. */
  abilityId: string;
  /** Индекс слота в объявлении сборки; −1 — активного слота нет. */
  slotIndex: number;
  /** Шагов цепочки у определения (ABIL-5) и подтверждённых из них. */
  stepCount: number;
  stagedSteps: number;
  /** Индекс шага, который игрок двигает сейчас; −1 — цепочка добрана. */
  currentStepIndex: number;
  /** Код вида текущего шага (ABIL-5); имя ему даёт источник. */
  currentStepKind: number;
  /** Фигура текущего шага рисуема: размеры определения — литералы (REND-28). */
  currentStepDrawable: boolean;
  /** Прицеливание идёт: локальный сэмпл принёс точку. */
  aiming: boolean;
  /** Точка прицела, мировые единицы; `NaN` — точки нет. */
  aimWorldX: number;
  aimWorldY: number;
  /** Контуров нарисовано этим кадром и сценовых объектов у подсистемы. */
  shapeCount: number;
  objectCount: number;
}

export interface DebugAbilityPreviewProbe extends DebugProbe {
  /** Единицы величин прозой рядом с ними (RDBG-7). */
  readonly units: string;
  readonly slotCount: number;
  readonly ownerEntity: number;
  readonly ownerDelivered: boolean;
  readonly casting: boolean;
  readonly abilityId: string;
  readonly slotIndex: number;
  readonly stepCount: number;
  readonly stagedSteps: number;
  readonly currentStepIndex: number;
  /** Вид текущего шага именем: `point`, `unit`, `vector`, `none`. */
  readonly currentStepKind: string;
  readonly currentStepDrawable: boolean;
  readonly aiming: boolean;
  /** Точка прицела, мировые единицы; null — прицеливания нет. */
  readonly aimWorldX: number | null;
  readonly aimWorldY: number | null;
  readonly shapeCount: number;
  readonly objectCount: number;
}

/** Что источнику нужно от подсистемы превью — снимок её кадрового решения. */
export interface AbilityPreviewDebugAccess {
  /**
   * Состояние превью этого кадра в переданную запись. Подсистема заполняет ту
   * же запись каждый кадр (RDBG-2) и читает ТО ЖЕ, чем нарисован кадр: второго
   * расчёта решения у отладки нет.
   */
  state(out: DebugPreviewState): void;
}

/** «Величины нет» выражается null, а не нулём: ноль — это координата (RDBG-7). */
function aimOrNull(value: number, aiming: boolean): number | null {
  return aiming && Number.isFinite(value) ? value : null;
}

export function abilityPreviewChainDebugSource(
  access: AbilityPreviewDebugAccess,
): DebugSource<DebugAbilityPreviewProbe> {
  const state: DebugPreviewState = {
    slotCount: 0,
    ownerEntity: -1,
    ownerDelivered: false,
    casting: false,
    abilityId: '',
    slotIndex: -1,
    stepCount: 0,
    stagedSteps: 0,
    currentStepIndex: -1,
    currentStepKind: STEP_NONE,
    currentStepDrawable: false,
    aiming: false,
    aimWorldX: Number.NaN,
    aimWorldY: Number.NaN,
    shapeCount: 0,
    objectCount: 0,
  };
  // Переиспользуемая проба (RDBG-2): поля переписываются, объект живёт.
  const probe = {
    units:
      'aimWorld* — мировые единицы; ownerEntity — идентификатор сущности; ' +
      'stepCount, stagedSteps и currentStepIndex — шаги цепочки прицеливания (ABIL-5), не тики',
    slotCount: 0,
    ownerEntity: -1,
    ownerDelivered: false,
    casting: false,
    abilityId: '',
    slotIndex: -1,
    stepCount: 0,
    stagedSteps: 0,
    currentStepIndex: -1,
    currentStepKind: 'none',
    currentStepDrawable: false,
    aiming: false,
    aimWorldX: null as number | null,
    aimWorldY: null as number | null,
    shapeCount: 0,
    objectCount: 0,
    noData: undefined as string | undefined,
  };

  return {
    id: 'abilityPreview.chain',
    title: 'превью каста: цепочка шагов и точка прицела',
    probe(): DebugAbilityPreviewProbe {
      access.state(state);
      if (state.slotCount === 0) {
        probe.noData =
          'состояние слотов способностей сборкой не объявлено (HUD-8): превью не рисуется вовсе';
        return probe;
      }
      probe.noData = undefined;
      probe.slotCount = state.slotCount;
      probe.ownerEntity = state.ownerEntity;
      probe.ownerDelivered = state.ownerDelivered;
      probe.casting = state.casting;
      probe.abilityId = state.abilityId;
      probe.slotIndex = state.slotIndex;
      probe.stepCount = state.stepCount;
      probe.stagedSteps = state.stagedSteps;
      probe.currentStepIndex = state.currentStepIndex;
      probe.currentStepKind = STEP_KIND_NAMES.get(state.currentStepKind) ?? 'none';
      probe.currentStepDrawable = state.currentStepDrawable;
      probe.aiming = state.aiming;
      probe.aimWorldX = aimOrNull(state.aimWorldX, state.aiming);
      probe.aimWorldY = aimOrNull(state.aimWorldY, state.aiming);
      probe.shapeCount = state.shapeCount;
      probe.objectCount = state.objectCount;
      return probe;
    },
    draw(value: DebugAbilityPreviewProbe, out: DebugDraw): void {
      const x = value.aimWorldX;
      const y = value.aimWorldY;
      // Отметка ровно одна и ровно там, куда указывает сэмпл: фигуры шагов
      // рисует сама подсистема, и повторять их наложением значило бы красить
      // кадр вторым изображением того же (RDBG-5).
      if (x === null || y === null) return;
      out.circle(x, y, AIM_MARK_RADIUS, AIM_COLOR);
      out.disc(x, y, AIM_MARK_RADIUS / 3, AIM_COLOR);
    },
  };
}
