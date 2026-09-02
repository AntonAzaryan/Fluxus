import { describe, expect, it } from 'vitest';
import { SystemRegistry } from '../src/systems/registry.js';
import { EventBus } from '../src/ecs/events.js';
import { EvaluatedSystem } from '../src/dsl/evaluatedSystem.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import { TimeScaleSystem, TIME_SCALE_MODIFIERS_COMPONENT } from '../src/systems/time.js';
import { LocomotionSystem } from '../src/systems/locomotion.js';
import { TweenSystem } from '../src/systems/tween.js';
import { PhysicsSystem, PhysicsWorld } from '../src/systems/physics.js';
import { ArenaSystem } from '../src/systems/arena.js';
import { VisibilitySystem, VISION_MODIFIER_COMPONENT } from '../src/systems/visibility.js';
import { modifierList } from '../src/systems/modifiers.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import type { System, SystemContext } from '../src/types.js';

const noop = (_ctx: SystemContext): void => {};

const sys = (name: string, order: number): System => ({ name, order, run: noop });

/** Минимальный документ поведения: одно состояние, один исполнитель (NPC-2). */
const BEHAVIOR = {
  schema: 1,
  name: 'walker',
  tier: 'mass',
  decision: { intervalTicks: 1 },
  ranges: { sense: 1310720, attack: 65536, arrive: 65536, separation: 131072 },
  speed: 65536,
  states: [
    {
      name: 'press',
      actions: [
        {
          executor: 'seekTarget',
          considerations: [
            { input: 'targetKnown', curve: { type: 'linear', slope: 65536, intercept: 0 }, weight: 65536 },
          ],
        },
      ],
      transitions: [],
    },
  ],
} as const;

/**
 * Сцена, включающая своим составом ВСЕ нативные системы, которые регистрирует
 * загрузчик (SER-7): арена, темп, твины, туман, платформа способностей с
 * баффами, платформа NPC с таблицей волн. Четыре оставшиеся системы таблицы
 * DET-9 регистрирует не загрузчик, а сборка (`build.ts`): им нужны игроки,
 * локомоушен и raycast (DI-3), — их тест добавляет руками.
 */
const FULL_SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Input', fields: { buttons: 'i32', prevButtons: 'i32' } },
    { name: 'Player', fields: { slot: 'i32' } },
    { name: 'Dead', fields: { at: 'i32' } },
    { name: 'ActionLock', fields: { mask: 'i32' } },
  ],
  terrain: { width: 2, height: 2, tileSize: 65536, levels: ['00', '00'], flags: ['..', '..'] },
  arena: { center: { x: 0, y: 0 }, radius: 655360 },
  timeScale: true,
  tweens: [],
  fog: true,
  abilities: [{ id: 'bolt', trigger: { input: { bit: 0 } }, effects: [{ emitEvent: { type: 'Cast' } }] }],
  buffs: [],
  abilityRuntime: { teamField: ['Player', 'slot'] },
  npc: {
    behaviors: [BEHAVIOR],
    bindings: { position: 'Position' },
    waves: {
      cap: 1,
      entries: [{ prefab: 'Creep', count: 0, behavior: 0, delayTicks: 0, spacingTicks: 0, x: 0, y: 0 }],
    },
  },
};

/**
 * Все девятнадцать нативных систем таблицы DET-9, каждая со своими
 * зависимостями (DI-1): пятнадцать — теми экземплярами, что регистрирует
 * загрузчик сцены, четыре — руками, как их регистрирует сборка.
 */
function nativeSystems(): readonly System[] {
  return [
    ...loadScene(FULL_SCENE).systems.ordered(),
    new InputSystem({ players: ['p1'] }),
    new TimeScaleSystem(modifierList(TIME_SCALE_MODIFIERS_COMPONENT)),
    new LocomotionSystem(),
    new TweenSystem([]),
    new PhysicsSystem(new PhysicsWorld([])),
    new ArenaSystem(),
    new VisibilitySystem({
      lists: {
        vision: modifierList(VISION_MODIFIER_COMPONENT),
        stealth: modifierList('StealthSources', undefined, 'mask'),
        detection: modifierList('DetectionSources', undefined, 'mask'),
      },
      hardStealthMask: ~0,
    }),
  ].filter((system, index, all) => all.findIndex((other) => other.name === system.name) === index);
}

describe('SystemRegistry (DET-3, SYS-2)', () => {
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
    expect(() => { registry.register(sys('B', 10)); }).toThrow(/order 10/);
  });

  it('отвергает дублирующееся имя — имя определяет RNG-стрим системы (RNG-4)', () => {
    const registry = new SystemRegistry();
    registry.register(sys('A', 10));
    expect(() => { registry.register(sys('A', 20)); }).toThrow(/уже зарегистрирована/);
  });

  // DET-3: порядок регистрации не наблюдаем в результате. Проверка не на паре,
  // а на наборе: сортировка устойчива, и на двух элементах совпадение вышло бы
  // и у реализации, которая просто сохранила порядок регистрации.
  it('один набор систем, зарегистрированный по-разному, исполняется одинаково (DET-3)', () => {
    const names = ['D', 'A', 'C', 'B'];
    const orders = { A: 5, B: -20, C: 300, D: 7 } as const;

    const forward = new SystemRegistry();
    for (const name of names) forward.register(sys(name, orders[name as keyof typeof orders]));
    const backward = new SystemRegistry();
    for (const name of [...names].reverse()) backward.register(sys(name, orders[name as keyof typeof orders]));

    expect(forward.ordered().map((s) => s.name)).toEqual(['B', 'A', 'D', 'C']);
    expect(backward.ordered().map((s) => s.name)).toEqual(forward.ordered().map((s) => s.name));
  });
});

describe('Шкала order (DET-9)', () => {
  // Тест обязан краснеть от правки любой из девятнадцати констант
  // `ANCHOR_ORDER`: сверяются и сами значения таблицы, и последовательность,
  // которая из них следует, — строка в строку с таблицей требования.
  it('нативные системы стоят на якорях таблицы', () => {
    const registry = new SystemRegistry();
    for (const system of nativeSystems()) registry.register(system);

    expect(registry.ordered().map((s) => [s.name, s.order])).toEqual([
      ['Input', -1000],
      ['NpcDirector', -960],
      ['TimeScale', -900],
      ['TargetingCommit', -800],
      ['NpcBehavior', -795],
      ['CastPhase', -790],
      ['Locomotion', 0],
      ['Tween', 50],
      ['NpcMovement', 70],
      ['Physics', 100],
      ['Arena', 110],
      ['Projectile', 300],
      ['Cooldown', 800],
      ['EffectDuration', 810],
      ['Buff', 820],
      ['CastInterrupt', 830],
      ['NpcThreat', 840],
      ['Visibility', 900],
      ['AbilityVisibility', 910],
    ]);
  });

  it('конфликт на регистрации называет значение и обе системы', () => {
    const registry = new SystemRegistry();
    registry.register(new ArenaSystem());

    expect(() => { registry.register(new EvaluatedSystem({ name: 'Border', order: 110, do: [] })); }).toThrow(
      /order 110 занят системой "Arena", на него же встаёт "Border"/,
    );
  });

  // Ничья не разрешается ничем — в том числе именем (SYS-7, RNG-4): регистрация
  // падает в обе стороны, и до сравнения имён дело не доходит.
  //
  // Проверяется здесь именно барьер регистрации, а не сортировка scheduler'а:
  // ничья в реестр не попадает, поэтому сравнения имён в сортировке нет и
  // проверить его нечем — реестр остаётся с одной системой в обоих порядках.
  it('равные order не разводятся по имени ни в каком порядке регистрации', () => {
    const first = new SystemRegistry();
    first.register(sys('A', 10));
    expect(() => { first.register(sys('B', 10)); }).toThrow(/order 10/);
    expect(first.ordered().map((s) => s.name)).toEqual(['A']);

    const second = new SystemRegistry();
    second.register(sys('B', 10));
    expect(() => { second.register(sys('A', 10)); }).toThrow(/order 10/);
    expect(second.ordered().map((s) => s.name)).toEqual(['B']);
  });

  // Свободный промежуток между якорями — то, ради чего шкала одна: контент
  // встаёт между нативными системами, не правя ядро (SYS-2).
  it('JSON-система из промежутка (100, 110) идёт после физики и до арены', () => {
    const registry = new SystemRegistry();
    for (const system of nativeSystems()) registry.register(system);
    registry.register(new EvaluatedSystem({ name: 'BeforeBorder', order: 105, do: [] }));

    const names = registry.ordered().map((s) => s.name);
    expect(names.slice(names.indexOf('Physics'), names.indexOf('Arena') + 1)).toEqual(['Physics', 'BeforeBorder', 'Arena']);
  });
});

describe('EventBus (OBS-4, EVT-1, EVT-4)', () => {
  it('копит события тика и отдаёт их как read-only view', () => {
    const bus = new EventBus();
    bus.emit('DamageDealt', { amount: 10 });
    bus.emit('UltimateCast');

    expect(bus.length).toBe(2);
    expect(bus.at(0)).toEqual({ type: 'DamageDealt', data: { amount: 10 } });
    expect([...bus].map((e) => e.type)).toEqual(['DamageDealt', 'UltimateCast']);
  });

  // EVT-4: шина чистится на границе тика — система видит только события
  // своего тика. Факт события переживает границу только в снапшоте (EVT-3).
  it('очищается между тиками — события не переживают тик', () => {
    const bus = new EventBus();
    bus.emit('DamageDealt');
    bus.clear();
    expect(bus.length).toBe(0);
    expect(() => bus.at(0)).toThrow();
  });
});
