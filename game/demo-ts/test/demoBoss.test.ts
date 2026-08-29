/**
 * Босс демо-арены как КОНТЕНТ (`content/scenes/duel.scene.json`: prefab `Boss`,
 * определения `bossStrike`/`bossSlam`/`bossCharge`/`bossRepel`/`bossFireAura`,
 * системы `Boss*` и документ поведения `arenaBoss`).
 *
 * Проверяется не платформа NPC и не платформа способностей — их механизмы
 * закрыты `engine/core-ts/test/npc.test.ts` и `abilities.test.ts`, — а ПОЛИТИКА,
 * написанная в JSON: кого босс выбирает целью, чем и на какую дистанцию бьёт,
 * что он при этом видит игрок и во что это обходится ему самому.
 *
 * Босс — НЕЙТРАЛЬНЫЙ враждебный игрок: слот 2 при двух игроках матча (0 и 1),
 * то есть чужой обоим, и своя команда 2. Отсюда обе половины проверки: снаряд
 * любого героя видит в нём законную цель, а его собственные площадные
 * способности обязаны исключать всех, кроме героев, — что и делает `withTag`
 * их запросов.
 *
 * Ротацией босса правят СИСТЕМЫ сцены, а не исполнитель `cast` документа
 * поведения (NPC-7): тот публикует просьбу только на ФРОНТЕ смены выбранного
 * действия, и повторный каст пришлось бы выражать циклом состояний. Документ
 * поэтому сведён к одному состоянию «преследовать», а «чем ударить» решает
 * `BossRotation` на −792 — обычная JSON-система, читающая кулдауны слотов.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { mdxLoader, type NormalizedModel } from '@fluxus/assets';
import { resolveClip } from '@fluxus/render';
import { DEMO_AIM_EVENTS } from '../app/extractor.js';
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

interface EffectEntry {
  readonly radius?: number;
  readonly radiusTo?: number;
}

const MANIFEST = manifestJson as unknown as {
  readonly entities: Record<string, { readonly animations: { readonly events: Record<string, string> } }>;
  readonly effects: {
    readonly byKind: Record<string, EffectEntry>;
    readonly byEvent: Record<string, EffectEntry>;
  };
  readonly particles: { readonly byEvent: Record<string, { readonly effect: string }> };
  readonly cameraEffects: { readonly events: Record<string, { readonly effect: string }> };
};

const CAST = 1 << ACTION_BITS.cast;

// ------------------------------------------------- балансные числа сцены
//
// Все они ЗЕРКАЛА документа: тест ищет каждое внутри определения, куда бы оно
// там ни переехало (см. «числа сцены» ниже), поэтому ретюн краснеет здесь, а
// не проявляется поведением.

/** Радиус тела босса: от него считаны и коридор волны, и взрыв слэма. */
const BOSS_RADIUS = 39321;
/**
 * «Средняя дистанция» боя с боссом — 5 мировых единиц. Одно число на три
 * величины: досягаемость волны удара, отброс слэма и отброс в упор. Мерка
 * взята от арены (радиус 21) и от собственного рывка героя (3.6): дальше
 * рывка, но далеко не через арену.
 */
const MEDIUM = 327680;
/** Ширина коридора волны — радиус тела босса. */
const WAVE_RADIUS = BOSS_RADIUS;
/** Взрыв слэма — три радиуса тела. */
const SLAM_RADIUS = 3 * BOSS_RADIUS;
/** Пятно огня вдвое меньше тела босса. */
const FIRE_RADIUS = 19661;

const STRIKE_WINDUP = 48; // 800 мс
const STRIKE_CD = 60; // 1 с
const STRIKE_DAMAGE = 300;
const SLAM_ROAR = 90; // 1.5 с
const SLAM_DAMAGE = 500;
const CHARGE_AIM = 120; // 2 с
const DASH_DAMAGE = 500;
const FIRE_LIFE = 240; // 4 с
const FIRE_PERIOD = 60; // 1 с
const FIRE_DAMAGE = 100;
const REPEL_DAMAGE = 200;
const REPEL_CD = 45;

/** Окно охоты за одной целью и окно возрождения — оба по 10 с при 60 Гц. */
const HUNT_TICKS = 600;
const BOSS_RESPAWN_TICKS = 600;
/** Вероятность переключиться на обидчика — 0.2 в Q16.16. */
const RAGE_CHANCE = 13107;

const BOSS_HP = 4000;
const HERO_HP = 1000;
const HIT_DAMAGE = 200;
/** Слой коллизий босса — свой, а не общий слой актёров (2). */
const BOSS_LAYER = 8;
const BOSS_BLOCK_MASK = 3;
/** Допуск подъёма босса: он всходит на любое плато арены (уровень 1 над 0). */
const BOSS_CLIFF_RISE = 1;
/** Центр арены (`arena.center` сцены) — точка возрождения босса. */
const ARENA_CENTER = 1572864;
/** `Locomotion` героя: шаг отброса — его собственный `dodgeSpeed`. */
const DODGE_SPEED = 26214;
/** Тиков отброса на среднюю дистанцию: `toInt(MEDIUM / dodgeSpeed)`. */
const KNOCKBACK_TICKS = 12;

const ABILITY_STRIKE = 8;

// ---------------------------------------------------------------- стенд

interface Frame {
  readonly buttons?: number;
  readonly moveX?: number;
  readonly moveY?: number;
}

interface Stand {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly boss: EntityId;
  readonly heroes: readonly EntityId[];
  /** Один тик; возвращает типы событий тика. */
  step(frames?: readonly Frame[]): readonly string[];
  /** Номер последнего исполненного тика — им меряются сроки замахов. */
  at(): number;
  /** События ПОСЛЕДНЕГО тика целиком: типам не видно ни направления, ни цели. */
  readonly last: { events: readonly GameEvent[] };
}

/**
 * Мир матча с ПОЛНОЙ расстановкой сцены: босс в центре арены остаётся на месте,
 * а герои встают там, где нужно тесту. Дуэльные тесты (`demoAbilities`) строят
 * тот же мир без `initial` сцены — здесь он и есть предмет проверки.
 *
 * Точка прицела всех героев — босс: иначе шаг прицеливания фаербола (ABIL-5)
 * записал бы начало координат, и выстрел ушёл бы мимо арены.
 */
function stand(
  cells: readonly (readonly [number, number])[],
  scene: SceneDef = SCENE,
  seed: number = MATCH.seed,
): Stand {
  const players = cells.map((_unused, index) => `p${index + 1}`);
  const built = buildMatchWorld({
    scene,
    seed,
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
  const bossEntity = boss;

  let tick = 0;
  const last: { events: readonly GameEvent[] } = { events: [] };
  return {
    sim: built.sim,
    state: built.state,
    boss: bossEntity,
    heroes,
    last,
    at: () => tick,
    step(frames = []) {
      tick += 1;
      const inputs: InputFrame[] = players.map((playerId, index) => ({
        tick,
        playerId,
        seq: tick,
        move: { x: frames[index]?.moveX ?? 0, y: frames[index]?.moveY ?? 0 },
        aimDir: 0,
        buttons: frames[index]?.buttons ?? 0,
        target: {
          x: coreWorld.getField(built.state.world, bossEntity, 'Position', 'x'),
          y: coreWorld.getField(built.state.world, bossEntity, 'Position', 'y'),
        },
      }));
      last.events = [...simTick(built.sim, built.state, inputs).events];
      return last.events.map((event) => event.type);
    },
  };
}

/** Сцена с ретюненным запасом hp: предмет проверки — ПУТЬ, а не число. */
function health(prefab: string, hp: number, scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) =>
      entry.name === prefab
        ? { ...entry, components: { ...entry.components, Health: { hp, hpMax: hp } } }
        : entry,
    ),
  };
}

/** Сцена с правкой коллайдера босса — ею проверяются допуск подъёма и точка старта. */
function bossCollider(fields: Record<string, number>, scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) =>
      entry.name === 'Boss'
        ? {
            ...entry,
            components: {
              ...entry.components,
              Collider: { ...(entry.components.Collider as Record<string, number>), ...fields },
            },
          }
        : entry,
    ),
  };
}

function bossAt(cx: number, cy: number, scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) =>
      entry.name === 'Boss'
        ? {
            ...entry,
            components: {
              ...entry.components,
              Position: { x: Math.round(cx * FIXED_ONE), y: Math.round(cy * FIXED_ONE) },
            },
          }
        : entry,
    ),
  };
}

/**
 * Сцена, где боссу выданы заведомо неисчерпаемые стартовые кулдауны на все
 * способности, кроме перечисленных. Так изолируется ОДНА из них: иначе первый
 * же тик уводит босса в замах, а `supersede` (ABIL-6) делает соседние касты
 * взаимоисключающими.
 */
function only(...keep: readonly string[]): SceneDef {
  const parked = new Set(
    ['SlotBossStrike', 'SlotBossSlam', 'SlotBossCharge', 'SlotBossRepel'].filter(
      (name) => !keep.includes(name),
    ),
  );
  return {
    ...SCENE,
    prefabs: SCENE.prefabs!.map((entry) =>
      parked.has(entry.name)
        ? {
            ...entry,
            components: {
              ...entry.components,
              AbilityCooldown: {
                ...(entry.components.AbilityCooldown as Record<string, number>),
                remaining: 100000,
              },
            },
          }
        : entry,
    ),
  };
}

const repelOnly = (): SceneDef => only('SlotBossRepel');

const hp = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Health', 'hp');

const px = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'x');

const py = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'y');

function distance(state: SimulationState, a: EntityId, b: EntityId): number {
  return Math.hypot(px(state, a) - px(state, b), py(state, a) - py(state, b));
}

/** Слот босса по индексу определения (ABIL-1): по нему читаются фаза и кулдаун. */
function slotOf(a: Stand, abilityId: number): EntityId {
  for (const entity of coreWorld.listAlive(a.state.world)) {
    if (!coreWorld.hasComponent(a.state.world, entity, 'AbilitySlot')) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'owner') !== a.boss) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'abilityId') === abilityId) return entity;
  }
  throw new Error(`у босса нет слота способности ${abilityId}`);
}

const tagged = (a: Stand, tag: string): readonly EntityId[] =>
  [...coreWorld.listAlive(a.state.world)].filter((entity) =>
    coreWorld.hasTag(a.state.world, entity, tag),
  );

/** Прогон до первого события `type`; возвращает АБСОЛЮТНЫЙ номер тика стенда. */
function until(a: Stand, type: string, limit = 400, frames?: readonly Frame[]): number {
  for (let t = 1; t <= limit; t++) {
    if (a.step(frames).includes(type)) return a.at();
  }
  throw new Error(`событие ${type} не случилось за ${limit} тиков`);
}

/** Все числа поддерева документа — ими сверяются зеркала констант выше. */
function numbers(node: unknown, found: number[] = []): number[] {
  if (typeof node === 'number') found.push(node);
  else if (Array.isArray(node)) for (const item of node) numbers(item, found);
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) numbers(value, found);
  }
  return found;
}

const abilityDef = (id: string): Record<string, unknown> =>
  (SCENE as unknown as { abilities: readonly Record<string, unknown>[] }).abilities.find(
    (entry) => entry.id === id,
  )!;

const systemDef = (name: string): Record<string, unknown> =>
  SCENE.systems!.find((entry) => entry.name === name)! as unknown as Record<string, unknown>;

// ------------------------------------------------------------------ тесты

describe('босс охотится за случайной целью', () => {
  it('цель — жребий, а не первый по расстановке', () => {
    // Сорок независимых миров: если бы выбор ехал порядком расстановки или
    // близостью, во всех сорока побеждал бы один и тот же герой.
    const picked = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const a = stand([[20, 24], [28, 24]], SCENE, seed);
      a.step();
      const ask = a.last.events.find((event) => event.type === 'BossHunting');
      expect(ask, `seed ${seed}: босс не выбрал цель на первом тике`).toBeDefined();
      picked.add(ask!.data.target === a.heroes[0] ? 'A' : 'B');
    }
    expect([...picked].sort()).toEqual(['A', 'B']);
  });

  it('держит цель десять секунд и перевыбирает — иногда ту же', () => {
    // Способности боссу запаркованы: он только преследует, героев не задевает
    // и потому не выбивает их с арены. Предмет проверки — СРОК охоты, и
    // посторонние смерти сдвигали бы его, ничего не сообщая о нём самом.
    const picks: { tick: number; target: EntityId }[] = [];
    const a = stand([[20, 24], [28, 24]], only(), 1);
    for (let t = 1; t <= 5 * HUNT_TICKS + 1; t++) {
      a.step();
      for (const event of a.last.events) {
        if (event.type === 'BossHunting') picks.push({ tick: t, target: event.data.target! });
      }
    }
    expect(picks.length).toBeGreaterThanOrEqual(5);
    // Ровно десять секунд между перевыборами — окно `BossHunt.untilTick`.
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i]!.tick - picks[i - 1]!.tick).toBe(HUNT_TICKS);
    }
    // Цель и меняется, и повторяется: «возможно, ту же самую» — это про
    // жребий, а не про запрет повтора.
    const changed = picks.some((pick, i) => i > 0 && pick.target !== picks[i - 1]!.target);
    const repeated = picks.some((pick, i) => i > 0 && pick.target === picks[i - 1]!.target);
    expect(changed).toBe(true);
    expect(repeated).toBe(true);
  });

  it('мёртвую цель бросает сразу, не дожидаясь окна', () => {
    // Один герой убивает себя kill-switch'ем; второй — единственный живой, и
    // босс обязан переключиться тем же тиком, а не через десять секунд.
    const a = stand([[20, 24], [28, 24]], SCENE, 3);
    a.step();
    const first = a.last.events.find((event) => event.type === 'BossHunting')!;
    const victim = first.data.target!;
    const other = a.heroes.find((hero) => hero !== victim)!;
    const kill = a.heroes.map((hero) => (hero === victim ? { buttons: 1 << ACTION_BITS.kill } : {}));

    const events = a.step(kill);
    expect(events).toContain('EntityDied');
    expect(a.step()).toContain('BossHunting');
    expect(a.last.events.find((event) => event.type === 'BossHunting')!.data.target).toBe(other);
  });
});

describe('босс переключается на обидчика с вероятностью 20%', () => {
  it('переключение случается, но далеко не на каждом попадании', { timeout: 60000 }, () => {
    // Замер по ансамблю сидов, а не по одному броску: единственная удача или
    // единственная неудача о вероятности не говорит ничего. Считаются
    // ПОДХОДЯЩИЕ попадания — те, где бьёт живой герой, который сейчас не цель:
    // ровно на них система `BossRage` и тянет жребий.
    let rollable = 0;
    let enraged = 0;
    const scene = health('Hero', 400000);
    for (let seed = 1; seed <= 12; seed++) {
      const a = stand([[21, 24], [27, 24]], scene, seed);
      for (let t = 1; t <= 1200; t++) {
        const fire = t % 70 === 0 ? CAST : 0;
        a.step([{ buttons: fire }, { buttons: fire }]);
        const target = coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target');
        for (const event of a.last.events) {
          if (event.type === 'BossEnraged') enraged += 1;
          if (event.type !== 'Damage') continue;
          if (event.data.entity !== a.boss) continue;
          if (event.data.source === target) continue;
          if (a.heroes.includes(event.data.source!)) rollable += 1;
        }
      }
    }
    // Контроль: без попаданий по боссу мерить было бы нечего.
    expect(rollable).toBeGreaterThan(50);
    expect(enraged).toBeGreaterThan(0);
    expect(enraged).toBeLessThan(rollable);
    // Доля вокруг объявленных 20%: полоса широкая намеренно — предмет проверки
    // редкость переключения, а не точное число выпавших орлов.
    const percent = (enraged * 100) / rollable;
    expect(percent).toBeGreaterThan(8);
    expect(percent).toBeLessThan(40);
  });

  it('вероятность живёт в системе, а не в коде', () => {
    expect(numbers(systemDef('BossRage'))).toContain(RAGE_CHANCE);
    expect(RAGE_CHANCE / FIXED_ONE).toBeCloseTo(0.2, 3);
  });
});

describe('отталкивание: пассивный микровзрыв на столкновении', () => {
  it('снимает 200 и уносит на среднюю дистанцию', () => {
    // Герой бежит в босса и упирается в него телом — физика эмитит
    // `Collision` (PHYS-9), система `BossContact` запоминает столкнувшегося, и
    // способность просится следующим тиком: событие живёт один тик (EVT-2), а
    // машина фаз читает шину раньше физики.
    const a = stand([[20, 24]], repelOnly());
    const hero = a.heroes[0]!;
    const forward = [{ moveX: FIXED_ONE }];

    const bump = until(a, 'Collision', 200, forward);
    const before = { x: px(a.state, hero), y: py(a.state, hero) };
    const away = distance(a.state, hero, a.boss);
    expect(a.step(forward)).toContain('BossRepelLanded');
    expect(bump).toBeGreaterThan(1);
    expect(hp(a.state, hero)).toBe(HERO_HP - REPEL_DAMAGE);

    // Отброс — БУКВАЛЬНО рывок жертвы: тот же `LOCOMOTION_DODGE`, что ставит
    // герою его собственный уклон (LOC-3, LOC-4), и число тиков считается от
    // его же `dodgeSpeed`. Единица разницы служебная: способность пишет
    // состояние командой, а `LocomotionSystem` того же тика уже отрабатывает
    // первый шаг манёвра.
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'state')).toBe(LOCOMOTION_DODGE);
    const left = coreWorld.getField(a.state.world, hero, 'LocomotionState', 'ticksLeft');
    expect(left).toBe(KNOCKBACK_TICKS - 1);

    for (let t = 0; t < left; t++) a.step();
    const moved = Math.hypot(px(a.state, hero) - before.x, py(a.state, hero) - before.y);
    // Допуск — один тик рывка: столько стоит служебная единица выше.
    expect(Math.abs(moved - MEDIUM)).toBeLessThanOrEqual(DODGE_SPEED);
    expect(distance(a.state, hero, a.boss)).toBeGreaterThan(away);
  });

  it('разворот к жертве едет направлением события, а не позой', () => {
    // Курс инстанса производен от скорости (REND-13), и стоящего босса он не
    // поворачивает. Событие несёт `dirX`/`dirY` на жертву — по ним рендер
    // доворачивает корпус (REND-5).
    const a = stand([[24, 20]], repelOnly());
    const hero = a.heroes[0]!;
    until(a, 'BossRepelLanded', 200, [{ moveY: FIXED_ONE }]);
    const landed = a.last.events.find((event) => event.type === 'BossRepelLanded')!;
    expect(landed.data.entity).toBe(a.boss);
    expect(landed.data.target).toBe(hero);
    // Герой ЮЖНЕЕ босса: направление на него — почти чистый −y.
    expect(landed.data.dirY!).toBeLessThan(0);
    expect(Math.abs(landed.data.dirX!)).toBeLessThan(Math.abs(landed.data.dirY!));
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'dirY')).toBeLessThan(0);
  });

  it('кулдаун держит паузу: второго толчка подряд не бывает', () => {
    const a = stand([[20, 24]], repelOnly());
    const forward = [{ moveX: FIXED_ONE }];
    until(a, 'BossRepelLanded', 200, forward);
    for (let t = 1; t < REPEL_CD; t++) {
      expect(a.step(forward)).not.toContain('BossRepelLanded');
    }
  });

  it('идущий каст толчок не срывает: замах доходит до волны', () => {
    // `supersede` (ABIL-6) прерывает чужой каст того же владельца безусловно,
    // поэтому подбежавший герой мог бы срывать боссу каждый замах собственным
    // телом. Гейт живёт в `BossRepelAsk`: пока хоть один слот в фазе, просьба
    // не публикуется вовсе.
    const a = stand([[20, 24]]);
    const hero = a.heroes[0]!;
    const forward = [{ moveX: FIXED_ONE }];
    const windup = until(a, 'BossStrikeWindup', 20, forward);
    let bumped = false;
    while (a.at() < windup + STRIKE_WINDUP) {
      const events = a.step(forward);
      if (events.includes('Collision')) bumped = true;
      // Пока замах идёт, толчок молчит — иначе он и оборвал бы этот замах.
      if (a.at() < windup + STRIKE_WINDUP) expect(events).not.toContain('BossRepelLanded');
    }
    expect(bumped).toBe(true);
    // Замах дожил до волны ровно 800 мс, несмотря на столкновения.
    expect(a.last.events.map((event) => event.type)).toContain('BossStrikeLanded');
    expect(hp(a.state, hero)).toBe(HERO_HP - STRIKE_DAMAGE);
  });
});

describe('удар: замах и волна вперёд', () => {
  it('замах длится 800 мс, потом волна — и кулдаун в секунду', () => {
    const a = stand([[27, 24]]);
    const hero = a.heroes[0]!;
    const windup = until(a, 'BossStrikeWindup', 20);
    const landed = until(a, 'BossStrikeLanded', 200);
    expect(landed - windup).toBe(STRIKE_WINDUP);
    expect(hp(a.state, hero)).toBe(HERO_HP - STRIKE_DAMAGE);

    // Волна — отдельная сущность-снаряд: её жизнь считает платформа (ABIL-9),
    // а урона она не несёт вовсе — коридор проверен один раз, на приземлении.
    expect(tagged(a, 'BossWave')).toHaveLength(1);
    // Кулдаун взведён и убывает: второй просьбы об ударе секунду не будет.
    expect(
      coreWorld.getField(a.state.world, slotOf(a, ABILITY_STRIKE), 'AbilityCooldown', 'remaining'),
    ).toBe(STRIKE_CD - 1);
    for (let t = 1; t < STRIKE_CD; t++) expect(a.step()).not.toContain('BossStrike');
  });

  it('волна бьёт коридором вперёд, а не кругом', () => {
    // Крест героев на равном расстоянии: кого бы жребий ни выбрал целью,
    // задет обязан быть ровно он — остальные трое стоят вбок и назад.
    const a = stand([[27, 24], [21, 24], [24, 27], [24, 21]]);
    until(a, 'BossStrikeLanded', 200);
    const landed = a.last.events.find((event) => event.type === 'BossStrikeLanded')!;
    const dirX = landed.data.dirX!;
    const dirY = landed.data.dirY!;

    let hit = 0;
    for (const hero of a.heroes) {
      const dx = px(a.state, hero) - (landed.data.x ?? 0);
      const dy = py(a.state, hero) - (landed.data.y ?? 0);
      const along = (dx * dirX + dy * dirY) / FIXED_ONE;
      const side = Math.abs(dx * dirY - dy * dirX) / FIXED_ONE;
      const inside = along >= 0 && along <= MEDIUM && side <= WAVE_RADIUS;
      expect(hp(a.state, hero), `герой на ${along / FIXED_ONE}/${side / FIXED_ONE}`).toBe(
        inside ? HERO_HP - STRIKE_DAMAGE : HERO_HP,
      );
      if (inside) hit += 1;
    }
    // Контроль: коридор кого-то накрыл, иначе проверялось бы пустое множество.
    expect(hit).toBe(1);
  });

  it('за досягаемостью волны урона нет: убежавший из коридора цел', () => {
    // Босс на замахе СТОИТ (`BossCastHold` гасит ему скорость), и герой успевает
    // выйти за пять единиц — тот же замах, та же волна, урона нет.
    const away = stand([[28.5, 24]]);
    until(away, 'BossStrikeLanded', 200, [{ moveX: FIXED_ONE }]);
    expect(hp(away.state, away.heroes[0]!)).toBe(HERO_HP);
    expect(px(away.state, away.heroes[0]!) - px(away.state, away.boss)).toBeGreaterThan(MEDIUM);

    // Тот же стенд без бегства — попадание: разница ровно в дистанции.
    const held = stand([[28.5, 24]]);
    until(held, 'BossStrikeLanded', 200);
    expect(hp(held.state, held.heroes[0]!)).toBe(HERO_HP - STRIKE_DAMAGE);
  });
});

describe('слем: рёв и круговой взрыв', () => {
  it('рёв 1.5 с, взрыв в три радиуса тела, 500 урона и отброс', () => {
    // Ближний герой внутри взрыва, дальний — снаружи: радиус проверяется
    // границей, а не фактом попадания.
    const a = stand([[25.5, 24], [26.6, 24]]);
    const near = a.heroes[0]!;
    const far = a.heroes[1]!;
    expect(distance(a.state, near, a.boss)).toBeLessThan(SLAM_RADIUS);
    expect(distance(a.state, far, a.boss)).toBeGreaterThan(SLAM_RADIUS);

    const roar = until(a, 'BossSlamRoar', 20);
    const before = { x: px(a.state, near), y: py(a.state, near) };
    const gap = distance(a.state, near, a.boss);
    const landed = until(a, 'BossSlamLanded', 200);
    expect(landed - roar).toBe(SLAM_ROAR);

    expect(hp(a.state, near)).toBe(HERO_HP - SLAM_DAMAGE);
    expect(hp(a.state, far)).toBe(HERO_HP);
    expect(a.last.events.find((event) => event.type === 'BossSlamLanded')!.data.radius).toBe(
      SLAM_RADIUS,
    );

    const left = coreWorld.getField(a.state.world, near, 'LocomotionState', 'ticksLeft');
    expect(left).toBe(KNOCKBACK_TICKS - 1);
    for (let t = 0; t < left; t++) a.step();
    const moved = Math.hypot(px(a.state, near) - before.x, py(a.state, near) - before.y);
    expect(Math.abs(moved - MEDIUM)).toBeLessThanOrEqual(DODGE_SPEED);
    expect(distance(a.state, near, a.boss)).toBeGreaterThan(gap);
  });
});

describe('разгон: наводка, рывок и полоса огня', () => {
  it('наводится 2 с, потом рассекает цель на 500 — ровно раз за рывок', () => {
    const a = stand([[36, 24]]);
    const hero = a.heroes[0]!;
    const aim = until(a, 'BossChargeAim', 20);
    const start = until(a, 'BossChargeStarted', 300);
    expect(start - aim).toBe(CHARGE_AIM);
    // На рывке боссу ничто не мешает — ни обрывы, ни тела (PHYS-2).
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'blockMask')).toBe(0);

    let hits = 0;
    const before = px(a.state, a.boss);
    for (let t = 1; t <= 60; t++) {
      const events = a.step();
      for (const event of a.last.events) {
        if (event.type === 'Damage' && event.data.entity === hero && event.data.amount === DASH_DAMAGE) {
          hits += 1;
        }
      }
      if (events.includes('BossChargeEnded')) break;
    }
    // Ровно одно попадание за рывок — метка `DashMark` жертвы держит счёт.
    expect(hits).toBe(1);
    expect(hp(a.state, hero)).toBe(HERO_HP - DASH_DAMAGE);
    // Босс ПРОШЁЛ сквозь цель, а не встал перед ней.
    expect(px(a.state, a.boss)).toBeGreaterThan(px(a.state, hero));
    expect(px(a.state, a.boss) - before).toBeGreaterThan(MEDIUM);
    // И маска блокировки вернулась: рывок кончился, тело снова упирается.
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'blockMask')).toBe(BOSS_BLOCK_MASK);
  });

  it('рассекает обрыв: там, где шагом не подняться, рывок проносит', () => {
    // Босс стоит ПОД плато (уровень 1 над 0), допуск подъёма ему снят: шагом
    // он упирается в обрыв, потому что идёт строго на север и скользить вдоль
    // стены ему нечем. Разница между двумя прогонами — только в дистанции до
    // цели, то есть в том, дотягивается ли до неё удар или просится разгон.
    const flat = bossCollider({ cliffRise: 0 }, bossAt(14, 8, health('Hero', 400000)));

    const walk = stand([[14, 12.5]], flat);
    for (let t = 1; t <= 400; t++) walk.step();
    expect(py(walk.state, walk.boss)).toBeLessThan(11 * FIXED_ONE);

    const dash = stand([[14, 14]], flat);
    for (let t = 1; t <= 400; t++) dash.step();
    expect(py(dash.state, dash.boss)).toBeGreaterThan(11 * FIXED_ONE);
  });

  it('оставляет полосу огня: 4 с жизни и 100 урона в секунду', () => {
    // Разгон в изоляции: после рывка босс стоит вплотную и герою нечем мешать
    // гореть — иначе тики огня перемешались бы с ударами и отбросами.
    const a = stand([[36, 24]], health('Hero', 400000, only('SlotBossCharge')));
    const started = until(a, 'BossChargeStarted', 300);
    const ended = until(a, 'BossChargeEnded', 100);
    const patches = tagged(a, 'BossFire');
    // Полоса, а не одно пятно: пятно на каждый тик рывка.
    expect(patches.length).toBe(ended - started + 1);
    expect(
      coreWorld.getField(a.state.world, patches[0]!, 'AbilityDuration', 'remaining'),
    ).toBeGreaterThan(FIRE_LIFE - patches.length - 2);

    // Тики огня: ровно по сотне и ровно раз в секунду, источник — пятно, а не
    // сам босс.
    const burns = new Map<EntityId, number[]>();
    let total = 0;
    while (a.at() < ended + 3 * FIRE_PERIOD) {
      const t = a.at() + 1;
      a.step();
      for (const event of a.last.events) {
        if (event.type !== 'Damage') continue;
        if (event.data.entity !== a.heroes[0]!) continue;
        total += 1;
        // Урон полосы — ровно сотня и ровно от пятна, а не от самого босса.
        expect(event.data.amount).toBe(FIRE_DAMAGE);
        const source = event.data.source!;
        expect(coreWorld.hasTag(a.state.world, source, 'BossFire')).toBe(true);
        burns.set(source, [...(burns.get(source) ?? []), t]);
      }
    }
    expect(total).toBeGreaterThanOrEqual(2);
    // Каждое пятно жжёт своим счётом — ровно раз в секунду.
    let periodic = 0;
    for (const ticks of burns.values()) {
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]! - ticks[i - 1]!).toBe(FIRE_PERIOD);
        periodic += 1;
      }
    }
    expect(periodic).toBeGreaterThan(0);

    // И полоса гаснет ровно через четыре секунды после последнего пятна.
    for (let t = 1; t <= FIRE_LIFE; t++) a.step();
    expect(tagged(a, 'BossFire')).toHaveLength(0);
  });
});

describe('босс, арена и собственная шкура', () => {
  it('всходит на плато: допуск подъёма против нулевого', () => {
    // Единственная разница между прогонами — `Collider.cliffRise` босса: с
    // допуском в один уровень он вступает на плато ровно там же, где герой
    // запрыгивает (PHYS-11), без допуска — упирается в обрыв.
    const scene = bossAt(14, 8, health('Hero', 400000));
    const climbs = stand([[14, 12.5]], scene);
    for (let t = 1; t <= 400; t++) climbs.step();
    expect(py(climbs.state, climbs.boss)).toBeGreaterThan(11 * FIXED_ONE);

    const stalls = stand([[14, 12.5]], bossCollider({ cliffRise: 0 }, scene));
    for (let t = 1; t <= 400; t++) stalls.step();
    expect(py(stalls.state, stalls.boss)).toBeLessThan(11 * FIXED_ONE);
  });

  it('снаряд гаснет в боссе и снимает с него урон', () => {
    const a = stand([[20, 24]]);
    expect(hp(a.state, a.boss)).toBe(BOSS_HP);
    let events: readonly string[] = [];
    for (let t = 0; t < 40 && !events.includes('FireballExploded'); t++) {
      events = a.step([{ buttons: t === 0 ? CAST : 0 }]);
    }
    expect(events).toContain('FireballExploded');
    expect(events).toContain('HeroHit');
    expect(hp(a.state, a.boss)).toBe(BOSS_HP - HIT_DAMAGE);
    expect(tagged(a, 'Fireball')).toHaveLength(0);
  });

  it('дошедший до нуля hp убивает босса, и через 10 с он встаёт в центре', () => {
    // hp ретюнится под один выстрел: проверяется путь смерти, а не число.
    const a = stand([[20, 24]], health('Boss', HIT_DAMAGE));
    let events: readonly string[] = [];
    for (let t = 0; t < 40 && !events.includes('EntityDied'); t++) {
      events = a.step([{ buttons: t === 0 ? CAST : 0 }]);
    }
    expect(events).toContain('EntityDied');
    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'layer')).toBe(0);

    // Возрождение — СВОЯ политика (`BossRespawn`), а не героическая: `Respawn`
    // требует `Spawn` и `LocomotionState`, которых у босса нет.
    for (let t = 1; t < BOSS_RESPAWN_TICKS; t++) {
      expect(a.step()).not.toContain('BossRespawned');
      expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    }
    expect(a.step()).toContain('BossRespawned');

    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(false);
    expect(hp(a.state, a.boss)).toBe(HIT_DAMAGE);
    expect(px(a.state, a.boss)).toBe(ARENA_CENTER);
    expect(py(a.state, a.boss)).toBe(ARENA_CENTER);
    // Тело снова препятствие, допуск подъёма и охота — с чистого листа.
    const collider = (field: string): number =>
      coreWorld.getField(a.state.world, a.boss, 'Collider', field);
    expect(collider('layer')).toBe(BOSS_LAYER);
    expect(collider('blockMask')).toBe(BOSS_BLOCK_MASK);
    expect(collider('cliffRise')).toBe(BOSS_CLIFF_RISE);
    expect(coreWorld.getField(a.state.world, a.boss, 'BossDash', 'ticksLeft')).toBe(0);
    // И документ поведения начинается заново (NPC-2): `state = -1` читается
    // платформой как «состояние ещё не выбрано».
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'state')).toBe(-1);
    a.step();
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'state')).toBe(0);
  });

  it('собственные способности босса его самого не задевают', () => {
    // Босс несёт `Player` и `Health`, то есть попал бы под запрос по игрокам;
    // исключает его `withTag: "Hero"` — тег есть только у героев.
    const a = stand([[26, 24], [30, 24]]);
    const seen = new Set<string>();
    for (let t = 1; t <= 600; t++) {
      for (const type of a.step()) seen.add(type);
      expect(hp(a.state, a.boss)).toBe(BOSS_HP);
    }
    // Контроль: за прогон отработали все три активные способности.
    expect(seen).toContain('BossStrikeLanded');
    expect(seen).toContain('BossSlamLanded');
    expect(seen).toContain('BossChargeStarted');
  });

  it('каждый площадной запрос босса отобран тегом героя', () => {
    // Механическая половина того же утверждения: выборка урона, забывшая тег,
    // накрыла бы кастера — и заметно это стало бы только в бою.
    const queries: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const each = record.forEach as { query?: Record<string, unknown> } | undefined;
      if (each?.query?.withinRadius !== undefined) queries.push(each.query);
      for (const value of Object.values(record)) walk(value);
    };
    for (const id of ['bossStrike', 'bossSlam', 'bossFireAura']) walk(abilityDef(id));
    for (const name of ['BossRotation', 'BossDashDrive']) walk(systemDef(name));
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const query of queries) {
      expect(query.withTag).toBe('Hero');
      expect(query.not).toEqual(['Dead']);
    }
  });
});

describe('числа и картинка босса: ретюн виден в диффе', () => {
  it('урон, радиусы и сроки — те, по которым считает сцена', () => {
    expect(numbers(abilityDef('bossStrike'))).toEqual(
      expect.arrayContaining([STRIKE_DAMAGE, STRIKE_CD, STRIKE_WINDUP, MEDIUM, WAVE_RADIUS]),
    );
    expect(numbers(abilityDef('bossSlam'))).toEqual(
      expect.arrayContaining([SLAM_DAMAGE, SLAM_ROAR, SLAM_RADIUS, MEDIUM]),
    );
    expect(numbers(abilityDef('bossCharge'))).toEqual(expect.arrayContaining([CHARGE_AIM]));
    expect(numbers(abilityDef('bossRepel'))).toEqual(
      expect.arrayContaining([REPEL_DAMAGE, REPEL_CD, MEDIUM]),
    );
    expect(numbers(abilityDef('bossFireAura'))).toEqual(
      expect.arrayContaining([FIRE_DAMAGE, FIRE_PERIOD, FIRE_RADIUS]),
    );
    expect(numbers(systemDef('BossDashDrive'))).toContain(DASH_DAMAGE);
    expect(numbers(systemDef('BossTarget'))).toContain(HUNT_TICKS);

    const boss = SCENE.prefabs!.find((prefab) => prefab.name === 'Boss')!;
    expect(boss.components.Health).toEqual({ hp: BOSS_HP, hpMax: BOSS_HP });
    expect(boss.components.BossDash).toBeDefined();
    expect((boss.components.Collider as Record<string, number>).radius).toBe(BOSS_RADIUS);
    expect((boss.components.Collider as Record<string, number>).cliffRise).toBe(BOSS_CLIFF_RISE);
    // Слот — чужой обоим игрокам матча: снаряд каждого видит в боссе цель.
    expect(boss.components.Player!.slot).toBe(MATCH.players.length);
    // Взрыв слэма — ровно три радиуса тела, а полоса огня вдвое уже тела.
    expect(SLAM_RADIUS).toBe(3 * BOSS_RADIUS);
    expect(FIRE_RADIUS * 2).toBeCloseTo(BOSS_RADIUS, -1);
    // Возрождение: окно и точка — зеркало `arena.center` сцены.
    const respawn = numbers(systemDef('BossRespawn'));
    expect(respawn).toContain(BOSS_RESPAWN_TICKS);
    expect(respawn).toContain(ARENA_CENTER);
    const center = (SCENE as unknown as { arena: { center: { x: number; y: number } } }).arena.center;
    expect(center).toEqual({ x: ARENA_CENTER, y: ARENA_CENTER });
  });

  it('босс бежит не медленнее героя — иначе преследование не преследование', () => {
    const behavior = (SCENE as unknown as {
      npc: { behaviors: readonly { name: string; speed: number; states: readonly unknown[] }[] };
    }).npc.behaviors.find((entry) => entry.name === 'arenaBoss')!;
    const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
    expect(behavior.speed).toBeGreaterThanOrEqual(
      (hero.components.Locomotion as Record<string, number>).maxSpeed!,
    );
    // Ротация живёт в системах сцены, а не в документе: у него одно состояние.
    expect(behavior.states).toHaveLength(1);
  });

  it('радиус вспышки слэма — радиус, по которому он бьёт', () => {
    // Та же связь, что у оболочки купола: картинка обязана совпадать с зоной
    // урона, иначе игрок учится не тому. Число некруглое намеренно — 1.8
    // мировой единицы в Q16.16 точно не представимо, а врать картинке нельзя.
    expect(MANIFEST.effects.byEvent.BossSlamLanded!.radiusTo).toBe(SLAM_RADIUS / FIXED_ONE);
    // Волна и полоса огня рисуются записями по ВИДУ: моделей у них нет, как у
    // купола. Оболочка вправе быть ЧУТЬ шире зоны урона — пятна огня ложатся с
    // шагом в 0.8 единицы, и полоса обязана читаться сплошной, — но не уже её:
    // невидимый урон под ногами учит игрока ровно неверному.
    expect(MANIFEST.effects.byKind.BossWave!.radius).toBeGreaterThanOrEqual(
      WAVE_RADIUS / FIXED_ONE,
    );
    expect(MANIFEST.effects.byKind.BossFire!.radius).toBeGreaterThanOrEqual(
      FIRE_RADIUS / FIXED_ONE,
    );
    // Замахи озвучены частицами, приземления — тряской камеры.
    for (const type of ['BossStrikeWindup', 'BossSlamRoar', 'BossChargeAim']) {
      expect(MANIFEST.particles.byEvent[type]!.effect).toBe(
        MANIFEST.particles.byEvent.CastFireball!.effect,
      );
    }
    for (const type of ['BossStrikeLanded', 'BossSlamLanded', 'BossChargeStarted', 'BossRepelLanded']) {
      expect(MANIFEST.cameraEffects.events[type]!.effect).toBe('shake');
    }
  });

  it('клипы, названные манифестом, у модели есть', () => {
    // Запись, не совпавшая ни с одним клипом, гасит анимацию молча (REND-4):
    // рендер предупреждает один раз в консоль и рисует позу покоя. Разрешение
    // здесь — то же самое, что у рендера, а не второе правило рядом.
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../content');
    const bytes = readFileSync(join(root, 'visuals/models/SkeletonBarbarian.mdx'));
    // Загрузчик MDX синхронен, но подпись реестра допускает и промис (ASSET-3):
    // сужение здесь — про подпись, а не про поведение.
    const model = mdxLoader.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { id: 'visuals/models/SkeletonBarbarian.mdx', read: () => Promise.reject(new Error('нет')) },
    ) as NormalizedModel;
    const clips = model.sequences.map((sequence) => ({ name: sequence.name }));
    const broken: string[] = [];
    for (const [kind, visual] of Object.entries(MANIFEST.entities)) {
      for (const [event, entry] of Object.entries(visual.animations.events)) {
        if (resolveClip(clips, entry).status !== 'resolved') broken.push(`${kind}.${event} → ${entry}`);
      }
    }
    expect(broken).toEqual([]);
    // Контроль: клипы вообще разобрались, иначе проверялось бы пустое множество.
    expect(clips.length).toBeGreaterThan(5);
  });

  it('доворот корпуса едет событиями, которые несут направление', () => {
    // Список `aimEvents` сборки против документа сцены: событие без `dirX`/
    // `dirY` доворачивать нечем, и запись молча не работала бы (REND-5).
    const carriers = new Map<string, Set<string>>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const emit = record.emitEvent as { type?: unknown; data?: unknown } | undefined;
      if (typeof emit?.type === 'string' && emit.data !== null && typeof emit.data === 'object') {
        const fields = carriers.get(emit.type) ?? new Set<string>();
        for (const field of Object.keys(emit.data)) fields.add(field);
        carriers.set(emit.type, fields);
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(sceneJson);
    for (const type of DEMO_AIM_EVENTS) {
      const fields = carriers.get(type);
      expect(fields, `событие ${type} сцена не публикует`).toBeDefined();
      expect([...fields!].sort(), type).toEqual(expect.arrayContaining(['dirX', 'dirY']));
    }
  });
});
