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
import { compileAbilityCatalog } from '../src/systems/abilities/catalog.js';
import { CastPhaseSystem } from '../src/systems/abilities/phase.js';
import { TargetingCommitSystem } from '../src/systems/abilities/targeting.js';
import { ProjectileSystem } from '../src/systems/abilities/projectile.js';
import { CooldownSystem } from '../src/systems/abilities/cooldown.js';
import { EffectDurationSystem } from '../src/systems/abilities/duration.js';
import { CastInterruptSystem } from '../src/systems/abilities/interrupt.js';
import { BuffSystem } from '../src/systems/abilities/buffs.js';
import { AbilityVisibilitySystem } from '../src/systems/abilities/visibility.js';
import { compileNpcCatalog } from '../src/systems/npc/document.js';
import { NpcDirectorSystem } from '../src/systems/npc/director.js';
import { NpcBehaviorSystem } from '../src/systems/npc/behavior.js';
import { NpcMovementSystem } from '../src/systems/npc/movement.js';
import { NpcThreatSystem } from '../src/systems/npc/threat.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import type { AbilityCatalog } from '../src/systems/abilities/model.js';
import type { NpcCatalog } from '../src/systems/npc/model.js';
import { FIXED_ONE, type System, type SystemContext } from '../src/types.js';

const noop = (_ctx: SystemContext): void => {};

const sys = (name: string, order: number): System => ({ name, order, run: noop });

/**
 * Таблица способностей ровно того объёма, какой нужен конструкторам систем
 * платформы: сами определения здесь не предмет проверки, предмет — место
 * системы в шкале.
 */
function abilityCatalog(): AbilityCatalog {
  const def: SceneDef = {
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      {
        name: 'Input',
        fields: { buttons: 'i32', prevButtons: 'i32', targetX: 'fixed', targetY: 'fixed' },
      },
    ],
    abilities: [{ id: 'probe', trigger: { input: { bit: 0 } }, effects: [] }],
  };
  return compileAbilityCatalog(def, loadScene(def).world);
}

/** То же для платформы поведения NPC: волны объявлены, иначе режиссёра нет (NPC-8). */
function npcCatalog(): NpcCatalog {
  const always = { input: 'always', curve: { type: 'constant', value: FIXED_ONE }, weight: FIXED_ONE };
  return compileNpcCatalog({
    behaviors: [
      {
        schema: 1,
        name: 'probe',
        tier: 'mass',
        decision: { intervalTicks: 1 },
        ranges: { sense: FIXED_ONE, attack: FIXED_ONE, arrive: FIXED_ONE, separation: FIXED_ONE },
        speed: FIXED_ONE,
        states: [{ name: 'idle', actions: [{ executor: 'seekTarget', considerations: [always] }] }],
      } as never,
    ],
    waves: {
      cap: 1,
      entries: [{ prefab: 'Creep', count: 1, behavior: 0, delayTicks: 0, spacingTicks: 1, route: 0 }],
    },
  });
}

/**
 * Все девятнадцать нативных систем таблицы DET-9, каждая со своими
 * зависимостями (DI-1). Конструкторы настоящие — те же, что зовёт загрузчик
 * сцены (`sim/scene.ts`): якорь принадлежит системе, а не месту регистрации.
 */
function nativeSystems(): readonly System[] {
  const abilities = abilityCatalog();
  const npc = npcCatalog();
  return [
    new InputSystem({ players: ['p1'] }),
    new NpcDirectorSystem(npc),
    new TimeScaleSystem(modifierList(TIME_SCALE_MODIFIERS_COMPONENT)),
    new TargetingCommitSystem(abilities),
    new NpcBehaviorSystem(npc),
    new CastPhaseSystem(abilities),
    new LocomotionSystem(),
    new TweenSystem([]),
    new NpcMovementSystem(npc),
    new PhysicsSystem(new PhysicsWorld([])),
    new ArenaSystem(),
    new ProjectileSystem(abilities),
    new CooldownSystem(),
    new EffectDurationSystem(abilities),
    new BuffSystem(abilities, undefined),
    new CastInterruptSystem(abilities),
    new NpcThreatSystem(npc),
    new VisibilitySystem({
      lists: {
        vision: modifierList(VISION_MODIFIER_COMPONENT),
        stealth: modifierList('StealthSources', undefined, 'mask'),
        detection: modifierList('DetectionSources', undefined, 'mask'),
      },
      hardStealthMask: ~0,
    }),
    new AbilityVisibilitySystem(abilities),
  ];
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
  // Тест обязан краснеть от правки любой из ДЕВЯТНАДЦАТИ констант таблицы:
  // сверяются и сами значения, и последовательность, которая из них следует.
  // Неполный перечень был бы хуже отсутствия: правка `ANCHOR_ORDER` системы, в
  // список не попавшей, не покраснила бы ничего, и расхождение вылезло бы
  // только другим исходом матча — ровно тем способом, который DET-9 называет
  // худшим.
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

  // «Между соседними значениями таблицы SHALL оставаться свободные значения:
  // контент обязан иметь возможность встать между любыми двумя нативными
  // системами» (DET-9). Проверяется на всех восемнадцати парах разом, потому
  // что нарушить это может добавление ЛЮБОЙ новой нативной системы.
  it('между соседними якорями остаётся свободное значение для контента', () => {
    const orders = nativeSystems()
      .map((s) => s.order)
      .sort((a, b) => a - b);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]! - orders[i - 1]!).toBeGreaterThan(1);
    }
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
    expect(names.slice(names.indexOf('Physics'), names.indexOf('Arena') + 1)).toEqual([
      'Physics',
      'BeforeBorder',
      'Arena',
    ]);
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
