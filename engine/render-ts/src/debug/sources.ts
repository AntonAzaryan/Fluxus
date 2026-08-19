/**
 * Отладочные источники движка, которыми не владеет ни одна подсистема
 * (`render-debug` RDBG-1): состояние доставки и интерполяции и читатель
 * счётчиков стоимости.
 *
 * Подсистема объявляет свои источники в точке регистрации (REND-27); эти два
 * показывают то, что живёт в шве между доставкой и кадром, — их регистрирует
 * встраивающая сборка, ровно как свои собственные. Механизм от этого не
 * меняется: реестр открыт (RDBG-1), и «источник движка» отличается от «источника
 * игры» только тем, кто его написал.
 */
import {
  COST_COUNTER_STAGES,
  attachCostSink,
  costSink,
  createCostCounters,
  releaseCostSink,
  type CostStage,
  type RenderCostCounters,
} from '../cost.js';
import type { EntityId } from '@game-mvp/core';
import {
  DebugRows,
  type DebugColor,
  type DebugDraw,
  type DebugFrameState,
  type DebugList,
  type DebugProbe,
  type DebugSource,
} from './contract.js';

// -------------------------------------------------- доставка и интерполяция

/** Почему сущность нарисована без интерполяции (REND-2). */
export type DebugSnapReason = 'none' | 'worldSnap' | 'replay' | 'spawn' | 'teleport';

/** Одна сущность доставки глазами отладки: два доставленных тика против кадра. */
export interface DebugDeliveryRow {
  entity: EntityId;
  kind: string | null;
  /** Позиция ПРЕДЫДУЩЕГО доставленного тика, мировые единицы. */
  prevTickWorldX: number;
  prevTickWorldY: number;
  /** Позиция ПОСЛЕДНЕГО доставленного тика, мировые единицы. */
  currTickWorldX: number;
  currTickWorldY: number;
  /** Интерполированная позиция кадра — то, что видит игрок (REND-2). */
  frameWorldX: number;
  frameWorldY: number;
  /** Уровень террейна на тех же двух тиках (TERR-4 производное). */
  prevLevel: number;
  currLevel: number;
  snapReason: DebugSnapReason;
  /** Фаза манёвра последнего тика; NaN выражен как null — «фазы нет» (REND-12). */
  motionPhase: number | null;
  flightPhase: number | null;
}

export interface DebugDeliveryProbe extends DebugProbe {
  readonly tick: number;
  readonly worldMode: string;
  readonly isReplay: boolean;
  /** Разрыв непрерывности ВСЕГО мира на этой доставке (REND-2). */
  readonly worldSnap: boolean;
  readonly freshEvents: boolean;
  readonly entityCount: number;
  readonly snappedCount: number;
  readonly spawnedCount: number;
  readonly eventCount: number;
  readonly statNames: readonly string[];
  /** Перечень сущностей с потолком (RDBG-7). */
  readonly entities: DebugList<DebugDeliveryRow>;
}

export interface DeliverySourceOptions {
  /** Потолок перечня сущностей (RDBG-7); величина потолка — политика источника. */
  readonly cap?: number;
  /** Цвет доставленных позиций и цвет позиции кадра. */
  readonly deliveredColor?: DebugColor;
  readonly frameColor?: DebugColor;
  /** Цвет отметки сущности, нарисованной без интерполяции. */
  readonly snapColor?: DebugColor;
}

const DELIVERY_CAP = 64;
const DELIVERY_MARK_RADIUS = 0.18;
const DEFAULT_DELIVERED_COLOR = 0x4090ff;
const DEFAULT_FRAME_COLOR = 0x60ff90;
const DEFAULT_SNAP_COLOR = 0xff5050;
/** Сглаживание оценки каденса доставки: величина часовая (RDBG-7). */
const SPAN_SMOOTHING = 0.25;

function snapReasonOf(
  worldSnap: boolean,
  isReplay: boolean,
  spawned: boolean,
  snap: boolean,
): DebugSnapReason {
  if (worldSnap) return 'worldSnap';
  if (isReplay) return 'replay';
  if (spawned) return 'spawn';
  return snap ? 'teleport' : 'none';
}

/** NaN как отсутствие значения (REND-12) — в дампе это null, а не «ноль». */
function orNull(value: number): number | null {
  return Number.isNaN(value) ? null : value;
}

/**
 * Источник состояния доставки и интерполяции (`net.delivery`, RDBG-1): позиции
 * двух доставленных тиков против той, которую видит игрок, причина снапа, режим
 * мира и каденс доставки.
 *
 * Режим мира включает `Rewinding` (REND-25) — он приезжает доставкой как есть.
 * ЭПОХИ здесь нет, и это не упущение: до главного потока эпоха не едет вовсе, а
 * признак разрыва непрерывности приносит сама доставка (`snapAll`, `snap`).
 * Выдумывать её по косвенным признакам значило бы показывать не то, что знает
 * клиент (RDBG-6).
 *
 * Каденс доставки — часовая величина (RDBG-7): он уезжает в секцию `clock`, а
 * не в тело секции, и наблюдается пассивно — по номеру доставленного тика, как
 * его наблюдает probe бенча (PERF-7). Своих сообщений в канал оболочки источник
 * не добавляет (SHELL-3).
 */
export function deliveryDebugSource(
  options: DeliverySourceOptions = {},
): DebugSource<DebugDeliveryProbe> {
  const rows = new DebugRows<DebugDeliveryRow>(options.cap ?? DELIVERY_CAP, () => ({
    entity: 0,
    kind: null,
    prevTickWorldX: 0,
    prevTickWorldY: 0,
    currTickWorldX: 0,
    currTickWorldY: 0,
    frameWorldX: 0,
    frameWorldY: 0,
    prevLevel: 0,
    currLevel: 0,
    snapReason: 'none',
    motionPhase: null,
    flightPhase: null,
  }));
  const delivered = options.deliveredColor ?? DEFAULT_DELIVERED_COLOR;
  const frameColor = options.frameColor ?? DEFAULT_FRAME_COLOR;
  const snapColor = options.snapColor ?? DEFAULT_SNAP_COLOR;
  const clock = { spanTicks: 0, lastTick: Number.NaN };
  /**
   * Имена статов доставки — СВОЙ массив, а не массив доставки (RDBG-2): проба
   * самодостаточна, ссылок на живые структуры рендера не несёт. Массив тот же
   * между пробами, переписывается его содержимое (REND-26).
   */
  const statNames: string[] = [];
  // Переиспользуемая проба (RDBG-2): поля переписываются, объект живёт.
  const probe = {
    tick: -1,
    worldMode: 'none',
    isReplay: false,
    worldSnap: false,
    freshEvents: false,
    entityCount: 0,
    snappedCount: 0,
    spawnedCount: 0,
    eventCount: 0,
    statNames: statNames as readonly string[],
    entities: rows.list,
    clock: { deliverySpanTicks: 0 },
    noData: undefined as string | undefined,
  };

  return {
    id: 'net.delivery',
    title: 'доставка и интерполяция',
    probe(state: DebugFrameState): DebugDeliveryProbe {
      const view = state.view;
      if (view === null) {
        probe.noData = 'доставок ещё не было: presentation-состояния у клиента нет';
        return probe;
      }
      probe.noData = undefined;
      // Наблюдение каденса идемпотентно: повторная проба на том же тике его не
      // двигает, иначе два дампа на одном входе разошлись бы (RDBG-7).
      if (view.tick !== clock.lastTick) {
        const span = Number.isNaN(clock.lastTick) ? 1 : Math.abs(view.tick - clock.lastTick);
        clock.spanTicks =
          clock.spanTicks === 0 ? span : clock.spanTicks + (span - clock.spanTicks) * SPAN_SMOOTHING;
        clock.lastTick = view.tick;
      }
      probe.tick = view.tick;
      probe.worldMode = view.mode;
      probe.isReplay = view.isReplay;
      probe.worldSnap = view.snapAll;
      probe.freshEvents = view.freshEvents;
      probe.entityCount = view.entities.size;
      probe.eventCount = view.events.length;
      // Копия, а не ссылка: массив доставки живёт в буфере вида и переживает
      // кадр, а проба обязана быть самодостаточной (RDBG-2).
      statNames.length = view.statNames.length;
      for (let i = 0; i < view.statNames.length; i += 1) statNames[i] = view.statNames[i]!;
      probe.clock.deliverySpanTicks = clock.spanTicks;
      let snapped = 0;
      let spawned = 0;
      rows.begin();
      for (const entity of view.entities.values()) {
        if (entity.snap) snapped += 1;
        if (entity.spawned) spawned += 1;
        const row = rows.next();
        if (row === null) continue;
        row.entity = entity.id;
        row.kind = entity.kind;
        row.prevTickWorldX = entity.prevX;
        row.prevTickWorldY = entity.prevY;
        row.currTickWorldX = entity.currX;
        row.currTickWorldY = entity.currY;
        row.frameWorldX = entity.prevX + (entity.currX - entity.prevX) * state.alpha;
        row.frameWorldY = entity.prevY + (entity.currY - entity.prevY) * state.alpha;
        row.prevLevel = entity.prevLevel;
        row.currLevel = entity.currLevel;
        row.snapReason = snapReasonOf(view.snapAll, view.isReplay, entity.spawned, entity.snap);
        row.motionPhase = orNull(entity.currMotionPhase);
        row.flightPhase = orNull(entity.flightPhase);
      }
      rows.end();
      probe.snappedCount = snapped;
      probe.spawnedCount = spawned;
      return probe;
    },
    draw(value: DebugDeliveryProbe, out: DebugDraw): void {
      for (const row of value.entities.items) {
        const color = row.snapReason === 'none' ? delivered : snapColor;
        out.circle(row.prevTickWorldX, row.prevTickWorldY, DELIVERY_MARK_RADIUS, color);
        out.circle(row.currTickWorldX, row.currTickWorldY, DELIVERY_MARK_RADIUS, color);
        out.disc(row.frameWorldX, row.frameWorldY, DELIVERY_MARK_RADIUS / 2, frameColor);
      }
    },
  };
}

// ------------------------------------------------------ счётчики стоимости

export interface DebugCostProbe extends DebugProbe {
  /** Кто держит сток: собственный слоя, чужой замер или никакой. */
  readonly sink: 'own' | 'foreign' | 'none';
}

/**
 * Источник счётчиков стоимости (`cost.counters`, PERF-3) — их ЧИТАТЕЛЬ, а не
 * второй писатель (RDBG-8).
 *
 * Сток счётчиков — одна переменная уровня модуля с обменом «поставил — вернул
 * предыдущий» (`cost.ts`), и двух одновременных владельцев ей противопоказано.
 * Поэтому источник подключает СВОЙ сток, только пока он включён И пока никакого
 * другого нет: рядом с замером (голден-гейт стоимости, бенч) он работает
 * читателем чужого. Так «никогда не работает рядом с замером» перестаёт быть
 * договорённостью и становится устройством кода — а значения счётчиков от
 * включения показа не меняются (RDBG-8): учёт делает исполняемой запись работы,
 * которая происходит и так, а не добавляет работы.
 *
 * Собственных инкрементов у отладки нет ни одного: примесь отладки в счётчиках
 * сделала бы эталон `*.cost.json` (PERF-4) зависящим от настроек разработчика.
 */
export function costCountersDebugSource(): DebugSource<DebugCostProbe> {
  const own = createCostCounters();
  let holding = false;
  const stages: Record<CostStage, Record<string, number>> = { syncTick: {}, frame: {} };
  const probe = {
    sink: 'none' as 'own' | 'foreign' | 'none',
    syncTick: stages.syncTick,
    frame: stages.frame,
    noData: undefined as string | undefined,
  };

  return {
    id: 'cost.counters',
    title: 'счётчики стоимости по подсистемам',
    toggle(enabled: boolean): void {
      if (enabled) {
        // Чужой сток уже подключён — значит идёт замер: встать рядом с ним
        // нельзя, и источник остаётся его читателем (design D8). Своё место
        // источник занимает только пустым, поэтому и отпускает его в пустоту.
        if (costSink() !== undefined) return;
        attachCostSink(own);
        holding = true;
        return;
      }
      if (!holding) return;
      holding = false;
      // Отпустить, а не «вернуть предыдущий»: пока источник был включён, поверх
      // него мог встать замер, и `attachCostSink` отобрал бы у него сток
      // посреди измерения. `releaseCostSink` снимает свой сток, только если он
      // ещё свой, а иначе помечает его отпущенным — и `finally` замера положит
      // на его место пустоту (RDBG-4: выключенный источник не стоит ничего).
      releaseCostSink(own);
    },
    probe(): DebugCostProbe {
      const sink = costSink();
      if (sink === undefined) {
        probe.noData = 'сток счётчиков не подключён: считать нечему (PERF-3)';
        probe.sink = 'none';
        return probe;
      }
      probe.noData = undefined;
      probe.sink = sink === own ? 'own' : 'foreign';
      // Счётчики раскладываются СТАДИЕЙ конвейера (PERF-2), а не догадкой о
      // смысле имени: атрибуцию несёт таблица стадий рендера.
      for (const [name, stage] of Object.entries(COST_COUNTER_STAGES)) {
        stages[stage][name] = sink[name as keyof RenderCostCounters];
      }
      return probe;
    },
  };
}
