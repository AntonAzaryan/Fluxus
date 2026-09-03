/**
 * Покрытия террейна (REND-7): тайлящиеся текстуры площадок пола и стенок
 * обрывов, спроецированные по мировым координатам, и их загрузка из дерева
 * контента (ASSET-2, ASSET-4). Владелец — подсистема террейна
 * (`subsystems/terrain.ts`); здесь собрано то, что у покрытий своё, чтобы
 * подсистема осталась про чанки и сетку, а не про текстуры.
 *
 * ВРЕМЕННЫЙ механизм в ряду `floorColor`: одно покрытие на весь пол и одно на
 * все стенки, пока текстурирование не приехало раскраской клеток из Blender
 * (стаб `terrain-texturing`). Недоступный ассет —
 * предупреждение с причиной и заливка цветом, не отказ кадра (по образцу
 * детали воды, REND-35).
 */
import * as THREE from 'three';
import type { AssetState, DecodedImage } from '@fluxus/assets';
import type { RenderContext } from '../types.js';
import { textureFromImage } from '../model/skins.js';

/** Покрытие террейна: ID текстуры (ASSET-2) и период тайла в мировых единицах. */
export interface TerrainCover {
  readonly texture: string;
  readonly period: number;
}

/**
 * Раскладка текстурных координат покрытия по мировым координатам вершин: у
 * геометрии террейна своих UV нет — она строится из сетки, — и тайлящееся
 * покрытие ложится на неё проекцией. `floor` — планарно сверху, период в
 * мировых единицах по обеим осям; `wall` — вдоль стенки (сумма `x + y`: у
 * стенки cliff-отрезка одна из осей постоянна, и на повороте отрезка
 * координата остаётся непрерывной) и по высоте `z`.
 */
export interface TerrainUvMapping {
  readonly kind: 'floor' | 'wall';
  /** Мировых единиц на период текстуры. */
  readonly period: number;
}

/** Покрытия подсистемы: пола и стенок (стенки и юбка делят одно). */
export interface TerrainCovers {
  readonly floor?: TerrainCover | undefined;
  readonly wall?: TerrainCover | undefined;
}

/** Раскладка по покрытию; нет покрытия — нет и раскладки, геометрия без `uv`. */
function mappingOf(
  cover: TerrainCover | undefined,
  kind: TerrainUvMapping['kind'],
): TerrainUvMapping | undefined {
  return cover === undefined ? undefined : { kind, period: cover.period };
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
const COVER_ANISOTROPY = 8;

/** Тон юбки под покрытием стенок: тот же срез породы, но темнее — глубина (REND-7). */
const SKIRT_COVER_TINT = 0x8a8a8a;

/**
 * Покрытие в материал: текстура становится картой, а цвет — множителем поверх
 * неё, поэтому одноцветная заливка уступает место белому либо названному тону.
 * Смена карты пересобирает программу материала — событие, а не кадр.
 */
function applyCover(
  material: THREE.MeshStandardMaterial,
  texture: THREE.Texture,
  tint = 0xffffff,
): void {
  material.map = texture;
  material.color.setHex(tint);
  material.needsUpdate = true;
}

/** Материалы террейна, которым достаются покрытия. */
export interface TerrainCoverMaterials {
  readonly floor: THREE.MeshStandardMaterial;
  readonly wall: THREE.MeshStandardMaterial;
  readonly skirt: THREE.MeshStandardMaterial;
}

/**
 * Загрузчик текстур покрытий: подписки по ID и созданные текстуры, которые
 * снос отдаёт GPU (REND-31). Спрашиваются только названные ID — подсистема без
 * покрытий не трогает модуль ассетов вовсе, и кадр сцены без них прежний.
 * Раскладки UV чанков — производная наличия покрытий и живут здесь же.
 */
export class TerrainCoverLoader {
  readonly floorMapping: TerrainUvMapping | undefined;
  readonly wallMapping: TerrainUvMapping | undefined;
  private readonly covers: TerrainCovers;
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly unsubscribes: (() => void)[] = [];
  /** ID, о недоступности которых уже сказано: предупреждение одно на причину. */
  private readonly warned = new Set<string>();
  private readonly warn: (message: string) => void;

  /** Канал предупреждений; не задан — `console.warn`. */
  constructor(covers: TerrainCovers, warn?: (message: string) => void) {
    this.covers = covers;
    this.warn =
      warn ??
      ((message): void => {
        console.warn(message);
      });
    this.floorMapping = mappingOf(covers.floor, 'floor');
    this.wallMapping = mappingOf(covers.wall, 'wall');
  }

  /**
   * Запрос покрытий (ASSET-2, ASSET-4) и их постановка в материалы по приезду.
   * Юбка несёт то же покрытие, что стенки, но темнее: уходящий вниз срез
   * читается глубиной, как и одноцветная юбка (REND-7).
   */
  attach(ctx: RenderContext, materials: TerrainCoverMaterials): void {
    if (this.covers.floor !== undefined) {
      this.request(ctx, this.covers.floor.texture, (texture) => {
        applyCover(materials.floor, texture);
      });
    }
    if (this.covers.wall !== undefined) {
      this.request(ctx, this.covers.wall.texture, (texture) => {
        applyCover(materials.wall, texture);
        applyCover(materials.skirt, texture, SKIRT_COVER_TINT);
      });
    }
  }

  /**
   * Подписка на текстуру покрытия: доехавшая уходит в `apply`, недоступная —
   * предупреждение с причиной; ещё не доехавший ассет предупреждением не
   * является (ASSET-4) — он доедет и будет применён сам.
   */
  private request(ctx: RenderContext, id: string, apply: (texture: THREE.Texture) => void): void {
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
        if (state.status !== 'ready') return;
        let texture = this.textures.get(id);
        if (texture === undefined) {
          // Владелец — подсистема террейна, а не модели (PERF-8): покрытие
          // арены обязано стоять в эталоне памяти своей строкой.
          texture = textureFromImage(state.data, 'base', 'terrain');
          // Покрытие тайлится по мировым координатам, а под изометрией период
          // занимает десятки пикселей: без мипов текстура сворачивается в шум
          // (`DataTexture` мипов не строит и берёт ближайший тексель).
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.anisotropy = COVER_ANISOTROPY;
          this.textures.set(id, texture);
        }
        apply(texture);
      }),
    );
  }

  /** Снос (REND-31): подписки снимаются, текстуры отдаются GPU. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.warned.clear();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}
