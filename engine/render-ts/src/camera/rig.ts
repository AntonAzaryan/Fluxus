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
import type { CameraInput } from './input.js';

// ---------------------------------------------------------------- контракты

export type CameraMode = 'follow' | 'free' | 'fly';

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
  /** Fly-состояние; за пределами fly не используется. */
  private flyX = 0;
  private flyY = 0;
  private flyZ = 0;
  private flyYaw: number;
  private flyPitch: number;
  private flySpeed: number;

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
    this.flyYaw = this.config.yaw;
    this.flyPitch = this.config.pitch;
    this.flySpeed = this.config.flySpeed;
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
   * Геометрия. Точка наземного прямоугольника, отстоящая от центра на `s` вдоль
   * направления взгляда, лежит в кадровых координатах на глубине `s·cos p + d`
   * и на высоте `s·sin p` (p — наклон, d — дистанция). Условие «попадает в
   * вертикальный угол» упирается первым у ближнего края (s < 0), откуда
   * `d ≥ h·(sin p / tan v + cos p)`. Поперёк взгляда высоты нет, а глубина у
   * ближнего края наименьшая, откуда `d ≥ w / tan h + h·cos p`. Ограничивающим
   * берётся больший из двух: тот габарит, который упирается первым.
   */
  frameBounds(request: CameraFraming): void {
    const cfg = this.config;
    const rect = request.rect;
    // Полуразмеры прямоугольника в осях кадра: прямоугольник задан в мировых
    // осях, а упирается он в углы кадра, повёрнутого на `yaw`. Опорная функция
    // прямоугольника вдоль оси и даёт полуразмер вдоль неё.
    const halfX = Math.abs(rect.maxX - rect.minX) / 2;
    const halfY = Math.abs(rect.maxY - rect.minY) / 2;
    const cosYaw = Math.abs(Math.cos(cfg.yaw));
    const sinYaw = Math.abs(Math.sin(cfg.yaw));
    const along = cosYaw * halfX + sinYaw * halfY;
    const across = sinYaw * halfX + cosYaw * halfY;

    const tanV = Math.tan(((cfg.fovDeg / 2) * Math.PI) / 180);
    const cosPitch = Math.cos(cfg.pitch);
    const sinPitch = Math.sin(cfg.pitch);
    const vertical = tanV > 0 ? along * (sinPitch / tanV + cosPitch) : along;
    // Пропорции кадра — от потребителя, и негодные (кадр нулевого размера) не
    // повод отдать NaN: горизонталь тогда не ограничивает, а вертикаль считается
    // как считалась. Спрашивать размеры конвейеру всё равно негде (CAM-1).
    const tanH = Number.isFinite(request.aspect) && request.aspect > 0 ? tanV * request.aspect : 0;
    const horizontal = tanH > 0 ? across / tanH + along * cosPitch : 0;

    // Кламп теми же пределами, что зум (CAM-4): прямоугольник, не влезающий на
    // предельной дистанции, показывается настолько целиком, насколько пределы
    // позволяют, и отказом это не является — нужен обзор шире, это настройка
    // пределов в конфиге (CAM-1), а не обход клампа кадрированием.
    const distance = clamp(
      Math.max(vertical, horizontal),
      cfg.minDistance,
      cfg.maxDistance,
    );

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

  /** Высота поверхности под точкой наблюдения — плоскость прицельного луча сборки. */
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
    if (input.flyToggle) this.toggleFly();

    if (this.modeState === 'fly') {
      this.updateFly(input, dt);
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
    if (this.modeState === 'follow' && target !== null) {
      this.advanceFollow(target, dt);
    } else {
      this.advanceFree(input, panX, panY, dt, target);
    }
    this.clampToBounds();
    this.advanceGroundHeight(target, dt);
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
   */
  private advanceFollow(target: FollowTarget, dt: number): void {
    if (target.snap && this.targetJumped(target)) {
      this.targetX = target.x;
      this.targetY = target.y;
      return;
    }
    const s = ease(this.config.followSmoothing, dt);
    this.targetX += (target.x - this.targetX) * s;
    this.targetY += (target.y - this.targetY) * s;
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
   * Высота — уровень клифа под точкой наблюдения (CAM-2), не z цели; snap цели
   * протаскивает и высоту без проезда.
   */
  private advanceGroundHeight(target: FollowTarget | null, dt: number): void {
    if (this.groundHeightAt === null) return;
    const ground = this.groundHeightAt(this.targetX, this.targetY);
    if (!this.hasGround || (target?.snap ?? false)) {
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
    this.flyX = this.pose.posX;
    this.flyY = this.pose.posY;
    this.flyZ = this.pose.posZ;
    this.flyYaw = this.pose.yaw;
    this.flyPitch = this.pose.pitch;
    this.modeState = 'fly';
  }

  private updateFly(input: CameraInput, dt: number): void {
    const cfg = this.config;
    // Колесо в fly — скорость полёта, не дистанция (CAM-4).
    if (input.wheelSteps !== 0) {
      this.flySpeed = clamp(
        this.flySpeed * Math.pow(cfg.flySpeedStep, -input.wheelSteps),
        cfg.flySpeedMin,
        cfg.flySpeedMax,
      );
    }
    this.flyYaw -= input.lookDX * cfg.lookSensitivity;
    this.flyPitch = clamp(
      this.flyPitch + input.lookDY * cfg.lookSensitivity,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );

    const cosP = Math.cos(this.flyPitch);
    // Векторы взгляда: forward — куда смотрим, right — вбок в плоскости XY.
    const fx = Math.cos(this.flyYaw) * cosP;
    const fy = Math.sin(this.flyYaw) * cosP;
    const fz = -Math.sin(this.flyPitch);
    const rx = Math.sin(this.flyYaw);
    const ry = -Math.cos(this.flyYaw);
    const step = this.flySpeed * dt;
    this.flyX += (fx * input.moveY + rx * input.moveX) * step;
    this.flyY += (fy * input.moveY + ry * input.moveX) * step;
    this.flyZ += (fz * input.moveY + input.moveZ) * step;

    const pose = this.pose;
    pose.posX = this.flyX;
    pose.posY = this.flyY;
    pose.posZ = this.flyZ;
    pose.yaw = this.flyYaw;
    pose.pitch = this.flyPitch;
    pose.roll = 0;
    pose.fovDeg = cfg.fovDeg;
  }
}
