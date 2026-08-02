/**
 * Command Buffer (CMD-1..5): единственный канал мутаций для систем (DET-7).
 * Команды копятся в плоском списке в порядке создания и применяются в том же
 * порядке на flush (CMD-3) — до flush world не меняется, поэтому Query внутри
 * системы видит состояние на её начало (CMD-5, QUERY-3). flush per-system
 * вызывает планировщик (CMD-2), сам буфер за это не отвечает.
 */
import type { CommandBuffer, EntityId, FieldOverrides, WorldState } from '../types.js';
import * as world from './world.js';

type Command =
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
    };

export interface CommandBufferHandle extends CommandBuffer {
  /** Применяет накопленные команды к world state в порядке создания и очищает буфер (CMD-2, CMD-3). */
  flush(): void;
}

export function createCommandBuffer(state: WorldState): CommandBufferHandle {
  const commands: Command[] = [];

  return {
    spawn(prefab, overrides) {
      commands.push({ kind: 'spawn', prefab, overrides });
    },
    destroy(entity) {
      commands.push({ kind: 'destroy', entity });
    },
    addComponent(entity, component, values) {
      commands.push({ kind: 'addComponent', entity, component, values });
    },
    removeComponent(entity, component) {
      commands.push({ kind: 'removeComponent', entity, component });
    },
    setField(entity, component, field, value) {
      commands.push({ kind: 'setField', entity, component, field, value });
    },
    flush() {
      for (const cmd of commands) {
        // Команда, адресованная уже умершей сущности, отбрасывается: иначе она
        // применилась бы к новой сущности, занявшей тот же слот (смысл
        // поколений в ID-1). Актуально для команд, созданных до того, как
        // предыдущая команда в этом же буфере убила цель.
        if (cmd.kind !== 'spawn' && !world.isAlive(state, cmd.entity)) continue;
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
      commands.length = 0;
    },
  };
}
