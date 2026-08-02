import { describe, expect, it } from 'vitest';
import { SystemRegistry } from '../src/systems/registry.js';
import { EventBus } from '../src/ecs/events.js';
import type { System, SystemContext } from '../src/types.js';

const noop = (_ctx: SystemContext): void => {};

const sys = (name: string, order: number): System => ({ name, order, run: noop });

describe('SystemRegistry (DET-3)', () => {
  it('исполняет по order независимо от порядка регистрации', () => {
    const registry = new SystemRegistry();
    registry.register(sys('B', 20));
    registry.register(sys('A', 10));
    registry.register(sys('C', 30));

    expect(registry.ordered().map((s) => s.name)).toEqual(['A', 'B', 'C']);
  });

  it('отвергает дублирующийся order — порядок обязан быть однозначен', () => {
    const registry = new SystemRegistry();
    registry.register(sys('A', 10));
    expect(() => registry.register(sys('B', 10))).toThrow(/order 10/);
  });

  it('отвергает дублирующееся имя — имя определяет RNG-стрим системы (RNG-4)', () => {
    const registry = new SystemRegistry();
    registry.register(sys('A', 10));
    expect(() => registry.register(sys('A', 20))).toThrow(/уже зарегистрирована/);
  });
});

describe('EventBus (OBS-4)', () => {
  it('копит события тика и отдаёт их как read-only view', () => {
    const bus = new EventBus();
    bus.emit('DamageDealt', { amount: 10 });
    bus.emit('UltimateCast');

    expect(bus.length).toBe(2);
    expect(bus.at(0)).toEqual({ type: 'DamageDealt', data: { amount: 10 } });
    expect([...bus].map((e) => e.type)).toEqual(['DamageDealt', 'UltimateCast']);
  });

  it('очищается между тиками — события не переживают тик', () => {
    const bus = new EventBus();
    bus.emit('DamageDealt');
    bus.clear();
    expect(bus.length).toBe(0);
    expect(() => bus.at(0)).toThrow();
  });
});
