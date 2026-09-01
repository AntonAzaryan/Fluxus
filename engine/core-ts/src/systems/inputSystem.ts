/**
 * Раскладка `InputFrame` в компоненты (TICK-4): обычная система на TS на
 * якорном `order` шкалы DET-9, а не часть `tick()`. Ввод, попавший в мир, входит в
 * снапшот, восстанавливается rewind'ом и виден в golden-эталоне — ничего из
 * этого не дал бы оператор доступа к фрейму из выражения.
 *
 * Имена компонентов — параметры, а не конвенция ядра: о вводе ядро не знает.
 * Имена полей компонента ввода фиксированы, их пишет эта система.
 *
 * TimeScale (TIME-5): игнорирует — фрейм приходит на пару «игрок, тик» (TICK-2),
 * и раскладка его в компоненты времени не считает вовсе.
 */
import { componentSchema } from '../ecs/world.js';
import type { EntityId, InputFrame, System, SystemContext, WorldState } from '../types.js';

export interface InputSystemOptions {
  /** Порядок задаёт слоты: индекс игрока в списке и есть его слот (TICK-5). */
  readonly players: readonly string[];
  readonly name?: string;
  /** Компонент ввода; поля см. `INPUT_FIELDS`. */
  readonly component?: string;
  /** Компонент со слотом игрока и имя его поля. */
  readonly slotComponent?: string;
  readonly slotField?: string;
  /**
   * Раскладывать ли точку прицела кадра (TICK-2) в `INPUT_TARGET_FIELDS`.
   * Решает СЦЕНА — объявлением полей у своего компонента ввода, — а вычисляет
   * ответ сборка (`inputTargetDeclared`): системе мир на конструировании не
   * передают, а спрашивать состав полей на каждом тике незачем — он неизменен.
   *
   * Умолчание `false`, и это не осторожность: сцена, точкой не пользующаяся,
   * не получает ни полей, ни записей в них, и её эталоны от появления точки в
   * протоколе не меняются вовсе.
   */
  readonly target?: boolean;
}

/** Что система пишет в компонент ввода. `prevButtons` — маска прошлого тика (TICK-4). */
export const INPUT_FIELDS = ['aimDir', 'buttons', 'moveX', 'moveY', 'prevButtons', 'seq'] as const;

/**
 * Пара полей точки прицела (TICK-2, TICK-4) — НЕОБЯЗАТЕЛЬНАЯ часть компонента
 * ввода: пишется, только если сцена объявила обе. Имена совпадают с теми, что
 * читает платформа способностей (`systems/abilities/model.ts`), и это одно и то
 * же соглашение, а не два совпавших.
 */
export const INPUT_TARGET_FIELDS = ['targetX', 'targetY'] as const;

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = -1000;

const DEFAULTS = {
  name: 'Input',
  component: 'Input',
  slotComponent: 'Player',
  slotField: 'slot',
} as const;

/**
 * Объявила ли сцена у своего компонента ввода пару полей точки прицела (TICK-4).
 * Спрашивается один раз, на сборке: состав полей компонента неизменен, а
 * ответ — параметр `InputSystem`.
 *
 * Обе половины или ни одной: точка с одной координатой — не точка, и молча
 * раскладывать её половину значило бы отдать способности координату, второй у
 * которой не будет никогда.
 */
export function inputTargetDeclared(world: WorldState, component: string = DEFAULTS.component): boolean {
  const schema = componentSchema(world, component);
  if (schema === undefined) return false;
  return INPUT_TARGET_FIELDS.every((field) => schema.fields[field] !== undefined);
}

export class InputSystem implements System {
  readonly name: string;
  readonly order = ANCHOR_ORDER;
  private readonly component: string;
  private readonly slotComponent: string;
  private readonly slotField: string;
  private readonly target: boolean;
  private readonly slots: ReadonlyMap<string, number>;

  constructor(options: InputSystemOptions) {
    this.name = options.name ?? DEFAULTS.name;
    this.component = options.component ?? DEFAULTS.component;
    this.slotComponent = options.slotComponent ?? DEFAULTS.slotComponent;
    this.slotField = options.slotField ?? DEFAULTS.slotField;
    this.target = options.target ?? false;

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
      //
      // Точки прицела это обнуление НЕ касается, как не касается оно `aimDir`
      // и `seq`: она — величина класса «последнее известное состояние ввода», а
      // не намерения (TICK-2). Обнулённая, она означала бы «игрок целится в
      // начало координат» — намерение, которого он не выражал, и цепочка
      // прицеливания рвалась бы от одного пропущенного кадра.
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
    // Кадр без точки её тоже не гасит: источник, точкой не владеющий, молчит о
    // ней, а не сообщает начало координат (TICK-2, `input-devices` INP-5).
    if (this.target && frame.target !== undefined) {
      set(INPUT_TARGET_FIELDS[0], frame.target.x);
      set(INPUT_TARGET_FIELDS[1], frame.target.y);
    }
  }
}
