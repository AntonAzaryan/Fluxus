/**
 * Контракты рендера (REND-1..13). Рендер — внешний наблюдатель симуляции:
 * единственный вход ДАННЫХ СИМУЛЯЦИИ — `TickResult` через `RenderHost.onTick`,
 * единственный выход — сцена Three.js. Иного канала к идущему миру нет: мир
 * помимо `TickResult` не читается, мутирующие API не вызываются, зависимостью
 * ядра рендер не является. Ядро о рендере не знает.
 *
 * Несимуляционные входы у пакета есть, и их набор закрыт (REND-1):
 * presentation-ассеты через `AssetService` (манифест визуалов ASSET-6, карта
 * кривизны ASSET-7); сцена и сетка террейна при инициализации подсистем
 * (REND-8), в воркер-сборке доставленные хендшейком оболочки (SHELL-5);
 * документный набор инстансов (REND-11, `documentSource.ts`) — второй продюсер
 * presentation-состояния, взаимоисключающий с потоком тиков; конфиг рендера
 * (шаг высоты REND-7) и поза камеры (CAM-1). Ни один из них не ведёт обратно в
 * мир и не несёт данных, влияющих на симуляцию (ASSET-1).
 *
 * Все величины здесь — float в мировых единицах. Конверсия Q16.16 → float идёт
 * на входной границе и глубже не проникает (REND-1): у потока тиков — в
 * `extractor.ts`, у прочих входов — в точке приёма (`tileSize` и cliff-отрезки
 * сетки в `subsystems/terrain.ts`, `visualSurface.ts` и `camera/rig.ts`).
 * Норма исключений из этого не знает, а код одно расхождение с ней имеет —
 * сырая полезная нагрузка события (`RenderEvent.data`, см. ниже): дефект
 * реализации, ждущий своего change'а, а не легальная оговорка.
 * Обратной конверсии float → fixed в потоке рендера не существует:
 * квантование авторских величин с экрана делает редактор вызовом ядра, до
 * записи в документ и вне этого пакета (`editor` ED-1, ED-16).
 */
import type * as THREE from 'three';
import type { EntityId, TerrainGrid, WorldMode, WorldState } from '@game-mvp/core';
import type { AssetService } from '@game-mvp/assets';
// Только тип: цикл `types` ↔ `stage` стирается компиляцией и в рантайме не существует.
import type { PresentationStage } from './stage.js';

// ------------------------------------------------- presentation-состояние

/**
 * Presentation-срез одной сущности: два последних тика для интерполяции
 * (REND-2) плюс производные признаки для анимаций (REND-4, REND-5).
 * Объект стабилен на всё время жизни сущности — подсистемы могут держать
 * ссылку; мутирует его продюсер presentation-состояния и только он: поток
 * тиков — в `ViewBuffer.apply` из `RenderHost.onTick`, документный набор —
 * в `DocumentSource.apply` (REND-11). Подсистеме, который из них, не видно.
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
  /**
   * Состояние машины локомоушена на последнем тике (`LOCOMOTION_*` ядра,
   * LOC-3): из него берётся состояние анимации манёвра (REND-4).
   */
  motion: number;
  /**
   * Фаза манёвра на тех же двух тиках, что позиция, — доля пройденных тиков
   * манёвра; `NaN` — манёвра на этом тике не было. Вход дуги прыжка (REND-12).
   */
  prevMotionPhase: number;
  currMotionPhase: number;
  /** Override уровня (TERR-4): сущность не «на поверхности», наклон не применяется (REND-10). */
  levelOverride: boolean;
  /** Последний курс движения, радианы; сохраняется, пока сущность стоит. */
  facingYaw: number;
  /** Направление последнего каста/атаки, радианы; null — цель протухла (REND-5). */
  aimYaw: number | null;
  /**
   * Битовая маска состояний сущности: бит i — присутствие i-й компоненты из
   * `stateComponents` конфига Extractor'а. Потребитель — длящиеся эффекты
   * камеры (CAM-6, ASSET-8).
   */
  states: number;
  /**
   * Клип, назначенный набором инстансов (REND-11): играет зацикленно поверх
   * состояния. `undefined` — клип производен от состояния сущности (REND-4);
   * поток тиков поле не заполняет никогда.
   */
  clip?: string;
  /**
   * Скин, назначенный набором инстансов (REND-11): смена обновляет материалы
   * существующего инстанса (REND-6). `undefined` — скином правит потребитель
   * (`ModelsSubsystem.setSkin`), и поток тиков поле не заполняет.
   */
  skin?: string;
  /**
   * Множитель масштаба поверх масштаба записи манифеста (REND-11); `undefined`
   * — масштаб целиком из записи (ASSET-6).
   */
  scale?: number;
}

/** Копия события тика: переживает `dispatch()`, в отличие от view ядра (OBS-3). */
export interface RenderEvent {
  readonly type: string;
  /** Тик, в котором событие произошло: при доставке каналом оболочки view может нести события нескольких тиков (SHELL-4). */
  readonly tick?: number;
  /**
   * Полезная нагрузка события — как её эмитировала система, поле в поле. Здесь
   * fixed-point переживает входную границу (REND-1): координатные поля (`x`/`y`,
   * `dirX`/`dirY`) приезжают в Q16.16 и делятся на `FIXED_ONE` у потребителя
   * (`camera/director.ts`). Перенести конверсию на границу нечем: какие поля
   * события координатные, знает содержимое, а не рендер, — схема события задана
   * контентом. Расхождение с инвариантом REND-1 известное и требует своего
   * change'а (нормировать «координатные поля события» либо приводить их в
   * Extractor'е по объявленной схеме), а не расширения нормы по факту.
   */
  readonly data: Readonly<Record<string, number>>;
}

/**
 * Presentation-состояние, передаваемое подсистемам в `syncTick`. Владеет им
 * продюсер, который его наполнил (REND-11): `RenderHost`/`ViewBuffer` у потока
 * тиков, `DocumentSource` у документного набора. В отличие от `TickResult`
 * ядра, данные скопированы и валидны до следующего `syncTick`.
 *
 * Поля, производные от тика (`events`, `freshEvents`, `snapAll`, `floorBits`),
 * документный продюсер не наполняет ничем: интерполяции, событий и фильтра
 * видимости в режиме правки нет (REND-11).
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
   * Сцена подсистем, разделяемая с другим продюсером presentation-состояния
   * (REND-11): её передаёт редактор, чтобы вьюпорт и превью (ED-9) кормили одни
   * и те же подсистемы. По умолчанию хост заводит свою — в игровом клиенте
   * второго продюсера не существует.
   */
  readonly stage?: PresentationStage;
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
  /** Компоненты, зеркалируемые в `EntityView.states` (эффекты камеры, CAM-6). */
  readonly stateComponents?: readonly string[];
  /** Имена компонентов локомоушена (LOC-1); дефолты — как у системы ядра. */
  readonly locomotion?: { readonly stateComponent?: string; readonly configComponent?: string };
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
}
