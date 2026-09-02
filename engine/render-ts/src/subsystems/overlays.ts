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
import {
  DEFAULT_CURVATURE_TESSELLATION,
  type QualityDeclaration,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '../types.js';
import {
  createPickProxy,
  type PickProxy,
  type PickProxySource,
  type PickProxyVisitor,
} from '../picking.js';
import { cellsGeometry, gridGeometry } from './overlaySurface.js';
import {
  DEFAULT_COLORS,
  DEFAULT_HANDLE_SIZE,
  DEFAULT_LIFT,
  sameItem,
  type OverlayCells,
  type OverlayColors,
  type OverlayGizmo,
  type OverlayGrid,
  type OverlayHandle,
  type OverlayHighlight,
  type OverlayItem,
  type OverlayOptions,
} from './overlayItems.js';
import { own } from '../footprint.js';

/** Толщина ручки как доля её длины. */
const HANDLE_THICKNESS = 0.08;
/** Вырожденная по оси рамка всё же должна быть видна. */
const MIN_BOX_SIZE = 1e-4;

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

    this.highlightMaterial = own(
      'material',
      'overlays',
      new THREE.LineBasicMaterial({
        color: this.colors.highlight,
        depthTest: false,
      }),
    );
    this.gridMaterial = own(
      'material',
      'overlays',
      new THREE.LineBasicMaterial({ color: this.colors.grid, transparent: true, opacity: 0.5 }),
    );
    this.cellsMaterial = own(
      'material',
      'overlays',
      new THREE.MeshBasicMaterial({
        color: this.colors.cells,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    // Материал ручки — одной фабрикой на все пять: они отличаются ровно цветом,
    // и учёт ресурса (PERF-8) у них поэтому тоже один.
    const handleMaterial = (color: number): THREE.MeshBasicMaterial =>
      own('material', 'overlays', new THREE.MeshBasicMaterial({ color, depthTest: false }));
    this.handleMaterials = new Map([
      ['x', handleMaterial(this.colors.axisX)],
      ['y', handleMaterial(this.colors.axisY)],
      ['z', handleMaterial(this.colors.axisZ)],
      ['hovered', handleMaterial(this.colors.hovered)],
      ['active', handleMaterial(this.colors.active)],
    ]);

    // Куб-источник живёт ровно до построения рёбер: `EdgesGeometry` читает его
    // в конструкторе и дальше держит СВОИ буферы. Отдаётся он тут же — учёт
    // ресурсов (PERF-8) видит и его создание, и его освобождение, а инвариант
    // «после сноса живых ноль» (PERF-9) на нём не спотыкается.
    const boxSource = own('geometry', 'overlays', new THREE.BoxGeometry(1, 1, 1));
    this.boxEdges = own('geometry', 'overlays', new THREE.EdgesGeometry(boxSource));
    boxSource.dispose();
    const arm = own(
      'geometry',
      'overlays',
      new THREE.BoxGeometry(
        this.handleSize,
        this.handleSize * HANDLE_THICKNESS,
        this.handleSize * HANDLE_THICKNESS,
      ),
    );
    arm.translate(this.handleSize / 2, 0, 0);
    arm.computeBoundingBox();
    this.armGeometry = arm;
    const ring = own(
      'geometry',
      'overlays',
      new THREE.TorusGeometry(
        this.handleSize * 0.8,
        (this.handleSize * HANDLE_THICKNESS) / 2,
        6,
        24,
      ),
    );
    ring.computeBoundingBox();
    this.ringGeometry = ring;

    this.syncAttachment();
  }

  /**
   * Снос подсистемы (REND-31): содержимое наложений, затем разделяемые
   * геометрии ручек и рамки и общие материалы — то, что заведено в `init` один
   * раз на подсистему и потому не освобождается сведением набора (REND-16).
   */
  dispose(): void {
    this.clear();
    for (const geometry of [this.boxEdges, this.armGeometry, this.ringGeometry]) {
      geometry?.dispose();
    }
    this.boxEdges = null;
    this.armGeometry = null;
    this.ringGeometry = null;
    for (const material of [this.highlightMaterial, this.cellsMaterial, this.gridMaterial]) {
      material?.dispose();
    }
    this.highlightMaterial = null;
    this.cellsMaterial = null;
    this.gridMaterial = null;
    for (const material of this.handleMaterials?.values() ?? []) material.dispose();
    this.handleMaterials = null;
  }

  /**
   * Наложения — состояние инструмента, а не тика: presentation-состояние они не
   * читают. Исчезновение подсвеченной сущности видно через её прокси (REND-15),
   * а не через `view` — источник прокси и есть то, что рисуется.
   */
  syncTick(_view: TickView): void {
    // намеренно пусто: наложения кладёт инструмент, а не доставленный тик
  }

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
      if (existing?.item.kind === item.kind) {
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
  /** Заливка набора клеток на визуальной поверхности (REND-16, REND-9). */
  private buildCells(node: OverlayNode, item: OverlayCells): void {
    const source = this.options.surface;
    const surface = source?.current;
    const material = this.cellsMaterial;
    if (source === undefined || surface == null || material === null) return;
    const geometry = cellsGeometry(item.cells, surface, source.terrain, this.lift, this.tessellation);
    if (geometry === null) return;
    node.owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'cells';
    node.object.add(mesh);
  }

  /** Контурная сетка прямоугольника клеток (REND-16, REND-9). */
  private buildGrid(node: OverlayNode, item: OverlayGrid): void {
    const source = this.options.surface;
    const surface = source?.current;
    const material = this.gridMaterial;
    if (source === undefined || surface == null || material === null) return;
    const geometry = gridGeometry(item, surface, source.terrain, this.lift, this.tessellation);
    if (geometry === null) return;
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
