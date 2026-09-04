/**
 * Демо-сцена как контент (`content/scenes/duel.scene.json`): проверяется не
 * ядро, а проводка сборки демо и политика падения в пустоту, написанная в JSON.
 *
 * Механизм — за ядром (`arena` ARENA-5 эмитит `FellThroughFloor`), политика —
 * системы сцены `FallStart`/`FallDeath`: снижение по тикам и смерть по
 * достижении глубины. Тест ловит ровно то, что unit-тесты пакетов не видят:
 * сцена, у которой герой не подписан на проверку пола или у сборки нет арены,
 * тикает штатно и молча.
 *
 * Арена — диск пола радиуса ~22 в сетке 48×48 (клетки вне вписанной окружности
 * без пола) с четырьмя плато по квадрантам и рампой к каждому со стороны
 * центра. Здесь пиннится геометрия, от которой зависит геймплей: подъём по
 * КАЖДОЙ из четырёх рамп действительно проходим (TERR-5), а шаг за кромку
 * диска — с любой стороны провал.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  tick as simTick,
  world as coreWorld,
  type EntityId,
  type GameEvent,
  type SceneDef,
  type WorldState,
} from '@fluxus/core';
import { ABILITY_SLOTS, ACTION_BITS, PLAYER_ID, createDemoSimulation } from '../app/sim.js';
import { DEMO_NAVIGATION } from '../app/match.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';
import manifestJson from '../../../content/visuals/manifest.json';

const SCENE = sceneJson as unknown as SceneDef;

/**
 * Манифест визуалов — только те две таблицы, которые ставят эффект НА СОБЫТИЕ
 * (ASSET-6, ASSET-14): их записи и есть потребители точки события (REND-24).
 */
const VISUALS = manifestJson as unknown as {
  readonly particles?: { readonly byEvent?: Readonly<Record<string, unknown>> };
  readonly effects?: { readonly byEvent?: Readonly<Record<string, unknown>> };
};

/**
 * Пустая арена — та же сцена без её собственной расстановки (`initial`).
 * Расстановка сцены — босс в центре, и он теперь полноценный участник боя:
 * преследует героя, бьёт по площади и отталкивает слэмом. Здесь проверяются
 * геометрия диска и рампы, то есть куда герой ДОХОДИТ сам; сбивающий его с
 * маршрута босс был бы посторонней переменной. Его поведение — `demoBoss.test.ts`.
 */
const EMPTY_ARENA = { ...SCENE, initial: [] } as unknown as SceneDef;

/** Расстановка матча дуэли (SER-8): по ней спавнятся оба героя. */
const MATCH = matchJson as unknown as {
  readonly initial: readonly {
    readonly prefab: string;
    readonly overrides?: { readonly Position?: { readonly x: number; readonly y: number } };
  }[];
};

/** Центр арены — те же числа, что в секции `arena` сцены. */
const CENTER = 24;
/** Радиус круга арены (ARENA-1); диск пола заведомо шире него. */
const ARENA_RADIUS = 21;

type Waypoint = readonly [number, number];

/**
 * Маршрут к плато квадранта. Каждый начинается на спавне p1 и идёт по
 * свободному коридору центра до подножия рампы: рампа подходит к плато со
 * стороны середины арены единственной полосой уровня плато, а весь остальной
 * периметр — обрыв в один уровень. ПЕШКОМ он непроходим, но плато
 * одноуровневые, а прыжок героя открывает допуск подъёма ровно в единицу
 * (LOC-5), поэтому кромка берётся прыжком в любом месте — рампа даёт путь БЕЗ
 * прыжка, а не единственный вход (пиннится тестом кромки ниже).
 */
interface RampRoute {
  readonly name: string;
  readonly level: number;
  readonly path: readonly Waypoint[];
}

/** Плато теперь одноуровневые: подъём — ровно одна ступень 0 → 1 в любом квадранте. */
const PLATEAU_LEVEL = 1;

const RAMP_ROUTES: readonly RampRoute[] = [
  // СЗ: полоса рампы в колонке 19, вход с земли колонки 20.
  { name: 'СЗ', level: PLATEAU_LEVEL, path: [[8.5, 20.5], [20.5, 20.5], [20.5, 14.5], [17.5, 14.5]] },
  // СВ: полоса рампы в колонке 28, вход с земли колонки 27.
  { name: 'СВ', level: PLATEAU_LEVEL, path: [[26.5, 24.5], [26.5, 14.5], [29.5, 14.5]] },
  // ЮЗ: полоса рампы в колонке 19, вход с земли колонки 20.
  { name: 'ЮЗ', level: PLATEAU_LEVEL, path: [[22.5, 24.5], [22.5, 32.5], [17.5, 32.5]] },
  // ЮВ: полоса рампы в колонке 28, вход с земли колонки 27.
  { name: 'ЮВ', level: PLATEAU_LEVEL, path: [[24.5, 24.5], [24.5, 32.5], [29.5, 32.5]] },
];

/** Мировая координата героя в единицах клеток — по ней и строится маршрут. */
function positionOf(world: WorldState, entity: EntityId, field: 'x' | 'y'): number {
  return coreWorld.getField(world, entity, 'Position', field) / FIXED_ONE;
}

/**
 * Ход по маршруту осевыми шагами: по каждой оси ввод держится, пока цель
 * дальше допуска. Диагоналей нет намеренно — ввод сцены нормализуется, и
 * осевой шаг делает маршрут воспроизводимым. `onTick` зовётся после каждого
 * ПРОТИКАННОГО тика: наблюдение за дорогой — дело вызывающего, а второго
 * прохода по тому же маршруту ради него заводить незачем.
 */
function walkPath(
  path: readonly Waypoint[],
  limit: number,
  onTick?: (demo: ReturnType<typeof createDemoSimulation>) => void,
) {
  const demo = createDemoSimulation(EMPTY_ARENA);
  const { sim, state, playerId } = demo;
  const TOLERANCE = 0.3;
  let leg = 0;
  let ticks = 0;
  while (leg < path.length && ticks < limit) {
    const [targetX, targetY] = path[leg]!;
    const dx = targetX - positionOf(state.world, playerId, 'x');
    const dy = targetY - positionOf(state.world, playerId, 'y');
    if (Math.abs(dx) <= TOLERANCE && Math.abs(dy) <= TOLERANCE) {
      // Точка маршрута достигнута — тик на это не тратится.
      leg += 1;
      continue;
    }
    // Сначала выравнивается ось с большим остатком: путь состоит из осевых
    // отрезков, и второй остаток на каждом из них уже нулевой.
    const move =
      Math.abs(dx) > Math.abs(dy)
        ? { x: dx > 0 ? FIXED_ONE : -FIXED_ONE, y: 0 }
        : { x: 0, y: dy > 0 ? FIXED_ONE : -FIXED_ONE };
    ticks += 1;
    simTick(sim, state, [
      { tick: ticks, playerId: PLAYER_ID, seq: ticks, move, aimDir: 0, buttons: 0 },
    ]);
    onTick?.(demo);
  }
  return { ...demo, legsDone: leg, ticks };
}

/** Уход по прямой до кромки диска: пола там нет, и герой проваливается. */
function walkOffTheEdge(direction: -1 | 1, limit: number) {
  const { sim, state, playerId } = createDemoSimulation(EMPTY_ARENA);
  let fellAt: number | null = null;
  let diedAt: number | null = null;
  let leftAt: number | null = null;
  let fellAtX = 0;
  /** Скорость В ПОЛЁТЕ (тик провала): импульс за кромку падение не отбирает. */
  let fallingVelX = 0;
  for (let tick = 1; tick <= limit; tick++) {
    const result = simTick(sim, state, [
      {
        tick,
        playerId: PLAYER_ID,
        seq: tick,
        move: { x: direction * FIXED_ONE, y: 0 },
        aimDir: 0,
        buttons: 0,
      },
    ]);
    for (const event of result.events) {
      if (event.type === 'LeftArena' && leftAt === null) leftAt = tick;
      if (event.type === 'FellThroughFloor' && fellAt === null) {
        fellAt = tick;
        fellAtX = positionOf(state.world, playerId, 'x');
        fallingVelX = coreWorld.getField(state.world, playerId, 'Velocity', 'x');
      }
      if (event.type === 'EntityDied' && diedAt === null) diedAt = tick;
    }
    if (diedAt !== null) break;
  }
  return {
    state,
    playerId,
    fellAt,
    diedAt,
    leftAt,
    fellAtX,
    fallingVelX,
    atX: positionOf(state.world, playerId, 'x'),
  };
}

describe('демо-сцена: кромка диска и смерть в пустоте (ARENA-5)', () => {
  for (const [side, direction, beyond] of [
    ['западной', -1, (x: number): boolean => x < CENTER - ARENA_RADIUS],
    ['восточной', 1, (x: number): boolean => x > CENTER + ARENA_RADIUS],
  ] as const) {
    it(`герой доходит до ${side} кромки, проваливается и умирает достигнув глубины`, () => {
      const { state, playerId, fellAt, diedAt, leftAt, fellAtX, fallingVelX, atX } =
        walkOffTheEdge(direction, 1200);

      expect(fellAt).not.toBeNull();
      expect(diedAt).not.toBeNull();
      // Смерть — не в тике провала: снижение занимает `deathDepth / speed` = 300
      // шагов, первый из которых делается на самом тике провала (`FallDeath`
      // идёт после `FallStart` в том же тике). Столько же длится снижение модели
      // в рендере: 75 единиц на 15 единицах в секунду при 60 Гц (REND-12).
      expect(diedAt! - fellAt!).toBe(299);
      // Круг арены вложен в диск пола: выход за него случается СТРОГО раньше
      // провала, и политика, повешенная на `LeftArena`, успевает сработать по
      // ещё стоящему на полу герою (ARENA-1..5).
      expect(leftAt).not.toBeNull();
      expect(leftAt!).toBeLessThan(fellAt!);
      // Провал случился на кромке диска, а не где-то в его середине.
      expect(beyond(fellAtX)).toBe(true);

      expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(true);
      expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(true);
      // Управление отобрано на входе в провал: конфигурации локомоушена нет.
      // Скорость на ЭТОМ переходе не трогается — импульс, с которым герой ушёл
      // за кромку, сохраняется, и он падает по дуге, а не оседает отвесно.
      expect(coreWorld.hasComponent(state.world, playerId, 'Locomotion')).toBe(false);
      expect(fallingVelX * direction).toBeGreaterThan(0);
      expect((atX - fellAtX) * direction).toBeGreaterThan(0);
      // А СМЕРТЬ скорость обнуляет — тем же тиком и так же, как два других пути
      // (`KillSwitch`, `HealthDeath`). Иначе труп все 600 тиков окна возрождения
      // продолжал бы ехать по инерции и уезжал бы прочь с карты.
      expect(coreWorld.getField(state.world, playerId, 'Velocity', 'x')).toBe(0);
      expect(coreWorld.getField(state.world, playerId, 'Velocity', 'y')).toBe(0);
      // Override уровня (ARENA-6): падающий больше не выводит уровень из позиции.
      expect(coreWorld.hasComponent(state.world, playerId, 'LevelOverride')).toBe(true);
    });
  }

  it('зажатая кнопка каста копит заряд и стреляет ровно раз — на отпускании (INP-2)', () => {
    // Held-семантика ввода (INP-2) даёт бит во всех тиках удержания. Каст
    // ловит фронт (триггер определения), а ОТПУСКАНИЕ завершает фазу `release`
    // (ABIL-4): тем же тиком записывается шаг прицеливания (ABIL-5) и летит
    // снаряд. Удержание не спамит снарядами, а копит заряд, и на одно нажатие
    // приходится ровно один снаряд.
    const { sim, state, playerId } = createDemoSimulation(EMPTY_ARENA);
    const CAST = 1 << ACTION_BITS.cast;
    const fireballs = (): number => {
      let count = 0;
      for (const entity of coreWorld.listAlive(state.world)) {
        if (coreWorld.hasTag(state.world, entity, 'Fireball')) count += 1;
      }
      return count;
    };
    /** Остаток кулдауна каста — поле компонента сущности-слота героя (ABIL-1). */
    const castCooldown = (): number => {
      for (const entity of coreWorld.listAlive(state.world)) {
        if (!coreWorld.hasComponent(state.world, entity, 'AbilitySlot')) continue;
        if (coreWorld.getField(state.world, entity, 'AbilitySlot', 'owner') !== playerId) continue;
        if (coreWorld.getField(state.world, entity, 'AbilitySlot', 'slotIndex') !== ABILITY_SLOTS.cast) {
          continue;
        }
        return coreWorld.getField(state.world, entity, 'AbilityCooldown', 'remaining');
      }
      throw new Error('слот каста не выдан');
    };
    /** Все снаряды, ЖИВШИЕ за прогон: долетевший исчезает, и живого счёта мало. */
    const spawned = new Set<EntityId>();
    const step = (tick: number, buttons: number): void => {
      simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons },
      ]);
      for (const entity of coreWorld.listAlive(state.world)) {
        if (coreWorld.hasTag(state.world, entity, 'Fireball')) spawned.add(entity);
      }
    };

    for (let tick = 1; tick <= 10; tick++) step(tick, CAST);
    // Кнопка всё ещё зажата — снаряда нет, есть заряд.
    expect(fireballs()).toBe(0);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(true);

    // Отпускание — и есть выстрел: ждать второй кнопки не нужно и нечего.
    step(11, 0);
    expect(fireballs()).toBe(1);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(false);

    // Повторное нажатие на неостывшем кулдауне заряда не начинает.
    expect(castCooldown()).toBeGreaterThan(0);
    step(12, CAST);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(false);
    expect(fireballs()).toBe(1);

    // Второй цикл «нажал-отпустил» после кулдауна даёт ВТОРОЙ снаряд: удержание
    // не спамит, но и не запирает способность навсегда. Считаются РОДИВШИЕСЯ
    // за прогон, а не живые: первый снаряд к этому времени долетел и исчез.
    expect(spawned.size).toBe(1);
    let tick = 13;
    while (castCooldown() > 0) {
      step(tick, 0);
      tick += 1;
    }
    step(tick, CAST);
    step(tick + 1, 0);
    expect(spawned.size).toBe(2);
    expect(fireballs()).toBe(1);
  });

  it('на полу событий провала нет и герой жив', () => {
    const { sim, state, playerId } = createDemoSimulation(EMPTY_ARENA);
    for (let tick = 1; tick <= 60; tick++) {
      const result = simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 },
      ]);
      for (const event of result.events) {
        expect(event.type).not.toBe('FellThroughFloor');
        expect(event.type).not.toBe('EntityDied');
      }
    }
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
  });
});

describe('демо-сцена: подъём по рампам всех четырёх квадрантов (TERR-5, TERR-7)', () => {
  for (const route of RAMP_ROUTES) {
    it(`${route.name}: герой поднимается по рампе на уровень ${route.level}`, () => {
      // Уровни собираются по дороге: подъём обязан идти ступенями по единице,
      // а не прыжком через обрыв, — и последняя ступень равна уровню плато.
      const seen: number[] = [];
      const { state, playerId, terrain, legsDone } = walkPath(route.path, 1500, (demo) => {
        const level = demo.terrain.levelOf(demo.playerId);
        if (seen[seen.length - 1] !== level) seen.push(level);
      });

      // Маршрут пройден целиком: упёршись в обрыв, герой не дошёл бы до цели.
      expect(legsDone).toBe(route.path.length);
      expect(terrain.levelOf(playerId)).toBe(route.level);
      expect(seen).toEqual(Array.from({ length: route.level + 1 }, (_, i) => i));
      // Провала по дороге не случилось: рампа и плато — клетки с полом.
      expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
      expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
    });
  }
});

describe('демо-сцена: кромка плато вне рампы (LOC-5, PHYS-11)', () => {
  /**
   * Проба ведёт под ЮЖНУЮ кромку СЗ-плато (клетки 11..18 по обеим осям) в
   * колонке 12: рампа этого квадранта стоит в колонке 19, то есть за семь
   * клеток отсюда. Маршрут — осевой: на восток вдоль ряда спавна, потом на
   * север до строки под кромкой.
   */
  const RIM_PATH: readonly Waypoint[] = [[12.5, 24.5], [12.5, 20.5]];
  /** Бит прыжка — `ACTION_BITS.jump` сборки демо. */
  const JUMP = 1 << 3;
  /** Строка 19 — последняя на нулевом уровне; строка 18 уже плато. */
  const RIM_Y = 19;

  it('пешком кромка держит, прыжком берётся — плато одноуровневое, как и прыжок', () => {
    const walked = walkPath(RIM_PATH, 600);
    const { sim, state, playerId, terrain } = walked;
    expect(walked.legsDone).toBe(RIM_PATH.length);
    expect(terrain.levelOf(playerId)).toBe(0);

    let tick = walked.ticks;
    /** Шаг на север; `buttons` — только чтобы нажать прыжок ровно одним тиком. */
    const north = (buttons: number): void => {
      tick += 1;
      simTick(sim, state, [
        {
          tick,
          playerId: PLAYER_ID,
          seq: tick,
          move: { x: 0, y: -FIXED_ONE },
          aimDir: 0,
          buttons,
        },
      ]);
    };

    // Пешком: обрыв в единицу — статика, и герой упирается в кромку, сколько бы
    // ни держал ввод. Уровень остаётся нулевым, а координата не заходит за ряд.
    for (let i = 0; i < 60; i++) north(0);
    expect(terrain.levelOf(playerId)).toBe(0);
    const stuckY = positionOf(state.world, playerId, 'y');
    expect(stuckY).toBeGreaterThan(RIM_Y);

    // Прыжок (LOC-5) пишет в коллайдер `cliffRise` = `jumpHeight` на время
    // полёта, а высота прыжка равна высоте плато: гейт обрыва (PHYS-11)
    // пропускает подъём в единицу, и герой оказывается наверху ВНЕ рампы.
    // Фронт кнопки — один тик: удержание тут ничего не меняет.
    north(JUMP);
    for (let i = 0; i < 40; i++) north(0);
    expect(terrain.levelOf(playerId)).toBe(PLATEAU_LEVEL);
    expect(positionOf(state.world, playerId, 'y')).toBeLessThan(RIM_Y);
    // Приземлился на плато, а не провалился с него в пустоту по дороге.
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
  });
});

describe('локальный режим собирает тот же состав, что матч (SHELL-8, NTR-14)', () => {
  it('одиночная симуляция печёт навигацию числами документа матча', () => {
    // Локальная сборка (`worker.ts`) и сетевая обязаны тикать один состав:
    // навигация, собранная в одной и пропущенная в другой, водила бы NPC
    // разными дорогами в двух режимах одной игры (NPC-6), а в локальном
    // режиме заметить это некому — сервера у него нет.
    expect(DEMO_NAVIGATION).toBeDefined();
    const demo = createDemoSimulation(SCENE);
    expect(demo.sim.navigation).toBeDefined();
    const path = demo.sim.navigation!.findPath(
      { x: 557056, y: 1605632 },
      { x: 2588672, y: 1605632 },
    );
    expect(path.status).toBe('found');
  });
});

describe('демо-матч: симметричный спавн героев на полу диска', () => {
  it('обе записи расстановки стоят в центрах клеток, на земле и зеркально центру', () => {
    const { terrain, grid } = createDemoSimulation(EMPTY_ARENA);
    const positions = MATCH.initial.map((entry) => entry.overrides?.Position);
    expect(positions.every((p) => p !== undefined)).toBe(true);

    for (const position of positions as { x: number; y: number }[]) {
      expect(terrain.hasFloorAt(position)).toBe(true);
      expect(terrain.levelAt(position)).toBe(0);
      // Ряд спавна — тот, в котором лежит центр арены.
      expect(Math.floor(position.y / FIXED_ONE)).toBe(CENTER);
    }

    const [p1, p2] = positions as { x: number; y: number }[];
    const left = p1!.x / FIXED_ONE;
    const right = p2!.x / FIXED_ONE;
    expect(left).toBeLessThan(CENTER);
    expect(right).toBeGreaterThan(CENTER);
    // Зеркальны и мировые позиции, и клетки под ними: спавн в центре клетки, а
    // не в её углу, — иначе одна из двух позиций разрешалась бы в клетку-соседа.
    expect(CENTER - left).toBe(right - CENTER);
    expect(Math.floor(left) + Math.floor(right)).toBe(grid.width - 1);
  });
});

/**
 * Точка события для рендера (REND-24): эффект, поставленный манифестом НА
 * СОБЫТИЕ, играется в мировой точке — координатах события, а нет их, позиции
 * названной им сущности. Вторая дорога у сетевой сборки ненадёжна, и не по
 * дефекту: события едут своим сообщением со своим курсором (`netcode-transport`
 * NTR-15), отбираются по видимости НА ТИКЕ ПУБЛИКАЦИИ (`netcode` NET-13), а
 * сущность приезжает персональным снапшотом ДРУГОГО тика — уже без неё, если
 * между публикацией и рассылкой она умерла или ушла в туман. Такое событие
 * доезжает законно, а играть его негде: рендер говорит «нет ни координат, ни
 * доставленной сущности» и молчит.
 *
 * Поэтому координаты события — обязанность КОНТЕНТА, а не поблажка рендера, и
 * держит её тест, а не память автора сцены.
 */
describe('события сцены, которые играет манифест, несут точку (REND-24)', () => {
  /** Все `emitEvent` сцены: тип → объединение имён полей данных. */
  const emitted = new Map<string, Set<string>>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const emit = record.emitEvent as { type?: unknown; data?: unknown } | undefined;
    if (emit !== undefined && typeof emit.type === 'string') {
      const fields = emitted.get(emit.type) ?? new Set<string>();
      if (emit.data !== null && typeof emit.data === 'object') {
        for (const key of Object.keys(emit.data)) fields.add(key);
      }
      emitted.set(emit.type, fields);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(SCENE);

  const played = [
    ...new Set([
      ...Object.keys(VISUALS.particles?.byEvent ?? {}),
      ...Object.keys(VISUALS.effects?.byEvent ?? {}),
    ]),
  ]
    .filter((type) => emitted.has(type))
    .sort();

  it('манифест и сцена вообще пересекаются — иначе проверять нечего', () => {
    expect(played).toContain('CastFireball');
  });

  for (const type of played) {
    it(`"${type}" несёт x и y`, () => {
      const fields = emitted.get(type)!;
      expect(fields.has('x') && fields.has('y')).toBe(true);
    });
  }
});

describe('каст фаербола отдаёт рендеру точку, а не только сущность (REND-24)', () => {
  it('CastFireball несёт координаты кастующего на тике публикации', () => {
    // РЕГРЕССИЯ: событие несло только `entity`, и в сетевом матче раз за матч —
    // в момент, когда владелец переставал быть доставленным, — всполох каста
    // играть было негде.
    const { sim, state, playerId } = createDemoSimulation(EMPTY_ARENA);
    const CAST = 1 << ACTION_BITS.cast;
    const step = (tick: number, buttons: number): GameEvent[] => [
      ...simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons },
      ]).events,
    ];

    for (let tick = 1; tick <= 10; tick++) step(tick, CAST);
    const x = coreWorld.getField(state.world, playerId, 'Position', 'x');
    const y = coreWorld.getField(state.world, playerId, 'Position', 'y');
    const cast = step(11, 0).find((event) => event.type === 'CastFireball');
    expect(cast).toBeDefined();
    // Ровно позиция владельца: пока сущность доставлена, картинка не меняется —
    // ту же точку рендер брал бы сам; меняется случай, когда её нет.
    expect(cast!.data.x).toBe(x);
    expect(cast!.data.y).toBe(y);
    expect(cast!.data.entity).toBe(playerId);
  });
});
