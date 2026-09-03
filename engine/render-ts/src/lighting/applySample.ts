/**
 * Значения кадра цикла времени суток — на ЖИВЫЕ источники сцены (REND-32).
 *
 * Отдельным модулем, а не методом подсистемы, по той же границе, что и всё в
 * `lighting/`: подсистема принимает РЕШЕНИЯ (какая фаза теневого прохода, чей
 * кэш устарел, что применять), а как решение исполняется на объектах three —
 * здесь. Своего состояния у модуля нет: это чистая операция над переданными
 * объектами, и потому её видно тестом без подсистемы вовсе.
 */
import type * as THREE from 'three';
import { aimDirectional, type ArenaExtent } from './arena.js';
import { applyShadowBias, fitShadowFrustum } from './shadowMaps.js';
import type { LightingCycleSample } from './cycle.js';
import type { OptionalLights } from './optionalLights.js';

/**
 * Ставит значения снимка на источники и возвращает, ПОЕХАЛО ли направление
 * этим кадром: кэш статики устаревает ровно тогда (REND-30) — и на каждом таком
 * кадре, включая последний, добивающий кэш точным направлением установившейся
 * фазы. Решение о том, что делать с устареванием, остаётся у подсистемы.
 *
 * Параметры позиционные, а не записью: функция зовётся на КАЖДОМ кадре
 * перехода, и запись-аргумент была бы аллокацией на кадр (REND-26).
 */
export function applyCycleSampleTo(
  ambient: THREE.AmbientLight,
  sun: THREE.DirectionalLight,
  optional: OptionalLights,
  extent: ArenaExtent,
  shadowMapSize: number,
  sample: LightingCycleSample,
): boolean {
  ambient.color.copy(sample.ambientColor);
  ambient.intensity = sample.ambientIntensity;
  // Необязательные источники ведёт фаза, но ЗАВОДИТ их статическая часть
  // (REND-32): источник уже в сцене, кадр меняет только числа — ни добавления,
  // ни снятия здесь не бывает, и пересборки программ материалов кадром тоже.
  optional.applySample(sample, extent);
  sun.color.copy(sample.directionalColor);
  // Интенсивность фазы — целиком на единственный источник (REND-30): делить её
  // между ярусами нечем, карта одна.
  sun.intensity = sample.directionalIntensity;
  aimDirectional(sun, extent, sample.directionX, sample.directionY, sample.directionZ);
  if (!sample.directionMoved) return false;
  // Фрустум — функция направления и коробки арены: поехало направление —
  // переобтягиваем, иначе кастеры у края арены уехали бы за его границу.
  // Смещения выборки следуют за фрустумом: тексель у него свой (design D6, L-9).
  fitShadowFrustum(sun, extent);
  applyShadowBias(sun, shadowMapSize);
  return true;
}
