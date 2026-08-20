/* eslint-disable max-lines -- baseline */
/**
 * Подсистема моделей (REND-3..6, REND-20..22): пул инстансов по сущностям
 * presentation-состояния.
 *
 * Появление сущности в presentation-состоянии создаёт инстанс, исчезновение —
 * убирает. Разделяемая часть ассета (геометрия, клипы, материалы, запечённые
 * производные `assets` ASSET-12) строится один раз и кэшируется здесь; инстансу
 * принадлежит только его состояние — трансформ, скин, анимационная фаза.
 *
 * Наружу инстанс виден ПРЕОБРАЗОВАНИЕМ И ГРАНИЦАМИ, а не узлом сцены (REND-3):
 * объём-прокси picking'а (REND-15), подсветка (REND-16) и `instanceFor` отдают
 * числа. Узел — представление детального яруса, и обещать его наружу нельзя:
 * у батчевой записи (REND-20) его не существует.
 *
 * ## Два яруса (REND-20)
 *
 * Ярус выбирает ЗАПИСЬ МАНИФЕСТА (ASSET-13), а не код: батчевый достаётся всем,
 * кроме записей с процедурным контролем костей (REND-5), и явное поле записи
 * это переопределяет. Умолчание для записей, ЯРУС НЕ НАЗВАВШИХ, — ручка пресета
 * качества (`render-quality` QUAL-1, `declaredTier` ниже); авторского выбора и
 * требования механизма пресет не касается.
 *
 * - **батчевый**: запись в разделяемом `InstancedMesh` (`model/batch.ts`),
 *   скиннинг на GPU по VAT-текстуре модели (`model/vatMaterial.ts`), анимация —
 *   пара скаляров (`model/vatAnimation.ts`), скин — индекс слоя (REND-6).
 *   Пер-инстансного скелета, микшера и материалов нет;
 * - **детальный**: сегодняшнее поддерево со скелетом (`model/build.ts`) —
 *   для контроля костей и для записей, которым художник назначил его явно.
 *
 * Модель без запечённых производных рисуется ДЕТАЛЬНЫМ ярусом с предупреждением
 * один раз на модель: отсутствие запекания — деградация стоимости, а не отказ
 * отрисовки (REND-20). Всё наблюдаемое — состояния и one-shot клипы (REND-4),
 * скины (REND-6), посадка и наклон (REND-9, REND-10), смещение (REND-12), перёд
 * (REND-13), picking (REND-15) — у ярусов одинаково: машина состояний, поза и
 * границы считаются ОДНИМ кодом, различается только носитель.
 *
 * Инстансы, целиком вне пирамиды видимости камеры, гасятся (REND-21). Это
 * стоимость кадра и только она: набор, picking и сведение отсечения не видят.
 * Границы отсечения — консервативные по всем клипам (ASSET-12), а не по
 * bind-позе: выпад у края экрана не должен исчезать раньше юнита.
 *
 * Кто наполнил presentation-состояние — поток тиков или документный набор
 * инстансов редактора (REND-11), — подсистеме не видно и знать не положено:
 * вход у неё один, и правило жизненного цикла инстанса тоже одно (REND-3).
 * Поля, которые заполняет только набор (`clip`, `skin`, `scale`), на пути тика
 * приходят пустыми, и ветки под них не работают.
 *
 * ## Второй пул: decoration-инстансы (REND-18)
 *
 * Набор decoration приходит своим входом (`syncDecorations`) и живёт в СВОЁМ
 * пуле — рядом с пулом presentation-состояния, а не внутри него. Причина одна и
 * несущая: смена продюсера гасит presentation-состояние (REND-11), а декорации
 * гасить нельзя — сцена, которую автор украсил, украшена и в прогоне. Общий пул
 * означал бы, что «погасить набор ушедшего продюсера» и «оставить декорации» —
 * одно действие с двумя разными результатами.
 *
 * Рисуются они ТЕМ ЖЕ путём и теми же ветками: запись манифеста (ASSET-6,
 * ASSET-9), ярус записи (REND-20) с тем же `syncPool` и тем же батчем, скин
 * (REND-6), перёд (REND-13), посадка на визуальную поверхность (REND-9) и
 * наклон по её нормали (REND-10). Второго пути отрисовки не появляется — этого
 * требуют и REND-18, и REND-11. Разница ровно в том, чего у декорации нет:
 * вертикального смещения (REND-12), контроля костей (REND-5) и событийных
 * клипов (REND-4) — производить их не от чего.
 *
 * Сам манифест — второй вход подсистемы и тоже переподаваемый (REND-17): в
 * матче он приезжает загруженным ассетом один раз (ASSET-6), а редактор правит
 * его непрерывно (ED-14) и обязан показать результат не позже следующего кадра
 * (ED-15). Вход для этого один — `applyManifest`, декларативный по образцу
 * `TerrainSubsystem.applyGrid` и `DocumentSource.apply`: потребитель отдаёт
 * документ ЦЕЛИКОМ, а решать, что пересобрать, — дело подсистемы. Императивной
 * правки поля записи здесь нет по той же причине, по какой её нет у инстансов и
 * у сетки: картинка обязана быть функцией документа, а не истории вызовов.
 */
import * as THREE from 'three';
import {
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_ROLL,
  type EntityId,
} from '@game-mvp/core';
import {
  modelDerivatives,
  resolveEffectByKind,
  resolveLodThresholds,
  resolveSurfaceAlign,
  resolveVisual,
  resolveVisualEmitter,
  type AssetState,
  type BakedDerivatives,
  type BakedSkinSet,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
  type VisualTier,
} from '@game-mvp/assets';
import type {
  EntityView,
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  ShadowCasterSink,
  ShadowCasterTier,
  TickView,
} from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import type { DebugSource } from '../debug/contract.js';
import { modelsInstancesDebugSource, type DebugInstanceRow } from '../debug/modelsSource.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { SurfaceNormal, VisualSurface } from '../visualSurface.js';
import { createPickProxy, type InstanceProxySource, type PickProxy, type PickProxyVisitor } from '../picking.js';
import { orientFromTiltYaw, smoothTilt, tiltTarget, type TiltVector } from '../model/surfaceAlign.js';
import {
  buildSharedModel,
  createModelInstance,
  modelBounds,
  type ModelBounds,
  type ModelInstance,
  type SharedModelData,
} from '../model/build.js';
import {
  advanceFall,
  jumpArc,
  jumpBase,
  maneuverEnds,
  type ManeuverEnds,
} from '../model/verticalOffset.js';
import { AnimationController, MixerAnimationBackend } from '../model/animation.js';
import { VatAnimationBackend } from '../model/vatAnimation.js';
import { BoneControlState } from '../model/boneControl.js';
import { smoothYaw } from '../model/boneControl.js';
import { applySkin, skinTextureSources, type SkinApplication } from '../model/skins.js';
import { ModelBatch, batchLevels } from '../model/batch.js';
import { BatchSkinLoader, skinArrayTexture } from '../model/batchSkins.js';
import {
  VAT_MAP_KINDS,
  createSkinPlaceholder,
  createVatDepthMaterial,
  createVatMaterial,
  createVatTexture,
  materialMapKinds,
  type VatMapKind,
  type VatMaterial,
} from '../model/vatMaterial.js';

/**
 * Видимая поза инстанса (REND-3): преобразование, которым он нарисован в этом
 * кадре. Числа, а не узел сцены: узел — представление ДЕТАЛЬНОГО яруса, и у
 * батчевой записи (REND-20) его не существует.
 */
export interface InstancePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Кватернион ориентации `(x, y, z, w)`: курс поверх наклона по поверхности. */
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  /** Курс с поправкой переда записи (REND-13), радианы — он же в кватернионе. */
  readonly yaw: number;
  /** Масштаб набора инстансов (REND-11); масштаб записи уже внутри `bounds`. */
  readonly scale: number;
}

/**
 * Публичный вид инстанса — вход отладки, демо и тестов. Объект СТАБИЛЕН на всё
 * время жизни инстанса: им и наблюдается «инстанс тот же» при переподаче
 * манифеста (REND-17). Узла сцены здесь нет по тем же основаниям, что у
 * `PickProxy` (REND-3): наружу инстанс виден преобразованием и границами.
 */
export interface ModelInstanceView {
  readonly entity: EntityId;
  /** Инстанс — decoration (REND-18), а не сущность presentation-состояния. */
  readonly decoration: boolean;
  /**
   * Ярус, которым инстанс нарисован (REND-20). Не то же самое, что ярус записи:
   * модель без запечённых производных деградирует в детальный.
   */
  readonly tier: VisualTier;
  /** Модель детального яруса; null — батчевый ярус, она грузится либо записи нет. */
  readonly model: ModelInstance | null;
  readonly controller: AnimationController | null;
  /** В кадре стоит заглушка (ASSET-4), а не модель. */
  readonly placeholder: boolean;
  /** Инстанс попал в пирамиду видимости этого кадра (REND-21). */
  readonly visible: boolean;
  /** Выбранный уровень детализации (REND-22); 0 — модель как она есть. */
  readonly lodLevel: number;
  readonly pose: InstancePose;
  /** Габариты в осях инстанса; null — нарисованного нет, попадать не во что. */
  readonly bounds: ModelBounds | null;
}

export interface ModelsOptions {
  /** Тип события смерти — конвенция ядра. */
  readonly deathEvent?: string;
  /**
   * Тип события возрождения — то, чем снимается фиксация последнего кадра клипа
   * смерти (REND-4). Умолчания нет: смерть — конвенция ядра, а возрождение
   * описывает сцена, и назвать его вправе только сборка (в демо — `HeroRespawned`
   * системы `Respawn`). Не названо — путь снятия остаётся один, разрыв
   * непрерывности (REND-2).
   */
  readonly reviveEvent?: string;
  /** Тип события провала в клетку без пола (ARENA-5) — вход снижения (REND-12). */
  readonly fallEvent?: string;
  /** Длительность кроссфейда клипов, секунды (REND-4). */
  readonly crossfade?: number;
  /** Скорость доворота корпуса инстанса к курсу движения, 1/с. */
  readonly turnRate?: number;
  /** Источник визуальной поверхности — высота и наклон по рельефу (REND-9, REND-10). */
  readonly surface?: VisualSurfaceSource;
  /** Скорость сглаживания наклона по поверхности, 1/с (REND-10). */
  readonly tiltRate?: number;
  /**
   * Камера, которой рисуется кадр, — вход отсечения невидимых инстансов
   * (REND-21) и выбора уровня детализации (REND-22). Не задана — отсечения нет,
   * все инстансы остаются в кадре и рисуются нулевым уровнем: стоимость, а не
   * поведение, и сборка без камеры (тесты, headless) обязана рисовать то же.
   *
   * Камера приходит опцией подсистемы, а не контекстом (REND-8): контракт
   * подсистем от отсечения не меняется, а знать позу камеры нужно ровно ей.
   * Собирающий обязан посадить позу на камеру ДО кадра подсистем — тем же
   * `applyCameraPose`, которым рисуется кадр (CAM-1).
   */
  readonly camera?: THREE.Camera;
  /**
   * Запас консервативности границ отсечения — доля радиуса габаритов инстанса
   * (REND-21). Берётся ВСЕГДА, а не только там, где запечённых границ по клипам
   * нет (`assets` ASSET-12): границы bind-позы анимация выводит за себя, и без
   * запаса выпад у края экрана срезался бы вместе с мечом, — но и запечённые
   * границы описывают ровно позы клипов, а не оверлеи над инстансом (REND-16),
   * доворот костей (REND-5) и погрешность объемлющей сферы.
   */
  readonly cullMargin?: number;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
  /**
   * Приёмник теневых кастеров подсистемы освещения (REND-8). Подсистема моделей
   * — единственная, кто знает и происхождение инстанса (доставка против набора
   * декораций), и запись его вида, поэтому ярус кастера считает она, а что с
   * ним делать, решает свет. Нет приёмника — сцена без света: флагов теней
   * инстансы не получают вовсе.
   */
  readonly shadows?: ShadowCasterSink;
  /**
   * Длительность fade-out «ушла в туман» в секундах (FOW-8, design D7) — из
   * конфигурации тумана (FOW-10), а не константа кода. Ноль или отсутствие —
   * fade выключен, исчезновение убирает инстанс сразу (прежнее поведение;
   * сборка без тумана этой опции не передаёт).
   *
   * С ней исчезновение сущности из доставленного состояния БЕЗ события смерти
   * читается как «ушла в туман»: инстанс доживает до конца анимации угасания,
   * появление получает короткий fade-in, а `EntityDied` идёт существующим
   * путём смерти — рендер отличает туман от гибели (FOW-8).
   */
  readonly fadeSeconds?: number;
}

const DEFAULT_TURN_RATE = 12;
const DEFAULT_TILT_RATE = 10;
/**
 * Половина радиуса габаритов сверх них самих: столько добавляет отсечению
 * консервативности запас по умолчанию (REND-21). Порядок величины взят от
 * размаха обычного клипа — выпад руки с оружием у нормализованной по высоте
 * модели, — а не от вкуса: меньше половины радиуса срезало бы такой клип.
 */
const DEFAULT_CULL_MARGIN = 0.5;
/**
 * Ширина зоны нечувствительности выбора уровня (REND-22): порог срабатывает на
 * `±10%` от своего значения, и колебание экранного размера у порога не
 * переключает уровень кадр к кадру. Гистерезис — механизм, а сами пороги —
 * данные записи (ASSET-13); поэтому число здесь одно и относительное.
 */
const LOD_HYSTERESIS = 0.1;
/**
 * Ручки качества подсистемы (`render-quality` QUAL-1). Множитель порогов LOD —
 * прямое значение поверх ПОРОГОВ ЗАПИСИ (ASSET-13, REND-22): больше единицы —
 * уровень переключается раньше и треугольников в кадре меньше. Ярус по
 * умолчанию (REND-20) — тоже прямое значение: авторского источника у него нет,
 * умолчание живёт в коде, и пресет заменяет именно его.
 */
const MODELS_LOD_SCALE = 'models.lodThresholdScale';
const MODELS_DEFAULT_TIER = 'models.defaultTier';
/**
 * Ярус, которым рисуется запись, НЕ назвавшая его (REND-20, ASSET-13): пресет
 * правит ровно это умолчание. Явный ярус записи и вынужденный детальный у
 * процедурного контроля костей (REND-5) ему не подчиняются: первый — решение
 * автора, второй — требование механизма, и скелет батчевому ярусу взять
 * неоткуда. Со значением `'batched'` функция тождественна `resolveVisualTier`
 * ассетов, и умолчание пресета совпадает с ним же.
 */
function declaredTier(visual: EntityVisual | undefined, fallback: VisualTier): VisualTier {
  if (visual?.tier !== undefined) return visual.tier;
  return visual?.boneControls === undefined ? fallback : 'detailed';
}
/**
 * Перёд модели, когда запись манифеста его не называет (REND-13): соглашение
 * первого поддержанного формата — у MDX лицо вдоль `+X`, то есть 0. Так модели,
 * добавленные до появления параметра, не меняют вид.
 */
const DEFAULT_FACING_RAD = 0;
const DEG_TO_RAD = Math.PI / 180;
const PLACEHOLDER_COLOR = 0xd040d0;
/** Габариты заглушки (ASSET-4) — из них же строится её геометрия. */
const PLACEHOLDER_WIDTH = 0.4;
const PLACEHOLDER_HEIGHT = 0.9;
/**
 * Объём-прокси заглушки (REND-15). Границ модели у неё нет — она сама и есть
 * нарисованное, поэтому прокси производен от её геометрии, а не от размера,
 * назначенного picking'ом отдельно.
 */
const PLACEHOLDER_BOUNDS: ModelBounds = {
  minX: -PLACEHOLDER_WIDTH / 2,
  minY: -PLACEHOLDER_WIDTH / 2,
  minZ: 0,
  maxX: PLACEHOLDER_WIDTH / 2,
  maxY: PLACEHOLDER_WIDTH / 2,
  maxZ: PLACEHOLDER_HEIGHT,
};
/**
 * Объём-прокси эмиттерного вида (ASSET-14). Частиц подсистема моделей не рисует
 * — их рисует подсистема частиц (REND-24), — но ПОПАДАТЬ автор обязан и в них:
 * размещение факела — такая же запись `decorations`, как размещение статуи, и
 * выделять, двигать и удалять её во вьюпорте нужно тем же способом (REND-18,
 * ED-17). Источник объёмов-прокси при этом остаётся ОДИН (REND-15): подсистема
 * частиц в picking'е не участвует и участвовать не начинает.
 *
 * Размер фиксированный: у эмиттера нет ни модели, ни границ — облако частиц
 * меняет размер каждый кадр, и производить объём попадания от него значило бы
 * заводить мерцающую цель. Габариты — по заглушке (ASSET-4) в ширину и метр в
 * высоту: столько занимает на арене типовой факел, и в эту величину автор целит.
 */
const EMITTER_WIDTH = PLACEHOLDER_WIDTH;
const EMITTER_HEIGHT = 1;
const EMITTER_BOUNDS: ModelBounds = {
  minX: -EMITTER_WIDTH / 2,
  minY: -EMITTER_WIDTH / 2,
  minZ: 0,
  maxX: EMITTER_WIDTH / 2,
  maxY: EMITTER_WIDTH / 2,
  maxZ: EMITTER_HEIGHT,
};
/** Конвенция арены ядра (ARENA-5); имя переопределяется опцией. */
const DEFAULT_FALL_EVENT = 'FellThroughFloor';
/** Конвенция смерти ядра — та же, что у `AnimationController` (REND-4, FOW-8). */
const DEFAULT_DEATH_EVENT = 'EntityDied';
/**
 * Fade-in — доля длительности fade-out (FOW-8, design D7): появление «короткое»
 * по спеке, и отдельного поля конфигурации под него не заводится — половина
 * той же длительности, которой сущность угасает.
 */
const FADE_IN_RATIO = 0.5;

// Переиспользуемые между кадрами объекты — аллокаций на инстанс на кадр нет.
const SCRATCH_NORMAL: SurfaceNormal = { x: 0, y: 0, z: 1 };
const SCRATCH_TILT: TiltVector = { x: 0, y: 0 };
const SCRATCH_ENDS: ManeuverEnds = { takeoffX: 0, takeoffY: 0, landingX: 0, landingY: 0 };
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_SCALE = new THREE.Vector3();
/**
 * Геометрия и материал заглушки — общие на все заглушки процесса: заглушка у
 * них одна и та же (ASSET-4), и пер-инстансного в ней нет ничего. Строятся
 * лениво и не освобождаются вместе с инстансом — иначе следующая заглушка
 * строила бы их заново.
 */
let placeholderGeometry: THREE.BufferGeometry | null = null;
let placeholderMaterial: THREE.MeshStandardMaterial | null = null;
/** Заглушка массива вариантов скина — одна на процесс по тем же основаниям. */
let skinPlaceholder: THREE.DataArrayTexture | null = null;
/** Наименьшая высота нормализации модели — как у `createModelInstance`. */
const MIN_MODEL_HEIGHT = 1e-3;

/**
 * Закрытый словарь состояний анимации (REND-4). Какие состояния бывают —
 * контракт рендера; какой клип на состояние ложится — политика манифеста
 * (ASSET-6), поэтому имён клипов здесь нет и быть не может.
 */
const STATE_IDLE = 'idle';
const STATE_MOVE = 'move';
const STATE_FALL = 'fall';

/** Манёвр машины локомоушена (LOC-3) → состояние; вне таблицы — idle/move по скорости. */
const MOTION_STATE: Readonly<Record<number, string>> = {
  [LOCOMOTION_DODGE]: 'dodge',
  [LOCOMOTION_ROLL]: 'roll',
  [LOCOMOTION_AIRBORNE]: 'jump',
};

/**
 * Состояние анимации инстанса (REND-4): снижение при провале — состояние
 * рендера, манёвр — из машины локомоушена мира, всё остальное — по скорости.
 * Окно даблтапа (LOC-4) в таблице манёвров отсутствует намеренно: ввод в нём
 * рулит скоростью штатно, значит и анимация штатная.
 */
function animationStateOf(record: InstanceRecord): string {
  if (record.falling) return STATE_FALL;
  return MOTION_STATE[record.view.motion] ?? (record.view.moving ? STATE_MOVE : STATE_IDLE);
}

/**
 * Прыжок в этом кадре (REND-12): манёвр `Airborne` с читаемой фазой. Ветка
 * выбирается по манёвру, а не по флагу override уровня: override носят и
 * снаряды, и проваливающиеся сущности (ARENA-6), и им ступенчатая база уместна.
 */
function isAirborne(view: EntityView): boolean {
  return view.motion === LOCOMOTION_AIRBORNE && Number.isFinite(view.currMotionPhase);
}

/**
 * Высота дуги ЭТОГО манёвра (REND-12): прыжок и наземные манёвры называют свои
 * высоты независимо, и дуга одного вида к другому не применяется. Манёвр, для
 * чьего вида запись высоты не задала, дуги не получает — ноль здесь означает
 * «параметра нет», а не «подставить чужой».
 *
 * Гейт по виду манёвра, а не по одной высоте на всё: фаза манёвра (`REND-12`)
 * конечна и у `Dodge`/`Roll`, поэтому без него уклон ехал бы по прыжковой дуге.
 */
function arcHeightOf(record: InstanceRecord, motion: number): number {
  if (motion === LOCOMOTION_AIRBORNE) return record.jumpArcHeight;
  if (motion === LOCOMOTION_DODGE || motion === LOCOMOTION_ROLL) return record.maneuverArcHeight;
  return 0;
}

interface SharedEntry {
  data: SharedModelData | null;
  failed: string | null;
  /**
   * Текстуры САМОЙ модели на её разделяемых материалах (REND-3): ставятся один
   * раз на ассет, живут вместе с ним. Инстанс, чей скин ничего не подменяет,
   * рисуется ими и своей копии материала не заводит (REND-6).
   */
  baseSkin: SkinApplication | null;
  /**
   * Запечённые производные модели (ASSET-12) — один раз на ассет: VAT-текстура,
   * таблица клипов, консервативные границы, маска видимости частей. null — ещё
   * не спрашивали; `ok: false` — их нет, и запись деградирует в детальный ярус.
   */
  derivatives: BakedDerivatives | null;
  /** VAT-текстура модели: разделяется всеми её батчами (REND-3). */
  vatTexture: THREE.DataTexture | null;
  /** Об отсутствии производных уже предупредили — один раз на модель (REND-20). */
  warnedDerivatives: boolean;
  /** Инстансы, ждущие готовности ассета. */
  readonly waiting: Set<InstanceRecord>;
}

/**
 * Батч записей одной записи манифеста (REND-20): `InstancedMesh`-ы, материалы с
 * VAT-патчем и набор вариантов скина. Ключ включает запись, а не только модель,
 * потому что скины и скрытые части — свойства ЗАПИСИ: две записи на одну модель
 * с разными скинами не могут делить массив вариантов, а число батчей всё равно
 * растёт с числом записей, а не с числом инстансов.
 */
interface BatchEntry {
  readonly key: string;
  readonly batch: ModelBatch;
  readonly materials: readonly VatMaterial[];
  /**
   * Живой набор вариантов скина записи (REND-6). НЕ readonly: варианты — это
   * таблица `skins` записи, а её переподача манифеста меняет (REND-17), и
   * пересобрать массив слоёв иначе как заново нечем.
   */
  skins: BatchSkinLoader;
  /**
   * Таблица скинов, по которой собран текущий набор вариантов. Сравнивается
   * ПО ЗНАЧЕНИЮ: редактор отдаёт разобранный документ, и после любой правки
   * все объекты в нём новые (REND-17).
   */
  skinTable: EntityVisual['skins'] | undefined;
  /**
   * Массивы текстур, поставленные в материалы батча последним набором слоёв.
   * Принадлежат БАТЧУ, а не ассету (REND-3): пересборка набора освобождает их,
   * иначе каждая переподача манифеста оставляла бы за собой прежние слои.
   */
  readonly skinTextures: THREE.DataArrayTexture[];
  readonly model: NormalizedModel;
  /** Границы модели в канонических осях — до нормализации по высоте. */
  readonly canonical: ModelBounds;
  /** Консервативные границы по всем клипам (ASSET-12), те же оси. */
  readonly canonicalCull: ModelBounds;
  /** Множитель нормализации: масштаб записи, делённый на высоту модели. */
  normalized: number;
  /** Габариты записи в осях инстанса — общие на все её записи. */
  readonly bounds: ModelBounds;
  /** Границы отсечения записи в тех же осях (REND-21). */
  readonly cullBounds: ModelBounds;
  /** Пороги переключения уровней (ASSET-13, REND-22). */
  thresholds: readonly number[];
}

interface InstanceRecord {
  readonly entity: EntityId;
  readonly kind: string | null;
  /**
   * Инстанс — decoration (REND-18), а не сущность presentation-состояния.
   * Признак нужен снаружи (picking REND-15, подсветка REND-16): нумерация у
   * двух пулов своя, и одно число значит в них разные инстансы.
   */
  readonly decoration: boolean;
  /** Запись манифеста этого типа; переподача манифеста её меняет (REND-17). */
  visual: EntityVisual | undefined;
  view: EntityView;
  /**
   * Узел детального яруса и носитель заглушки (ASSET-4); null — записи в сцене
   * узла нет. У батчевой записи узла не существует (REND-20), и держать пустой
   * `Group` на каждую значило бы платить обходом сцены за то, чего в ней нет.
   */
  holder: THREE.Group | null;
  placeholder: THREE.Mesh | null;
  /**
   * Ключ записи разрешился в ЭМИТТЕРНЫЙ вид (ASSET-14): рисуют его частицы
   * (REND-24), а этот пул даёт ему только объём-прокси (`EMITTER_BOUNDS`) —
   * чтобы попадать в размещённый факел было чем (REND-15, REND-18).
   */
  emitter: boolean;
  /** Ярус, которым инстанс нарисован (REND-20) — с учётом деградации. */
  tier: VisualTier;
  model: ModelInstance | null;
  /** Батч записи и слот в нём; null — инстанс не батчевый (REND-20). */
  batch: BatchEntry | null;
  slot: number;
  /** Скалярный бэкенд батчевой записи — источник строк VAT кадра. */
  vat: VatAnimationBackend | null;
  /** Индекс варианта скина в наборе батча (REND-6). */
  skinIndex: number;
  /** Уровень детализации записи (REND-22); у детального яруса всегда 0. */
  lodLevel: number;
  /**
   * Консервативные границы по всем клипам модели (`assets` ASSET-12) в осях
   * инстанса — вход отсечения (REND-21). У батчевой записи их держит батч
   * (они общие на запись), у детальной — сам инстанс: масштаб записи у него
   * свой и переставляется на живом инстансе. null — производных у модели нет,
   * и отсечение идёт по габаритам bind-позы с запасом.
   */
  cullBounds: ModelBounds | null;
  controller: AnimationController | null;
  boneControl: BoneControlState | null;
  skinApp: SkinApplication | null;
  skin: string | undefined;
  /**
   * Скин выбран этому инстансу поимённо — полем набора (REND-11) или сменой
   * скина (REND-6), — а не взят из `defaultSkin` записи. Переподача манифеста
   * выбранного не отменяет (REND-17), а невыбранному отдаёт новый умолчательный.
   */
  skinChosen: boolean;
  /**
   * Скин и масштаб, назначенные presentation-состоянием (REND-11): хранятся,
   * чтобы отличить «набор поменял поле» от «набор им не правит вовсе». На пути
   * тика оба всегда `undefined`, поэтому `setSkin` остаётся единственным
   * источником скина и ничем не перебивается.
   */
  viewSkin: string | undefined;
  viewScale: number | undefined;
  /**
   * Видимое преобразование инстанса (REND-3): позиция, ориентация и масштаб
   * набора. Числа, а не узел сцены, — у батчевой записи узла нет, а посадку,
   * наклон и курс считает один и тот же `poseAll` для обоих ярусов.
   */
  readonly pos: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  scale: number;
  yaw: number;
  snapPending: boolean;
  /**
   * Поправка разворота инстанса, радианы (REND-13): курс сущности плюс она даёт
   * угол инстанса. Это ПРОТИВОПОЛОЖНОСТЬ переда модели из манифеста — чтобы
   * лицо, смотрящее под углом `f`, оказалось направлено по курсу, инстанс надо
   * довернуть на `−f`. Конверсия градусов и смена знака сделаны один раз при
   * приёме записи, а не в кадре.
   */
  facingOffset: number;
  /** Параметры наклона записи (ASSET-6): factor 0 выключает наклон. */
  tiltFactor: number;
  tiltMaxRad: number | null;
  /** Сглаженный наклон «ось × угол» (REND-10). */
  readonly tilt: TiltVector;
  /** Параметры вертикального смещения записи (ASSET-6); нули — смещения нет (REND-12). */
  jumpArcHeight: number;
  /** Высота дуги наземного манёвра (`Dodge`/`Roll`) — своя, не доля прыжковой. */
  maneuverArcHeight: number;
  /** Высота полётной дуги; применяется только при доставленной фазе полёта. */
  flightArcHeight: number;
  fallSpeed: number;
  fallDepth: number;
  /**
   * Снижение при провале — presentation-состояние инстанса: в мире состояния
   * «падает» нет, есть событие (ARENA-5). Живёт до разрыва непрерывности.
   */
  falling: boolean;
  fallOffset: number;
  /**
   * Инстанс уже получил позу кадра. До первого `updateFrame` он стоит в мировом
   * нуле, а не там, где сущность: попадание в него было бы попаданием в
   * ненарисованное (REND-15).
   */
  posed: boolean;
  /**
   * Инстанс попал в пирамиду видимости последнего кадра (REND-21). Без камеры
   * отсечения нет, и признак остаётся истинным: невидимых в таком кадре не
   * бывает.
   */
  visible: boolean;
  /**
   * Доля проявленности инстанса [0, 1] (FOW-8): множитель АЛЬФЫ кадра —
   * инстанс растворяется прозрачностью, а не стягиванием (стягивание читалось
   * как «враг уменьшается»). Единица — инстанс как обычно; меньше — fade-in
   * или fade-out. Масштаба, семантического и видимого, доля не касается.
   */
  fade: number;
  /**
   * Сущности больше нет в доставленном состоянии, а события смерти не было:
   * «ушла в туман», инстанс доживает fade-out и убирается по его концу (FOW-8).
   */
  fadingOut: boolean;
  /**
   * Меши держателя, чьи материалы на время fade подменены СВОИМИ копиями с
   * прозрачностью (FOW-8): разделяемые с ассетом материалы (REND-3, REND-6)
   * трогать нельзя. null — fade не идёт, у мешей разделяемые материалы.
   */
  fadedTargets: FadeTarget[] | null;
  /** Публичный вид инстанса; строится лениво и живёт с инстансом (REND-17). */
  publicView: ModelInstanceView | null;
}

/** Меш держателя и его РАЗДЕЛЯЕМЫЕ материалы, отложенные на время fade (FOW-8). */
interface FadeTarget {
  readonly mesh: { material: THREE.Material | THREE.Material[] };
  readonly original: THREE.Material | THREE.Material[];
}

/** Материалы меша списком — у three они бывают и одиночными, и массивом. */
function materialsOf(material: THREE.Material | THREE.Material[]): readonly THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

export class ModelsSubsystem implements RenderSubsystem, InstanceProxySource {
  readonly name = 'models';

  /** Текущий манифест визуалов (ASSET-6); переподаётся целиком (REND-17). */
  private manifest: VisualManifest;
  private readonly options: ModelsOptions;
  private readonly warn: (message: string) => void;
  private ctx: RenderContext | null = null;
  private readonly instances = new Map<EntityId, InstanceRecord>();
  /**
   * Пул decoration-инстансов (REND-18) — второй и независимый: смена продюсера
   * гасит `instances` и этого пула не касается.
   */
  private readonly decorations = new Map<EntityId, InstanceRecord>();
  private readonly shared = new Map<string, SharedEntry>();
  /**
   * Батчи по ключу записи (REND-20). Живут в кэше наравне с разделяемыми
   * данными ассета: опустевший батч не рисует ничего (`count` нулевой — draw
   * call'а нет), а следующий инстанс той же записи не собирает его заново.
   */
  private readonly batches = new Map<string, BatchEntry>();
  private readonly warnedKinds = new Set<string>();
  /** Переиспользуемая запись прокси обхода (REND-15): валидна внутри визита. */
  private readonly proxy: PickProxy = createPickProxy();
  /**
   * Переиспользуемое хозяйство отсечения (REND-21): пирамида, матрица кадра и
   * сфера инстанса. Аллокаций на кадр и на инстанс у отсечения нет — иначе оно
   * платило бы за себя тем же, что экономит.
   */
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();
  private readonly cullCenter = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  /** Метрика экранного размера камеры (REND-22) — снимается в неё каждый кадр. */
  private readonly screenScale: ScreenScale = { tanHalfFov: 0, orthoHeight: 0 };
  /** Множитель порогов LOD от пресета качества (QUAL-1, REND-22); 1 — пороги записи. */
  private lodScale = 1;
  /** Ярус записей, не назвавших его (QUAL-1, REND-20) — умолчание кода до пресета. */
  private defaultTier: VisualTier = 'batched';

  constructor(manifest: VisualManifest, options: ModelsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.warn = options.warn ?? ((message) => { console.warn(message); });
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемой террейна источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
  }

  /**
   * Снос подсистемы (REND-31). Порядок несущий: сперва инстансы обоих пулов
   * обычным удалением (REND-3) — с ними уходят fade-копии материалов, скины и
   * записи батчей, — затем сами батчи, и только потом разделяемые данные
   * ассетов. Обратный порядок сломал бы правило `ModelBatch.dispose`: батч
   * снимает чужие атрибуты с геометрии ассета ДО её освобождения (REND-3), и
   * освободи ассет раньше — снимать было бы уже не с чего.
   *
   * Источник поверхности и приёмник теневых кастеров приходят опцией сборки и
   * принадлежат ей: подсистема лишь сообщает им об ушедших объектах тем же
   * путём, каким сообщает в матче.
   */
  dispose(): void {
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) this.remove(record);
      pool.clear();
    }
    for (const entry of this.batches.values()) this.releaseBatch(entry);
    this.batches.clear();
    for (const entry of this.shared.values()) this.releaseShared(entry);
    this.shared.clear();
  }

  /**
   * Освобождает разделяемые данные ассета модели (REND-3): буферы геометрии её
   * частей, материалы ассета и VAT-текстуру, общую всем его батчам. Разобранный
   * ассет при этом остаётся в кэше модуля ассетов (ASSET-2) — он не наш, и
   * следующая сцена читает его оттуда, а не грузит заново.
   */
  private releaseShared(entry: SharedEntry): void {
    entry.baseSkin?.dispose();
    entry.baseSkin = null;
    entry.vatTexture?.dispose();
    entry.vatTexture = null;
    for (const mesh of entry.data?.meshes ?? []) mesh.geometry.dispose();
    for (const material of entry.data?.materials ?? []) material.dispose();
    entry.waiting.clear();
    entry.data = null;
  }

  // ------------------------------------------------------------- syncTick

  syncTick(view: TickView): void {
    const ctx = this.requireCtx();
    // Сток читается ОДИН раз на доставку и уходит вниз параметром (PERF-3):
    // проверять его на каждом инстансе значило бы платить за учёт ровно тем,
    // что он мерит. Без стока это одно сравнение на весь обход.
    const cost = costSink();
    // Разрыв непрерывности (REND-2) снимает необратимость смерти: перемотка
    // через момент смерти оживляет сущность в симуляции, а `EntityDied` в
    // прошлом не разэмитится — без этого живой персонаж навсегда остался бы
    // лежать нулевым кадром клипа смерти (REND-4, REND-25). Раньше сведения
    // пула: клип состояния этого же кадра ставится уже живому контроллеру.
    //
    // Возрождение ИДУЩЕГО мира сюда не попадает и попасть не может: сущность
    // та же, мир непрерывен, `snapAll` не поднимается — а прыжок на точку
    // спавна виден лишь пер-сущностным телепортом, который значит «не
    // интерполировать», а не «этот труп ожил». Снимает фиксацию названное
    // сборкой событие возрождения — ниже, общим разбором событий тика.
    if (view.snapAll) {
      for (const record of this.instances.values()) record.controller?.onSnap();
    }
    this.syncPool(ctx, this.instances, view.entities, false, view, cost);

    // События тика → one-shot клипы (REND-4); дедуп на потребителе (OBS-5):
    // при rewind/replay и на замороженных тиках события не переигрываются.
    if (view.freshEvents) {
      const fallEvent = this.options.fallEvent ?? DEFAULT_FALL_EVENT;
      for (const event of view.events) {
        const caster = event.data.entity ?? event.data.source;
        if (caster === undefined) continue;
        const record = this.instances.get(caster);
        if (record === undefined) continue;
        // Провал (ARENA-5) включает снижение и состояние `fall` (REND-12);
        // убьёт ли сущность геймплейная система или вернёт на арену —
        // рендеру неизвестно, и предвосхищать её решение он не пытается.
        if (event.type === fallEvent) {
          record.falling = true;
          record.controller?.setState(STATE_FALL);
        }
        record.controller?.handleEvent(event.type);
      }
    }
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Сведение — то же самое, что у
   * presentation-состояния: тот же `syncPool`, то же правило жизненного цикла
   * (REND-3), тот же выбор яруса (REND-20). Событий здесь не разбирается вовсе
   * — их у decoration нет, а не «пока никто не прислал».
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    this.syncPool(this.requireCtx(), this.decorations, entities, true, null, costSink());
    // Набор декораций переподан — статика могла переехать, и кэшированная карта
    // теней устарела вместе с ней. Вход событийный (REND-18), а не кадровый:
    // в матче он приходит однажды, в режиме правки — на правку (ED-15).
    this.options.shadows?.invalidateStatic();
  }

  /**
   * Сведение пула с поданным набором сущностей (REND-3): появившиеся создают
   * инстанс, исчезнувшие убирают, сохранившиеся обновляются. Одна реализация на
   * оба пула — второй разошёлся бы с первым, а REND-18 требует ровно того же
   * пути отрисовки, что REND-11.
   *
   * `view` приходит только от потока тиков и только он включает ветки fade
   * (FOW-8, design D7): у decoration-набора «ушла в туман» не бывает — его
   * записи не фильтруются видимостью вовсе (REND-18).
   */
  private syncPool(
    ctx: RenderContext,
    pool: Map<EntityId, InstanceRecord>,
    entities: ReadonlyMap<EntityId, EntityView>,
    decoration: boolean,
    view: TickView | null = null,
    cost?: RenderCostCounters,
  ): void {
    // Просмотр поданного набора — работа подсистемы на доставке (PERF-3),
    // растущая с числом сущностей и с числом декораций одинаково: путь у обоих
    // пулов один (REND-18). Снятие исчезнувших идёт ниже по пулу и своего поля
    // не имеет: в установившейся сцене пул равен поданному набору.
    if (cost !== undefined) cost.modelsInstancesSynced += entities.size;
    // Fade действует только на непрерывном ходе мира: разрыв (rewind, смена
    // продюсера, гашение набора пустым состоянием) убирает инстансы сразу —
    // плавное угасание нарисовало бы «уход в туман», которого не было (REND-2).
    const fadeSeconds = view !== null && !view.snapAll ? (this.options.fadeSeconds ?? 0) : 0;
    for (const entityView of entities.values()) {
      let record = pool.get(entityView.id);
      if (record === undefined) {
        record = this.create(ctx, entityView, decoration, fadeSeconds > 0);
        pool.set(entityView.id, record);
        if (cost !== undefined) cost.modelsInstancesCreated++;
      }
      // Сущность снова в доставленном состоянии: начатый fade-out отменяется,
      // проявление доигрывается от текущей доли — объект в кадре не мигает.
      record.fadingOut = false;
      record.view = entityView;
      record.snapPending ||= entityView.snap;
      // Разрыв непрерывности возвращает инстанс на поверхность (REND-12):
      // телепорт, респавн, rewind — снижение отменено, а не доигрывается.
      if (entityView.snap) {
        record.falling = false;
        record.fallOffset = 0;
      }
      // Скин и масштаб из набора инстансов (REND-11, REND-18): правка поля
      // обновляет существующий инстанс — материалы скина, фаза анимации и
      // сглаженный наклон при этом не теряются, потому что инстанс тот же.
      if (entityView.skin !== record.viewSkin) {
        record.viewSkin = entityView.skin;
        record.skinChosen = entityView.skin !== undefined;
        this.assignSkin(record, entityView.skin ?? record.visual?.defaultSkin);
      }
      if (entityView.scale !== record.viewScale) {
        record.viewScale = entityView.scale;
        record.scale = entityView.scale ?? 1;
      }
      this.applyAnimation(record);
      // Правка walkable-записи (позиция, курс, масштаб, сам флаг) доводит
      // walkable-вклад поля до нового размещения (REND-9, REND-18); правка
      // не-walkable полей (скин) реестр не трогает — вклад тот же.
      if (decoration) this.syncWalkable(record);
    }

    // Исчезнувшие: инстанс убирается, разделяемый ассет остаётся в кэше (REND-3).
    // С включённым fade исчезновение БЕЗ события смерти — «ушла в туман»
    // (FOW-8, NET-14): инстанс остаётся дожить fade-out; `EntityDied` того же
    // тика идёт существующим путём смерти — немедленное снятие, как и прежде.
    const died = fadeSeconds > 0 && view !== null ? diedIn(view, this.options.deathEvent) : null;
    for (const [entity, record] of pool) {
      if (entities.has(entity)) continue;
      if (fadeSeconds > 0 && died?.has(entity) !== true) {
        record.fadingOut = true;
        continue;
      }
      this.remove(record);
      pool.delete(entity);
    }
  }

  // ---------------------------------------------------------- updateFrame

  /**
   * Кадр подсистемы. `dt` — часы презентации СО ЗНАКОМ (REND-2, REND-25):
   * гейта «вне `Running` время вперёд не идёт» здесь нет и быть не должно —
   * его несёт сам знак, а режим мира подсистеме не виден вовсе (её одинаково
   * зовут оба продюсера presentation-состояния, REND-11). Стоящий мир приходит
   * нулевым dt, и клипы замирают ровно потому, что кадр их не двигает.
   */
  updateFrame(dt: number, alpha: number): void {
    const heightStep = this.requireCtx().config.heightStep;
    const turnRate = this.options.turnRate ?? DEFAULT_TURN_RATE;
    const tiltRate = this.options.tiltRate ?? DEFAULT_TILT_RATE;
    const surface = this.options.surface?.current ?? null;
    // Сток кадра — один раз на вход и вниз параметром (PERF-3), как на доставке.
    const cost = costSink();

    // Оба пула одним проходом и одними правилами: декорация в кадре автора и
    // декорация в кадре игрока обязаны быть одним изображением (REND-18).
    this.poseAll(this.instances, dt, alpha, heightStep, turnRate, tiltRate, surface, cost);
    this.poseAll(this.decorations, dt, alpha, heightStep, turnRate, tiltRate, surface, cost);

    // Доигравшие fade-out (FOW-8): анимация угасания кончилась — инстанс
    // убирается тем же `remove`, что и обычное исчезновение. После позы кадра:
    // последний кадр угасания ещё нарисован, а не пропущен.
    //
    // Обход идёт по значениям, а не по парам: итерация Map с деструктуризацией
    // заводит массив пары на КАЖДЫЙ инстанс каждого кадра, а ключ у записи и
    // так свой (`entity` — им её в пул и клали) — в установившемся кадре путь
    // не аллоцирует пропорционально инстансам.
    for (const record of this.instances.values()) {
      if (record.fadingOut && record.fade <= 0) {
        this.remove(record);
        this.instances.delete(record.entity);
      }
    }

    // Отсечение — после позы: видимость считается по тому преобразованию,
    // которым инстанс нарисован в ЭТОМ кадре (REND-21). Уровень детализации
    // считается там же — по экранному размеру того же объёма (REND-22).
    this.cullAll(cost);

    // Компактация видимых записей в инстанс-буферы — последним: до неё batch
    // не знает ни позы кадра, ни видимости.
    for (const entry of this.batches.values()) entry.batch.flush(cost);
  }

  /**
   * Отсечение невидимых инстансов (REND-21): консервативная сфера инстанса
   * против пирамиды видимости камеры. Невидимая запись не попадает в
   * компактацию батча, невидимый holder гасится — а из набора запись не
   * убирается: picking (REND-15) и сведение (REND-3, REND-18) идут по полному
   * набору, и других наблюдаемых последствий у отсечения нет.
   */
  private cullAll(cost: RenderCostCounters | undefined): void {
    const camera = this.options.camera;
    // Камеры нет — отсечения не существует вовсе (сборка без неё рисует всё), и
    // счётчики остаются нулевыми: приписывать кадру тесты, которых он не делал,
    // нельзя (PERF-3).
    if (camera === undefined) return;
    // Матрицы камеры — те, с которыми кадр и будет нарисован: позу на неё
    // сажает сборка до кадра подсистем (CAM-1), второго расчёта здесь нет.
    camera.updateMatrixWorld();
    this.frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    const margin = this.options.cullMargin ?? DEFAULT_CULL_MARGIN;
    const screen = screenScaleOf(camera, this.screenScale);
    this.cullPool(this.instances, margin, screen, cost);
    this.cullPool(this.decorations, margin, screen, cost);
  }

  private cullPool(
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    margin: number,
    screen: ScreenScale | null,
    cost: RenderCostCounters | undefined,
  ): void {
    for (const record of pool.values()) {
      const bounds = cullBoundsOf(record) ?? boundsOf(record);
      // Рисовать нечего — и отсекать нечего: невизуальная сущность в кадре не
      // участвует вовсе, а не «участвует невидимой».
      if (bounds === null || !record.posed) continue;
      const scale = record.scale;
      // Центр габаритов в осях инстанса → мировые оси тем же преобразованием,
      // которым инстанс нарисован; радиус — половина диагонали. Запас берётся
      // ВСЕГДА, а не только к границам bind-позы: консервативность запечённых
      // границ (ASSET-12) отвечает за позы клипов, но не за то, чего в границах
      // модели нет вовсе, — оверлеи (REND-16), контроль костей (REND-5) и
      // погрешность самой сферы у вытянутых моделей.
      this.cullCenter
        .set((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2)
        .multiplyScalar(scale)
        .applyQuaternion(record.quat)
        .add(record.pos);
      const radius =
        (Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2) *
        Math.abs(scale) *
        (1 + margin);
      this.cullSphere.center.copy(this.cullCenter);
      this.cullSphere.radius = radius;
      record.visible = this.frustum.intersectsSphere(this.cullSphere);
      // Сток уже в локальной переменной: на инстансе остаётся сравнение и
      // целочисленное сложение, а не чтение стока (PERF-3).
      if (cost !== undefined) {
        cost.modelsCullTests++;
        if (!record.visible) cost.modelsCulled++;
      }
      if (record.holder !== null) record.holder.visible = record.visible;
      if (record.batch !== null) {
        record.batch.batch.setVisible(record.slot, record.visible);
        if (record.visible && screen !== null) this.selectLod(record, radius, screen, cost);
      }
    }
  }

  /**
   * Уровень детализации записи по её экранному размеру (REND-22). Пороги —
   * данные записи (ASSET-13), гистерезис — механизм: у порога уровень не
   * дёргается кадр к кадру. Состояние записи переключение не трогает вовсе —
   * меняется только то, в какой набор инстанс-мешей она компактируется.
   */
  private selectLod(
    record: InstanceRecord,
    radius: number,
    screen: ScreenScale,
    cost: RenderCostCounters | undefined,
  ): void {
    const entry = record.batch;
    if (entry === null) return;
    const maxLevel = entry.batch.levelCount - 1;
    if (maxLevel <= 0) return; // модель без цепочки — единственный уровень
    // Счёт стоит ПОСЛЕ отказов выше: у записи без цепочки уровней работы нет, и
    // приписывать ей выбор значило бы считать несделанное (PERF-3).
    if (cost !== undefined) cost.modelsLodSelections++;
    const size = screenSize(radius, this.cameraPosition.distanceTo(record.pos), screen);
    const thresholds = entry.thresholds;
    // Множитель пресета (QUAL-1) сдвигает ПОРОГИ, а не экранный размер: пороги
    // остаются данными записи (ASSET-13), а пресет говорит, насколько раньше
    // или позже их читать. Гистерезис при этом свой — он про дрожание у порога,
    // а не про качество.
    const scale = this.lodScale;
    let level = Math.min(record.lodLevel, maxLevel);
    while (level < maxLevel && size < (thresholds[level] ?? 0) * scale * (1 - LOD_HYSTERESIS)) level += 1;
    while (
      level > 0 &&
      size > (thresholds[level - 1] ?? Number.POSITIVE_INFINITY) * scale * (1 + LOD_HYSTERESIS)
    ) {
      level -= 1;
    }
    record.lodLevel = level;
    entry.batch.setLevel(record.slot, level);
  }

  private poseAll(
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    dt: number,
    alpha: number,
    heightStep: number,
    turnRate: number,
    tiltRate: number,
    surface: VisualSurface | null,
    cost: RenderCostCounters | undefined,
  ): void {
    // Поза кадра — по одной записи на инстанс пула (PERF-2, стадия кадра): счёт
    // снимается разом с размера пула, а не инкрементом внутри цикла.
    if (cost !== undefined) cost.modelsPoseWrites += pool.size;
    // Сходящиеся к цели величины кадра — доворот (REND-5), наклон (REND-10),
    // контроль костей — берут МОДУЛЬ часов: направления у них нет, цель ведёт
    // доставленное состояние, и на обратном ходе сглаживание обязано идти к
    // ней, а не от неё (отрицательный шаг экспоненты уводил бы инстанс прочь).
    const settle = Math.abs(dt);
    const fadeSeconds = this.options.fadeSeconds ?? 0;
    for (const record of pool.values()) {
      // Fade идёт по кадрам, как снижение при провале (FOW-8, design D7):
      // угасание — полной длительностью конфига, проявление — короткое
      // (`FADE_IN_RATIO`). Модуль часов: направление задаёт состояние, а не
      // знак хода мира — на обратном ходе угасание не «проявляет» обратно.
      if (fadeSeconds > 0 && !record.decoration) {
        if (record.fadingOut) {
          record.fade = Math.max(0, record.fade - settle / fadeSeconds);
        } else if (record.fade < 1) {
          record.fade = Math.min(1, record.fade + settle / (fadeSeconds * FADE_IN_RATIO));
        }
      } else {
        record.fade = 1;
      }
      const view = record.view;
      // Интерполяция между двумя последними тиками; snap-тик рисуется без неё (REND-2).
      const t = view.snap ? 1 : alpha;
      const x = view.prevX + (view.currX - view.prevX) * t;
      const y = view.prevY + (view.currY - view.prevY) * t;
      // Walkable-инстанс сажается и наклоняется по террейн-форме — без
      // walkable-вкладов, в том числе чужих: иначе два моста сажались бы друг
      // на друга по кругу (REND-9). Все прочие читают поле целиком — юнит на
      // настиле стоит на настиле (REND-10).
      const walkableSeat = record.decoration && view.walkable === true;
      // Сущность на поверхности стоит на визуальной поверхности (рампы и
      // кривизна, REND-9); с override уровня (TERR-4) — на высоте уровня.
      // Летящая — на переходе между высотами отрыва и приземления (REND-12):
      // дискретный уровень под ней в высоте прыжка не участвует, иначе
      // пересечение границы обрыва сдвигало бы инстанс на ступень.
      let base: number;
      if (surface !== null && isAirborne(view)) {
        // Фаза манёвра до первого его тика — ноль: на том тике манёвра ещё не
        // было, и `prevMotionPhase` пришла как NaN.
        const phasePrev = Number.isFinite(view.prevMotionPhase) ? view.prevMotionPhase : 0;
        const phase = phasePrev + (view.currMotionPhase - phasePrev) * t;
        maneuverEnds(
          x,
          y,
          view.currX - view.prevX,
          view.currY - view.prevY,
          phase,
          view.currMotionPhase - phasePrev,
          SCRATCH_ENDS,
        );
        base = jumpBase(
          surface.heightAt(SCRATCH_ENDS.takeoffX, SCRATCH_ENDS.takeoffY),
          surface.heightAt(SCRATCH_ENDS.landingX, SCRATCH_ENDS.landingY),
          phase,
        );
      } else if (surface !== null && !view.levelOverride) {
        base = walkableSeat ? surface.terrainFormHeightAt(x, y) : surface.heightAt(x, y);
      } else {
        base = (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
      }
      // Вертикальное смещение — чистое представление (REND-12): дуга манёвра
      // смешивается по тем же двум тикам, что позиция, снижение идёт по кадрам.
      // Высота КАЖДОГО вклада берётся по виду манёвра ЕГО тика: прыжковая
      // высота к уклону не переносится, а тик приземления (манёвра уже нет)
      // доигрывает спуск прошлого тика вместо мгновенного обнуления.
      const arcPrev = jumpArc(view.prevMotionPhase, arcHeightOf(record, view.prevMotion));
      const arcCurr = jumpArc(view.currMotionPhase, arcHeightOf(record, view.motion));
      // Полётная дуга — по фазе полёта плоской формы (REND-12): её приносит
      // сборка воркера (SHELL-2), и без неё дуги нет независимо от манифеста.
      const flightArc = jumpArc(view.flightPhase, record.flightArcHeight);
      if (record.falling) {
        record.fallOffset = advanceFall(record.fallOffset, record.fallSpeed, record.fallDepth, dt);
      }
      record.pos.set(
        x,
        y,
        base + arcPrev + (arcCurr - arcPrev) * t + flightArc + record.fallOffset,
      );

      // Курс: цель из данных тика, доворот сглажен по кадрам; при snap —
      // мгновенно. Поправка на перёд модели — своя у каждой записи (REND-13).
      const targetYaw = view.facingYaw + record.facingOffset;
      record.yaw = record.snapPending
        ? targetYaw
        : smoothYaw(record.yaw, targetYaw, turnRate, settle);

      // Наклон по нормали поверхности (REND-10): только для сущностей на
      // поверхности; сглажен по кадрам, при snap — мгновенно (REND-2).
      if (surface !== null && record.tiltFactor > 0 && !view.levelOverride) {
        if (walkableSeat) surface.terrainFormNormalAt(x, y, SCRATCH_NORMAL);
        else surface.normalAt(x, y, SCRATCH_NORMAL);
        tiltTarget(SCRATCH_NORMAL, record.tiltFactor, record.tiltMaxRad, SCRATCH_TILT);
        if (record.snapPending) {
          record.tilt.x = SCRATCH_TILT.x;
          record.tilt.y = SCRATCH_TILT.y;
        } else {
          smoothTilt(record.tilt, SCRATCH_TILT, tiltRate, settle);
        }
      } else {
        record.tilt.x = 0;
        record.tilt.y = 0;
      }
      record.snapPending = false;
      record.posed = true;
      // Ориентация: сперва курс вокруг вертикали, поверх — наклон в мировых
      // осях. Композиция общая с walkable-реестром поля (REND-9): трансформ
      // walkable-поверхности — тот же, каким инстанс нарисован.
      orientFromTiltYaw(record.tilt, record.yaw, record.quat);

      // Анимационное время — единственное, что берёт ЗНАК: клип идёт вперёд,
      // стоит либо отматывается вместе с миром (REND-25).
      record.controller?.update(dt);
      this.applyPose(record, settle);
    }
  }

  /**
   * Видимое преобразование записи — в её носитель. Считается оно ОДНИМ кодом
   * для обоих ярусов (REND-20): узел детального яруса и инстанс-матрица
   * батчевого получают ровно те же числа, а не два похожих расчёта.
   */
  private applyPose(record: InstanceRecord, settle: number): void {
    // Fade (FOW-8) — прозрачность, а не масштаб: стягивание читалось как
    // «враг уменьшается». Доля одна на оба яруса (REND-20): батч несёт её
    // пер-инстансным атрибутом в альфу (`vatMaterial`), держатель — своими
    // копиями материалов на время fade (`applyHolderFade`). Масштаб кадра —
    // семантический `scale` записи (REND-11), без множителей.
    const drawScale = record.scale;
    this.applyHolderFade(record);
    const holder = record.holder;
    if (holder !== null) {
      holder.position.copy(record.pos);
      holder.quaternion.copy(record.quat);
      holder.scale.setScalar(drawScale);
    }
    // Bone-контроль строго после mixer.update и до отрисовки (REND-5).
    if (record.model !== null && record.boneControl !== null) {
      record.boneControl.apply(
        record.model,
        record.view.aimYaw,
        record.yaw - record.facingOffset,
        settle,
        this.warn,
      );
    }
    const entry = record.batch;
    if (entry === null) return;
    // Масштаб записи и нормализация по высоте у батча живут в ИНСТАНС-МАТРИЦЕ:
    // у детального яруса их несёт обёртка `body` внутри поддерева, здесь
    // поддерева нет — и множитель тот же самый. Fade едет отдельно (FOW-8).
    SCRATCH_SCALE.setScalar(drawScale * entry.normalized);
    SCRATCH_MATRIX.compose(record.pos, record.quat, SCRATCH_SCALE);
    entry.batch.setMatrix(record.slot, SCRATCH_MATRIX);
    entry.batch.setFade(record.slot, record.fade);
    const vat = record.vat;
    if (vat !== null) {
      entry.batch.setPose(record.slot, vat.rowA, vat.rowB, vat.blend, record.skinIndex);
      entry.batch.setFrame(record.slot, vat.visibilityFrame);
    }
  }

  /**
   * Fade держателя (FOW-8) — прозрачностью: материалы мешей разделяются с
   * ассетом (REND-3) и copy-on-write скинов (REND-6), поэтому на время fade
   * инстанс получает СВОИ копии с `transparent`, а по концу возвращает
   * разделяемые и копии освобождает. Программа шейдера та же — прозрачность
   * не перекомпилирует; копии появляются ровно на эпизод угасания.
   */
  private applyHolderFade(record: InstanceRecord): void {
    if (record.fade >= 1) {
      this.clearHolderFade(record);
      return;
    }
    const holder = record.holder;
    if (holder === null) return;
    if (record.fadedTargets === null) {
      const targets: FadeTarget[] = [];
      holder.traverse((node) => {
        // Узкий типизированный проход: `instanceof THREE.Mesh` дал бы Mesh<any>.
        const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
        if (mesh.isMesh !== true || mesh.material === undefined) return;
        const original = mesh.material;
        const clones = materialsOf(original).map((material) => {
          const clone = material.clone();
          clone.transparent = true;
          clone.userData.fadeBaseOpacity = clone.opacity;
          return clone;
        });
        mesh.material = Array.isArray(original) ? clones : clones[0]!;
        targets.push({ mesh: mesh as FadeTarget['mesh'], original });
      });
      record.fadedTargets = targets;
    }
    for (const target of record.fadedTargets) {
      for (const clone of materialsOf(target.mesh.material)) {
        clone.opacity = (clone.userData.fadeBaseOpacity as number) * record.fade;
      }
    }
  }

  /** Возврат разделяемых материалов мешам и освобождение fade-копий (FOW-8). */
  private clearHolderFade(record: InstanceRecord): void {
    const targets = record.fadedTargets;
    if (targets === null) return;
    record.fadedTargets = null;
    for (const target of targets) {
      for (const clone of materialsOf(target.mesh.material)) clone.dispose();
      target.mesh.material = target.original;
    }
  }

  // ------------------------------------------------------------ публичное

  /**
   * Ручки качества подсистемы (QUAL-1, QUAL-3): стоимость кадра растёт числом
   * инстансов, и обе ручки правят именно её — множитель порогов LOD (REND-22)
   * решает, сколько треугольников несёт один инстанс, ярус по умолчанию
   * (REND-20) — сколько стоит его носитель.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: MODELS_LOD_SCALE,
          cost: 'треугольники инстансов: множитель порогов переключения уровней детализации записи (REND-22, ASSET-13)',
          semantics: 'value',
          default: 1,
          // Только вверх от единицы: пресет вправе УДЕШЕВИТЬ картинку —
          // переключить инстанс на грубый уровень раньше, — но не обогатить её
          // сверх порогов автора (ASSET-13). Множитель меньше единицы держал бы
          // детальный уровень дальше, чем задумал автор записи, то есть
          // выправлял бы его данные пресетом. То же соображение, что у потолка
          // разрешения маски тумана (FOW-10): политика ограничивает авторское
          // значение в одну сторону, в другую — авторское значение и есть закон.
          min: 1,
          max: 8,
        },
        {
          name: MODELS_DEFAULT_TIER,
          cost: 'носитель инстанса: батчевый — общий InstancedMesh со скиннингом на GPU, детальный — пер-инстансный скелет, микшер и материалы (REND-20)',
          semantics: 'value',
          default: 'batched',
          values: ['batched', 'detailed'],
        },
      ],
    };
  }

  /**
   * Значения ручек от контроллера качества (QUAL-1). Множитель порогов доедет
   * ближайшим кадром сам — уровень выбирается в кадре (REND-22); смена яруса по
   * умолчанию пересобирает инстансы записей, ярус не назвавших, — это событие
   * уровня меню, а не кадра (design Risks): аллокационная дисциплина
   * кадрового пути ограничивает кадры, а не события.
   */
  applyQuality(values: QualityValues): void {
    const scale = values.get(MODELS_LOD_SCALE);
    if (typeof scale === 'number') this.lodScale = scale;
    const tier = values.get(MODELS_DEFAULT_TIER);
    if (tier === 'batched' || tier === 'detailed') this.applyDefaultTier(tier);
  }

  /**
   * Ярус по умолчанию на живой сцене (REND-20, QUAL-1). Пересобираются ровно
   * записи, ярус НЕ назвавшие: у явной записи и у контроля костей ярус свой, и
   * трогать их пресет не вправе. До `init` пересобирать нечего — инстансов ещё
   * нет, а ярус выберется при их создании.
   */
  private applyDefaultTier(next: VisualTier): void {
    if (next === this.defaultTier) return;
    this.defaultTier = next;
    const ctx = this.ctx;
    if (ctx === null) return;
    // Смена яруса — событие пресета, а не кадра (QUAL-1): сток читается один раз
    // на событие, и счётчик показывает ЦЕНУ переключения — сколько инстансов
    // пересобрано (PERF-3).
    const cost = costSink();
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) {
        if (record.kind === null) continue;
        if (record.visual?.tier !== undefined || record.visual?.boneControls !== undefined) continue;
        if (cost !== undefined) cost.modelsRebuilds++;
        this.rebuild(ctx, record);
      }
    }
  }

  /**
   * Смена скина инстанса без перезагрузки модели (REND-6): у детального яруса
   * подменяются текстуры его материалов, у батчевого — индекс варианта записи.
   * Возвращает false, если сущности нет.
   */
  setSkin(entity: EntityId, skin: string | undefined): boolean {
    const record = this.instances.get(entity);
    if (record === undefined) return false;
    // Скин назван поимённо: переподача манифеста его не отменит (REND-17).
    record.skinChosen = true;
    this.assignSkin(record, skin);
    return true;
  }

  /**
   * Правленый манифест визуалов целиком (ED-14, ED-15, REND-17). Подсистема
   * сводит поданное с живыми инстансами сама: пере-инициализировать её или
   * пересобирать сцену ради правки записи не нужно.
   *
   * Пересобирается инстанс ровно тогда, когда изменилось то, что строится из
   * разделяемых данных ассета (REND-3), — модель, набор её рисуемых частей и
   * ярус записи (REND-20); остальное записи применяется на месте, потому что
   * пересоздание потеряло бы материалы скина (REND-6), фазу анимации и
   * сглаженный наклон (REND-10) — ровно то, что перечисляет REND-11, запрещая
   * пересоздание.
   *
   * Записи, не изменившиеся в поданном документе, наблюдаемых последствий не
   * получают: сравниваются ЗНАЧЕНИЯ, а не ссылки, — редактор отдаёт разобранный
   * документ, и после любой правки все объекты в нём новые.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    const ctx = this.requireCtx();
    // Переподача — событие правки документа (REND-17, ED-15), и сток читается
    // один раз на неё: цена переподачи — число пересобранных инстансов (PERF-3).
    const cost = costSink();
    // Переподача действует на оба пула: раздел decoration-видов — такая же
    // часть манифеста (ASSET-9), и правка записи камня обязана доехать и до
    // размещённой декорации (REND-17, ED-15).
    this.resupply(ctx, this.instances, cost);
    this.resupply(ctx, this.decorations, cost);
    // Переподача — единственная точка, где ключи батчей устаревают, и она же
    // их пересматривает (REND-31): в матче её не зовут ни разу, и кэш батчей
    // ведёт себя ровно как прежде.
    this.retireBatches();
  }

  /**
   * Пересмотр кэша батчей на переподаче манифеста (REND-31): освобождается
   * батч, ключ которого ТЕКУЩИЙ манифест больше не порождает и в котором не
   * нарисовано ни одной записи. Ключ производен от авторских данных (модель ×
   * скрытые части × вид × ярус кастера), и без этого прохода каждая правка
   * модели или набора рисуемых частей записи оставляла бы за собой буферы
   * `InstancedMesh` навсегда.
   *
   * Достижимое множество считается ПО МАНИФЕСТУ, а не по живым записям: батч
   * вида, все инстансы которого сейчас сняты, остаётся в кэше — иначе правило
   * «опустевший батч переживает последнего пользователя» (REND-20) отменялось
   * бы с другой стороны. Оба яруса кастера берутся без разбора: ярус декорации
   * производен от наличия анимаций (REND-4), и второго места, где живёт то же
   * правило, заводить незачем — надмножество ошибается в безопасную сторону,
   * оставляя лишнее, а не освобождая нужное.
   */
  private retireBatches(): void {
    if (this.batches.size === 0) return;
    const reachable = new Set<string>();
    for (const kind of visualKinds(this.manifest)) {
      const visual = resolveVisual(this.manifest, kind);
      reachable.add(batchKey(visual, kind, 'static'));
      reachable.add(batchKey(visual, kind, 'dynamic'));
    }
    for (const [key, entry] of this.batches) {
      // Проверка на непустой батч — страховка вглубь, а не ветка со своим
      // случаем: сочетание «ключ недостижим, а записи в батче есть» не
      // построить — всё, из чего сложен ключ, переводит запись в другой батч
      // через `rebuildsInstance`, а запись, чей вид исчез из манифеста, из
      // батча уходит вовсе. Проверка стоит потому, что цена ошибки в множестве
      // достижимых ключей — погашенное нарисованное, а цена страховки — одно
      // сравнение на запись кэша.
      if (reachable.has(key) || entry.batch.count > 0) continue;
      this.releaseBatch(entry);
      this.batches.delete(key);
    }
  }

  /**
   * Освобождает запись кэша батчей (REND-31): живой набор вариантов скина,
   * массивы текстур слоёв, которые он поставил в материалы, и сам батч с его
   * геометриями и материалами. Массивы принадлежат БАТЧУ, а не ассету (REND-3),
   * поэтому уходят вместе с ним; разделяемые буферы модели не трогаются —
   * их снимает `ModelBatch.dispose` со своей геометрии и отдаёт кэшу ассетов.
   */
  private releaseBatch(entry: BatchEntry): void {
    entry.skins.dispose();
    for (const texture of entry.skinTextures) texture.dispose();
    entry.skinTextures.length = 0;
    entry.batch.dispose();
  }

  private resupply(
    ctx: RenderContext,
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    cost: RenderCostCounters | undefined,
  ): void {
    for (const record of pool.values()) {
      // Невизуальная сущность (резолвер отнёс её к нерисуемым) записи не имеет.
      if (record.kind === null) continue;
      const before = record.visual;
      record.visual = resolveVisual(this.manifest, record.kind);
      if (rebuildsInstance(before, record.visual, this.defaultTier, record.decoration)) {
        if (cost !== undefined) cost.modelsRebuilds++;
        this.rebuild(ctx, record);
        continue;
      }
      this.applyEntryParams(record);
      // Масштаб записи — нормализующая обёртка: переставляется на живом инстансе.
      record.model?.setScale(record.visual?.scale ?? 1);
      this.rescaleDetailedCull(record, null);
      this.syncBatchEntry(record);
      record.controller?.setMapping(record.visual?.animations ?? {});
      this.syncBoneControls(record);
      this.syncSkin(record, before);
      // Правка записи (масштаб, наклон, перёд) двигает и walkable-поверхность
      // вместе с картинкой (REND-17 → REND-9).
      if (record.decoration) this.syncWalkable(record);
    }
  }

  /**
   * Отладочный источник инстансов (`render-debug` RDBG-1, REND-27): объём-прокси
   * в видимой позе, признак отсечения по пирамиде (REND-21), уровень детализации
   * (REND-22) и ярус представления (REND-20).
   *
   * Обход тот же, что у прокси picking'а, — и это несущее: показывается ТА ЖЕ
   * поза, которой инстанс нарисован, а не второй её расчёт. Инкрементов
   * счётчиков стоимости здесь нет ни одного (RDBG-8): отладка читает уже
   * посчитанное кадром.
   */
  debugSources(): readonly DebugSource[] {
    return [
      modelsInstancesDebugSource({
        each: (out, visit) => {
          for (const record of this.instances.values()) {
            if (this.fillDebugRow(record, out)) visit();
          }
          // Декорации — после сущностей, тем же порядком, что у прокси (REND-18).
          for (const record of this.decorations.values()) {
            if (this.fillDebugRow(record, out)) visit();
          }
        },
      }),
    ];
  }

  /**
   * Инстанс в переиспользуемую запись отладки; false — рендер его не рисует.
   * Поза кладётся ТЕМ ЖЕ `fillProxy`, что и у picking'а (REND-15): запись
   * отладки и есть объём-прокси плюс решения кадра, второго заполнения нет.
   */
  private fillDebugRow(record: InstanceRecord, out: DebugInstanceRow): boolean {
    if (!this.fillProxy(record, out)) return false;
    out.tier = record.tier;
    out.lodLevel = record.lodLevel;
    out.visible = record.visible;
    out.placeholder = record.placeholder !== null;
    return true;
  }

  /**
   * Объёмы-прокси нарисованных инстансов — вход picking'а вьюпорта (REND-15) и
   * подсветки выделения (REND-16). Подсистема отдаёт ТО САМОЕ ПРЕОБРАЗОВАНИЕ,
   * которым инстанс нарисован в этом кадре, — посадка на визуальную поверхность
   * (REND-9), вертикальное смещение (REND-12), наклон (REND-10), курс с
   * поправкой переда (REND-13) и масштаб (REND-11) уже в нём. Пересчитывать их
   * второй раз было бы вторым ответом на один вопрос, а отдавать узлом — обещать
   * наружу то, чего у батчевой записи (REND-20) нет.
   *
   * Ни отсечение (REND-21), ни выбранный уровень детализации (REND-22) обход не
   * меняют: объём-прокси производен от границ МОДЕЛИ, а невидимый инстанс из
   * набора не исчезает — picking по нему промахивается лучом, а не отсутствием.
   */
  eachProxy(visit: PickProxyVisitor): void {
    for (const record of this.instances.values()) {
      if (this.fillProxy(record, this.proxy)) visit(this.proxy);
    }
    // Decoration-инстансы — после инстансов presentation-состояния (REND-18):
    // правило «первый в порядке набора» (REND-15) при двух наборах остаётся
    // определённым только заданным порядком обхода.
    for (const record of this.decorations.values()) {
      if (this.fillProxy(record, this.proxy)) visit(this.proxy);
    }
  }

  /**
   * Прокси одного инстанса; false — рендер его не рисует, попадать не во что.
   * `decoration` выбирает пул: нумерация у них своя, и одно число значит в них
   * разные инстансы (REND-18).
   */
  proxyOf(entity: EntityId, out: PickProxy, decoration = false): boolean {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    return record === undefined ? false : this.fillProxy(record, out);
  }

  /** Сколько decoration-инстансов нарисовано — по этому видно, что набор доехал. */
  get decorationCount(): number {
    return this.decorations.size;
  }

  /**
   * Диагностика батчевого яруса (REND-20): сколько батчей заведено, сколько
   * инстанс-мешей рисуется в этом кадре и сколько записей в них живёт. По ней и
   * видно главное свойство яруса — число draw calls растёт с числом ЗАПИСЕЙ
   * манифеста, а не с числом инстансов.
   */
  batchStats(): { readonly batches: number; readonly drawnMeshes: number; readonly records: number } {
    let drawnMeshes = 0;
    let records = 0;
    for (const entry of this.batches.values()) {
      drawnMeshes += entry.batch.drawnMeshes;
      records += entry.batch.count;
    }
    return { batches: this.batches.size, drawnMeshes, records };
  }

  /** Инстанс-меши всех батчей — вход теста компактации (`count` на меш). */
  batchMeshes(): readonly THREE.InstancedMesh[] {
    return [...this.batches.values()].flatMap((entry) => entry.batch.meshes);
  }

  /**
   * Попадание только в нарисованное (REND-15): у сущности, отнесённой резолвером
   * к невизуальным, нет ни модели, ни заглушки — и прокси у неё нет. Инстанс,
   * чья модель ещё грузится, участвует объёмом заглушки (ASSET-4): автор видит
   * её и вправе её двигать. Инстанс, созданный `syncTick` и ещё не получивший
   * позы кадра, не участвует: в кадре его нет.
   */
  private fillProxy(record: InstanceRecord, out: PickProxy): boolean {
    if (!record.posed) return false;
    const bounds = boundsOf(record);
    if (bounds === null) return false;
    out.entity = record.entity;
    out.decoration = record.decoration;
    out.handle = null;
    out.posX = record.pos.x;
    out.posY = record.pos.y;
    out.posZ = record.pos.z;
    out.quatX = record.quat.x;
    out.quatY = record.quat.y;
    out.quatZ = record.quat.z;
    out.quatW = record.quat.w;
    out.scaleX = record.scale;
    out.scaleY = record.scale;
    out.scaleZ = record.scale;
    out.minX = bounds.minX;
    out.minY = bounds.minY;
    out.minZ = bounds.minZ;
    out.maxX = bounds.maxX;
    out.maxY = bounds.maxY;
    out.maxZ = bounds.maxZ;
    return true;
  }

  /**
   * Инстанс сущности — для отладки и тестов. Объект стабилен на всё время жизни
   * инстанса: им и наблюдается «инстанс тот же», когда переподача манифеста
   * пересобирает построенное из ассета, а размещённый объект оставляет на месте
   * (REND-17). Узла сцены он не отдаёт (REND-3).
   */
  instanceFor(entity: EntityId, decoration = false): ModelInstanceView | null {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    if (record === undefined) return null;
    record.publicView ??= viewOf(record);
    return record.publicView;
  }

  // ------------------------------------------------------------ внутреннее

  private requireCtx(): RenderContext {
    if (this.ctx === null) throw new Error('ModelsSubsystem: init() не вызван (REND-8)');
    return this.ctx;
  }

  /** Скин инстанса: у детального — текстуры материалов, у батчевого — индекс (REND-6). */
  private assignSkin(record: InstanceRecord, skin: string | undefined): void {
    record.skin = skin;
    if (record.model !== null) this.applyInstanceSkin(record, record.model);
    const entry = record.batch;
    if (entry !== null) {
      // Смена скина батчевой записи — запись ОДНОГО ЧИСЛА: соседние записи
      // батча и разделяемый набор вариантов не затронуты (REND-6).
      record.skinIndex = entry.skins.indexOf(skin);
      entry.batch.setSkin(record.slot, record.skinIndex);
    }
  }

  /**
   * Величины записи, которые инстанс применяет покадрово: наклон (REND-10),
   * перёд (REND-13), вертикальное смещение (REND-12). Раскладываются в точке
   * приёма записи — при создании инстанса и при переподаче манифеста (REND-17),
   * — а не в кадре: конверсия градусов и разрешение дефолта манифеста делаются
   * один раз. Присваивание того же значения последствий не имеет по построению.
   */
  private applyEntryParams(record: InstanceRecord): void {
    const visual = record.visual;
    const align = resolveSurfaceAlign(this.manifest, visual);
    record.tiltFactor = align.factor;
    record.tiltMaxRad = align.maxAngleDeg === undefined ? null : (align.maxAngleDeg * Math.PI) / 180;
    // Перёд записи описан как направление лица модели; поправка разворота —
    // противоположный угол, см. `InstanceRecord.facingOffset`.
    record.facingOffset =
      visual?.facingDeg === undefined ? DEFAULT_FACING_RAD : -visual.facingDeg * DEG_TO_RAD;
    // Вертикальное смещение (REND-12) у decoration отсутствует: ни дуги прыжка,
    // ни снижения при провале — манёвров у него не бывает (REND-18). Запись с
    // этой секцией остаётся валидной (ASSET-9), но смысла ей здесь не придаётся.
    const offset = record.decoration ? undefined : visual?.verticalOffset;
    record.jumpArcHeight = offset?.jumpArc ?? 0;
    record.maneuverArcHeight = offset?.maneuverArc ?? 0;
    record.flightArcHeight = offset?.flightArc ?? 0;
    record.fallSpeed = offset?.fallSpeed ?? 0;
    record.fallDepth = offset?.fallDepth ?? 0;
  }

  /**
   * Параметры записи на живом батче (REND-17): масштаб и пороги LOD правятся
   * на месте — они не строятся из разделяемых данных ассета, и пересобирать
   * ради них записи батча незачем.
   */
  private syncBatchEntry(record: InstanceRecord): void {
    const entry = record.batch;
    if (entry === null) return;
    entry.thresholds = resolveLodThresholds(record.visual);
    this.syncBatchSkins(entry, record.visual);
    const normalized =
      (record.visual?.scale ?? 1) / Math.max(entry.model.height, MIN_MODEL_HEIGHT);
    if (normalized === entry.normalized) return;
    entry.normalized = normalized;
    scaleBounds(entry.canonical, normalized, entry.bounds);
    scaleBounds(entry.canonicalCull, normalized, entry.cullBounds);
  }

  /**
   * Набор вариантов скина батча после переподачи (REND-17, REND-6). Варианты —
   * свойство ЗАПИСИ, а не инстанса: новый вариант в таблице сдвигает сквозные
   * индексы, а правленый путь существующего меняет пиксели слоя, — и то и
   * другое пересобирает массив слоёв целиком, потому что собран он один раз на
   * батч (ASSET-12).
   *
   * Пересобирается РОВНО набор: позы записей батча, фазы их клипов и сглаженные
   * наклоны остаются на месте — пересборки инстансов здесь нет (REND-11).
   * Запись, чья таблица скинов не изменилась, не получает и этого: таблицы
   * сравниваются по значению, как и всё прочее в переподаче (REND-17).
   */
  private syncBatchSkins(entry: BatchEntry, visual: EntityVisual | undefined): void {
    if (sameSkinTables(entry.skinTable, visual?.skins)) return;
    entry.skinTable = visual?.skins;
    entry.skins.dispose();
    entry.skins = new BatchSkinLoader(
      entry.model,
      visual,
      this.requireCtx().assets,
      batchSkinListener(entry.model, entry.materials, entry.skinTextures),
    );
    // Сквозные индексы вариантов поехали — каждой записи батча заново (REND-6).
    // Записям, чей скин переподача ещё будет менять, индекс перепишет их
    // собственный `assignSkin`: он идёт после этого места и по тому же набору.
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) {
        if (record.batch !== entry) continue;
        record.skinIndex = entry.skins.indexOf(record.skin);
        entry.batch.setSkin(record.slot, record.skinIndex);
      }
    }
  }

  /** Параметры контроля костей записи на живом инстансе (REND-5, REND-17). */
  private syncBoneControls(record: InstanceRecord): void {
    // Процедурный контроль костей производен от цели атаки/каста (REND-5), а у
    // decoration её не бывает: роли записи на него не действуют (ASSET-9).
    const controls = record.decoration ? undefined : record.visual?.boneControls;
    if (controls === undefined) {
      // Роли сняты: пустая таблица заодно вернёт костям то, что было до override.
      record.boneControl?.setControls({});
      return;
    }
    if (record.boneControl === null) record.boneControl = new BoneControlState(controls);
    else record.boneControl.setControls(controls);
  }

  /**
   * Скин после переподачи (REND-17): выбранный поимённо остаётся, невыбранный
   * переезжает на `defaultSkin` новой записи. Текстуры переставляются заново
   * только если изменились подмены самого выбранного скина — правка чужого
   * скина этот инстанс не касается.
   */
  private syncSkin(record: InstanceRecord, before: EntityVisual | undefined): void {
    const skin = record.skinChosen ? record.skin : record.visual?.defaultSkin;
    if (skin !== record.skin) {
      this.assignSkin(record, skin);
      return;
    }
    if (record.model !== null && !sameSkinSlots(before, record.visual, skin)) {
      this.applyInstanceSkin(record, record.model);
    }
  }

  /**
   * Инстанс строится заново под новую запись (REND-3, REND-17). Поза и место в
   * наборе остаются те же: пересобирается то, что построено из разделяемых
   * данных ассета, а не размещённый объект — его идентичность в документе
   * (REND-11) и попадание picking'а (REND-15) переподачу переживают.
   */
  private rebuild(ctx: RenderContext, record: InstanceRecord): void {
    this.detachModel(record);
    this.applyEntryParams(record);
    if (!record.skinChosen) record.skin = record.visual?.defaultSkin;
    this.attachVisual(ctx, record);
    // Другая модель записи: до её готовности walkable-вклада нет (ASSET-4,
    // REND-9) — кэшированный ассет вернёт его сразу же через attachModel.
    if (record.decoration) this.syncWalkable(record);
  }

  /**
   * Анимация инстанса: состояние из presentation-состояния (REND-4) и клип,
   * назначенный набором инстансов поверх него (REND-11). На пути тика клип не
   * назначается никогда, и override остаётся снятым.
   */
  private applyAnimation(record: InstanceRecord): void {
    const controller = record.controller;
    if (controller === null) return;
    controller.setState(animationStateOf(record));
    controller.setClipOverride(record.view.clip);
  }

  private create(
    ctx: RenderContext,
    view: EntityView,
    decoration: boolean,
    fadeIn = false,
  ): InstanceRecord {
    // Разрешение ключа — одно на оба раздела манифеста (ASSET-9): decoration
    // вправе сослаться и на запись сущности, если камень у неё и prop, и
    // декорация, — второй копии записи для этого не заводится.
    const visual = view.kind === null ? undefined : resolveVisual(this.manifest, view.kind);
    const record: InstanceRecord = {
      entity: view.id,
      kind: view.kind,
      decoration,
      visual,
      view,
      holder: null,
      placeholder: null,
      emitter: false,
      tier: 'detailed',
      model: null,
      batch: null,
      slot: -1,
      vat: null,
      skinIndex: 0,
      lodLevel: 0,
      cullBounds: null,
      controller: null,
      boneControl: null,
      skinApp: null,
      skin: view.skin ?? visual?.defaultSkin,
      skinChosen: view.skin !== undefined,
      viewSkin: view.skin,
      viewScale: view.scale,
      // Масштаб набора — множитель поверх масштаба записи манифеста (REND-11):
      // запись масштабирует модель, набор — конкретное размещение.
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: view.scale ?? 1,
      facingOffset: DEFAULT_FACING_RAD,
      yaw: 0,
      snapPending: true,
      tiltFactor: 0,
      tiltMaxRad: null,
      tilt: { x: 0, y: 0 },
      jumpArcHeight: 0,
      maneuverArcHeight: 0,
      flightArcHeight: 0,
      fallSpeed: 0,
      fallDepth: 0,
      falling: false,
      fallOffset: 0,
      posed: false,
      visible: true,
      // Появление в наборе с включённым fade — короткий fade-in (FOW-8): вышла
      // ли сущность из тумана или только что заспавнилась, доставленное не
      // различает (NET-14), и мягкое проявление честно для обоих прочтений.
      fade: fadeIn && !decoration ? 0 : 1,
      fadedTargets: null,
      fadingOut: false,
      publicView: null,
    };
    this.applyEntryParams(record);
    record.yaw = view.facingYaw + record.facingOffset;

    this.attachVisual(ctx, record);
    return record;
  }

  /**
   * Заглушка и модель записи для инстанса, у которого их ещё (или уже) нет:
   * общая часть создания инстанса и его пересборки под новой записью (REND-17).
   */
  private attachVisual(ctx: RenderContext, record: InstanceRecord): void {
    record.emitter = false;
    const kind = record.kind;
    // Резолвер явно отнёс сущность к невизуальным — не рисуем и не шумим.
    if (kind === null) return;

    const visual = record.visual;
    if (visual === undefined) {
      // Тип, который манифест описал записью ЭФФЕКТА (REND-23), рисуется не
      // моделью — и заглушки ему не полагается: заглушка означает «ассет ещё не
      // доехал» (ASSET-4), а тут доезжать нечему. Молчит подсистема по той же
      // причине: запись в манифесте есть, просто не её.
      if (resolveEffectByKind(this.manifest, kind) !== undefined) return;
      // Ровно то же и по той же причине — эмиттерный вид (ASSET-14): его
      // изображение частицы, и рисует его подсистема частиц (REND-24).
      // `resolveVisual` отдаёт по такому ключу пусто НАМЕРЕННО — чтобы
      // подсистема моделей не рисовала того, чего ей рисовать нечем; принять
      // это за отсутствующую запись значило бы поставить на факел заглушку.
      // Объём-прокси такой записи, однако, даёт всё-таки этот пул: источник
      // прокси один (REND-15), а попадать в размещённый факел автор обязан
      // тем же способом, что в статую (REND-18, ED-17).
      if (resolveVisualEmitter(this.manifest, kind) !== undefined) {
        record.emitter = true;
        return;
      }
      // Сущность без записи в манифесте: заглушка и предупреждение один раз (ASSET-6).
      if (!this.warnedKinds.has(kind)) {
        this.warnedKinds.add(kind);
        this.warn(`render: для типа "${kind}" нет записи в манифесте визуалов — заглушка (ASSET-6)`);
      }
      this.makePlaceholder(ctx, record);
      return;
    }

    // Модель грузится асинхронно; до готовности — заглушка (ASSET-4).
    this.makePlaceholder(ctx, record);
    const entry = this.ensureShared(ctx, visual.model);
    if (entry.data !== null) {
      this.attachModel(record, entry.data);
    } else if (entry.failed === null) {
      entry.waiting.add(record);
    }
  }

  /**
   * Узел записи в сцене: носитель заглушки и корень детального яруса. Заводится
   * ЛЕНИВО и снимается, как только оба исчезли: у батчевой записи узла в сцене
   * нет (REND-20), и пустой `Group` на каждую значил бы обход сцены за то,
   * чего в ней не рисуется.
   */
  private ensureHolder(ctx: RenderContext, record: InstanceRecord): THREE.Group {
    if (record.holder !== null) return record.holder;
    const holder = new THREE.Group();
    holder.name = `${record.decoration ? 'decoration' : 'entity'}:${record.entity}`;
    holder.position.copy(record.pos);
    holder.quaternion.copy(record.quat);
    holder.scale.setScalar(record.scale);
    ctx.scene.add(holder);
    record.holder = holder;
    this.markCaster(record);
    return holder;
  }

  private releaseHolder(record: InstanceRecord): void {
    if (record.holder === null || record.model !== null || record.placeholder !== null) return;
    this.options.shadows?.dropCaster(record.holder);
    record.holder.removeFromParent();
    record.holder = null;
  }

  /**
   * Корень нарисованного инстанса — приёмнику теней вместе с ярусом (REND-8).
   * Корень, а не каждый меш: флаги расставляет обходом сам приёмник, а сменить
   * их у поддерева, которое ещё только строится, здесь было бы нечем.
   */
  private markCaster(record: InstanceRecord): void {
    const sink = this.options.shadows;
    if (sink === undefined) return;
    const root = record.batch?.batch.group ?? record.holder;
    if (root !== null) sink.setCaster(root, casterTierOf(record));
  }

  /**
   * Заглушка инстанса (ASSET-4). Геометрия и материал у всех заглушек ОБЩИЕ:
   * пер-инстансного в заглушке нет ничего, а своя пара на инстанс — это лишний
   * буфер и лишний материал на каждую незагруженную модель.
   */
  private makePlaceholder(ctx: RenderContext, record: InstanceRecord): void {
    if (placeholderGeometry === null) {
      const geometry = new THREE.BoxGeometry(PLACEHOLDER_WIDTH, PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT);
      geometry.translate(0, 0, PLACEHOLDER_HEIGHT / 2); // стоит на земле, а не тонет в ней
      placeholderGeometry = geometry;
    }
    placeholderMaterial ??= new THREE.MeshStandardMaterial({ color: PLACEHOLDER_COLOR });
    const mesh = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
    this.ensureHolder(ctx, record).add(mesh);
    record.placeholder = mesh;
  }

  private ensureShared(ctx: RenderContext, modelId: string): SharedEntry {
    const existing = this.shared.get(modelId);
    if (existing !== undefined) return existing;
    const entry: SharedEntry = {
      data: null,
      failed: null,
      baseSkin: null,
      derivatives: null,
      vatTexture: null,
      warnedDerivatives: false,
      waiting: new Set(),
    };
    this.shared.set(modelId, entry);

    const handle = ctx.assets.request<NormalizedModel>('model', modelId);
    const onState = (state: AssetState<NormalizedModel>): void => {
      if (entry.data !== null) return;
      if (state.status === 'ready') {
        // Разделяемая часть строится один раз на ассет (REND-3), запечённые
        // производные — тоже (ASSET-12): десять инстансов не запекают ничего
        // по десять раз, кэш живёт в модуле ассетов по идентичности модели.
        const data = buildSharedModel(state.data);
        entry.data = data;
        entry.failed = null;
        const baked = modelDerivatives(state.data);
        if (baked.ok) {
          entry.derivatives = baked.derivatives;
        } else if (!entry.warnedDerivatives) {
          entry.warnedDerivatives = true;
          this.warn(
            `render: у модели "${modelId}" нет запечённых производных (${baked.reason}) — детальный ярус (REND-20)`,
          );
        }
        for (const record of entry.waiting) this.attachModel(record, data);
        entry.waiting.clear();
      } else if (state.status === 'failed' && entry.failed !== state.reason) {
        entry.failed = state.reason;
        this.warn(`render: модель "${modelId}" не загрузилась: ${state.reason} — остаётся заглушка (ASSET-4)`);
      }
    };
    onState(ctx.assets.state(handle));
    ctx.assets.subscribe(handle, onState);
    return entry;
  }

  /**
   * Ярус записи (REND-20, ASSET-13) с учётом деградации: батчевый требует
   * запечённых производных модели (ASSET-12), и без них запись рисуется
   * детальным ярусом — предупреждение о них выдано один раз на модель там же,
   * где производные и спрашивались.
   */
  private tierOf(record: InstanceRecord, shared: SharedEntry): VisualTier {
    if (declaredTier(record.visual, this.defaultTier) === 'detailed') return 'detailed';
    return shared.derivatives === null ? 'detailed' : 'batched';
  }

  private attachModel(record: InstanceRecord, shared: SharedModelData): void {
    if (record.model !== null || record.batch !== null) return;
    // Смена содержимого держателя (заглушка → модель): fade-копии материалов
    // привязаны к прежним мешам — вернуть разделяемые и освободить копии;
    // идущий fade заново соберёт их по новому поддереву (FOW-8).
    this.clearHolderFade(record);
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    if (entry === undefined) return;
    record.tier = this.tierOf(record, entry);
    if (record.tier === 'batched' && entry.derivatives !== null) {
      this.attachBatched(record, shared, entry.derivatives);
    } else {
      this.attachDetailed(record, shared);
    }

    // Ярус нарисованного сменился (заглушка → модель либо → запись батча): его
    // корень объявляется приёмнику теней заново.
    this.markCaster(record);

    // Модель готова — walkable-вклад появляется в поле, и подписчики поверхности
    // узнают о клетках под bbox не позже следующего кадра (ASSET-4 → REND-9).
    if (record.decoration) this.syncWalkable(record);
  }

  /** Детальный ярус: пер-инстансное поддерево со скелетом и микшером (REND-20). */
  private attachDetailed(record: InstanceRecord, shared: SharedModelData): void {
    const ctx = this.requireCtx();
    // Запечённые границы есть и у детальной записи, когда модель их даёт: они
    // производны от МОДЕЛИ, а не от яруса, и отсечение по ним точнее запаса
    // (REND-21). Батчевый ярус тут ни при чём — деградировавшая запись тоже их
    // получает.
    const baked = this.shared.get(record.visual?.model ?? '')?.derivatives ?? null;
    record.cullBounds = baked === null ? null : boundsFromBaked(baked);
    this.rescaleDetailedCull(record, shared);
    const instanceOptions: { scale?: number; hiddenParts?: readonly number[] } = {};
    if (record.visual?.scale !== undefined) instanceOptions.scale = record.visual.scale;
    if (record.visual?.hiddenParts !== undefined) {
      instanceOptions.hiddenParts = record.visual.hiddenParts;
    }
    const model = createModelInstance(shared, instanceOptions);
    this.ensureHolder(ctx, record).add(model.root);
    this.disposePlaceholder(record);
    record.model = model;
    record.controller = this.makeController(new MixerAnimationBackend(model.mixer, shared.clips), record);
    this.applyAnimation(record);

    // Контроля костей у decoration нет (REND-5, REND-18): доворачивать нечего.
    const controls = record.decoration ? undefined : record.visual?.boneControls;
    record.boneControl = controls === undefined ? null : new BoneControlState(controls);

    this.applyInstanceSkin(record, model);
  }

  /**
   * Границы отсечения детальной записи под масштабом записи манифеста: тот же
   * множитель нормализации, каким отмасштабирован сам инстанс (REND-17).
   */
  private rescaleDetailedCull(record: InstanceRecord, shared: SharedModelData | null): void {
    if (record.cullBounds === null) return;
    const model = shared?.model ?? this.shared.get(record.visual?.model ?? '')?.data?.model;
    const baked = this.shared.get(record.visual?.model ?? '')?.derivatives;
    if (model === undefined || baked == null) return;
    const normalized = (record.visual?.scale ?? 1) / Math.max(model.height, MIN_MODEL_HEIGHT);
    scaleBounds(boundsFromBaked(baked), normalized, record.cullBounds);
  }

  /** Батчевый ярус: запись в разделяемом инстанс-меше (REND-20). */
  private attachBatched(
    record: InstanceRecord,
    shared: SharedModelData,
    derivatives: BakedDerivatives,
  ): void {
    const entry = this.ensureBatch(record, shared, derivatives);
    record.batch = entry;
    record.slot = entry.batch.acquire();
    // Пустой батч из сцены снят: набор без записей не должен оставлять в кадре
    // ничего (REND-11, REND-18) — даже узла, который ничего не рисует.
    if (entry.batch.group.parent === null) this.requireCtx().scene.add(entry.batch.group);
    record.lodLevel = 0;
    record.skinIndex = entry.skins.indexOf(record.skin);
    entry.batch.setSkin(record.slot, record.skinIndex);
    entry.batch.setLevel(record.slot, 0);
    const vat = new VatAnimationBackend(derivatives.clips, derivatives.fps, derivatives.restFrame);
    record.vat = vat;
    record.controller = this.makeController(vat, record);
    // Контроля костей у батчевой записи нет по построению: запись с ним
    // получает детальный ярус (REND-5 → REND-20).
    record.boneControl = null;
    this.disposePlaceholder(record);
    this.releaseHolder(record);
    this.applyAnimation(record);
  }

  /**
   * Неразрешённая запись анимации диагностируется в тот же сток, что и
   * отсутствующая кость (REND-4, REND-5): у подсистемы один адресат жалоб.
   */
  private makeController(
    backend: ConstructorParameters<typeof AnimationController>[0],
    record: InstanceRecord,
  ): AnimationController {
    const options: {
      crossfade?: number;
      deathEvent?: string;
      reviveEvent?: string;
      warn: (message: string) => void;
    } = { warn: this.warn };
    if (this.options.crossfade !== undefined) options.crossfade = this.options.crossfade;
    if (this.options.deathEvent !== undefined) options.deathEvent = this.options.deathEvent;
    if (this.options.reviveEvent !== undefined) options.reviveEvent = this.options.reviveEvent;
    return new AnimationController(backend, record.visual?.animations ?? {}, options);
  }

  /**
   * Батч записи: `InstancedMesh` на часть каждого уровня, материалы с
   * VAT-патчем, набор вариантов скина. Ключ — модель, набор скрытых частей и
   * сама запись: скины и `hiddenParts` — свойства ЗАПИСИ, и делить между
   * записями их нельзя. Число батчей растёт с числом записей манифеста, а не с
   * числом инстансов — этого REND-20 и требует.
   */
  private ensureBatch(
    record: InstanceRecord,
    shared: SharedModelData,
    derivatives: BakedDerivatives,
  ): BatchEntry {
    const visual = record.visual;
    const key = batchKeyOf(record);
    const existing = this.batches.get(key);
    if (existing !== undefined) {
      // Батч из кэша мог опустеть ЕЩЁ ДО правки скинов записи — например,
      // когда все инстансы вида ушли из доставки, а следом приехала переподача,
      // правившая таблицу скинов этой записи: ключ она не меняет, батч из кэша
      // не уходит (REND-31), а `syncBatchEntry` идёт по ЖИВЫМ записям и пустого
      // батча не видит вовсе. Поэтому набор вариантов сводится с записью здесь
      // же — иначе первый же респавн рисовался бы прежними слоями (REND-17).
      this.syncBatchSkins(existing, visual);
      return existing;
    }

    skinPlaceholder ??= createSkinPlaceholder();
    const placeholder = skinPlaceholder;
    const vatTexture = this.ensureVatTexture(visual?.model ?? '', derivatives);
    const materials = shared.model.materials.map((source, index) =>
      createVatMaterial(
        shared.materials[index] ?? new THREE.MeshStandardMaterial(),
        vatTexture,
        materialMapKinds(source),
        placeholder,
      ),
    );

    // Уровни приходят вместе с владением (REND-31): геометрии цепочки LOD
    // построены для этого батча и отдаются его сносом, части модели — нет.
    const { levels, owned } = batchLevels(shared.meshes, derivatives.lod, visual?.hiddenParts);
    const batch = new ModelBatch({
      materials,
      partVisibility: derivatives.partVisibility,
      levels,
      ownedGeometries: owned,
      // Глубина теневого прохода — тем же вершинным преобразованием VAT, что
      // кадр: иначе тень записи застыла бы в позе покоя (design D4).
      depthMaterial: createVatDepthMaterial(vatTexture),
    });

    const canonical = modelBounds(shared.model, visual?.hiddenParts);
    const canonicalCull = boundsFromBaked(derivatives);
    const normalized = (visual?.scale ?? 1) / Math.max(shared.model.height, MIN_MODEL_HEIGHT);
    const skinTextures: THREE.DataArrayTexture[] = [];
    const entry: BatchEntry = {
      key,
      batch,
      materials,
      skins: new BatchSkinLoader(
        shared.model,
        visual,
        this.requireCtx().assets,
        batchSkinListener(shared.model, materials, skinTextures),
      ),
      skinTable: visual?.skins,
      skinTextures,
      model: shared.model,
      canonical,
      canonicalCull,
      normalized,
      bounds: scaleBounds(canonical, normalized, emptyBounds()),
      cullBounds: scaleBounds(canonicalCull, normalized, emptyBounds()),
      thresholds: resolveLodThresholds(visual),
    };
    this.batches.set(key, entry);
    return entry;
  }

  /** VAT-текстура модели — одна на ассет и общая для всех её батчей (REND-3). */
  private ensureVatTexture(modelId: string, derivatives: BakedDerivatives): THREE.DataTexture {
    const shared = this.shared.get(modelId);
    if (shared?.vatTexture != null) return shared.vatTexture;
    const texture = createVatTexture(derivatives.vat.width, derivatives.vat.height, derivatives.vat.data);
    if (shared !== undefined) shared.vatTexture = texture;
    return texture;
  }

  /**
   * Скин на ДЕТАЛЬНОМ инстансе (REND-6). Пока выбранный скин ничего не
   * подменяет, инстанс рисуется РАЗДЕЛЯЕМЫМИ материалами ассета с его же
   * текстурами: своей копии ему незачем — от ассета он не отличается ничем.
   * Первая же подмена переводит материалы в собственные (copy-on-write) и
   * ставит в них полный набор «слот → источник»: соседние инстансы и
   * разделяемые данные не затронуты.
   *
   * Обратного пути нет намеренно: инстанс, однажды получивший свои материалы,
   * их и оставляет — снятие скина применяется к ним же полным набором, а
   * возврат к разделяемым сэкономил бы один материал ценой ветки, которой не
   * видно из кадра.
   */
  private applyInstanceSkin(record: InstanceRecord, model: ModelInstance): void {
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    if (entry?.data === undefined || entry.data === null) return;
    const overrides = record.skin === undefined ? undefined : record.visual?.skins?.[record.skin];
    if (!model.ownsMaterials && (overrides === undefined || Object.keys(overrides).length === 0)) {
      record.skinApp?.dispose();
      record.skinApp = null;
      this.ensureBaseSkin(entry);
      return;
    }
    record.skinApp?.dispose();
    record.skinApp = applySkin(
      model.ownTextureTargets(),
      skinTextureSources(entry.data.model, record.visual, record.skin),
      this.requireCtx().assets,
    );
  }

  /**
   * Текстуры САМОЙ модели на её разделяемых материалах — один раз на ассет
   * (REND-3). Лениво, по первому инстансу, которому скин ничего не подменяет:
   * модель, все записи которой перекрывают её слоты, своих текстур не грузит
   * вовсе — они бы никогда не были видны.
   */
  private ensureBaseSkin(entry: SharedEntry): void {
    if (entry.baseSkin !== null || entry.data === null) return;
    entry.baseSkin = applySkin(
      entry.data.textureTargets,
      skinTextureSources(entry.data.model, undefined, undefined),
      this.requireCtx().assets,
    );
  }

  private remove(record: InstanceRecord): void {
    // Исчезнувшая walkable-декорация забирает свой вклад из поля; подписчики
    // получают клетки под прежним bbox (REND-9, REND-18).
    if (record.decoration) this.options.surface?.setWalkable(record.entity, null);
    this.detachModel(record);
    if (record.holder !== null) this.options.shadows?.dropCaster(record.holder);
    record.holder?.removeFromParent();
    record.holder = null;
  }

  /**
   * Сведение walkable-вклада инстанса с реестром поля (REND-9): вклад есть
   * ровно тогда, когда декорация несёт флаг записи (PRES-2 → REND-18) и её
   * модель готова (ASSET-4). Размещение — те же величины, которыми `poseAll`
   * ставит инстанс в кадре: позиция набора, курс с поправкой переда (REND-13),
   * k/limit наклона записи, итоговый масштаб меша как у `createModelInstance`.
   * Посадку по террейн-форме реестр считает сам — тем же расчётом (REND-9).
   */
  private syncWalkable(record: InstanceRecord): void {
    const source = this.options.surface;
    if (source === undefined) return;
    const visual = record.visual;
    const entry = visual === undefined ? undefined : this.shared.get(visual.model);
    const model = entry?.data?.model;
    const view = record.view;
    if (view.walkable !== true || visual === undefined || model === undefined) {
      source.setWalkable(record.entity, null);
      return;
    }
    source.setWalkable(record.entity, {
      x: view.currX,
      y: view.currY,
      yaw: view.facingYaw + record.facingOffset,
      tiltFactor: record.tiltFactor,
      tiltMaxRad: record.tiltMaxRad,
      // Нормализация — та же, что у `createModelInstance`: высота модели → 1
      // мировая единица × масштаб записи, поверх — масштаб набора (REND-11).
      scale: (view.scale ?? 1) * ((visual.scale ?? 1) / Math.max(model.height, MIN_MODEL_HEIGHT)),
      model,
      // Скрытые части записи (ASSET-6) не рисуются — и в поле не попадают:
      // индекс реестра обязан совпадать с нарисованным набором частей (REND-9).
      hiddenParts: visual.hiddenParts,
    });
  }

  /**
   * Снимает с инстанса всё построенное из данных ассета — заглушку, модель или
   * запись батча, анимационный контроллер, контроль костей и текстуры скина.
   * Общая часть удаления инстанса и его пересборки под новой записью (REND-17);
   * разделяемые данные ассета и сам батч остаются в кэше (REND-3).
   */
  private detachModel(record: InstanceRecord): void {
    // Возврат разделяемых материалов ДО снятия поддерева: dispose модели
    // освобождает материалы её мешей, и это должны быть fade-копии, а не
    // разделяемые с ассетом (FOW-8, REND-3).
    this.clearHolderFade(record);
    for (const entry of this.shared.values()) entry.waiting.delete(record);
    // Ярус — свойство НАРИСОВАННОГО (REND-20): пока построенного из ассета у
    // записи нет, рисуется заглушка, и она детальная. Оставить прежний ярус
    // значило бы отдавать наружу (`instanceFor`) ярус, которым в кадре ничего
    // не нарисовано; `attachModel` проставит настоящий, как только сможет.
    record.tier = 'detailed';
    this.disposePlaceholder(record);
    record.skinApp?.dispose();
    record.skinApp = null;
    record.controller = null;
    record.boneControl = null;
    record.vat = null;
    record.cullBounds = null;
    if (record.batch !== null) {
      const batch = record.batch.batch;
      batch.release(record.slot);
      // Опустевший батч уходит из сцены, но остаётся в кэше: разделяемое им
      // строится один раз на запись (REND-3), а рисовать ему уже нечего.
      if (batch.count === 0) {
        this.options.shadows?.dropCaster(batch.group);
        batch.group.removeFromParent();
      }
      record.batch = null;
      record.slot = -1;
      record.lodLevel = 0;
    }
    if (record.model !== null) {
      record.model.root.removeFromParent();
      record.model.dispose();
      record.model = null;
    }
  }

  /**
   * Снимает заглушку с инстанса. Геометрию и материал НЕ освобождает: они общие
   * на все заглушки (см. `makePlaceholder`), и освобождение здесь погасило бы
   * заглушки всех остальных инстансов.
   */
  private disposePlaceholder(record: InstanceRecord): void {
    if (record.placeholder === null) return;
    record.placeholder.removeFromParent();
    record.placeholder = null;
  }
}

// ------------------------------------------------------------ помощники

/**
 * Сущности, о чьей смерти сказали события ЭТОЙ доставки (FOW-8): для них
 * исчезновение из состояния — гибель, а не уход в туман, и инстанс снимается
 * существующим путём. null — событий смерти в доставке нет.
 */
function diedIn(view: TickView, deathEvent: string | undefined): ReadonlySet<EntityId> | null {
  const type = deathEvent ?? DEFAULT_DEATH_EVENT;
  let died: Set<EntityId> | null = null;
  for (const event of view.events) {
    if (event.type !== type) continue;
    const entity = event.data.entity ?? event.data.source;
    if (entity === undefined) continue;
    died ??= new Set();
    died.add(entity);
  }
  return died;
}

/** Пустая запись габаритов — заполняется `scaleBounds`. */
function emptyBounds(): ModelBounds {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
}

/** Габариты под множителем нормализации; пишет в `out` и его же возвращает. */
function scaleBounds(source: ModelBounds, factor: number, out: ModelBounds): ModelBounds {
  out.minX = source.minX * factor;
  out.minY = source.minY * factor;
  out.minZ = source.minZ * factor;
  out.maxX = source.maxX * factor;
  out.maxY = source.maxY * factor;
  out.maxZ = source.maxZ * factor;
  return out;
}

/** Консервативные границы по клипам (ASSET-12) в форме габаритов рендера. */
function boundsFromBaked(derivatives: BakedDerivatives): ModelBounds {
  const { min, max } = derivatives.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

/**
 * Ключ батча (REND-20): модель, набор скрытых частей, сама запись манифеста и
 * ярус теневого кастера. Запись входит в ключ потому, что скины батча — её
 * свойство (REND-6): две записи на одну модель делят геометрию, но не массив
 * вариантов. Ярус — потому, что `InstancedMesh` несёт ОДИН набор флагов теней
 * на все свои записи: батч обязан быть однороден по ярусу, иначе статика и
 * динамика попадали бы в одну карту (design D3). Расщепляются на практике
 * только статичные модели с двойным происхождением инстансов — ящик, который и
 * decoration, и prop; цена — +1 draw call на такую модель.
 */
function batchKeyOf(record: InstanceRecord): string {
  return batchKey(record.visual, record.kind ?? '', casterTierOf(record));
}

/**
 * Ключ батча из его слагаемых. Отдельной функцией потому, что то же множество
 * ключей считается и НЕ ПО ЗАПИСЯМ: пересмотр кэша на переподаче (REND-31)
 * спрашивает у манифеста, порождает ли он такой ключ, — и вторая сборка ключа
 * для этого разошлась бы с первой при первой же правке состава ключа.
 */
function batchKey(
  visual: EntityVisual | undefined,
  kind: string,
  tier: ShadowCasterTier,
): string {
  const hidden = [...(visual?.hiddenParts ?? [])].sort((a, b) => a - b).join(',');
  return JSON.stringify([visual?.model ?? '', hidden, kind, tier]);
}

/** Ключи обоих разделов манифеста (ASSET-9): пространство имён у них одно. */
function visualKinds(manifest: VisualManifest): readonly string[] {
  const entities = Object.keys(manifest.entities);
  const decorations = manifest.decorations;
  return decorations === undefined ? entities : [...entities, ...Object.keys(decorations)];
}

/**
 * Ярус теневого кастера инстанса — ПРОИЗВОДНАЯ ДАННЫХ, а не поле записи
 * (design D3): инстанс presentation-состояния (REND-11) двигается тиками и
 * динамичен всегда; decoration (REND-18) статичен, пока запись его вида не
 * объявила анимации (REND-4), — тогда он в кадре меняет позу и обязан
 * попадать в покадровую карту.
 */
function casterTierOf(record: InstanceRecord): ShadowCasterTier {
  if (!record.decoration) return 'dynamic';
  return animatedVisual(record.visual) ? 'dynamic' : 'static';
}

/** Есть ли у записи вида анимации (REND-4): пустая таблица — их отсутствие. */
function animatedVisual(visual: EntityVisual | undefined): boolean {
  const animations = visual?.animations;
  if (animations === undefined) return false;
  return (
    Object.keys(animations.states ?? {}).length > 0 ||
    Object.keys(animations.events ?? {}).length > 0
  );
}

/**
 * Слушатель готовых слоёв батча: набор приезжает асинхронно (ASSET-4) и может
 * приехать ПОВТОРНО — после переподачи манифеста, правившей таблицу скинов
 * записи (REND-17). Прежние массивы текстур освобождаются здесь: они
 * принадлежат батчу, а не ассету (REND-3).
 */
function batchSkinListener(
  model: NormalizedModel,
  materials: readonly VatMaterial[],
  textures: THREE.DataArrayTexture[],
): (set: BakedSkinSet) => void {
  return (set) => {
    for (const texture of textures) texture.dispose();
    textures.length = 0;
    applySkinArrays(model, materials, set, textures);
  };
}

/**
 * Готовые слои вариантов — в материалы батча (REND-6). Массив текстур один на
 * пару «слот × вид карты»: цветовое пространство у карты нормалей своё, и
 * делить с ней текстуру базового цвета нельзя. Созданные массивы собираются в
 * `created`: освобождать их — дело того, кто их поставил.
 */
function applySkinArrays(
  model: NormalizedModel,
  materials: readonly VatMaterial[],
  set: BakedSkinSet,
  created: THREE.DataArrayTexture[],
): void {
  const cache = new Map<string, THREE.DataArrayTexture | null>();
  const slotOf = (source: NormalizedModel['materials'][number], kind: VatMapKind): number | null => {
    if (kind === 'base') return source.baseColorTexture;
    if (kind === 'normal') return source.normalTexture;
    return source.emissiveTexture;
  };
  model.materials.forEach((source, index) => {
    const material = materials[index];
    if (material === undefined) return;
    for (const kind of VAT_MAP_KINDS) {
      if (!material.maps.has(kind)) continue;
      const slot = slotOf(source, kind);
      if (slot === null) continue;
      const cacheKey = `${slot}:${kind}`;
      let texture = cache.get(cacheKey);
      if (texture === undefined) {
        texture = skinArrayTexture(set, slot, kind);
        cache.set(cacheKey, texture);
        if (texture !== null) created.push(texture);
      }
      if (texture === null) continue;
      if (kind === 'base') material.uniforms.vatSkinBase.value = texture;
      else if (kind === 'normal') material.uniforms.vatSkinNormal.value = texture;
      else material.uniforms.vatSkinEmissive.value = texture;
    }
  });
}

/** Метрика экранного размера камеры — то, что от неё нужно выбору уровня. */
interface ScreenScale {
  /** Тангенс половины вертикального поля зрения; 0 — камера ортографическая. */
  tanHalfFov: number;
  /** Видимая высота кадра в мировых единицах у ортографической камеры. */
  orthoHeight: number;
}

/**
 * Метрика камеры — в поданную запись; null — камера ни перспективная, ни
 * ортографическая (уровень тогда не выбирается вовсе). Пишет в `out`, а не
 * заводит запись: отсечение с выбором уровня идёт каждый кадр, и своей записи
 * на кадр у него быть не должно — тем же соображением здесь живут пирамида,
 * матрица и сфера.
 */
function screenScaleOf(camera: THREE.Camera, out: ScreenScale): ScreenScale | null {
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    out.tanHalfFov = Math.tan(((perspective.fov / 2) * Math.PI) / 180);
    out.orthoHeight = 0;
    return out;
  }
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    const height = (ortho.top - ortho.bottom) / (ortho.zoom || 1);
    if (height <= 0) return null;
    out.tanHalfFov = 0;
    out.orthoHeight = height;
    return out;
  }
  return null;
}

/**
 * Экранный размер инстанса — доля высоты кадра, которую занимает его
 * консервативная сфера (REND-22). Именно доля, а не пиксели: пороги записи
 * (ASSET-13) не должны зависеть от разрешения вьюпорта.
 */
function screenSize(radius: number, distance: number, screen: ScreenScale): number {
  if (screen.tanHalfFov > 0) {
    const visible = Math.max(distance, 1e-6) * screen.tanHalfFov;
    return radius / visible;
  }
  return (2 * radius) / screen.orthoHeight;
}

/**
 * Габариты нарисованного инстанса в его собственных осях: модель (детальный
 * ярус) либо запись батча, а до готовности — заглушка (ASSET-4). null — рисовать
 * нечего, и попадать не во что (REND-15). Один ответ на весь файл: прокси
 * picking'а и границы отсечения (REND-21) обязаны говорить об одном объёме.
 */
function boundsOf(record: InstanceRecord): ModelBounds | null {
  if (record.model !== null) return record.model.bounds;
  if (record.batch !== null) return record.batch.bounds;
  // Эмиттерный вид (ASSET-14) рисуется частицами, а попадать в него нужно тем
  // же способом, что в модельный (REND-15, REND-18): фиксированный объём.
  if (record.emitter) return EMITTER_BOUNDS;
  return record.placeholder === null ? null : PLACEHOLDER_BOUNDS;
}

/**
 * Консервативные границы по клипам (ASSET-12) — вход отсечения (REND-21); null
 * — производных у модели нет, и отсечение идёт по габаритам с запасом.
 */
function cullBoundsOf(record: InstanceRecord): ModelBounds | null {
  return record.batch?.cullBounds ?? record.cullBounds;
}

/**
 * Публичный вид инстанса поверх его записи: геттеры, а не копия полей, —
 * потребитель, взявший вид один раз, обязан видеть позу текущего кадра, а не ту,
 * что была в момент вызова.
 */
function viewOf(record: InstanceRecord): ModelInstanceView {
  const pose: InstancePose = {
    get x(): number { return record.pos.x; },
    get y(): number { return record.pos.y; },
    get z(): number { return record.pos.z; },
    get qx(): number { return record.quat.x; },
    get qy(): number { return record.quat.y; },
    get qz(): number { return record.quat.z; },
    get qw(): number { return record.quat.w; },
    get yaw(): number { return record.yaw; },
    get scale(): number { return record.scale; },
  };
  return {
    entity: record.entity,
    decoration: record.decoration,
    get tier(): VisualTier { return record.tier; },
    get model(): ModelInstance | null { return record.model; },
    get controller(): AnimationController | null { return record.controller; },
    get placeholder(): boolean { return record.placeholder !== null; },
    get visible(): boolean { return record.visible; },
    get lodLevel(): number { return record.lodLevel; },
    pose,
    get bounds(): ModelBounds | null { return boundsOf(record); },
  };
}

/**
 * Пересобирать ли инстанс под переподанной записью (REND-17). Граница проходит
 * по тому, что построено из разделяемых данных ассета (REND-3), по ярусу записи
 * (REND-20) и по ярусу теневого кастера (REND-8): другую модель, другой набор
 * её рисуемых частей и другой ярус правкой построенного не получить, а всё
 * прочее записи применяется на живом инстансе.
 */
function rebuildsInstance(
  before: EntityVisual | undefined,
  after: EntityVisual | undefined,
  fallbackTier: VisualTier,
  decoration: boolean,
): boolean {
  if (before === after) return false;
  if (before?.model !== after?.model) return true;
  // Ярус сравнивается ДЕЙСТВУЮЩИЙ (REND-20, QUAL-1): под пресетом с детальным
  // ярусом по умолчанию правка «убрать явный batched из записи» меняет ярус, а
  // `resolveVisualTier` этого бы не увидел — он знает только умолчание кода.
  if (declaredTier(before, fallbackTier) !== declaredTier(after, fallbackTier)) return true;
  // Ярус теневого кастера decoration производен от наличия анимаций у записи
  // (REND-4, design D3) и входит в ключ батча — однородность батча по ярусу
  // иначе держалась бы на том, что запись не правили: дописанная автором
  // таблица анимаций оставила бы декорацию в статическом батче, и её тень
  // запеклась бы в кэшированную карту в позе покоя (REND-8).
  if (decoration && animatedVisual(before) !== animatedVisual(after)) return true;
  return !samePartSets(before?.hiddenParts, after?.hiddenParts);
}

/** Один и тот же набор скрытых частей (ASSET-6); порядок и отсутствие — не различия. */
function samePartSets(before?: readonly number[], after?: readonly number[]): boolean {
  if (before === after) return true;
  const a = before ?? [];
  const b = after ?? [];
  return a.length === b.length && a.every((part) => b.includes(part));
}

/**
 * Совпадают ли подмены выбранного скина в двух записях (REND-6). Сравнивается
 * ровно выбранный скин: правка соседнего скина той же записи текстур этого
 * инстанса не меняет и переставлять их не повод (REND-17).
 */
function sameSkinSlots(
  before: EntityVisual | undefined,
  after: EntityVisual | undefined,
  skin: string | undefined,
): boolean {
  // Скина нет — подмен нет ни до, ни после: слоты модели идут как есть.
  if (skin === undefined) return true;
  return sameSlotMaps(before?.skins?.[skin], after?.skins?.[skin]);
}

/**
 * Совпадают ли таблицы скинов двух записей ЦЕЛИКОМ (REND-6). Этим и меряется
 * набор вариантов батча: он производен от всей таблицы — от списка имён (он
 * задаёт сквозные индексы) и от подмен каждого имени (они задают пиксели
 * слоёв), — а не от одного выбранного скина.
 */
function sameSkinTables(
  before: EntityVisual['skins'] | undefined,
  after: EntityVisual['skins'] | undefined,
): boolean {
  if (before === after) return true;
  const a = before ?? {};
  const b = after ?? {};
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((name) => sameSlotMaps(a[name], b[name]));
}

/** Один и тот же набор подмен «слот → путь»; отсутствие обеих — совпадение. */
function sameSlotMaps(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const slots = Object.keys(a);
  return slots.length === Object.keys(b).length && slots.every((slot) => a[slot] === b[slot]);
}
