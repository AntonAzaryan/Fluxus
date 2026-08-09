/**
 * Раскладка `InputFrame` в компоненты (TICK-4): обычная система на TS на
 * якорном `order` шкалы DET-9, а не часть `tick()`. Ввод, попавший в мир, входит в
 * снапшот, восстанавливается rewind'ом и виден в golden-эталоне — ничего из
 * этого не дал бы оператор доступа к фрейму из выражения.
 *
 * Имена компонентов — параметры, а не конвенция ядра: о вводе ядро не знает.
 * Имена полей компонента ввода фиксированы, их пишет эта система.
 */
import type { EntityId, InputFrame, System, SystemContext } from '../types.js';

export interface InputSystemOptions {
  /** Порядок задаёт слоты: индекс игрока в списке и есть его слот (TICK-5). */
  readonly players: readonly string[];
  readonly name?: string;
  /** Компонент ввода; поля см. `INPUT_FIELDS`. */
  readonly component?: string;
  /** Компонент со слотом игрока и имя его поля. */
  readonly slotComponent?: string;
  readonly slotField?: string;
}

/** Что система пишет в компонент ввода. `prevButtons` — маска прошлого тика (TICK-4). */
export const INPUT_FIELDS = ['aimDir', 'buttons', 'moveX', 'moveY', 'prevButtons', 'seq'] as const;

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = -1000;

const DEFAULTS = {
  name: 'Input',
  component: 'Input',
  slotComponent: 'Player',
  slotField: 'slot',
} as const;

export class InputSystem implements System {
  readonly name: string;
  readonly order = ANCHOR_ORDER;
  private readonly component: string;
  private readonly slotComponent: string;
  private readonly slotField: string;
  private readonly slots: ReadonlyMap<string, number>;

  constructor(options: InputSystemOptions) {
    this.name = options.name ?? DEFAULTS.name;
    this.component = options.component ?? DEFAULTS.component;
    this.slotComponent = options.slotComponent ?? DEFAULTS.slotComponent;
    this.slotField = options.slotField ?? DEFAULTS.slotField;

    const slots = new Map<string, number>();
    options.players.forEach((playerId, slot) => {
      if (slots.has(playerId)) throw new Error(`InputSystem: игрок "${playerId}" указан дважды`);
      slots.set(playerId, slot);
    });
    this.slots = slots;
  }

  run(ctx: SystemContext): void {
    const bySlot = new Map<number, InputFrame>();
    for (const frame of ctx.inputs) {
      const slot = this.slots.get(frame.playerId);
      if (slot === undefined) {
        throw new Error(`InputSystem: игрок "${frame.playerId}" не объявлен в списке игроков (TICK-5)`);
      }
      if (bySlot.has(slot)) {
        throw new Error(`InputSystem: два фрейма игрока "${frame.playerId}" на тике ${ctx.tick}`);
      }
      bySlot.set(slot, frame);
    }

    for (const entity of ctx.query({ all: [this.slotComponent, this.component] })) {
      const slot = ctx.get(entity, this.slotComponent, this.slotField);
      const frame = bySlot.get(slot);
      bySlot.delete(slot);
      this.write(ctx, entity, frame);
    }

    // Молча отброшенный ввод отлаживается по эффекту («персонаж не двигается»),
    // а не по сообщению, поэтому фрейм без сущности — ошибка (TICK-5).
    const orphan = [...bySlot.keys()][0];
    if (orphan !== undefined) throw new Error(`InputSystem: фрейм слота ${orphan} без живой сущности`);
  }

  /** Поля в алфавитном порядке — тот же принцип, что у действий DSL (ACT-3). */
  private write(ctx: SystemContext, entity: EntityId, frame: InputFrame | undefined): void {
    const set = (field: string, value: number): void => {
      ctx.commands.setField(entity, this.component, field, value);
    };
    // Прежняя маска сохраняется до записи новой: фронт кнопки считает
    // система-потребитель, и хранить его вне мира нельзя (TICK-4).
    set('prevButtons', ctx.get(entity, this.component, 'buttons'));

    if (frame === undefined) {
      // Значения прошлого тика дали бы залипшее движение, неотличимое от намеренного.
      set('buttons', 0);
      set('moveX', 0);
      set('moveY', 0);
      return;
    }
    set('aimDir', frame.aimDir);
    set('buttons', frame.buttons);
    set('moveX', frame.move.x);
    set('moveY', frame.move.y);
    set('seq', frame.seq);
  }
}
