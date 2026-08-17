/**
 * Батч инстансов одной модели (REND-20, design D1/D7): `InstancedMesh` на
 * (модель × уровень LOD × часть), пер-инстансные атрибуты вместо пер-инстансных
 * скелетов и материалов.
 *
 * Батч НЕ ЗНАЕТ ни о presentation-состоянии, ни о манифесте: снаружи ему дают
 * матрицу записи, пару строк VAT с весом, индекс скина, видимость и уровень —
 * а он держит их в преаллоцированных буферах и раскладывает по инстанс-меша́м.
 * Так подсистема моделей остаётся единственным местом, где живёт политика, а
 * здесь — только раскладка.
 *
 * ## Компактация (REND-21)
 *
 * У батча один меш на часть, и three отсекает его целиком либо никак — значит
 * отсечение делается САМИМ батчем: видимые записи компактируются в начало
 * инстанс-буферов, `count` меша равен их числу. Аллокаций на кадр здесь нет —
 * буферы преаллоцированы по ёмкости, а компактация это копирование из слота в
 * слот.
 *
 * ## Видимость частей (ASSET-12)
 *
 * То, что у детального яруса делает трек видимости (`part<id>.visible`), у
 * батчевой записи делает маска кадра: часть, погашенная в текущем кадре записи,
 * в компактацию своего меша не попадает. Если маска модели не гасит НИЧЕГО
 * (обычный случай), порядок компактации у всех частей уровня совпадает — и они
 * делят один набор буферов, вместо того чтобы платить копированием за каждую.
 *
 * ## Рост ёмкости
 *
 * Ёмкость удваивается, ЖИВЫЕ ЗАПИСИ при этом не пересоздаются: меняются только
 * буферы, а слот записи, её поза, фаза и скин переезжают как есть (REND-22
 * требует того же от переключения уровня — состояние записи её представление
 * переживает).
 */
import * as THREE from 'three';
import type { BakedPartVisibility, NormalizedMesh } from '@game-mvp/assets';
import { geometryFromMesh, type SharedMeshData } from './build.js';
import type { VatMaterial } from './vatMaterial.js';

/** Начальная ёмкость батча: меньше — и первая же группа юнитов её удвоит. */
const INITIAL_CAPACITY = 32;
/** Чисел в инстанс-матрице. */
const MATRIX_STRIDE = 16;
/** Чисел в атрибуте позы: строка A, строка B, вес B, слой скина. */
const POSE_STRIDE = 4;

/** Часть уровня: `InstancedMesh` плюс бит части в маске видимости (ASSET-12). */
interface BatchPart {
  readonly mesh: THREE.InstancedMesh;
  readonly buffers: BatchBuffers;
  /** Бит части в маске кадра; -1 — часть треков видимости не имеет. */
  readonly bit: number;
}

/**
 * Диапазон заливки атрибута — в той форме, в какой его держит `updateRanges`
 * three. Своя запись, потому что она ПЕРЕИСПОЛЬЗУЕТСЯ (см. `BatchBuffers`).
 */
interface UpdateRange {
  start: number;
  count: number;
}

/** Инстанс-буферы: матрицы и позы видимых записей подряд. */
interface BatchBuffers {
  matrix: THREE.InstancedBufferAttribute;
  pose: THREE.InstancedBufferAttribute;
  count: number;
  /**
   * Диапазоны заливки — по одной долгоживущей записи на атрибут.
   * `addUpdateRange` three кладёт в `updateRanges` НОВЫЙ объект на каждый
   * вызов, то есть по два объекта на набор буферов каждого уровня каждый кадр:
   * мусор, растущий с числом батчей, а значит с объёмом контента. Диапазон же
   * тут всегда один и по смыслу тот же — начало буфера и `count` записей.
   */
  readonly matrixRange: UpdateRange;
  readonly poseRange: UpdateRange;
}

interface BatchLevel {
  readonly parts: readonly BatchPart[];
  /** Уникальные наборы буферов уровня: один общий либо по одному на часть. */
  readonly buffers: readonly BatchBuffers[];
}

/** Часть модели в форме, из которой батч строит уровень. */
export interface BatchPartSource {
  readonly geometry: THREE.BufferGeometry;
  readonly partId: number;
  readonly materialIndex: number;
}

export interface ModelBatchOptions {
  /** Материалы батча по индексу материала модели (`vatMaterial.ts`). */
  readonly materials: readonly VatMaterial[];
  /** Маска видимости частей по кадрам (ASSET-12). */
  readonly partVisibility: BakedPartVisibility;
  /** Уровень 0 — части самой модели; дальше — уровни цепочки (REND-22). */
  readonly levels: readonly (readonly BatchPartSource[])[];
}

export class ModelBatch {
  /** Корень батча в сцене: все инстанс-меши всех уровней под ним. */
  readonly group = new THREE.Group();

  private readonly materials: readonly VatMaterial[];
  private readonly partVisibility: BakedPartVisibility;
  private readonly levelSources: readonly (readonly BatchPartSource[])[];
  /**
   * Маска не гасит ничего: компактация одна на уровень. Считается один раз по
   * запечённым данным — про кадр знать для этого не нужно.
   */
  private readonly uniformVisibility: boolean;

  private levels: BatchLevel[] = [];
  private capacity = 0;
  /** Верхняя граница занятых слотов: обход идёт по ней, а не по ёмкости. */
  private used = 0;
  private live = 0;
  private readonly free: number[] = [];

  private occupied = new Uint8Array(0);
  private visibleFlags = new Uint8Array(0);
  private frames = new Int32Array(0);
  private slotLevels = new Uint8Array(0);
  private matrices = new Float32Array(0);
  private poses = new Float32Array(0);

  constructor(options: ModelBatchOptions) {
    this.materials = options.materials;
    this.partVisibility = options.partVisibility;
    this.levelSources = options.levels;
    this.uniformVisibility = maskHidesNothing(options.partVisibility);
    this.grow(INITIAL_CAPACITY);
  }

  /** Сколько уровней у батча; 1 — модель без цепочки (REND-22). */
  get levelCount(): number {
    return this.levels.length;
  }

  /** Записей в батче — независимо от видимости (REND-21). */
  get count(): number {
    return this.live;
  }

  /** Все инстанс-меши батча: вход диагностики draw calls и тестов. */
  get meshes(): readonly THREE.InstancedMesh[] {
    return this.levels.flatMap((level) => level.parts.map((part) => part.mesh));
  }

  /** Сколько инстанс-мешей нарисуется в этом кадре (draw calls батча). */
  get drawnMeshes(): number {
    let drawn = 0;
    for (const level of this.levels) {
      for (const part of level.parts) if (part.mesh.count > 0) drawn += 1;
    }
    return drawn;
  }

  /** Свободный слот записи; ёмкость растёт сама и живых записей не трогает. */
  acquire(): number {
    const slot = this.free.pop() ?? this.used++;
    if (slot >= this.capacity) this.grow(this.capacity * 2);
    this.occupied[slot] = 1;
    this.visibleFlags[slot] = 1;
    this.frames[slot] = 0;
    this.slotLevels[slot] = 0;
    this.live += 1;
    return slot;
  }

  release(slot: number): void {
    if (this.occupied[slot] !== 1) return;
    this.occupied[slot] = 0;
    this.visibleFlags[slot] = 0;
    this.free.push(slot);
    this.live -= 1;
  }

  setMatrix(slot: number, matrix: THREE.Matrix4): void {
    this.matrices.set(matrix.elements, slot * MATRIX_STRIDE);
  }

  /** Поза записи: две строки VAT, вес второй и слой скина (REND-4, REND-6). */
  setPose(slot: number, rowA: number, rowB: number, blend: number, skin: number): void {
    const base = slot * POSE_STRIDE;
    this.poses[base] = rowA;
    this.poses[base + 1] = rowB;
    this.poses[base + 2] = blend;
    this.poses[base + 3] = skin;
  }

  setSkin(slot: number, skin: number): void {
    this.poses[slot * POSE_STRIDE + 3] = skin;
  }

  setVisible(slot: number, visible: boolean): void {
    this.visibleFlags[slot] = visible ? 1 : 0;
  }

  /** Кадр записи — по нему читается маска видимости частей (ASSET-12). */
  setFrame(slot: number, frame: number): void {
    this.frames[slot] = frame;
  }

  /** Уровень детализации записи (REND-22); вне цепочки — грубейший имеющийся. */
  setLevel(slot: number, level: number): void {
    this.slotLevels[slot] = Math.max(0, Math.min(this.levels.length - 1, level));
  }

  levelOf(slot: number): number {
    return this.slotLevels[slot] ?? 0;
  }

  /**
   * Компактация видимых записей в начало инстанс-буферов и `count` мешей
   * (REND-21). Единственная покадровая работа батча — и она копирование, а не
   * аллокация.
   */
  flush(): void {
    for (let level = 0; level < this.levels.length; level++) {
      const entry = this.levels[level]!;
      for (const buffers of entry.buffers) buffers.count = 0;
      if (this.uniformVisibility) this.compactShared(entry, level);
      else this.compactPerPart(entry, level);
      // На GPU уезжает РОВНО скомпактованный кусок буфера, а не весь атрибут по
      // ёмкости батча: хвост за `count` — прошлый кадр, и заливать его нечем.
      for (const buffers of entry.buffers) {
        setUpdateRange(buffers.matrix, buffers.matrixRange, buffers.count * MATRIX_STRIDE);
        setUpdateRange(buffers.pose, buffers.poseRange, buffers.count * POSE_STRIDE);
      }
    }
  }

  /** Маска не гасит ничего: порядок у частей уровня общий, и буфер один. */
  private compactShared(entry: BatchLevel, level: number): void {
    const buffers = entry.buffers[0];
    if (buffers === undefined) return;
    for (let slot = 0; slot < this.used; slot++) {
      if (this.drawn(slot, level)) this.writeInto(buffers, slot);
    }
    for (const part of entry.parts) part.mesh.count = buffers.count;
  }

  /** У части свой набор записей: маска кадра гасит её отдельно от соседей. */
  private compactPerPart(entry: BatchLevel, level: number): void {
    for (let slot = 0; slot < this.used; slot++) {
      if (!this.drawn(slot, level)) continue;
      const frame = this.frames[slot]!;
      for (const part of entry.parts) {
        if (part.bit < 0 || this.partVisible(frame, part.bit)) this.writeInto(part.buffers, slot);
      }
    }
    for (const part of entry.parts) part.mesh.count = part.buffers.count;
  }

  /**
   * Снимает батч со сцены. Разделяемые буферы геометрии модели при этом НЕ
   * освобождаются: они принадлежат ассету (REND-3), и `dispose` геометрии
   * погасил бы их у детального яруса — поэтому чужие атрибуты снимаются с
   * геометрии до её освобождения.
   */
  dispose(): void {
    this.group.removeFromParent();
    for (const level of this.levels) {
      for (const part of level.parts) {
        const geometry = part.mesh.geometry;
        for (const name of Object.keys(geometry.attributes)) {
          if (name !== 'instancePose') geometry.deleteAttribute(name);
        }
        geometry.setIndex(null);
        geometry.dispose();
      }
    }
    for (const material of this.materials) material.material.dispose();
    this.levels = [];
  }

  // ------------------------------------------------------------ внутреннее

  private drawn(slot: number, level: number): boolean {
    return (
      this.occupied[slot] === 1 && this.visibleFlags[slot] === 1 && this.slotLevels[slot] === level
    );
  }

  private partVisible(frame: number, bit: number): boolean {
    const { wordsPerFrame, mask } = this.partVisibility;
    const word = mask[frame * wordsPerFrame + (bit >> 5)] ?? 0xffffffff;
    return ((word >>> (bit & 31)) & 1) === 1;
  }

  /**
   * Запись слота в конец инстанс-буферов. Копирование поэлементное, а не через
   * `subarray`: `subarray` создаёт новый объект TypedArray НА КАЖДЫЙ вызов, то
   * есть на каждую видимую запись каждого кадра, — и компактация, которой
   * аллокаций иметь не положено (design D7), платила бы мусором ровно по числу
   * инстансов. Длины здесь константы, и цикл разворачивается сам.
   */
  private writeInto(buffers: BatchBuffers, slot: number): void {
    const index = buffers.count++;
    const matrix = buffers.matrix.array as Float32Array;
    const matrixFrom = slot * MATRIX_STRIDE;
    const matrixTo = index * MATRIX_STRIDE;
    for (let k = 0; k < MATRIX_STRIDE; k++) matrix[matrixTo + k] = this.matrices[matrixFrom + k]!;
    const pose = buffers.pose.array as Float32Array;
    const poseFrom = slot * POSE_STRIDE;
    const poseTo = index * POSE_STRIDE;
    for (let k = 0; k < POSE_STRIDE; k++) pose[poseTo + k] = this.poses[poseFrom + k]!;
  }

  /**
   * Новая ёмкость: слотовые массивы и инстанс-буферы переезжают, слоты и их
   * содержимое сохраняются. Меши остаются те же — им подменяются атрибуты.
   */
  private grow(capacity: number): void {
    const next = Math.max(INITIAL_CAPACITY, capacity);
    this.occupied = copyInto(new Uint8Array(next), this.occupied);
    this.visibleFlags = copyInto(new Uint8Array(next), this.visibleFlags);
    this.frames = copyInto(new Int32Array(next), this.frames);
    this.slotLevels = copyInto(new Uint8Array(next), this.slotLevels);
    this.matrices = copyInto(new Float32Array(next * MATRIX_STRIDE), this.matrices);
    this.poses = copyInto(new Float32Array(next * POSE_STRIDE), this.poses);
    this.capacity = next;

    if (this.levels.length === 0) this.levels = this.buildLevels(next);
    else for (const level of this.levels) this.regrowLevel(level, next);
  }

  private buildLevels(capacity: number): BatchLevel[] {
    return this.levelSources.map((parts) => {
      const shared = this.uniformVisibility ? makeBuffers(capacity) : null;
      const buffers: BatchBuffers[] = shared === null ? [] : [shared];
      const built = parts.map((source) => {
        const own = shared ?? makeBuffers(capacity);
        if (shared === null) buffers.push(own);
        return this.buildPart(source, own, capacity);
      });
      return { parts: built, buffers };
    });
  }

  private buildPart(
    source: BatchPartSource,
    buffers: BatchBuffers,
    capacity: number,
  ): BatchPart {
    const geometry = new THREE.BufferGeometry();
    // Буферы вершин РАЗДЕЛЯЮТСЯ с геометрией ассета (REND-3): батчу нужна своя
    // геометрия только ради инстанс-атрибута, а не ради копии вершин.
    for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
      geometry.setAttribute(name, attribute);
    }
    const index = source.geometry.getIndex();
    if (index !== null) geometry.setIndex(index);
    geometry.setAttribute('instancePose', buffers.pose);

    const material = this.materials[source.materialIndex] ?? this.materials[0];
    const mesh = new THREE.InstancedMesh(
      geometry,
      material?.material ?? new THREE.MeshStandardMaterial(),
      capacity,
    );
    mesh.instanceMatrix = buffers.matrix;
    mesh.count = 0;
    // Отсечение — наше (REND-21): three отсекал бы батч целиком или никак.
    mesh.frustumCulled = false;
    mesh.name = `batch:part${source.partId}`;
    this.group.add(mesh);
    return { mesh, buffers, bit: this.partVisibility.parts.indexOf(source.partId) };
  }

  private regrowLevel(level: BatchLevel, capacity: number): void {
    for (const buffers of level.buffers) {
      buffers.matrix = growAttribute(buffers.matrix, capacity, MATRIX_STRIDE);
      buffers.pose = growAttribute(buffers.pose, capacity, POSE_STRIDE);
    }
    for (const part of level.parts) {
      part.mesh.instanceMatrix = part.buffers.matrix;
      part.mesh.geometry.setAttribute('instancePose', part.buffers.pose);
    }
  }
}

/** Уровни батча из разделяемых данных ассета и цепочки LOD (REND-22). */
export function batchLevels(
  meshes: readonly SharedMeshData[],
  lod: readonly { readonly meshes: readonly NormalizedMesh[] }[],
  hiddenParts: readonly number[] | undefined,
): BatchPartSource[][] {
  const hidden = new Set(hiddenParts ?? []);
  const base = meshes.filter((mesh) => !hidden.has(mesh.partId));
  const levels: BatchPartSource[][] = [base.map((mesh) => ({ ...mesh }))];
  for (const level of lod) {
    const parts = level.meshes
      .filter((mesh) => !hidden.has(mesh.partId))
      .map((mesh) => ({
        geometry: geometryFromMesh(mesh),
        partId: mesh.partId,
        materialIndex: mesh.materialIndex,
      }));
    // Пустой уровень цепочки в батч не берётся: рисовать им нечего, а слот
    // уровня сдвинул бы пороги записи (ASSET-13).
    if (parts.length > 0) levels.push(parts);
  }
  return levels;
}

function makeBuffers(capacity: number): BatchBuffers {
  return {
    matrix: dynamicAttribute(capacity, MATRIX_STRIDE),
    pose: dynamicAttribute(capacity, POSE_STRIDE),
    count: 0,
    matrixRange: { start: 0, count: 0 },
    poseRange: { start: 0, count: 0 },
  };
}

/**
 * Единственный диапазон заливки атрибута — переиспользуемой записью. Ровно то
 * же, что пара `clearUpdateRanges()` + `addUpdateRange(0, count)`, но без
 * объекта на каждый кадр (см. `BatchBuffers.matrixRange`): `updateRanges` —
 * обычный массив, и очистка с записью одной записи в него делаются здесь.
 */
function setUpdateRange(
  attribute: THREE.InstancedBufferAttribute,
  range: UpdateRange,
  count: number,
): void {
  range.start = 0;
  range.count = count;
  const ranges = attribute.updateRanges;
  ranges.length = 0;
  ranges.push(range);
  attribute.needsUpdate = true;
}

/** Инстанс-атрибут кадровой записи: содержимое меняется каждый кадр. */
function dynamicAttribute(capacity: number, stride: number): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * stride),
    stride,
  );
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function growAttribute(
  attribute: THREE.InstancedBufferAttribute,
  capacity: number,
  stride: number,
): THREE.InstancedBufferAttribute {
  const next = dynamicAttribute(capacity, stride);
  (next.array as Float32Array).set(attribute.array);
  next.needsUpdate = true;
  return next;
}

function copyInto<T extends { set(source: never, offset?: number): void }>(next: T, previous: T): T {
  (next.set as (source: T, offset?: number) => void)(previous, 0);
  return next;
}

/**
 * Маска не гасит ни одной части ни в одном кадре. Тогда компактация одна на
 * уровень, и части делят буферы — обычный случай, за который платить копией на
 * часть было бы не за что.
 */
function maskHidesNothing(visibility: BakedPartVisibility): boolean {
  const bits = visibility.parts.length;
  if (bits === 0) return true;
  const { wordsPerFrame, mask } = visibility;
  const frames = wordsPerFrame === 0 ? 0 : mask.length / wordsPerFrame;
  for (let frame = 0; frame < frames; frame++) {
    for (let bit = 0; bit < bits; bit++) {
      const word = mask[frame * wordsPerFrame + (bit >> 5)] ?? 0;
      if (((word >>> (bit & 31)) & 1) === 0) return false;
    }
  }
  return true;
}
