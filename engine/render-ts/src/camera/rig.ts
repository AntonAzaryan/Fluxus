/**
 * CameraRig — клиентская камера как чистый конвейер позы (CAM-1): режимы
 * follow / free-RTS / fly (CAM-2) → логическая поза; эффекты (`effects.ts`)
 * накладываются поверх отдельным слоем. Поза — данные без привязки к
 * графической библиотеке; применение к THREE-камере — одна функция на
 * стороне сборки.
 *
 * Камера не касается симуляции: ввод камеры не пересекает границу воркера,
 * состояние rig'а не входит в откатываемое состояние и не реагирует на
 * rewind/replay (CAM-5) — единственная видимая ему сторона отката — snap
 * follow-цели, приезжающий готовым флагом из `ViewBuffer` (REND-2).
 *
 * Высота точки наблюдения во всех режимах, кроме fly, — уровень клифа под
 * ней (CAM-2), сглаженный; вертикальная координата цели не читается вовсе:
 * подброс героя камеру не качает.
 *
 * Вход кадрирования (`frameBounds`, CAM-8) — вход этого же конвейера, а не
 * вторая поза и не четвёртый режим: он меняет ровно те величины, которыми
 * управляют панорамирование и зум, и после него камера работает как обычно.
 *
 * Источник поверхности и границы инжектирует потребитель и может переподать
 * их работающему конвейеру (`setSources`, CAM-7): в матче арена иммутабельна
 * (TERR-6) и переподачи нет ни разу, а в редакторе автор правит геометрию и
 * меняет размеры арены, не теряя ни режима, ни зума, ни вида.
 */
import { framingDistance } from './framing.js';
import { CameraFly } from './fly.js';
import { CameraPathPlayer, type CameraPath } from './path.js';
import type { CameraInput } from './input.js';

// ---------------------------------------------------------------- контракты

/**
 * Режимы конвейера (CAM-2) плюс кинематографический путь (CAM-10). Путь —
 * режим, а не вход, по тому же основанию, что и fly: он позу ПРОИЗВОДИТ, а не
 * ведёт уже существующую, и панорамирование с зумом в это время не действуют.
 */
export type CameraMode = 'follow' | 'free' | 'fly' | 'path';

/**
 * Логическая поза камеры (CAM-1): позиция глаза и углы взгляда.
 * `yaw` — азимут в плоскости XY (радианы), `pitch` — наклон вниз от
 * горизонтали (положительный — смотрим вниз), `roll` — крен, `fovDeg` —
 * вертикальный угол обзора в градусах.
 */
export interface CameraPose {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  roll: number;
  fovDeg: number;
}

/** Follow-цель: интерполированная горизонталь и snap-флаг из `EntityView` (REND-2). */
export interface FollowTarget {
  readonly x: number;
  readonly y: number;
  /**
   * РОД разрыва непрерывности цели в последнем тике, поднятый политикой рендера
   * (REND-2). Прыжок камеры — не он один: величину сравнивает с собственным
   * порогом сама камера (CAM-5, `CameraConfig.snapDistance`).
   */
  readonly snap: boolean;
}

/** Границы, в которых живёт точка наблюдения (CAM-3). */
export interface CameraBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Политика камеры (CAM-1): все настроечные числа в одном месте, код режимов —
 * механизм. Дефолты — стартовая точка, сборка переопределяет частично.
 */
export interface CameraConfig {
  /** Наклон взгляда вниз от горизонтали, радианы. */
  readonly pitch: number;
  /** Азимут взгляда, радианы; π/2 — камера южнее цели, смотрит на север. */
  readonly yaw: number;
  readonly fovDeg: number;
  readonly distance: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Множитель дистанции на один шаг колеса (CAM-4). */
  readonly zoomStep: number;
  /** Экспоненты сглаживаний, 1/с. */
  readonly followSmoothing: number;
  readonly zoomSmoothing: number;
  readonly heightSmoothing: number;
  readonly recenterSmoothing: number;
  /** Панорама, мировых единиц/с на дистанции `distance` (масштабируется зумом). */
  readonly panSpeed: number;
  /** Drag: мировых единиц на пиксель на дистанции `distance`. */
  readonly dragPanPerPx: number;
  /** Ширина зоны edge-pan у границ канваса, px (используется сборкой). */
  readonly edgeMarginPx: number;
  /** Запас клампа точки наблюдения внутрь границ арены, мировых единиц. */
  readonly boundsMargin: number;
  /** Разрыв follow-цели больше этого — snap без проезда (CAM-5). */
  readonly snapDistance: number;
  /** Перелёт центрирования считается завершённым ближе этого, мировых единиц. */
  readonly recenterEpsilon: number;
  /** Fly: стартовая скорость (ед/с), пределы и множитель шага колеса. */
  readonly flySpeed: number;
  readonly flySpeedMin: number;
  readonly flySpeedMax: number;
  readonly flySpeedStep: number;
  /** Fly: чувствительность осмотра, радиан на пиксель. */
  readonly lookSensitivity: number;
  /** Глобальный множитель силы эффектов камеры, 0 — полное отключение (CAM-6). */
  readonly effectsMultiplier: number;
}

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  pitch: (50 * Math.PI) / 180,
  yaw: Math.PI / 2,
  fovDeg: 45,
  distance: 16,
  minDistance: 8,
  maxDistance: 28,
  zoomStep: 1.15,
  followSmoothing: 6,
  zoomSmoothing: 8,
  heightSmoothing: 8,
  recenterSmoothing: 10,
  panSpeed: 14,
  dragPanPerPx: 0.02,
  edgeMarginPx: 24,
  boundsMargin: 2,
  snapDistance: 2,
  recenterEpsilon: 0.1,
  flySpeed: 12,
  flySpeedMin: 2,
  flySpeedMax: 60,
  flySpeedStep: 1.2,
  lookSensitivity: 0.005,
  effectsMultiplier: 1,
};

/**
 * Инжектируемая потребителем часть конвейера (CAM-7): источник высоты и
 * границы. Тот же набор принимает конструктор и `CameraRig.setSources` —
 * состав инжекции при создании и при переподаче один по построению.
 * Отсутствующее поле оставляет прежнее значение, `null` снимает источник.
 */
export interface CameraSources {
  /** Высота поверхности (уровень клифа × шаг высоты) под мировой точкой (CAM-2). */
  readonly groundHeightAt?: ((x: number, y: number) => number) | null;
  readonly bounds?: CameraBounds | null;
}

export interface CameraRigOptions extends CameraSources {
  readonly config?: Partial<CameraConfig>;
  /** Стартовая точка наблюдения. */
  readonly startX?: number;
  readonly startY?: number;
}

/**
 * Запрос кадрирования (CAM-8): «показать заданные границы». Вход того же
 * конвейера, а не вторая поза — он меняет ровно те величины, которыми
 * управляют панорамирование (CAM-3) и зум (CAM-4).
 *
 * Пропорции кадра подаёт потребитель: конвейер headless (CAM-1) и своих
 * размеров не знает, а горизонтальный угол обзора без соотношения сторон не
 * вычисляется. В конфиг они не переезжают — конфиг переживает ресайз окна, а
 * пропорции нет.
 */
export interface CameraFraming {
  /** Прямоугольник в мировых координатах. Инжектированные границы он не подменяет (CAM-7). */
  readonly rect: CameraBounds;
  /** Соотношение сторон кадра — ширина к высоте. */
  readonly aspect: number;
  /**
   * Мгновенное применение вместо сглаженного перелёта. Существует ради первого
   * кадра потребителя: стартовый кадр обязан быть уже кадрированным, а не
   * приезжать в него на глазах у автора.
   */
  readonly immediate?: boolean;
}

// ------------------------------------------------------------------- helpers

/** Экспоненциальное сглаживание, независимое от кадровой частоты. */
const ease = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Кламп в интервал, который может оказаться пустым: арена меньше двойного
 * запаса не оставляет допустимых положений вовсе (CAM-7), и симметричный
 * ответ один — середина, то есть центр арены.
 */
const clampInside = (v: number, lo: number, hi: number): number =>
  lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi);

// ----------------------------------------------------------------------- rig

export class CameraRig {
  readonly config: CameraConfig;

  /** Инжектированные источники (CAM-7); переподаются `setSources`. */
  private groundHeightAt: ((x: number, y: number) => number) | null;
  private bounds: CameraBounds | null;

  private modeState: CameraMode = 'follow';
  /** Точка наблюдения (сглаженная) и её высота по поверхности. */
  private targetX: number;
  private targetY: number;
  private targetZ = 0;
  private hasGround = false;
  /** Дистанция: желаемая (мгновенно от колеса) и сглаженная (CAM-4). */
  private desiredDistance: number;
  private distance: number;
  /** Перелёт центрирования к герою (CAM-2), гасится вводом панорамы. */
  private recentering = false;
  /**
   * Незакрытый сглаженный перелёт кадрирования (CAM-8) и его назначение — уже
   * склампленное по инжектированным границам. Гасится вводом панорамы и
   * переходом в follow тем же правилом, что и центрирование: обе просьбы
   * разовые, и обе автор отменяет тем, что берёт камеру в руки (CAM-3).
   */
  private framing = false;
  private framingX = 0;
  private framingY = 0;
  /**
   * Позиция follow-цели на ПРОШЛОМ кадре: по ней меряется её смещение, когда
   * рендер поднял признак разрыва (CAM-5). `null` — цели на прошлом кадре не
   * было (её нет вовсе, она только что появилась или сменилась), и мерить
   * тогда не от чего.
   */
  private lastTargetX: number | null = null;
  private lastTargetY: number | null = null;
  /**
   * Проигрыватель кинематографического пути (CAM-10) и режим, из которого путь
   * запущен: по концу конвейер возвращается в него — доигравший путь камеру
   * удерживать не вправе.
   */
  private readonly player = new CameraPathPlayer();
  private pathReturn: CameraMode = 'free';
  /** Состояние облёта (CAM-2); за пределами fly не используется (`fly.ts`). */
  private readonly fly: CameraFly;

  /** Переиспользуемая поза (CAM-1): валидна до следующего `update`. */
  private readonly pose: CameraPose;

  constructor(options: CameraRigOptions = {}) {
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...options.config };
    this.groundHeightAt = options.groundHeightAt ?? null;
    this.bounds = options.bounds ?? null;
    this.targetX = options.startX ?? 0;
    this.targetY = options.startY ?? 0;
    this.desiredDistance = this.config.distance;
    this.distance = this.config.distance;
    this.fly = new CameraFly(this.config);
    this.pose = {
      posX: 0,
      posY: 0,
      posZ: 0,
      yaw: this.config.yaw,
      pitch: this.config.pitch,
      roll: 0,
      fovDeg: this.config.fovDeg,
    };
  }

  get mode(): CameraMode {
    return this.modeState;
  }

  /**
   * Переподача инжектированных источников работающему конвейеру (CAM-7):
   * автор поменял размеры арены или правит её геометрию. Отсутствующее поле
   * оставляет прежнее значение, `null` снимает источник.
   *
   * Новые границы применяются сразу, а не в ближайшем кадре: точку наблюдения
   * до него успевает прочитать диспетчер эффектов (CAM-6). Высота, наоборот,
   * не пересчитывается здесь — её тянет к новой поверхности кадр своим
   * сглаживанием (CAM-2), и накопленное значение не сбрасывается.
   */
  setSources(sources: CameraSources): void {
    if (sources.groundHeightAt !== undefined) {
      this.groundHeightAt = sources.groundHeightAt;
    }
    if (sources.bounds !== undefined) {
      this.bounds = sources.bounds;
      this.clampToBounds();
    }
  }

  /**
   * Кадрирование по заданным границам (CAM-8): точка наблюдения в центр
   * прямоугольника, дистанция — такая, чтобы прямоугольник поместился в кадр
   * при действующих наклоне, повороте и FOV (CAM-1).
   *
   * Разовый вход, а не режим: следующий кадр к поданному прямоугольнику не
   * возвращается, панорама и зум после него работают как обычно. Режим (CAM-2)
   * кадрирование не меняет — вызванное в fly, оно адресуется наземным величинам
   * и становится видимым при возврате из облёта.
   *
   * Применений два (CAM-8). Мгновенное ставит и точку наблюдения, и обе
   * дистанции разом — ради первого кадра потребителя. Сглаженное — перелёт тем
   * же сглаживанием, что и прочие переходы (CAM-2): точка наблюдения едет к
   * центру ровно так же, как её ведёт центрирование к герою, а дистанция —
   * своим `zoomSmoothing`. Телепорт точки наблюдения при сглаженной дистанции
   * перелётом не является: половина кадра прыгала бы, половина приезжала.
   *
   * Геометрия дистанции — чистая функция чисел (`framing.ts`): состояния рига
   * она не читает, а кламп по инжектированным границам и выбор «мгновенно или
   * перелётом» остаются здесь.
   */
  frameBounds(request: CameraFraming): void {
    const rect = request.rect;
    const distance = framingDistance(this.config, rect, request.aspect);

    // Центр клампится по ИНЖЕКТИРОВАННЫМ границам (CAM-3, CAM-7): кадрируют по
    // аргументу, а клампят по инжектированному — поданный прямоугольник границ
    // не подменяет. Клампится именно назначение, а не догоняющая его точка:
    // перелёт к недостижимому назначению не кончился бы никогда.
    const centerX = this.clampedX((rect.minX + rect.maxX) / 2);
    const centerY = this.clampedY((rect.minY + rect.maxY) / 2);
    // Перелёт центрирования к герою (CAM-2) — такая же разовая просьба, и
    // оставленный незавершённым он утащил бы кадрированную точку обратно уже
    // следующим кадром.
    this.recentering = false;

    this.desiredDistance = distance;
    if (request.immediate === true) {
      this.framing = false;
      this.targetX = centerX;
      this.targetY = centerY;
      // Мгновенное применение выставляет и сглаженную дистанцию: иначе первый
      // кадр всё равно приезжает к ней сглаживанием `zoomSmoothing`.
      this.distance = distance;
      return;
    }
    this.framing = true;
    this.framingX = centerX;
    this.framingY = centerY;
  }

  /** Fly владеет клавиатурой движения: ввод героя в симуляцию не уходит (CAM-2). */
  capturesMovement(): boolean {
    return this.modeState === 'fly';
  }

  /**
   * Запуск кинематографического пути (CAM-10): режим `path`, время с нуля.
   * Режим, из которого путь запущен, запоминается — по концу конвейер вернётся
   * в него: доигравший путь удерживать камеру MUST NOT.
   *
   * Запуск из fly возвращает в fly: облёт — явный переключатель (CAM-2), и путь
   * его не отменяет.
   */
  playPath(path: CameraPath): void {
    if (this.modeState !== 'path') this.pathReturn = this.modeState;
    this.player.start(path);
    this.modeState = 'path';
    // Разовые перелёты пути не нужны: позу он производит целиком сам.
    this.framing = false;
    this.recentering = false;
  }

  /** Остановка пути (CAM-10): возврат в режим, из которого он был запущен. */
  stopPath(): void {
    if (this.modeState !== 'path') return;
    this.player.stop();
    this.modeState = this.pathReturn;
  }

  /** Секунды, пройденные текущим путём; вне режима `path` — 0 (вход панели и тестов). */
  get pathTime(): number {
    return this.modeState === 'path' ? this.player.time : 0;
  }

  /**
   * Высота поверхности под точкой наблюдения (CAM-2) — наблюдаемая величина
   * конвейера. Прицельным лучом сборки она больше не является: курсор
   * разрешается проекцией на визуальную поверхность (`rendering` REND-42), а не
   * плоскостью этой высоты.
   */
  get groundZ(): number {
    return this.targetZ;
  }

  /** Точка наблюдения — центр затухания импульсных эффектов по расстоянию (CAM-6). */
  get focusX(): number {
    return this.targetX;
  }

  get focusY(): number {
    return this.targetY;
  }

  /**
   * Кадр камеры: ввод + dt + follow-цель → логическая поза. Возвращаемый
   * объект переиспользуется (валиден до следующего вызова); эффекты
   * накладываются поверх отдельным слоем (CAM-6).
   */
  update(input: CameraInput, dt: number, target: FollowTarget | null): CameraPose {
    // Путь прерывается вводом ДО кадра режима (CAM-10): автор, взявший камеру
    // в руки, получает её ТЕМ ЖЕ кадром, а не следующим, — и тот же ввод, каким
    // он её забрал, действует на восстановленный режим сразу.
    if (this.modeState === 'path' && this.pathInterrupted(input)) this.stopPath();
    if (input.flyToggle) this.toggleFly();

    if (this.modeState === 'path') {
      this.updatePath(dt);
    } else if (this.modeState === 'fly') {
      this.fly.update(input, dt, this.pose);
    } else {
      this.updateGrounded(input, dt, target);
    }
    // Позиция цели запоминается на КАЖДОМ кадре и во всех режимах, а не только
    // в follow: смещение (CAM-5) — свойство цели, а не режима, и вернувшийся из
    // free-панорамы кадр обязан мерить его от свежей позиции, а не от той, на
    // которой follow прервался. Цели нет — память чистится: догонять после
    // паузы в существовании цели нечего, это разрыв по определению.
    this.lastTargetX = target === null ? null : target.x;
    this.lastTargetY = target === null ? null : target.y;
    return this.pose;
  }

  // ------------------------------------------------------------- follow/free

  private updateGrounded(input: CameraInput, dt: number, target: FollowTarget | null): void {
    const panX = this.panAxis(input.panX + input.edgeX);
    const panY = this.panAxis(input.panY + input.edgeY);
    const panActive = panX !== 0 || panY !== 0 || input.dragDX !== 0 || input.dragDY !== 0;
    this.applyModeTransitions(input, target, panActive);
    this.applyZoom(input, dt);
    // Решение «точка наблюдения прыгнула» родит только follow (CAM-5); free и
    // fly не порождают его никогда — там порог не действует вовсе.
    let jumped = false;
    if (this.modeState === 'follow' && target !== null) {
      jumped = this.advanceFollow(target, dt);
    } else {
      this.advanceFree(input, panX, panY, dt, target);
    }
    this.clampToBounds();
    this.advanceGroundHeight(jumped, dt);
    this.writeGroundedPose();
  }

  /**
   * Переходы режимов (CAM-2): панорама открепляет, followToggle залипает,
   * centerTap запускает перелёт, centerHeld держит на герое.
   */
  private applyModeTransitions(
    input: CameraInput,
    target: FollowTarget | null,
    panActive: boolean,
  ): void {
    if (panActive) {
      this.modeState = 'free';
      this.recentering = false;
      this.framing = false;
    }
    // Явное открепление (CAM-8): follow → free-RTS, не двигая ни точки
    // наблюдения, ни дистанции. Разовые перелёты оно НЕ гасит — открепление и
    // заводится ради того, чтобы перелёт кадрирования стал возможен: в follow
    // точку наблюдения каждый кадр переписывает цель, и кадрирование там
    // инертно. Ввод панорамирования гасит их по-прежнему (CAM-3) — это
    // отдельное правило, и открепление его не отменяет.
    if (input.detach) {
      this.modeState = 'free';
      this.recentering = false;
    }
    if (input.followToggle && target !== null) {
      this.modeState = 'follow';
      this.recentering = false;
      this.framing = false;
    }
    if (input.centerTap && this.modeState === 'free' && target !== null) {
      this.recentering = true;
    }
  }

  /** Зум (CAM-4): желаемая дистанция мгновенно, фактическая — сглаженно. */
  private applyZoom(input: CameraInput, dt: number): void {
    const cfg = this.config;
    if (input.wheelSteps !== 0) {
      this.desiredDistance = clamp(
        this.desiredDistance * Math.pow(cfg.zoomStep, input.wheelSteps),
        cfg.minDistance,
        cfg.maxDistance,
      );
    }
    this.distance += (this.desiredDistance - this.distance) * ease(cfg.zoomSmoothing, dt);
  }

  /**
   * Проезд точки наблюдения за follow-целью (CAM-5).
   *
   * Признак `target.snap` — РОД разрыва, поднятый политикой рендера (REND-2:
   * спавн, телепорт, rewind/replay); величины у неё нет, и порога камере она не
   * даёт. Порогом владеет CAM-5, поэтому прыжок случается не по признаку, а по
   * признаку И смещению цели больше `snapDistance` (CAM-1): «подпороговый
   * телепорт инстанс снапит, а камера доводит сглаживанием — она следует за
   * целью, а не рисует её».
   *
   * Возвращает САМО РЕШЕНИЕ — прыгнула точка наблюдения или доехала. По нему, а
   * не по сырому признаку, снапается и высота (CAM-5): признак приходит рендером
   * и в free-RTS, и в fly, где порог не действует вовсе, а половина позы,
   * приезжающая плавно, и половина, прыгающая, — это и есть тот «проезд», от
   * которого требование избавляет.
   */
  private advanceFollow(target: FollowTarget, dt: number): boolean {
    if (target.snap && this.targetJumped(target)) {
      this.targetX = target.x;
      this.targetY = target.y;
      return true;
    }
    const s = ease(this.config.followSmoothing, dt);
    this.targetX += (target.x - this.targetX) * s;
    this.targetY += (target.y - this.targetY) * s;
    return false;
  }

  /**
   * Смещение цели с прошлого кадра больше собственного порога камеры (CAM-5).
   * Прошлой позиции нет — разрыв надпороговый: цель только что появилась
   * (спавн) или сменилась, и «доехать сглаживанием» тут значило бы проехать
   * через всю арену от чужой точки.
   */
  private targetJumped(target: FollowTarget): boolean {
    if (this.lastTargetX === null || this.lastTargetY === null) return true;
    const dx = target.x - this.lastTargetX;
    const dy = target.y - this.lastTargetY;
    return Math.hypot(dx, dy) > this.config.snapDistance;
  }

  /**
   * Free-RTS (CAM-3): скорость панорамы масштабируется дистанцией — на
   * отдалённой камере экранная скорость ощущается одинаковой. Поверх панорамы
   * идут перелёт кадрирования (CAM-8) и центрирование к герою (CAM-2).
   */
  private advanceFree(
    input: CameraInput,
    panX: number,
    panY: number,
    dt: number,
    target: FollowTarget | null,
  ): void {
    const cfg = this.config;
    const zoomScale = this.distance / cfg.distance;
    const speed = cfg.panSpeed * zoomScale;
    this.targetX += panX * speed * dt;
    this.targetY += panY * speed * dt;
    this.targetX -= input.dragDX * cfg.dragPanPerPx * zoomScale;
    this.targetY += input.dragDY * cfg.dragPanPerPx * zoomScale;

    if (this.framing) this.advanceFraming(dt);
    const held = input.centerHeld && target !== null;
    if ((this.recentering || held) && target !== null) this.advanceRecenter(target, dt);
  }

  /**
   * Перелёт кадрирования (CAM-8) — тем же сглаживанием, что и центрирование к
   * герою: назначение уже склампено, поэтому доехать до него можно, и доехавший
   * перелёт садится в него точно, а не «в пределах epsilon».
   */
  private advanceFraming(dt: number): void {
    const cfg = this.config;
    const s = ease(cfg.recenterSmoothing, dt);
    this.targetX += (this.framingX - this.targetX) * s;
    this.targetY += (this.framingY - this.targetY) * s;
    if (
      Math.hypot(this.framingX - this.targetX, this.framingY - this.targetY) <
      cfg.recenterEpsilon
    ) {
      this.targetX = this.framingX;
      this.targetY = this.framingY;
      this.framing = false;
    }
  }

  /** Центрирование к герою из free-режима (CAM-2): tap доезжает, hold держит. */
  private advanceRecenter(target: FollowTarget, dt: number): void {
    const cfg = this.config;
    const s = ease(cfg.recenterSmoothing, dt);
    this.targetX += (target.x - this.targetX) * s;
    this.targetY += (target.y - this.targetY) * s;
    if (Math.hypot(target.x - this.targetX, target.y - this.targetY) < cfg.recenterEpsilon) {
      this.recentering = false;
    }
  }

  /**
   * Высота — уровень клифа под точкой наблюдения (CAM-2), не z цели.
   *
   * Снапается она по РЕШЕНИЮ follow-режима (`jumped`), а не по сырому признаку
   * разрыва: признак — род разрыва, поднятый рендером (REND-2), и он приезжает
   * в любом режиме. Прыжок по нему означал бы, что `snapAll` доставки (перемотка,
   * реплей) двигает Z во free-RTS, где CAM-5 велит камере не реагировать вовсе,
   * а подпороговый телепорт в follow сглаживает XY и прыгает Z.
   *
   * Первый кадр (`hasGround === false`) исключением не является и решением не
   * считается: сглаживать тогда не от чего.
   */
  private advanceGroundHeight(jumped: boolean, dt: number): void {
    if (this.groundHeightAt === null) return;
    const ground = this.groundHeightAt(this.targetX, this.targetY);
    if (!this.hasGround || jumped) {
      this.targetZ = ground;
      this.hasGround = true;
      return;
    }
    this.targetZ += (ground - this.targetZ) * ease(this.config.heightSmoothing, dt);
  }

  /** Логическая поза орбитальной камеры вокруг точки наблюдения (CAM-1). */
  private writeGroundedPose(): void {
    const cfg = this.config;
    const pose = this.pose;
    const forwardXY = Math.cos(cfg.pitch);
    pose.posX = this.targetX - Math.cos(cfg.yaw) * forwardXY * this.distance;
    pose.posY = this.targetY - Math.sin(cfg.yaw) * forwardXY * this.distance;
    pose.posZ = this.targetZ + Math.sin(cfg.pitch) * this.distance;
    pose.yaw = cfg.yaw;
    pose.pitch = cfg.pitch;
    pose.roll = 0;
    pose.fovDeg = cfg.fovDeg;
  }

  /**
   * Кламп точки наблюдения в границы арены с запасом (CAM-3). Один хелпер на
   * кадр и на переподачу границ (CAM-7): второй способ клампить разошёлся бы
   * с первым, как разошлись бы две реализации применения позы (CAM-1).
   */
  private clampToBounds(): void {
    this.targetX = this.clampedX(this.targetX);
    this.targetY = this.clampedY(this.targetY);
  }

  /** Та же граница с запасом, применённая к одной координате (CAM-3, CAM-7). */
  private clampedX(v: number): number {
    const bounds = this.bounds;
    if (bounds === null) return v;
    const margin = this.config.boundsMargin;
    return clampInside(v, bounds.minX + margin, bounds.maxX - margin);
  }

  private clampedY(v: number): number {
    const bounds = this.bounds;
    if (bounds === null) return v;
    const margin = this.config.boundsMargin;
    return clampInside(v, bounds.minY + margin, bounds.maxY - margin);
  }

  /** Мёртвая зона и кламп осей панорамы. */
  private panAxis(v: number): number {
    return Math.abs(v) < 1e-3 ? 0 : clamp(v, -1, 1);
  }

  // -------------------------------------------------------------------- fly

  private toggleFly(): void {
    if (this.modeState === 'fly') {
      // Возврат в free-RTS: точка наблюдения осталась где была до полёта.
      this.modeState = 'free';
      return;
    }
    // Вход: полёт стартует из текущей позы, чтобы не было скачка.
    this.fly.enter(this.pose);
    this.modeState = 'fly';
  }

  /**
   * Кадр кинематографического пути (CAM-10): поза целиком из данных пути,
   * панорамирование и зум не действуют. Прерывается тем же вводом, каким
   * панорама открепляет follow (CAM-2): автор, взявший камеру в руки, получает
   * её немедленно; по концу пути конвейер возвращается в прежний режим.
   */
  private updatePath(dt: number): void {
    const pose = this.player.advance(dt);
    if (pose === null) {
      this.stopPath();
      return;
    }
    this.targetX = pose.x;
    this.targetY = pose.y;
    this.distance = pose.distance;
    this.desiredDistance = pose.distance;
    // Высота точки наблюдения — по поверхности, как во всех наземных режимах
    // (CAM-2): путь ведёт горизонталь, а не вертикаль арены.
    this.advanceGroundHeight(true, dt);
    this.writePathPose(pose.yaw, pose.pitch, pose.fovDeg);
    if (!this.player.active) this.stopPath();
  }

  /**
   * Ввод, забирающий камеру у пути (CAM-10) — тот же, каким панорама открепляет
   * follow (CAM-2), плюс явные переключатели режимов: поза, которую производит
   * путь, чужому решению о режиме не подчиняется, и разрешается это в пользу
   * автора.
   *
   * Поза при этом остаётся там, где путь её оставил: возврат идёт с неё, без
   * скачка, — точка наблюдения и дистанция пути становятся действующими.
   */
  private pathInterrupted(input: CameraInput): boolean {
    return (
      this.panAxis(input.panX + input.edgeX) !== 0 ||
      this.panAxis(input.panY + input.edgeY) !== 0 ||
      input.dragDX !== 0 ||
      input.dragDY !== 0 ||
      input.detach ||
      input.followToggle ||
      input.flyToggle
    );
  }

  /** Поза орбитальной камеры по величинам пути (CAM-10) — те же оси, что у CAM-1. */
  private writePathPose(yaw: number, pitch: number, fovDeg: number): void {
    const pose = this.pose;
    const forwardXY = Math.cos(pitch);
    pose.posX = this.targetX - Math.cos(yaw) * forwardXY * this.distance;
    pose.posY = this.targetY - Math.sin(yaw) * forwardXY * this.distance;
    pose.posZ = this.targetZ + Math.sin(pitch) * this.distance;
    pose.yaw = yaw;
    pose.pitch = pitch;
    pose.roll = 0;
    pose.fovDeg = fovDeg;
  }
}
