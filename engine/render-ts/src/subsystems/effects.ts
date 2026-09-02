/**
 * Подсистема транзиентных эффектов (REND-23): короткоживущие изображения
 * поверх сцены, у которых нет модели в манифесте инстансов, — оболочка щита,
 * шарик снаряда, вспышка взрыва, превью зоны.
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
 *
 * Собственного состояния у оболочек нет: исчезла сущность или её состояние —
 * исчезла оболочка, а восстановленное перемоткой состояние воспроизводит её
 * само (REND-2).
 *
 * Параметры — примитив, цвет, альфа, радиусы, длительность, кривая — данные
 * манифеста (REND-23, REND-4: реакция на событие — данные). Новый эффект есть
 * запись в JSON, и код этого модуля от неё не меняется. Имена примитивов и
 * кривых называет ЭТОТ код (перечень принадлежит рендеру, ASSET-8-образно):
 * неизвестное имя — предупреждение один раз и пропуск, а не отказ кадра.
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
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { jumpArc } from '../model/verticalOffset.js';
import { createWarnOnce, type WarnOnce } from '../warnOnce.js';
import {
  createShellPose,
  createStateReader,
  eventPointOf,
  poseShell,
  type EventPoint,
  type StateReader,
} from './shellSupport.js';
import { own } from '../footprint.js';

/** Примитивы, которые умеет рисовать подсистема; перечень принадлежит рендеру. */
const PRIMITIVE_SPHERE = 'sphere';

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

/** Разбиение общей сферы: круглая на глаз и дешёвая — эффектов в кадре десятки. */
const SPHERE_SEGMENTS = 16;
const SPHERE_RINGS = 12;

/** Пустой список имён состояний — чтобы тик без таблицы `byState` не аллоцировал. */
const NO_STATE_NAMES: readonly string[] = [];

/** Длительность вспышки, если запись её не назвала: короткая, но видимая. */
const DEFAULT_FLASH_MS = 300;

export interface EffectsOptions {
  /**
   * Источник визуальной поверхности (REND-9): по нему эффект садится на рельеф,
   * как инстанс. Не задан — опорной высотой служит высота уровня (REND-7).
   */
  readonly surface?: VisualSurfaceSource;
  /**
   * Компоненты-состояния в порядке, которым Extractor сборки выставляет биты
   * `EntityView.states` (CAM-6, SHELL-2): по нему запись `effects.byState`
   * находит свой бит. Список не задан — оболочек состояния не бывает, и запись
   * таблицы получает предупреждение один раз, а не молчание.
   */
  readonly stateComponents?: readonly string[];
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
 * Оболочка: эффект, привязанный к сущности доставленного состояния. Ключ —
 * пара «сущность + источник» (`kind:<тип>` либо `state:<состояние>`): на одной
 * сущности законны обе — шарик снаряда и сфера щита поверх героя.
 */
interface Shell {
  readonly node: EffectNode;
  record: VisualEffect;
  view: EntityView;
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

/** Ключ оболочки: сущность плюс имя источника (тип или состояние). */
function shellKey(entity: EntityId, source: string): string {
  return `${String(entity)}|${source}`;
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

export class EffectsSubsystem implements RenderSubsystem {
  readonly name = 'effects';

  private manifest: VisualManifest;
  private readonly options: EffectsOptions;
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

  /** Оболочки по ключу «сущность + источник» (см. `shellKey`). */
  private readonly shells = new Map<string, Shell>();
  /** Переиспользуемый набор ключей живых оболочек: сведение без аллокаций на кадр. */
  private readonly liveShells = new Set<string>();
  private flashes: Flash[] = [];
  /** Свободные меши пула: аллокация — только когда эффектов стало больше, чем было. */
  private readonly pool: EffectNode[] = [];
  /** Переиспользуемая поза оболочки: аллокаций на оболочку на кадр нет. */
  private readonly pose = createShellPose();

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;
  /** Кэш имён таблицы состояний манифеста; null — пересобрать (REND-17). */
  private stateNames: readonly string[] | null = null;

  constructor(manifest: VisualManifest, options: EffectsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.warnOnce = createWarnOnce(options.warn);
    this.hasState = createStateReader(options.stateComponents ?? [], (name) => {
      this.warnOnce(
        `state-bit:${name}`,
        `render: состояние "${name}" не зеркалируется Extractor'ом (stateComponents) — эффект-оболочка не появится (REND-23)`,
      );
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
    for (const shell of this.shells.values()) this.release(shell.node);
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
      this.spawnFlash(record, event.data, view);
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
    if (source !== undefined) {
      const exact = this.shells.get(shellKey(entity, source));
      return exact === undefined ? null : { record: exact.record, object: exact.node.mesh };
    }
    for (const [key, shell] of this.shells) {
      if (key.startsWith(`${String(entity)}|`)) {
        return { record: shell.record, object: shell.node.mesh };
      }
    }
    return null;
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView): void {
    const live = this.liveShells;
    live.clear();
    const states = this.manifest.effects?.byState;
    // Имена таблицы состояний снимаются один раз на МАНИФЕСТ, а не на доставку:
    // список меняется только переподачей (REND-17), и массив имён на каждую
    // доставку был бы мусором на ровном месте.
    const stateNames = (this.stateNames ??=
      states === undefined ? NO_STATE_NAMES : Object.keys(states));
    for (const entityView of view.entities.values()) {
      this.syncEntityShells(entityView, stateNames, live);
    }
    for (const [key, shell] of this.shells) {
      if (live.has(key)) continue;
      this.release(shell.node);
      this.shells.delete(key);
    }
  }

  /** Оболочки одной сущности: по её визуальному типу и по каждому состоянию. */
  private syncEntityShells(
    entityView: EntityView,
    stateNames: readonly string[],
    live: Set<string>,
  ): void {
    // Оболочка визуального типа: живёт, пока жива сущность такого типа.
    if (entityView.kind !== null) {
      const record = resolveEffectByKind(this.manifest, entityView.kind);
      if (record !== undefined) {
        this.ensureShell(entityView, `kind:${entityView.kind}`, record, live);
      }
    }
    // Оболочка состояния: живёт, пока состояние доставляется (REND-23).
    for (const name of stateNames) {
      if (!this.hasState(entityView, name)) continue;
      const record = resolveEffectByState(this.manifest, name);
      if (record !== undefined) this.ensureShell(entityView, `state:${name}`, record, live);
    }
  }

  /** Создаёт оболочку источника либо обновляет существующую; помечает её живой. */
  private ensureShell(
    view: EntityView,
    source: string,
    record: VisualEffect,
    live: Set<string>,
  ): void {
    const key = shellKey(view.id, source);
    let shell = this.shells.get(key);
    if (shell === undefined) {
      const node = this.acquire(record);
      if (node === null) return; // неизвестный примитив — пропуск с предупреждением
      shell = { node, record, view };
      this.shells.set(key, shell);
    }
    shell.view = view;
    if (shell.record !== record) {
      shell.record = record;
      this.applyStatic(shell.node, record);
    }
    live.add(key);
  }

  /**
   * Поза оболочки в кадре: горизонталь и опорная высота — общим правилом
   * оболочек (`shellSupport.ts`, REND-2, REND-9), сверх неё подъём записи и
   * полётная дуга по фазе плоской формы (REND-12). Дугу считает та же функция,
   * что у инстансов: второй параболы в репозитории нет.
   */
  private poseShells(alpha: number): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    const pose = this.pose;
    for (const shell of this.shells.values()) {
      poseShell(shell.view, alpha, heightStep, surface, pose);
      const arc = jumpArc(shell.view.flightPhase, shell.record.verticalOffset?.flightArc ?? 0);
      shell.node.mesh.position.set(pose.x, pose.y, pose.base + (shell.record.height ?? 0) + arc);
    }
  }

  // -------------------------------------------------------------- вспышки

  /**
   * Вспышка по событию (REND-23). Точка — координатные поля события, уже
   * приведённые к float на входной границе рендера (REND-1, `eventData.ts`):
   * делить здесь нечего. Нет координат — берётся позиция сущности события, а
   * нет и её — играть вспышку негде.
   */
  private spawnFlash(
    record: VisualEffect,
    data: Readonly<Record<string, number>>,
    view: TickView,
  ): void {
    const point = this.eventPoint;
    if (!eventPointOf(data, view, point)) return;
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
      ageMs: 0,
      durationMs: record.durationMs ?? DEFAULT_FLASH_MS,
    };
    flash.node.mesh.position.set(x, y, flash.z);
    this.flashes.push(flash);
    this.applyPhase(flash, 0);
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
    this.applyStatic(node, record);
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

  /** Значения записи, не зависящие от фазы: цвет и стартовые радиус с альфой. */
  private applyStatic(node: EffectNode, record: VisualEffect): void {
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
