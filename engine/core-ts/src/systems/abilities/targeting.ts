/**
 * Подтверждение шага прицеливания (ABIL-5), `order` −800 (DET-9).
 *
 * Имя системы называет её работу точно: она обрабатывает ПОДТВЕРЖДЕНИЕ шага, а
 * не ведёт непрерывное прицеливание, которого ABIL-5 не допускает. Проверка
 * накопленного выполняется позже и в другом месте — на завершении фазы,
 * накапливающей шаги (`CastPhaseSystem`).
 *
 * Сигналов подтверждения два, а правило накопления одно — один сигнал, один шаг
 * (ABIL-5): фронт бита подтверждения в фазах видов `commit` и `release` и
 * прекращение удержания бита триггера в фазе вида `release`. Второй сигнал и
 * есть «держать, целясь, отпустить»: одна кнопка открывает прицеливание и
 * подтверждает его.
 *
 * Стоит позже раскладки ввода и раньше фаз: шаг, подтверждённый на тике T,
 * уезжает в проверку и эффекты на тике T, а не на T+1. Одна кнопка при этом
 * порождает два разных действия двух систем, и обе читают ОДНУ и ту же маску
 * из компонента ввода (TICK-4) — собственного состояния фронта у платформы нет
 * (ABIL-3), а «удержание прекращено» обе считают одной функцией.
 */
import * as vector from '../../math/vector.js';
import { evaluate, typeError } from '../../dsl/expr.js';
import { ABILITY_SLOT_COMPONENT, stepFieldEntity, stepFieldX, stepFieldY } from './components.js';
import type { SlotHandles } from './handles.js';
import {
  PHASE_COMMIT,
  PHASE_RELEASE,
  STEP_POINT,
  STEP_UNIT,
  STEP_VECTOR,
  type AbilityCatalog,
  type CompiledAbility,
  type CompiledStep,
} from './model.js';
import {
  abilityOf,
  aimX,
  aimY,
  buttonEdge,
  buttonsOf,
  CandidatePicker,
  positionOf,
  prevButtonsOf,
  SlotScope,
  stepOriginX,
  stepOriginY,
  triggerHoldEnded,
} from './runtime.js';
import {
  NO_ENTITY,
  type EntityId,
  type Fixed,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = -800;

export class TargetingCommitSystem implements System {
  readonly name = 'TargetingCommit';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  private readonly scope = new SlotScope();
  private readonly picker = new CandidatePicker();
  private readonly spec: QuerySpec = { all: [ABILITY_SLOT_COMPONENT] };

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    const slots = ctx.query(this.spec);
    if (slots.length === 0) return;
    // Handle полей слота (SYS-10): один раз, на первом входе, после раннего выхода.
    const h = this.scope.handles(ctx);
    for (const slot of slots) {
      const phaseIndex = ctx.getByHandle(slot, h.phase);
      if (phaseIndex < 0) continue;
      const ability = abilityOf(this.catalog, ctx, h, slot);
      if (ability.stepCount === 0) continue;
      const staged = ctx.getByHandle(slot, h.staged);
      if (staged >= ability.stepCount) continue;
      // Шаг накапливают только фазы, которые его накапливают: `hold` и `auto`
      // завершаются временем и удержанием, и записывать в них нечего (ABIL-5).
      const trigger = this.catalog.phases[ability.phaseStart + phaseIndex]?.trigger;
      if (trigger !== PHASE_COMMIT && trigger !== PHASE_RELEASE) continue;
      const owner = ctx.getByHandle(slot, h.owner);
      if (owner === NO_ENTITY || !ctx.isAlive(owner)) continue;
      const buttons = buttonsOf(ctx, this.catalog, owner);
      const prevButtons = prevButtonsOf(ctx, this.catalog, owner);
      // Фронт бита подтверждения — в обеих фазах; прекращение удержания бита
      // триггера — только в фазе `release`, и тем же тиком оно завершит фазу
      // (ABIL-4): условие у обеих систем считает одна функция.
      const confirmed =
        buttonEdge(buttons, prevButtons, ability.confirmBit) ||
        (trigger === PHASE_RELEASE && triggerHoldEnded(ability, buttons));
      if (!confirmed) continue;
      this.commit(ctx, h, slot, owner, ability, staged);
    }
  }

  /**
   * Записывает прицеливание ЭТОГО кадра в очередной незаполненный шаг и
   * увеличивает `staged` (ABIL-5). Номеров шага на проводе не появляется:
   * провод несёт прицеливание тика, цепочку накапливает симуляция.
   */
  private commit(
    ctx: SystemContext,
    h: SlotHandles,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    staged: number,
  ): void {
    const step = this.catalog.steps[ability.stepStart + staged]!;
    this.scope.bind(ctx, slot, owner);
    const originX = stepOriginX(ctx, h, slot, owner, staged);
    const originY = stepOriginY(ctx, h, slot, owner, staged);
    const targetX = aimX(ctx, this.catalog, owner);
    const targetY = aimY(ctx, this.catalog, owner);

    let x: Fixed = 0;
    let y: Fixed = 0;
    let entity: EntityId = NO_ENTITY;
    switch (step.kind) {
      case STEP_POINT:
        x = targetX;
        y = targetY;
        break;
      case STEP_UNIT:
        entity = this.picker.nearest(
          ctx,
          originX,
          originY,
          targetX,
          targetY,
          this.rangeOf(ctx, ability, step),
          step.filter,
          this.scope.vars,
        );
        if (entity !== NO_ENTITY) {
          x = positionOf(ctx, entity, 'x');
          y = positionOf(ctx, entity, 'y');
        }
        break;
      case STEP_VECTOR: {
        // ponytail: `normalize` строит вектор объектом — одна аллокация на
        // подтверждение, то есть на нажатие, а не на слот и не на тик.
        const dir = vector.normalize({
          x: ctx.math.sub(targetX, originX),
          y: ctx.math.sub(targetY, originY),
        });
        x = dir.x;
        y = dir.y;
        break;
      }
      default:
        // `none` — шаг ничего не берёт (ABIL-5), но место в цепочке занимает.
        break;
    }

    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, stepFieldX(staged), x);
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, stepFieldY(staged), y);
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, stepFieldEntity(staged), entity);
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, 'staged', staged + 1);
  }

  private rangeOf(
    ctx: SystemContext,
    ability: CompiledAbility,
    step: CompiledStep,
  ): Fixed | undefined {
    if (step.range === undefined) return undefined;
    const range = evaluate(step.range, ctx, this.scope.vars);
    if (typeof range !== 'number') {
      throw typeError(`способность "${ability.id}": "range" шага`, 'number', range);
    }
    return range;
  }
}
