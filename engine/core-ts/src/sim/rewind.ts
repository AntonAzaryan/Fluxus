/**
 * Машина состояний мира и перемотка (WSM-1..6, REW-1..11).
 *
 * Здесь только МЕХАНИЗМ: переходы и `seekTo`. Ульта отката — кто инициирует,
 * какой cooldown, какая стоимость, на сколько отматывает, есть ли автостоп —
 * политика, то есть JSON-система поверх этих четырёх вызовов (WSM-5). Ни
 * одного балансного числа в этом файле нет и быть не должно.
 */
import {
  componentSchema,
  getField,
  hasComponent,
  isAlive,
  setField,
} from '../ecs/world.js';
import { query } from '../ecs/query.js';
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

/**
 * Компонент-маркер вне отката (REW-9, вторая форма): переживают ВСЕ его поля у
 * КАЖДОЙ сущности, владеющей им на момент восстановления. Сущности заранее не
 * перечисляются — состав игроков матча известен только после построения мира, а
 * конфигурировать перемотку приходится до него.
 *
 * Сущность, которой в восстановленном мире нет, значение теряет — как и в
 * пофилдовой форме: умерший не уносит cooldown в прошлое.
 */
export interface ExemptComponent {
  readonly component: string;
}

/** Запись exempt-списка в любой из двух форм (REW-9). */
export type ExemptEntry = ExemptField | ExemptComponent;

export interface RewindOptions {
  readonly history: HistoryProvider;
  readonly inputs: InputLog;
  /** Поля и компоненты вне отката, например cooldown самой ульты (REW-9). */
  readonly exempt?: readonly ExemptEntry[];
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

/** Снятые до восстановления значения компонента-маркера: сущность и её поля. */
interface PreservedOwner {
  readonly entity: EntityId;
  readonly values: readonly number[];
}

const isFieldForm = (entry: ExemptEntry): entry is ExemptField => 'entity' in entry;

export function createRewindController(
  sim: Simulation,
  state: SimulationState,
  options: RewindOptions,
): RewindController {
  const { history, inputs } = options;
  const exempt = options.exempt ?? [];
  const exemptFields = exempt.filter(isFieldForm);
  const exemptComponents = exempt.filter((entry): entry is ExemptComponent => !isFieldForm(entry));

  // Поле могло исчезнуть вместе с сущностью — тогда сохранять и возвращать нечего.
  const readable = (field: ExemptField): boolean =>
    isAlive(state.world, field.entity) && hasComponent(state.world, field.entity, field.component);
  const readExempt = (): (number | undefined)[] =>
    exemptFields.map((field) => (readable(field) ? getField(state.world, field.entity, field.component, field.field) : undefined));

  /**
   * Имена полей компонента-маркера в порядке схемы. Считаются один раз: схема
   * компонентов мира неизменна за прогон (ECS-3), а `seekTo` зовётся по кадру
   * рассылки — перечислять ключи схемы на каждом шаге скраба незачем.
   */
  const exemptComponentFields = exemptComponents.map((entry) => {
    const schema = componentSchema(state.world, entry.component);
    if (schema === undefined) {
      throw new Error(`REW-9: exempt-компонент "${entry.component}" не объявлен в мире`);
    }
    return Object.keys(schema.fields);
  });

  const readExemptComponents = (): PreservedOwner[][] =>
    exemptComponents.map((entry, i) => {
      const fields = exemptComponentFields[i]!;
      // Владельцы берутся из ТЕКУЩЕГО, ещё не откаченного мира: смысл формы в
      // том, что перечня сущностей у конфигурации нет (REW-9).
      const owners: PreservedOwner[] = [];
      for (const entity of query(state.world, { all: [entry.component] })) {
        owners.push({
          entity,
          values: fields.map((field) => getField(state.world, entity, entry.component, field)),
        });
      }
      return owners;
    });

  /**
   * Возврат снятых значений компонента-маркера после реплея (REW-9).
   *
   * Порядок полей здесь — порядок `Object.keys(schema.fields)`, и он СИММЕТРИЧЕН:
   * снятие и запись идут по одному и тому же списку `exemptComponentFields`, а
   * наружу — в снапшот, на провод, в канонический лог — этот массив не уходит
   * вовсе. Поэтому порт на Rust вправе перечислять поля любым своим стабильным
   * порядком: наблюдаемого расхождения из-за него не возникает, в отличие от
   * порядка компонентов в снапшоте, который задаёт битовые id (SER-7).
   */
  const writeExemptComponents = (preserved: readonly PreservedOwner[][]): void => {
    for (let i = 0; i < exemptComponents.length; i++) {
      const component = exemptComponents[i]!.component;
      const fields = exemptComponentFields[i]!;
      for (const owner of preserved[i]!) {
        // Сущности, которой в восстановленном мире нет (или которая потеряла
        // компонент), значение не возвращается: писать некуда.
        if (!isAlive(state.world, owner.entity)) continue;
        if (!hasComponent(state.world, owner.entity, component)) continue;
        for (let f = 0; f < fields.length; f++) {
          setField(state.world, owner.entity, component, fields[f]!, owner.values[f]!);
        }
      }
    }
  };

  /*
   * Кэша последнего восстановленного состояния здесь нет — он был написан и
   * снят (design, Decision 3). Обслужить он мог только скраб ВПЕРЁД внутри
   * одной перемотки, а шаг ведения точки (REW-13) ходит назад: состояние тика T
   * основанием для тика T − k не бывает. За эту недостижимую ветвь каждый
   * `seekTo` платил полной копией мира плюс снимком RNG, шины и тегов, а сам
   * кэш держал ещё один мир в памяти на всё время матча.
   */

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
      const preservedOwners = readExemptComponents();

      // Компенсации режима здесь нет и не нужно: `restoreSnapshot` машину
      // состояний не трогает (REW-2), поэтому мир остаётся в `Rewinding`, в
      // который его перевёл `beginRewind` (WSM-2, WSM-5). Многократный `seekTo`
      // подряд (REW-7) поэтому и корректен.
      restoreSnapshot(state, snapshot);

      // Доигрывание вперёд по каноническим вводам (REW-2). Реплеевые тики
      // помечены `isReplay`, чтобы внешние потребители их не дублировали (WSM-6).
      while (state.tick < reachable) {
        advance(sim, state, inputs.at(state.tick + 1), true);
      }

      for (let i = 0; i < exemptFields.length; i++) {
        const value = preserved[i];
        const field = exemptFields[i]!;
        if (value !== undefined && readable(field)) {
          setField(state.world, field.entity, field.component, field.field, value);
        }
      }
      writeExemptComponents(preservedOwners);
    },
  };
}
