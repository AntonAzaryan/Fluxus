/**
 * Плашка растрового источника отладочного слоя (`render-debug` RDBG-2): своя
 * текстура, свой квад и своя копия растра — буфер подсистемы плашке не
 * принадлежит, и держать на него ссылку она не вправе.
 *
 * Отдельно от словаря примитивов (`painter.ts`) по тому же основанию, что и
 * носители (`carriers.ts`): это устройство одного примитива, а не сам словарь.
 */
import * as THREE from 'three';
import type { DebugRaster } from './contract.js';
import { own } from '../footprint.js';

/** Плашка растрового источника: своя текстура и свой квад. */
export interface RasterPlane {
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

/**
 * Плашка под растр названного разрешения. Одноканальный растр: цвет плашки
 * задаёт источник, яркость — сам тексель.
 */
export function rasterPlaneOf(id: string, raster: DebugRaster): RasterPlane {
  const texels = new Uint8Array(raster.widthTexels * raster.heightTexels);
  const texture = own(
    'texture',
    'debug',
    new THREE.DataTexture(
      texels,
      raster.widthTexels,
      raster.heightTexels,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    ),
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  const material = own(
    'material',
    'debug',
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  const geometry = own('geometry', 'debug', new THREE.PlaneGeometry(1, 1));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `render-debug:${id}`;
  return {
    mesh,
    texture,
    texels,
    material,
    geometry,
    widthTexels: raster.widthTexels,
    heightTexels: raster.heightTexels,
    used: true,
  };
}

/** Ресурсы плашки — все три вида разом (REND-31): снятие со сцены за вызывающим. */
export function disposeRasterPlane(plane: RasterPlane): void {
  plane.geometry.dispose();
  plane.material.dispose();
  plane.texture.dispose();
}
