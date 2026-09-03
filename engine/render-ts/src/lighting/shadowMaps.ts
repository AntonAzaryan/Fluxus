/**
 * Карты теней направленных источников и флаги кастеров (`rendering` REND-30) —
 * механика three, отделённая от РЕШЕНИЯ подсистемы. Подсистема
 * (`subsystems/lighting.ts`) знает, чья карта рисуется в этом кадре и какой ярус
 * поднят флагом; здесь — как эти решения исполняются на объектах three:
 * освобождение построенной карты, смена её стороны и обход поддерева корня.
 *
 * Своего состояния у модуля нет: это чистые операции над переданными объектами.
 */
import * as THREE from 'three';
import { PRESENTATION_SHADOW_MODES, type PresentationShadowMode } from '@fluxus/assets';
import type { QualityKnob } from '../types.js';
import type { LightingRenderConfig, ShadowMode } from './config.js';
import { aimDirectional, type ArenaExtent } from './arena.js';

/**
 * Запас фрустума теневой камеры по бокам коробки арены, мировые единицы. Нужен
 * не «на всякий случай»: кастер стоит НА краю арены, а его тень уходит за край,
 * и обтянутый ровно по коробке фрустум срезал бы её у самой кромки. Полметра —
 * половина клетки типовой арены.
 */
const FRUSTUM_MARGIN_WORLD_UNITS = 0.5;

/** Переиспользуемое хозяйство подгонки фрустума: событие, но аллокаций не стоит. */
const SCRATCH_VIEW = new THREE.Matrix4();
const SCRATCH_CORNER = new THREE.Vector3();
const SCRATCH_EYE = new THREE.Vector3();
const SCRATCH_TARGET = new THREE.Vector3();
const SCRATCH_UP = new THREE.Vector3();

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
  fitShadowFrustum(light, extent);
  resizeShadowMap(light, config.shadowMapSize);
  applyShadowBias(light, config.shadowMapSize);
}

/**
 * Обтягивает ортографический фрустум теневой камеры по КОРОБКЕ АРЕНЫ в
 * пространстве света (design D6, находка L-9 аудита 2026-09-03).
 *
 * Прежняя наводка брала квадрат по диагонали сетки — «радиус» описывал арену
 * окружностью, и фрустум не зависел от направления света вовсе. Стоило это
 * вчетверо больше площади, чем нужно: для арены 48×48 сторона выходила 84.9
 * мировой единицы там, где проекция восьми углов коробки на направление демо
 * укладывается в ≈33×26. Тексели тратились на пустоту за углами арены, а
 * плотность карты — то самое, чем меряется качество кромки тени.
 *
 * Подгонка идёт по ВОСЬМИ УГЛАМ коробки, а не по её плану: свет косой, и
 * верхние углы проецируются в другое место, чем нижние. Границы получаются
 * АСИММЕТРИЧНЫМИ (`left ≠ −right`) — это нормально для ортографии и это ровно
 * та экономия, ради которой подгонка и делается.
 *
 * Свойство «без мерцания» (design D6) сохраняется: фрустум — функция НАПРАВЛЕНИЯ
 * СВЕТА и коробки арены, и ничего больше. Камера кадра в него не входит, поэтому
 * панорама и зум текселей не двигают; пересчитывается он только там, где поехало
 * направление, — на применении секции и на кадре перехода цикла (REND-32).
 */
export function fitShadowFrustum(light: THREE.DirectionalLight, extent: ArenaExtent): void {
  const camera = light.shadow.camera;
  // Матрица вида света: смотрим из позиции источника в его цель. Собирается она
  // здесь, а не берётся у камеры, потому что позу камеры three ставит своим
  // `updateMatrices` уже во время теневого прохода — то есть позже нас.
  SCRATCH_EYE.copy(light.position);
  SCRATCH_TARGET.copy(light.target.position);
  SCRATCH_UP.copy(camera.up);
  SCRATCH_VIEW.lookAt(SCRATCH_EYE, SCRATCH_TARGET, SCRATCH_UP);
  SCRATCH_VIEW.setPosition(SCRATCH_EYE);
  SCRATCH_VIEW.invert();

  const halfX = extent.sizeX / 2;
  const halfY = extent.sizeY / 2;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const height = extent.maxZ - extent.minZ;
  for (let corner = 0; corner < 8; corner++) {
    // Биты номера — это и есть выбор угла: младший даёт знак по X, следующий —
    // по Y, старший поднимает угол на верх коробки. Арифметикой, а не ветвями:
    // читается так же, а анализатору сложности здесь видеть нечего.
    const signX = (corner & 1) * 2 - 1;
    const signY = ((corner >> 1) & 1) * 2 - 1;
    const high = (corner >> 2) & 1;
    SCRATCH_CORNER.set(
      extent.centerX + signX * halfX,
      extent.centerY + signY * halfY,
      extent.minZ + high * height,
    );
    SCRATCH_CORNER.applyMatrix4(SCRATCH_VIEW);
    minX = Math.min(minX, SCRATCH_CORNER.x);
    maxX = Math.max(maxX, SCRATCH_CORNER.x);
    minY = Math.min(minY, SCRATCH_CORNER.y);
    maxY = Math.max(maxY, SCRATCH_CORNER.y);
    minZ = Math.min(minZ, SCRATCH_CORNER.z);
    maxZ = Math.max(maxZ, SCRATCH_CORNER.z);
  }
  const margin = FRUSTUM_MARGIN_WORLD_UNITS;
  camera.left = minX - margin;
  camera.right = maxX + margin;
  camera.bottom = minY - margin;
  camera.top = maxY + margin;
  // Камера смотрит вдоль −Z своего пространства: точка на глубине `z` удалена от
  // неё на `−z`. Ближняя плоскость — самый близкий угол, дальняя — самый далёкий.
  // Ноль ближней плоскости ортографию не ломает, но оставляет её на самом углу
  // коробки: запас тот же, что по бокам.
  camera.near = Math.max(0.1, -maxZ - margin);
  camera.far = -minZ + margin;
  camera.updateProjectionMatrix();
}

/**
 * Смещения выборки — производная фрустума и стороны карты (см. константы
 * `NORMAL_BIAS_TEXELS`/`DEPTH_BIAS_TEXELS`). Тексель ортографической камеры один
 * и тот же по всей арене, но после подгонки фрустума (L-9) он РАЗНЫЙ ПО ОСЯМ:
 * коробка арены проецируется в прямоугольник, а не в квадрат. Берётся больший из
 * двух — смещение обязано покрывать худшую ось, иначе на ней вернётся ребристая
 * сетка самозатенения.
 */
export function applyShadowBias(light: THREE.DirectionalLight, mapSize: number): void {
  const camera = light.shadow.camera;
  const side = Math.max(1, Math.round(mapSize));
  const texel = Math.max(
    (camera.right - camera.left) / side,
    (camera.top - camera.bottom) / side,
  );
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

/**
 * Ручки качества подсистемы освещения (QUAL-1, QUAL-3). Обе — ПОТОЛКИ над
 * авторскими значениями секции: пресет вправе удешевить тени, но не поднять их
 * выше авторских и не тронуть документ сцены (та же семантика, что у потолка
 * разрешения маски тумана, FOW-10).
 *
 * Объявления живут здесь, рядом с механикой карт, по тому же основанию, что и
 * ручка пула локальных источников рядом с пулом (`localLightsKnob`): подсистема
 * решает, ЧТО рисовать, а чем это меряется — свойство самой механики.
 */
export const LIGHTING_SHADOW_MODE = 'lighting.shadowMode';
export const LIGHTING_SHADOW_MAP_SIZE = 'lighting.shadowMapSize';

export function shadowModeKnob(): QualityKnob {
  return {
    name: LIGHTING_SHADOW_MODE,
    cost: 'теневые проходы кадра: `none` — их нет, `blob` — карт нет, под динамикой контактные пятна одним инстанс-мешем, `hybrid` — покадрово рисуется только динамический ярус, `full` — все кастеры каждым кадром',
    semantics: 'ceiling',
    // Потолка нет — действует авторский режим секции: самый дорогой из
    // объявленных и есть «не ограничивать».
    default: 'full',
    values: PRESENTATION_SHADOW_MODES,
  };
}

export function shadowMapSizeKnob(): QualityKnob {
  return {
    name: LIGHTING_SHADOW_MAP_SIZE,
    cost: 'тексели карт теней: стоимость теневого прохода растёт квадратом стороны карты',
    semantics: 'ceiling',
    default: Number.POSITIVE_INFINITY,
    min: 256,
    max: 8192,
  };
}
