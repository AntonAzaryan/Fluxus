/**
 * Контракты рендера (REND-1..8). Рендер — внешний наблюдатель симуляции:
 * единственный вход данных — `TickResult` через `RenderHost.onTick`,
 * единственный выход — сцена Three.js. Ядро о рендере не знает.
 *
 * Все величины здесь — float в мировых единицах: конверсия Q16.16 → float
 * происходит ровно один раз, при копировании в presentation-состояние
 * (`host.ts`); обратной конверсии float → fixed в пакете не существует (REND-1).
 */
import type * as THREE from 'three';
import type { EntityId, TerrainGrid, WorldMode, WorldState } from '@game-mvp/core';
import type { AssetService } from '@game-mvp/assets';

// ------------------------------------------------- presentation-состояние

/**
 * Presentation-срез одной сущности: два последних тика для интерполяции
 * (REND-2) плюс производные признаки для анимаций (REND-4, REND-5).
 * Объект стабилен на всё время жизни сущности — подсистемы могут держать
 * ссылку; мутирует его только `RenderHost` в `onTick`.
 */
export interface EntityView {
  readonly id: EntityId;
  /** Визуальный тип (ключ манифеста визуалов) либо null — сущность не рисуется. */
  readonly kind: string | null;
  /** Позиция предыдущего тика. */
  prevX: number;
  prevY: number;
  /** Позиция последнего тика. */
  currX: number;
  currY: number;
  /** Уровень террейна под сущностью на тех же двух тиках (TERR-4 производное). */
  prevLevel: number;
  currLevel: number;
  /** Разрыв непрерывности в этом тике (спавн, телепорт, rewind): рисовать без интерполяции. */
  snap: boolean;
  /** Появилась в этом тике. */
  spawned: boolean;
  /** Скорость выше порога на последнем тике — состояние `move` (REND-4). */
  moving: boolean;
  /** Последний курс движения, радианы; сохраняется, пока сущность стоит. */
  facingYaw: number;
  /** Направление последнего каста/атаки, радианы; null — цель протухла (REND-5). */
  aimYaw: number | null;
}

/** Копия события тика: переживает `dispatch()`, в отличие от view ядра (OBS-3). */
export interface RenderEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, number>>;
}

/**
 * Presentation-состояние тика, передаваемое подсистемам в `syncTick`.
 * Владеет им `RenderHost`; в отличие от `TickResult` ядра, данные скопированы
 * и валидны до следующего `onTick`.
 */
export interface TickView {
  tick: number;
  mode: WorldMode;
  isReplay: boolean;
  /** Разрыв непрерывности всего мира (rewind/смена режима): всем сущностям snap (REND-2). */
  snapAll: boolean;
  /** Первый честный проход тика: события можно проигрывать (OBS-5 — дедуп на потребителе). */
  freshEvents: boolean;
  readonly entities: ReadonlyMap<EntityId, EntityView>;
  events: readonly RenderEvent[];
  /** Зеркало карты пола (1 — пол есть), row-major; null — сцена без террейна. */
  floorBits: Uint8Array | null;
  /** Клетки, чей пол изменился в этом тике (TERR-6 → REND-7). */
  floorChangedCells: readonly number[];
}

// ------------------------------------------------------------- подсистемы

/** Общий конфиг рендера, доступный всем подсистемам. */
export interface RenderConfig {
  /** Высота одного уровня террейна в мировых единицах — параметр рендера, не ядра (REND-7). */
  readonly heightStep: number;
}

/** Что подсистема получает на инициализации (REND-8). */
export interface RenderContext {
  readonly scene: THREE.Scene;
  readonly assets: AssetService;
  readonly config: RenderConfig;
}

/**
 * Контракт подсистемы рендера (REND-8): `syncTick` и `updateFrame` вызываются
 * в порядке регистрации. Подсистема владеет своими сценовыми объектами и
 * кэшами; добавление новой подсистемы не требует правок существующих.
 */
export interface RenderSubsystem {
  readonly name: string;
  init(ctx: RenderContext): void;
  /** Синхронизация с тиком: view скопирован и валиден до следующего syncTick. */
  syncTick(view: TickView): void;
  /** Покадровое обновление: dt — секунды с прошлого кадра, alpha — доля тика [0..1] (REND-2). */
  updateFrame(dt: number, alpha: number): void;
}

// ------------------------------------------------------------ конфиг хоста

export interface RenderHostConfig {
  /** Длительность тика в секундах — знаменатель альфы интерполяции (REND-2). */
  readonly tickSeconds: number;
  /**
   * Визуальный тип сущности — ключ манифеста визуалов; null — не рисовать.
   * Ядро не хранит имя prefab'а на сущности, поэтому связь задаёт вызывающий;
   * практичный резолвер — `kindByTags` по тегам prefab'а.
   */
  readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  /** Компонент скорости; конвенция физики ядра — 'Velocity' с полями x/y. */
  readonly velocityComponent?: string;
  /** Скачок позиции за тик больше этого (мировых единиц) — телепорт, snap (REND-2). */
  readonly snapDistance?: number;
  /** Порог скорости (мировых единиц за тик) для состояния `move` (REND-4). */
  readonly moveEpsilon?: number;
  /** Сетка террейна сцены — уровень под сущностями и зеркало карты пола (REND-7). */
  readonly terrainGrid?: TerrainGrid;
  /** Типы событий, несущие направление атаки/каста для bone-контроля (REND-5). */
  readonly aimEvents?: readonly string[];
  /** Сколько тиков держится направление каста, прежде чем цель протухнет. */
  readonly aimHoldTicks?: number;
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
}
