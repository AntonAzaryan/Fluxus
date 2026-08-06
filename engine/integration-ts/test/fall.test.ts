/**
 * Падение в дыру как чистая политика контента поверх механизма ядра: событие
 * `FellThroughFloor` (ARENA-5) → JSON-системы `FallStart`/`FallProgress` →
 * `EntityDied` и уничтожение по порогу в тиках (см. change entity-fall-system).
 *
 * Сцена — инлайн-фикстура, а не документ из `content/` (CONT-4): эталонное
 * поведение движка не должно зависеть от перенастройки контента дизайнером.
 */
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, runScenario, type ScenarioDef, type SystemDef } from '@game-mvp/core';

const DURATION = 5;

/** Системы падения — та же форма, что в `content/scenes/duel.scene.json`. */
function fallSystems(): SystemDef[] {
  return [
    {
      name: 'FallStart',
      order: 120,
      do: [
        {
          forEachEvent: {
            type: 'FellThroughFloor',
            as: 'ev',
            do: [
              {
                addComponent: {
                  entity: { eventField: [{ var: 'ev' }, 'entity'] },
                  component: 'Falling',
                  values: { progress: 0, duration: DURATION },
                },
              },
            ],
          },
        },
      ],
    },
    {
      name: 'FallProgress',
      order: 121,
      query: { all: ['Falling'] },
      as: 'e',
      do: [
        {
          let: {
            bindings: {
              next: { '+': [{ getComponent: [{ var: 'e' }, 'Falling', 'progress'] }, 1] },
            },
            do: [
              {
                modifyComponent: {
                  entity: { var: 'e' },
                  component: 'Falling',
                  values: { progress: { var: 'next' } },
                },
              },
              {
                if: {
                  cond: {
                    '>=': [
                      { var: 'next' },
                      { getComponent: [{ var: 'e' }, 'Falling', 'duration'] },
                    ],
                  },
                  then: [
                    { emitEvent: { type: 'EntityDied', data: { entity: { var: 'e' } } } },
                    { destroyEntity: { entity: { var: 'e' } } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  ];
}

/** Арена 4×4 с дырой в клетке (2, 2); падение сущности задаёт `at`. */
function scenario(at: { x: number; y: number }, ticks: number): ScenarioDef {
  return {
    name: 'fall-through-hole',
    seed: 1,
    ticks,
    scene: {
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Falling', fields: { progress: 'i32', duration: 'i32' } },
      ],
      prefabs: [
        {
          name: 'Walker',
          components: { Position: { x: 0, y: 0 }, ArenaState: { support: 0 } },
          tags: ['Walker'],
        },
      ],
      systems: fallSystems(),
      terrain: {
        width: 4,
        height: 4,
        tileSize: FIXED_ONE,
        levels: ['0000', '0000', '0000', '0000'],
        flags: ['....', '....', '.._.', '....'],
      },
      arena: { center: { x: 2 * FIXED_ONE, y: 2 * FIXED_ONE }, radius: 4 * FIXED_ONE },
      capacity: 8,
    },
    initial: [{ prefab: 'Walker', overrides: { Position: at } }],
  };
}

const HOLE = { x: 2 * FIXED_ONE + FIXED_ONE / 2, y: 2 * FIXED_ONE + FIXED_ONE / 2 };
const FLOOR = { x: FIXED_ONE / 2, y: FIXED_ONE / 2 };

function eventsOf(run: ReturnType<typeof runScenario>): Array<{ tick: number; type: string }> {
  return run.ticks.flatMap((record) =>
    record.events.map((event) => ({ tick: record.tick, type: event.type })),
  );
}

describe('падение в дыру: политика JSON поверх ARENA-5', () => {
  it('над дырой: FellThroughFloor на первом тике, EntityDied ровно через duration, сущность уничтожена', () => {
    const run = runScenario(scenario(HOLE, DURATION + 2));
    const events = eventsOf(run);
    expect(events).toContainEqual({ tick: 1, type: 'FellThroughFloor' });
    expect(events).toContainEqual({ tick: DURATION, type: 'EntityDied' });
    expect(events.filter((event) => event.type === 'EntityDied')).toHaveLength(1);

    // Прогресс дошёл до порога и сущность уничтожена — падение не повторяется.
    const last = run.ticks[run.ticks.length - 1]!;
    expect(last.world.aliveCount).toBe(2); // носители террейна и арены
    expect(eventsOf(run).filter((event) => event.type === 'FellThroughFloor')).toHaveLength(1);
  });

  it('на полу: ни события, ни падения, ни смерти', () => {
    const run = runScenario(scenario(FLOOR, DURATION + 2));
    expect(eventsOf(run)).toHaveLength(0);
    const last = run.ticks[run.ticks.length - 1]!;
    expect(last.world.aliveCount).toBe(3);
  });
});
