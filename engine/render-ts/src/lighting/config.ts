/**
 * Конфигурация освещения сцены — ДАННЫЕ, а не механизм (REND-29): секция
 * `lighting` парного presentation-документа (PRES-2), документированные
 * умолчания и их слияние. Живёт отдельно от подсистемы (`subsystems/lighting.ts`) по той же
 * причине, по которой политика живёт отдельно от механизма, и ровно тем же
 * швом, что конфигурация тумана (FOW-10): числа здесь правит дизайнер данными,
 * а подсистема ниже — их потребитель.
 *
 * Потолок пресета качества (QUAL-1) сюда не попадает намеренно: он ограничивает
 * ДЕЙСТВУЮЩЕЕ значение в подсистеме и авторскую секцию не трогает ни байтом.
 *
 * Умолчания списаны один в один с захардкоженного света, который до появления
 * подсистемы держали демо (`game/demo-ts/app/main.ts`) и вьюпорт редактора
 * (`editor/ui-ts/src/areas/sceneStage.ts`): сцена без секции обязана рисоваться
 * тем же кадром, что рисовалась.
 */
import type {
  PresentationHemisphereLight,
  PresentationLighting,
  PresentationLightingPhase,
  PresentationRimLight,
  PresentationShadowMode,
} from '@fluxus/assets';
import { PRESENTATION_SHADOW_MODES } from '@fluxus/assets';

/** Режим теней сцены — словарь формата, а не второй его перечень. */
export type ShadowMode = PresentationShadowMode;

/**
 * Значения полусферной подсветки с закрытыми дырами (REND-29). Отдельной
 * записью, а не тремя полями плоской конфигурации, ровно потому, что её
 * ОТСУТСТВИЕ — состояние: `undefined` вместо записи и есть «источника нет».
 */
export interface HemisphereConfig {
  /** Тон «неба», `#rrggbb`. */
  readonly skyColor: string;
  /** Тон «земли», `#rrggbb`. */
  readonly groundColor: string;
  readonly intensity: number;
}

/** Значения контрового источника с закрытыми дырами (REND-29). */
export interface RimConfig {
  readonly color: string;
  readonly intensity: number;
  /** Откуда светит: смещение позиции от цели — та же семантика, что у солнца. */
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
}

/**
 * Умолчания ПОЛЕЙ необязательных источников (REND-29). Написана подсекция —
 * автор источник захотел, и дыры её полей закрываются этими числами; не
 * написана — источника нет вовсе, и до умолчаний дело не доходит.
 *
 * Тона взяты нейтральными и симметричными сегодняшнему кадру: холодный верх и
 * тёплый низ — то, ради чего подсветка и заводится, а половинная интенсивность
 * держит её добавкой к рассеянному свету, а не его заменой. Контровой источник
 * светит «из-за спины сцены» — с противоположной солнцу стороны
 * (`DEFAULT_LIGHTING_CONFIG.direction*` со знаком минус по горизонтали), потому
 * что смысл его один: отделить силуэт от фона там, куда солнце не достаёт.
 */
export const DEFAULT_HEMISPHERE: HemisphereConfig = Object.freeze({
  skyColor: '#b4c8ff',
  groundColor: '#6b5a3a',
  intensity: 0.5,
} satisfies HemisphereConfig);

export const DEFAULT_RIM: RimConfig = Object.freeze({
  color: '#ffffff',
  intensity: 0.6,
  directionX: -8,
  directionY: 12,
  directionZ: 10,
} satisfies RimConfig);

/**
 * Действующая конфигурация освещения — секция `lighting` с закрытыми дырами.
 * Плоская: вложенность есть у авторского документа (там она группирует правку),
 * а подсистеме нужны значения, и лишний уровень она бы только разворачивала.
 */
export interface LightingRenderConfig {
  /** Тон рассеянного света, `#rrggbb`. */
  readonly ambientColor: string;
  /** Интенсивность рассеянного света. */
  readonly ambientIntensity: number;
  /** Тон направленного источника, `#rrggbb`. */
  readonly directionalColor: string;
  /** Суммарная интенсивность направленного источника — до деления на ярусы. */
  readonly directionalIntensity: number;
  /** Откуда светит источник: смещение его позиции от цели, мировые единицы. */
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  /**
   * Полусферная подсветка (REND-29) — либо её значения, либо `undefined`, и
   * `undefined` значит ОТСУТСТВИЕ ИСТОЧНИКА, а не «источник с нулём». Второго
   * способа записать «выключено» здесь нет намеренно: нулевой источник всё равно
   * жил бы в сцене и в униформах материалов, и сцена без подсекции перестала бы
   * рисоваться байт-в-байт как прежде.
   */
  readonly hemisphere: HemisphereConfig | undefined;
  /** Контровой источник (REND-29) — под тем же правилом «нет — значит нет». */
  readonly rim: RimConfig | undefined;
  /** Режим теней: `none` < `blob` < `hybrid` < `full` по стоимости (REND-30). */
  readonly shadowMode: ShadowMode;
  /** Сторона карты теней в текселях (REND-30). */
  readonly shadowMapSize: number;
  /**
   * Доля статики (REND-30): доля интенсивности, отданная кэшированной карте
   * статического яруса в `hybrid`; остальное достаётся покадровой карте
   * динамического. Вне `hybrid` карта либо одна, либо её нет, и доля не
   * применяется.
   */
  readonly staticShare: number;
}

/**
 * Документированные значения по умолчанию: свет работает и без секции
 * `lighting`. Ambient и направленный источник — ровно те числа, что до
 * появления подсистемы стояли в коде потребителей; тени по умолчанию выключены,
 * то есть сцена без секции платит за них ноль и выглядит как прежде.
 */
export const DEFAULT_LIGHTING_CONFIG: LightingRenderConfig = Object.freeze({
  ambientColor: '#ffffff',
  ambientIntensity: 0.65,
  directionalColor: '#ffffff',
  directionalIntensity: 1.7,
  directionX: 8,
  directionY: -12,
  directionZ: 18,
  // Ни полусферной подсветки, ни контрового источника у сцены без секции нет
  // (REND-29): их отсутствие — и есть сегодняшний кадр байт-в-байт.
  hemisphere: undefined,
  rim: undefined,
  shadowMode: 'none',
  // Половина типовой карты теней: у арены на десять игроков ортографический
  // фрустум обтягивает всю сетку, и 2048 текселей на её сторону — та плотность,
  // на которой кромка тени юнита ещё не пилится. Потолок пресета правит это
  // значение вниз (QUAL-1), вверх его правит только автор сцены.
  shadowMapSize: 2048,
  // Ровно пополам: в `hybrid` тень статики и тень динамики гасят по половине
  // вклада источника, и ни один ярус не выглядит нарисованным «поверх» другого.
  staticShare: 0.5,
} satisfies LightingRenderConfig);

/**
 * Ранг режима теней — его место в порядке стоимости (`none` < `blob` <
 * `hybrid` < `full`). Существует ради потолка пресета: `min` над перечислением
 * считается по рангу, и второго определения этого порядка быть не должно.
 */
export function shadowModeRank(mode: ShadowMode): number {
  return PRESENTATION_SHADOW_MODES.indexOf(mode);
}

/** Дешевейший из двух режимов — семантика `ceiling` над перечислением (QUAL-1). */
export function minShadowMode(a: ShadowMode, b: ShadowMode): ShadowMode {
  return shadowModeRank(a) <= shadowModeRank(b) ? a : b;
}

/**
 * Документированное умолчание длительности кроссфейда на границе фаз, секунды
 * (REND-32). Пятнадцать секунд — восьмая часть двухминутной фазы демо-арены: на
 * такой длине смена читается ходом времени, а не переключателем, и при этом
 * занимает малую долю круга. Число — умолчание, а не политика: свою длину
 * перехода сцена пишет полем `transitionSeconds`.
 */
export const DEFAULT_CYCLE_TRANSITION_SECONDS = 15;

/**
 * Доля слота самой короткой фазы, которой умолчание перехода ограничено сверху.
 *
 * Кроссфейд занимает хвост слота, поэтому переход длиной в слот не оставляет
 * фазе ни секунды собственного облика — цикл вырождается в непрерывный дрейф.
 * Авторское число на этой границе валидация отвергает адресно (PRES-2), но
 * НЕНАПИСАННОЕ отвергать нечего: умолчание обязано быть безопасным для сцены с
 * любыми длительностями, включая фазы короче пятнадцати секунд. Половина —
 * точка, где держание облика и переход равны: за ней фаза больше переходит, чем
 * держит, и перестаёт быть фазой. Автору, которому нужен переход длиннее,
 * достаточно написать его — там граница строже и проходит по слоту целиком.
 */
const DEFAULT_TRANSITION_SLOT_SHARE = 0.5;

/**
 * Значения света одной фазы цикла — плоские и с закрытыми дырами: поле, которого
 * фаза не назвала, приходит из статической части секции, а если и там его нет —
 * из умолчаний (REND-32, те же правила дыр, что PRES-2). Теневых полей здесь нет
 * намеренно: они принадлежат секции целиком и по кругу не ходят.
 */
export interface LightingPhaseConfig {
  /** Авторское имя фазы; пусто — имени автор не дал. Механизм имён не знает. */
  readonly name: string;
  /** Длительность фазы, секунды (положительная). */
  readonly seconds: number;
  readonly ambientColor: string;
  readonly ambientIntensity: number;
  readonly directionalColor: string;
  readonly directionalIntensity: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  /**
   * Значения полусферной подсветки на фазе (REND-32) — либо запись, либо
   * `undefined`, и `undefined` здесь значит ровно одно: подсветки нет у
   * СТАТИЧЕСКОЙ части секции. Завести источник фазой нельзя — валидация такой
   * документ отвергает адресно (PRES-2), а подсистеме, собранной руками,
   * отдаётся то же прочтение: нет в статике — нет и по кругу.
   */
  readonly hemisphere: HemisphereConfig | undefined;
  /** Значения контрового источника на фазе — под тем же правилом (REND-32). */
  readonly rim: RimConfig | undefined;
}

/** Действующий цикл времени суток: фазы по кругу и длина перехода (REND-32). */
export interface LightingCycleConfig {
  /** Длительность кроссфейда на границе фаз, секунды. */
  readonly transitionSeconds: number;
  /** Фазы в авторском порядке; не менее двух. */
  readonly phases: readonly LightingPhaseConfig[];
}

/** Значения одной фазы поверх статической части секции (REND-32). */
function resolvePhase(
  phase: PresentationLightingPhase,
  base: LightingRenderConfig,
): LightingPhaseConfig {
  const ambient = phase.ambient;
  const directional = phase.directional;
  const axes = directional?.direction;
  return {
    name: phase.name ?? '',
    seconds: phase.seconds,
    ambientColor: ambient?.color ?? base.ambientColor,
    ambientIntensity: ambient?.intensity ?? base.ambientIntensity,
    directionalColor: directional?.color ?? base.directionalColor,
    directionalIntensity: directional?.intensity ?? base.directionalIntensity,
    directionX: axes?.x ?? base.directionX,
    directionY: axes?.y ?? base.directionY,
    directionZ: axes?.z ?? base.directionZ,
    // Дыры фазы закрывает СТАТИЧЕСКАЯ ЧАСТЬ секции, а не умолчания подсветки:
    // источник у секции уже есть со своими числами, и фаза, назвавшая одну
    // интенсивность, обязана держать её тона (REND-32). Нет источника у
    // статики — нет его и у фазы: `base.hemisphere` тогда `undefined`, и
    // значения фазы отбрасываются вместе с ним.
    hemisphere:
      base.hemisphere === undefined
        ? undefined
        : resolveHemisphere(phase.hemisphere ?? {}, base.hemisphere),
    rim: base.rim === undefined ? undefined : resolveRim(phase.rim ?? {}, base.rim),
  };
}

/**
 * Подсекция цикла в действующие фазы (REND-32). Нет подсекции — нет и цикла:
 * сцена ведёт себя байт-в-байт как до его появления.
 *
 * Вырожденный цикл (меньше двух фаз, неположительная длительность) подсистеме не
 * отдаётся вовсе: валидация формата такой документ отвергает адресно (PRES-2), и
 * приспосабливаться к нему — значило бы заводить второе, необъявленное
 * прочтение данных. Действует тогда статическая часть секции.
 *
 * Написанную автором длительность перехода эта функция НЕ правит: слишком
 * длинную отвергает валидация, и подгонять принятое число значило бы рисовать не
 * то, что написано. Ограничивается только УМОЛЧАНИЕ — его валидация не видит
 * (`DEFAULT_TRANSITION_SLOT_SHARE`).
 */
export function resolveLightingCycle(
  section?: PresentationLighting,
): LightingCycleConfig | undefined {
  const cycle = section?.cycle;
  if (cycle === undefined || cycle.phases.length < 2) return undefined;
  if (cycle.phases.some((phase) => !(phase.seconds > 0) || !Number.isFinite(phase.seconds))) {
    return undefined;
  }
  const base = resolveLightingConfig(section);
  const shortest = Math.min(...cycle.phases.map((phase) => phase.seconds));
  const transition =
    cycle.transitionSeconds ??
    Math.min(DEFAULT_CYCLE_TRANSITION_SECONDS, shortest * DEFAULT_TRANSITION_SLOT_SHARE);
  return {
    transitionSeconds: transition >= 0 && Number.isFinite(transition) ? transition : 0,
    phases: cycle.phases.map((phase) => resolvePhase(phase, base)),
  };
}

/**
 * Подсекция полусферной подсветки в значения кадра (REND-29). Нет подсекции —
 * `undefined`: источника нет, и сцена рисуется прежним кадром.
 */
function resolveHemisphere(
  section: PresentationHemisphereLight | undefined,
  fallback: HemisphereConfig,
): HemisphereConfig | undefined {
  if (section === undefined) return undefined;
  return {
    skyColor: section.skyColor ?? fallback.skyColor,
    groundColor: section.groundColor ?? fallback.groundColor,
    intensity: section.intensity ?? fallback.intensity,
  };
}

/** Подсекция контрового источника в значения кадра (REND-29); нет — `undefined`. */
function resolveRim(
  section: PresentationRimLight | undefined,
  fallback: RimConfig,
): RimConfig | undefined {
  if (section === undefined) return undefined;
  const direction = section.direction;
  return {
    color: section.color ?? fallback.color,
    intensity: section.intensity ?? fallback.intensity,
    directionX: direction?.x ?? fallback.directionX,
    directionY: direction?.y ?? fallback.directionY,
    directionZ: direction?.z ?? fallback.directionZ,
  };
}

/** Секция документа поверх умолчаний: отсутствующее поле — умолчание (PRES-2). */
export function resolveLightingConfig(section?: PresentationLighting): LightingRenderConfig {
  const ambient = section?.ambient;
  const directional = section?.directional;
  const direction = directional?.direction;
  const shadows = section?.shadows;
  const fallback = DEFAULT_LIGHTING_CONFIG;
  return {
    ambientColor: ambient?.color ?? fallback.ambientColor,
    ambientIntensity: ambient?.intensity ?? fallback.ambientIntensity,
    directionalColor: directional?.color ?? fallback.directionalColor,
    directionalIntensity: directional?.intensity ?? fallback.directionalIntensity,
    directionX: direction?.x ?? fallback.directionX,
    directionY: direction?.y ?? fallback.directionY,
    directionZ: direction?.z ?? fallback.directionZ,
    hemisphere: resolveHemisphere(section?.hemisphere, DEFAULT_HEMISPHERE),
    rim: resolveRim(section?.rim, DEFAULT_RIM),
    shadowMode: shadows?.mode ?? fallback.shadowMode,
    shadowMapSize: shadows?.mapSize ?? fallback.shadowMapSize,
    staticShare: shadows?.staticShare ?? fallback.staticShare,
  };
}
