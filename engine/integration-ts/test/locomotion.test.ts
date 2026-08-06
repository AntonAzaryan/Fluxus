/**
 * Кросс-слойные тесты конвейера Input → LocomotionSystem → PhysicsSystem
 * (LOC-2, LOC-4, LOC-5, PHYS-8, PHYS-11, PHYS-12) на живой сцене через
 * публичную поверхность ядра — `runScenario` (CLI-9). Сцена собрана инлайн,
 * а не загружена из `content/` (CONT-4): ретюнинг контента не должен красить
 * этот тест.
 *
 * Все ожидаемые значения — целые Q16.16 (FP-1). TimeScale в сцене нет, поэтому
 * множитель интеграции равен единице (PHYS-8) и смещение за тик равно скорости
 * тика — равенства точные, без допусков.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_NORMAL,
  LOCOMOTION_ROLL,
  LOCOMOTION_WINDOW,
  STATIC_COLLIDER,
  fixed,
  runScenario,
  type InputFrame,
  type RunOutput,
  type SceneDef,
  type ScenarioSpawn,
  type TerrainDef,
} from '@game-mvp/core';

const PLAYER = 'p1';
/** Биты кнопок — параметры системы, а не конвенция ядра (LOC-1). */
const DODGE_BUTTON = 2;
const JUMP_BUTTON = 3;
const DODGE_MASK = 1 << DODGE_BUTTON;
const JUMP_MASK = 1 << JUMP_BUTTON;

const STEP: number = fixed.fromInt(1);

/**
 * Балансные числа героя — данные сцены, не ядра (LOC-1). Подобраны так, чтобы
 * траектории считались в уме: accel 2048 при maxSpeed 8192 насыщается за
 * четыре тика, манёвры кратны степеням двойки.
 */
const HERO_LOCOMOTION = {
  accel: 2048,
  decel: 4096,
  dodgeSpeed: 16384,
  dodgeTicks: 4,
  jumpHeight: 1,
  jumpSpeed: 16384,
  jumpTicks: 8,
  maxSpeed: 8192,
  rollSpeed: 8192,
  rollTicks: 16,
  windowTicks: 6,
} as const;

const HERO_HALF: number = 19661;
const BOLT_HALF: number = 6554;

/**
 * Состав компонентов — как в `content/scenes/duel.scene.json`, но сцена
 * построена инлайн (CONT-4). Герой: слой 2, `blockMask 1` — блокируется
 * статикой обрывов (её слой по умолчанию 1, PHYS-2). Снаряд-сенсор: `blockMask
 * 0` — ничто его не блокирует, `hitMask 2` — регистрирует пересечение с
 * героями событием `Overlap` (PHYS-12).
 */
function movementScene(terrain?: TerrainDef): SceneDef {
  return {
    components: [
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
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
      {
        name: 'Collider',
        fields: {
          blockMask: 'i32',
          cliffRise: 'i32',
          halfX: 'fixed',
          halfY: 'fixed',
          hitMask: 'i32',
          layer: 'i32',
          radius: 'fixed',
          shape: 'i32',
        },
      },
      {
        name: 'Locomotion',
        fields: {
          accel: 'fixed',
          decel: 'fixed',
          dodgeSpeed: 'fixed',
          dodgeTicks: 'i32',
          jumpHeight: 'i32',
          jumpSpeed: 'fixed',
          jumpTicks: 'i32',
          maxSpeed: 'fixed',
          rollSpeed: 'fixed',
          rollTicks: 'i32',
          windowTicks: 'i32',
        },
      },
      {
        name: 'LocomotionState',
        fields: { dirX: 'fixed', dirY: 'fixed', state: 'i32', ticksLeft: 'i32' },
      },
      { name: 'LevelOverride', fields: { level: 'i32' } },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
          Velocity: { x: 0, y: 0 },
          Collider: {
            blockMask: 1,
            cliffRise: 0,
            halfX: HERO_HALF,
            halfY: HERO_HALF,
            hitMask: 0,
            layer: 2,
            radius: HERO_HALF,
            shape: 0,
          },
          Locomotion: HERO_LOCOMOTION,
          LocomotionState: { dirX: 0, dirY: 0, state: 0, ticksLeft: 0 },
        },
        tags: ['Hero'],
      },
      {
        name: 'Bolt',
        components: {
          Position: { x: 0, y: 0 },
          Velocity: { x: 0, y: 0 },
          Collider: {
            blockMask: 0,
            cliffRise: 0,
            halfX: BOLT_HALF,
            halfY: BOLT_HALF,
            hitMask: 2,
            layer: 4,
            radius: BOLT_HALF,
            shape: 0,
          },
        },
        tags: ['Bolt'],
      },
    ],
    ...(terrain !== undefined ? { terrain } : {}),
    capacity: 16,
  };
}

/**
 * Обрыв 0 → 1 без рампы на линии x = 4: два уровня дают вертикальные рёбра
 * cliff-геометрии (TERR-5), направленный гейт которых проверяет PHYS-11.
 */
const CLIFF_TERRAIN: TerrainDef = {
  width: 8,
  height: 4,
  tileSize: fixed.fromInt(1),
  levels: ['00001111', '00001111', '00001111', '00001111'],
  flags: ['........', '........', '........', '........'],
};
const CLIFF_LINE: number = fixed.fromInt(4);

function run(
  name: string,
  ticks: number,
  scene: SceneDef,
  initial: readonly ScenarioSpawn[],
  inputs: readonly InputFrame[],
): RunOutput {
  return runScenario({
    name,
    seed: 20260806,
    ticks,
    scene,
    initial,
    inputs,
    players: [PLAYER],
    // Физика и локомоушен — зависимости сборки сценария, а не данные сцены (SER-7).
    physics: {},
    locomotion: { dodgeButton: DODGE_BUTTON, jumpButton: JUMP_BUTTON },
  });
}

function frame(tick: number, moveX: number, buttons: number): InputFrame {
  return { tick, playerId: PLAYER, seq: tick, move: { x: moveX, y: 0 }, aimDir: 0, buttons };
}

/** Ввод «идём вправо» на тиках [from, to] без кнопок. */
function walkRight(from: number, to: number): InputFrame[] {
  const frames: InputFrame[] = [];
  for (let tick = from; tick <= to; tick++) frames.push(frame(tick, STEP, 0));
  return frames;
}

function fieldAt(
  out: RunOutput,
  tick: number,
  component: string,
  field: string,
  index: number,
): number {
  const value = out.ticks[tick]?.world.components[component]?.[field]?.[index];
  if (value === undefined) {
    throw new Error(`${component}.${field}[${index}] отсутствует на тике ${tick}`);
  }
  return value;
}

/** Смещение за тик; равно скорости тика — множитель интеграции единичный (PHYS-8). */
function stepX(out: RunOutput, tick: number, index: number): number {
  return fieldAt(out, tick, 'Position', 'x', index) - fieldAt(out, tick - 1, 'Position', 'x', index);
}

function stateAt(out: RunOutput, tick: number, index: number): number {
  return fieldAt(out, tick, 'LocomotionState', 'state', index);
}

function eventsAt(out: RunOutput, tick: number, type: string) {
  const record = out.ticks[tick];
  if (record === undefined) throw new Error(`нет тика ${tick}`);
  return record.events.filter((event) => event.type === type);
}

function countEvents(out: RunOutput, type: string): number {
  return out.ticks.reduce((sum, record) => sum + record.events.filter((e) => e.type === type).length, 0);
}

describe('конвейер Input → Locomotion → Physics на живой сцене (CLI-9, CONT-4)', () => {
  // Без террейна первый спавн `initial` получает индекс 0 (ID-2).
  const HERO = 0;

  it('разгон до maxSpeed и торможение до точного нуля (LOC-2)', () => {
    const out = run(
      'locomotion-accel',
      10,
      movementScene(),
      [{ prefab: 'Hero', overrides: { Position: { x: fixed.fromInt(2), y: fixed.fromInt(2) } } }],
      walkRight(1, 6),
    );

    // Разгон: смещение растёт строго на accel за тик до насыщения на maxSpeed.
    const steps = [1, 2, 3, 4].map((tick) => stepX(out, tick, HERO));
    expect(steps).toEqual([2048, 4096, 6144, 8192]);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    // Насыщение точное, без осцилляции вокруг цели (LOC-2).
    expect(stepX(out, 5, HERO)).toBe(HERO_LOCOMOTION.maxSpeed);
    expect(stepX(out, 6, HERO)).toBe(HERO_LOCOMOTION.maxSpeed);

    // Отпущенный ввод: торможение на decel за тик до точного нуля.
    expect(stepX(out, 7, HERO)).toBe(4096);
    expect(stepX(out, 8, HERO)).toBe(0);
    expect(fieldAt(out, 10, 'Position', 'x', HERO)).toBe(fieldAt(out, 8, 'Position', 'x', HERO));
    // Манёвров не было: машина состояний не покидала Normal (LOC-3).
    expect(stateAt(out, 10, HERO)).toBe(LOCOMOTION_NORMAL);
  });

  it('уклон: рывок dodgeSpeed на dodgeTicks, окно и возврат в Normal (LOC-4)', () => {
    const out = run(
      'locomotion-dodge',
      12,
      movementScene(),
      [{ prefab: 'Hero', overrides: { Position: { x: fixed.fromInt(2), y: fixed.fromInt(2) } } }],
      // Фронт кнопки уклона при ненулевом векторе движения (LOC-3, LOC-4).
      [frame(1, STEP, DODGE_MASK)],
    );

    // Тик нажатия + dodgeTicks манёвра — каждый со смещением dodgeSpeed.
    for (let tick = 1; tick <= 5; tick++) {
      expect(stepX(out, tick, HERO)).toBe(HERO_LOCOMOTION.dodgeSpeed);
    }
    expect(stateAt(out, 3, HERO)).toBe(LOCOMOTION_DODGE);
    // По завершении рывка открывается окно даблтапа windowTicks (LOC-4).
    expect(stateAt(out, 6, HERO)).toBe(LOCOMOTION_WINDOW);
    // Окно истекло без повторного нажатия — возврат в Normal.
    expect(stateAt(out, 11, HERO)).toBe(LOCOMOTION_NORMAL);
  });

  it('даблтап в окне — перекат: медленнее уклона, но дальше (LOC-4)', () => {
    const dodge = run(
      'locomotion-dodge-travel',
      12,
      movementScene(),
      [{ prefab: 'Hero', overrides: { Position: { x: fixed.fromInt(2), y: fixed.fromInt(2) } } }],
      [frame(1, STEP, DODGE_MASK)],
    );
    const roll = run(
      'locomotion-roll',
      25,
      movementScene(),
      [{ prefab: 'Hero', overrides: { Position: { x: fixed.fromInt(2), y: fixed.fromInt(2) } } }],
      // Повторный фронт на тике 7 — внутри окна (уклон кончается на тике 5,
      // окно — 6 тиков); нулевой вектор движения берёт направление уклона.
      [frame(1, STEP, DODGE_MASK), frame(7, 0, DODGE_MASK)],
    );

    expect(stateAt(roll, 7, HERO)).toBe(LOCOMOTION_ROLL);
    // Перекат за тик медленнее уклона...
    expect(stepX(roll, 8, HERO)).toBe(HERO_LOCOMOTION.rollSpeed);
    expect(HERO_LOCOMOTION.rollSpeed).toBeLessThan(HERO_LOCOMOTION.dodgeSpeed);
    // ...но суммарная дистанция манёвра больше: (1 + rollTicks) × rollSpeed
    // против (1 + dodgeTicks) × dodgeSpeed.
    const dodgeTravel =
      fieldAt(dodge, 5, 'Position', 'x', HERO) - fieldAt(dodge, 0, 'Position', 'x', HERO);
    const rollTravel =
      fieldAt(roll, 23, 'Position', 'x', HERO) - fieldAt(roll, 6, 'Position', 'x', HERO);
    expect(dodgeTravel).toBe(5 * HERO_LOCOMOTION.dodgeSpeed);
    expect(rollTravel).toBe(17 * HERO_LOCOMOTION.rollSpeed);
    expect(rollTravel).toBeGreaterThan(dodgeTravel);
    // По завершении переката — Normal (LOC-4).
    expect(stateAt(roll, 24, HERO)).toBe(LOCOMOTION_NORMAL);
  });

  describe('прыжок через обрыв 0 → 1 (LOC-5, PHYS-11)', () => {
    // Сущность террейна спавнится первой (ID-2), герой — индекс 1.
    const HERO_T = 1;
    // Быстрый герой: разгон мгновенный, траектория считается без рампы accel.
    const JUMP_HERO: ScenarioSpawn = {
      prefab: 'Hero',
      overrides: {
        Position: { x: 163840, y: fixed.fromInt(2) },
        Locomotion: { accel: 32768, decel: 16384, maxSpeed: 16384 },
      },
    };

    it('без прыжка обрыв блокирует: герой стоит у линии, эмитится Collision', () => {
      const out = run('locomotion-cliff-blocked', 8, movementScene(CLIFF_TERRAIN), [JUMP_HERO], walkRight(1, 8));

      // 163840 + 4 × 16384 = 229376; пятый шаг заметает ребро x = 262144 и
      // гасится по оси (PHYS-8): cliffRise = 0 — гейт закрыт (PHYS-11).
      expect(fieldAt(out, 8, 'Position', 'x', HERO_T)).toBe(229376);
      expect(fieldAt(out, 8, 'Position', 'x', HERO_T) + HERO_HALF).toBeLessThan(CLIFF_LINE);
      // Заблокированный ход порождает столкновение со статикой (PHYS-9).
      expect(eventsAt(out, 5, 'Collision')).toEqual([
        {
          type: 'Collision',
          data: { entity: HERO_T, nx: fixed.fromInt(-1), ny: 0, other: STATIC_COLLIDER },
        },
      ]);
      expect(eventsAt(out, 4, 'Collision')).toHaveLength(0);
    });

    it('с прыжком jumpHeight = 1 гейт открыт: герой приземляется на верхнем уровне', () => {
      const out = run(
        'locomotion-cliff-jump',
        11,
        movementScene(CLIFF_TERRAIN),
        [JUMP_HERO],
        // Один фронт кнопки прыжка при движении вправо; в полёте ввод не нужен —
        // манёвр владеет скоростью (LOC-3).
        [frame(1, STEP, JUMP_MASK)],
      );

      expect(stateAt(out, 4, HERO_T)).toBe(LOCOMOTION_AIRBORNE);
      // На время полёта система выставляет cliffRise = jumpHeight (LOC-5, D3)...
      expect(fieldAt(out, 4, 'Collider', 'cliffRise', HERO_T)).toBe(1);
      // ...и снимает на тике приземления.
      expect(fieldAt(out, 9, 'Collider', 'cliffRise', HERO_T)).toBe(0);
      expect(stateAt(out, 9, HERO_T)).toBe(LOCOMOTION_NORMAL);

      // (1 + jumpTicks) × jumpSpeed = 9 × 16384: герой за линией обрыва целиком.
      expect(fieldAt(out, 11, 'Position', 'x', HERO_T)).toBe(311296);
      expect(fieldAt(out, 11, 'Position', 'x', HERO_T) - HERO_HALF).toBeGreaterThan(CLIFF_LINE);
      // Подъём 1 ≤ cliffRise 1 — ребро не блокировало ни одного тика (PHYS-11).
      expect(countEvents(out, 'Collision')).toBe(0);
    });
  });

  it('sensor-снаряд пролетает героя насквозь и даёт Overlap без блокировки (PHYS-12)', () => {
    const BOLT = 1;
    const heroX = fixed.fromInt(5);
    const out = run(
      'locomotion-sensor-bolt',
      8,
      movementScene(),
      [
        { prefab: 'Hero', overrides: { Position: { x: heroX, y: heroX } } },
        // Снаряд летит сквозь героя: blockMask 0 — не блокируется, hitMask 2
        // накрывает слой героя (PHYS-2).
        {
          prefab: 'Bolt',
          overrides: { Position: { x: fixed.fromInt(3), y: heroX }, Velocity: { x: 32768, y: 0 } },
        },
      ],
      [],
    );

    // Герой не сдвинут: снаряд не препятствие ни для кого (PHYS-12).
    for (let tick = 0; tick <= 8; tick++) {
      expect(fieldAt(out, tick, 'Position', 'x', HERO)).toBe(heroX);
      expect(fieldAt(out, tick, 'Position', 'y', HERO)).toBe(heroX);
    }
    // Снаряд прошёл насквозь и оказался за героем: 196608 + 8 × 32768.
    expect(fieldAt(out, 8, 'Position', 'x', BOLT)).toBe(458752);
    expect(fieldAt(out, 8, 'Position', 'x', BOLT) - BOLT_HALF).toBeGreaterThan(heroX + HERO_HALF);

    // Пересечение длится два тика — по одному Overlap на тик и пару (PHYS-12).
    expect(eventsAt(out, 4, 'Overlap')).toEqual([{ type: 'Overlap', data: { entity: BOLT, other: HERO } }]);
    expect(eventsAt(out, 5, 'Overlap')).toEqual([{ type: 'Overlap', data: { entity: BOLT, other: HERO } }]);
    expect(eventsAt(out, 3, 'Overlap')).toHaveLength(0);
    expect(eventsAt(out, 6, 'Overlap')).toHaveLength(0);
    // Блокировки не было нигде: у снаряда blockMask 0, герой недвижим.
    expect(countEvents(out, 'Collision')).toBe(0);
  });
});
