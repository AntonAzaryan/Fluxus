/**
 * Карты теней направленных источников и флаги кастеров (`rendering` REND-30) —
 * механика three, отделённая от РЕШЕНИЯ подсистемы. Подсистема
 * (`subsystems/lighting.ts`) знает, чья карта рисуется в этом кадре и какой ярус
 * поднят флагом; здесь — как эти решения исполняются на объектах three:
 * освобождение построенной карты, смена её стороны и обход поддерева корня.
 *
 * Своего состояния у модуля нет: это чистые операции над переданными объектами.
 */
import type * as THREE from 'three';
import { PRESENTATION_SHADOW_MODES, type PresentationShadowMode } from '@fluxus/assets';
import type { LightingRenderConfig, ShadowMode } from './config.js';
import { aimDirectional, type ArenaExtent } from './arena.js';

/**
 * Запас фрустума теневой камеры над ареной, доля её радиуса: модели стоят выше
 * пола, и обтянутый ровно по сетке фрустум срезал бы тень высокой декорации.
 */
const FRUSTUM_MARGIN = 0.25;

/**
 * Смещения выборки карты теней — в ТЕКСЕЛЯХ этой карты, а не в мировых
 * единицах и не авторским числом секции (REND-29).
 *
 * Поверхность, освещённая вкось, за один тексель карты меняет глубину на
 * «тексель × tg(угол между нормалью и светом)», и без смещения она затеняет
 * сама себя: половина текселя оказывается «за» собственной глубиной, половина
 * перед ней. На арене это читалось РЕБРИСТОЙ СЕТКОЙ на боках клифов — они
 * стоят почти вдоль лучей, и угол там наибольший.
 *
 * Смещение поэтому и меряется текселями: величина дефекта — свойство
 * ПЛОТНОСТИ карты, а плотность меняют и автор сцены (`shadows.mapSize`), и
 * потолок пресета (QUAL-1), и размер арены. Мировое число, поставленное под
 * одну из этих троек, под остальными либо не спасало бы от сетки, либо
 * отрывало бы тень от ног. Отсюда и место расчёта — `aimShadowLight`, где
 * фрустум и сторона карты известны обе.
 *
 * Двух смещений именно два, потому что они лечат разное: `normalBias` сдвигает
 * точку выборки ВДОЛЬ НОРМАЛИ приёмника (то есть ровно поперёк ошибки наклона)
 * и делает основную работу, `bias` — постоянная поправка глубины, добавка
 * против остатка на самых косых поверхностях. Больше текселя-двух ни то, ни
 * другое брать нельзя: смещение — это и есть отрыв тени от контакта.
 */
const NORMAL_BIAS_TEXELS = 2;
const DEPTH_BIAS_TEXELS = 1;

/**
 * Пирамида теневой камеры источника в мировых осях (REND-21, REND-30) — вход
 * отсечения у владельца инстансов: инстанс, попадающий в неё, обязан быть
 * нарисован, даже если камера кадра его не видит, иначе он перестанет
 * отбрасывать тень внутрь экрана.
 *
 * Матрицы теневой камеры производны от позы источника и его цели, и three
 * сводит их только в теневом проходе — здесь этот пересчёт вызывается явно,
 * потому что пирамиду спрашивают ДО кадра. Считает её сам three
 * (`updateMatrices` заодно обновляет и пирамиду своей карты, с оглядкой на
 * систему координат и обратную глубину бэкенда), здесь она лишь копируется в
 * поданную: своего объекта на кадр обход не требует (REND-26).
 */
export function shadowCameraFrustum(
  light: THREE.DirectionalLight,
  out: THREE.Frustum,
): THREE.Frustum {
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
  light.shadow.updateMatrices(light);
  return out.copy(light.shadow.getFrustum());
}

/**
 * Позиция, цель, тон и фрустум теневой камеры одного источника (design D6):
 * ортографический фрустум обтянут по границам арены — она мала, и стабильный
 * фрустум не даёт мерцания текселей при движении камеры кадра.
 */
export function aimShadowLight(
  light: THREE.DirectionalLight,
  extent: ArenaExtent,
  config: LightingRenderConfig,
  intensity: number,
): void {
  light.color.set(config.directionalColor);
  light.intensity = intensity;
  aimDirectional(light, extent, config.directionX, config.directionY, config.directionZ);

  const distance = extent.radius * 2;
  const radius = extent.radius * (1 + FRUSTUM_MARGIN);
  const camera = light.shadow.camera;
  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  camera.near = 0.5;
  camera.far = distance + radius * 2;
  camera.updateProjectionMatrix();
  resizeShadowMap(light, config.shadowMapSize);

  // Смещения выборки — производная фрустума и стороны карты (см. константы):
  // тексель камеры ортографический, то есть один и тот же по всей арене.
  const side = Math.max(1, Math.round(config.shadowMapSize));
  const texel = (radius * 2) / side;
  light.shadow.normalBias = texel * NORMAL_BIAS_TEXELS;
  // `bias` три складывает с нормированной глубиной приёмника, а глубина
  // ортографической камеры линейна по `far − near`: мировая поправка
  // становится долей этого отрезка. Знак отрицательный — приёмник надо
  // подвинуть К свету, иначе сравнение оставит его в собственной тени.
  light.shadow.bias = -((texel * DEPTH_BIAS_TEXELS) / (camera.far - camera.near));
}

/** Значение ручки — режим теней; иначе потолка нет (QUAL-1). */
export function isShadowMode(value: unknown): value is ShadowMode {
  return (
    typeof value === 'string' && PRESENTATION_SHADOW_MODES.includes(value as PresentationShadowMode)
  );
}

/**
 * Флаги теней всему поддереву корня: `castShadow`/`receiveShadow` три проверяет
 * на каждом меше, а корень — это то, что подсистема-владелец объявила кастером
 * (узел детального инстанса, группа батча, меш чанка террейна).
 */
export function applyShadowFlags(root: THREE.Object3D, cast: boolean, receive: boolean): void {
  root.traverse((node) => {
    node.castShadow = cast;
    node.receiveShadow = receive;
  });
}

/**
 * Сторона карты теней. Смена — событие (правка секции, пресет): готовую карту
 * three по изменившемуся `mapSize` не пересоздаёт, поэтому прежняя
 * освобождается здесь вместе с её текстурой глубины.
 */
function resizeShadowMap(light: THREE.DirectionalLight, size: number): void {
  const side = Math.max(1, Math.round(size));
  if (light.shadow.mapSize.x === side && light.shadow.mapSize.y === side) return;
  light.shadow.mapSize.set(side, side);
  releaseShadowMap(light);
}

/**
 * Освобождает построенную карту теней источника вместе с её текстурой глубины.
 * Пустая карта (`null`) — обычное состояние источника, который ещё не рисовали:
 * three строит её на первом теневом проходе и сам никогда не освобождает.
 */
export function releaseShadowMap(light: THREE.DirectionalLight): void {
  const map = light.shadow.map;
  if (map === null) return;
  map.depthTexture?.dispose();
  map.dispose();
  light.shadow.map = null;
}
