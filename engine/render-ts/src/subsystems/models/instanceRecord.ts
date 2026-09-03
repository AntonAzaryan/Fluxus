/**
 * Словарь пула инстансов (REND-3): САМА ЗАПИСЬ и структуры, на которые она
 * ссылается, — разделяемая часть ассета и запись батча, — плюс то, что из
 * записи чисто выводится.
 *
 * Почему они лежат вместе, а не по своим модулям. Распил подсистемы прошёл по
 * шву «кто пишет какие поля»: носители яруса (`carrier/`), поза кадра
 * (`instancePose`), отсечение (`instanceCull`), угасание (`instanceFade`),
 * порты света (`lightingPorts`), кэши ассета и батчей (`sharedModels`,
 * `batchCache`) — все они пишут в ОДНУ запись. Значит запись — их общий
 * словарь, и лежать он обязан НИЖЕ них всех: граф модулей проверяется на циклы
 * (`lint:arch`), а запись, ссылающаяся на разделяемую запись ассета, которая
 * ссылается на записи, — цикл ровно того рода. Поэтому здесь только типы и
 * чистые функции над ними: ни одного ресурса THREE этот модуль не создаёт.
 *
 * Носитель (`InstanceCarrier`) объявлен здесь по той же причине: поле записи —
 * это её словарь, а реализации ярусов живут в `carrier/` и импортируют его
 * односторонне.
 */
import * as THREE from 'three';
import {
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_ROLL,
  type EntityId,
} from '@fluxus/core';
import type {
  AssetService,
  BakedDerivatives,
  EntityVisual,
  VisualTier,
} from '@fluxus/assets';
import type { BlobCaster, EntityView, LightCarrier, ShadowCasterTier } from '../../types.js';
import type { RenderCostCounters } from '../../cost.js';
import type { ModelBounds, ModelInstance, SharedModelData } from '../../model/build.js';
import type { AnimationController } from '../../model/animation.js';
import type { VatAnimationBackend } from '../../model/vatAnimation.js';
import type { BoneControlState } from '../../model/boneControl.js';
import type { SkinApplication, SkinTextureCache } from '../../model/skins.js';
import type { ModelBatch } from '../../model/batch.js';
import type { BatchSkinLoader } from '../../model/batchSkins.js';
import type { VatMaterial } from '../../model/vatMaterial.js';
import type { NormalizedModel } from '@fluxus/assets';
import type { TiltVector } from '../../model/surfaceAlign.js';
import type { SurfaceNormal } from '../../visualSurface.js';
import type { InstanceTint, ResolvedFlash } from './instanceTint.js';

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
  /**
   * Авторская высота мирового якоря над позой (ASSET-6, REND-41); `null` —
   * запись её не называет, и якорь берёт верх габаритов. Отдаётся сырым числом
   * записи, а не готовой точкой: чей якорь и на какой высоте — политика
   * потребителя (REND-41), рендер лишь доносит до него авторское число.
   */
  readonly anchorHeight: number | null;
}

/**
 * Ярус, которым рисуется запись, НЕ назвавшая его (REND-20, ASSET-13): пресет
 * правит ровно это умолчание. Явный ярус записи и вынужденный детальный у
 * процедурного контроля костей (REND-5) ему не подчиняются: первый — решение
 * автора, второй — требование механизма, и скелет батчевому ярусу взять
 * неоткуда. Со значением `'batched'` функция тождественна `resolveVisualTier`
 * ассетов, и умолчание пресета совпадает с ним же.
 */
export function declaredTier(visual: EntityVisual | undefined, fallback: VisualTier): VisualTier {
  if (visual?.tier !== undefined) return visual.tier;
  return visual?.boneControls === undefined ? fallback : 'detailed';
}

/**
 * Перёд модели, когда запись манифеста его не называет (REND-13): соглашение
 * первого поддержанного формата — у MDX лицо вдоль `+X`, то есть 0. Так модели,
 * добавленные до появления параметра, не меняют вид.
 */
export const DEFAULT_FACING_RAD = 0;
export const DEG_TO_RAD = Math.PI / 180;

/**
 * Закрытый словарь состояний анимации (REND-4). Какие состояния бывают —
 * контракт рендера; какой клип на состояние ложится — политика манифеста
 * (ASSET-6), поэтому имён клипов здесь нет и быть не может.
 */
const STATE_IDLE = 'idle';
const STATE_MOVE = 'move';
export const STATE_FALL = 'fall';

/**
 * Что изменилось в размещении decoration-инстанса за сведение (REND-18).
 * Биты, а не запись: сведение идёт по всем декорациям набора на каждую правку
 * документа (ED-15), и объект ответа на каждую был бы мусором ровно по их числу.
 *
 * Различаются они потому, что следствия у них разные: трансформ устаревает
 * кэшированную карту статических теней (REND-8), флаг walkable — только вклад
 * инстанса в поле высот (REND-9). Одним признаком на оба правка флага платила бы
 * полным перезапеканием статики.
 */
export const PLACEMENT_MOVED = 1;
const PLACEMENT_WALKABLE = 2;

/** Манёвр машины локомоушена (LOC-3) → состояние; вне таблицы — idle/move по скорости. */
const MOTION_STATE: Readonly<Record<number, string>> = {
  [LOCOMOTION_DODGE]: 'dodge',
  [LOCOMOTION_ROLL]: 'roll',
  [LOCOMOTION_AIRBORNE]: 'jump',
};

/**
 * Тот же закрытый словарь перечнем — для потребителя, которому его надо
 * ПОКАЗАТЬ автору: таблицу «состояние → подстрока имени клипа» записи манифеста
 * правит редактор (`editor` ED-14), а список состояний он обязан брать из кода
 * рендера, а не набирать своим (ED-2 — тем же основанием, каким типы эффектов
 * камеры приходят описанием CAM-9). Перечень ВЫВЕДЕН из таблицы манёвров, а не
 * набран рядом с ней: два списка разошлись бы при первом же новом манёвре.
 */
export const ANIMATION_STATES: readonly string[] = Object.freeze([
  STATE_IDLE,
  STATE_MOVE,
  ...Object.values(MOTION_STATE),
  STATE_FALL,
]);

/**
 * Состояние анимации инстанса (REND-4): снижение при провале — состояние
 * рендера, манёвр — из машины локомоушена мира, всё остальное — по скорости.
 * Окно даблтапа (LOC-4) в таблице манёвров отсутствует намеренно: ввод в нём
 * рулит скоростью штатно, значит и анимация штатная.
 */
export function animationStateOf(record: InstanceRecord): string {
  if (record.falling) return STATE_FALL;
  return MOTION_STATE[record.view.motion] ?? (record.view.moving ? STATE_MOVE : STATE_IDLE);
}

/**
 * Анимация инстанса: состояние из presentation-состояния (REND-4) и клип,
 * назначенный набором инстансов поверх него (REND-11). На пути тика клип не
 * назначается никогда, и override остаётся снятым.
 */
export function applyAnimation(record: InstanceRecord): void {
  const controller = record.controller;
  if (controller === null) return;
  controller.setState(animationStateOf(record));
  controller.setClipOverride(record.view.clip);
}

/**
 * Может ли инстанс СНИЖАТЬСЯ при провале (REND-12): запись назвала и скорость,
 * и глубину (ASSET-6). Запись без них не опускается ни на йоту, и состояния
 * `fall` у неё нет: провал наблюдаем ровно снижением, а клип падения на
 * сущности, стоящей на месте, соврал бы о происходящем (REND-4). Событие
 * провала при этом остаётся событием и разбирается обычным путём (ARENA-5).
 */
export function descends(record: InstanceRecord): boolean {
  return record.fallSpeed > 0 && record.fallDepth > 0;
}

/**
 * Прыжок в этом кадре (REND-12): манёвр `Airborne` с читаемой фазой. Ветка
 * выбирается по манёвру, а не по флагу override уровня: override носят и
 * снаряды, и проваливающиеся сущности (ARENA-6), и им ступенчатая база уместна.
 */
export function isAirborne(view: EntityView): boolean {
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
export function arcHeightOf(record: InstanceRecord, motion: number): number {
  if (motion === LOCOMOTION_AIRBORNE) return record.jumpArcHeight;
  if (motion === LOCOMOTION_DODGE || motion === LOCOMOTION_ROLL) return record.maneuverArcHeight;
  return 0;
}

export interface SharedEntry {
  data: SharedModelData | null;
  failed: string | null;
  /**
   * Текстуры САМОЙ модели на её разделяемых материалах (REND-3): ставятся один
   * раз на ассет, живут вместе с ним. Инстанс, чей скин ничего не подменяет,
   * рисуется ими и своей копии материала не заводит (REND-6).
   */
  baseSkin: SkinApplication | null;
  /**
   * GPU-текстуры скинов этого ассета с учётом ссылок (REND-6): десять инстансов
   * одного скина заливают его пиксели ОДИН раз. Кэш ассета, а не подсистемы:
   * пиксели разделяются модулем ассетов по идентичности модели (ASSET-2), и
   * живёт он ровно столько же, сколько разделяемая часть.
   */
  readonly skinCache: SkinTextureCache;
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
  /**
   * Индекс кости по исходному имени ноды и матрицы позы привязки — кэш выборки
   * позы узла у батчевого яруса (`nodePose.ts`, REND-24). Строятся по первому
   * запросу: моделям, у которых сокетов не спрашивают, они не нужны вовсе.
   */
  boneIndex: Map<string, number> | null;
  boneBinds: THREE.Matrix4[] | null;
  /**
   * Якоря прогретых программ материалов модели (FOW-8) по НАБОРУ ЗАНЯТЫХ
   * СЛОТОВ (`warmAnchorKey`); пустая карта — прогрева не было. Ключ не «модель»,
   * потому что подмена скина вправе занять слот, который сама модель оставила
   * пустым (`skinTextureSources`): у двух записей одной модели тогда РАЗНЫЕ
   * ключи программы, и один набор якорей грел бы только одну из них. Верхняя
   * граница — число различных занятостей в манифесте, то есть функция
   * документа, а не длины сессии (REND-31).
   */
  readonly warmAnchors: Map<string, WarmAnchors>;
  /**
   * Инстансы, ждущие готовности ассета. Обратная ссылка живёт на самой записи
   * (`InstanceRecord.waitingOn`): снятие инстанса обязано стоить одного
   * удаления, а не обхода всех разделяемых записей сцены.
   */
  readonly waiting: Set<InstanceRecord>;
}

/**
 * Якоря прогретых шейдерных программ модели (FOW-8, `prewarm`): по варианту на
 * то, чем модель вообще рисуют, с текстурами записи — теми же, какими рисует
 * матч.
 *
 * Якорь не рисуется ни одного кадра, и смысл у него ровно один: пока материал
 * жив, `usedTimes` его программы у three не падает до нуля, и программа не
 * удаляется (`WebGLPrograms.releaseProgram`). Освободи прогрев свои материалы
 * по концу — компиляция вернулась бы в первый же кадр, которому эта программа
 * понадобится. Живут якоря столько же, сколько разделяемая часть ассета, и
 * отдаются вместе с ней (`releaseShared`, REND-31).
 */
export interface WarmAnchors {
  /** Вариант, которым вид рисуется обычно. */
  readonly opaque: WarmVariant;
  /**
   * Вариант с `transparent` — им идёт угасание (FOW-8). null, пока о нём не
   * спросили: модель, которую рисуют одни декорации, не угасает никогда
   * (REND-18), и прозрачные якоря с их текстурами были бы у неё мёртвым грузом.
   */
  faded: WarmVariant | null;
}

/** Один вариант якорей: разделяемый материал модели → якорь и его текстуры. */
export interface WarmVariant {
  readonly materials: ReadonlyMap<THREE.Material, THREE.MeshStandardMaterial>;
  /** Живое применение скина к якорям варианта: держит их текстуры (REND-6). */
  readonly skin: SkinApplication;
}

/**
 * Батч записей одной записи манифеста (REND-20): `InstancedMesh`-ы, материалы с
 * VAT-патчем и набор вариантов скина. Ключ включает запись, а не только модель,
 * потому что скины и скрытые части — свойства ЗАПИСИ: две записи на одну модель
 * с разными скинами не могут делить массив вариантов, а число батчей всё равно
 * растёт с числом записей, а не с числом инстансов.
 */
export interface BatchEntry {
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

export interface InstanceRecord {
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
   * Изображение вида — частицы (REND-24), и обе дороги к нему один и тот же
   * флаг: ключ разрешился в эмиттерный decoration-вид (ASSET-14) либо вид
   * назван записью `particles.byKind` (REND-37). Этот пул такому инстансу
   * ничего не строит и даёт ему только объём-прокси (`EMITTER_BOUNDS`) — чтобы
   * попадать в нарисованное было чем (REND-15, REND-18).
   */
  emitter: boolean;
  /**
   * ЧЕМ инстанс нарисован (REND-20): батчевая запись, детальное поддерево,
   * заглушка, изображение частиц или ничего. Носитель отвечает за позу, скин,
   * видимость, уровень и габариты — парных веток по ярусу в подсистеме больше
   * нет, а ярус наружу отдаёт он же.
   */
  carrier: InstanceCarrier;
  model: ModelInstance | null;
  /** Батч записи и слот в нём; null — инстанс не батчевый (REND-20). */
  batch: BatchEntry | null;
  slot: number;
  /**
   * Разделяемая запись, готовности которой ждёт инстанс (ASSET-4); null — не
   * ждёт. Ссылка держится на записи, чтобы снятие инстанса стоило одного
   * удаления из ОДНОГО множества: инстанс ждёт ровно одну модель, а обход всех
   * разделяемых записей платил бы числом ассетов сцены за каждый уход юнита в
   * туман (FOW-8).
   */
  waitingOn: SharedEntry | null;
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
   * Снимок РАЗМЕЩЕНИЯ decoration-инстанса, сведённого последним (REND-18):
   * позиция, курс и флаг walkable, которыми запись уже сведена. Снимок нужен
   * потому, что сравнивать не с чем: набор мутирует ТУ ЖЕ запись `EntityView`,
   * которую держит инстанс (`keyedInstanceSet.ts`), и прежних значений в ней
   * уже нет. Начальные NaN делают первое сведение изменением по построению.
   *
   * У инстанса presentation-состояния снимок не ведётся вовсе: его размещение
   * двигается каждым тиком, и спрашивать «сдвинулось ли» не о чем.
   */
  placedX: number;
  placedY: number;
  placedYaw: number;
  placedWalkable: boolean;
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
   * Сущность инстанса мертва — АВТОРИТЕТ ЗАПИСИ (REND-4). Ставится обоими
   * источниками правды о смерти: доставленным состоянием (появился уже мёртвым
   * — гибели этот инстанс не видел) и событием гибели, в том числе когда
   * рисовать инстанс ещё нечем и контроллера у него нет (`assets` ASSET-4).
   *
   * Флаг живёт на записи, а не в контроллере, потому что контроллер —
   * СЕГОДНЯШНИЙ носитель воспроизведения, а не память инстанса: он вправе
   * появиться позже модели, смениться вместе с ярусом (REND-20) и пересобраться
   * переподачей манифеста (REND-17), — а сущность всё это время мертва, и
   * каждый следующий контроллер обязан встать трупом так же, как встал бы
   * первый. Снимается тем, что сущность перестала быть мёртвой: снятым маркером
   * состояния, событием возрождения и разрывом непрерывности (`snapAll`,
   * REND-2); удачей фиксации — нет.
   */
  deathLock: boolean;
  /**
   * Меши держателя, чьи материалы на время fade подменены СВОИМИ копиями с
   * прозрачностью (FOW-8): разделяемые с ассетом материалы (REND-3, REND-6)
   * трогать нельзя. null — fade не идёт, у мешей разделяемые материалы.
   */
  fadedTargets: FadeTarget[] | null;
  /**
   * Носитель локального света инстанса (REND-33); null — запись вида блока
   * `light` не несёт (ASSET-16) либо порта света у сборки нет. Объект живёт
   * вместе с инстансом: числа блока правятся на нём переподачей манифеста
   * (REND-17), а снимается он вместе с инстансом.
   */
  lightCarrier: LightCarrier | null;
  /**
   * Носитель контактного пятна инстанса (REND-30, режим `blob`); null — инстанс
   * не динамический кастер либо порта пятен у сборки нет. Живёт вместе с
   * инстансом: радиус правится на нём переподачей манифеста (REND-17), а
   * снимается он вместе с инстансом или со сменой яруса кастера.
   */
  blobCaster: BlobCaster | null;
  /**
   * Опора кадра под инстансом — высота поверхности и её нормаль в точке
   * (REND-30, вход `poseOfBlob`). Считается там же, где поза кадра, и только
   * при живом носителе пятна: инстанс без него за выборку поверхности не платит.
   *
   * Отдельно от `pos`, потому что это РАЗНЫЕ величины: в позу входят дуга
   * манёвра, полёт и снижение при провале (REND-12), а опора — то, над чем
   * инстанс в этот момент находится. Нормаль — свойство той же точки, и берётся
   * она тем же правилом, каким сажается сам инстанс: walkable-инстанс — по
   * террейн-форме, все прочие — по полю целиком (REND-9).
   */
  seatZ: number;
  readonly seatNormal: SurfaceNormal;
  /**
   * Канал тинта инстанса (REND-40): база порта, вспышка события и их сведение.
   * Объект заводится вместе с записью и переиспользуется — кадр переписывает в
   * нём числа (REND-26).
   */
  readonly tint: InstanceTint;
  /**
   * Маска команд-цвета — индексы материалов модели (ASSET-18); `null` — тинт на
   * весь инстанс. Раскладывается из записи манифеста в точке её приёма
   * (`applyEntryParams`), а не в кадре.
   */
  tintMask: readonly number[] | null;
  /** Таблица «событие → вспышка» записи (ASSET-18); null — вспышек у записи нет. */
  tintFlashes: ReadonlyMap<string, ResolvedFlash> | null;
  /**
   * Доля целостности трупа [0, 1] (REND-4): единица — инстанс цел, ноль —
   * растворился. Отдельно от `fade`, потому что каналов ДВА и они независимы:
   * `fade` говорит «сущность ушла из обзора» (FOW-8), растворение — «труп
   * убран из кадра»; труп вправе уйти в туман посреди растворения, и умножение
   * долей — единственное, что честно рисует оба.
   */
  dissolve: number;
  /** Секунды до начала растворения; счёт идёт от фиксации смерти (REND-4). */
  dissolveHeld: number;
  /**
   * Растворение доиграно и построенное из ассета снято: сущность в доставке
   * ещё есть (сцена снимает `Dead` своим временем), а в кадре её уже нет.
   * Возвращается монтированием — возрождением, разрывом непрерывности либо
   * возвратом из тумана.
   */
  dissolved: boolean;
  /** Задержка и длительность растворения записи (ASSET-6); 0 — записи блока нет. */
  dissolveDelay: number;
  dissolveDuration: number;
  /**
   * Запись стоит в очереди отложенного монтирования (REND-44, `spawnQueue.ts`):
   * пул её уже знает, а построенного из ассета у неё ещё нет. Флаг живёт на
   * записи, а не в очереди, потому что ОТМЕНА приходит сведением пула — пачкой,
   * — и вырезание из середины очереди стоило бы сдвигом на каждую отменённую.
   */
  pendingMount: boolean;
  /** Публичный вид инстанса; строится лениво и живёт с инстансом (REND-17). */
  publicView: ModelInstanceView | null;
}

/**
 * Меш держателя и его РАЗДЕЛЯЕМЫЕ материалы, отложенные на время fade (FOW-8).
 * Пока запись жива, в самом меше стоят fade-копии, выданные пулами оригиналов
 * (`borrowFadeClone`); порядок в массиве тот же, что у оригиналов, — по нему
 * копии и возвращаются (`returnFadeTargets`).
 */
export interface FadeTarget {
  readonly mesh: { material: THREE.Material | THREE.Material[] };
  readonly original: THREE.Material | THREE.Material[];
}

/**
 * НОСИТЕЛЬ инстанса (REND-20): то, чем запись нарисована в кадре. Их три —
 * батчевая запись, детальное поддерево и «модели нет» (заглушка ASSET-4,
 * изображение частиц REND-24, невизуальная сущность), — и интерфейс сводит
 * парные ветки ярусов в одно место: поза, скин, видимость, уровень и габариты
 * спрашиваются у носителя, а не выбираются `if (record.batch !== null)`.
 *
 * Носители БЕЗ СОСТОЯНИЯ: состояние живёт в записи, а носитель — таблица
 * поведения, одна на процесс. Так у батчевой записи не появляется объекта на
 * инстанс — того самого, ради отсутствия которого ярус и заведён (REND-20).
 *
 * Кадровые методы (`applyPose`, `setVisible`, `selectLod`, `bounds`,
 * `cullBounds`) хозяйства подсистемы не требуют вовсе; те два, что требуют
 * (`detach`, `applySkin`), получают его УЗКИМ портом (`CarrierDeps`) —
 * параметром, а не ссылкой на подсистему.
 */
export interface InstanceCarrier {
  /** Ярус, которым инстанс нарисован (REND-20) — он же уходит наружу. */
  readonly tier: VisualTier;
  /**
   * Видимое преобразование кадра в носитель: одни и те же числа обоим ярусам.
   * `settle` и `warn` нужны довороту костей детального яруса (REND-5) — у
   * прочих носителей они не читаются вовсе.
   */
  applyPose(
    record: InstanceRecord,
    drawScale: number,
    settle: number,
    warn: (message: string) => void,
  ): void;
  /** Итог отсечения кадра (REND-21): погасить или зажечь нарисованное. */
  setVisible(record: InstanceRecord, visible: boolean): void;
  /**
   * Уровень детализации по экранному размеру (REND-22). У носителей, кроме
   * батчевого, — no-op: цепочка уровней есть возможность батчевого яруса, и
   * это оговорка самого REND-22, а не пропуск.
   *
   * Экранный размер носитель считает САМ и только после отказа «цепочки нет»:
   * дистанция до камеры — корень, и платить им за записи без уровней кадр не
   * должен (PERF-3). Поэтому сюда приходят слагаемые, а не результат.
   */
  selectLod(record: InstanceRecord, lod: LodFrame): void;
  /** Габариты нарисованного в осях инстанса; null — рисовать нечего. */
  bounds(record: InstanceRecord): ModelBounds | null;
  /** Консервативные границы по клипам (ASSET-12); null — их у модели нет. */
  cullBounds(record: InstanceRecord): ModelBounds | null;
  /** Скин инстанса (REND-6): текстуры детального, индекс варианта батчевого. */
  applySkin(record: InstanceRecord, deps: CarrierDeps): void;
  /** Снять построенное из ассета; кэш ассета и батч остаются (REND-3). */
  detach(record: InstanceRecord, deps: CarrierDeps): void;
}

/**
 * Слагаемые выбора уровня в этом кадре (REND-22): радиус сферы отсечения,
 * положение камеры, метрика экрана и множитель порогов от пресета (QUAL-1).
 * Одна запись на кадр, а не на инстанс — её заполняет отсечение.
 */
export interface LodFrame {
  radius: number;
  readonly camera: THREE.Vector3;
  tanHalfFov: number;
  orthoHeight: number;
  scale: number;
  cost: RenderCostCounters | undefined;
}

/**
 * Узкий порт носителя к хозяйству подсистемы — ровно то, без чего он не может
 * сняться и переставить скин. Не ссылка на подсистему и не её кэши целиком:
 * носитель обязан оставаться таблицей поведения, а не вторым владельцем сцены.
 */
export interface CarrierDeps {
  readonly assets: AssetService;
  readonly scene: THREE.Scene;
  /**
   * Адресат жалоб подсистемы: неразрешённая запись, отсутствующая кость.
   * Свойство-функция, а не метод: её ПЕРЕДАЮТ дальше (контроллеру, доворту
   * костей), и метод интерфейса в этой роли уводил бы за собой `this`.
   */
  readonly warn: (message: string) => void;
  /** Корень нарисованного — приёмнику теней вместе с ярусом (REND-8). */
  markCaster(record: InstanceRecord): void;
  /** Текстуры самой модели на её разделяемых материалах — раз на ассет (REND-3). */
  ensureBaseSkin(entry: SharedEntry): void;
  /** Разделяемая запись ассета этой записи; undefined — модели у неё нет. */
  sharedOf(record: InstanceRecord): SharedEntry | undefined;
  /** Fade-копии материалов, которые инстанс сейчас освободит (FOW-8). */
  disposeFadeClones(originals: Iterable<THREE.Material>): void;
  /** Корень ушёл из кадра — приёмнику теней (REND-8). */
  dropCaster(root: THREE.Object3D): void;
}

/**
 * Носитель «рисовать нечего»: невизуальная сущность (`kind: null`) и запись до
 * первого монтирования. Не заглушка — заглушка рисуется и живёт в
 * `carrier/placeholder.ts`; это буквально отсутствие нарисованного, и вопрос о
 * позе, скине и габаритах у него имеет один честный ответ.
 */
export const NONE_CARRIER: InstanceCarrier = {
  tier: 'detailed',
  applyPose: nothingDrawn,
  setVisible: nothingDrawn,
  selectLod: nothingDrawn,
  bounds: () => null,
  cullBounds: () => null,
  applySkin: nothingDrawn,
  detach: nothingDrawn,
};

function nothingDrawn(): void {
  // Намеренно пусто: у отсутствия нарисованного нет ни позы, ни скина, ни
  // видимости — и это ответ, а не заглушка на будущее.
}

/** Пустая запись габаритов — заполняется `scaleBounds`. */
export function emptyBounds(): ModelBounds {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
}

/** Габариты под множителем нормализации; пишет в `out` и его же возвращает. */
export function scaleBounds(source: ModelBounds, factor: number, out: ModelBounds): ModelBounds {
  out.minX = source.minX * factor;
  out.minY = source.minY * factor;
  out.minZ = source.minZ * factor;
  out.maxX = source.maxX * factor;
  out.maxY = source.maxY * factor;
  out.maxZ = source.maxZ * factor;
  return out;
}

/** Консервативные границы по клипам (ASSET-12) в форме габаритов рендера. */
export function boundsFromBaked(derivatives: BakedDerivatives): ModelBounds {
  const { min, max } = derivatives.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

/**
 * Ярус теневого кастера инстанса — ПРОИЗВОДНАЯ ДАННЫХ, а не поле записи
 * (design D3): инстанс presentation-состояния (REND-11) двигается тиками и
 * динамичен всегда; decoration (REND-18) статичен, пока запись его вида не
 * объявила анимации (REND-4), — тогда он в кадре меняет позу и обязан
 * попадать в покадровую карту.
 */
export function casterTierOf(record: InstanceRecord): ShadowCasterTier {
  if (!record.decoration) return 'dynamic';
  return animatedVisual(record.visual) ? 'dynamic' : 'static';
}

/** Есть ли у записи вида анимации (REND-4): пустая таблица — их отсутствие. */
export function animatedVisual(visual: EntityVisual | undefined): boolean {
  const animations = visual?.animations;
  if (animations === undefined) return false;
  return (
    Object.keys(animations.states ?? {}).length > 0 ||
    Object.keys(animations.events ?? {}).length > 0
  );
}

/**
 * Габариты нарисованного инстанса в его собственных осях: модель (детальный
 * ярус) либо запись батча, а до готовности — заглушка (ASSET-4). null — рисовать
 * нечего, и попадать не во что (REND-15). Один ответ на весь файл: прокси
 * picking'а и границы отсечения (REND-21) обязаны говорить об одном объёме.
 */
export function boundsOf(record: InstanceRecord): ModelBounds | null {
  return record.carrier.bounds(record);
}

/**
 * Консервативные границы по клипам (ASSET-12) — вход отсечения (REND-21); null
 * — производных у модели нет, и отсечение идёт по габаритам с запасом.
 */
export function cullBoundsOf(record: InstanceRecord): ModelBounds | null {
  return record.carrier.cullBounds(record);
}

/**
 * Публичный вид инстанса поверх его записи: геттеры, а не копия полей, —
 * потребитель, взявший вид один раз, обязан видеть позу текущего кадра, а не ту,
 * что была в момент вызова.
 */
export function viewOf(record: InstanceRecord): ModelInstanceView {
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
    get tier(): VisualTier { return record.carrier.tier; },
    get model(): ModelInstance | null { return record.model; },
    get controller(): AnimationController | null { return record.controller; },
    get placeholder(): boolean { return record.placeholder !== null; },
    get visible(): boolean { return record.visible; },
    get lodLevel(): number { return record.lodLevel; },
    pose,
    get bounds(): ModelBounds | null { return boundsOf(record); },
    get anchorHeight(): number | null { return record.visual?.anchorHeight ?? null; },
  };
}

/**
 * Пересобирать ли инстанс под переподанной записью (REND-17). Граница проходит
 * по тому, что построено из разделяемых данных ассета (REND-3), по ярусу записи
 * (REND-20) и по ярусу теневого кастера (REND-8): другую модель, другой набор
 * её рисуемых частей и другой ярус правкой построенного не получить, а всё
 * прочее записи применяется на живом инстансе.
 */
export function rebuildsInstance(
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
  // Маска команд-цвета скомпилирована в материалы батча (REND-40, ASSET-18) —
  // тем же порядком, что и ярус кастера: правкой построенного её не сменить, и
  // без пересборки автор увидел бы прежнюю программу до перезагрузки сцены
  // (ED-15).
  if (tintMaskToken(before) !== tintMaskToken(after)) return true;
  return !samePartSets(before?.hiddenParts, after?.hiddenParts);
}

/**
 * Маска тинта записи как СЛАГАЕМОЕ КЛЮЧА (REND-40, ASSET-18): она входит и в
 * ключ батча, и в решение о пересборке инстанса, и написана поэтому один раз —
 * разойдись эти два прочтения, инстанс попал бы в батч, чьи материалы читают
 * не тот канал, что его собственные.
 *
 * Записи без блока и записи с пустой маской дают ОДИН токен намеренно: тинта
 * нет ни у той, ни у другой, программа материала у них одна, и делить батч им
 * ничто не мешает.
 */
export function tintMaskToken(visual: EntityVisual | undefined): string {
  const mask = visual?.tint?.materials;
  if (visual?.tint === undefined) return '';
  return mask === undefined ? 'all' : [...mask].sort((a, b) => a - b).join(',');
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
export function sameSkinSlots(
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
export function sameSkinTables(
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

/**
 * Что изменилось в размещении decoration-инстанса с прошлого сведения
 * (REND-18): снимок на записи сравнивается с доставленным и переписывается им.
 * Возвращает биты `PLACEMENT_*`; ноль — набор переподан, а этой декорации
 * правка не касалась.
 */
export function placementChange(record: InstanceRecord, view: EntityView): number {
  let change = 0;
  if (record.placedX !== view.currX || record.placedY !== view.currY) {
    record.placedX = view.currX;
    record.placedY = view.currY;
    change |= PLACEMENT_MOVED;
  }
  if (record.placedYaw !== view.facingYaw) {
    record.placedYaw = view.facingYaw;
    change |= PLACEMENT_MOVED;
  }
  const walkable = view.walkable === true;
  if (record.placedWalkable !== walkable) {
    record.placedWalkable = walkable;
    change |= PLACEMENT_WALKABLE;
  }
  return change;
}
