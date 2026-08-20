/**
 * Компоненты платформы (ABIL-1), предкомпиляция определений и её проверки
 * (ABIL-10), биндинги сцены (ABIL-8) и подключение платформы загрузчиком
 * (SER-7).
 *
 * Ошибка определения обязана быть ошибкой ЗАГРУЗКИ, а не первого срабатывания:
 * текст определения известен целиком заранее — то же правило и то же основание,
 * что у регистрации JSON-системы (SYS-3).
 */
import { describe, expect, it } from 'vitest';
import { componentNames, componentSchema } from '../src/ecs/world.js';
import * as fixed from '../src/math/fixed.js';
import {
  ABILITY_COMPONENTS,
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_DURATION_COMPONENT,
  ABILITY_PROJECTILE_COMPONENT,
  ABILITY_SLOT_COMPONENT,
  ABILITY_SLOT_SCHEMA,
  ABILITY_STEPS,
  NO_INTERRUPT,
  NO_PHASE,
} from '../src/systems/abilities/components.js';
import {
  defaultOutcome,
  INTERRUPT_CANCEL_INPUT,
  INTERRUPT_DEATH,
  INTERRUPT_DISABLE,
  INTERRUPT_SOURCES,
  interruptCode,
} from '../src/systems/abilities/interrupt.js';
import {
  COOLDOWN_FULL,
  COOLDOWN_REFUND,
  PHASE_COMMIT,
  PHASE_HOLD,
  PHASE_RELEASE,
  STAGED_RESET,
  STEP_UNIT,
  TIMEOUT_CANCEL,
  TIMEOUT_COMMIT,
  TRIGGER_ALWAYS,
  TRIGGER_INPUT,
  type AbilityDef,
} from '../src/systems/abilities/model.js';
import { compileAbilityCatalog } from '../src/systems/abilities/catalog.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { NO_ENTITY } from '../src/types.js';

const F = fixed.fromFloat;

const BASE: SceneDef['components'] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Input', fields: { buttons: 'i32', prevButtons: 'i32' } },
  { name: 'Player', fields: { slot: 'i32' } },
  { name: 'Dead', fields: { at: 'i32' } },
  { name: 'ActionLock', fields: { mask: 'i32' } },
];

const SIMPLE: AbilityDef = {
  id: 'bolt',
  trigger: { input: { bit: 0 } },
  effects: [{ emitEvent: { type: 'Cast' } }],
};

function scene(extra: Partial<SceneDef> = {}): SceneDef {
  return { components: BASE, abilities: [SIMPLE], ...extra };
}

/** Компиляция вне загрузчика — та же чистая функция над тем же миром. */
function compile(def: Partial<SceneDef>): ReturnType<typeof compileAbilityCatalog> {
  const loaded = loadScene({ components: BASE, ...def });
  return compileAbilityCatalog(
    { abilities: def.abilities, abilityRuntime: def.abilityRuntime, systems: def.systems },
    loaded.world,
  );
}

// ----------------------------------------------------------- компоненты

describe('Компоненты платформы (ABIL-1)', () => {
  it('состав полей слота: состояние автомата, шаги и только числа', () => {
    const fields = Object.keys(ABILITY_SLOT_SCHEMA.fields).sort();
    expect(fields).toEqual([
      'abilityId',
      'lastInterrupt',
      'level',
      'owner',
      'phase',
      'phaseTicks',
      'slotIndex',
      'staged',
      'step0e',
      'step0x',
      'step0y',
      'step1e',
      'step1x',
      'step1y',
      'step2e',
      'step2x',
      'step2y',
    ]);
    for (const type of Object.values(ABILITY_SLOT_SCHEMA.fields)) {
      expect(['i32', 'fixed', 'entity']).toContain(type);
    }
  });

  it('число шагов — именованная константа платформы, равная трём', () => {
    expect(ABILITY_STEPS).toBe(3);
    const stepFields = Object.keys(ABILITY_SLOT_SCHEMA.fields).filter((name) => name.startsWith('step'));
    expect(stepFields).toHaveLength(ABILITY_STEPS * 3);
  });

  it('умолчания: «каста нет» — минус единица, ссылки шагов пусты, прерывания не было', () => {
    expect(ABILITY_SLOT_SCHEMA.defaults?.phase).toBe(NO_PHASE);
    expect(NO_PHASE).toBe(-1);
    expect(NO_INTERRUPT).toBe(0);
    expect(ABILITY_SLOT_SCHEMA.defaults?.owner).toBe(NO_ENTITY);
    for (let i = 0; i < ABILITY_STEPS; i++) {
      expect(ABILITY_SLOT_SCHEMA.defaults?.[`step${i}e`]).toBe(NO_ENTITY);
    }
  });

  it('кулдаун — отдельный компонент той же сущности (ABIL-1, REW-9)', () => {
    expect(ABILITY_SLOT_SCHEMA.fields.remaining).toBeUndefined();
    const cooldown = ABILITY_COMPONENTS.find((schema) => schema.name === ABILITY_COOLDOWN_COMPONENT);
    expect(Object.keys(cooldown!.fields).sort()).toEqual(['remaining', 'total']);
  });
});

// ------------------------------------------------------------ компиляция

describe('Предкомпиляция определений (ABIL-2, ABIL-10)', () => {
  it('плоское представление: срезы общих массивов и коды видов', () => {
    const charge: AbilityDef = {
      id: 'charge',
      trigger: { input: { bit: 3 } },
      confirmBit: 1,
      cooldownTicks: 60,
      phases: [
        { id: 'wind', trigger: 'hold', durationTicks: 30, timeout: { then: 'commit' } },
        { id: 'aim', trigger: 'commit' },
      ],
      targeting: { steps: [{ kind: 'unit', range: F(8) }] },
      effects: [],
    };
    const aura: AbilityDef = { id: 'aura', trigger: { always: true }, effects: [] };
    const catalog = compile({ abilities: [charge, aura] });

    expect(catalog.abilities).toHaveLength(2);
    expect(catalog.index.get('charge')).toBe(0);
    expect(catalog.index.get('aura')).toBe(1);

    const compiled = catalog.abilities[0]!;
    expect(compiled.triggerKind).toBe(TRIGGER_INPUT);
    expect(compiled.triggerBit).toBe(3);
    expect(compiled.phaseStart).toBe(0);
    expect(compiled.phaseCount).toBe(2);
    expect(compiled.stepStart).toBe(0);
    expect(compiled.stepCount).toBe(1);
    expect(catalog.phases[compiled.phaseStart]!.trigger).toBe(PHASE_HOLD);
    expect(catalog.phases[compiled.phaseStart]!.timeoutThen).toBe(TIMEOUT_COMMIT);
    expect(catalog.phases[compiled.phaseStart + 1]!.trigger).toBe(PHASE_COMMIT);
    expect(catalog.steps[compiled.stepStart]!.kind).toBe(STEP_UNIT);

    // Вторая способность встаёт срезом за первой — дерева на способность нет.
    expect(catalog.abilities[1]!.triggerKind).toBe(TRIGGER_ALWAYS);
    expect(catalog.abilities[1]!.phaseStart).toBe(2);
    expect(catalog.abilities[1]!.phaseCount).toBe(0);
  });

  it('четвёртый вид перехода `release` компилируется в свой код (ABIL-4)', () => {
    const grab: AbilityDef = {
      id: 'grab',
      trigger: { input: { bit: 5 } },
      phases: [{ id: 'aim', trigger: 'release' }],
      targeting: { steps: [{ kind: 'unit' }] },
      effects: [],
    };
    const compiled = compile({ abilities: [grab] });
    expect(compiled.phases[compiled.abilities[0]!.phaseStart]!.trigger).toBe(PHASE_RELEASE);
  });

  it('вид способности не хранится: поле вида отвергается схемой определения', () => {
    const compiled = compile({ abilities: [SIMPLE] }).abilities[0]!;
    expect(Object.keys(compiled)).not.toContain('kind');
  });

  it('`timeout.then` разрешается в номер фазы определения, `cancel` — в код исхода', () => {
    const def: AbilityDef = {
      id: 'x',
      trigger: { always: true },
      phases: [
        { id: 'a', trigger: 'auto', durationTicks: 1, timeout: { then: 'b' } },
        { id: 'b', trigger: 'auto', durationTicks: 1, timeout: { then: 'cancel' } },
      ],
      effects: [],
    };
    const catalog = compile({ abilities: [def] });
    expect(catalog.phases[0]!.timeoutThen).toBe(1);
    expect(catalog.phases[1]!.timeoutThen).toBe(TIMEOUT_CANCEL);
  });

  it('исходы прерываний — срезы общей таблицы, умолчания дописываются на загрузке', () => {
    const def: AbilityDef = {
      id: 'x',
      trigger: { always: true },
      interrupts: { cancelInput: { staged: 'keep' } },
      effects: [],
    };
    const catalog = compile({ abilities: [def] });
    const compiled = catalog.abilities[0]!;
    expect(compiled.outcomeCount).toBe(1);
    const outcome = catalog.outcomes[compiled.outcomeStart]!;
    expect(outcome.source).toBe(INTERRUPT_CANCEL_INPUT);
    // Названо только отличие; судьба кулдауна осталась платформенным умолчанием.
    expect(outcome.cooldown).toBe(COOLDOWN_REFUND);
    expect(outcome.staged).not.toBe(STAGED_RESET);
  });
});

describe('Нормативный словарь и умолчания прерываний (ABIL-6)', () => {
  it('коды следуют порядку строк словаря, начиная с единицы; ноль — «прерывания не было»', () => {
    expect(INTERRUPT_SOURCES).toEqual([
      'release',
      'cancelInput',
      'supersede',
      'disable',
      'death',
      'displacement',
      'targetLost',
      'timeout',
      'damaged',
      'dispel',
    ]);
    expect(interruptCode('release')).toBe(1);
    expect(interruptCode('dispel')).toBe(INTERRUPT_SOURCES.length);
    expect(interruptCode('нет такого')).toBe(NO_INTERRUPT);
  });

  it('таблица умолчаний: возврат у отмены, потери цели и смерти, у прочих — полное взведение', () => {
    for (const source of INTERRUPT_SOURCES) {
      const code = interruptCode(source);
      const outcome = defaultOutcome(code);
      const refund = source === 'cancelInput' || source === 'targetLost' || source === 'death';
      expect(outcome.cooldown).toBe(refund ? COOLDOWN_REFUND : COOLDOWN_FULL);
      expect(outcome.staged).toBe(STAGED_RESET);
    }
    expect(defaultOutcome(INTERRUPT_DISABLE).cooldown).toBe(COOLDOWN_FULL);
    expect(defaultOutcome(INTERRUPT_DEATH).cooldown).toBe(COOLDOWN_REFUND);
  });
});

// --------------------------------------------------- проверки загрузки

describe('Проверки загрузки определений (ABIL-10)', () => {
  const failing = (ability: Partial<AbilityDef>, extra: Partial<SceneDef> = {}): (() => void) => {
    const def: AbilityDef = { ...SIMPLE, ...ability };
    return () => loadScene({ components: BASE, abilities: [def], ...extra });
  };

  it('неизвестное имя действия — ошибка загрузки, называющая способность и место', () => {
    expect(failing({ effects: [{ emitEvnet: { type: 'Cast' } }] })).toThrow(
      /способность "bolt"\.effects\[0\]: неизвестное действие "emitEvnet"/,
    );
  });

  it('неизвестный оператор выражения — ошибка загрузки', () => {
    expect(failing({ cooldownTicks: { nope: [1] } })).toThrow(
      /способность "bolt"\.cooldownTicks: неизвестный оператор "nope"/,
    );
  });

  it('ссылка на незарегистрированный компонент — ошибка загрузки', () => {
    expect(failing({ condition: { hasComponent: [{ var: 'owner' }, 'Ghost'] } })).toThrow(
      /компонент "Ghost" не зарегистрирован/,
    );
  });

  it('несуществующий `timeout.then` — ошибка загрузки, называющая фазу и написанное значение', () => {
    expect(
      failing({
        phases: [{ id: 'a', trigger: 'auto', durationTicks: 1, timeout: { then: 'b' } }],
      }),
    ).toThrow(/фазы "b" в определении нет; есть: a/);
  });

  it('число шагов сверх константы слота — ошибка загрузки', () => {
    expect(
      failing({
        targeting: {
          steps: [{ kind: 'point' }, { kind: 'point' }, { kind: 'point' }, { kind: 'point' }],
        },
      }),
    ).toThrow(/шагов 4, а слот несёт 3/);
  });

  it('неизвестный вид перехода фазы — словарь закрыт и перечислен в отказе (ABIL-4)', () => {
    expect(failing({ phases: [{ id: 'a', trigger: 'tap' as 'auto' }] })).toThrow(
      /неизвестное значение "tap"; допустимы: auto, commit, hold, release/,
    );
  });

  it('неизвестный источник прерывания — словарь закрыт', () => {
    expect(failing({ interrupts: { stunned: {} } })).toThrow(/неизвестный источник прерывания/);
  });

  it('неизвестная переменная в эффекте — ошибка загрузки, а не молчаливый undefined', () => {
    expect(failing({ effects: [{ emitEvent: { type: 'Cast', data: { v: { var: 'nope' } } } }] })).toThrow(
      /переменная "nope" не связана/,
    );
  });

  it('имя события связано только там, где событие есть', () => {
    // Триггер по вводу: имени события нет вовсе.
    expect(
      failing({ effects: [{ emitEvent: { type: 'Cast', data: { v: { eventField: [{ var: 'e' }, 'x'] } } } }] }),
    ).toThrow(/переменная "e" не связана/);
    // Триггер по событию: имя связано в эффектах мгновенной способности.
    expect(() =>
      loadScene({
        components: BASE,
        abilities: [
          {
            id: 'proc',
            trigger: { event: { type: 'Hit', as: 'e' } },
            effects: [{ emitEvent: { type: 'Cast', data: { v: { eventField: [{ var: 'e' }, 'x'] } } } }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('опечатка в имени действия эффекта ловится на загрузке, а не на первом срабатывании', () => {
    // Действие лежит в ветке, до которой прогон мог бы и не дойти.
    expect(
      failing({
        effects: [{ if: { cond: false, then: [{ destroyEntitty: { entity: { var: 'self' } } }] } }],
      }),
    ).toThrow(/неизвестное действие "destroyEntitty"/);
  });

  it('дубль идентификатора определения — ошибка загрузки', () => {
    expect(() => loadScene({ components: BASE, abilities: [SIMPLE, SIMPLE] })).toThrow(
      /определение "bolt" объявлено дважды/,
    );
  });
});

// ---------------------------------------------------------- биндинги ABIL-8

describe('Биндинги сцены (ABIL-8)', () => {
  it('объявленные биндинги разрешаются в имена компонентов и полей', () => {
    const catalog = compile({
      abilities: [SIMPLE],
      abilityRuntime: {
        deadMarker: 'Dead',
        actionLock: 'ActionLock',
        teamField: ['Player', 'slot'],
        damageEvent: { type: 'Hit', entityField: 'target', amountField: 'amount' },
      },
    });
    expect(catalog.bindings.deadMarker).toBe('Dead');
    expect(catalog.bindings.teamComponent).toBe('Player');
    expect(catalog.bindings.teamFieldName).toBe('slot');
    expect(catalog.bindings.damageType).toBe('Hit');
    expect(catalog.bindings.hasInput).toBe(true);
    // Полей точки прицела у этого компонента ввода нет — они приезжают с TICK-2.
    expect(catalog.bindings.hasAimPoint).toBe(false);
  });

  it('источник death без биндинга смерти — отказ загрузки с именем способности и биндинга', () => {
    expect(() =>
      loadScene({
        components: BASE,
        abilities: [{ ...SIMPLE, interrupts: { death: {} } }],
      }),
    ).toThrow(/способность "bolt".*источник "death" недоступен.*"deadMarker"/s);
  });

  it('источник disable без биндинга лока — отказ загрузки', () => {
    expect(() =>
      loadScene({
        components: BASE,
        abilities: [{ ...SIMPLE, interrupts: { disable: { mask: 1 } } }],
      }),
    ).toThrow(/источник "disable" недоступен.*"actionLock"/s);
  });

  it('порог урона в сцене без урона — ошибка загрузки, а не молча недействующее прерывание', () => {
    expect(() =>
      loadScene({
        components: BASE,
        abilities: [{ ...SIMPLE, interrupts: { damaged: { threshold: 1 } } }],
      }),
    ).toThrow(/источник "damaged" недоступен.*"damageEvent"/s);
  });

  it('туман войны вместе со способностями требует объявленной стороны', () => {
    expect(() =>
      loadScene({
        components: BASE,
        terrain: {
          width: 2,
          height: 2,
          tileSize: fixed.fromInt(8),
          levels: ['00', '00'],
          flags: ['..', '..'],
        },
        fog: true,
        abilities: [SIMPLE],
      }),
    ).toThrow(/ABIL-8.*teamField/s);
  });

  it('биндинг, называющий незарегистрированный компонент, отвергается', () => {
    expect(() =>
      loadScene({ components: BASE, abilities: [SIMPLE], abilityRuntime: { deadMarker: 'Ghost' } }),
    ).toThrow(/компонент "Ghost" не зарегистрирован/);
  });

  it('система, публикующая событие урона позже прерываний, отвергается на загрузке (ABIL-6)', () => {
    const late = {
      name: 'LateDamage',
      order: 900,
      do: [{ emitEvent: { type: 'Hit', data: { target: 0, amount: 1 } } }],
    };
    expect(() =>
      loadScene({
        components: BASE,
        systems: [late],
        abilities: [SIMPLE],
        abilityRuntime: { damageEvent: { type: 'Hit', entityField: 'target', amountField: 'amount' } },
      }),
    ).toThrow(/система "LateDamage" публикует "Hit" на order 900/);
  });

  it('та же система раньше прерываний принимается', () => {
    const early = {
      name: 'Damage',
      order: 128,
      do: [{ emitEvent: { type: 'Hit', data: { target: 0, amount: 1 } } }],
    };
    expect(() =>
      loadScene({
        components: BASE,
        systems: [early],
        abilities: [SIMPLE],
        abilityRuntime: { damageEvent: { type: 'Hit', entityField: 'target', amountField: 'amount' } },
      }),
    ).not.toThrow();
  });
});

// ------------------------------------------------------- подключение сценой

describe('Загрузчик подключает платформу составом сцены (SER-7)', () => {
  it('компоненты платформы дописываются ПОСЛЕ компонентов тумана войны', () => {
    const { world } = loadScene({
      components: BASE,
      terrain: {
        width: 2,
        height: 2,
        tileSize: fixed.fromInt(8),
        levels: ['00', '00'],
        flags: ['..', '..'],
      },
      arena: { center: { x: 0, y: 0 }, radius: fixed.fromInt(10) },
      timeScale: true,
      tweens: [],
      fog: true,
      abilities: [SIMPLE],
      abilityRuntime: { teamField: ['Player', 'slot'] },
    });
    const names = componentNames(world);
    const platform = ABILITY_COMPONENTS.map((schema) => schema.name);
    // Порядок нормативен: он задаёт битовые id, то есть маски в снапшоте.
    expect(names.slice(-platform.length)).toEqual(platform);
    expect(names.indexOf('Visibility')).toBeLessThan(names.indexOf(ABILITY_SLOT_COMPONENT));
  });

  it('системы платформы регистрирует загрузчик на нормативных местах (DET-9)', () => {
    const { systems } = loadScene(scene());
    const places = new Map(systems.ordered().map((system) => [system.name, system.order]));
    expect(places.get('TargetingCommit')).toBe(-800);
    expect(places.get('CastPhase')).toBe(-790);
    expect(places.get('Projectile')).toBe(300);
    expect(places.get('Cooldown')).toBe(800);
    expect(places.get('EffectDuration')).toBe(810);
    expect(places.get('CastInterrupt')).toBe(830);
  });

  it('сцена без `abilities` не меняется ни компонентами, ни системами', () => {
    const bare = loadScene({ components: BASE });
    expect(componentNames(bare.world)).toEqual(BASE.map((schema) => schema.name));
    expect(bare.systems.ordered()).toHaveLength(0);
    expect(bare.abilities).toBeUndefined();
    for (const name of [
      ABILITY_SLOT_COMPONENT,
      ABILITY_COOLDOWN_COMPONENT,
      ABILITY_PROJECTILE_COMPONENT,
      ABILITY_DURATION_COMPONENT,
    ]) {
      expect(componentSchema(bare.world, name)).toBeUndefined();
    }
  });

  it('скомпилированная таблица отдаётся сценой и в снапшот не входит', () => {
    const loaded = loadScene(scene());
    expect(loaded.abilities?.abilities).toHaveLength(1);
    expect(loaded.abilities?.index.get('bolt')).toBe(0);
  });
});
