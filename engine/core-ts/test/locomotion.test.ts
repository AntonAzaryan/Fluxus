import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import {
  addComponent,
  getField,
  hasComponent,
  removeComponent,
  setField,
  spawn,
} from '../src/ecs/world.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  LocomotionSystem,
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_NORMAL,
  LOCOMOTION_ROLL,
  LOCOMOTION_WINDOW,
} from '../src/systems/locomotion.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import type { TerrainDef } from '../src/systems/terrain.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import {
  initialState,
  restoreSnapshot,
  takeSnapshot,
  tick,
  type Simulation,
} from '../src/sim/tick.js';
import { LEVEL_OVERRIDE_COMPONENT, type InputFrame, type Vec2 } from '../src/types.js';

const F = fixed.fromFloat;

/** Биты кнопок — дефолты системы: уклон 1, прыжок 2. */
const DODGE = 1 << 1;
const JUMP = 1 << 2;

/** Имя компонента лока и бит манёвров — параметры сборки, а не ядра (LOC-7). */
const LOCK_COMPONENT = 'ActionLock';
const MANEUVER_LOCK_BIT = 1;
const MANEUVER_LOCK = 1 << MANEUVER_LOCK_BIT;

const RIGHT: Vec2 = { x: F(1), y: 0 };
const UP: Vec2 = { x: 0, y: F(1) };

/** Ровная сетка уровня 2: `levelOf` при прыжке обязан вернуть именно его. */
const TERRAIN: TerrainDef = {
  width: 4,
  height: 4,
  tileSize: fixed.fromInt(1),
  levels: ['2222', '2222', '2222', '2222'],
  flags: ['....', '....', '....', '....'],
};

/**
 * Балансные числа живут в контенте (LOC-1) — здесь они подобраны так, чтобы
 * доводчик попадал в цель точно: разгон 1.5 к максимуму 4 снапится на третьем
 * тике, торможение 2.5 доходит до нуля за два.
 */
const CONFIG = {
  maxSpeed: F(4),
  accel: F(1.5),
  decel: F(2.5),
  dodgeSpeed: F(6),
  dodgeTicks: 2,
  windowTicks: 3,
  rollSpeed: F(3),
  rollTicks: 6,
  jumpSpeed: F(2),
  jumpTicks: 4,
  jumpHeight: 1,
} as const;

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Player', fields: { slot: 'i32' } },
    {
      name: 'Input',
      fields: {
        aimDir: 'fixed',
        buttons: 'i32',
        moveX: 'fixed',
        moveY: 'fixed',
        prevButtons: 'i32',
        seq: 'i32',
      },
    },
    { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
    // Из коллайдера системе нужен только допуск подъёма (PHYS-11, D3).
    { name: 'Collider', fields: { cliffRise: 'i32' } },
    {
      name: 'Locomotion',
      fields: {
        maxSpeed: 'fixed',
        accel: 'fixed',
        decel: 'fixed',
        dodgeSpeed: 'fixed',
        dodgeTicks: 'i32',
        windowTicks: 'i32',
        rollSpeed: 'fixed',
        rollTicks: 'i32',
        jumpSpeed: 'fixed',
        jumpTicks: 'i32',
        jumpHeight: 'i32',
      },
    },
    {
      name: 'LocomotionState',
      fields: { state: 'i32', ticksLeft: 'i32', dirX: 'fixed', dirY: 'fixed' },
    },
    { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
    // Компонент-лок (LOC-7): на префабе его нет — контент ставит его сам.
    { name: LOCK_COMPONENT, fields: { mask: 'i32' } },
  ],
  prefabs: [
    {
      name: 'Hero',
      components: {
        Position: { x: F(1.5), y: F(1.5) },
        Player: { slot: 0 },
        Input: {},
        Velocity: {},
        Collider: {},
        Locomotion: { ...CONFIG },
        LocomotionState: {},
      },
    },
  ],
  terrain: TERRAIN,
};

/**
 * Мир с одним героем и конвейером Input → Locomotion; физика не участвует.
 * `lock` — сборка с параметрами селективного лока (LOC-7); без него система
 * собирается ровно как в остальных тестах файла.
 */
function harness(lock = false) {
  const { world, terrain, systems } = loadScene(SCENE);
  systems.register(new InputSystem({ players: ['p1'] }));
  systems.register(
    new LocomotionSystem(
      lock ? { lockComponent: LOCK_COMPONENT, maneuverLockBit: MANEUVER_LOCK_BIT } : {},
    ),
  );
  const hero = spawn(world, 'Hero');
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, terrain: terrain! };
  const state = initialState(world, 1);

  let at = 0;
  const step = (over: Partial<InputFrame> = {}): void => {
    at += 1;
    void tick(sim, state, [
      { tick: at, playerId: 'p1', seq: at, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0, ...over },
    ]);
  };
  return {
    world,
    hero,
    state,
    step,
    vel: () => ({
      x: getField(world, hero, 'Velocity', 'x'),
      y: getField(world, hero, 'Velocity', 'y'),
    }),
    st: (field: string) => getField(world, hero, 'LocomotionState', field),
    /** Постановка лока — то, что контент делает через Command Buffer. */
    setLock: (mask: number): void => {
      if (hasComponent(world, hero, LOCK_COMPONENT)) setField(world, hero, LOCK_COMPONENT, 'mask', mask);
      else addComponent(world, hero, LOCK_COMPONENT, { mask });
    },
    clearLock: (): void => {
      removeComponent(world, hero, LOCK_COMPONENT);
    },
    cliffRise: () => getField(world, hero, 'Collider', 'cliffRise'),
    airborne: () => hasComponent(world, hero, LEVEL_OVERRIDE_COMPONENT),
  };
}

describe('разгон и торможение (LOC-2)', () => {
  it('старт с места достигает maxSpeed точно, без перелёта', () => {
    const h = harness();
    h.step({ move: RIGHT });
    expect(h.vel().x).toBe(F(1.5));
    h.step({ move: RIGHT });
    expect(h.vel().x).toBe(F(3));
    h.step({ move: RIGHT });
    expect(h.vel().x).toBe(F(4)); // остаток 1.0 < accel — точный снап
    h.step({ move: RIGHT });
    expect(h.vel().x).toBe(F(4));
    expect(h.vel().y).toBe(0);
  });

  it('отпущенный ввод тормозит до точного нуля без смены знака', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.step({ move: RIGHT });
    h.step();
    expect(h.vel().x).toBe(F(1.5));
    h.step();
    expect(h.vel().x).toBe(0); // остаток 1.5 < decel — точный ноль
    h.step();
    expect(h.vel().x).toBe(0); // осцилляции вокруг нуля нет
  });

  it('разворот — постепенный, мгновенного скачка к −maxSpeed нет', () => {
    const h = harness();
    const LEFT: Vec2 = { x: F(-1), y: 0 };
    for (let i = 0; i < 4; i++) h.step({ move: RIGHT });
    const trace: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.step({ move: LEFT });
      trace.push(h.vel().x);
    }
    // |желаемая| ≤ |текущая| — торможение 2.5; после нуля — разгон 1.5.
    expect(trace).toEqual([F(1.5), F(0), F(-1.5), F(-3), F(-4)]);
  });
});

describe('уклон, окно даблтапа, перекат (LOC-3, LOC-4)', () => {
  it('одиночный уклон: Dodge → Window → Normal', () => {
    const h = harness();
    h.step({ move: UP, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    expect(h.st('ticksLeft')).toBe(CONFIG.dodgeTicks);
    expect(h.st('dirX')).toBe(0);
    expect(h.st('dirY')).toBe(F(1));
    expect(h.vel()).toEqual({ x: 0, y: F(6) });

    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    expect(h.st('ticksLeft')).toBe(CONFIG.windowTicks);

    h.step();
    h.step();
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
  });

  it('даблтап в окне — перекат: медленнее уклона, но дальше', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    let dodgeTravel = h.vel().x;
    while (h.st('state') === LOCOMOTION_DODGE) {
      h.step();
      dodgeTravel += h.vel().x;
    }
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);

    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_ROLL);
    expect(h.st('ticksLeft')).toBe(CONFIG.rollTicks);
    expect(h.vel().x).toBe(F(3)); // медленнее dodgeSpeed
    let rollTravel = h.vel().x;
    while (h.st('state') === LOCOMOTION_ROLL) {
      h.step();
      rollTravel += h.vel().x;
    }
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL); // перекат минует окно
    expect(rollTravel).toBeGreaterThan(dodgeTravel); // но дистанция больше
  });

  it('повторное нажатие при нулевом векторе — перекат в направлении уклона', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    h.step();
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    h.step({ buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_ROLL);
    expect(h.st('dirX')).toBe(F(1));
    expect(h.vel()).toEqual({ x: F(3), y: 0 });
  });

  it('удержание кнопки — не фронт: окно истекает в Normal, а не в Roll', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    h.step({ buttons: DODGE });
    h.step({ buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    h.step({ buttons: DODGE });
    h.step({ buttons: DODGE });
    h.step({ buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
  });

  it('нажатие после истечения окна — новый уклон, не перекат', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    for (let i = 0; i < 5; i++) h.step(); // уклон 2 + окно 3
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    h.step({ move: UP, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    expect(h.st('dirY')).toBe(F(1));
  });

  it('уклон при нулевом векторе движения игнорируется', () => {
    const h = harness();
    h.step({ buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    expect(h.vel()).toEqual({ x: 0, y: 0 });
  });

  it('чужая запись скорости не переживает тик манёвра', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    setField(h.world, h.hero, 'Velocity', 'x', F(1)); // как сделала бы другая система
    h.step();
    expect(h.vel().x).toBe(F(6)); // манёвр владеет скоростью (LOC-3)
  });
});

describe('прыжок (LOC-5)', () => {
  it('вход в Airborne ставит override уровня и cliffRise = jumpHeight', () => {
    const h = harness();
    expect(h.airborne()).toBe(false);
    h.step({ move: RIGHT, buttons: JUMP });
    expect(h.st('state')).toBe(LOCOMOTION_AIRBORNE);
    expect(h.st('ticksLeft')).toBe(CONFIG.jumpTicks);
    expect(h.vel()).toEqual({ x: F(2), y: 0 });
    expect(h.airborne()).toBe(true);
    // Уровень зафиксирован на момент отрыва — из terrain.levelOf (ARENA-6).
    expect(getField(h.world, h.hero, LEVEL_OVERRIDE_COMPONENT, 'level')).toBe(2);
    expect(h.cliffRise()).toBe(CONFIG.jumpHeight);
  });

  it('ввод в полёте игнорируется, приземление снимает override и cliffRise', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: JUMP });
    h.step({ move: UP, buttons: DODGE }); // ни направление, ни уклон не действуют
    expect(h.st('state')).toBe(LOCOMOTION_AIRBORNE);
    expect(h.vel()).toEqual({ x: F(2), y: 0 });

    h.step();
    h.step();
    expect(h.airborne()).toBe(true); // ещё в полёте
    h.step(); // ticksLeft 0 — тик приземления
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    expect(h.airborne()).toBe(false);
    expect(h.cliffRise()).toBe(0);
  });

  it('нулевой вектор движения — прыжок на месте', () => {
    const h = harness();
    h.step({ buttons: JUMP });
    expect(h.st('state')).toBe(LOCOMOTION_AIRBORNE);
    expect(h.vel()).toEqual({ x: 0, y: 0 });
  });

  it('прыжок в Roll игнорируется: манёвр один (LOC-3)', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    h.step();
    h.step();
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_ROLL);
    h.step({ buttons: JUMP });
    expect(h.st('state')).toBe(LOCOMOTION_ROLL);
    expect(h.airborne()).toBe(false);
  });

  it('прыжок из окна даблтапа не стартует: только из Normal', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    h.step();
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    h.step({ buttons: JUMP });
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    expect(h.airborne()).toBe(false);
  });
});

describe('состояние манёвра в снапшоте (LOC-3, SNAP-1)', () => {
  it('перемотка посреди уклона продолжает его с тем же счётчиком и направлением', () => {
    const h = harness();
    h.step({ move: RIGHT, buttons: DODGE });
    h.step();
    expect(h.st('ticksLeft')).toBe(1);
    const snapshot = takeSnapshot(h.state);

    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);

    restoreSnapshot(h.state, snapshot);
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    expect(h.st('ticksLeft')).toBe(1);
    expect(h.st('dirX')).toBe(F(1));

    // Проигрыш заново даёт тот же переход — состояние манёвра было в снапшоте.
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);
    expect(h.st('ticksLeft')).toBe(CONFIG.windowTicks);
    expect(h.vel().x).toBe(F(6));
  });
});

describe('селективный лок манёвров (LOC-7)', () => {
  it('без параметров лока система его не читает — компонент на сущности ничего не меняет', () => {
    const h = harness(); // сборка без lockComponent
    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
  });

  it('лок запрещает уклон, но не ходьбу: разгон и торможение штатные', () => {
    const h = harness(true);
    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    expect(h.vel().x).toBe(F(1.5)); // разгон идёт как обычно (LOC-2)
    h.step({ move: RIGHT });
    expect(h.vel().x).toBe(F(3));
    h.step();
    expect(h.vel().x).toBe(F(0.5)); // торможение тоже
  });

  it('лок запрещает прыжок', () => {
    const h = harness(true);
    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT, buttons: JUMP });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    expect(h.airborne()).toBe(false);
  });

  it('лок запрещает перекат: окно даблтапа истекает в Normal', () => {
    const h = harness(true);
    h.step({ move: RIGHT, buttons: DODGE });
    while (h.st('state') === LOCOMOTION_DODGE) h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW);

    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW); // перекат не стартовал
    h.step({ move: RIGHT });
    h.step({ move: RIGHT });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL); // окно дотикало
  });

  it('чужие биты маски ядро не интерпретирует', () => {
    const h = harness(true);
    h.setLock(1 << 3); // бит запрета каста — конвенция контента
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
  });

  it('лок посреди уклона его не прерывает: гейтится только старт', () => {
    const h = harness(true);
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    h.setLock(MANEUVER_LOCK); // лок пришёл посреди манёвра
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
    expect(h.vel().x).toBe(F(6)); // манёвр по-прежнему владеет скоростью
    h.step();
    expect(h.st('state')).toBe(LOCOMOTION_WINDOW); // доиграл до конца
  });

  it('проигнорированный фронт не буферизуется: нужно новое нажатие', () => {
    const h = harness(true);
    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);

    // Кнопка всё ещё зажата, лок снят — фронта нет, манёвр не стартует.
    h.clearLock();
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);

    // Отпустил и нажал заново — стартует.
    h.step({ move: RIGHT });
    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_DODGE);
  });

  it('перемотка с локом детерминирована: лок пришёл из снапшота (SNAP-1)', () => {
    const h = harness(true);
    h.setLock(MANEUVER_LOCK);
    h.step({ move: RIGHT });
    const snapshot = takeSnapshot(h.state);

    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    const blocked = h.vel();

    // Снятие лока ПОСЛЕ снапшота откатом отменяется — иначе повтор разошёлся бы.
    h.clearLock();
    restoreSnapshot(h.state, snapshot);
    expect(hasComponent(h.world, h.hero, LOCK_COMPONENT)).toBe(true);

    h.step({ move: RIGHT, buttons: DODGE });
    expect(h.st('state')).toBe(LOCOMOTION_NORMAL);
    expect(h.vel()).toEqual(blocked);
  });

  it('maneuverLockBit без компонента — ошибка конфигурации, не тишина', () => {
    expect(() => new LocomotionSystem({ maneuverLockBit: 1 })).toThrow(/lockComponent/);
    expect(() => new LocomotionSystem({ lockComponent: 'ActionLock', maneuverLockBit: 31 })).toThrow(
      /0\.\.30/,
    );
  });
});
