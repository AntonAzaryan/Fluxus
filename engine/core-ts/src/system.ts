import type { System } from './types.js';

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

  /** Системы в порядке исполнения. */
  ordered(): readonly System[] {
    if (!this.sorted) {
      this.systems.sort((a, b) => a.order - b.order);
      this.sorted = true;
    }
    return this.systems;
  }
}
