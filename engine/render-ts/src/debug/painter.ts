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
import type { DebugColor, DebugDraw, DebugPose, DebugRaster } from './contract.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';

/** Сегментов на окружность и диск: контур читается, а вершин остаётся немного. */
const CIRCLE_SEGMENTS = 32;
/** Подъём наложения над поверхностью, чтобы оно не спорило с полом по глубине. */
const SURFACE_LIFT = 0.03;
/** Стартовая ёмкость буферов в вершинах; растёт удвоением, не на кадр. */
const INITIAL_VERTICES = 256;
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

/** Растущий буфер вершин с цветом: позиции и цвета в паре, длина — в вершинах. */
class VertexBuffer {
  positions: Float32Array = new Float32Array(INITIAL_VERTICES * 3);
  colors: Float32Array = new Float32Array(INITIAL_VERTICES * 3);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, color: DebugColor): void {
    if ((this.count + 1) * 3 > this.positions.length) this.grow();
    const at = this.count * 3;
    this.positions[at] = x;
    this.positions[at + 1] = y;
    this.positions[at + 2] = z;
    this.colors[at] = ((color >> 16) & 0xff) / 255;
    this.colors[at + 1] = ((color >> 8) & 0xff) / 255;
    this.colors[at + 2] = (color & 0xff) / 255;
    this.count += 1;
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Float32Array(this.colors.length * 2);
    colors.set(this.colors);
    this.colors = colors;
  }
}

/** Один носитель: геометрия, её атрибуты и объект сцены. */
interface Carrier {
  readonly buffer: VertexBuffer;
  readonly geometry: THREE.BufferGeometry;
  readonly object: THREE.Object3D;
  /** Ёмкость атрибутов в вершинах — по ней видно, что буфер перерос их. */
  capacity: number;
}

/** Плашка растрового источника: своя текстура и свой квад. */
interface RasterPlane {
  readonly mesh: THREE.Mesh;
  readonly texture: THREE.DataTexture;
  /** Растр текстуры: своя копия слоя, а не буфер подсистемы (RDBG-2). */
  readonly texels: Uint8Array;
  readonly material: THREE.MeshBasicMaterial;
  readonly geometry: THREE.PlaneGeometry;
  readonly widthTexels: number;
  readonly heightTexels: number;
  used: boolean;
}

export interface DebugPainterOptions {
  /** Сцена наложений; нет — слой не рисует вовсе (headless-дамп, RDBG-2). */
  readonly scene?: THREE.Scene;
  /** Визуальная поверхность (REND-9): на неё ложатся окружности, диски и полигоны. */
  readonly surface?: VisualSurfaceSource;
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
      (geometry) =>
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }),
        ),
    );
    this.points = carrier(
      (geometry) =>
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({
            vertexColors: true,
            size: 6,
            sizeAttenuation: false,
            depthTest: false,
            depthWrite: false,
          }),
        ),
    );
    this.triangles = carrier(
      (geometry) =>
        new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        ),
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
      plane.geometry.dispose();
      plane.material.dispose();
      plane.texture.dispose();
      this.rasters.delete(id);
    }
    this.syncAttachment();
  }

  /** Полностью снимает наложения: выключение убирает их из кадра целиком (RDBG-4). */
  clear(): void {
    this.begin();
    this.commit();
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

  circle(x: number, y: number, radius: number, color: DebugColor): void {
    let px = 0;
    let py = 0;
    for (let i = 0; i <= CIRCLE_SEGMENTS; i += 1) {
      const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const qx = x + Math.cos(angle) * radius;
      const qy = y + Math.sin(angle) * radius;
      if (i > 0) {
        this.lines.buffer.push(px, py, this.heightAt(px, py), color);
        this.lines.buffer.push(qx, qy, this.heightAt(qx, qy), color);
      }
      px = qx;
      py = qy;
    }
  }

  disc(x: number, y: number, radius: number, color: DebugColor): void {
    for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const b = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
      const ax = x + Math.cos(a) * radius;
      const ay = y + Math.sin(a) * radius;
      const bx = x + Math.cos(b) * radius;
      const by = y + Math.sin(b) * radius;
      this.triangles.buffer.push(x, y, this.heightAt(x, y), color);
      this.triangles.buffer.push(ax, ay, this.heightAt(ax, ay), color);
      this.triangles.buffer.push(bx, by, this.heightAt(bx, by), color);
    }
  }

  polygon(points: readonly number[], color: DebugColor): void {
    const count = Math.floor(points.length / 2);
    if (count < 3) return;
    const ax = points[0]!;
    const ay = points[1]!;
    for (let i = 1; i + 1 < count; i += 1) {
      const bx = points[i * 2]!;
      const by = points[i * 2 + 1]!;
      const cx = points[(i + 1) * 2]!;
      const cy = points[(i + 1) * 2 + 1]!;
      this.triangles.buffer.push(ax, ay, this.heightAt(ax, ay), color);
      this.triangles.buffer.push(bx, by, this.heightAt(bx, by), color);
      this.triangles.buffer.push(cx, cy, this.heightAt(cx, cy), color);
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
      existing.geometry.dispose();
      existing.material.dispose();
      existing.texture.dispose();
    }
    // Одноканальный растр: цвет плашки задаёт источник, яркость — сам тексель.
    const texels = new Uint8Array(raster.widthTexels * raster.heightTexels);
    const texture = new THREE.DataTexture(
      texels,
      raster.widthTexels,
      raster.heightTexels,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.unpackAlignment = 1;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `render-debug:${id}`;
    const plane: RasterPlane = {
      mesh,
      texture,
      texels,
      material,
      geometry,
      widthTexels: raster.widthTexels,
      heightTexels: raster.heightTexels,
      used: true,
    };
    this.group.add(mesh);
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

function carrier(build: (geometry: THREE.BufferGeometry) => THREE.Object3D): Carrier {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(INITIAL_VERTICES * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(INITIAL_VERTICES * 3), 3));
  const object = build(geometry);
  object.frustumCulled = false;
  object.renderOrder = 3;
  return { buffer: new VertexBuffer(), geometry, object, capacity: INITIAL_VERTICES };
}

/**
 * Атрибуты носителя из буфера. Пока ёмкость достаточна — одна запись в
 * существующий массив и сдвиг диапазона отрисовки; переросший буфер заводит
 * атрибуты заново, и это редкость, а не кадровая работа.
 */
function upload(one: Carrier): void {
  const buffer = one.buffer;
  if (buffer.count > one.capacity) {
    one.capacity = buffer.positions.length / 3;
    one.geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3));
    one.geometry.setAttribute('color', new THREE.BufferAttribute(buffer.colors, 3));
  } else {
    const position = one.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = one.geometry.getAttribute('color') as THREE.BufferAttribute;
    (position.array as Float32Array).set(buffer.positions.subarray(0, buffer.count * 3));
    (color.array as Float32Array).set(buffer.colors.subarray(0, buffer.count * 3));
    position.needsUpdate = true;
    color.needsUpdate = true;
  }
  one.geometry.setDrawRange(0, buffer.count);
  one.object.visible = buffer.count > 0;
}
