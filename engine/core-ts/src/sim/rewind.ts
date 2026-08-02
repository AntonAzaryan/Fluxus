/**
 * Машина состояний мира и перемотка (WSM-1..6, REW-1..11).
 *
 * Здесь только МЕХАНИЗМ: переходы и `seekTo`. Ульта отката — кто инициирует,
 * какой cooldown, какая стоимость, на сколько отматывает, есть ли автостоп —
 * политика, то есть JSON-система поверх этих четырёх вызовов (WSM-5). Ни
 * одного балансного числа в этом файле нет и быть не должно.
 */
import { getField, hasComponent, isAlive, setField } from '../ecs/world.js';
import { advance, restoreSnapshot } from './tick.js';
import type { Simulation } from './tick.js';
import type {
  EntityId,
  HistoryProvider,
  InputFrame,
  SimulationState,
  WorldMode,
} from '../types.js';

/**
 * Канонические вводы тика (TICK-2). Реплей обязан идти по ним, иначе
 * восстановленное состояние разойдётся с исходным (REW-2, DET-1).
 */
export interface InputLog {
  record(tick: number, inputs: readonly InputFrame[]): void;
  at(tick: number): readonly InputFrame[];
}

const NO_INPUTS: readonly InputFrame[] = [];

/**
 * Лог вводов с ограниченной глубиной: дальше буфера истории вводы всё равно
 * бесполезны — снапшота, от которого их проигрывать, уже нет (SNAP-3).
 */
export function createInputLog(keep = 1024): InputLog {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('InputLog: "keep" — целое ≥ 1');
  const frames = new Map<number, readonly InputFrame[]>();
  return {
    record(tick, inputs) {
      frames.set(tick, inputs);
      frames.delete(tick - keep);
    },
    at: (tick) => frames.get(tick) ?? NO_INPUTS,
  };
}

/**
 * Поле, переживающее откат (REW-9). Точечное исключение на восстановлении, а
 * не фильтр записи: значение снимается с живого мира до восстановления и
 * возвращается после реплея.
 */
export interface ExemptField {
  readonly entity: EntityId;
  readonly component: string;
  readonly field: string;
}

export interface RewindOptions {
  readonly history: HistoryProvider;
  readonly inputs: InputLog;
  /** Поля вне отката, например cooldown самой ульты (REW-9). */
  readonly exempt?: readonly ExemptField[];
}

/** Core-API переходов (WSM-5). Политика зовёт эти четыре метода и ничего больше. */
export interface RewindController {
  readonly mode: WorldMode;
  /** `Running → Paused` либо `Rewinding → Paused` (WSM-2, WSM-3). */
  pause(): void;
  /** `Paused → Running` — продолжить с текущего, в том числе перемотанного, тика. */
  resume(): void;
  /** `Paused → Rewinding`. Из `Running` напрямую нельзя (WSM-2), из `Rewinding` — тоже (REW-8). */
  beginRewind(): void;
  /** Восстанавливает полное состояние целевого тика (REW-2). Только в `Rewinding`. */
  seekTo(tick: number): void;
}

export function createRewindController(
  sim: Simulation,
  state: SimulationState,
  options: RewindOptions,
): RewindController {
  const { history, inputs } = options;
  const exempt = options.exempt ?? [];

  // Поле могло исчезнуть вместе с сущностью — тогда сохранять и возвращать нечего.
  const readable = (field: ExemptField): boolean =>
    isAlive(state.world, field.entity) && hasComponent(state.world, field.entity, field.component);
  const readExempt = (): (number | undefined)[] =>
    exempt.map((field) => (readable(field) ? getField(state.world, field.entity, field.component, field.field) : undefined));

  return {
    get mode() {
      return state.mode;
    },

    pause() {
      if (state.mode === 'Paused') return;
      state.mode = 'Paused';
    },

    resume() {
      if (state.mode !== 'Paused') {
        throw new Error(`WSM-2: выйти в Running можно только из Paused, а мир в ${state.mode}`);
      }
      state.mode = 'Running';
    },

    beginRewind() {
      if (state.mode === 'Rewinding') {
        throw new Error('REW-8: перемотка внутри перемотки запрещена');
      }
      if (state.mode !== 'Paused') {
        throw new Error(`WSM-2: вход в Rewinding только через Paused, а мир в ${state.mode}`);
      }
      state.mode = 'Rewinding';
    },

    seekTo(target) {
      if (state.mode !== 'Rewinding') {
        throw new Error(`WSM-5: seekTo доступен только в Rewinding, а мир в ${state.mode}`);
      }
      if (!Number.isInteger(target) || target < 0) throw new Error('seekTo: тик — целое ≥ 0');

      const snapshot = history.nearest(target);
      if (snapshot === undefined) throw new Error('REW-1: история пуста, отматывать не от чего');
      // Запрос глубже буфера упирается в самый старый доступный тик (REW-1).
      const reachable = Math.max(target, snapshot.tick);

      const preserved = readExempt();

      restoreSnapshot(state, snapshot);
      // `restoreSnapshot` вернул и режим снапшота — но мы всё ещё перематываем.
      state.mode = 'Rewinding';

      // Доигрывание вперёд по каноническим вводам (REW-2). Реплеевые тики
      // помечены `isReplay`, чтобы внешние потребители их не дублировали (WSM-6).
      while (state.tick < reachable) {
        advance(sim, state, inputs.at(state.tick + 1), true);
      }

      for (let i = 0; i < exempt.length; i++) {
        const value = preserved[i];
        const field = exempt[i]!;
        if (value !== undefined && readable(field)) {
          setField(state.world, field.entity, field.component, field.field, value);
        }
      }
    },
  };
}
