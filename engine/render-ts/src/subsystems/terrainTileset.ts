/**
 * Текстурирование поверхности террейна (`rendering` REND-39): tileset покрытий
 * из манифеста визуалов (ASSET-6), карта раскраски клеток (ASSET-15) и
 * материал, смешивающий слоты по весам вершин. Владелец — подсистема террейна
 * (`subsystems/terrain.ts`); здесь собрано то, что у текстурирования своё, чтобы
 * подсистема осталась про чанки и сетку.
 *
 * ## Слот — данные, смешивание — картинка
 *
 * В документе раскраски ОДИН слот на клетку (design D1): весов там нет. Веса
 * считает генератор геометрии в вершинах (`terrainGeometry.ts`), а фрагмент их
 * интерполирует — отсюда мягкий шов шириной в клетку на границе двух покрытий и
 * сплошная заливка внутри однородной области.
 *
 * ## Материал — стандартный, подменён только цвет
 *
 * Пол остаётся `MeshStandardMaterial` с `onBeforeCompile`: свет, тени (REND-30),
 * туман и порядок проходов кадра (REND-34) остаются механизмом three, а
 * подменяется ровно `diffuseColor`. Своим `ShaderMaterial` пришлось бы учить
 * материал читать теневые карты вручную — цена, уже уплаченная водой, и платить
 * её второй раз незачем.
 *
 * Стенки обрывов и юбка кроются ОТДЕЛЬНОЙ записью tileset'а обычной картой
 * материала с UV-проекцией вдоль стенки: слоты пола на вертикальной грани не
 * смешиваются — у неё нет своей клетки, она стоит на границе двух (design D3).
 */
import * as THREE from 'three';
import type { AssetState, DecodedImage, TerrainPaintMap, TerrainTileset } from '@fluxus/assets';
import type { RenderContext } from '../types.js';
import { textureFromImage } from '../model/skins.js';
import { TERRAIN_PAINT_SLOTS, type TerrainPaintSource } from './terrainPaintWeights.js';

/**
 * Раскладка текстурных координат по мировым координатам вершин: у геометрии
 * террейна своих UV нет — она строится из сетки. `floor` — планарно сверху,
 * период в мировых единицах по обеим осям; `wall` — вдоль стенки (сумма
 * `x + y`: у стенки cliff-отрезка одна из осей постоянна, и на повороте отрезка
 * координата остаётся непрерывной) и по высоте `z`.
 *
 * Полу раскладка больше не нужна: его слоты фрагмент проецирует сам, каждый
 * своим периодом (REND-39). Осталась она у стенок и юбки — там карта одна.
 */
export interface TerrainUvMapping {
  readonly kind: 'floor' | 'wall';
  /** Мировых единиц на период текстуры. */
  readonly period: number;
}

/** UV проекцией мировых координат (см. `TerrainUvMapping`). */
export function projectUv(positions: Float32Array, mapping: TerrainUvMapping): Float32Array {
  const count = positions.length / 3;
  const uv = new Float32Array(count * 2);
  const inv = 1 / Math.max(mapping.period, 1e-6);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (mapping.kind === 'floor') {
      uv[i * 2] = x * inv;
      uv[i * 2 + 1] = y * inv;
    } else {
      uv[i * 2] = (x + y) * inv;
      uv[i * 2 + 1] = z * inv;
    }
  }
  return uv;
}

/** Запрошенная анизотропия текстур покрытий; фактическую зажимает потолок устройства. */
const TILESET_ANISOTROPY = 8;

/** Тон юбки под покрытием стенок: тот же срез породы, но темнее — глубина (REND-7). */
const SKIRT_TINT = 0x8a8a8a;

/** Материалы террейна, которым достаётся текстурирование. */
export interface TerrainTilesetMaterials {
  readonly floor: THREE.MeshStandardMaterial;
  readonly wall: THREE.MeshStandardMaterial;
  readonly skirt: THREE.MeshStandardMaterial;
}

/** Вход текстурирования: авторский tileset и ID производной карты раскраски. */
export interface TerrainTilesetOptions {
  readonly tileset?: TerrainTileset | undefined;
  readonly paintMap?: string | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * Смешиваемых слотов не больше четырёх — это ГРАНИЦА ГЕОМЕТРИИ, а не бюджет: в
 * узле квадратной сетки сходятся до четырёх клеток, и пятого вклада в вес не
 * бывает (REND-39). Слоты сверх этого числа tileset объявлять вправе — их
 * разбирает предупреждение потребителя, а не отказ ассета (ASSET-15).
 */
export const TERRAIN_MAX_SLOTS = TERRAIN_PAINT_SLOTS;

/** Имя атрибута весов слотов в геометрии пола. */
export const TERRAIN_PAINT_ATTRIBUTE = 'aPaint';

/**
 * Заголовок вершинного шейдера пола: веса слотов и мировая позиция вершины.
 * Мировая, а не локальная: координата слота — проекция МИРОВОЙ точки (REND-39),
 * и чанк, сдвинутый в сцене, не должен сдвигать рисунок покрытия.
 */
const FLOOR_VERTEX_HEAD = /* glsl */ `
attribute vec4 aPaint;
varying vec4 vPaint;
varying vec3 vTerrainWorld;
`;

const FLOOR_FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D tSlot0;
uniform sampler2D tSlot1;
uniform sampler2D tSlot2;
uniform sampler2D tSlot3;
uniform vec4 uSlotPeriod;
varying vec4 vPaint;
varying vec3 vTerrainWorld;
`;

/**
 * Смесь слотов вместо карты цвета. Число выборок — `#define TERRAIN_SLOTS`:
 * потолок пресета убирает выборки из ПРОГРАММЫ, а не умножает их на ноль
 * (QUAL-1), поэтому ключ кэша программы обязан нести это число.
 *
 * Веса нормированы генератором, поэтому сумма произведений и есть цвет: делить
 * на сумму в фрагменте незачем.
 */
function floorBlendSource(slots: number): string {
  const terms: string[] = [];
  for (let i = 0; i < slots; i++) {
    const axis = ['x', 'y', 'z', 'w'][i]!;
    terms.push(`  blended += texture2D(tSlot${i}, vTerrainWorld.xy / uSlotPeriod.${axis}).rgb * vPaint.${axis};`);
  }
  return `
  vec3 blended = vec3(0.0);
${terms.join('\n')}
  diffuseColor.rgb *= blended;
`;
}

/**
 * Материал пола под текстурирование: тот же `MeshStandardMaterial`, что и без
 * него, с подменённым `diffuseColor`. Цвет материала остаётся множителем поверх
 * смеси — им подкрашивают арену целиком, не трогая текстуры.
 */
function patchFloorMaterial(
  material: THREE.MeshStandardMaterial,
  slots: number,
  uniforms: Record<string, THREE.IUniform>,
): void {
  material.onBeforeCompile = (shader): void => {
    for (const [name, uniform] of Object.entries(uniforms)) shader.uniforms[name] = uniform;
    shader.vertexShader =
      FLOOR_VERTEX_HEAD +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vPaint = aPaint;\n  vTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    shader.fragmentShader =
      FLOOR_FRAGMENT_HEAD +
      shader.fragmentShader.replace('#include <map_fragment>', floorBlendSource(slots));
  };
  // Две программы с разным числом выборок не должны делить кэш: ключ несёт
  // ровно то, чем тексты отличаются.
  material.customProgramCacheKey = (): string => `terrain-tileset-${slots}`;
  material.needsUpdate = true;
}

/**
 * Текстурирование подсистемы террейна: подписки на текстуры слотов и на карту
 * раскраски, действующее число слотов под потолком пресета и источник слота
 * клетки для генератора геометрии.
 *
 * Сцена без tileset'а либо без карты раскраски не трогает модуль ассетов вовсе
 * и не заводит ни атрибута весов, ни `onBeforeCompile`: кадр остаётся тем же,
 * каким был до текстурирования (REND-39, PERF-2).
 */
export class TerrainTilesetView {
  private readonly options: TerrainTilesetOptions;
  private readonly warn: (message: string) => void;
  /** Текстуры по ID ассета; `null` — ассет ещё не доехал (ASSET-4). */
  private readonly textures = new Map<string, THREE.Texture | null>();
  private readonly unsubscribes: (() => void)[] = [];
  private readonly warned = new Set<string>();
  private readonly uniforms: Record<string, THREE.IUniform> = {
    tSlot0: { value: null },
    tSlot1: { value: null },
    tSlot2: { value: null },
    tSlot3: { value: null },
    uSlotPeriod: { value: new THREE.Vector4(1, 1, 1, 1) },
  };
  private paint: TerrainPaintMap | null = null;
  /** Потолок пресета (QUAL-1); бесконечность — потолка нет. */
  private ceiling = Number.POSITIVE_INFINITY;
  private materials: TerrainTilesetMaterials | null = null;
  /** Сетка сцены: карта не той сетки — предупреждение и рендер без раскраски. */
  private gridWidth = 0;
  private gridHeight = 0;
  /** Позвать, когда текстурирование изменилось: чанки пересобираются заново. */
  private onChanged: (() => void) | null = null;

  constructor(options: TerrainTilesetOptions) {
    this.options = options;
    this.warn =
      options.warn ??
      ((message): void => {
        console.warn(message);
      });
  }

  /** Раскладка UV стенок и юбки; нет записи `wall` — покрытия у них нет. */
  get wallMapping(): TerrainUvMapping | undefined {
    const wall = this.options.tileset?.wall;
    return wall === undefined ? undefined : { kind: 'wall', period: wall.period };
  }

  /**
   * Действующее число слотов: авторское под потолком пресета и под границей
   * геометрии (REND-39). Ноль — текстурирования нет вовсе.
   */
  get slots(): number {
    const declared = this.options.tileset?.slots.length ?? 0;
    if (declared === 0 || this.paint === null) return 0;
    return Math.max(1, Math.min(declared, TERRAIN_MAX_SLOTS, Math.floor(this.ceiling)));
  }

  /**
   * Слот клетки для генератора геометрии; `null` — текстурирования нет. Индекс
   * зажат в действующее число слотов: потолок пресета сливает хвост tileset'а в
   * последний оставшийся слот — картинка беднеет, но не чернеет (QUAL-1).
   */
  get paintSource(): TerrainPaintSource | null {
    const map = this.paint;
    const slots = this.slots;
    if (map === null || slots === 0) return null;
    const { width, height, slots: cells } = map;
    return {
      slotAt: (cellX, cellY): number => {
        if (cellX < 0 || cellY < 0 || cellX >= width || cellY >= height) return -1;
        return Math.min(cells[cellY * width + cellX]!, slots - 1);
      },
    };
  }

  /**
   * Запрос текстур слотов и карты раскраски (ASSET-2, ASSET-4). Сцена без
   * tileset'а либо без ссылки на карту не спрашивает ничего.
   */
  attach(
    ctx: RenderContext,
    materials: TerrainTilesetMaterials,
    grid: { width: number; height: number },
    onChanged: () => void,
  ): void {
    this.materials = materials;
    this.gridWidth = grid.width;
    this.gridHeight = grid.height;
    this.onChanged = onChanged;
    const tileset = this.options.tileset;
    const paintMap = this.options.paintMap;
    if (tileset === undefined || paintMap === undefined) return;
    for (const [index, slot] of tileset.slots.entries()) {
      if (index >= TERRAIN_MAX_SLOTS) {
        this.warnOnce(
          'slots',
          `render: tileset террейна объявил ${tileset.slots.length} слотов — смешивается не больше ` +
            `${TERRAIN_MAX_SLOTS} (в узле сетки сходятся четыре клетки, REND-39); лишние игнорируются`,
        );
        break;
      }
      this.requestTexture(ctx, slot.texture, index);
    }
    if (tileset.wall !== undefined) this.requestWallTexture(ctx, tileset.wall.texture);
    this.requestPaint(ctx, paintMap);
    this.applyPeriods();
  }

  /**
   * Потолок числа смешиваемых слотов (QUAL-1). Возвращает `true`, если
   * действующее число изменилось: материал и геометрия тогда пересобираются
   * событием смены пресета, а не кадром.
   */
  setCeiling(ceiling: number): boolean {
    const before = this.slots;
    this.ceiling = ceiling;
    const after = this.slots;
    if (after === before) return false;
    this.applyMaterial();
    return true;
  }

  /** Снос (REND-31): подписки снимаются, текстуры отдаются GPU. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const texture of this.textures.values()) texture?.dispose();
    this.textures.clear();
    this.warned.clear();
    this.paint = null;
    this.materials = null;
    this.onChanged = null;
  }

  /** Периоды слотов в униформу: смена периода не пересобирает геометрию (REND-39). */
  private applyPeriods(): void {
    const slots = this.options.tileset?.slots ?? [];
    const period = this.uniforms.uSlotPeriod!.value as THREE.Vector4;
    period.set(
      slots[0]?.period ?? 1,
      slots[1]?.period ?? 1,
      slots[2]?.period ?? 1,
      slots[3]?.period ?? 1,
    );
  }

  /** Материал пола под действующее число слотов; ноль — материал прежний, одноцветный. */
  private applyMaterial(): void {
    const floor = this.materials?.floor;
    const slots = this.slots;
    if (floor === undefined || slots === 0) return;
    // Цвет материала — множитель поверх смеси: белый отдаёт текстуры как есть.
    floor.color.setHex(0xffffff);
    patchFloorMaterial(floor, slots, this.uniforms);
  }

  private requestTexture(ctx: RenderContext, id: string, index: number): void {
    this.subscribe(ctx, id, (texture) => {
      this.uniforms[`tSlot${index}`]!.value = texture;
      // Приезд первой текстуры включает текстурирование: материал получает
      // подмену цвета, а чанки пересобираются с весами (ASSET-4, ED-15).
      this.applyMaterial();
      this.onChanged?.();
    });
  }

  private requestWallTexture(ctx: RenderContext, id: string): void {
    this.subscribe(ctx, id, (texture) => {
      const materials = this.materials;
      if (materials === null) return;
      applyWallCover(materials.wall, texture);
      applyWallCover(materials.skirt, texture, SKIRT_TINT);
    });
  }

  /**
   * Карта раскраски (ASSET-15): несовпадение сетки — предупреждение и рендер
   * без текстурирования, а не отказ кадра (по образцу карты кривизны ASSET-7).
   */
  private requestPaint(ctx: RenderContext, id: string): void {
    const handle = ctx.assets.request<TerrainPaintMap>('terrain-paint', id);
    this.unsubscribes.push(
      ctx.assets.subscribe(handle, (state: AssetState<TerrainPaintMap>) => {
        if (state.status === 'failed') {
          this.warnOnce(
            id,
            `render: карта раскраски террейна "${id}" не загрузилась: ${state.reason} — террейн без текстурирования (REND-39)`,
          );
          return;
        }
        if (state.status !== 'ready') return;
        const map = state.data;
        if (map.width !== this.gridWidth || map.height !== this.gridHeight) {
          this.warnOnce(
            id,
            `render: карта раскраски "${id}" ${map.width}×${map.height} не совпадает с сеткой террейна ` +
              `${this.gridWidth}×${this.gridHeight} — террейн без текстурирования (REND-39)`,
          );
          return;
        }
        this.reportSlotOverflow(id, map);
        this.paint = map;
        this.applyMaterial();
        this.onChanged?.();
      }),
    );
  }

  /**
   * Слот за пределом объявленных tileset'ом — предупреждение с адресом клетки
   * (REND-39): рисуется он последним оставшимся слотом, а не чёрным.
   */
  private reportSlotOverflow(id: string, map: TerrainPaintMap): void {
    const declared = this.options.tileset?.slots.length ?? 0;
    for (let cell = 0; cell < map.slots.length; cell++) {
      if (map.slots[cell]! < declared) continue;
      this.warnOnce(
        `${id}:overflow`,
        `render: карта раскраски "${id}", клетка (${cell % map.width}, ${Math.floor(cell / map.width)}): ` +
          `слот ${map.slots[cell]!} за пределом объявленных tileset'ом (${declared}) — рисуется последним слотом (REND-39)`,
      );
      return;
    }
  }

  /** Общая подписка на текстуру покрытия: мип-цепочка, тайлинг, анизотропия. */
  private subscribe(ctx: RenderContext, id: string, apply: (texture: THREE.Texture) => void): void {
    if (this.textures.has(id)) {
      const ready = this.textures.get(id);
      if (ready != null) apply(ready);
      return;
    }
    this.textures.set(id, null);
    const handle = ctx.assets.request<DecodedImage>('texture', id);
    this.unsubscribes.push(
      ctx.assets.subscribe(handle, (state: AssetState<DecodedImage>) => {
        if (state.status === 'failed') {
          this.warnOnce(
            id,
            `render: текстура покрытия террейна "${id}" не загрузилась: ${state.reason} — заливка цветом (REND-7)`,
          );
          return;
        }
        if (state.status !== 'ready' || this.textures.get(id) != null) return;
        // Владелец — подсистема террейна (PERF-8): покрытие арены стоит в
        // эталоне памяти своей строкой, а не растит строку моделей.
        const texture = textureFromImage(state.data, 'base', 'terrain');
        // Покрытие тайлится по мировым координатам, а под изометрией период
        // занимает десятки пикселей: без мипов текстура сворачивается в шум
        // (`DataTexture` мипов не строит и берёт ближайший тексель).
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = TILESET_ANISOTROPY;
        this.textures.set(id, texture);
        apply(texture);
      }),
    );
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}

/**
 * Покрытие стенок в материал: текстура становится картой, а цвет — множителем
 * поверх неё, поэтому одноцветная заливка уступает место белому либо названному
 * тону. Смена карты пересобирает программу материала — событие, а не кадр.
 */
function applyWallCover(
  material: THREE.MeshStandardMaterial,
  texture: THREE.Texture,
  tint = 0xffffff,
): void {
  material.map = texture;
  material.color.setHex(tint);
  material.needsUpdate = true;
}
