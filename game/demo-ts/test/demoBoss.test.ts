/**
 * Босс демо-сцены как КОНТЕНТ (`content/scenes/duel.scene.json`: prefab `Boss`,
 * определения `bossSlam`/`bossQuake`, документ поведения `arenaBoss`).
 *
 * Проверяется не платформа NPC — её механизмы закрыты `engine/core-ts/test/npc.test.ts`,
 * — а политика, написанная в JSON: что босс УЧАСТВУЕТ в бою обеими сторонами.
 * Ровно это и не ловилось раньше: у босса не было компонента `Player`, а весь
 * урон героев адресован цели с ним (`hasComponent(other,"Player")` в `onHit`
 * фаербола, запрос `["Health","Player","Position"]` у передержки), поэтому
 * снаряды сквозь него пролетали, hp не убывал и убить его было нельзя — сцена
 * при этом тикала штатно и молча.
 *
 * Босс — НЕЙТРАЛЬНЫЙ враждебный игрок: слот 2 при двух игроках матча (0 и 1),
 * то есть чужой обоим, и своя команда 2. Отсюда обе половины: снаряд любого
 * героя видит в нём законную цель (слоты не совпадают), а его собственная
 * площадная способность обязана исключать САМОГО себя — запрос `["Health",
 * "Player"]` теперь ловит и кастера.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  LOCOMOTION_DODGE,
  tick as simTick,
  world as coreWorld,
  type EntityId,
  type GameEvent,
  type InputFrame,
  type SceneDef,
  type SimulationState,
  type Simulation,
} from '@fluxus/core';
import { buildMatchWorld } from '@fluxus/net';
import { ACTION_BITS } from '../app/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';
import manifestJson from '../../../content/visuals/manifest.json';

const SCENE = sceneJson as unknown as SceneDef;

const MATCH = matchJson as unknown as {
  readonly seed: number;
  readonly players: readonly string[];
  readonly locomotion: Record<string, unknown>;
  /** Пересчёт видимости (NTR-14, FOW-4): сцена с `fog` без него не собирается. */
  readonly visibility?: Record<string, never>;
};

const MANIFEST = manifestJson as unknown as {
  readonly effects: { readonly byEvent: Record<string, { readonly radiusTo?: number }> };
  readonly particles: { readonly byEvent: Record<string, { readonly effect: string }> };
  readonly cameraEffects: { readonly events: Record<string, { readonly effect: string }> };
};

const CAST = 1 << ACTION_BITS.cast;
/** Прицел на восток — та же конвенция угла, что у дуэльных тестов (FP-7). */
const AIM_EAST = 0;
const AIM_REACH = 4 * FIXED_ONE;

/** Балансные числа сцены, ретюн которых обязан быть виден в диффе. */
const BOSS_HP = 4000;
const HIT_DAMAGE = 200;
const SLAM_DAMAGE = 180;
const QUAKE_DAMAGE = 280;
const SLAM_RADIUS = 262144;
const QUAKE_RADIUS = 458752;
/** `Locomotion` героя: рывок в сторону — `dodgeSpeed` × `dodgeTicks`. */
const DODGE_SPEED = 26214;
const DODGE_TICKS = 9;
const STRAFE_DISTANCE = DODGE_SPEED * DODGE_TICKS;
/** `BossRespawn`: окно возрождения босса — 10 с при 60 Гц. */
const BOSS_RESPAWN_TICKS = 600;
/**
 * Слой коллизий босса — СВОЙ, а не общий слой актёров (2): им герой блокируется
 * (`blockMask` 9 = обрывы + босс), а героя от героя он не трогает. Смерть гасит
 * слой в ноль общим путём сцены, возрождение возвращает именно этот.
 */
const BOSS_LAYER = 8;
/** Урон и радиус отталкивания в упор (`bossRepel`), кулдаун — его же. */
const REPEL_DAMAGE = 250;
const REPEL_RADIUS = 98304;
const REPEL_COOLDOWN = 90;
/** Радиусы тел: контакт героя с боссом — их сумма. */
const BOSS_RADIUS = 39321;
const HERO_RADIUS = 19661;
/** Центр арены (`arena.center` сцены) — точка возрождения босса. */
const ARENA_CENTER = 1572864;

interface Stand {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly boss: EntityId;
  readonly heroes: readonly EntityId[];
  /** Один тик; возвращает типы событий тика. */
  step(frames?: readonly { readonly buttons?: number; readonly moveX?: number }[]): readonly string[];
  /** События ПОСЛЕДНЕГО тика целиком: типам не видно ни направления, ни цели. */
  readonly last: { events: readonly GameEvent[] };
}

/**
 * Мир матча с ПОЛНОЙ расстановкой сцены: босс в центре арены остаётся на месте,
 * а герои встают там, где нужно тесту. Дуэльные тесты (`demoAbilities`) строят
 * тот же мир без `initial` сцены — здесь он и есть предмет проверки.
 */
function stand(cells: readonly (readonly [number, number])[], scene: SceneDef = SCENE): Stand {
  const players = cells.map((_unused, index) => `p${index + 1}`);
  const built = buildMatchWorld({
    scene,
    seed: MATCH.seed,
    players,
    initial: cells.map(([cx, cy], index) => ({
      prefab: 'Hero',
      overrides: {
        Player: { slot: index },
        Team: { id: index },
        Position: { x: Math.round(cx * FIXED_ONE), y: Math.round(cy * FIXED_ONE) },
      },
    })),
    physics: {},
    locomotion: MATCH.locomotion,
    ...(MATCH.visibility !== undefined ? { visibility: MATCH.visibility } : {}),
  });

  const heroes: EntityId[] = [];
  let boss: EntityId | undefined;
  for (const entity of coreWorld.listAlive(built.state.world)) {
    if (coreWorld.hasTag(built.state.world, entity, 'Boss')) boss = entity;
    if (!coreWorld.hasTag(built.state.world, entity, 'Hero')) continue;
    heroes[coreWorld.getField(built.state.world, entity, 'Player', 'slot')] = entity;
  }
  if (boss === undefined) throw new Error('расстановка сцены не поставила босса');

  let tick = 0;
  const last: { events: readonly GameEvent[] } = { events: [] };
  return {
    sim: built.sim,
    state: built.state,
    boss,
    heroes,
    last,
    step(frames = []) {
      tick += 1;
      const inputs: InputFrame[] = players.map((playerId, index) => ({
        tick,
        playerId,
        seq: tick,
        move: { x: frames[index]?.moveX ?? 0, y: 0 },
        aimDir: AIM_EAST,
        buttons: frames[index]?.buttons ?? 0,
        target: {
          x: coreWorld.getField(built.state.world, heroes[index]!, 'Position', 'x') + AIM_REACH,
          y: coreWorld.getField(built.state.world, heroes[index]!, 'Position', 'y'),
        },
      }));
      last.events = [...simTick(built.sim, built.state, inputs).events];
      return last.events.map((event) => event.type);
    },
  };
}

/**
 * Сцена с ретюненным запасом босса. Нужна там, где предмет проверки — ПУТЬ, а
 * не число: смерть от нуля и порог второй фазы документа `arenaBoss`. Сами
 * числа сцены пиннятся отдельным тестом ниже.
 */
function wounded(hp: number, hpMax: number = BOSS_HP): SceneDef {
  return {
    ...SCENE,
    prefabs: SCENE.prefabs!.map((prefab) =>
      prefab.name === 'Boss'
        ? { ...prefab, components: { ...prefab.components, Health: { hp, hpMax } } }
        : prefab,
    ),
  };
}

const hp = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Health', 'hp');

const px = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'x');

const py = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'y');

function distance(state: SimulationState, a: EntityId, b: EntityId): number {
  const dx = px(state, a) - px(state, b);
  const dy = py(state, a) - py(state, b);
  return Math.hypot(dx, dy);
}

/** Прогон до первого события `type` либо до исчерпания лимита тиков. */
function until(a: Stand, type: string, limit = 400): number {
  for (let t = 1; t <= limit; t++) {
    if (a.step().includes(type)) return t;
  }
  throw new Error(`событие ${type} не случилось за ${limit} тиков`);
}

describe('босс демо-сцены уязвим: способности героев на нём работают', () => {
  it('снаряд гаснет в боссе и снимает с него урон', () => {
    // Герой стоит западнее босса на его же ординате: выстрел на восток идёт
    // ровно в коллайдер босса.
    const a = stand([[20, 24]]);
    expect(hp(a.state, a.boss)).toBe(BOSS_HP);

    let events: readonly string[] = [];
    let ticks = 0;
    while (ticks < 40 && !events.includes('FireballExploded')) {
      events = a.step([{ buttons: ticks === 0 ? CAST : 0 }]);
      ticks += 1;
    }

    // Взрыв — на боссе, а не на истечении жизни снаряда: 40 тиков заведомо
    // меньше её полных 50.
    expect(events).toContain('FireballExploded');
    // Кровь — то же событие, что при попадании по герою: попадание видно.
    expect(events).toContain('HeroHit');
    expect(hp(a.state, a.boss)).toBe(BOSS_HP - HIT_DAMAGE);
    // Снаряд в боссе именно ГАСНЕТ, а не пролетает насквозь.
    expect(
      [...coreWorld.listAlive(a.state.world)].filter((e) =>
        coreWorld.hasTag(a.state.world, e, 'Fireball'),
      ),
    ).toHaveLength(0);
  });

  it('дошедший до нуля hp убивает босса, и через 10 с он встаёт в центре', () => {
    // hp ретюнится под один выстрел: проверяется путь смерти, а не число.
    const a = stand([[20, 24]], wounded(HIT_DAMAGE, HIT_DAMAGE));
    let events: readonly string[] = [];
    let ticks = 0;
    while (ticks < 40 && !events.includes('EntityDied')) {
      events = a.step([{ buttons: ticks === 0 ? CAST : 0 }]);
      ticks += 1;
    }

    expect(events).toContain('EntityDied');
    expect(hp(a.state, a.boss)).toBe(0);
    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    // Смерть идёт общим путём сцены (`HealthDeath`): коллайд снят, и труп
    // больше не задерживает снаряды.
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'layer')).toBe(0);

    // Возрождение — СВОЯ политика (`BossRespawn`), а не героическая: `Respawn`
    // требует `Spawn` и `LocomotionState`, которых у босса нет. Окно то же —
    // 600 тиков, ровно 10 с при 60 Гц, — и до последнего тика он лежит.
    for (let t = 1; t < BOSS_RESPAWN_TICKS; t++) {
      expect(a.step()).not.toContain('BossRespawned');
      expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    }
    expect(a.step()).toContain('BossRespawned');

    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(false);
    expect(hp(a.state, a.boss)).toBe(HIT_DAMAGE);
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'layer')).toBe(BOSS_LAYER);
    // В ЦЕНТРЕ арены, а не там, где его убили: точка возрождения — та же, что
    // `arena.center` сцены (зеркало пиннится ниже).
    expect(px(a.state, a.boss)).toBe(ARENA_CENTER);
    expect(py(a.state, a.boss)).toBe(ARENA_CENTER);
    // И начинает документ заново: `BossRespawn` (order 331) ставит `state = -1`,
    // а платформа СЛЕДУЮЩИМ тиком читает его как «состояние ещё не выбрано» и
    // входит в первое (NPC-2). Иначе босс вставал бы в фазе, в которой умер.
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'state')).toBe(-1);
    a.step();
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'state')).toBe(0);
  });
});

describe('босс бьёт по героям и отталкивает слэмом', () => {
  it('слэм снимает с героя урон и уносит его на дистанцию стрейфа', () => {
    // Герой стоит внутри радиуса слэма и в зоне чутья босса — тот сам доходит
    // до фазы `slam` документа `arenaBoss` и кастует.
    const a = stand([[26, 24.5]]);
    const hero = a.heroes[0]!;
    expect(hp(a.state, hero)).toBe(1000);

    // Замер — от положения на тике ПЕРЕД приземлением: во время замаха босс
    // ещё идёт к герою и мог бы подвинуть его телом.
    let before = { x: px(a.state, hero), y: py(a.state, hero) };
    let away = distance(a.state, hero, a.boss);
    for (let t = 1; t <= 400; t++) {
      const at = { x: px(a.state, hero), y: py(a.state, hero) };
      const gap = distance(a.state, hero, a.boss);
      if (a.step().includes('BossSlamLanded')) {
        before = at;
        away = gap;
        break;
      }
      if (t === 400) throw new Error('слэм не приземлился за 400 тиков');
    }

    expect(hp(a.state, hero)).toBe(1000 - SLAM_DAMAGE);
    // Отбрасывание — БУКВАЛЬНО стрейф: тот же `LOCOMOTION_DODGE`, что ставит
    // герою его собственный рывок (LOC-3, LOC-4). Единица разницы служебная:
    // эффект пишет состояние командой, а `LocomotionSystem` того же тика уже
    // отрабатывает первый шаг манёвра.
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'state')).toBe(LOCOMOTION_DODGE);
    const left = coreWorld.getField(a.state.world, hero, 'LocomotionState', 'ticksLeft');
    expect(left).toBe(DODGE_TICKS - 1);

    for (let t = 0; t < left; t++) a.step();
    const moved = Math.hypot(px(a.state, hero) - before.x, py(a.state, hero) - before.y);
    // Допуск — один тик рывка: столько стоит служебная единица выше.
    expect(Math.abs(moved - STRAFE_DISTANCE)).toBeLessThanOrEqual(DODGE_SPEED);
    // И уносит ОТ босса, а не куда попало.
    expect(distance(a.state, hero, a.boss)).toBeGreaterThan(away);
  });

  it('собственные способности босса его самого не задевают', () => {
    // Босс несёт `Player` и `Health`, то есть попадает под собственный запрос
    // `["Health","Player"]` — исключает его условие `victim != owner`.
    const slam = stand([[26, 24.5]]);
    until(slam, 'BossSlamLanded');
    expect(hp(slam.state, slam.boss)).toBe(BOSS_HP);

    // Вторая фаза документа `arenaBoss` открывается порогом `healthBelow` в
    // половину запаса, поэтому босс сюда приходит уже раненым.
    const hurt = Math.floor(BOSS_HP / 4);
    const quake = stand([[26, 24.5]], wounded(hurt));
    until(quake, 'BossQuakeLanded', 400);
    expect(hp(quake.state, quake.boss)).toBe(hurt);
  });
});

describe('числа и картинка босса: ретюн виден в диффе', () => {
  it('урон способностей и запас hp — те, по которым считает сцена', () => {
    const def = (id: string): Record<string, unknown> =>
      (SCENE as unknown as { abilities: readonly Record<string, unknown>[] }).abilities.find(
        (entry) => entry.id === id,
      )!;
    const numbers = (node: unknown, found: number[] = []): number[] => {
      if (typeof node === 'number') found.push(node);
      else if (Array.isArray(node)) for (const item of node) numbers(item, found);
      else if (node !== null && typeof node === 'object') {
        for (const value of Object.values(node)) numbers(value, found);
      }
      return found;
    };

    expect(numbers(def('bossSlam'))).toContain(SLAM_DAMAGE);
    expect(numbers(def('bossQuake'))).toContain(QUAKE_DAMAGE);
    expect(
      SCENE.prefabs!.find((prefab) => prefab.name === 'Boss')!.components.Health,
    ).toEqual({ hp: BOSS_HP, hpMax: BOSS_HP });
    // Запас босса — ровно двадцать необычных попаданий: столько стоит его
    // убийство в одиночку.
    expect(BOSS_HP / HIT_DAMAGE).toBe(20);
    // Слот — чужой обоим игрокам матча: снаряд каждого видит в боссе цель.
    const slot = SCENE.prefabs!.find((prefab) => prefab.name === 'Boss')!.components.Player!.slot;
    expect(slot).toBe(MATCH.players.length);

    // Возрождение: окно и точка. Точка — ЗЕРКАЛО `arena.center` сцены, и
    // разъехаться им нельзя: босс, встающий не в центре, вставал бы в чистом
    // поле, где документ `arenaBoss` его никогда не задумывал.
    const respawn = numbers(SCENE.systems!.find((system) => system.name === 'BossRespawn')!);
    expect(respawn).toContain(BOSS_RESPAWN_TICKS);
    expect(respawn).toContain(ARENA_CENTER);
    const center = (SCENE as unknown as { arena: { center: { x: number; y: number } } }).arena.center;
    expect(center).toEqual({ x: ARENA_CENTER, y: ARENA_CENTER });
  });

  it('радиусы вспышек в манифесте — радиусы, по которым способности бьют', () => {
    // Та же связь, что у оболочки купола: картинка обязана совпадать с зоной
    // урона, иначе игрок учится не тому.
    expect(MANIFEST.effects.byEvent.BossSlamLanded!.radiusTo).toBe(SLAM_RADIUS / FIXED_ONE);
    expect(MANIFEST.effects.byEvent.BossQuakeLanded!.radiusTo).toBe(QUAKE_RADIUS / FIXED_ONE);
    // Замах и приземление озвучены так же просто, как каст и взрыв у героя:
    // частицы на замахе, тряска на приземлении.
    expect(MANIFEST.particles.byEvent.BossTelegraph!.effect).toBe(
      MANIFEST.particles.byEvent.CastFireball!.effect,
    );
    expect(MANIFEST.cameraEffects.events.BossSlamLanded!.effect).toBe('shake');
    expect(MANIFEST.cameraEffects.events.BossQuakeLanded!.effect).toBe('shake');
  });
});

describe('герой и босс не проходят друг сквозь друга', () => {
  it('герой упирается в босса и не оказывается за ним', () => {
    // Босс стоит в центре арены, герой западнее и бежит на восток прямо в него.
    // До правки масок он проходил насквозь: `blockMask` героя знал только слой
    // обрывов (1), а босс лежал на общем слое актёров, который героя не держал.
    const a = stand([[21, 24]]);
    const hero = a.heroes[0]!;
    const contact = BOSS_RADIUS + HERO_RADIUS;

    for (let t = 0; t < 90; t++) {
      a.step([{ moveX: FIXED_ONE }]);
      // За спину босса герой не попадает ни на тик.
      expect(px(a.state, hero)).toBeLessThan(px(a.state, a.boss));
      // И не влезает в него: центры не сближаются ближе суммы радиусов.
      expect(distance(a.state, hero, a.boss)).toBeGreaterThanOrEqual(contact);
    }
  });

  it('герой героя по-прежнему не блокирует: слой босса свой, а не общий', () => {
    // Правка адресная. Общий слой актёров в `blockMask` героя развернул бы и
    // дуэль — там сквозное прохождение остаётся балансом, о котором отдельно
    // не просили.
    const collider = (name: string): Record<string, number> =>
      SCENE.prefabs!.find((prefab) => prefab.name === name)!.components.Collider as Record<
        string,
        number
      >;
    const hero = collider('Hero');
    const boss = collider('Boss');
    expect(hero.layer).toBe(2);
    expect(boss.layer).toBe(BOSS_LAYER);
    // Герой держится боссом и обрывами, но не героем.
    expect(hero.blockMask! & boss.layer!).toBe(boss.layer);
    expect(hero.blockMask! & hero.layer!).toBe(0);
    // Босс держится героями — «друг сквозь друга» верно в обе стороны.
    expect(boss.blockMask! & hero.layer!).toBe(hero.layer);
    // Снаряд по-прежнему видит в боссе сенсорную цель: слой сменился, маска — тоже.
    for (const name of ['Fireball', 'HeavyFireball']) {
      const ball = collider(name);
      expect(ball.hitMask! & boss.layer!).toBe(boss.layer);
      expect(ball.hitMask! & hero.layer!).toBe(hero.layer);
      // И НЕ блокируется им: снаряд гаснет попаданием, а не упирается в тело.
      expect(ball.blockMask! & boss.layer!).toBe(0);
    }
  });
});

describe('босс отталкивает подошедшего вплотную', () => {
  it('снимает 250, уносит на дистанцию стрейфа и разворачивает босса к жертве', () => {
    // Герой ставится внутрь радиуса отталкивания, но вне контакта тел.
    const a = stand([[25.2, 24]]);
    const hero = a.heroes[0]!;
    const before = { x: px(a.state, hero), y: py(a.state, hero) };
    const away = distance(a.state, hero, a.boss);
    expect(away).toBeLessThan(REPEL_RADIUS);

    // «Сразу же»: система близости просит отталкивание тем же тиком, каким
    // герой оказался рядом, а способность без фазы замаха бьёт на нём же.
    expect(a.step()).toContain('BossRepelLanded');
    expect(hp(a.state, hero)).toBe(1000 - REPEL_DAMAGE);

    // Отбрасывание — тот же `Dodge`-манёвр, что у слэма (LOC-3, LOC-4).
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'state')).toBe(
      LOCOMOTION_DODGE,
    );
    const left = coreWorld.getField(a.state.world, hero, 'LocomotionState', 'ticksLeft');
    expect(left).toBe(DODGE_TICKS - 1);
    for (let t = 0; t < left; t++) a.step();
    const moved = Math.hypot(px(a.state, hero) - before.x, py(a.state, hero) - before.y);
    expect(Math.abs(moved - STRAFE_DISTANCE)).toBeLessThanOrEqual(DODGE_SPEED);
    expect(distance(a.state, hero, a.boss)).toBeGreaterThan(away);
  });

  it('разворот к жертве едет направлением события, а не позой', () => {
    // Курс инстанса производен от скорости (REND-13), и стоящего босса он не
    // поворачивает. Разворот показывает доворот корпуса (REND-5) по `dirX`/`dirY`
    // события — на жертву, а не куда попало.
    const a = stand([[24, 25.2]]);
    const hero = a.heroes[0]!;
    a.step();
    const landed = a.last.events.find((event) => event.type === 'BossRepelLanded');
    expect(landed).toBeDefined();
    expect(landed!.data.entity).toBe(a.boss);
    expect(landed!.data.target).toBe(hero);
    // Герой стоит СЕВЕРНЕЕ босса: направление на него — почти чистый +y.
    expect(landed!.data.dirY!).toBeGreaterThan(0);
    expect(Math.abs(landed!.data.dirX!)).toBeLessThan(landed!.data.dirY!);
    // Тем же вектором уносит жертву: разворот и толчок — одно направление.
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'dirY')).toBeGreaterThan(0);
  });

  it('кулдаун держит паузу: второго удара в упор подряд не бывает', () => {
    const a = stand([[25.2, 24]]);
    expect(a.step()).toContain('BossRepelLanded');
    // Герой остаётся рядом (его уносит, но босс идёт следом), а способность
    // молчит: повторы глушит кулдаун слота, а не редкость события.
    for (let t = 1; t < REPEL_COOLDOWN; t++) {
      expect(a.step()).not.toContain('BossRepelLanded');
    }
  });

  it('мёртвый босс не отталкивает и не задерживает снаряды', () => {
    // hp ретюнится под один выстрел: предмет проверки — путь, а не число.
    const a = stand([[20, 24]], wounded(HIT_DAMAGE, HIT_DAMAGE));
    let events: readonly string[] = [];
    for (let t = 0; t < 40 && !events.includes('EntityDied'); t++) {
      events = a.step([{ buttons: t === 0 ? CAST : 0 }]);
    }
    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'layer')).toBe(0);

    // Герой бежит НА труп и дальше сквозь него, дольше кулдауна отталкивания:
    // запрос системы близости мертвеца не касается (`not: ["Dead"]`), а слой
    // коллизий смерть погасила — тело больше не препятствие.
    const hero = a.heroes[0]!;
    const healthy = hp(a.state, hero);
    let crossed = false;
    for (let t = 0; t < REPEL_COOLDOWN + 60; t++) {
      expect(a.step([{ moveX: FIXED_ONE }])).not.toContain('BossRepelLanded');
      if (px(a.state, hero) > px(a.state, a.boss)) crossed = true;
    }
    // Прошёл насквозь и цел: ни отталкивания, ни урона от трупа.
    expect(crossed).toBe(true);
    expect(hp(a.state, hero)).toBe(healthy);
  });
});
