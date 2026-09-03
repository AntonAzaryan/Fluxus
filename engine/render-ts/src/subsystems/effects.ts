/**
 * Подсистема транзиентных эффектов (REND-23): короткоживущие изображения
 * поверх сцены, у которых нет модели в манифесте инстансов, — оболочка щита,
 * шарик снаряда, шар заряда каста, вспышка взрыва, превью зоны.
 *
 * Отдельная подсистема за общим контрактом (REND-8), а не ветка в подсистеме
 * моделей: у эффекта нет ни модели, ни ассетов, ни анимационного графа —
 * общего с инстансом у него только место в кадре. Кусок маленький и заменяемый:
 * появится настоящая система частиц — она встанет сюда же, не трогая моделей.
 *
 * Три источника, и все — уже ДОСТАВЛЕННОЕ presentation-состояние (REND-23):
 *
 * - **оболочка типа** (`effects.byKind`): живёт, пока в доставленном состоянии
 *   есть сущность такого визуального типа (шарик снаряда);
 * - **оболочка состояния** (`effects.byState`): живёт, пока доставленные
 *   состояния сущности несут названное состояние (сфера щита). Состояния
 *   приезжают битами `EntityView.states`, а какой бит какому имени соответствует
 *   — говорит список `stateComponents` сборки, тот же, что у длящихся эффектов
 *   камеры (CAM-6): второго словаря состояний не заводится;
 * - **вспышка** (`effects.byEvent`): reliable-событие тика запускает её на
 *   `durationMs`, и фаза жизни идёт по ЧАСАМ КАДРА главного потока (SHELL-7),
 *   а не по тикам: события не тикают, а доставка их только переносит. Разрыв
 *   непрерывности (REND-2) вспышки гасит — доигрывать через перемотку нечего.
 *   Доставка вправе привезти события НЕСКОЛЬКИХ тиков (SHELL-4), и вспышка
 *   стартует с возрастом, накопленным с тика своего события: иначе пачка
 *   взрывов, разнесённых в мире на сотни миллисекунд, началась бы и кончилась
 *   одним кадром (`eventAgeSeconds`).
 *
 * Собственного состояния у оболочек нет: исчезла сущность или её состояние —
 * исчезла оболочка, а восстановленное перемоткой состояние воспроизводит её
 * само (REND-2). Сведение оболочек с доставленным состоянием — общий набор
 * (`shellSupport.ts`, `ShellSet`), тот же, которым живёт подсистема частиц:
 * правило «какие оболочки существуют» одно на рендер.
 *
 * Параметры — примитив, цвет, альфа, радиусы, длительность, кривая, вынос
 * вперёд и ведение радиуса доставленным статом — данные манифеста (REND-23,
 * REND-4: реакция на событие — данные). Новый эффект есть запись в JSON, и код
 * этого модуля от неё не меняется; телеграф, который растёт вместе со статом и
 * меняет цвет на пороге, — тоже запись, а не модуль игровой сборки. Имена
 * примитивов и кривых называет ЭТОТ код (перечень принадлежит рендеру,
 * ASSET-8-образно): неизвестное имя — предупреждение один раз и пропуск, а не
 * отказ кадра.
 *
 * Геометрия примитива разделяется всеми эффектами (REND-3), пер-инстансны
 * только материал и трансформ; меши берутся из пула и в него возвращаются —
 * аллокаций на кадр, растущих с числом эффектов, нет. Освобождения пула нет
 * НАМЕРЕННО: он ограничен пиком одновременных эффектов сцены (единицы-десятки
 * мешей со своим материалом), а геометрия и материалы живут столько же, сколько
 * сама подсистема, — как разделяемые данные ассета у подсистемы моделей
 * (REND-3). Возвращённый в пул узел не держит ни записи манифеста, ни
 * presentation-среза: ссылки на них живут в оболочке и вспышке, а те исчезают
 * вместе с эффектом.
 *
 * Симуляции подсистема не читает (её вход — `TickView`, как у всех), в picking
 * не участвует (REND-15): источника прокси она не реализует, и попасть лучом в
 * эффект нельзя по построению — эффект есть изображение, а не сущность.
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import {
  resolveEffectByEvent,
  resolveEffectByKind,
  resolveEffectByState,
  type VisualEffect,
  type VisualManifest,
} from '@fluxus/assets';
import type {
  EntityView,
  QualityDeclaration,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import type { VisualSurface } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { jumpArc } from '../model/verticalOffset.js';
import { createWarnOnce, type WarnOnce } from '../warnOnce.js';
import {
  ShellSet,
  createStateReader,
  eventAgeSeconds,
  eventPointOf,
  poseShell,
  shellKey,
  stateTableNames,
  syncShellSources,
  type EventPoint,
  type Shell,
  type ShellPose,
  type StateReader,
} from './shellSupport.js';
import { effectPrimitives, warmEffectNodes, type EffectsPrewarm } from './effectsPrewarm.js';
import { own } from '../footprint.js';

/** Примитивы, которые умеет рисовать подсистема; перечень принадлежит рендеру. */
const PRIMITIVE_SPHERE = 'sphere';

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

/** Разбиение общей сферы: круглая на глаз и дешёвая — эффектов в кадре десятки. */
const SPHERE_SEGMENTS = 16;
const SPHERE_RINGS = 12;

/** Длительность вспышки, если запись её не назвала: короткая, но видимая. */
const DEFAULT_FLASH_MS = 300;

/**
 * Шаг тика по умолчанию, секунды — знаменатель возраста события (REND-23,
 * SHELL-4). Величина сборки, а не рендера: подсистеме её называет опция.
 */
const DEFAULT_TICK_SECONDS = 1 / 60;

export interface EffectsOptions {
  /**
   * Источник визуальной поверхности (REND-9): по нему эффект садится на рельеф,
   * как инстанс. Не задан — опорной высотой служит высота уровня (REND-7).
   */
  readonly surface?: VisualSurfaceSource;
  /**
   * Компоненты-состояния в порядке, которым Extractor сборки выставляет биты
   * `EntityView.states` (CAM-6, SHELL-2): по нему запись `effects.byState`
   * находит свой бит. Список не задан — оболочек состояния не бывает вовсе, и
   * таблица пропускается молча: пустой словарь состояний есть ЛЕГАЛЬНАЯ сборка
   * (вьюпорт редактора, ED-15), а не забытая прокидка (`stateTableNames`).
   */
  readonly stateComponents?: readonly string[];
  /**
   * Длительность тика сборки в секундах — знаменатель возраста, с которым
   * вспышка стартует, когда доставка привозит события нескольких тиков
   * (SHELL-4). Не задана — {@link DEFAULT_TICK_SECONDS}; занижение шага
   * продлевает вспышку, но не гасит её.
   */
  readonly tickSeconds?: number;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/**
 * Узел пула: меш с собственным материалом и НИЧЕГО больше. Ни записи манифеста,
 * ни presentation-среза он не держит — иначе возвращённый в пул узел удерживал
 * бы сущность, которой давно нет.
 */
interface EffectNode {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

/**
 * Оболочка эффекта: узел пула плюс запись, которой он нарисован. Своего сверх
 * общей оболочки (`shellSupport.ts`) у неё одно поле — взят ли второй цвет
 * порога: `Color.set` разбирает строку, и звать его каждый кадр на каждую
 * оболочку значило бы аллоцировать пропорционально числу эффектов (REND-26).
 */
interface EffectShell extends Shell<VisualEffect, EffectNode> {
  colorAtTaken: boolean;
}

/** Вспышка: эффект, проигрывающий свою длительность по часам кадра. */
interface Flash {
  readonly node: EffectNode;
  readonly record: VisualEffect;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Сколько миллисекунд кадров прожито; `durationMs` — конец жизни. */
  ageMs: number;
  readonly durationMs: number;
}

/** Фаза жизни по кривой записи: `linear` как есть, `easeOut` — с замедлением. */
function curveOf(curve: string | undefined, t: number): number {
  if (curve === undefined || curve === CURVE_LINEAR) return t;
  if (curve === CURVE_EASE_OUT) return 1 - (1 - t) * (1 - t);
  return t;
}

/** Значение параметра по фазе: `from` → `to`, если конец назван. */
function lerpParam(from: number, to: number | undefined, phase: number): number {
  return to === undefined ? from : from + (to - from) * phase;
}

/**
 * Фаза окна стата записи (REND-23): доля пройденного окна `radiusFromStat`,
 * зажатая в [0..1]. `NaN` — вести нечем: стата в доставленном состоянии нет.
 */
function statPhase(record: VisualEffect, view: EntityView): number {
  const range = record.radiusFromStat;
  if (range === undefined) return Number.NaN;
  const value = view.stats?.get(range.stat);
  if (value === undefined) return Number.NaN;
  const min = range.min ?? 0;
  const span = range.max - min;
  if (!(span > 0)) return Number.NaN;
  const t = (value - min) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class EffectsSubsystem implements RenderSubsystem {
  readonly name = 'effects';

  private manifest: VisualManifest;
  private readonly options: EffectsOptions;
  private readonly stateComponents: readonly string[];
  private readonly tickSeconds: number;
  /**
   * Несёт ли доставленное состояние сущности названное состояние (REND-23).
   * Читатель общий с подсистемой частиц (`shellSupport.ts`) — словарь битов
   * `EntityView.states` один на всех (CAM-6); своё здесь только предупреждение.
   */
  private readonly hasState: StateReader;
  /** Об неизвестном примитиве/кривой сказано один раз на имя, а не на кадр. */
  private readonly warnOnce: WarnOnce;
  /** Точка разбираемого события; переиспользуется — аллокаций на вспышку нет. */
  private readonly eventPoint: EventPoint = { x: 0, y: 0 };

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  private geometry: THREE.SphereGeometry | null = null;

  /** Оболочки по ключу «сущность + источник» — общий набор (`shellSupport.ts`). */
  private readonly shells: ShellSet<VisualEffect, EffectNode, EffectShell>;
  private flashes: Flash[] = [];
  /** Свободные меши пула: аллокация — только когда эффектов стало больше, чем было. */
  private readonly pool: EffectNode[] = [];

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;
  /** Кэш имён таблицы состояний манифеста; null — пересобрать (REND-17). */
  private stateNames: readonly string[] | null = null;
  /**
   * Часы презентации подсистемы, мс: по ним мигает передержанный телеграф
   * (REND-23). Модуль `dt`, а не знак: мигание — величина периодическая, у неё
   * нет направления, а в стоящем мире оно замирает вместе с часами (REND-25).
   */
  private clockMs = 0;

  /** Резолверы записей таблиц: строятся один раз, а не на каждую доставку. */
  private readonly byKind = (kind: string): VisualEffect | undefined =>
    resolveEffectByKind(this.manifest, kind);
  private readonly byState = (name: string): VisualEffect | undefined =>
    resolveEffectByState(this.manifest, name);

  constructor(manifest: VisualManifest, options: EffectsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.stateComponents = options.stateComponents ?? [];
    this.tickSeconds = options.tickSeconds ?? DEFAULT_TICK_SECONDS;
    this.warnOnce = createWarnOnce(options.warn);
    this.hasState = createStateReader(this.stateComponents, (name) => {
      this.warnOnce(
        `state-bit:${name}`,
        `render: состояние "${name}" не зеркалируется Extractor'ом (stateComponents) — эффект-оболочка не появится (REND-23)`,
      );
    });
    this.shells = new ShellSet<VisualEffect, EffectNode, EffectShell>({
      acquire: (key, source, view, record) => {
        const node = this.acquire(record);
        if (node === null) return null; // неизвестный примитив — пропуск с предупреждением
        return { key, source, decoration: false, instance: node, record, view, colorAtTaken: false };
      },
      release: (shell) => {
        this.release(shell.instance);
      },
      rebind: (shell, record) => {
        this.applyStatic(shell, record);
        return true;
      },
      pose: (shell, alpha, heightStep, surface, pose) => {
        this.poseEffectShell(shell, alpha, heightStep, surface, pose);
      },
    });
    this.group.name = 'effects';
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    this.geometry ??= own(
      'geometry',
      'effects',
      new THREE.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_RINGS),
    );
    ctx.scene.add(this.group);
  }

  /**
   * Снос подсистемы (REND-31): материалы всех заведённых мешей — они
   * пер-инстансны (цвет и альфа записи), — и одна разделяемая геометрия
   * примитива. Живые оболочки и вспышки сперва возвращаются в пул, чтобы
   * освобождение шло одним проходом по нему, а не тремя по разным спискам.
   */
  dispose(): void {
    this.shells.clear();
    for (const flash of this.flashes) this.release(flash.node);
    this.flashes = [];
    for (const node of this.pool) node.material.dispose();
    this.pool.length = 0;
    this.geometry?.dispose();
    this.geometry = null;
    this.group.removeFromParent();
  }

  /**
   * Сведение с доставленным тиком (REND-23): оболочки — с набором сущностей,
   * вспышки — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое: доигрывать вспышку через перемотку нечего (REND-2).
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) this.dropFlashes();
    this.syncShells(view);
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveEffectByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.spawnFlash(record, event.type, event.data, event.tick, view);
    }
  }

  /**
   * Стоимость подсистемы объявлена КОНСТАНТНОЙ (`render-quality` QUAL-3, второй
   * сценарий: «дешёвая фича объявляет константность»), и ручек у неё нет.
   *
   * Стоимость одного эффекта фиксирована и не зависит ни от содержимого записи,
   * ни от объёма контента: геометрия примитива одна на все эффекты (REND-3),
   * меши берутся из пула и в него возвращаются, пер-инстансен только материал.
   * Растёт же ЧИСЛО одновременных эффектов — но задают его доставленное
   * состояние и манифест (REND-23), и снижать его пресетом нельзя: шарик
   * снаряда и сфера щита — то, что игрок видит вместо сущности, а состав
   * доступной ему информации от качества картинки не зависит (QUAL-2).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [],
      constantCost:
        'разделяемая геометрия примитива и пул мешей: стоимость эффекта фиксирована, ' +
        'а число одновременных эффектов задают доставленное состояние и манифест (REND-23), ' +
        'и пресет его MUST NOT менять — это информация игрока (QUAL-2)',
    };
  }

  updateFrame(dt: number, alpha: number): void {
    // Мигание передержки идёт МОДУЛЕМ шага: направления у периодической
    // величины нет, а в стоящем мире часы стоят (REND-25).
    this.clockMs += Math.abs(dt) * 1000;
    this.poseShells(alpha);
    // Вспышка необратима: отматывать её назад нечем, а играть вперёд в
    // стоящем мире REND-25 запрещает — вне `Running` она замирает. Терять при
    // этом нечего: вход в перемотку гасит проигрываемое (`syncTick`), а новых
    // событий вне живых тиков не бывает (REND-4).
    this.advanceFlashes(dt > 0 ? dt : 0);
  }

  /**
   * Правленый манифест целиком (REND-17, ED-15): записи живых оболочек
   * переснимаются на месте, оболочка исчезнувшей записи убирается. Вспышки
   * переподача не трогает — они уже проигрываются по своей копии записи.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    this.stateNames = null;
    // Сведение оболочек с новым документом — обычным проходом по последнему
    // доставленному состоянию: правило «какие оболочки существуют» одно, и
    // второй его копии для переподачи не заводится (REND-17).
    if (this.view !== null) this.syncShells(this.view);
  }

  /**
   * Прогрев до первого кадра (REND-23): по одному узлу пула на КАЖДЫЙ примитив
   * манифеста — программа `MeshBasicMaterial{transparent}` компилируется тёплой
   * сценой, а не в кадре первой вспышки. Тёплые узлы возвращаются в пул
   * `finish()`; наблюдаемого состояния прогрев не меняет и счётчиков не двигает.
   */
  prewarm(): EffectsPrewarm {
    return warmEffectNodes(
      effectPrimitives(this.manifest),
      (record) => this.acquire(record),
      (node) => { this.release(node); },
    );
  }

  /** Сколько эффектов нарисовано сейчас — вход отладки и тестов. */
  get activeCount(): number {
    return this.shells.size + this.flashes.length;
  }

  /** Сколько мешей заведено всего (пул + живые): по нему видно, что пул работает. */
  get pooledCount(): number {
    return this.pool.length + this.activeCount;
  }

  /**
   * Оболочка сущности — вход отладки и тестов. `source` называет источник
   * (`kind:<тип>` или `state:<состояние>`); без него отдаётся первая оболочка
   * этой сущности в порядке создания. null — оболочки нет.
   */
  effectFor(
    entity: EntityId,
    source?: string,
  ): { readonly record: VisualEffect; readonly object: THREE.Object3D } | null {
    const shell =
      source === undefined ? this.shells.first(entity) : this.shells.get(shellKey(entity, source));
    return shell === undefined ? null : { record: shell.record, object: shell.instance.mesh };
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView): void {
    // Имена таблицы состояний снимаются один раз на МАНИФЕСТ, а не на доставку:
    // список меняется только переподачей (REND-17). Пустой словарь состояний
    // сборки короткого замыкания и есть — та же трактовка, что у частиц.
    const stateNames = (this.stateNames ??= stateTableNames(
      this.manifest.effects?.byState,
      this.stateComponents,
    ));
    syncShellSources(
      this.shells,
      view.entities.values(),
      stateNames,
      this.hasState,
      this.byKind,
      this.byState,
    );
  }

  /**
   * Поза оболочки в кадре: горизонталь и опорная высота — общим правилом
   * оболочек (`shellSupport.ts`, REND-2, REND-9), сверх неё вынос вперёд по
   * доставленному курсу прицела, подъём записи и полётная дуга по фазе плоской
   * формы (REND-12). Дугу считает та же функция, что у инстансов: второй
   * параболы в репозитории нет.
   */
  private poseEffectShell(
    shell: EffectShell,
    alpha: number,
    heightStep: number,
    surface: VisualSurface | null,
    pose: ShellPose,
  ): void {
    const view = shell.view;
    const record = shell.record;
    poseShell(view, alpha, heightStep, surface, pose);
    let x = pose.x;
    let y = pose.y;
    const offset = record.offset ?? 0;
    if (offset !== 0) {
      // Курс — ДОСТАВЛЕННЫЙ (REND-2): локальный сэмпл ввода текущего кадра —
      // вход единственной подсистемы превью каста (REND-1, REND-28).
      const yaw = view.aimYaw ?? view.facingYaw;
      x += Math.cos(yaw) * offset;
      y += Math.sin(yaw) * offset;
    }
    const arc = jumpArc(view.flightPhase, record.verticalOffset?.flightArc ?? 0);
    // Опорная высота берётся ПОД СУЩНОСТЬЮ, а не под вынесенной точкой: шар
    // висит перед кастером на высоте его пола, а не пола за краем плато.
    shell.instance.mesh.position.set(x, y, pose.base + (record.height ?? 0) + arc);
    this.applyShellLook(shell);
  }

  /**
   * Размер, цвет и альфа оболочки в кадре (REND-23). Масштаб размещения
   * (REND-11, REND-18) учитывается наравне с эмиттером частиц: у размера
   * изображения сущности один ответ, а не два разных у двух подсистем.
   *
   * Ведение статом (`radiusFromStat`) правит те же три числа фазой окна: радиус
   * — множителем, цвет — порогом `colorAt`, альфа — миганием за концом окна.
   * Стата в доставленном состоянии нет — оболочка рисуется числами записи без
   * ведения: выдумывать значение рендер не вправе.
   */
  private applyShellLook(shell: EffectShell): void {
    const record = shell.record;
    const node = shell.instance;
    const placement = shell.view.scale ?? 1;
    const alpha = record.alpha ?? 1;
    const phase = statPhase(record, shell.view);
    if (Number.isNaN(phase)) {
      node.mesh.scale.setScalar(record.radius * placement);
      node.material.opacity = alpha;
      this.applyColorAt(shell, false);
      return;
    }
    const range = record.radiusFromStat!;
    const from = range.from ?? 1;
    node.mesh.scale.setScalar(record.radius * (from + (range.to - from) * phase) * placement);
    const colorAt = record.colorAt;
    this.applyColorAt(shell, colorAt !== undefined && phase >= colorAt.phase);
    // Мигание — ЗА концом окна: заряд перезрел и рванёт в самом кастере.
    const blink = record.blink;
    const value = shell.view.stats?.get(range.stat) ?? 0;
    const overcharged = blink !== undefined && value >= range.max;
    const dark = overcharged && Math.floor(this.clockMs / (blink.periodMs / 2)) % 2 === 0;
    node.material.opacity = dark ? alpha * blink.alpha : alpha;
  }

  /**
   * Второй цвет порога — только на СМЕНЕ состояния: `Color.set` разбирает
   * строку, и вызов на каждую оболочку каждого кадра аллоцировал бы
   * пропорционально числу эффектов (REND-26).
   */
  private applyColorAt(shell: EffectShell, taken: boolean): void {
    if (taken === shell.colorAtTaken) return;
    shell.colorAtTaken = taken;
    const color = taken ? shell.record.colorAt?.color : undefined;
    shell.instance.material.color.set(color ?? shell.record.color);
  }

  private poseShells(alpha: number): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    this.shells.poseAll(alpha, heightStep, surface);
  }

  // -------------------------------------------------------------- вспышки

  /**
   * Вспышка по событию (REND-23). Точка — координатные поля события, уже
   * приведённые к float на входной границе рендера (REND-1, `eventData.ts`):
   * делить здесь нечего. Нет координат — берётся позиция сущности события, а
   * нет и её — играть вспышку негде, и об этом сказано один раз.
   *
   * Возраст СОБЫТИЯ (SHELL-4): доставка вправе привезти события нескольких
   * тиков, и вспышка стартует уже прожившей своё расстояние до тика доставки.
   * Отжившая к этому моменту не заводится вовсе — она уже кончилась в мире.
   */
  private spawnFlash(
    record: VisualEffect,
    type: string,
    data: Readonly<Record<string, number>>,
    tick: number | undefined,
    view: TickView,
  ): void {
    const durationMs = record.durationMs ?? DEFAULT_FLASH_MS;
    const ageMs = eventAgeSeconds(view, tick, this.tickSeconds) * 1000;
    if (durationMs > 0 && ageMs >= durationMs) return;
    const point = this.eventPoint;
    if (!eventPointOf(type, data, view, point, this.warnOnce, 'REND-23')) return;
    const x = point.x;
    const y = point.y;
    const node = this.acquire(record);
    if (node === null) return;
    const surface = this.options.surface?.current ?? null;
    const base = surface === null ? 0 : surface.heightAt(x, y);
    const flash: Flash = {
      node,
      record,
      x,
      y,
      z: base + (record.height ?? 0),
      ageMs,
      durationMs,
    };
    flash.node.mesh.position.set(x, y, flash.z);
    this.flashes.push(flash);
    this.applyPhase(flash, durationMs <= 0 ? 1 : ageMs / durationMs);
  }

  /**
   * Фаза жизни вспышек — по часам КАДРА (SHELL-7): доставки конвертов идут
   * своим темпом, а вспышка обязана дожить свою длительность и умереть один
   * раз. Отжившие возвращаются в пул тем же проходом.
   */
  private advanceFlashes(dt: number): void {
    if (this.flashes.length === 0) return;
    let alive = 0;
    for (const flash of this.flashes) {
      flash.ageMs += dt * 1000;
      const phase = flash.durationMs <= 0 ? 1 : flash.ageMs / flash.durationMs;
      if (phase >= 1) {
        this.release(flash.node);
        continue;
      }
      this.applyPhase(flash, phase);
      this.flashes[alive++] = flash;
    }
    this.flashes.length = alive;
  }

  private dropFlashes(): void {
    for (const flash of this.flashes) this.release(flash.node);
    this.flashes.length = 0;
  }

  // ------------------------------------------------------------- примитивы

  /**
   * Меш из пула под запись: геометрия общая, материал — свой у каждого меша
   * (цвет и альфа пер-инстансны, REND-3). null — примитив записи рендеру
   * неизвестен: предупреждение один раз и пропуск, документ старше кода.
   */
  private acquire(record: VisualEffect): EffectNode | null {
    if (record.primitive !== PRIMITIVE_SPHERE) {
      this.warnOnce(
        `primitive:${record.primitive}`,
        `render: примитив эффекта "${record.primitive}" рендеру неизвестен — запись пропущена (REND-23)`,
      );
      return null;
    }
    const node = this.pool.pop() ?? this.createNode();
    node.mesh.visible = true;
    this.group.add(node.mesh);
    this.applyRecordLook(node, record);
    return node;
  }

  private createNode(): EffectNode {
    const geometry = this.geometry;
    if (geometry === null) throw new Error('EffectsSubsystem: init() не вызван (REND-8)');
    const material = own(
      'material',
      'effects',
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'effect';
    // Эффект — изображение, а не сущность: в picking он не участвует (REND-15),
    // и луч сцены его не видит даже там, где ищут не по прокси.
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
    mesh.raycast = () => {};
    return { mesh, material };
  }

  private release(node: EffectNode): void {
    node.mesh.removeFromParent();
    node.mesh.visible = false;
    this.pool.push(node);
  }

  /** Правленая запись на живой оболочке: цвет порога снимается, числа — заново. */
  private applyStatic(shell: EffectShell, record: VisualEffect): void {
    shell.colorAtTaken = false;
    this.applyRecordLook(shell.instance, record);
  }

  /** Значения записи, не зависящие от фазы: цвет и стартовые радиус с альфой. */
  private applyRecordLook(node: EffectNode, record: VisualEffect): void {
    node.material.color.set(record.color);
    node.mesh.scale.setScalar(record.radius);
    node.material.opacity = record.alpha ?? 1;
    if (record.curve !== undefined && record.curve !== CURVE_LINEAR && record.curve !== CURVE_EASE_OUT) {
      this.warnOnce(
        `curve:${record.curve}`,
        `render: кривая эффекта "${record.curve}" рендеру неизвестна — берётся линейная (REND-23)`,
      );
    }
  }

  /** Радиус и альфа по фазе жизни: `radius → radiusTo`, `alpha → alphaTo`. */
  private applyPhase(flash: Flash, phase: number): void {
    const record = flash.record;
    const curved = curveOf(record.curve, phase);
    flash.node.mesh.scale.setScalar(lerpParam(record.radius, record.radiusTo, curved));
    flash.node.material.opacity = lerpParam(record.alpha ?? 1, record.alphaTo, curved);
  }
}
