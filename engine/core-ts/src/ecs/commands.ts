/**
 * Command Buffer (CMD-1..5): единственный канал мутаций для систем (DET-7).
 * Команды копятся в плоском списке в порядке создания и применяются в том же
 * порядке на flush (CMD-3) — до flush world не меняется, поэтому Query внутри
 * системы видит состояние на её начало (CMD-5, QUERY-3). flush per-system
 * вызывает планировщик (CMD-2), сам буфер за это не отвечает.
 *
 * flush идёт двумя проходами — сначала проверка всего буфера, потом применение
 * (SYS-9): единица атомарности — система, и отказ на десятой команде из двадцати
 * не вправе оставить в мире первые девять.
 */
import type { CommandOutcome, CommandBuffer, EntityId, FieldOverrides, WorldState } from '../types.js';
import { countCommands, nextSeq, record, traceFull, type DiagnosticsContext } from '../debug.js';
import * as world from './world.js';

/**
 * `seq` — номер записи трейса, зарезервированный при ЗАКАЗЕ команды (DIAG-2):
 * порядок задаётся моментом создания, а не моментом применения, иначе взаимный
 * порядок команд и событий внутри системы был бы искажён. Поле появляется
 * только при полном уровне трейса, при выключенном его нет.
 */
interface Traced { seq?: number }

type Command = Traced &
  (
    | { readonly kind: 'spawn'; readonly prefab: string; readonly overrides?: FieldOverrides }
    | { readonly kind: 'destroy'; readonly entity: EntityId }
    | {
        readonly kind: 'addComponent';
        readonly entity: EntityId;
        readonly component: string;
        readonly values?: Readonly<Record<string, number>>;
      }
    | { readonly kind: 'removeComponent'; readonly entity: EntityId; readonly component: string }
    | {
        readonly kind: 'setField';
        readonly entity: EntityId;
        readonly component: string;
        readonly field: string;
        readonly value: number;
      }
  );

/** Данные записи о команде (DIAG-2): только скаляры, ссылок на мир нет (DIAG-4). */
function commandData(cmd: Command): Readonly<Record<string, number | string>> {
  switch (cmd.kind) {
    case 'spawn':
      return { cmd: cmd.kind, prefab: cmd.prefab };
    case 'destroy':
      return { cmd: cmd.kind, entity: cmd.entity };
    case 'addComponent':
    case 'removeComponent':
      return { cmd: cmd.kind, entity: cmd.entity, component: cmd.component };
    case 'setField':
      return {
        cmd: cmd.kind,
        entity: cmd.entity,
        component: cmd.component,
        field: cmd.field,
        value: cmd.value,
      };
  }
}

/**
 * Обвязка прохода применения при полном уровне трейса (DIAG-2, CMD-3). Исходы
 * копятся и уходят в трейс ПОСЛЕ прохода: перекрытие становится известно только
 * когда до мира дошла более поздняя запись в то же поле, то есть задним числом
 * относительно перекрытой команды. При выключенном трейсе записи нет вовсе — и
 * ни одной аллокации сверх обычного прохода.
 */
interface FlushTrace {
  readonly ctx: DiagnosticsContext;
  readonly outcomes: (CommandOutcome | undefined)[];
  /** Индекс последней команды, писавшей в адрес поля: `entity|component|field`. */
  readonly lastWriter: Map<string, number>;
}

/** Применение одной команды к миру (CMD-3): порядок — порядок создания. */
function applyCommand(state: WorldState, cmd: Command): void {
  switch (cmd.kind) {
    case 'spawn':
      world.spawn(state, cmd.prefab, cmd.overrides);
      break;
    case 'destroy':
      world.destroy(state, cmd.entity);
      break;
    case 'addComponent':
      world.addComponent(state, cmd.entity, cmd.component, cmd.values);
      break;
    case 'removeComponent':
      world.removeComponent(state, cmd.entity, cmd.component);
      break;
    case 'setField':
      world.setField(state, cmd.entity, cmd.component, cmd.field, cmd.value);
      break;
  }
}

/** Исход применённой команды и перекрытие предыдущей записи в тот же адрес (CMD-3). */
function noteApplied(trace: FlushTrace, cmd: Command, index: number): void {
  trace.outcomes[index] = 'applied';
  if (cmd.kind !== 'setField') return;
  const key = `${cmd.entity}|${cmd.component}|${cmd.field}`;
  const previous = trace.lastWriter.get(key);
  // Значение предыдущей команды до мира дошло, но было перезаписано этой — для
  // наблюдателя оно потеряно бесследно (CMD-3).
  if (previous !== undefined) trace.outcomes[previous] = 'overwritten';
  trace.lastWriter.set(key, index);
}

/** Записи о командах буфера — одним проходом после применения (DIAG-2, DIAG-5). */
function traceCommands(trace: FlushTrace, commands: readonly Command[]): void {
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const outcome = trace.outcomes[i];
    record(trace.ctx, 'command', 'info', 'COMMAND', {
      ...(cmd.seq !== undefined ? { seq: cmd.seq } : {}),
      data: commandData(cmd),
      ...(outcome !== undefined ? { outcome } : {}),
    });
  }
}

export interface CommandBufferHandle extends CommandBuffer {
  /**
   * Применяет накопленные команды к world state в порядке создания и очищает
   * буфер (CMD-2, CMD-3). Всё или ничего (SYS-9): отказ на любой команде
   * оставляет мир нетронутым, а буфер — накопленным.
   */
  flush(): void;
}

export function createCommandBuffer(state: WorldState): CommandBufferHandle {
  const commands: Command[] = [];
  /**
   * Сколько `destroy` в буфере. Счётчик, а не множество целей: он держит
   * обратный проход `alreadyDead` выключенным в подавляющем большинстве
   * буферов, где `destroy` нет вовсе, и не стоит ни одной аллокации.
   */
  let destroys = 0;

  /** Номер записи резервируется здесь — в момент заказа команды (DIAG-2, DIAG-5). */
  function enqueue(cmd: Command): void {
    const traced = traceFull();
    if (traced !== undefined) cmd.seq = nextSeq(traced);
    commands.push(cmd);
  }

  /**
   * Убила ли цель одна из предыдущих команд этого же буфера. Проход по уже
   * накопленному, а не множество уничтоженных: `destroy` в буфере единицы, а Set
   * стоил бы аллокации на каждом тике (тот же приём и та же причина, что у
   * `peekField`).
   */
  function alreadyDead(upto: number, entity: EntityId): boolean {
    if (destroys === 0) return false;
    for (let i = 0; i < upto; i++) {
      const cmd = commands[i]!;
      if (cmd.kind === 'destroy' && cmd.entity === entity) return true;
    }
    return false;
  }

  /**
   * Проход валидации перед применением (SYS-9). Всё, на чём мог бы бросить
   * проход применения, проверяется здесь — до первой мутации мира: иначе
   * исключение посреди применения оставило бы в мире часть команд упавшей
   * системы, а единица атомарности у flush'а — система целиком.
   *
   * Условия и сообщения не копируются: их держит `world.ts` рядом с самими
   * мутаторами, и оба прохода читают одни и те же функции.
   *
   * Аллокаций проход не делает — только счёт по уже накопленным записям.
   */
  function validate(): void {
    // Ёмкость: `spawn` берёт слот из freeList, иначе очередной индекс (ID-2), а
    // `destroy` внутри этого же прохода возвращает слот в пул.
    let room = world.spawnRoom(state);
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      if (cmd.kind === 'spawn') {
        world.checkSpawn(state, cmd.prefab, cmd.overrides);
        world.checkSpawnRoom(state, room);
        room--;
        continue;
      }
      // Та же проверка живой цели, что у прохода применения: команда, которую он
      // отбросит, до мутатора не дойдёт и проверяться не должна.
      if (!world.isAlive(state, cmd.entity) || alreadyDead(i, cmd.entity)) continue;
      switch (cmd.kind) {
        case 'destroy':
          room++;
          break;
        case 'addComponent':
          // Вместе с составом проверяются и значения: непредставимое значение —
          // отказ записи (ECS-3), и узнать о нём обязан этот проход, а не мир.
          world.checkComponent(state, 'addComponent', cmd.component, cmd.values);
          break;
        case 'setField':
          world.checkField(state, 'setField', cmd.component, cmd.field, cmd.value);
          break;
        case 'removeComponent':
          // Тотален: незарегистрированный компонент — no-op, а не отказ.
          break;
      }
    }
  }

  return {
    spawn(prefab, overrides) {
      enqueue({ kind: 'spawn', prefab, overrides });
    },
    destroy(entity) {
      enqueue({ kind: 'destroy', entity });
      destroys++;
    },
    addComponent(entity, component, values) {
      enqueue({ kind: 'addComponent', entity, component, values });
    },
    removeComponent(entity, component) {
      enqueue({ kind: 'removeComponent', entity, component });
    },
    setField(entity, component, field, value) {
      enqueue({ kind: 'setField', entity, component, field, value });
    },
    /**
     * CMD-5: точечное чтение уже отложенного. Обратный проход — потому что
     * побеждает последняя команда на поле, как и на flush (CMD-3).
     *
     * Значение адресу ставит не только `setField`: `addComponent` на flush
     * переписывает все поля компонента (`values` → default схемы → нейтральное
     * значение типа, ECS-3, ECS-6), поэтому и здесь он отвечает за поле — иначе
     * чтение разошлось бы с тем, что окажется в мире после flush (CMD-5).
     *
     * ponytail: O(команд в буфере) на вызов. Буфер флашится в конце каждой
     * системы, поэтому список короткий; индекс по адресу поля — когда
     * распределение слотов станет горячим.
     */
    peekField(entity, component, field) {
      for (let i = commands.length - 1; i >= 0; i--) {
        const cmd = commands[i]!;
        if (cmd.kind === 'setField' && cmd.entity === entity && cmd.component === component && cmd.field === field) {
          return cmd.value;
        }
        if (cmd.kind === 'addComponent' && cmd.entity === entity && cmd.component === component) {
          const schema = world.componentSchema(state, component);
          const type = schema?.fields[field];
          // Поле вне схемы (или незарегистрированный компонент) `addComponent`
          // не пишет — значения на этот адрес такая команда не ставит.
          if (type === undefined) continue;
          // Тот же порядок источников, что у мутатора в `world.ts` (ECS-3).
          return cmd.values?.[field] ?? schema?.defaults?.[field] ?? world.neutralValue(type);
        }
      }
      return undefined;
    },
    flush() {
      // Сначала весь буфер проверяется, и только потом применяется: ниже по
      // тексту действует инвариант «проход применения не бросает» (SYS-9).
      validate();

      const ctx = traceFull();
      const trace: FlushTrace | undefined =
        ctx === undefined ? undefined : { ctx, outcomes: [], lastWriter: new Map() };
      let applied = 0;

      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!;
        // Команда, адресованная уже умершей сущности, отбрасывается: иначе она
        // применилась бы к новой сущности, занявшей тот же слот (смысл
        // поколений в ID-1). Актуально для команд, созданных до того, как
        // предыдущая команда в этом же буфере убила цель.
        if (cmd.kind !== 'spawn' && !world.isAlive(state, cmd.entity)) {
          if (trace !== undefined) trace.outcomes[i] = 'dropped:dead-target';
          continue;
        }
        applied++;
        if (trace !== undefined) noteApplied(trace, cmd, i);
        applyCommand(state, cmd);
      }

      // Счётчики нужны записи `systemEnd` и на уровне границ систем, где
      // потока команд нет вовсе (DIAG-3).
      countCommands(commands.length, applied);

      if (trace !== undefined) traceCommands(trace, commands);

      commands.length = 0;
      destroys = 0;
    },
  };
}
