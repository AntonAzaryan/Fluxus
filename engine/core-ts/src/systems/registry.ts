import { EvaluatedSystem, validateSystem, type SystemDef } from '../dsl/evaluatedSystem.js';
import type { System, WorldState } from '../types.js';

/**
 * Реестр систем. Единственный источник порядка исполнения — поле `order`
 * (DET-3); порядок регистрации на результат не влияет. Шкала `order` одна на
 * нативные и JSON-описанные системы, и значения в ней попарно различны (DET-9).
 */
export class SystemRegistry {
  private readonly systems: System[] = [];
  private sorted = false;

  register(system: System): void {
    if (this.systems.some((s) => s.name === system.name)) {
      throw new Error(`система с именем "${system.name}" уже зарегистрирована`);
    }
    // Уникальность `order`, запрет tie-break'а и требование назвать обе системы
    // в ошибке — норма DET-9; здесь только её проверка.
    const clash = this.systems.find((s) => s.order === system.order);
    if (clash !== undefined) {
      throw new Error(
        `order ${system.order} занят системой "${clash.name}", на него же встаёт "${system.name}": ` +
          `порядок должен быть однозначен (DET-9)`,
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
   * видимо, — тот же класс ошибки, ради которого DET-9 запрещает равные order.
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
