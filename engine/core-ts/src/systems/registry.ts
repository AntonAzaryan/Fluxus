import { EvaluatedSystem, validateSystem, type SystemDef } from '../dsl/evaluatedSystem.js';
import type { System, WorldState } from '../types.js';

/**
 * Реестр систем. Единственный источник порядка исполнения — поле `order`
 * (DET-3); порядок регистрации на результат не влияет.
 */
export class SystemRegistry {
  private readonly systems: System[] = [];
  private sorted = false;

  register(system: System): void {
    if (this.systems.some((s) => s.name === system.name)) {
      throw new Error(`система с именем "${system.name}" уже зарегистрирована`);
    }
    // Равные order оставили бы порядок на усмотрение сортировки — то есть на
    // усмотрение реализации. Для парности с Rust это недопустимо.
    const clash = this.systems.find((s) => s.order === system.order);
    if (clash !== undefined) {
      throw new Error(
        `order ${system.order} занят системой "${clash.name}": порядок должен быть однозначен (DET-3)`,
      );
    }
    this.systems.push(system);
    this.sorted = false;
  }

  /** JSON-система из редактора: валидируется до старта матча (SYS-3), не в середине. */
  registerFromJson(def: SystemDef, world: WorldState): void {
    validateSystem(def, world);
    this.register(new EvaluatedSystem(def));
  }

  /**
   * Подмена реализации по имени (SYS-7). `order` обязан совпадать: подмена,
   * тихо сдвинувшая порядок, меняет результат симуляции, ничего не сломав
   * видимо, — тот же класс ошибки, ради которого DET-3 запрещает равные order.
   */
  override(system: System): void {
    const index = this.systems.findIndex((s) => s.name === system.name);
    if (index === -1) throw new Error(`override: система "${system.name}" не зарегистрирована`);
    const previous = this.systems[index]!;
    if (previous.order !== system.order) {
      throw new Error(
        `override: у системы "${system.name}" order ${previous.order}, подменяющая заявляет ${system.order}`,
      );
    }
    this.systems[index] = system;
  }

  /** Системы в порядке исполнения. */
  ordered(): readonly System[] {
    if (!this.sorted) {
      this.systems.sort((a, b) => a.order - b.order);
      this.sorted = true;
    }
    return this.systems;
  }
}
