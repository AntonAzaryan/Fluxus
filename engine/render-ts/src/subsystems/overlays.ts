/* eslint-disable max-lines -- baseline */
/**
 * Подсистема служебных наложений вьюпорта (REND-16): подсветка выделения,
 * ручки gizmo, набор клеток по поверхности и сетка по поверхности.
 *
 * Это подсистема за общим контрактом REND-8, а не рисующий слой редактора.
 * Слой пришлось бы кормить визуальной поверхностью (REND-9) и видимой позой
 * инстанса (REND-10, REND-13) — то есть он был бы той же подсистемой, только
 * зарегистрированной не там, — и делал бы редактор вторым рендером (ED-1).
 *
 * Набор декларативный по образцу `DocumentSource.apply` (REND-11): потребитель
 * отдаёт полный набор с устойчивыми ключами, сведение делает подсистема.
 * Императивных «нарисуй обводку» и «сотри gizmo» нет: картинка вьюпорта обязана
 * быть функцией состояния инструмента, а не истории вызовов, иначе отмена
 * операции авторинга (ED-18) требовала бы обратного проигрывания рисования.
 *
 * Словарь видов закрыт и назван рендером. Что каждое наложение ЗНАЧИТ — какой
 * объект выделен, какой инструмент активен, что случится при захвате ручки —
 * политика редактора (ED-25, ED-29), и доменных имён редактора здесь нет.
 *
 * Наложения не красят кадр (ED-22): подсистема владеет своими сценовыми
 * объектами и своими материалами, а материалов, освещения и геометрии
 * подсистем террейна и моделей не касается. Подсветка сделана отдельным
 * объектом, а не подменой материала инстанса, ещё и потому, что материалы несут
 * скин записи манифеста (REND-6), а выделение живёт вне жизненного цикла
 * инстанса. При пустом наборе сценовых объектов у подсистемы нет вовсе.
 *
 * Регистрирует подсистему только сборка вьюпорта редактора: игровой клиент её
 * не знает, и наложения в игровом кадре невозможны по конструкции — тем же
 * способом, каким взаимоисключающесть продюсеров (REND-11) делает невозможным
 * документный инстанс в игровом кадре.
 */
import * as THREE from 'three';
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  type QualityDeclaration,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { VisualSurface } from '../visualSurface.js';
import {
  createPickProxy,
  type InstanceProxySource,
  type PickProxy,
  type PickProxySource,
  type PickProxyVisitor,
} from '../picking.js';

// ------------------------------------------------------------ словарь видов

/** Ось наложения в мировых осях сцены. */
export type OverlayAxis = 'x' | 'y' | 'z';

/** Форма ручки gizmo: перемещение вдоль оси либо поворот вокруг неё. */
export type OverlayHandleForm = 'translate' | 'rotate';

/**
 * Ручка gizmo. `id` — её идентичность: им же picking называет попадание
 * (REND-15). Что произойдёт при захвате, рендеру неизвестно (ED-16, ED-29).
 */
export interface OverlayHandle {
  readonly id: string;
  readonly axis: OverlayAxis;
  readonly form: OverlayHandleForm;
  /** Курсор наведён на ручку. */
  readonly hovered?: boolean;
  /** Ручка захвачена. */
  readonly active?: boolean;
}

/** Подсветка инстанса в его видимой позе. */
export interface OverlayHighlight {
  readonly kind: 'highlight';
  readonly key: string;
  readonly entity: EntityId;
  /**
   * Подсвечивается decoration-инстанс (REND-18), а не сущность
   * presentation-состояния. Признак, а не отдельный вид наложения: подсветка у
   * сим-объекта и у декорации одна и та же — этого требует единообразие
   * выделения (`editor` ED-17), — а различаются только наборы, в которых
   * ищется инстанс.
   */
  readonly decoration?: boolean;
}

/** Ручки gizmo в заданной позе. */
export interface OverlayGizmo {
  readonly kind: 'gizmo';
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Разворот набора ручек вокруг вертикали, радианы; нет — мировые оси. */
  readonly yaw?: number;
  /**
   * Множитель размера ручек поверх размера подсистемы; нет — 1. Поле набора, а
   * не настройка сборки: экранно-постоянный gizmo — состояние инструмента,
   * зависящее от дистанции камеры, и держать его в конструкторе значило бы
   * лишить редактора (ED-16) единственного способа его назначить.
   */
  readonly scale?: number;
  readonly handles: readonly OverlayHandle[];
}

/** Набор клеток, лежащий на визуальной поверхности. */
export interface OverlayCells {
  readonly kind: 'cells';
  readonly key: string;
  /** Индексы клеток сетки (row-major), как их называет picking (REND-15). */
  readonly cells: readonly number[];
}

/** Сетка по визуальной поверхности; без прямоугольника — вся арена. */
export interface OverlayGrid {
  readonly kind: 'grid';
  readonly key: string;
  readonly x0?: number;
  readonly y0?: number;
  /** Включительно. */
  readonly x1?: number;
  readonly y1?: number;
}

export type OverlayItem = OverlayHighlight | OverlayGizmo | OverlayCells | OverlayGrid;

// ------------------------------------------------------------------ опции

/** Цвета наложений — настройка вьюпорта, а не норма: словарь видов закрыт, палитра нет. */
export interface OverlayColors {
  readonly highlight: number;
  readonly cells: number;
  readonly grid: number;
  readonly axisX: number;
  readonly axisY: number;
  readonly axisZ: number;
  readonly hovered: number;
  readonly active: number;
}

const DEFAULT_COLORS: OverlayColors = {
  highlight: 0xffffff,
  cells: 0x9fd0ff,
  grid: 0x8fa0b0,
  axisX: 0xd05050,
  axisY: 0x50c050,
  axisZ: 0x5080d0,
  hovered: 0xffffff,
  active: 0xffe070,
};

export interface OverlayOptions {
  /** Визуальная поверхность (REND-9): на неё ложатся клетки и сетка. */
  readonly surface?: VisualSurfaceSource;
  /** Прокси инстансов — по ним рисуется подсветка в видимой позе (REND-16). */
  readonly instances?: InstanceProxySource;
  readonly colors?: Partial<OverlayColors>;
  /** Базовый размер ручек gizmo в мировых единицах; набор множит его своим `scale`. */
  readonly handleSize?: number;
  /** Подъём наложений над поверхностью, чтобы они не спорили с полом по глубине. */
  readonly lift?: number;
}

const DEFAULT_HANDLE_SIZE = 1;
const DEFAULT_LIFT = 0.02;
/** Толщина ручки как доля её длины. */
const HANDLE_THICKNESS = 0.08;
/** Вырожденная по оси рамка всё же должна быть видна. */
const MIN_BOX_SIZE = 1e-4;

// ------------------------------------------------------ внутреннее хозяйство

interface HandleNode {
  readonly id: string;
  readonly mesh: THREE.Mesh;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

interface OverlayNode {
  item: OverlayItem;
  readonly object: THREE.Object3D;
  /** Геометрии, которыми наложение владеет; общие с подсистемой — не здесь. */
  readonly owned: THREE.BufferGeometry[];
  readonly handles: HandleNode[];
}

export class OverlaySubsystem implements RenderSubsystem, PickProxySource {
  readonly name = 'overlays';

  private readonly options: OverlayOptions;
  private readonly colors: OverlayColors;
  private readonly handleSize: number;
  private readonly lift: number;

  private ctx: RenderContext | null = null;
  /** Плотность разбиения — та же, что у пола: наложение лежит на той же выборке. */
  private tessellation = DEFAULT_CURVATURE_TESSELLATION;
  private readonly group = new THREE.Group();
  private readonly nodes = new Map<string, OverlayNode>();
  private attached = false;
  /** Поверхность изменилась — наложения по ней перестраиваются следующим кадром. */
  private surfaceDirty = false;

  /** Общие материалы и геометрии подсистемы: свои, чужих она не трогает. */
  private highlightMaterial: THREE.LineBasicMaterial | null = null;
  private cellsMaterial: THREE.MeshBasicMaterial | null = null;
  private gridMaterial: THREE.LineBasicMaterial | null = null;
  private handleMaterials: Map<string, THREE.MeshBasicMaterial> | null = null;
  private boxEdges: THREE.BufferGeometry | null = null;
  private armGeometry: THREE.BufferGeometry | null = null;
  private ringGeometry: THREE.BufferGeometry | null = null;

  /** Переиспользуемое: прокси инстанса и матрица рамки подсветки. */
  private readonly proxy: PickProxy = createPickProxy();
  private readonly handleProxy: PickProxy = createPickProxy();
  private readonly boxMatrix = new THREE.Matrix4();
  private readonly boxPosition = new THREE.Vector3();
  private readonly boxScale = new THREE.Vector3();
  private readonly boxQuaternion = new THREE.Quaternion();
  /** Скретчи разбора и сборки преобразования прокси: оно числа, а не узел. */
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly proxyPosition = new THREE.Vector3();
  private readonly proxyQuaternion = new THREE.Quaternion();
  private readonly proxyScale = new THREE.Vector3();

  constructor(options: OverlayOptions = {}) {
    this.options = options;
    this.colors = { ...DEFAULT_COLORS, ...options.colors };
    this.handleSize = options.handleSize ?? DEFAULT_HANDLE_SIZE;
    this.lift = options.lift ?? DEFAULT_LIFT;
    this.group.name = 'overlays';
  }

  // ------------------------------------------------------------- REND-8

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.tessellation = Math.max(
      1,
      Math.floor(ctx.config.curvatureTessellation ?? DEFAULT_CURVATURE_TESSELLATION),
    );
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    this.options.surface?.onChange(() => {
      this.surfaceDirty = true;
    });

    this.highlightMaterial = new THREE.LineBasicMaterial({
      color: this.colors.highlight,
      depthTest: false,
    });
    this.gridMaterial = new THREE.LineBasicMaterial({ color: this.colors.grid, transparent: true, opacity: 0.5 });
    this.cellsMaterial = new THREE.MeshBasicMaterial({
      color: this.colors.cells,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.handleMaterials = new Map([
      ['x', new THREE.MeshBasicMaterial({ color: this.colors.axisX, depthTest: false })],
      ['y', new THREE.MeshBasicMaterial({ color: this.colors.axisY, depthTest: false })],
      ['z', new THREE.MeshBasicMaterial({ color: this.colors.axisZ, depthTest: false })],
      ['hovered', new THREE.MeshBasicMaterial({ color: this.colors.hovered, depthTest: false })],
      ['active', new THREE.MeshBasicMaterial({ color: this.colors.active, depthTest: false })],
    ]);

    this.boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const arm = new THREE.BoxGeometry(
      this.handleSize,
      this.handleSize * HANDLE_THICKNESS,
      this.handleSize * HANDLE_THICKNESS,
    );
    arm.translate(this.handleSize / 2, 0, 0);
    arm.computeBoundingBox();
    this.armGeometry = arm;
    const ring = new THREE.TorusGeometry(
      this.handleSize * 0.8,
      (this.handleSize * HANDLE_THICKNESS) / 2,
      6,
      24,
    );
    ring.computeBoundingBox();
    this.ringGeometry = ring;

    this.syncAttachment();
  }

  /**
   * Наложения — состояние инструмента, а не тика: presentation-состояние они не
   * читают. Исчезновение подсвеченной сущности видно через её прокси (REND-15),
   * а не через `view` — источник прокси и есть то, что рисуется.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- baseline
  syncTick(_view: TickView): void {}

  /**
   * Стоимость подсистемы объявлена КОНСТАНТНОЙ (`render-quality` QUAL-3), и
   * ручек у неё нет: набор наложений — состояние ИНСТРУМЕНТА редактора (что
   * выделено, какой gizmo активен), а не объём контента, и растёт он с числом
   * наложений, которые кладёт редактор, а не с числом сущностей сцены.
   *
   * Игрового кадра подсистема не касается вовсе: её регистрирует только сборка
   * вьюпорта, и наложений в игровом кадре не бывает по конструкции (REND-16), —
   * а пресеты качества калибруются как раз по нему. Вьюпорт же работает на
   * ультра (авторская картинка, а не бюджет, design D4), и рычаг здесь не
   * понадобится ни при каком пресете.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [],
      constantCost:
        'набор наложений — состояние инструмента редактора, а не объём контента; ' +
        'в игровом кадре подсистемы нет вовсе (REND-16)',
    };
  }

  updateFrame(_dt: number, _alpha: number): void {
    if (this.surfaceDirty) {
      this.surfaceDirty = false;
      for (const node of this.nodes.values()) {
        if (node.item.kind === 'cells' || node.item.kind === 'grid') this.rebuild(node);
      }
    }
    // Подсветка следует за видимой позой инстанса: матрица берётся у его узла, а
    // не считается заново, — на склоне холма (REND-10) это одно и то же только
    // при одном источнике.
    for (const node of this.nodes.values()) {
      if (node.item.kind === 'highlight') this.updateHighlight(node, node.item);
    }
  }

  // ---------------------------------------------------------- REND-16 API

  /**
   * Полный набор наложений (REND-16): ключ, которого не было, создаёт
   * наложение, исчезнувший убирает, сохранившийся обновляет. Набор без
   * изменений сценовых объектов не пересоздаёт — иначе картинка мигала бы на
   * каждом движении курсора.
   */
  apply(items: Iterable<OverlayItem>): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) {
        throw new Error(`OverlaySubsystem: ключ "${item.key}" встречается в наборе дважды (REND-16)`);
      }
      seen.add(item.key);
      const existing = this.nodes.get(item.key);
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
      if (existing !== undefined && existing.item.kind === item.kind) {
        if (sameItem(existing.item, item)) continue;
        existing.item = item;
        this.rebuild(existing);
        continue;
      }
      if (existing !== undefined) this.drop(item.key);
      this.nodes.set(item.key, this.create(item));
    }
    for (const key of [...this.nodes.keys()]) {
      if (!seen.has(key)) this.drop(key);
    }
    this.syncAttachment();
  }

  /** Пустой набор гасит все наложения. */
  clear(): void {
    this.apply([]);
  }

  /** Сколько наложений в текущем наборе. */
  get size(): number {
    return this.nodes.size;
  }

  /** Сценовых объектов подсистемы; 0 — кадр тот же, что без подсистемы вовсе (ED-22). */
  get objectCount(): number {
    return this.attached ? this.group.children.length : 0;
  }

  /**
   * Ручки как объёмы-прокси (REND-15): порядок разрешения ставит их перед
   * объектами, поэтому источник у них свой.
   *
   * Преобразование отдаётся числами, а не узлом (REND-3): мировая матрица меша
   * ручки разбирается на позицию, кватернион и масштаб прямо здесь. Это ТА ЖЕ
   * матрица, которой ручка нарисована, — второго расчёта её позы у наложений
   * не заводится, как и у инстансов.
   */
  eachProxy(visit: PickProxyVisitor): void {
    for (const node of this.nodes.values()) {
      for (const handle of node.handles) {
        // Мировые матрицы обновляет рендерер перед отрисовкой; наведение
        // спрашивают и между кадрами, поэтому матрица подтягивается из позы.
        handle.mesh.updateWorldMatrix(true, false);
        handle.mesh.matrixWorld.decompose(this.proxyPosition, this.proxyQuaternion, this.proxyScale);
        this.handleProxy.entity = 0;
        this.handleProxy.decoration = false;
        this.handleProxy.handle = handle.id;
        this.handleProxy.posX = this.proxyPosition.x;
        this.handleProxy.posY = this.proxyPosition.y;
        this.handleProxy.posZ = this.proxyPosition.z;
        this.handleProxy.quatX = this.proxyQuaternion.x;
        this.handleProxy.quatY = this.proxyQuaternion.y;
        this.handleProxy.quatZ = this.proxyQuaternion.z;
        this.handleProxy.quatW = this.proxyQuaternion.w;
        this.handleProxy.scaleX = this.proxyScale.x;
        this.handleProxy.scaleY = this.proxyScale.y;
        this.handleProxy.scaleZ = this.proxyScale.z;
        this.handleProxy.minX = handle.minX;
        this.handleProxy.minY = handle.minY;
        this.handleProxy.minZ = handle.minZ;
        this.handleProxy.maxX = handle.maxX;
        this.handleProxy.maxY = handle.maxY;
        this.handleProxy.maxZ = handle.maxZ;
        visit(this.handleProxy);
      }
    }
  }

  // ------------------------------------------------------------ внутреннее

  /** Группа наложений висит в сцене только когда в ней есть что рисовать. */
  private syncAttachment(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const wanted = this.group.children.length > 0;
    if (wanted === this.attached) return;
    if (wanted) ctx.scene.add(this.group);
    else ctx.scene.remove(this.group);
    this.attached = wanted;
  }

  private create(item: OverlayItem): OverlayNode {
    const node: OverlayNode = {
      item,
      object: new THREE.Group(),
      owned: [],
      handles: [],
    };
    node.object.name = `overlay:${item.key}`;
    this.group.add(node.object);
    this.rebuild(node);
    return node;
  }

  private drop(key: string): void {
    const node = this.nodes.get(key);
    if (node === undefined) return;
    this.nodes.delete(key);
    this.group.remove(node.object);
    this.disposeContents(node);
  }

  /** Снимает и освобождает содержимое наложения; общие ресурсы не трогает. */
  private disposeContents(node: OverlayNode): void {
    node.object.clear();
    for (const geometry of node.owned) geometry.dispose();
    node.owned.length = 0;
    node.handles.length = 0;
  }

  private rebuild(node: OverlayNode): void {
    this.disposeContents(node);
    const item = node.item;
    if (item.kind === 'highlight') this.buildHighlight(node, item);
    else if (item.kind === 'gizmo') this.buildGizmo(node, item);
    else if (item.kind === 'cells') this.buildCells(node, item);
    else this.buildGrid(node, item);
  }

  // -------------------------------------------------------- виды наложений

  private buildHighlight(node: OverlayNode, item: OverlayHighlight): void {
    const edges = this.boxEdges;
    const material = this.highlightMaterial;
    if (edges === null || material === null) return;
    const outline = new THREE.LineSegments(edges, material);
    outline.name = `highlight:${item.decoration === true ? 'decoration:' : ''}${item.entity}`;
    outline.matrixAutoUpdate = false;
    outline.renderOrder = 1;
    node.object.add(outline);
    this.updateHighlight(node, item);
  }

  /**
   * Рамка ставится ТЕМ ЖЕ преобразованием, которым подсистема моделей нарисовала
   * инстанс в этом кадре, а размер берёт из его объёма-прокси. Матрица инстанса
   * собирается из позы прокси — узла сцены в контракте нет (REND-3), и на
   * батчевой записи (REND-20) рамка встанет теми же числами. Материалы и скин
   * инстанса (REND-6) при этом не трогаются.
   */
  private updateHighlight(node: OverlayNode, item: OverlayHighlight): void {
    const outline = node.object.children[0];
    if (outline === undefined) return;
    const source = this.options.instances;
    if (!source?.proxyOf(item.entity, this.proxy, item.decoration === true)) {
      outline.visible = false;
      return;
    }
    outline.visible = true;
    const proxy = this.proxy;
    this.proxyPosition.set(proxy.posX, proxy.posY, proxy.posZ);
    this.proxyQuaternion.set(proxy.quatX, proxy.quatY, proxy.quatZ, proxy.quatW);
    this.proxyScale.set(proxy.scaleX, proxy.scaleY, proxy.scaleZ);
    this.instanceMatrix.compose(this.proxyPosition, this.proxyQuaternion, this.proxyScale);
    this.boxPosition.set(
      (proxy.minX + proxy.maxX) / 2,
      (proxy.minY + proxy.maxY) / 2,
      (proxy.minZ + proxy.maxZ) / 2,
    );
    this.boxScale.set(
      Math.max(proxy.maxX - proxy.minX, MIN_BOX_SIZE),
      Math.max(proxy.maxY - proxy.minY, MIN_BOX_SIZE),
      Math.max(proxy.maxZ - proxy.minZ, MIN_BOX_SIZE),
    );
    this.boxQuaternion.identity();
    this.boxMatrix.compose(this.boxPosition, this.boxQuaternion, this.boxScale);
    outline.matrix.multiplyMatrices(this.instanceMatrix, this.boxMatrix);
    outline.matrixWorldNeedsUpdate = true;
  }

  private buildGizmo(node: OverlayNode, item: OverlayGizmo): void {
    const arm = this.armGeometry;
    const ring = this.ringGeometry;
    const materials = this.handleMaterials;
    if (arm === null || ring === null || materials === null) return;
    node.object.position.set(item.x, item.y, item.z);
    node.object.rotation.set(0, 0, item.yaw ?? 0);
    // Размер живёт в узле, а не в геометрии: объёмы-прокси ручек заданы в
    // локальных осях меша, и picking (REND-15) получает масштаб той же матрицей,
    // какой ручка нарисована, — второго места, где он учитывается, нет.
    node.object.scale.setScalar(item.scale ?? 1);

    for (const handle of item.handles) {
      const geometry = handle.form === 'translate' ? arm : ring;
      const key = handle.active === true ? 'active' : handle.hovered === true ? 'hovered' : handle.axis;
      const mesh = new THREE.Mesh(geometry, materials.get(key));
      mesh.name = `handle:${handle.id}`;
      mesh.renderOrder = 2;
      orientHandle(mesh, handle);
      node.object.add(mesh);
      const box = geometry.boundingBox;
      node.handles.push({
        id: handle.id,
        mesh,
        minX: box?.min.x ?? 0,
        minY: box?.min.y ?? 0,
        minZ: box?.min.z ?? 0,
        maxX: box?.max.x ?? 0,
        maxY: box?.max.y ?? 0,
        maxZ: box?.max.z ?? 0,
      });
    }
  }

  /**
   * Клетки лежат на визуальной поверхности (REND-9) — по кривизне и рампам, а не
   * на плоскости уровня: иначе превью кисти на холме показывает автору не те
   * клетки, которые кисть покрасит (ED-11).
   *
   * Ячейка строится ТОЙ ЖЕ выборкой и с той же плотностью, что пол под ней:
   * плоский квад на сглаженном холме провалился бы в него серединой. Наложений
   * в кадре единицы, поэтому отдельного параметра плотности у них нет.
   */
  private buildCells(node: OverlayNode, item: OverlayCells): void {
    const source = this.options.surface;
    const surface = source?.current;
    const material = this.cellsMaterial;
    if (source === undefined || surface == null || material === null) return;
    const grid = source.terrain;
    // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
    const tile = grid.tileSize / FIXED_ONE;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const cell of item.cells) {
      if (cell < 0 || cell >= grid.width * grid.height) continue;
      const x = cell % grid.width;
      const y = Math.floor(cell / grid.width);
      // Быстрый путь по углам клетки не годится ни при кривизне, ни под
      // walkable-поверхностью (REND-9): в накрытой клетке высота поля не
      // выводится из углов — ячейка ложится на настил той же выборкой поля.
      if (!surface.hasCellCurvature(x, y) && !surface.hasCellWalkable(x, y)) {
        const [h00, h10, h11, h01] = surface.cornerHeights(x, y);
        const base = positions.length / 3;
        positions.push(
          x * tile, y * tile, h00 + this.lift,
          (x + 1) * tile, y * tile, h10 + this.lift,
          (x + 1) * tile, (y + 1) * tile, h11 + this.lift,
          x * tile, (y + 1) * tile, h01 + this.lift,
        );
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        continue;
      }
      const divisions = this.tessellation;
      for (let j = 0; j < divisions; j++) {
        for (let i = 0; i < divisions; i++) {
          const ax = (x + i / divisions) * tile;
          const bx = (x + (i + 1) / divisions) * tile;
          const ay = (y + j / divisions) * tile;
          const by = (y + (j + 1) / divisions) * tile;
          const base = positions.length / 3;
          pushLiftedPoint(positions, surface, x, y, ax, ay, this.lift);
          pushLiftedPoint(positions, surface, x, y, bx, ay, this.lift);
          pushLiftedPoint(positions, surface, x, y, bx, by, this.lift);
          pushLiftedPoint(positions, surface, x, y, ax, by, this.lift);
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
    if (indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    node.owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'cells';
    node.object.add(mesh);
  }

  /** Сетка идёт по углам клеток той же поверхности — контур клетки, а не плоскости. */
  private buildGrid(node: OverlayNode, item: OverlayGrid): void {
    const source = this.options.surface;
    const surface = source?.current;
    const material = this.gridMaterial;
    if (source === undefined || surface == null || material === null) return;
    const grid = source.terrain;
    const tile = grid.tileSize / FIXED_ONE;
    const x0 = Math.max(item.x0 ?? 0, 0);
    const y0 = Math.max(item.y0 ?? 0, 0);
    const x1 = Math.min(item.x1 ?? grid.width - 1, grid.width - 1);
    const y1 = Math.min(item.y1 ?? grid.height - 1, grid.height - 1);
    const positions: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        pushCellOutline(positions, surface, x, y, tile, this.lift, this.tessellation);
      }
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    node.owned.push(geometry);
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'grid';
    node.object.add(lines);
  }
}

// ---------------------------------------------------------------- хелперы

/** Ориентация ручки: ось перемещения — вдоль неё, ось поворота — нормаль кольца. */
function orientHandle(mesh: THREE.Mesh, handle: OverlayHandle): void {
  if (handle.form === 'translate') {
    // Геометрия построена вдоль +X.
    if (handle.axis === 'y') mesh.rotation.set(0, 0, Math.PI / 2);
    else if (handle.axis === 'z') mesh.rotation.set(0, -Math.PI / 2, 0);
    return;
  }
  // Кольцо построено в плоскости XY, то есть нормалью вдоль Z.
  if (handle.axis === 'x') mesh.rotation.set(0, Math.PI / 2, 0);
  else if (handle.axis === 'y') mesh.rotation.set(Math.PI / 2, 0, 0);
}

/**
 * Четыре ребра клетки по визуальной поверхности. Клетка с кривизной даёт
 * ломаную по той же выборке поля, что и её пол (REND-9): прямой контур на
 * сглаженном холме резал бы его насквозь.
 */
function pushCellOutline(
  out: number[],
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  lift: number,
  tessellation: number,
): void {
  const x0 = x * tile;
  const y0 = y * tile;
  const x1 = (x + 1) * tile;
  const y1 = (y + 1) * tile;
  // Как у ячеек: под walkable-поверхностью контур идёт выборкой поля (REND-9).
  if (!surface.hasCellCurvature(x, y) && !surface.hasCellWalkable(x, y)) {
    const [h00, h10, h11, h01] = surface.cornerHeights(x, y);
    const z00 = h00 + lift;
    const z10 = h10 + lift;
    const z11 = h11 + lift;
    const z01 = h01 + lift;
    out.push(
      x0, y0, z00, x1, y0, z10,
      x1, y0, z10, x1, y1, z11,
      x1, y1, z11, x0, y1, z01,
      x0, y1, z01, x0, y0, z00,
    );
    return;
  }
  // Рёбра в том же порядке: юг (y0), восток (x1), север (y1), запад (x0).
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x0, y0, x1, y0);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x1, y0, x1, y1);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x1, y1, x0, y1);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x0, y1, x0, y0);
}

/** Ребро контура ломаной по полю: `tessellation` отрезков вместо одного. */
function pushOutlineEdge(
  out: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  lift: number,
  tessellation: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  let px = ax;
  let py = ay;
  let pz = surface.heightInCell(cellX, cellY, ax, ay) + lift;
  for (let i = 1; i <= tessellation; i++) {
    const t = i / tessellation;
    const qx = ax + (bx - ax) * t;
    const qy = ay + (by - ay) * t;
    const qz = surface.heightInCell(cellX, cellY, qx, qy) + lift;
    out.push(px, py, pz, qx, qy, qz);
    px = qx;
    py = qy;
    pz = qz;
  }
}

/** Точка ячейки наложения на поле, поднятая над ним на `lift`. */
function pushLiftedPoint(
  out: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  wx: number,
  wy: number,
  lift: number,
): void {
  out.push(wx, wy, surface.heightInCell(cellX, cellY, wx, wy) + lift);
}

/** Наложение не изменилось — сценовые объекты пересобирать нечего. */
function sameItem(a: OverlayItem, b: OverlayItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'highlight' && b.kind === 'highlight') {
    return a.entity === b.entity && (a.decoration ?? false) === (b.decoration ?? false);
  }
  if (a.kind === 'gizmo' && b.kind === 'gizmo') {
    if (a.x !== b.x || a.y !== b.y || a.z !== b.z || (a.yaw ?? 0) !== (b.yaw ?? 0)) return false;
    if ((a.scale ?? 1) !== (b.scale ?? 1)) return false;
    if (a.handles.length !== b.handles.length) return false;
    return a.handles.every((handle, i) => {
      const other = b.handles[i]!;
      return (
        handle.id === other.id &&
        handle.axis === other.axis &&
        handle.form === other.form &&
        (handle.hovered ?? false) === (other.hovered ?? false) &&
        (handle.active ?? false) === (other.active ?? false)
      );
    });
  }
  if (a.kind === 'cells' && b.kind === 'cells') {
    return a.cells.length === b.cells.length && a.cells.every((cell, i) => cell === b.cells[i]);
  }
  if (a.kind === 'grid' && b.kind === 'grid') {
    return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
  }
  return false;
}
