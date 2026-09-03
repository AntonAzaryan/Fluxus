/**
 * Рисовальщик примитивов отладочного слоя (`render-debug` RDBG-3): сценовыми
 * объектами наложений владеет ОН, а не источник.
 *
 * Источник отдаёт примитивы закрытого словаря (`contract.ts`), painter сводит их
 * в три переиспользуемых носителя — отрезки, точки и треугольники — плюс по
 * плашке на растровый источник. Три носителя, а не объект на примитив: набор
 * наложений перестраивается каждым кадром включённого источника, и сцена,
 * пересобираемая узлами, стоила бы аллокаций пропорционально числу примитивов
 * (REND-26).
 *
 * Кадр под наложением не красится (RDBG-5): painter добавляет СВОИ объекты со
 * СВОИМИ материалами и не трогает ни материалов, ни освещения, ни геометрии
 * подсистем. Пустой набор снимает группу со сцены целиком — кадр тогда тот же,
 * что у сборки без отладочного слоя вовсе (RDBG-4).
 *
 * Наложения, привязанные к поверхности (окружность, диск, полигон), ложатся на
 * ВИЗУАЛЬНУЮ поверхность (REND-9) — по кривизне и рампам, а не на плоскость
 * уровня: иначе круг коллайдера на холме показывал бы не то место, по которому
 * решает тик, ровно как превью кисти вьюпорта (REND-16).
 */
import * as THREE from 'three';
import { FIXED_ONE } from '@fluxus/core';
import type { DebugColor, DebugDraw, DebugPose, DebugRaster } from './contract.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { carrier, upload, type Carrier } from './carriers.js';
import { disposeRasterPlane, rasterPlaneOf, type RasterPlane } from './rasterPlane.js';
import { areaSubdivisions } from '../surfaceCells.js';
import { DEFAULT_CURVATURE_TESSELLATION } from '../types.js';
import { own } from '../footprint.js';

/** Сегментов на окружность и диск: контур читается, а вершин остаётся немного. */
const CIRCLE_SEGMENTS = 32;
/** Подъём наложения над поверхностью, чтобы оно не спорило с полом по глубине. */
const SURFACE_LIFT = 0.03;
/**
 * Рёбра коробки парами индексов углов. Номер угла — битовая маска осей:
 * бит 0 — X по максимуму, бит 1 — Y, бит 2 — Z. Четыре ребра нижней грани,
 * четыре верхней и четыре вертикали.
 */
const BOX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export interface DebugPainterOptions {
  /** Сцена наложений; нет — слой не рисует вовсе (headless-дамп, RDBG-2). */
  readonly scene?: THREE.Scene;
  /** Визуальная поверхность (REND-9): на неё ложатся окружности, диски и полигоны. */
  readonly surface?: VisualSurfaceSource;
  /**
   * Подшагов на клетку при укладке полигона на поверхность (REND-9) — то же
   * число, которым дробит клетку геометрия террейна и наложений; умолчание —
   * умолчание конфига рендера.
   */
  readonly tessellation?: number;
}

/**
 * Реализация словаря примитивов поверх THREE. Пишут в неё только рисовальщики
 * источников, и только между `begin()` и `commit()`.
 */
export class DebugPainter implements DebugDraw {
  private readonly options: DebugPainterOptions;
  private readonly group = new THREE.Group();
  private readonly lines: Carrier;
  private readonly points: Carrier;
  private readonly triangles: Carrier;
  private readonly rasters = new Map<string, RasterPlane>();
  private attached = false;
  /** Ресурсы отданы: повторный `dispose` не отдаёт их дважды (учёт PERF-8 считает разность). */
  private disposed = false;
  /** Растровый источник текущего примитива — по нему плашка находит свою. */
  private rasterOwner = '';

  /** Скретчи преобразования коробки: живут между кадрами, на кадр не аллоцируют. */
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());

  /**
   * То, что видит ИСТОЧНИК, — закрытый словарь примитивов и ничего сверх него
   * (RDBG-3). Отдельный объект, а не сам painter: у painter'а есть ещё
   * жизненный цикл набора (`begin`/`owner`/`commit`/`clear`) и счётчики сцены,
   * и рисовальщику источника они не принадлежат — «прямого доступа к сцене, её
   * объектам и материалам у источника MUST NOT быть» держится так на
   * построении, а не на типе аргумента. Объект создаётся ОДИН раз вместе со
   * слоем: аллокаций на кадр от него нет (REND-26).
   */
  readonly primitives: DebugDraw = {
    point: (x, y, z, color) => {
      this.point(x, y, z, color);
    },
    segment: (x1, y1, z1, x2, y2, z2, color) => {
      this.segment(x1, y1, z1, x2, y2, z2, color);
    },
    polyline: (points, color, closed) => {
      this.polyline(points, color, closed);
    },
    circle: (x, y, radius, color) => {
      this.circle(x, y, radius, color);
    },
    disc: (x, y, radius, color) => {
      this.disc(x, y, radius, color);
    },
    box: (pose, color) => {
      this.box(pose, color);
    },
    polygon: (points, color) => {
      this.polygon(points, color);
    },
    raster: (raster, color) => {
      this.raster(raster, color);
    },
  };

  constructor(options: DebugPainterOptions = {}) {
    this.options = options;
    this.group.name = 'render-debug';
    // Наложения рисуются ПОВЕРХ изображения (RDBG-5): глубина не тестируется,
    // но и не пишется — кадр под ними остаётся нетронутым.
    this.lines = carrier(
      own(
        'material',
        'debug',
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }),
      ),
      (geometry, material) => new THREE.LineSegments(geometry, material),
    );
    this.points = carrier(
      own(
        'material',
        'debug',
        new THREE.PointsMaterial({
          vertexColors: true,
          size: 6,
          sizeAttenuation: false,
          depthTest: false,
          depthWrite: false,
        }),
      ),
      (geometry, material) => new THREE.Points(geometry, material),
    );
    this.triangles = carrier(
      own(
        'material',
        'debug',
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
      (geometry, material) => new THREE.Mesh(geometry, material),
    );
    for (const one of [this.lines, this.points, this.triangles]) this.group.add(one.object);
  }

  /** Сценовых объектов слоя; 0 — кадр тот же, что без слоя вовсе (RDBG-4). */
  get objectCount(): number {
    return this.attached ? this.group.children.length : 0;
  }

  /** Вершин отрезков, точек и треугольников в текущем наборе — вход тестов. */
  get vertexCount(): number {
    return this.lines.buffer.count + this.points.buffer.count + this.triangles.buffer.count;
  }

  /** Начало набора кадра: буферы обнуляются, плашки помечаются неиспользованными. */
  begin(): void {
    this.lines.buffer.reset();
    this.points.buffer.reset();
    this.triangles.buffer.reset();
    for (const plane of this.rasters.values()) plane.used = false;
  }

  /** Чей примитив пишется сейчас: адрес плашки растрового источника. */
  owner(id: string): void {
    this.rasterOwner = id;
  }

  /** Конец набора: атрибуты обновляются, неиспользованные плашки уходят из сцены. */
  commit(): void {
    upload(this.lines);
    upload(this.points);
    upload(this.triangles);
    for (const [id, plane] of this.rasters) {
      if (plane.used) continue;
      this.group.remove(plane.mesh);
      disposeRasterPlane(plane);
      this.rasters.delete(id);
    }
    this.syncAttachment();
  }

  /** Полностью снимает наложения: выключение убирает их из кадра целиком (RDBG-4). */
  clear(): void {
    this.begin();
    this.commit();
  }

  /**
   * Точка освобождения рисовальщика (REND-31, ED-15): три носителя со своими
   * геометриями и материалами плюс плашки растровых источников. Без неё каждый
   * снос вьюпорта редактора терял бы их — учёт (PERF-8) видит владельца `debug`,
   * а инвариант PERF-9 требует, чтобы живых после сноса не осталось.
   *
   * Идемпотентна: повторный `dispose` не отдаёт ресурс дважды.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const scene = this.options.scene;
    if (this.attached && scene !== undefined) scene.remove(this.group);
    this.attached = false;
    for (const one of [this.lines, this.points, this.triangles]) {
      this.group.remove(one.object);
      one.geometry.dispose();
      one.material.dispose();
      one.buffer.reset();
    }
    for (const plane of this.rasters.values()) {
      this.group.remove(plane.mesh);
      disposeRasterPlane(plane);
    }
    this.rasters.clear();
  }

  // ------------------------------------------------------------- примитивы

  point(x: number, y: number, z: number, color: DebugColor): void {
    this.points.buffer.push(x, y, z, color);
  }

  segment(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    color: DebugColor,
  ): void {
    this.lines.buffer.push(x1, y1, z1, color);
    this.lines.buffer.push(x2, y2, z2, color);
  }

  polyline(points: readonly number[], color: DebugColor, closed = false): void {
    const count = Math.floor(points.length / 3);
    for (let i = 1; i < count; i += 1) {
      this.pushEdge(points, i - 1, i, color);
    }
    if (closed && count > 2) this.pushEdge(points, count - 1, 0, color);
  }

  /**
   * Окружность НА визуальной поверхности (REND-9). Звено между сегментами
   * дробится тем же правилом, что и полигон (`surfaceCells.ts`): на клетке с
   * кривизной прямое звено режет холм насквозь ровно так же, как резал его
   * плоский веер полигона.
   */
  circle(x: number, y: number, radius: number, color: DebugColor): void {
    const steps = this.areaSteps(x - radius, y - radius, x + radius, y + radius);
    let px = x + radius;
    let py = y;
    for (let i = 1; i <= CIRCLE_SEGMENTS; i += 1) {
      const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const qx = x + Math.cos(angle) * radius;
      const qy = y + Math.sin(angle) * radius;
      this.pushSurfaceEdge(px, py, qx, qy, steps, color);
      px = qx;
      py = qy;
    }
  }

  /**
   * Диск НА визуальной поверхности (REND-9): сектор — треугольник, и ложится он
   * тем же дроблением, что и треугольник полигона.
   */
  disc(x: number, y: number, radius: number, color: DebugColor): void {
    const steps = this.areaSteps(x - radius, y - radius, x + radius, y + radius);
    for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const b = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
      this.pushSurfaceTriangle(
        x, y,
        x + Math.cos(a) * radius, y + Math.sin(a) * radius,
        x + Math.cos(b) * radius, y + Math.sin(b) * radius,
        steps,
        color,
      );
    }
  }

  /**
   * Выпуклый полигон НА визуальной поверхности (REND-9). Сэмплировать одни
   * вершины нельзя: клетка с кривизной вышла бы плоским веером сквозь холм, а
   * клеточная заливка наложений (REND-16) ту же клетку дробит по тесселяции —
   * два разной точности строителя «клетка на поверхности» и были находкой
   * аудита. Правило дробления здесь общее с ней (`surfaceCells.ts`); дробление
   * одно на весь полигон — разное у соседних треугольников оставило бы щель.
   */
  polygon(points: readonly number[], color: DebugColor): void {
    const count = Math.floor(points.length / 2);
    if (count < 3) return;
    const steps = this.polygonSteps(points, count);
    const ax = points[0]!;
    const ay = points[1]!;
    for (let i = 1; i + 1 < count; i += 1) {
      this.pushSurfaceTriangle(
        ax, ay,
        points[i * 2]!, points[i * 2 + 1]!,
        points[(i + 1) * 2]!, points[(i + 1) * 2 + 1]!,
        steps,
        color,
      );
    }
  }

  box(pose: DebugPose, color: DebugColor): void {
    this.position.set(pose.posX, pose.posY, pose.posZ);
    this.quaternion.set(pose.quatX, pose.quatY, pose.quatZ, pose.quatW);
    this.scale.set(pose.scaleX, pose.scaleY, pose.scaleZ);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    for (let i = 0; i < 8; i += 1) {
      this.corner.set(
        (i & 1) === 0 ? pose.minX : pose.maxX,
        (i & 2) === 0 ? pose.minY : pose.maxY,
        (i & 4) === 0 ? pose.minZ : pose.maxZ,
      );
      this.corners[i]!.copy(this.corner).applyMatrix4(this.matrix);
    }
    for (const [a, b] of BOX_EDGES) {
      const from = this.corners[a]!;
      const to = this.corners[b]!;
      this.lines.buffer.push(from.x, from.y, from.z, color);
      this.lines.buffer.push(to.x, to.y, to.z, color);
    }
  }

  raster(raster: DebugRaster, color: DebugColor): void {
    if (this.options.scene === undefined) return;
    const plane = this.planeOf(this.rasterOwner, raster);
    plane.used = true;
    plane.texels.set(raster.texels.subarray(0, plane.texels.length));
    plane.texture.needsUpdate = true;
    plane.material.color.setHex(color);
    plane.mesh.scale.set(raster.worldWidth, raster.worldHeight, 1);
    plane.mesh.position.set(
      raster.worldX + raster.worldWidth / 2,
      raster.worldY + raster.worldHeight / 2,
      raster.worldZ,
    );
  }

  // ------------------------------------------------------------ внутреннее

  /** Высота визуальной поверхности под точкой; нет поверхности — плоскость нуля. */
  private heightAt(x: number, y: number): number {
    const surface = this.options.surface?.current ?? null;
    return (surface === null ? 0 : surface.heightAt(x, y)) + SURFACE_LIFT;
  }

  /** Делений стороны для полигона — по прямоугольнику, который он накрывает. */
  private polygonSteps(points: readonly number[], count: number): number {
    let minX = points[0]!;
    let maxX = minX;
    let minY = points[1]!;
    let maxY = minY;
    for (let i = 1; i < count; i += 1) {
      const x = points[i * 2]!;
      const y = points[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return this.areaSteps(minX, minY, maxX, maxY);
  }

  /**
   * Делений стороны для мирового прямоугольника (`surfaceCells.ts`) — одно
   * правило на все наложения, лежащие на поверхности: полигон, окружность и
   * диск дробятся им одинаково. Поверхности нет — плоскость нуля, дробить нечего.
   */
  private areaSteps(minX: number, minY: number, maxX: number, maxY: number): number {
    const source = this.options.surface;
    const surface = source?.current ?? null;
    if (source === undefined || surface === null) return 1;
    const grid = source.terrain;
    // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
    const tile = grid.tileSize / FIXED_ONE;
    return areaSubdivisions(
      surface,
      grid,
      tile,
      minX, minY, maxX, maxY,
      this.options.tessellation ?? DEFAULT_CURVATURE_TESSELLATION,
    );
  }

  /** Звено ломаной на поверхности: `steps` подшагов вместо одного (REND-9). */
  private pushSurfaceEdge(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    steps: number,
    color: DebugColor,
  ): void {
    let px = ax;
    let py = ay;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const qx = ax + (bx - ax) * t;
      const qy = ay + (by - ay) * t;
      this.lines.buffer.push(px, py, this.heightAt(px, py), color);
      this.lines.buffer.push(qx, qy, this.heightAt(qx, qy), color);
      px = qx;
      py = qy;
    }
  }

  /**
   * Треугольник, положенный на поверхность барицентрическим дроблением:
   * `P(u, v) = A + (B − A)·u + (C − A)·v`, вершины подтреугольников — на поле.
   * `steps === 1` — прежний путь по трём вершинам, и плоская арена от дробления
   * не дорожает ни на вершину.
   */
  private pushSurfaceTriangle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    steps: number,
    color: DebugColor,
  ): void {
    if (steps <= 1) {
      this.pushSurfacePoint(ax, ay, color);
      this.pushSurfacePoint(bx, by, color);
      this.pushSurfacePoint(cx, cy, color);
      return;
    }
    const ux = (bx - ax) / steps;
    const uy = (by - ay) / steps;
    const vx = (cx - ax) / steps;
    const vy = (cy - ay) / steps;
    for (let j = 0; j < steps; j += 1) {
      for (let i = 0; i + j < steps; i += 1) {
        const x0 = ax + ux * i + vx * j;
        const y0 = ay + uy * i + vy * j;
        this.pushSurfacePoint(x0, y0, color);
        this.pushSurfacePoint(x0 + ux, y0 + uy, color);
        this.pushSurfacePoint(x0 + vx, y0 + vy, color);
        // Вторая половина параллелограмма — везде, кроме внешнего ряда.
        if (i + j + 1 >= steps) continue;
        this.pushSurfacePoint(x0 + ux, y0 + uy, color);
        this.pushSurfacePoint(x0 + ux + vx, y0 + uy + vy, color);
        this.pushSurfacePoint(x0 + vx, y0 + vy, color);
      }
    }
  }

  /** Вершина треугольника на поверхности: высоту берёт само поле (REND-9). */
  private pushSurfacePoint(x: number, y: number, color: DebugColor): void {
    this.triangles.buffer.push(x, y, this.heightAt(x, y), color);
  }

  private pushEdge(points: readonly number[], a: number, b: number, color: DebugColor): void {
    this.lines.buffer.push(points[a * 3]!, points[a * 3 + 1]!, points[a * 3 + 2]!, color);
    this.lines.buffer.push(points[b * 3]!, points[b * 3 + 1]!, points[b * 3 + 2]!, color);
  }

  /** Плашка источника: своя на `id`, пересоздаётся только при смене разрешения. */
  private planeOf(id: string, raster: DebugRaster): RasterPlane {
    const existing = this.rasters.get(id);
    if (existing?.widthTexels === raster.widthTexels && existing.heightTexels === raster.heightTexels) {
      return existing;
    }
    if (existing !== undefined) {
      this.group.remove(existing.mesh);
      disposeRasterPlane(existing);
    }
    const plane = rasterPlaneOf(id, raster);
    this.group.add(plane.mesh);
    this.rasters.set(id, plane);
    return plane;
  }

  /** Группа висит в сцене, только когда в ней есть что рисовать (RDBG-4). */
  private syncAttachment(): void {
    const scene = this.options.scene;
    if (scene === undefined) return;
    const wanted = this.vertexCount > 0 || this.rasters.size > 0;
    if (wanted === this.attached) return;
    if (wanted) scene.add(this.group);
    else scene.remove(this.group);
    this.attached = wanted;
  }
}
