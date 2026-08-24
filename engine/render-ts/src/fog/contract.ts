/**
 * Контракты подсистемы тумана (FOW-7, REND-8) — опции сборки и структурные
 * минимумы её зависимостей. Врозь с самой подсистемой (`subsystems/fog.ts`)
 * только ради размера того файла: владелец контрактов — она, а наружу они
 * уходят через `index.ts` тем же путём, что и раньше.
 */
import type * as THREE from 'three';
import type { EntityId, TerrainGrid } from '@game-mvp/core';
import type { PresentationFog } from '@game-mvp/assets';
import type { ScenePostSource } from '../types.js';
import type { FogLayerCanvas } from './layer.js';

/** Имена статов доставки (HUD-8, design D4): радиус обзора и команда сущности. */
export interface FogStatNames {
  readonly visionRadius: string;
  readonly team: string;
}

/**
 * Рендерер глазами пост-прохода — структурный минимум `THREE.WebGLRenderer`:
 * подсистема не требует живого WebGL в тестах, а в сборке это он и есть.
 */
export interface FogRendererLike {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}

export interface FogSubsystemOptions {
  /** Сетка террейна сцены — прямоугольник маски и cliff-отрезки (TERR-5, FOW-9). */
  readonly grid: TerrainGrid;
  /** Имена статов доставки (design D4): их объявляет конфигурация сборки воркера. */
  readonly stats: FogStatNames;
  /**
   * Сущность героя игрока — из неё читается команда, чьи наблюдатели открывают
   * маску (design D4). Функция, а не значение: ID приезжает handshake'ом позже
   * сборки подсистем.
   */
  readonly hero: () => EntityId | null;
  /** Секция `fog` парного документа (PRES-2); нет — умолчания (FOW-10). */
  readonly config?: PresentationFog;
  /**
   * Фабрика канваса слоя миникарты (design D6) — её приносит сборка (в
   * браузере — `document.createElement('canvas')`): пакет рендера DOM не
   * трогает. Без фабрики слоя миникарты нет; маска и пост-проход работают.
   */
  readonly createCanvas?: (width: number, height: number) => FogLayerCanvas;
  /**
   * Бюджет порционной перестройки маски — тексель-операций на кадр (design D1,
   * PERF-3). Не задан — от площади маски (`REBUILD_BUDGET_MASK_AREAS`): полная
   * перестройка укладывается в ≤3 кадра. `Infinity` — перестройка целиком в
   * первом же кадре после доставки: так меряют РАБОТУ перестройки стенды, чей
   * каденс кадров не равен игровому (`integration-ts`), и так же она идёт при
   * снапе.
   *
   * Единицы машинно-независимые (тексели, а не миллисекунды): счётчики
   * стоимости остаются воспроизводимыми побитово (PERF-3).
   */
  readonly rebuildBudget?: number;
  /**
   * Пост-обработка кадра портом (`rendering` REND-34, FOW-7, change
   * `bloom-tone-mapping` design D2): при активной цепочке маскирующий проход
   * читает ЕЁ выход, а сцену подсистема тумана не рисует. Порта нет — кадр
   * ровно такой, каким был до REND-34.
   *
   * Порт, а не ссылка на подсистему: подсистемы не знают друг о друге, а общий
   * объект им приносит сборка — тот же приём, что у приёмника теневых кастеров.
   * Владелец порта регистрируется РАНЬШЕ тумана и переживает его снос (REND-31).
   */
  readonly post?: ScenePostSource;
}
