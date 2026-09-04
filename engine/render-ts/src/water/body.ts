/**
 * Одно тело воды в кадре (`rendering` REND-35): меш на урезе, глубинная
 * текстура региона, материал и кольца ряби (REND-36). Владелец всего этого —
 * подсистема воды (`subsystems/water.ts`); здесь собрано то, что у тела своё,
 * чтобы подсистема осталась про список тел, а не про их устройство.
 *
 * Инвалидация точечная: правка кривизны, walkable-вклад, догрузка карты
 * кривизны и переподача сетки террейна (REND-14) метят ПРЯМОУГОЛЬНИК КЛЕТОК, а
 * перезаполняется он не позже следующего кадра (REND-35) — тем же каденсом, что
 * пересборка чанков террейна (REND-7, ED-15).
 */
import * as THREE from 'three';
import { UNLIMITED_FRAME_BUDGET, type FrameBudget, type TickView } from '../types.js';
import type { WaterBodyConfig } from './config.js';
import {
  depthTexelRect,
  fillWaterDepth,
  waterDepthLayout,
  type WaterDepthCells,
  type WaterDepthLayout,
  type WaterFieldSampler,
  type WaterTexelRect,
} from './depth.js';
import { createWaterMaterial, type WaterMaterialInput } from './material.js';
import { waterGeometryOf, type WaterRegion } from './region.js';
import { WaterRippleField, type WaterRippleOptions } from './ripples.js';
import { uniformOf } from '../uniforms.js';
import { own } from '../footprint.js';

/**
 * Место воды среди прозрачных (design D6): ниже частиц и превью каста, поэтому
 * они рисуются ПОВЕРХ неё. Отдельного прохода вода не заводит — маска тумана
 * остаётся финальным проходом кадра (REND-34, FOW-7).
 */
export const WATER_RENDER_ORDER = -1;

/** Действующие потолки пресета для тела — уже применённые минимумы (QUAL-1). */
export interface WaterBodyLimits {
  readonly rippleSources: number;
  readonly detailLayers: number;
  readonly depthTexelsPerCell: number;
}

export interface WaterBodyOptions {
  readonly region: WaterRegion;
  readonly config: WaterBodyConfig;
  readonly limits: WaterBodyLimits;
  /** Сторона клетки в мировых единицах (точка приёма fixed-point — у вызывающего). */
  readonly tile: number;
  readonly heightStep: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** Загруженные текстуры детали (ASSET-2); отсутствие — procedural (REND-35). */
  readonly detailNormal?: THREE.Texture | null;
  readonly detailFoam?: THREE.Texture | null;
  readonly detailFlow?: THREE.Texture | null;
}

export class WaterBodyView {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly texture: THREE.DataTexture;
  private readonly layout: WaterDepthLayout;
  private readonly data: Uint16Array;
  private readonly options: WaterBodyOptions;
  private readonly ripples = new WaterRippleField();
  private readonly rippleUniform: Float32Array;
  private readonly rippleOptions: WaterRippleOptions;
  /** Прямоугольник клеток к перезаполнению; `maxX < minX` — чистое тело. */
  private dirty = { x0: 0, y0: 0, x1: -1, y1: -1 };
  /**
   * Клетки покрытия для заливки: маска тела и ЖИВАЯ карта пола (TERR-6).
   * Запись одна на тело и переиспользуется — карта пола приезжает доставкой и
   * подменяется в ней ссылкой, а кадр перезаполнения не аллоцирует (PERF-3).
   */
  private readonly cells: { -readonly [K in keyof WaterDepthCells]: WaterDepthCells[K] };
  /** Запись опций заливки — одна на тело: перезаполнение не аллоцирует лишнего. */
  private readonly fill: { rect: WaterTexelRect | undefined; cells: WaterDepthCells };

  constructor(options: WaterBodyOptions) {
    this.options = options;
    const { region, config, tile, heightStep } = options;
    this.cells = { mask: region.mask, gridWidth: options.gridWidth, floor: null };
    this.fill = { rect: undefined, cells: this.cells };
    const surfaceHeight = config.surfaceLevel * heightStep;
    this.layout = waterDepthLayout(region, tile, options.limits.depthTexelsPerCell);
    this.data = new Uint16Array(Math.max(1, this.layout.width * this.layout.height));
    this.texture = own(
      'texture',
      'water',
      new THREE.DataTexture(
        this.data,
        Math.max(1, this.layout.width),
        Math.max(1, this.layout.height),
        THREE.RedFormat,
        THREE.HalfFloatType,
      ),
    );
    // Билинейная выборка — то, чем берег остаётся линией поля, а не лесенкой
    // текселей; зажим по краям: за покрытием воды нет по построению.
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    // Ряд текстуры — ширина bbox × плотность текселей по два байта на тексель, и
    // выравнивание рядов у three по умолчанию четыре: при нечётном произведении
    // ряды не выровнены, `texImage2D` отвергает загрузку, текстура остаётся
    // пустой — и КАЖДЫЙ фрагмент воды отбрасывается по `depth <= 0`, молча.
    // Плотность — ручка пресета с минимумом 1 (QUAL-1), так что нечётная
    // ширина достижима данными; единица снимает вопрос целиком.
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this.geometry = own('geometry', 'water', new THREE.BufferGeometry());
    const data = waterGeometryOf(region.rects, tile, surfaceHeight);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

    this.rippleUniform = new Float32Array(4 * Math.max(1, options.limits.rippleSources));
    this.material = createWaterMaterial(this.materialInput());
    uniformOf(this.material, 'uRipples').value = this.rippleUniform;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `water:body:${region.body}`;
    this.mesh.renderOrder = WATER_RENDER_ORDER;
    // Вода — приёмник теней (REND-30): материал читает теневые карты сцены, а
    // рендерер отдаёт ему признак приёма отдельным униформом — без флага он
    // остался бы `false`, и река под тенью плато светилась бы как на солнце.
    // Кастером вода не становится: плоскость на урезе тени не отбрасывает.
    this.mesh.receiveShadow = true;
    this.rippleOptions = {
      limit: options.limits.rippleSources,
      minSpeed: config.ripples.minSpeed,
      amplitude: config.ripples.amplitude,
      // Время жизни кольца — оно же задаёт каденс излучения (`ripples.ts`),
      // поэтому число обязано быть тем же, что уехало в униформу волны
      // (`applyWaterUniforms`): иначе отбор снимал бы кольцо не тогда, когда
      // шейдер довёл его затухание до нуля.
      decaySeconds: config.ripples.decaySeconds,
      tile,
      nearWater: (cellX, cellY) => this.nearWater(cellX, cellY),
      centerX: ((region.minX + region.maxX + 1) / 2) * tile,
      centerY: ((region.minY + region.maxY + 1) / 2) * tile,
    };
    this.markAll();
  }

  /** Квадов в меше тела — счётная величина стоимости кадра (PERF-3). */
  get quads(): number {
    return this.options.region.rects.length;
  }

  /** Вся глубинная текстура устарела: сменилась поверхность целиком (REND-9). */
  markAll(): void {
    this.dirty = {
      x0: this.options.region.minX,
      y0: this.options.region.minY,
      x1: this.options.region.maxX,
      y1: this.options.region.maxY,
    };
  }

  /**
   * Клетка затронута правкой поля (REND-14, REND-9). Копится ОХВАТЫВАЮЩИЙ
   * прямоугольник: мазок кисти локален, а разбросанный набор в пределе
   * вырождается в перезаполнение всей текстуры — ровно то, что делалось бы и
   * без него (тот же приём, что у источника поверхности).
   */
  markCell(cellX: number, cellY: number): void {
    if (this.options.region.mask[cellY * this.options.gridWidth + cellX] !== 1) return;
    if (this.dirty.x1 < this.dirty.x0) {
      this.dirty = { x0: cellX, y0: cellY, x1: cellX, y1: cellY };
      return;
    }
    this.dirty = {
      x0: Math.min(this.dirty.x0, cellX),
      y0: Math.min(this.dirty.y0, cellY),
      x1: Math.max(this.dirty.x1, cellX),
      y1: Math.max(this.dirty.y1, cellY),
    };
  }

  /**
   * Перезаполнение помеченного прямоугольника — не позже следующего кадра
   * (REND-35). Возвращает число заполненных текселей: счётная величина
   * стоимости, а не диагностика (PERF-3).
   *
   * `floor` — живая карта пола владельца (TERR-6): под выбитой клеткой тела
   * глубина не положительна, и вода там не рисуется (REND-35). `null` — пол
   * считается везде.
   */
  flush(
    field: WaterFieldSampler,
    floor: Uint8Array | null = null,
    budget: FrameBudget = UNLIMITED_FRAME_BUDGET,
  ): number {
    if (this.dirty.x1 < this.dirty.x0 || this.layout.width === 0) return 0;
    const surfaceHeight = this.options.config.surfaceLevel * this.options.heightStep;
    this.cells.floor = floor;
    if (budget.unlimited) {
      this.fill.rect = depthTexelRect(this.layout, this.dirty.x0, this.dirty.y0, this.dirty.x1, this.dirty.y1);
      const texels = fillWaterDepth(this.data, this.layout, field, surfaceHeight, this.fill);
      this.dirty = { x0: 0, y0: 0, x1: -1, y1: -1 };
      if (texels > 0) this.texture.needsUpdate = true;
      return texels;
    }
    // Под бюджетом (REND-44, design D9) прямоугольник режется ПОЛОСАМИ клеток
    // сверху: заполненные ряды уходят, остаток остаётся прямоугольником — и
    // состояния сверх уже существующего не заводится. Тексель заполняется ровно
    // один раз, поэтому сумма `waterDepthTexels` за прогон от нарезки не
    // меняется (PERF-3).
    let texels = 0;
    let row = this.dirty.y0;
    while (row <= this.dirty.y1 && budget.hasTime()) {
      this.fill.rect = depthTexelRect(this.layout, this.dirty.x0, row, this.dirty.x1, row);
      texels += fillWaterDepth(this.data, this.layout, field, surfaceHeight, this.fill);
      row++;
    }
    this.dirty =
      row > this.dirty.y1
        ? { x0: 0, y0: 0, x1: -1, y1: -1 }
        : { x0: this.dirty.x0, y0: row, x1: this.dirty.x1, y1: this.dirty.y1 };
    // Текстура уезжает целиком (`needsUpdate`), но НАБЛЮДАЕМО это не полурастр:
    // незаполненные ряды несут глубину предыдущего кадра, а не мусор, — то же
    // отличие «когда», которое REND-44 и разрешает.
    if (texels > 0) this.texture.needsUpdate = true;
    return texels;
  }

  /**
   * Есть ли что перезаполнять (REND-44): им подсистема решает, звать ли выборку
   * поля и осталась ли работа после прохода под бюджетом.
   *
   * Метод, а не геттер, намеренно: значение меняется вызовом `flush` в том же
   * блоке кода, а сужение типа у геттера пережило бы этот вызов и сделало бы
   * проверку «осталось ли» заведомо ложной для компилятора.
   */
  needsRefill(): boolean {
    return this.dirty.x1 >= this.dirty.x0 && this.layout.width > 0;
  }

  /**
   * Кадр тела (REND-2, REND-25): часы презентации в униформу, живые кольца
   * ряби стареют, а движущиеся в воде сущности роняют новые — каждое там, где
   * сущность была в момент излучения (REND-36). Возвращает число живых колец —
   * счётчик стоимости кадра (PERF-3).
   */
  updateFrame(clock: number, view: TickView | null, alpha: number, dt: number): number {
    uniformOf(this.material, 'uTime').value = clock;
    if (this.rippleOptions.limit <= 0) return 0;
    this.ripples.update(view, alpha, dt, this.rippleOptions);
    return this.ripples.writeUniform(this.rippleUniform, this.rippleOptions.limit);
  }

  /** Разрыв непрерывности мира (REND-2): накопленные кольца сбрасываются. */
  resetRipples(): void {
    this.ripples.reset();
  }

  /**
   * Снос тела (REND-31): геометрия, материал и глубинная текстура. Сцена телу
   * не принадлежит — снимает его со сцены владелец списка.
   */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  /** Клетка тела либо кольцо в одну клетку вокруг — область источников ряби. */
  private nearWater(cellX: number, cellY: number): boolean {
    const { gridWidth, gridHeight, region } = this.options;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cellX + dx;
        const y = cellY + dy;
        if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) continue;
        if (region.mask[y * gridWidth + x] === 1) return true;
      }
    }
    return false;
  }

  private materialInput(): WaterMaterialInput {
    return {
      body: this.options.config,
      heightStep: this.options.heightStep,
      layers: this.options.limits.detailLayers,
      rippleSources: this.options.limits.rippleSources,
      depth: this.texture,
      depthRect: new THREE.Vector4(
        this.layout.originX,
        this.layout.originY,
        Math.max(this.layout.sizeX, 1e-4),
        Math.max(this.layout.sizeY, 1e-4),
      ),
      detailNormal: this.options.detailNormal ?? null,
      detailFoam: this.options.detailFoam ?? null,
      detailFlow: this.options.detailFlow ?? null,
    };
  }
}
