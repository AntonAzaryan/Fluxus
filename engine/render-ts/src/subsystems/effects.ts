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
import { NO_ENTITY, FIXED_ONE, type EntityId } from '@fluxus/core';
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
import { costSink } from '../cost.js';
import { jumpArc } from '../model/verticalOffset.js';
import { createWarnOnce, type WarnOnce } from '../warnOnce.js';
import {
  ShellSet,
  createShellPose,
  createStateReader,
  poseShell,
  shellKey,
  stateTableNames,
  syncShellSources,
  type Shell,
  type ShellPose,
  type StateReader,
} from './shellSupport.js';
import { effectPrimitives, warmEffectNodes, type EffectsPrewarm } from './effectsPrewarm.js';
import { EffectNodePool, type EffectNode, type ShapeContext } from './effectNodes.js';
import {
  PRIMITIVE_BEAM,
  applyShapeEdge,
  drawBeam,
  drawGround,
  drawTrail,
  isGroundPrimitive,
  radiusOf,
} from './effectDraw.js';
import { FlashSet } from './effectFlashes.js';

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

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
 * Оболочка эффекта: узел пула плюс запись, которой он нарисован. Своего сверх
 * общей оболочки (`shellSupport.ts`) у неё одно поле — взят ли второй цвет
 * порога: `Color.set` разбирает строку, и звать его каждый кадр на каждую
 * оболочку значило бы аллоцировать пропорционально числу эффектов (REND-26).
 */
interface EffectShell extends Shell<VisualEffect, EffectNode> {
  colorAtTaken: boolean;
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
  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  /** Узлы и их пул (`effectNodes.ts`): раздельный по примитиву и топологии. */
  private readonly pool: EffectNodePool;

  /** Оболочки по ключу «сущность + источник» — общий набор (`shellSupport.ts`). */
  private readonly shells: ShellSet<VisualEffect, EffectNode, EffectShell>;
  /** Проигрываемые вспышки (`effectFlashes.ts`): свой набор, своя длительность. */
  private readonly flashes: FlashSet;
  /** Поза цели луча и три числа выборки следа: аллокаций на кадр нет. */
  private readonly targetPose = createShellPose();
  private readonly trailScratch = new Float32Array(3);
  /** Вершины непроцедурных фигур, переписанные в этом кадре (PERF-3). */
  private shapeVertices = 0;

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
    this.pool = new EffectNodePool(this.group, this.warnOnce);
    this.flashes = new FlashSet({
      acquire: (flashRecord) => this.acquire(flashRecord),
      release: (node) => { this.release(node); },
      surface: () => this.options.surface?.current ?? null,
      countVertices: (vertices) => { this.shapeVertices += vertices; },
      warnOnce: this.warnOnce,
      tickSeconds: this.tickSeconds,
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
    this.pool.init();
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
    this.flashes.dropAll();
    this.pool.dispose();
    this.group.removeFromParent();
  }

  /**
   * Сведение с доставленным тиком (REND-23): оболочки — с набором сущностей,
   * вспышки — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое: доигрывать вспышку через перемотку нечего (REND-2).
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) this.flashes.dropAll();
    this.syncShells(view);
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveEffectByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.flashes.spawn(record, event.type, event.data, event.tick, view);
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
    // Сток кадра — один раз на вход (PERF-3).
    const cost = costSink();
    // Мигание передержки идёт МОДУЛЕМ шага: направления у периодической
    // величины нет, а в стоящем мире часы стоят (REND-25).
    this.clockMs += Math.abs(dt) * 1000;
    this.shapeVertices = 0;
    this.poseShells(alpha);
    // Вспышка необратима: отматывать её назад нечем, а играть вперёд в
    // стоящем мире REND-25 запрещает — вне `Running` она замирает. Терять при
    // этом нечего: вход в перемотку гасит проигрываемое (`syncTick`), а новых
    // событий вне живых тиков не бывает (REND-4).
    this.flashes.advance(dt > 0 ? dt : 0);
    // Вершины непроцедурных фигур, переписанные этим кадром (REND-43, PERF-3):
    // покадровая работа подсистемы, растущая с числом наземных телеграфов.
    if (cost !== undefined) cost.effectsShapeVertices += this.shapeVertices;
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
    return this.shells.size + this.flashes.size;
  }

  /** Сколько мешей заведено всего (пул + живые): по нему видно, что пул работает. */
  get pooledCount(): number {
    return this.pool.size;
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
    const scale = this.applyShellLook(shell);
    const node = shell.instance;
    if (node.shape !== null) {
      // Фигура несёт МИРОВЫЕ вершины: меш стоит в начале координат группы, а
      // место и размер живут в самих вершинах (REND-43).
      this.drawShellShape(shell, x, y, pose.base, alpha, heightStep, surface, scale);
      return;
    }
    const arc = jumpArc(view.flightPhase, record.verticalOffset?.flightArc ?? 0);
    // Опорная высота берётся ПОД СУЩНОСТЬЮ, а не под вынесенной точкой: шар
    // висит перед кастером на высоте его пола, а не пола за краем плато.
    node.mesh.position.set(x, y, pose.base + (record.height ?? 0) + arc);
  }

  /**
   * Фигура оболочки в кадре: наземная садится на поле (REND-43), луч тянется к
   * цели доставленного стата, лента — по истории поз (REND-23, design D5, D6).
   */
  private drawShellShape(
    shell: EffectShell,
    x: number,
    y: number,
    base: number,
    alpha: number,
    heightStep: number,
    surface: VisualSurface | null,
    scale: number,
  ): void {
    const record = shell.record;
    const node = shell.instance;
    const shape = node.shape!;
    node.mesh.visible = true;
    this.shapeVertices += shape.vertices;
    if (isGroundPrimitive(record.primitive)) {
      const yaw = shell.view.aimYaw ?? shell.view.facingYaw;
      drawGround(shape, record, surface, x, y, yaw, scale, base);
      return;
    }
    const lift = record.height ?? 0;
    if (record.primitive === PRIMITIVE_BEAM) {
      const target = this.beamTarget(record, shell.view);
      if (target === undefined) {
        // Цели в доставленном состоянии нет — луч в этом кадре не рисуется, и
        // невидимую сущность он не открывает (NET-12). Это не ошибка.
        node.mesh.visible = false;
        return;
      }
      poseShell(target, alpha, heightStep, surface, this.targetPose);
      const end = this.targetPose;
      drawBeam(shape, record, x, y, base + lift, end.x, end.y, end.base + lift);
      return;
    }
    // Лента: разрыв непрерывности сбрасывает историю (REND-2, design D6).
    const trail = node.trail!;
    if (shell.view.snap) trail.reset();
    trail.push(x, y, base + lift);
    drawTrail(shape, record, trail, this.trailScratch);
  }

  /**
   * Сущность цели луча-оболочки: доставленный стат записи называет её номером
   * (HUD-8). Не названа, не доехала или не разрешается — цели нет.
   */
  private beamTarget(record: VisualEffect, source: EntityView): EntityView | undefined {
    const name = record.targetFromStat;
    const delivered = this.view;
    if (name === undefined || delivered === null) return undefined;
    const target = source.stats?.get(name);
    if (target === undefined || !Number.isInteger(target) || target === NO_ENTITY) return undefined;
    return delivered.entities.get(target);
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
  private applyShellLook(shell: EffectShell): number {
    const record = shell.record;
    const node = shell.instance;
    const placement = shell.view.scale ?? 1;
    const alpha = record.alpha ?? 1;
    const phase = statPhase(record, shell.view);
    if (Number.isNaN(phase)) {
      if (node.shape === null) node.mesh.scale.setScalar(radiusOf(record) * placement);
      node.material.opacity = this.pulsed(record, alpha);
      this.applyColorAt(shell, false);
      return placement;
    }
    const range = record.radiusFromStat!;
    const from = range.from ?? 1;
    const scale = (from + (range.to - from) * phase) * placement;
    // Сфере множитель идёт в масштаб меша, фигуре — в её мировые вершины.
    if (node.shape === null) node.mesh.scale.setScalar(radiusOf(record) * scale);
    const colorAt = record.colorAt;
    this.applyColorAt(shell, colorAt !== undefined && phase >= colorAt.phase);
    // Мигание — ЗА концом окна: заряд перезрел и рванёт в самом кастере.
    const blink = record.blink;
    const value = shell.view.stats?.get(range.stat) ?? 0;
    const overcharged = blink !== undefined && value >= range.max;
    const dark = overcharged && this.blinkDark(blink.periodMs);
    node.material.opacity = dark ? alpha * blink.alpha : alpha;
    return scale;
  }

  /**
   * Тёмная половина цикла мигания по часам презентации подсистемы (REND-25).
   * Общая точка: с окном стата это предупреждение о передержке, без окна —
   * пульс луча и ленты, и цикл у них один и тот же.
   */
  private blinkDark(periodMs: number): boolean {
    return periodMs > 0 && Math.floor(this.clockMs / (periodMs / 2)) % 2 === 0;
  }

  /**
   * Альфа записи под пульсом: запись БЕЗ окна стата, назвавшая мигание,
   * пульсирует всегда — так живёт луч и лента (REND-23).
   */
  private pulsed(record: VisualEffect, alpha: number): number {
    const blink = record.blink;
    // С окном стата мигание принадлежит ЕГО концу (передержка), и запись без
    // доехавшего стата рисуется числами записи без ведения — в том числе без
    // мигания: выдумывать передержку там, где величины нет, рендер не вправе.
    if (blink === undefined || record.radiusFromStat !== undefined) return alpha;
    return this.blinkDark(blink.periodMs) ? alpha * blink.alpha : alpha;
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

  // ------------------------------------------------------------- примитивы

  /**
   * Узел из пула под запись (`effectNodes.ts`). Мягкость кромки пишется здесь:
   * она от позы не зависит, а зависит от записи — и переписывается вместе с ней.
   */
  private acquire(record: VisualEffect): EffectNode | null {
    const node = this.pool.acquire(record, this.shapeContext());
    if (node === null) return null;
    this.applyRecordLook(node, record);
    return node;
  }

  private release(node: EffectNode): void {
    this.pool.release(node);
  }

  /** Что подсистема знает о поле в момент взятия узла — вход дробления фигуры. */
  private shapeContext(): ShapeContext {
    const surface = this.options.surface?.current ?? null;
    const grid = this.options.surface?.terrain;
    return {
      surface,
      // Приём `tileSize` — точка входной границы рендера (REND-1, TERR-2).
      tile: grid === undefined ? 0 : grid.tileSize / FIXED_ONE,
      tessellation: this.ctx?.config.curvatureTessellation ?? 1,
    };
  }

  /** Правленая запись на живой оболочке: цвет порога снимается, числа — заново. */
  private applyStatic(shell: EffectShell, record: VisualEffect): void {
    shell.colorAtTaken = false;
    this.applyRecordLook(shell.instance, record);
  }

  /** Значения записи, не зависящие от фазы: цвет и стартовые радиус с альфой. */
  private applyRecordLook(node: EffectNode, record: VisualEffect): void {
    node.material.color.set(record.color);
    node.material.opacity = record.alpha ?? 1;
    if (node.shape === null) node.mesh.scale.setScalar(radiusOf(record));
    // Фигура несёт мировые вершины: масштаб меша остаётся единичным, а размер
    // живёт в самих вершинах (REND-43). Мягкость кромки — тоже величина записи.
    else applyShapeEdge(node.shape, record);
    if (record.curve !== undefined && record.curve !== CURVE_LINEAR && record.curve !== CURVE_EASE_OUT) {
      this.warnOnce(
        `curve:${record.curve}`,
        `render: кривая эффекта "${record.curve}" рендеру неизвестна — берётся линейная (REND-23)`,
      );
    }
  }

}
