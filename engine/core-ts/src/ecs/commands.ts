/**
 * Command Buffer (CMD-1..5): единственный канал мутаций для систем (DET-7).
 * Команды копятся в плоском списке в порядке создания и применяются в том же
 * порядке на flush (CMD-3) — до flush world не меняется, поэтому Query внутри
 * системы видит состояние на её начало (CMD-5, QUERY-3). flush per-system
 * вызывает планировщик (CMD-2), сам буфер за это не отвечает.
 */
import type { CommandOutcome, CommandBuffer, EntityId, FieldOverrides, WorldState } from '../types.js';
import { countCommands, nextSeq, record, traceFull } from '../debug.js';
import * as world from './world.js';

/**
 * `seq` — номер записи трейса, зарезервированный при ЗАКАЗЕ команды (DIAG-2):
 * порядок задаётся моментом создания, а не моментом применения, иначе взаимный
 * порядок команд и событий внутри системы был бы искажён. Поле появляется
 * только при полном уровне трейса, при выключенном его нет.
 */
type Traced = { seq?: number };

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

export interface CommandBufferHandle extends CommandBuffer {
  /** Применяет накопленные команды к world state в порядке создания и очищает буфер (CMD-2, CMD-3). */
  flush(): void;
}

export function createCommandBuffer(state: WorldState): CommandBufferHandle {
  const commands: Command[] = [];

  /** Номер записи резервируется здесь — в момент заказа команды (DIAG-2, DIAG-5). */
  function enqueue(cmd: Command): void {
    const traced = traceFull();
    if (traced !== undefined) cmd.seq = nextSeq(traced);
    commands.push(cmd);
  }

  return {
    spawn(prefab, overrides) {
      enqueue({ kind: 'spawn', prefab, overrides });
    },
    destroy(entity) {
      enqueue({ kind: 'destroy', entity });
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
      }
      return undefined;
    },
    flush() {
      const traced = traceFull();
      // Исходы копятся и уходят в трейс ПОСЛЕ прохода: перекрытие (CMD-3)
      // становится известно только когда до мира дошла более поздняя запись в
      // то же поле, то есть задним числом относительно перекрытой команды.
      const outcomes: (CommandOutcome | undefined)[] | undefined = traced ? [] : undefined;
      const lastWriter: Map<string, number> | undefined = traced ? new Map() : undefined;
      let applied = 0;

      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!;
        // Команда, адресованная уже умершей сущности, отбрасывается: иначе она
        // применилась бы к новой сущности, занявшей тот же слот (смысл
        // поколений в ID-1). Актуально для команд, созданных до того, как
        // предыдущая команда в этом же буфере убила цель.
        if (cmd.kind !== 'spawn' && !world.isAlive(state, cmd.entity)) {
          if (outcomes !== undefined) outcomes[i] = 'dropped:dead-target';
          continue;
        }
        applied++;
        if (outcomes !== undefined && lastWriter !== undefined) {
          outcomes[i] = 'applied';
          if (cmd.kind === 'setField') {
            const key = `${cmd.entity}|${cmd.component}|${cmd.field}`;
            const previous = lastWriter.get(key);
            // Значение предыдущей команды до мира дошло, но было перезаписано
            // этой — для наблюдателя оно потеряно бесследно (CMD-3).
            if (previous !== undefined) outcomes[previous] = 'overwritten';
            lastWriter.set(key, i);
          }
        }
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

      // Счётчики нужны записи `systemEnd` и на уровне границ систем, где
      // потока команд нет вовсе (DIAG-3).
      countCommands(commands.length, applied);

      if (traced !== undefined && outcomes !== undefined) {
        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i]!;
          record(traced, 'command', 'info', 'COMMAND', {
            ...(cmd.seq !== undefined ? { seq: cmd.seq } : {}),
            data: commandData(cmd),
            ...(outcomes[i] !== undefined ? { outcome: outcomes[i]! } : {}),
          });
        }
      }

      commands.length = 0;
    },
  };
}
