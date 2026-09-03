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
  isEffectList,
  resolveEffectsByEvent,
  resolveEffectsByKind,
  resolveEffectsByState,
  type VisualEffect,
  type VisualEffectEntry,
  type VisualManifest,
} from '@fluxus/assets';
import type {
  EntityView,
  QualityDeclaration,
  QualityValues,
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
  type ShellPose,
  type StateReader,
} from './shellSupport.js';
import { effectPrimitives, warmEffectNodes, type EffectsPrewarm } from './effectsPrewarm.js';
import { EffectNodePool, type EffectNode, type ShapeContext } from './effectNodes.js';
import { CameraCull } from './cameraCull.js';
import { MAX_GROUND_STEPS } from './effectShapes.js';
import {
  PRIMITIVE_BEAM,
  applyShapeEdge,
  drawBeam,
  drawGround,
  drawTrail,
  groundExtentOf,
  isGroundPrimitive,
  radiusOf,
} from './effectDraw.js';
import { FlashSet } from './effectFlashes.js';
import { applyShellLook, type EffectShell } from './effectLook.js';

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

/**
 * Шаг тика по умолчанию, секунды — знаменатель возраста события (REND-23,
 * SHELL-4). Величина сборки, а не рендера: подсистеме её называет опция.
 */
const DEFAULT_TICK_SECONDS = 1 / 60;

/**
 * Ручка потолка дробления наземных фигур (QUAL-1, семантика потолка): пресет
 * вправе сделать фигуру грубее, а её ФОРМА от этого не меняется — меняется
 * лишь то, насколько плотно она облегает рельеф. Информации у игрока потолок не
 * отнимает (QUAL-2): зона накрывает те же клетки.
 */
const EFFECTS_SHAPE_DETAIL = 'effects.shapeDetail';

/**
 * Запас вокруг якоря наземной фигуры при отсечении, мировые единицы: мягкая
 * кромка и подъём над полем выводят её чуть за расчётный поперечник.
 */
const SHAPE_CULL_MARGIN = 0.5;

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
  /**
   * Камера сборки — вход отсечения наземных фигур по пирамиде кадра (REND-43,
   * QUAL-3). Приходит опцией, а не контекстом (REND-8), тем же путём, каким её
   * получает подсистема моделей. Не задана — отсечения нет вовсе, и подсистема
   * делает ту же работу, что делала до него: это стоимость, а не поведение.
   */
  readonly camera?: THREE.Camera;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
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
  /** Фигуры, пропущенные отсечением камеры в этом кадре (REND-43). */
  private shapesCulled = 0;
  /** Отсечение кадра по камере (`cameraCull.ts`); без камеры — неактивно. */
  private readonly cull = new CameraCull();
  /** Потолок дробления от пресета (QUAL-1); бесконечность — потолка нет. */
  private shapeDetail = Number.POSITIVE_INFINITY;

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
  private readonly byKind = (kind: string): VisualEffectEntry | undefined =>
    resolveEffectsByKind(this.manifest, kind);
  private readonly byState = (name: string): VisualEffectEntry | undefined =>
    resolveEffectsByState(this.manifest, name);

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
      shapeVisible: (record, x, y, z, scale) => this.shapeVisible(record, x, y, z, scale),
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
      const entry = resolveEffectsByEvent(this.manifest, event.type);
      if (entry === undefined) continue;
      // Изображений у события бывает несколько (REND-23): вспышка и кольцо
      // ударной волны — две записи одного взрыва, и играют они обе.
      if (isEffectList(entry)) {
        for (const record of entry) this.flashes.spawn(record, event.type, event.data, event.tick, view);
      } else {
        this.flashes.spawn(entry, event.type, event.data, event.tick, view);
      }
    }
  }

  /**
   * Ручка подсистемы одна — ПОТОЛОК дробления наземных фигур (QUAL-1, QUAL-3).
   *
   * Стоимость эффекта-СФЕРЫ константна и была таковой всегда: геометрия одна на
   * все эффекты (REND-3), меши берутся из пула и в него возвращаются,
   * пер-инстансен только материал. Наземная фигура (REND-43) эту константность
   * сняла: она облегает рельеф, её вершины переписываются каждый кадр, а число
   * их растёт с поперечником зоны и дробностью поля под ней — покадровая
   * работа, растущая с содержимым, а такая по QUAL-3 обязана иметь рычаг.
   *
   * Рычаг — потолок, а не значение: пресет вправе сделать зону ГРУБЕЕ, но не
   * мельче и не иначе. Форма фигуры от потолка не меняется — телеграф накрывает
   * те же клетки поля, — и потому информации у игрока он не отнимает (QUAL-2).
   *
   * Ручки ЧИСЛА эффектов нет и быть не может: сколько их одновременно, задают
   * доставленное состояние и манифест (REND-23), а шарик снаряда и сфера щита —
   * то, что игрок видит вместо сущности. Нет ручки и у отсечения по пирамиде
   * кадра: фигура за кромкой не видна ни при каком пресете, и её пропуск есть
   * отсутствие работы, а не качество картинки.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: EFFECTS_SHAPE_DETAIL,
          cost:
            'вершины наземных фигур: дробление, которым фигура облегает рельеф, ' +
            'переписывается каждый кадр и растёт с поперечником зоны (REND-43)',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: 1,
          max: MAX_GROUND_STEPS,
        },
      ],
    };
  }

  /**
   * Значения пресета (QUAL-1). Топология узла фиксируется его ВЗЯТИЕМ (REND-26,
   * design D2), поэтому смена потолка снимает живые оболочки и заводит их
   * заново обычным сведением — тем же проходом, каким живёт переподача
   * манифеста (REND-17). Проигрываемые вспышки доигрывают своей топологией: они
   * короче доли секунды, и обрывать их сменой пресета значило бы терять момент
   * мира ради кадра, которого игрок не заметит.
   */
  applyQuality(values: QualityValues): void {
    const detail = values.get(EFFECTS_SHAPE_DETAIL);
    if (typeof detail !== 'number' || detail === this.shapeDetail) return;
    this.shapeDetail = detail;
    this.shells.clear();
    if (this.view !== null) this.syncShells(this.view);
  }

  updateFrame(dt: number, alpha: number): void {
    // Сток кадра — один раз на вход (PERF-3).
    const cost = costSink();
    // Мигание передержки идёт МОДУЛЕМ шага: направления у периодической
    // величины нет, а в стоящем мире часы стоят (REND-25).
    this.clockMs += Math.abs(dt) * 1000;
    this.shapeVertices = 0;
    this.shapesCulled = 0;
    // Пирамида кадра снимается ОДИН раз на кадр (REND-43): спрашивают её
    // каждая наземная фигура и каждая вспышка, а считают — здесь.
    this.cull.update(this.options.camera);
    this.poseShells(alpha);
    // Вспышка необратима: отматывать её назад нечем, а играть вперёд в
    // стоящем мире REND-25 запрещает — вне `Running` она замирает. Терять при
    // этом нечего: вход в перемотку гасит проигрываемое (`syncTick`), а новых
    // событий вне живых тиков не бывает (REND-4).
    this.flashes.advance(dt > 0 ? dt : 0);
    // Вершины непроцедурных фигур, переписанные этим кадром (REND-43, PERF-3):
    // покадровая работа подсистемы, растущая с числом наземных телеграфов.
    if (cost !== undefined) {
      cost.effectsShapeVertices += this.shapeVertices;
      // Фигуры, за которые кадр не заплатил вовсе (REND-43): экономия отсечения
      // видна числом, а не на глаз.
      cost.effectsShapesCulled += this.shapesCulled;
    }
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
    const scale = applyShellLook(shell, this.clockMs);
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
    if (isGroundPrimitive(record.primitive)) {
      if (!this.shapeVisible(record, x, y, base, scale)) {
        node.mesh.visible = false;
        return;
      }
      node.mesh.visible = true;
      this.shapeVertices += shape.vertices;
      const yaw = shell.view.aimYaw ?? shell.view.facingYaw;
      drawGround(shape, record, surface, x, y, yaw, scale, base);
      return;
    }
    node.mesh.visible = true;
    this.shapeVertices += shape.vertices;
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
   * Видна ли наземная фигура записи в этом кадре (REND-43). Радиус якоря —
   * наибольший поперечник записи под масштабом кадра плюс запас: мягкая кромка
   * и подъём над полем выводят фигуру чуть за расчётный круг, а ошибиться здесь
   * дороже, чем переписать лишние вершины. Отсечённая фигура вершин не
   * переписывает и в счёт кадра не идёт — в этом и состоит экономия.
   */
  private shapeVisible(
    record: VisualEffect,
    x: number,
    y: number,
    z: number,
    scale: number,
  ): boolean {
    if (!this.cull.active) return true;
    const radius = groundExtentOf(record) * scale + SHAPE_CULL_MARGIN;
    if (this.cull.visible(x, y, z, radius, 0)) return true;
    this.shapesCulled++;
    return false;
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
      detail: this.shapeDetail,
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
