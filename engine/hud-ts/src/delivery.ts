/**
 * Доставленное состояние глазами HUD (HUD-1, HUD-5): HUD — чистый наблюдатель
 * того, что оболочка доставила главному потоку (SHELL-2, SHELL-4), и читает
 * его в той же точке, что подсистемы рендера, — `RemoteHost.register`
 * (design Decision 6). Доступа к `WorldState` нет по построению: всё, чего
 * здесь не хватает виджету, добавляется в плоскую форму на стороне воркера.
 *
 * Типы — структурные подмножества `TickView`/`EntityView`/`RenderEvent` из
 * `render-ts`, продублированные сознательно: зависимость пакета — только
 * `@game-mvp/client` (proposal), а структурная типизация TS делает адаптер
 * HUD совместимым с `RemoteHost.register` без импорта типов рендера. Сужение
 * здесь — и контракт: селекторы видят ровно перечисленное, а не весь
 * presentation-срез.
 */

export type HudWorldMode = 'Running' | 'Paused' | 'Rewinding';

/** Reliable-событие с номером своего тика (SHELL-4): основа «ровно один раз» HUD-5. */
export interface HudDeliveredEvent {
  readonly type: string;
  /** Тик события: одна доставка может нести события нескольких тиков (HUD-5). */
  readonly tick?: number;
  /** Полезная нагрузка «как эмитировала система»; координатные поля — Q16.16 (см. render-ts). */
  readonly data: Readonly<Record<string, number>>;
}

/**
 * Подмножество presentation-среза сущности, доступное селекторам HUD.
 *
 * Запись — ЖИВОЙ объект продюсера доставки (как `EntityView` render-ts):
 * стабилен на всё время жизни сущности, но его поля мутируются продюсером на
 * каждой доставке. Селектор, удерживающий данные между доставками (график,
 * история значений), обязан скопировать нужные поля — ссылка «протухает» на
 * следующей доставке, превращаясь в текущее состояние.
 */
export interface HudEntityView {
  readonly id: number;
  /** Визуальный тип (ключ манифеста визуалов); null — сущность не рисуется. */
  readonly kind: string | null;
  /** Позиция последнего доставленного тика (float, мировые единицы). */
  readonly currX: number;
  readonly currY: number;
  readonly currLevel: number;
  /** Разрыв непрерывности сущности в этом тике (спавн, телепорт): снап (HUD-5). */
  readonly snap: boolean;
  readonly spawned: boolean;
  readonly moving: boolean;
}

/**
 * Доставленное состояние одного вызова подписки — то, над чем считаются
 * селекторы (HUD-4). Скрытое туманом войны сюда не попадает по построению:
 * снапшот отфильтрован в симуляции (HUD-1, NET-12).
 *
 * Владеет объектом продюсер доставки, и он ЖИВОЙ: сам объект и записи его
 * `entities` мутируются продюсером между доставками (см. `HudEntityView`),
 * `events`/`floorChangedCells` валидны до следующей доставки. Внутри вызова
 * селектора читать можно всё; удерживать за его пределами — только копию.
 */
export interface HudDeliveredState {
  readonly tick: number;
  readonly mode: HudWorldMode;
  readonly isReplay: boolean;
  /** Разрыв непрерывности всего мира (SHELL-7): виджетам — снап, не доигрывание. */
  readonly snapAll: boolean;
  /** Первый честный проход тика: события можно проигрывать (OBS-5, дедуп у потребителя). */
  readonly freshEvents: boolean;
  readonly entities: ReadonlyMap<number, HudEntityView>;
  /** События всех тиков с прошлой доставки, каждое со своим тиком (SHELL-4). */
  readonly events: readonly HudDeliveredEvent[];
  /** Зеркало карты пола (1 — пол есть), row-major; null — сцена без террейна (SHELL-5). */
  readonly floorBits: Uint8Array | null;
  /** Клетки, чей пол изменился с прошлой доставки, — дельты для миникарты (HUD-6). */
  readonly floorChangedCells: readonly number[];
}

/**
 * Форма подписки HUD на доставку: структурно совместима с `RenderSubsystem`
 * рендера, поэтому объект регистрируется в `RemoteHost.register` наравне с
 * подсистемами (design Decision 6) — второй точки доставки у HUD нет (HUD-1).
 */
export interface HudDeliverySubsystem {
  readonly name: string;
  init(): void;
  /** Одна доставка — один вызов: состояние conflatable, каденс — доставки (HUD-5). */
  syncTick(view: HudDeliveredState): void;
  updateFrame(dt: number, alpha: number): void;
}
