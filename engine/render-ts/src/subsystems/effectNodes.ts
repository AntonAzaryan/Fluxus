/**
 * Узел подсистемы эффектов и его пул (REND-23, REND-43): меш со своим
 * материалом, а у непроцедурного примитива — ещё и своя параметрическая сетка.
 *
 * Вынесено из подсистемы по той же причине, что прогрев и набор оболочек: «чем
 * эффект нарисован» и «какие эффекты существуют» — разные вопросы. Здесь —
 * только первый.
 *
 * ## Почему пул делится по примитиву И топологии
 *
 * Узел, построенный под диск, кольцом не станет: у них разное число вершин, а
 * топология фиксируется созданием (REND-26 — кадр переписывает только позиции).
 * Ключ пула поэтому — пара «примитив + сетка»; узел сферы делит с прочими
 * сферами ОДНУ геометрию (REND-3), и у него в ключе только имя примитива.
 *
 * Освобождения пула нет НАМЕРЕННО, как и прежде: он ограничен пиком
 * одновременных эффектов сцены, а геометрия и материалы живут столько же,
 * сколько сама подсистема.
 */
import * as THREE from 'three';
import type { VisualEffect } from '@fluxus/assets';
import type { VisualSurface } from '../visualSurface.js';
import type { WarnOnce } from '../warnOnce.js';
import { own } from '../footprint.js';
import { createGridShape, type ShapeBuffer } from './effectShapes.js';
import { EffectTrail } from './effectTrail.js';
import {
  DEFAULT_TRAIL_SAMPLES,
  GROUND_EFFECT_RENDER_ORDER,
  PRIMITIVE_RIBBON,
  isKnownPrimitive,
  isShapePrimitive,
  planShape,
} from './effectDraw.js';

/** Разбиение общей сферы: круглая на глаз и дешёвая — эффектов в кадре десятки. */
const SPHERE_SEGMENTS = 16;
const SPHERE_RINGS = 12;

/**
 * Узел пула: меш с собственным материалом и НИЧЕГО из presentation-среза. Ни
 * записи манифеста, ни сущности он не держит — иначе возвращённый в пул узел
 * удерживал бы сущность, которой давно нет.
 */
export interface EffectNode {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  /** Примитив, под который узел построен, — половина ключа пула. */
  readonly primitive: string;
  /** Своя сетка непроцедурного примитива; null — общая геометрия сферы. */
  readonly shape: ShapeBuffer | null;
  /** История поз ленты; null — узел не лента. */
  readonly trail: EffectTrail | null;
}

/** Что подсистема знает о поле в момент взятия узла — вход дробления фигуры. */
export interface ShapeContext {
  readonly surface: VisualSurface | null;
  /** Сторона клетки в мировых единицах; 0 — сетки нет, дробление по единицам. */
  readonly tile: number;
  readonly tessellation: number;
}

export class EffectNodePool {
  private readonly group: THREE.Object3D;
  private readonly warnOnce: WarnOnce;
  /** Свободные узлы по ключу «примитив + топология». */
  private readonly free = new Map<string, EffectNode[]>();
  /** Все заведённые узлы: по ним идёт снос (REND-31). */
  private readonly created: EffectNode[] = [];
  private sphere: THREE.SphereGeometry | null = null;
  /** Сколько узлов сейчас взято: пул + взятые и есть «заведено всего». */
  private taken = 0;

  constructor(group: THREE.Object3D, warnOnce: WarnOnce) {
    this.group = group;
    this.warnOnce = warnOnce;
  }

  /** Сколько узлов заведено всего (пул + взятые): по нему видно, что пул работает. */
  get size(): number {
    return this.created.length;
  }

  /** Сколько узлов взято прямо сейчас — вход отладки. */
  get active(): number {
    return this.taken;
  }

  init(): void {
    this.sphere ??= own(
      'geometry',
      'effects',
      new THREE.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_RINGS),
    );
  }

  /**
   * Узел под запись; null — примитив записи рендеру неизвестен: предупреждение
   * один раз и пропуск, документ старше кода (REND-23).
   */
  acquire(record: VisualEffect, ctx: ShapeContext): EffectNode | null {
    const primitive = record.primitive;
    if (!isKnownPrimitive(primitive)) {
      this.warnOnce(
        `primitive:${primitive}`,
        `render: примитив эффекта "${primitive}" рендеру неизвестен — запись пропущена (REND-23)`,
      );
      return null;
    }
    const plan = isShapePrimitive(primitive)
      ? planShape(record, ctx.surface, ctx.tile, ctx.tessellation)
      : null;
    const key = plan === null ? primitive : `${primitive}|${String(plan.rows)}x${String(plan.cols)}`;
    let bucket = this.free.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.free.set(key, bucket);
    }
    const node = bucket.pop() ?? this.create(record, plan);
    node.trail?.reset();
    node.mesh.visible = true;
    this.group.add(node.mesh);
    this.taken++;
    return node;
  }

  /** Гасит узел и возвращает его в свой карман пула. */
  release(node: EffectNode): void {
    node.mesh.removeFromParent();
    node.mesh.visible = false;
    const key =
      node.shape === null
        ? node.primitive
        : `${node.primitive}|${String(node.shape.rows)}x${String(node.shape.cols)}`;
    const bucket = this.free.get(key);
    if (bucket === undefined) this.free.set(key, [node]);
    else bucket.push(node);
    this.taken--;
  }

  /**
   * Снос пула (REND-31): пер-инстансные материалы всех заведённых узлов, их
   * собственные сетки и одна разделяемая геометрия сферы. Проход идёт по списку
   * ЗАВЕДЁННЫХ, а не по карманам: живые узлы возвращает вызывающий, но полагаться
   * на это освобождение не обязано.
   */
  dispose(): void {
    for (const node of this.created) {
      node.mesh.removeFromParent();
      node.material.dispose();
      node.shape?.geometry.dispose();
    }
    this.created.length = 0;
    this.free.clear();
    this.taken = 0;
    this.sphere?.dispose();
    this.sphere = null;
  }

  private create(record: VisualEffect, plan: { rows: number; cols: number } | null): EffectNode {
    const primitive = record.primitive;
    const shape = plan === null ? null : createGridShape(plan.rows, plan.cols);
    const geometry = shape?.geometry ?? this.sphere;
    if (geometry === null) throw new Error('EffectsSubsystem: init() не вызван (REND-8)');
    // Материал непроцедурной фигуры несёт ВЕРШИННЫЙ цвет: им живут мягкость
    // кромки и гашение хвоста ленты (design D4). Это бит ключа программы three,
    // поэтому и материал, и пул у таких узлов свои.
    const material = own(
      'material',
      'effects',
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        ...(shape === null ? {} : { vertexColors: true, side: THREE.DoubleSide }),
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'effect';
    if (shape !== null) {
      // Вершины фигуры — МИРОВЫЕ: узел стоит в начале координат группы, а
      // положение несёт сама сетка. Отсечения по границам у неё нет — границы
      // переписывались бы каждый кадр вместе с позициями.
      mesh.frustumCulled = false;
      // Место среди прозрачных: после воды (design D3, REND-35).
      mesh.renderOrder = GROUND_EFFECT_RENDER_ORDER;
    }
    // Эффект — изображение, а не сущность: в picking он не участвует (REND-15),
    // и луч сцены его не видит даже там, где ищут не по прокси.
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
    mesh.raycast = () => {};
    const trail =
      primitive === PRIMITIVE_RIBBON
        ? new EffectTrail(record.trailSamples ?? DEFAULT_TRAIL_SAMPLES)
        : null;
    const node: EffectNode = { mesh, material, primitive, shape, trail };
    this.created.push(node);
    return node;
  }
}
