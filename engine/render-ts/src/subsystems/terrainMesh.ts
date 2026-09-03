/**
 * Меш чанка террейна из числовых данных генераторов (`terrainGeometry.ts`,
 * `terrainSkirt.ts`): BufferGeometry с позициями, индексами, нормалями и —
 * при покрытии — раскладкой UV проекцией мировых координат (`terrainCover.ts`).
 * Отдельно от генераторов, потому что они — функции данных и о three не знают.
 */
import * as THREE from 'three';
import { own } from '../footprint.js';
import { projectUv, type TerrainUvMapping } from './terrainCover.js';
import type { TerrainGeometryData } from './terrainGeometry.js';

/**
 * BufferGeometry из числовых данных. Готовые нормали ставятся атрибутом (пол:
 * они посчитаны из поля высот, REND-9); если их нет — считаются по
 * треугольникам, и стенка обрыва остаётся плоской. Атрибут `uv` появляется
 * только с раскладкой покрытия: без покрытия геометрия та же, что и до него.
 */
export function toBufferGeometry(
  data: TerrainGeometryData,
  mapping?: TerrainUvMapping,
): THREE.BufferGeometry {
  const geometry = own('geometry', 'terrain', new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (data.normals?.length === data.positions.length) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (mapping !== undefined) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(projectUv(data.positions, mapping), 2));
  }
  return geometry;
}
