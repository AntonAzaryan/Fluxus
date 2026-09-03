/**
 * Заполнение записи отладки освещения (`render-debug` RDBG-2, REND-27) —
 * механика отдельно от РЕШЕНИЙ подсистемы (`subsystems/lighting.ts`), тем же
 * швом, каким рядом живут пул локальных источников (`localLights.ts`), часы
 * цикла (`cycle.ts`) и карты теней (`shadowMaps.ts`): подсистема знает, чем
 * нарисован кадр, а здесь — как это перекладывается в поля дампа.
 *
 * Числа берутся с ЖИВЫХ объектов сцены — тех самых, которыми нарисован кадр, а
 * не вторым расчётом по конфигурации; тон берётся из действующей конфигурации:
 * `getHexString()` аллоцировал бы строку каждым кадром (REND-26).
 *
 * На сцене без цикла (REND-32) это одно и то же — тоном конфигурации источники и
 * покрашены. С циклом покраска идёт фазами, и тон кадра расходится с тоном
 * конфигурации; дамп поэтому не выдаёт второй за первый, а называет рядом
 * авторские тона идущей фазы и долю перехода (`LightingCycle.fillDebug`).
 *
 * Своей работы источник отладки не заказывает и счётчиков стоимости не двигает
 * (RDBG-8) — он читает уже посчитанное кадром.
 */
import type * as THREE from 'three';
import type { PresentationLighting } from '@fluxus/assets';
import type { ShadowPhase } from '../types.js';
import type { DebugLightingState } from '../debug/lightingSource.js';
import type { ArenaExtent } from './arena.js';
import { resolveLightingConfig, type LightingRenderConfig, type ShadowMode } from './config.js';
import type { LightingCycle } from './cycle.js';
import type { OptionalLights } from './optionalLights.js';

/**
 * Всё, что подсистема отдаёт дампу: живые источники, действующая конфигурация,
 * авторская секция и её же решения кадра. Запись собирается на КАЖДЫЙ дамп —
 * это допустимо ровно потому, что дамп снимается по требованию, а не кадром
 * (RDBG-8); кадровый путь этой записи не касается вовсе.
 */
export interface LightingDebugInput {
  /** Подсистема получила `init`: без него источники в сцену не отданы (RDBG-6). */
  readonly inScene: boolean;
  /** Авторская секция как есть; `undefined` — сцена секции не несёт (PRES-2). */
  readonly section: PresentationLighting | undefined;
  /** Действующая конфигурация — секция под потолками пресета (QUAL-1). */
  readonly config: LightingRenderConfig;
  readonly ambient: THREE.AmbientLight;
  readonly sun: THREE.DirectionalLight;
  readonly sunDynamic: THREE.DirectionalLight;
  readonly optional: OptionalLights;
  readonly cycle: LightingCycle;
  readonly extent: ArenaExtent;
  readonly modeCeiling: ShadowMode;
  readonly sizeCeiling: number;
  readonly phase: ShadowPhase;
  readonly staticRoots: number;
  readonly dynamicRoots: number;
  readonly staticRebuilds: number;
  readonly staticStale: boolean;
}

/** Состояние освещения — в переиспользуемую запись отладки (RDBG-2). */
export function fillLightingDebugState(
  input: LightingDebugInput,
  out: DebugLightingState,
): void {
  // Без `init` источники в сцену не отданы, и кадр они не освещают: показывать
  // тогда нечего, и источник скажет это вслух (RDBG-6).
  out.inScene = input.inScene;
  out.authoredSection = input.section !== undefined;
  if (!input.inScene) return;
  const { sun, sunDynamic, optional, config } = input;
  const authored = resolveLightingConfig(input.section);
  const paired = sunDynamic.parent !== null;
  // Необязательные источники (REND-29) считаются по ПРИСУТСТВИЮ В СЦЕНЕ, а не
  // по конфигурации: дамп называет то, чем нарисован кадр.
  const rimLit = optional.rimLit;
  out.ambientLights = 1;
  out.hemisphereLights = optional.hemisphereLit ? 1 : 0;
  out.directionalLights = (paired ? 2 : 1) + (rimLit ? 1 : 0);
  out.rimIntensity = rimLit ? optional.rim.intensity : 0;
  out.ambientColor = config.ambientColor;
  out.ambientIntensity = input.ambient.intensity;
  out.directionalColor = config.directionalColor;
  // Фаза цикла (REND-32, design D5) — своими полями и своим тоном поверх
  // статического: числа круга знает он, а не подсистема.
  input.cycle.fillDebug(out);
  out.sunIntensity = sun.intensity;
  out.sunDynamicIntensity = paired ? sunDynamic.intensity : 0;
  out.lightWorldX = sun.position.x;
  out.lightWorldY = sun.position.y;
  out.lightWorldZ = sun.position.z;
  out.targetWorldX = sun.target.position.x;
  out.targetWorldY = sun.target.position.y;
  out.targetWorldZ = sun.target.position.z;
  out.arenaRadiusWorldUnits = input.extent.radius;
  out.shadowFrustumHalfWorldUnits = sun.shadow.camera.right;
  out.shadowMode = config.shadowMode;
  out.authoredShadowMode = authored.shadowMode;
  out.ceilingShadowMode = input.modeCeiling;
  // Действующая сторона карты — та, что стоит у камеры источника: конфиг
  // округляется при применении, и показывать надо применённое.
  out.shadowMapTexels = sun.shadow.mapSize.x;
  out.authoredShadowMapTexels = authored.shadowMapSize;
  out.ceilingShadowMapTexels = input.sizeCeiling;
  out.staticShare = config.staticShare;
  out.shadowPhase = input.phase;
  out.staticCasterRoots = input.staticRoots;
  out.dynamicCasterRoots = input.dynamicRoots;
  out.staticRebuilds = input.staticRebuilds;
  out.staticStale = input.staticStale;
  // Карту строит теневой проход three: ноль — прохода ещё не было (headless-
  // прогон, режим `none`), и это ответ на «тени настроены, а их нет».
  out.builtShadowMaps =
    (sun.shadow.map === null ? 0 : 1) + (paired && sunDynamic.shadow.map !== null ? 1 : 0);
}
