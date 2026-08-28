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
import type { TickView } from '../types.js';
import type { WaterBodyConfig } from './config.js';
import {
  depthTexelRect,
  fillWaterDepth,
  waterDepthLayout,
  type WaterDepthLayout,
  type WaterFieldSampler,
} from './depth.js';
import { createWaterMaterial, type WaterMaterialInput } from './material.js';
import { waterGeometryOf, type WaterRegion } from './region.js';
import { WaterRippleField, type WaterRippleOptions } from './ripples.js';
import { uniformOf } from '../uniforms.js';

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

  constructor(options: WaterBodyOptions) {
    this.options = options;
    const { region, config, tile, heightStep } = options;
    const surfaceHeight = config.surfaceLevel * heightStep;
    this.layout = waterDepthLayout(region, tile, options.limits.depthTexelsPerCell);
    this.data = new Uint16Array(Math.max(1, this.layout.width * this.layout.height));
    this.texture = new THREE.DataTexture(
      this.data,
      Math.max(1, this.layout.width),
      Math.max(1, this.layout.height),
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    // Билинейная выборка — то, чем берег остаётся линией поля, а не лесенкой
    // текселей; зажим по краям: за покрытием воды нет по построению.
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;

    this.geometry = new THREE.BufferGeometry();
    const data = waterGeometryOf(region.rects, tile, surfaceHeight);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

    this.rippleUniform = new Float32Array(4 * Math.max(1, options.limits.rippleSources));
    this.material = createWaterMaterial(this.materialInput());
    uniformOf(this.material, 'uRipples').value = this.rippleUniform;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `water:body:${region.body}`;
    this.mesh.renderOrder = WATER_RENDER_ORDER;
    this.rippleOptions = {
      limit: options.limits.rippleSources,
      minSpeed: config.ripples.minSpeed,
      amplitude: config.ripples.amplitude,
      // Период кольца — он же время затухания: возраст источника ходит по этому
      // кругу, поэтому число обязано быть тем же, что уехало в униформу волны
      // (`applyWaterUniforms`), иначе кольцо гасло бы не там, где кончается.
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
   */
  flush(field: WaterFieldSampler): number {
    if (this.dirty.x1 < this.dirty.x0 || this.layout.width === 0) return 0;
    const rect = depthTexelRect(this.layout, this.dirty.x0, this.dirty.y0, this.dirty.x1, this.dirty.y1);
    const surfaceHeight = this.options.config.surfaceLevel * this.options.heightStep;
    const texels = fillWaterDepth(
      this.data,
      this.layout,
      field,
      surfaceHeight,
      rect.tx0,
      rect.ty0,
      rect.tx1,
      rect.ty1,
    );
    this.dirty = { x0: 0, y0: 0, x1: -1, y1: -1 };
    if (texels > 0) this.texture.needsUpdate = true;
    return texels;
  }

  /**
   * Кадр тела (REND-2, REND-25): часы презентации в униформу и пересчёт
   * источников ряби от доставленного состояния. Возвращает число действующих
   * источников — счётчик стоимости кадра (PERF-3).
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
