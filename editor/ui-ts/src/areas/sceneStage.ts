/* eslint-disable max-lines -- baseline */
/**
 * @contribution Сборка вьюпорта сцены — часть вклада области, а не каркаса.
 *
 * Здесь редактор встречается с рендером движка, и вся встреча — регистрация
 * подсистем и подача документного набора. Собственного рендера у редактора нет
 * (ED-1): террейн рисует `TerrainSubsystem` (REND-7, REND-9), модели —
 * `ModelsSubsystem` (REND-3..6, REND-10), эмиттерные виды — `ParticlesSubsystem`
 * (REND-24), служебные наложения — `OverlaySubsystem` (REND-16), а
 * presentation-состояние наполняет `DocumentSource` (REND-11) — тот же вход
 * подсистем, что у потока тиков.
 *
 * Тика в режиме правки нет (ED-15): кадровый цикл не двигает мир, а только
 * сводит документный набор, считает позу камеры конвейером (ED-13) и рисует.
 *
 * ## Кадр без террейна
 *
 * Подсистемы поднимает первая сетка: до неё ни поверхности (REND-9), ни границ
 * арены (CAM-7) не существует. Набору из одного инстанса без сцены и террейна —
 * превью ассета (ED-20, REND-11) — сетки не будет никогда, и он поднимает те же
 * подсистемы сразу, опцией `terrain: false`. Не второй сборкой рендера: ED-20
 * требует «тем же рендером, что вьюпорт», и вторая сборка разошлась бы с первой
 * по определению (ED-1, CORE-3). Разница ровно в том, чего у вырожденного
 * случая нет: без сетки нет ни подсистемы террейна, ни визуальной поверхности,
 * а значит нет и того, что из неё выведено, — наложений и picking'а (REND-15,
 * REND-16). Инстанс в таком кадре стоит на своём `level` (REND-11), потому что
 * сажать его не на что.
 *
 * ## Стартовый и обзорный кадр
 *
 * Первая сетка не только поднимает подсистемы, но и просит кадрирование по
 * границам арены с мгновенным применением (ED-15, CAM-8): автор при открытии
 * видит то, что собирается править. Просьба исполняется кадровым циклом, а не
 * на месте, потому что пропорции кадра подаёт потребитель, а свои размеры холст
 * узнаёт только после раскладки страницы; при нулевых размерах просьба ждёт.
 * Тем же путём идёт обзорное действие бара — сглаженным перелётом.
 *
 * ## Контекст свой, модуль ассетов общий
 *
 * `RenderContext` (сцена THREE, модуль ассетов, конфиг) заводится здесь, то
 * есть по одному на кадр: кадров в редакторе больше одного, и каждый держит
 * свою presentation-сцену — иначе переключение рабочих областей отбирало бы
 * presentation-состояние у соседа (REND-11) и теряло бы позу камеры, которую
 * ED-23 обязывает пережить переключение. Общим при этом остаётся модуль
 * ассетов: он приходит параметром, а не создаётся здесь. Развилка и её цена
 * разобраны в шапке `assetModule.ts`.
 *
 * ## Второй продюсер и один цикл кадров
 *
 * Превью (ED-9) публикуется в ЭТУ же presentation-сцену вторым продюсером
 * (REND-11) и рисуется ЭТИМ же циклом (`attachProducer`). Своего цикла у него
 * нет намеренно: два цикла давали бы подсистемам два `updateFrame` на кадр.
 * Камера при этом остаётся здесь и в превью работает как обычно — её ввод не
 * пересекает границы воркера (ED-13, CAM-1) просто потому, что пересекать её
 * тут нечем: обратный канал прогона держит его runner, а не вьюпорт.
 *
 * ## Отклик не позже следующего кадра
 *
 * ED-15 требует показать правку не позже следующего кадра. Механизм — один и
 * простой: `submit` кладёт новое состояние документов и поднимает флаг, а
 * ближайший кадр сводит его с нарисованным. Считать в `submit` нельзя: за один
 * кадр правок бывает несколько (мазок кисти — операция на кадр, ED-18), и
 * пересчёт на каждую делал бы работу, которую всё равно перекроет последняя.
 *
 * Кадр, который не рисуется (автор ушёл в другую область — узла нет в
 * странице), флаг не гасит: правка дождётся возвращения вьюпорта, а не
 * потеряется в кадре, которого никто не видел.
 *
 * ## Что делает сорвавшийся кадр
 *
 * Ошибка внутри кадра — сведения набора или самой отрисовки — не имеет права
 * ни увести цикл (иначе вьюпорт замирает навсегда), ни промолчать (иначе автор
 * видит прежнюю картинку и считает её ответом на свою правку). Поэтому кадр
 * ловит её, оставляет нарисованным последнее целое и называет причину полем
 * `failure`, о смене которого сообщает `onChange` — теми же иконкой и текстом,
 * какими область показывает сломанный документ (ED-8, ED-22).
 *
 * Живут эти две причины по-разному, и это не мелочь. Сорвавшееся сведение
 * повторить не на чем — флаг погашен, документы те же, — и погасить причину
 * следующим удавшимся кадром значило бы показать её ровно на один кадр, то
 * есть не показать: она держится до следующей подачи. Сорвавшаяся отрисовка
 * повторяется каждый кадр сама и гаснет тем кадром, который прошёл.
 *
 * ## Почему смена режима камеры объявляется, а не спрашивается
 *
 * Режим — состояние конвейера (CAM-2), и переключатель до него доходит вводом:
 * `toggleFly` взводит фронт, а применяет его ближайший кадр rig'а. Спросить
 * `flying` сразу после нажатия значит получить прежний ответ, поэтому смену
 * режима объявляет сам кадр (`onChange`) — иначе подпись бара показывала бы
 * один режим, пока камера в другом (ED-26). Тем же путём объявляется и `F`.
 *
 * ## Клавиатура холсту не принадлежит
 *
 * Слушателей клавиатуры на холсте нет: клавиши принадлежат активной области
 * (ED-32), приходят от каркаса и складываются в набор, который живёт в записи
 * состояния области. Вьюпорт спрашивает этот набор каждым кадром
 * (`options.keys`) — так он переживает перерисовку страницы, заменяющую узел
 * кадра, и не требует, чтобы автор перед стрелкой ткнул в кадр мышью. Указатель
 * — edge-pan, drag, колесо — остаётся на холсте: это ввод мышью в кадр (CAM-3),
 * и к фокусу он отношения не имеет.
 *
 * ## Почему холст живёт вне дерева описания
 *
 * Каркас перерисовывает страницу целиком (`frame/mount.ts`), заменяя поддерево
 * узла. Холст рендера такого не переживает, поэтому он принадлежит вьюпорту, а
 * не описанию: каждый кадр проверяется, лежит ли он в текущем узле кадра
 * (`hostId`), и при необходимости возвращается на место. Это не обход каркаса —
 * содержимое кадра и по контракту `viewportFrame` приносит рендер, а не
 * интерфейс.
 *
 * ## Picking и наложения: вьюпорт отдаёт сервисы, а не политику
 *
 * REND-15 требует, чтобы луч строился «из той же позы и той же общей реализацией
 * её применения, которыми нарисован кадр». Поэтому поза кадра здесь и хранится:
 * `pick` считает по ПОСЛЕДНЕЙ отданной конвейером позе, а не по свежему опросу
 * rig'а, — иначе наведение отвечало бы про кадр, которого автор не видел.
 * Камера picking'у отдаётся та же самая (`camera3`), чтобы объект был буквально
 * один, а прямоугольник кадра берётся у холста.
 *
 * Перевод попадания в размещённое делает набор инстансов (`DocumentSource.keyOf`,
 * REND-11): picking о документах не знает и знать не должен. Обратный перевод —
 * подсветка по ключу документа — идёт тем же набором (`entityOf`), и второго
 * отображения «ключ ↔ сущность» в редакторе нет.
 *
 * Набор наложений декларативен (REND-16): вьюпорт хранит последний поданный и
 * переподаёт его после каждого сведения документов. Переподача не украшение:
 * смена визуального типа пересоздаёт инстанс с новым номером сущности, и
 * подсветка, оставленная на прежнем номере, погасла бы молча.
 *
 * Что значит попадание — выделить, потащить, поставить — вьюпорт не решает
 * (ED-25): события левой кнопки он пересылает наружу, а средняя и правая
 * остаются камере (CAM-3).
 */
import * as THREE from 'three';
import type {
  AssetService,
  PresentationLighting,
  TerrainCurvatureMap,
  VisualManifest,
} from '@game-mvp/assets';
import {
  DecorationSet,
  DocumentSource,
  LightingSubsystem,
  ModelsSubsystem,
  OverlaySubsystem,
  ParticlesSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  ViewportPicking,
  VisualSurfaceSource,
  applyCameraPose,
  type CameraBounds,
  type CameraPose,
  type DecorationInstance,
  type DocumentInstance,
  type OverlayItem,
  type PickHit,
  type QualityPreset,
  type RenderContext,
} from '@game-mvp/render';
import type { TerrainGrid } from '@game-mvp/core';
import type { AssetModule } from './assetModule.js';
import { createSceneCamera, type PointerSample, type SceneCamera } from './sceneCamera.js';
import type {
  ScenePick,
  ScenePicker,
  SceneOverlay,
  StagePointer,
} from './sceneInteraction.js';

/** Шаг высоты уровня в мировых единицах — параметр рендера (REND-7). */
const HEIGHT_STEP = 0.6;

/** Кадр, у которого источника клавиатуры нет вовсе (ED-20): ничего не зажато. */
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Пресет качества вьюпорта (`render-quality` QUAL-1, design D4): редактору
 * важна АВТОРСКАЯ картинка, а не бюджет слабого устройства, — поэтому здесь
 * зашита «ультра». Потолков в документе нет ни одного, и это его содержание:
 * разрешение маски тумана (FOW-10) и плотность разбиения террейна (REND-9)
 * действуют так, как написаны в контенте и конфиге, а не так, как разрешил бы
 * пресет игры. Названные значения — документированные умолчания ручек: автор
 * видит запись манифеста как есть (пороги LOD REND-22 без множителя, ярус
 * REND-20 и плотность частиц REND-24 на своих умолчаниях).
 *
 * Документ ИНЛАЙНОВЫЙ, а не импорт из `game/demo-ts/app/presets/`: пресеты —
 * политика игрового приложения (design D4), и своих файлов у редактора она не
 * одалживает. Совпадение значений с `ultra.json` демо здесь ничего не связывает:
 * игра вправе переписать свой документ, не спрашивая редактор.
 */
export const EDITOR_QUALITY_PRESET: QualityPreset = {
  'models.lodThresholdScale': 1,
  'models.defaultTier': 'batched',
  'particles.density': 1,
};

/** Кнопка мыши: левая — инструмент, средняя — drag-панорама (CAM-3), правая — осмотр. */
const LEFT_BUTTON = 0;
const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;

/**
 * Что вьюпорту нужно от документов, чтобы нарисовать кадр: сетка террейна
 * (REND-14), карта кривизны (REND-9), полный набор инстансов (REND-11) и полный
 * набор декораций (REND-18). Ровно четыре несимуляционных входа рендера, и ни
 * одного доменного имени сверх них — поэтому подать сюда может и кадр сцены
 * (`SceneDraft`), и вырожденный набор просмотрщика ассетов (ED-20), у которого
 * ни сетки, ни кривизны, ни декораций нет.
 */
export interface StageDraft {
  readonly grid: TerrainGrid | null;
  readonly curvature: TerrainCurvatureMap | null;
  readonly placements: readonly DocumentInstance[];
  /** Набор decoration-инстансов (REND-18); нет поля — слой пуст. */
  readonly decorations?: readonly DecorationInstance[];
  /**
   * Секция `lighting` парного документа (PRES-2); нет поля — умолчания
   * подсистемы освещения, то есть тот же свет, что был у вьюпорта до неё.
   */
  readonly lighting?: PresentationLighting;
}

export interface SceneStageOptions {
  /** Идентификатор узла кадра — тот же, что у `viewportFrame`. */
  readonly hostId: string;
  /**
   * Модуль ассетов редактора (ASSET-2) — готовый, а не источник байтов, из
   * которого кадр завёл бы свой. Кэш один на ID, и кадров в редакторе больше
   * одного: обоснование — в шапке `assetModule.ts`. Модуль, а не сам сервис,
   * потому что сервис под ним сменяется: кэш выбрасывается целиком, когда
   * дерево изменилось, и кадр обязан идти за новым, а не рисовать по прежнему.
   */
  readonly assets: AssetModule;
  /** Манифест визуалов (ASSET-6): без него подсистеме моделей нечего строить. */
  readonly visuals: VisualManifest;
  /**
   * Бывает ли у этого кадра террейн. `false` — вырожденный случай REND-11
   * (превью ассета ED-20): подсистемы поднимаются сразу, без сетки и без
   * поверхности. По умолчанию `true` — кадр ждёт первой сетки документа.
   */
  readonly terrain?: boolean;
  /** Документ среды; по умолчанию — документ вкладки. */
  readonly document?: Document;
  readonly heightStep?: number;
  /**
   * Вьюпорт сообщает о том, что изменилось у него самого и видно в интерфейсе:
   * режим камеры (CAM-2) и причина сорвавшегося кадра. Зовётся из кадра и
   * только на смену, а не на каждый кадр.
   */
  readonly onChange?: () => void;
  /**
   * Что сейчас зажато на клавиатуре — спрашивается каждым кадром (CAM-3).
   * Набор держит область, а не вьюпорт: клавиши принадлежат активной области
   * (ED-32), а не её холсту, и набор обязан пережить перерисовку страницы,
   * которая холст в узле кадра заменяет. Нет источника — кадр без клавиатуры
   * (превью ассета ED-20).
   */
  readonly keys?: () => ReadonlySet<string>;
  /**
   * Указатель левой кнопкой — вход инструмента (ED-16, ED-17). Что попадание
   * значит, вьюпорт не знает: это политика вклада (ED-25).
   */
  readonly onPointer?: (event: StagePointer) => void;
}

/**
 * Что вьюпорт объявляет интерфейсу (`onChange`): режим камеры (CAM-2), причина
 * сорвавшегося кадра (ED-8) и наличие арены (ED-26). Все три — одной записью, а
 * не тремя сравнениями по месту: забытое в сравнении поле и есть тот дефект,
 * при котором действие остаётся показанным недоступным после того, как стало
 * доступным, а заметить это можно только глазом на живой сцене.
 */
export interface StageSignals {
  readonly flying: boolean;
  readonly failure: string | null;
  readonly canFrame: boolean;
}

/**
 * Изменилось ли объявляемое. Ключи берутся у самой записи, а не перечислены
 * здесь: поле, дописанное в `StageSignals`, попадает в сравнение само, и забыть
 * его негде.
 */
export function signalsChanged(shown: StageSignals, next: StageSignals): boolean {
  return (Object.keys(next) as (keyof StageSignals)[]).some((key) => shown[key] !== next[key]);
}

export interface SceneStage extends ScenePicker {
  /**
   * Новое состояние документов; кадр покажет его не позже следующего (ED-15).
   *
   * `reapply` — подать всё заново, даже если значения совпали по ссылке.
   * Сравнение по ссылке здесь обычно и есть ответ на вопрос «изменилось ли», но
   * ровно один случай оно разбирает неверно: возврат из превью. Документы за
   * прогон не менялись, а картинка менялась — поток тиков выбил пол в СВОЁМ
   * мире, — и повторная доставка той же сетки возвращает его (REND-14), тогда
   * как пропуск по совпадению ссылок оставил бы дыру в кадре режима правки.
   */
  submit(draft: StageDraft, reapply?: boolean): void;
  /**
   * Правленый манифест визуалов целиком (REND-17): подсистема сводит поданное с
   * живыми инстансами сама. Декларативно и целиком — императивной правки одной
   * записи у неё нет, и заводить её здесь было бы вторым решением о том, что
   * пересобрать (ED-14, ED-15).
   */
  applyVisuals(visuals: VisualManifest): void;
  /** Идёт ли облёт (CAM-2) — это показывает бар области. */
  readonly flying: boolean;
  toggleFly(): void;
  zoom(steps: number): void;
  /**
   * Есть ли что кадрировать: у кадра без террейна (ED-20) арены нет вовсе, и
   * обзорное действие бара показывается недоступным (ED-26), а не молчит.
   *
   * Заводит арену первая сетка документа — то есть уже после того, как бар
   * области нарисован без неё, — поэтому смену вьюпорт объявляет сам
   * (`StageSignals`), а не ждёт, что его спросят.
   */
  readonly canFrame: boolean;
  /**
   * Обзорный кадр (ED-15): кадрирование по границам арены входом конвейера
   * (CAM-8). Запомненной позы у него нет — она разошлась бы с ареной на первой
   * же правке её размеров.
   *
   * Просьба исполняется ближайшим кадром, а не здесь: пропорции у конвейера
   * от кадра (CAM-8), а размеры холста известны только после раскладки
   * страницы. Тем же путём идёт и стартовый кадр — с мгновенным применением.
   */
  frameArena(): void;
  /** Сколько инстансов в наборе сейчас — по этому видно, что кадр не пуст. */
  readonly instanceCount: number;
  /** Сколько декораций в наборе сейчас (REND-18). */
  readonly decorationCount: number;
  /** Почему сорвался кадр; `null` — последний кадр прошёл целиком (ED-8). */
  readonly failure: string | null;
  /**
   * Presentation-сцена вьюпорта. Наружу она выходит потому, что продюсеров у
   * неё больше одного и они взаимоисключающи (REND-11): превью (ED-9)
   * публикуется в ЭТУ сцену, а не заводит вторую. У просмотрщика ассетов
   * (ED-20) кадр свой — свой холст в своей рабочей области, — и продюсер в нём
   * ровно один; собран он этой же сборкой, а не второй (ED-1).
   */
  readonly presentation: PresentationStage;
  /**
   * Контекст рендера вьюпорта (REND-8): та же сцена THREE, тот же модуль
   * ассетов, тот же конфиг. Второй продюсер получает его, а не заводит свой:
   * два контекста — это две сцены, то есть второй путь отрисовки (REND-11).
   */
  readonly context: RenderContext;
  /**
   * Подключает кадр чужого продюсера к циклу вьюпорта; возвращает отсоединение.
   *
   * Цикл кадров у редактора один — тот, что крутит `requestAnimationFrame`
   * здесь. Второй, заведённый превью, гнал бы подсистемам второй `updateFrame`
   * на том же кадре, и dt сглаживаний удваивался бы (REND-8). Кто из
   * подключённых наполняет presentation-состояние, решает не цикл, а сцена
   * (`PresentationStage.isActive`, REND-11): неактивный на свой вызов ничего не
   * делает.
   */
  attachProducer(frame: (now: number) => void): () => void;
  /** Поза последнего кадра (CAM-1); `null` — кадра ещё не было. */
  readonly pose: CameraPose | null;
  /** Полный набор служебных наложений (REND-16); пустой — гасит все. */
  setOverlays(items: readonly SceneOverlay[]): void;
  dispose(): void;
}

/**
 * Есть ли в этой среде чем рисовать. Проверка, а не try/catch: headless-прогон
 * (тесты пакета, ED-29) обязан собирать область без единого обращения к
 * WebGL, и решать это должен явный вопрос к среде.
 */
export function canRender(doc?: Document): boolean {
  return (
    typeof requestAnimationFrame === 'function' &&
    (doc ?? (typeof document === 'undefined' ? null : document)) !== null
  );
}

export function createSceneStage(options: SceneStageOptions): SceneStage {
  const doc = options.document ?? document;
  const heightStep = options.heightStep ?? HEIGHT_STEP;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  // Теневые карты включает владелец рендерера (design D8) — тем же вызовом и с
  // тем же типом фильтрации, что игровой клиент: кадр вьюпорта обязан быть тем
  // же кадром (ED-22), а не похожим. Тип — `PCFShadowMap`: `PCFSoftShadowMap` в
  // three `^0.185` устарел, и рендерер молча подменяет его этим же значением.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  // Остановка Tab у кадра остаётся: он обязан быть достижим обходом (ED-31).
  // Клавиатуру она при этом не включает — клавиши работают, пока область
  // активна, и указания на её поверхность правки не требуют (ED-32).
  canvas.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera3 = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  camera3.up.set(0, 0, 1);
  // Своего света у вьюпорта больше нет: источники арены создаёт подсистема
  // освещения из той же секции `lighting` парного документа (PRES-2), что и у
  // игрового клиента. Тождество кадров (ED-22) выполняется этим по построению,
  // а не тем, что два файла держат одинаковые числа.

  // Модуль ассетов приходит снаружи и остаётся общим на все кадры редактора
  // (ASSET-2): контекст рендера у каждого кадра свой, а кэш ассетов — один.
  //
  // Сервис спрашивается у модуля на КАЖДОМ обращении подсистем, а не кладётся
  // сюда снимком: модуль выбрасывает сервис целиком, когда изменилось
  // прочитанное им в дереве (обоснование — шапка `assetModule.ts`), и снимок
  // означал бы, что кадр отвечает на «загрузился ли этот ассет» не тем же
  // кэшем, что просмотрщик (ASSET-2).
  const context: RenderContext = {
    scene,
    get assets(): AssetService {
      return options.assets.service;
    },
    config: { heightStep },
  };
  const presentation = new PresentationStage(context);
  // Контроллер качества заводится ЗДЕСЬ, до подсистем (QUAL-1, design D2): он
  // подписан на регистрации сцены, и подсистема, поднятая первой сеткой,
  // получит текущие значения ручек ровно так же, как поднятая сразу. Своей
  // ссылки ему не нужно — переключателя качества у редактора нет и не будет:
  // авторская картинка не настройка (design D4).
  new QualityController(presentation, EDITOR_QUALITY_PRESET);
  const source = new DocumentSource(presentation);
  // Третий набор рядом с продюсером, а не второй продюсер (REND-18): декорации
  // остаются в кадре и в превью — гасить их смена режима не должна.
  const decorations = new DecorationSet(presentation);

  let surface: VisualSurfaceSource | null = null;
  let lighting: LightingSubsystem | null = null;
  let terrain: TerrainSubsystem | null = null;
  let models: ModelsSubsystem | null = null;
  let particles: ParticlesSubsystem | null = null;
  let overlays: OverlaySubsystem | null = null;
  let picking: ViewportPicking | null = null;
  let camera: SceneCamera | null = null;
  let grid: TerrainGrid | null = null;
  /** Манифест, которым живёт подсистема моделей сейчас (ASSET-6, REND-17). */
  let visuals = options.visuals;
  /** Подняты ли подсистемы: сетка их поднимает один раз, и только первая. */
  let built = false;
  let curvature: StageDraft['curvature'] = null;
  /** Поза кадра: по ней и считается луч наведения (REND-15), а не свежим опросом. */
  let pose: CameraPose | null = null;
  /** Последний поданный набор наложений — он переподаётся после сведения (REND-16). */
  let overlaySet: readonly SceneOverlay[] = [];
  /**
   * Незакрытая просьба кадрировать (CAM-8): прямоугольник и способ применения.
   * Ждёт кадра, потому что пропорции подаёт потребитель, а свои размеры холст
   * узнаёт только после раскладки страницы. Не гаснет, пока размеры нулевые:
   * стартовый кадр обязан быть кадрированным, а не пропущенным (ED-15).
   */
  let framing: { readonly rect: CameraBounds; readonly immediate: boolean } | null = null;

  let draft: StageDraft | null = null;
  let dirty = false;
  /** Подать заново, не спрашивая ссылок: так возвращается кадр после превью. */
  let reapply = false;
  /** Кадры чужих продюсеров (REND-11) — превью ED-9; в игровом кадре их нет. */
  const guests = new Set<(now: number) => void>();
  let disposed = false;
  let lastFrameAt: number | null = null;
  /**
   * Две причины, а не одна: сорвавшееся сведение документов держится до
   * следующей подачи (кадр за кадром оно не повторяется, и гасить его удачной
   * отрисовкой значило бы показать причину на один кадр — то есть не показать),
   * сорвавшаяся отрисовка держится, пока кадр не пройдёт.
   */
  let applyFailure: string | null = null;
  let drawFailure: string | null = null;
  const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  /** Что о вьюпорте уже показано интерфейсом — с этим и сверяется `onChange`. */
  let shown: StageSignals = { flying: false, failure: null, canFrame: false };

  /** Зажатое приходит от области (ED-32); своего набора у холста больше нет. */
  const heldKeys = options.keys ?? ((): ReadonlySet<string> => NO_KEYS);
  let pointer: PointerSample | null = null;
  let midDrag = false;
  let rightDrag = false;
  let leftDrag = false;

  // ---------------------------------------------------------------- ввод

  const rect = (): { left: number; top: number; width: number; height: number } => {
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };

  const onPointerMove = (event: MouseEvent): void => {
    if (midDrag) camera?.drag(event.movementX, event.movementY);
    if (rightDrag) camera?.look(event.movementX, event.movementY);
    pointer = { x: event.clientX, y: event.clientY, rect: rect() };
    tell('move', event);
  };
  const onPointerLeave = (event: MouseEvent): void => {
    pointer = null;
    // Инструменту это говорится, а не только edge-панораме: наложение, которое
    // показывало клетку под курсором, обязано погаснуть вместе с курсором
    // (REND-16). Начатое взаимодействие фаза не закрывает — отпускание придёт
    // с документа, где бы кнопку ни отпустили (ED-18).
    tell('leave', event);
  };
  /** Модификатор мультивыделения (ED-17): и Shift, и Ctrl/Cmd — обе привычки. */
  const additive = (event: MouseEvent): boolean =>
    event.shiftKey || event.ctrlKey || event.metaKey;
  const tell = (phase: StagePointer['phase'], event: MouseEvent): void => {
    options.onPointer?.({
      phase,
      x: event.clientX,
      y: event.clientY,
      additive: additive(event),
    });
  };

  const onPointerDown = (event: MouseEvent): void => {
    // Фокус холсту нажатие НЕ отдаёт: клик в кадр — не способ включить
    // клавиатуру области (ED-32), а забранный фокус увёл бы автора из виджета,
    // в котором он стоял.
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault();
      midDrag = true;
    }
    if (event.button === RIGHT_BUTTON) rightDrag = true;
    if (event.button === LEFT_BUTTON) {
      leftDrag = true;
      tell('down', event);
    }
  };
  const onPointerUp = (event: MouseEvent): void => {
    if (event.button === MIDDLE_BUTTON) midDrag = false;
    if (event.button === RIGHT_BUTTON) rightDrag = false;
    // Отпускание ловится на документе: взаимодействие обязано закрыться и
    // тогда, когда курсор ушёл с холста (ED-18 — одна запись на взаимодействие).
    if (event.button === LEFT_BUTTON && leftDrag) {
      leftDrag = false;
      tell('up', event);
    }
  };
  /**
   * Отпускание, до вьюпорта не дошедшее: окно потеряло фокус (переключение
   * приложения, системное меню), и `mouseup` в него уже не придёт. Без этого
   * взаимодействие сессии осталось бы открытым навсегда — а пока оно открыто,
   * сессия не даёт ни следующей операции, ни undo (ED-18).
   */
  const onWindowBlur = (): void => {
    if (!leftDrag) return;
    leftDrag = false;
    options.onPointer?.({ phase: 'cancel', x: 0, y: 0, additive: false });
  };
  const onContextMenu = (event: Event): void => { event.preventDefault(); };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // ~100 deltaY на щелчок колеса; трекпад копит дробные шаги.
    camera?.zoom(event.deltaY / 100);
  };

  // Указатель остаётся на холсте: edge-pan, drag и колесо — ввод мышью в кадр
  // (CAM-3), и к тому, где стоит фокус клавиатуры, он отношения не имеет.
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseleave', onPointerLeave);
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('mouseup', onPointerUp);
  const window_ = doc.defaultView;
  window_?.addEventListener('blur', onWindowBlur);

  // ------------------------------------------------------------- подсистемы

  /**
   * Первая сетка поднимает подсистемы: до неё рисовать нечего, а размеры арены
   * нужны и поверхности (REND-9), и камере (CAM-7). Порядок регистрации
   * нормативен (REND-8): террейн, модели, наложения.
   *
   * `first === null` — кадр без террейна (`terrain: false`, см. шапку): сетки не
   * будет никогда, и всё, что из неё выводится, не поднимается вовсе. Ветка
   * здесь одна и та же, потому что сборка рендера у обоих случаев одна (ED-1):
   * различаются они тем, чего у вырожденного случая нет, а не тем, как он
   * рисуется.
   */
  const build = (first: TerrainGrid | null): void => {
    built = true;
    // Свет — первой подсистемой (REND-8): геометрия ниже отдаёт ей свои корни
    // теневыми кастерами, а сам он не зависит ни от сетки, ни от манифеста.
    lighting = new LightingSubsystem(first === null ? {} : { grid: first });
    presentation.register(lighting);
    if (first !== null) {
      surface = new VisualSurfaceSource(first);
      terrain = new TerrainSubsystem(first, { surface, shadows: lighting });
      presentation.register(terrain);
    }
    // Камера подсистеме — вход отсечения невидимых инстансов (REND-21): та же
    // самая (`camera3`), которой рисуется кадр и считается луч наведения. Позу
    // на неё сажает `applyCameraPose` до кадра подсистем (см. `frame`), поэтому
    // отсекается по пирамиде ЭТОГО кадра, а не прошлого.
    models = new ModelsSubsystem(visuals, {
      camera: camera3,
      shadows: lighting,
      ...(surface === null ? {} : { surface }),
    });
    presentation.register(models);
    // Частицы (REND-24) — после моделей, как и в игровой сборке: эмиттер с
    // сокетом снимает позу узла инстанса, посаженного в этом же кадре. Автору
    // она нужна ради decoration-эмиттеров: факел на арене — такое же
    // размещение, как статуя (ASSET-14, PRES-2), и не видеть его в кадре
    // правки значило бы ставить его вслепую (ED-15). Словаря состояний у
    // редактора нет: доставленных состояний в кадре правки не бывает вовсе
    // (тика здесь нет), и записи `particles.byState` в нём не оживают.
    particles = new ParticlesSubsystem(visuals, {
      sockets: models,
      ...(surface === null ? {} : { surface }),
    });
    presentation.register(particles);
    if (surface !== null) {
      // Подсистему наложений регистрирует только вьюпорт редактора (REND-16):
      // в игровом кадре её нет по конструкции. Подсветка встаёт по видимой позе
      // инстанса, поэтому источник прокси у неё тот же, что у picking'а.
      overlays = new OverlaySubsystem({ surface, instances: models });
      presentation.register(overlays);
      // Камера picking'у отдаётся та же, которой рисуется кадр: «второго способа
      // посчитать луч MUST NOT существовать» (REND-15).
      picking = new ViewportPicking({
        surface,
        instances: models,
        handles: overlays,
        camera: camera3,
      });
    }
    // Конвейер камеры один и тот же (ED-13, CAM-1); арены без террейна у него
    // просто нет — ни границ, ни поверхности под точкой наблюдения.
    camera = createSceneCamera({ heightStep, ...(first === null ? {} : { grid: first }) });
    // Первый кадр открытой сцены показывает арену целиком (ED-15): просьба
    // кадрировать мгновенно, чтобы перелёта к обзору автор не видел. Позу
    // считает конвейер (CAM-8) — своего расчёта стартовой позы у редактора не
    // появляется, `startX/startY` остаются центром арены.
    const arena = camera.arena;
    if (arena !== null) framing = { rect: arena, immediate: true };
  };
  /** Бывает ли у этого кадра террейн: у вырожденного случая (см. шапку) — нет. */
  const hasTerrain = options.terrain !== false;
  if (!hasTerrain) build(null);

  const applyDraft = (next: StageDraft, again: boolean): void => {
    // «Сетки не будет никогда» держится сборкой, а не тем, что подающий её не
    // подаёт: подсистемы кадра без террейна подняты без поверхности, и принятая
    // сетка дала бы камере границы арены, которой в кадре нет (CAM-7).
    if (hasTerrain && next.grid !== null && (again || next.grid !== grid)) {
      const first = !built;
      grid = next.grid;
      if (first) build(next.grid);
      else {
        // Декларативная доставка сетки целиком (REND-14): подсистема сводит её
        // с нарисованным сама, а поверхность и чанки инвалидирует точечно.
        // Повторная доставка той же сетки не пуста — она возвращает карту пола
        // (REND-14), и на этом держится выход из превью (ED-9).
        terrain?.applyGrid(next.grid);
        camera?.setGrid(next.grid);
        // Границы арены сменились — фрустумы теневых камер обтянуты по ним, а
        // кэшированная карта статики устарела вместе с геометрией (REND-14).
        lighting?.applyGrid(next.grid);
      }
    }
    if (again || next.curvature !== curvature) {
      curvature = next.curvature;
      // Карта из памяти, а не ассетом: несохранённый документ кисти ассетом ещё
      // не является (ED-11, REND-14).
      surface?.setCurvature(curvature);
    }
    // Полный набор инстансов; что создать, обновить и убрать, решает источник.
    source.apply(next.placements);
    // Правка секции `lighting` — на живой подсистеме (ED-15): свет меняется не
    // позже следующего кадра, пересборки рендера нет. Подаётся секция целиком
    // и всегда, как манифест и сетка: решать, что применить, — дело подсистемы.
    lighting?.applyConfig(next.lighting);
    // Декорации — отдельный набор и отдельная подача: продюсера они не
    // трогают, и в превью их гасить нечем (REND-18).
    decorations.apply(next.decorations ?? []);
    // Наложения переподаются после набора: смена визуального типа пересоздаёт
    // инстанс с новым номером сущности, и подсветка на прежнем номере погасла
    // бы молча (REND-11, REND-16).
    pushOverlays();
  };

  // ------------------------------------------------------- picking и наложения

  /** Точка вьюпорта из координат окна; null — прямоугольника кадра ещё нет. */
  const viewportPoint = (
    x: number,
    y: number,
  ): { x: number; y: number; width: number; height: number } | null => {
    const box = rect();
    if (box.width === 0 || box.height === 0) return null;
    return { x: x - box.left, y: y - box.top, width: box.width, height: box.height };
  };

  /**
   * Копия попадания: объект сервиса переиспользуется до следующего запроса
   * (REND-15), а инструмент держит попадание от нажатия до отпускания. Ключ
   * документа даёт набор инстансов, которому он и принадлежит (REND-11).
   */
  const copyHit = (hit: PickHit | null): ScenePick | null =>
    hit === null
      ? null
      : {
          kind: hit.kind,
          handle: hit.handle,
          decoration: hit.decoration,
          // Ключ документа даёт тот набор, которому инстанс принадлежит:
          // нумерация у них своя, и спросить не тот набор значило бы получить
          // чужой ключ (REND-18).
          key:
            hit.entity === 0
              ? null
              : ((hit.decoration ? decorations.keyOf(hit.entity) : source.keyOf(hit.entity)) ?? null),
          x: hit.x,
          y: hit.y,
          z: hit.z,
          cell: hit.cell,
          cellX: hit.cellX,
          cellY: hit.cellY,
          noFloor: hit.noFloor,
          wall: hit.wall,
        };

  /** Наложения в словаре рендера: подсветка адресуется сущностью (REND-16). */
  const pushOverlays = (): void => {
    if (overlays === null) return;
    const items: OverlayItem[] = [];
    for (const item of overlaySet) {
      if (item.kind !== 'highlight') {
        items.push(item);
        continue;
      }
      // Ключ ищется в том наборе, который его и выдал: сим-объект — в
      // документном источнике, декорация — в наборе REND-18.
      const entity = item.decoration
        ? decorations.entityOf(item.placement)
        : source.entityOf(item.placement);
      // Ключа нет в наборе — рендер его не рисует, и подсвечивать нечего.
      if (entity !== undefined) {
        items.push({
          kind: 'highlight',
          key: item.key,
          entity,
          ...(item.decoration ? { decoration: true } : {}),
        });
      }
    }
    overlays.apply(items);
  };

  // ----------------------------------------------------------------- кадр

  /** Холст на месте и по размеру узла кадра: перерисовка страницы его вытесняет. */
  let sizedTo = { width: 0, height: 0 };
  const attach = (): boolean => {
    const host = doc.getElementById(options.hostId);
    if (host === null) return false;
    if (canvas.parentElement !== host) host.append(canvas);
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    // Сравнение с запрошенным размером, а не с размером буфера: буфер больше
    // на pixelRatio, и сверка с ним пересоздавала бы его каждый кадр.
    if (sizedTo.width !== width || sizedTo.height !== height) {
      sizedTo = { width, height };
      renderer.setSize(width, height);
      camera3.aspect = width / height;
      camera3.updateProjectionMatrix();
    }
    return true;
  };

  const failureNow = (): string | null => applyFailure ?? drawFailure;
  /** Есть ли арена: её заводит первая сетка документа, а не сборка вьюпорта. */
  const framableNow = (): boolean => camera?.arena != null;

  /** Сообщить интерфейсу, если у вьюпорта изменилось видимое им (CAM-2, ED-8). */
  const publish = (): void => {
    const next: StageSignals = {
      flying: camera?.flying ?? false,
      failure: failureNow(),
      canFrame: framableNow(),
    };
    if (!signalsChanged(shown, next)) return;
    shown = next;
    options.onChange?.();
  };

  const frame = (now: number): void => {
    if (disposed) return;
    // Планирование до работы: сорвавшийся кадр не имеет права увести цикл.
    requestAnimationFrame(frame);
    // Кадра нет, пока узла нет в странице: правка ждёт возвращения вьюпорта
    // (`dirty` не гаснет), а не теряется в кадре, которого никто не увидел.
    if (!attach()) return;

    const dt = lastFrameAt === null ? 0 : Math.min((now - lastFrameAt) / 1000, 0.25);
    lastFrameAt = now;

    // Флаг гасится до сведения, а не после: сорвавшееся сведение обязано
    // назвать причину, а не повторяться каждый кадр на тех же документах.
    if (dirty && draft !== null) {
      dirty = false;
      const again = reapply;
      reapply = false;
      try {
        applyDraft(draft, again);
        applyFailure = null;
      } catch (error) {
        // Последнее целое остаётся нарисованным, причина уходит в интерфейс.
        applyFailure = reasonOf(error);
      }
    }
    // Кадрирование — раньше кадра камеры и после раскладки холста: пропорции
    // подаёт потребитель (CAM-8), и до первой раскладки подавать нечего. Пока
    // размеры нулевые, просьба ждёт: кадр нулевого размера дал бы конвейеру
    // пропорции, которых у него не будет уже в следующем кадре.
    if (framing !== null && camera !== null) {
      const box = rect();
      if (box.width > 0 && box.height > 0) {
        camera.frameBounds(framing.rect, box.width / box.height, framing.immediate);
        framing = null;
      }
    }
    try {
      if (camera !== null) {
        camera.sample(heldKeys(), pointer);
        // Общая реализация применения позы (CAM-1): своей копии у редактора нет.
        // Она же запоминается: луч наведения обязан идти из позы НАРИСОВАННОГО
        // кадра, а не из свежего опроса конвейера (REND-15).
        pose = camera.frame(dt);
        applyCameraPose(camera3, pose);
      }
      // Кадр подсистем: интерполировать нечего, альфа всегда 1 (REND-11).
      source.frame(now);
      // Кадры чужих продюсеров тем же циклом (REND-8): наполняет
      // presentation-состояние ровно один из подключённых, и кто именно —
      // знает сцена, а не этот цикл.
      for (const guest of guests) guest(now);
      renderer.render(scene, camera3);
      drawFailure = null;
    } catch (error) {
      drawFailure = reasonOf(error);
    }
    publish();
  };
  requestAnimationFrame(frame);

  return {
    submit(next, again = false) {
      draft = next;
      dirty = true;
      // Просьба переподать не гаснет от следующей обычной подачи: между
      // подачей и кадром может пройти и то, и другое.
      if (again) reapply = true;
    },
    applyVisuals(next) {
      // Запоминается и тогда, когда подсистемы ещё не подняты: сетка поднимет
      // их правленым манифестом, а не тем, с которым собирался вьюпорт.
      visuals = next;
      models?.applyManifest(next);
      particles?.applyManifest(next);
    },
    get flying(): boolean {
      return camera?.flying ?? false;
    },
    toggleFly() {
      camera?.toggleFly();
    },
    zoom(steps) {
      camera?.zoom(steps);
    },
    get canFrame(): boolean {
      return framableNow();
    },
    frameArena() {
      const arena = camera?.arena ?? null;
      // Границы спрашиваются на каждый вызов, а не запоминаются: автор правит
      // размеры арены (CAM-7), и запомненный прямоугольник разошёлся бы с ней.
      if (arena !== null) framing = { rect: arena, immediate: false };
    },
    get instanceCount(): number {
      return source.size;
    },
    get decorationCount(): number {
      return decorations.size;
    },
    get failure(): string | null {
      return failureNow();
    },
    presentation,
    context,
    attachProducer(guest) {
      // Недоставленная подача документов гасится: пока presentation-состояние
      // наполняет чужой продюсер, сводить её нельзя — она отобрала бы у него
      // состояние посреди прогона (REND-11). Потерять её нечего: возврат к
      // документам идёт переподачей целиком (`submit(draft, true)`).
      dirty = false;
      guests.add(guest);
      return () => {
        guests.delete(guest);
      };
    },
    get pose(): CameraPose | null {
      return pose;
    },
    pick(x, y) {
      if (picking === null || pose === null) return null;
      const point = viewportPoint(x, y);
      return point === null ? null : copyHit(picking.pick(pose, point));
    },
    pickSurface(x, y) {
      if (picking === null || pose === null) return null;
      const point = viewportPoint(x, y);
      return point === null ? null : copyHit(picking.pickSurface(pose, point));
    },
    setOverlays(items) {
      overlaySet = items;
      pushOverlays();
    },
    dispose() {
      disposed = true;
      // Сессия живёт дольше вьюпорта: снос кадра посреди перетаскивания не имеет
      // права оставить её взаимодействие открытым.
      onWindowBlur();
      canvas.removeEventListener('mousemove', onPointerMove);
      canvas.removeEventListener('mouseleave', onPointerLeave);
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      doc.removeEventListener('mouseup', onPointerUp);
      window_?.removeEventListener('blur', onWindowBlur);
      canvas.remove();
      renderer.dispose();
    },
  };
}
