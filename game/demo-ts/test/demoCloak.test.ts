/**
 * Невидимость демо-арены как КОНТЕНТ (`content/scenes/duel.scene.json`:
 * способности `cloak`/`bossCloak`, баффы `cloakFade`/`cloakSoft`/`cloakHard`/
 * `bossCloakFade`/`bossCloak`, система `CloakBreak`, правки `bossCharge` и
 * `BossTarget`, решение `BossCloak` документа `arenaBoss`).
 *
 * Проверяется не платформа — каналы (FOW-3, FOW-12), баффы (BUFF-2..6) и
 * восприятие NPC (NPC-10) закрыты тестами ядра, — а ПОЛИТИКА, написанная в
 * JSON: сколько длится каждая фаза, что снимает невидимость, а что нет, кому
 * достаётся бафф босса и что делает босс, потеряв всех.
 *
 * Сроки фаз пиннятся ОКНАМИ, а не тиком: цепочка идёт через `onExpire` баффов
 * (BUFF-6), и каждое звено стоит платформе тик-другой на инициализацию
 * следующего инстанса — это свойство механизма, а не сцены, и точное число
 * тиков латентности тест не обещает. Что он обещает: порядок фаз, их длину с
 * точностью до этой латентности и сумму «семь секунд от каста».
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
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
import { ABILITY_SLOTS, ACTION_BITS } from '../app/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

const SCENE = sceneJson as unknown as SceneDef;
/** Дуэль без расстановки сцены: босс в центре был бы посторонней переменной. */
const DUEL = { ...SCENE, initial: [] } as unknown as SceneDef;

const MATCH = matchJson as unknown as {
  readonly seed: number;
  readonly players: readonly string[];
  readonly locomotion: Record<string, unknown>;
  readonly visibility?: Record<string, never>;
  readonly navigation?: { readonly budget: number; readonly maxAgentRadius: number };
};

const CLOAK = 1 << ACTION_BITS.cloak;
const JUMP = 1 << ACTION_BITS.jump;
const DODGE = 1 << ACTION_BITS.dodge;
const SHIELD = 1 << ACTION_BITS.shield;
const DOME = 1 << ACTION_BITS.slowDome;
const CAST = 1 << ACTION_BITS.cast;
const REWIND = 1 << ACTION_BITS.rewind;
const KILL = 1 << ACTION_BITS.kill;

// ---------------------------------------------------------- числа сцены
//
// Зеркала документа: тест сверяет каждое с определением ниже («числа сцены»),
// поэтому ретюн краснеет здесь, а не проявляется поведением.

/** Затухание героя и босса — секунда при 60 Гц; герой ещё виден и таргетируем. */
const FADE_TICKS = 60;
/** Силуэт героя — секунда мягкого канала 0. */
const SOFT_TICKS = 60;
/** Полная невидимость героя — пять секунд жёсткого канала 1. */
const HARD_TICKS = 300;
/** Итого семь секунд от каста. */
const CLOAK_TOTAL = FADE_TICKS + SOFT_TICKS + HARD_TICKS;
/** Силуэт босса и миньонов — четыре секунды мягкого канала; жёсткой фазы нет. */
const BOSS_CLOAK_TICKS = 240;
const CLOAK_CD = 1200;
const BOSS_CLOAK_CD = 1200;
/** Маски каналов: канал 0 мягкий (`softStealthChannels`), канал 1 жёсткий. */
const SOFT_MASK = 1;
const HARD_MASK = 2;
/**
 * Латентность платформы баффов: страж маркера видит снятый маркер на своём
 * проходе, ставит признак снятия, и лишь следующий проход разбирает его
 * (BUFF-6) — маска гаснет через тик-другой после разрыва. Звенья цепочки
 * сменяются без просвета (следующее заводится на предпоследнем тике жизни
 * предыдущего), поэтому окна ниже — про инициализацию инстанса, не про паузу.
 */
const CHAIN_LAG = 3;
/** Стартовый кулдаун ульты отката — раньше него её не скастовать. */
const REWIND_INITIAL_CD = 450;
/** Индекс определения невидимости босса — по нему ищется его слот. */
const ABILITY_BOSS_CLOAK = SCENE.abilities!.findIndex((a) => a.id === 'bossCloak');

// ------------------------------------------------------------------ стенд

interface Frame {
  readonly buttons?: number;
  readonly moveX?: number;
  readonly moveY?: number;
}

interface Stand {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly heroes: readonly EntityId[];
  /** Босс расстановки сцены; -1 у дуэли без расстановки. */
  readonly boss: EntityId;
  /** Один тик; возвращает типы событий тика. */
  step(frames?: readonly Frame[]): readonly string[];
  at(): number;
  readonly last: { events: readonly GameEvent[] };
}

/**
 * Мир матча: герои по клеткам в РАЗНЫХ командах (иначе стелс друг от друга не
 * прячет — своя команда видит себя безусловно, FOW-3), босс — из расстановки
 * сцены, если она есть. Точка прицела — соперник (либо босс): шаг `vector`
 * фаербола читает точку, а не угол (ABIL-5).
 */
function stand(cells: readonly (readonly [number, number])[], scene: SceneDef = SCENE): Stand {
  const players = cells.map((_unused, index) => `p${index + 1}`);
  const built = buildMatchWorld({
    scene,
    seed: MATCH.seed,
    players,
    // Расстановку сцены (босса) сборка матча ставит сама; сюда — только герои.
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
    ...(MATCH.navigation !== undefined ? { navigation: MATCH.navigation } : {}),
  });
  const heroes: EntityId[] = [];
  let boss = -1 as EntityId;
  for (const entity of coreWorld.listAlive(built.state.world)) {
    if (coreWorld.hasTag(built.state.world, entity, 'Boss')) boss = entity;
    if (!coreWorld.hasTag(built.state.world, entity, 'Hero')) continue;
    heroes[coreWorld.getField(built.state.world, entity, 'Player', 'slot')] = entity;
  }
  let tick = 0;
  const last: { events: readonly GameEvent[] } = { events: [] };
  const aimAt = (index: number): { x: number; y: number } => {
    const other = boss !== -1 ? boss : heroes[1 - index]!;
    return {
      x: coreWorld.getField(built.state.world, other, 'Position', 'x'),
      y: coreWorld.getField(built.state.world, other, 'Position', 'y'),
    };
  };
  return {
    sim: built.sim,
    state: built.state,
    heroes,
    boss,
    last,
    at: () => tick,
    step(frames = []) {
      tick += 1;
      const inputs: InputFrame[] = players.map((playerId, index) => ({
        tick,
        playerId,
        seq: tick,
        move: { x: frames[index]?.moveX ?? 0, y: frames[index]?.moveY ?? 0 },
        aimDir: index === 0 ? 0 : 0x8000,
        buttons: frames[index]?.buttons ?? 0,
        target: aimAt(index),
      }));
      const result = simTick(built.sim, built.state, inputs);
      last.events = [...result.events];
      return last.events.map((event) => event.type);
    },
  };
}

/** Дуэль двух героев без босса: `p1` слева, `p2` справа. */
const duel = (gap = 8): Stand => stand([[24 - gap / 2, 24.5], [24 + gap / 2, 24.5]], DUEL);

const has = (a: Stand, entity: EntityId, component: string): boolean =>
  coreWorld.hasComponent(a.state.world, entity, component);

/** Эффективная стелс-маска (`StealthState`, FOW-3); без компонента — ноль. */
function mask(a: Stand, entity: EntityId): number {
  if (!has(a, entity, 'StealthState')) return 0;
  return coreWorld.getField(a.state.world, entity, 'StealthState', 'mask');
}

/** Виден ли герой команде `team` по маске `Visibility` (FOW-2). */
function visibleTo(a: Stand, entity: EntityId, team: number): boolean {
  return (coreWorld.getField(a.state.world, entity, 'Visibility', 'visibleTo') & (1 << team)) !== 0;
}

function slotOf(a: Stand, owner: EntityId, slotIndex: number): EntityId {
  for (const entity of coreWorld.listAlive(a.state.world)) {
    if (!coreWorld.hasComponent(a.state.world, entity, 'AbilitySlot')) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'owner') !== owner) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'slotIndex') === slotIndex) return entity;
  }
  throw new Error(`слот ${slotIndex} сущности ${owner} не выдан`);
}

function bossSlotOf(a: Stand, abilityId: number): EntityId {
  for (const entity of coreWorld.listAlive(a.state.world)) {
    if (!coreWorld.hasComponent(a.state.world, entity, 'AbilitySlot')) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'owner') !== a.boss) continue;
    if (coreWorld.getField(a.state.world, entity, 'AbilitySlot', 'abilityId') === abilityId) return entity;
  }
  throw new Error(`у босса нет слота способности ${abilityId}`);
}

const cooldown = (a: Stand, slot: EntityId): number =>
  coreWorld.getField(a.state.world, slot, 'AbilityCooldown', 'remaining');

const tagged = (a: Stand, tag: string): readonly EntityId[] =>
  [...coreWorld.listAlive(a.state.world)].filter((entity) => coreWorld.hasTag(a.state.world, entity, tag));

const px = (a: Stand, entity: EntityId): number => coreWorld.getField(a.state.world, entity, 'Position', 'x');
const py = (a: Stand, entity: EntityId): number => coreWorld.getField(a.state.world, entity, 'Position', 'y');

/** Прогон до первого события `type`; возвращает абсолютный тик стенда. */
function until(a: Stand, type: string, limit = 400, frames?: readonly Frame[]): number {
  for (let t = 1; t <= limit; t++) {
    if (a.step(frames).includes(type)) return a.at();
  }
  throw new Error(`событие ${type} не случилось за ${limit} тиков`);
}

/** Прогон до тика `to` включительно нейтральными вводами. */
function runTo(a: Stand, to: number, frames?: readonly Frame[]): void {
  while (a.at() < to) a.step(frames);
}

/** Первый тик в окне, на котором предикат истинен; -1 — ни разу. */
function firstTick(a: Stand, to: number, predicate: () => boolean, frames?: readonly Frame[]): number {
  while (a.at() < to) {
    a.step(frames);
    if (predicate()) return a.at();
  }
  return -1;
}

/** Кастует инвиз героем `index` на следующем тике и возвращает его номер. */
function castCloak(a: Stand, index = 0): number {
  const frames: Frame[] = [];
  frames[index] = { buttons: CLOAK };
  const events = a.step(frames);
  expect(events).toContain('HeroCloak');
  return a.at();
}

const BOSS_SLOTS = [
  'SlotBossStrike',
  'SlotBossSlam',
  'SlotBossCharge',
  'SlotBossField',
  'SlotBossSpawn',
  'SlotBossTether',
  'SlotBossCloak',
] as const;

/**
 * Сцена, у которой у босса готовы ТОЛЬКО названные слоты: остальные припаркованы
 * запредельным кулдауном (тот же приём, что в `demoBoss.test.ts`); `delay` —
 * стартовый кулдаун названного слота, чтобы развести касты по времени.
 */
function only(keep: Readonly<Record<string, number>>, scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) => {
      if (!(BOSS_SLOTS as readonly string[]).includes(entry.name)) return entry;
      const remaining = keep[entry.name] ?? 100000;
      return {
        ...entry,
        components: {
          ...entry.components,
          AbilityCooldown: { ...(entry.components.AbilityCooldown as Record<string, number>), remaining },
        },
      };
    }),
  };
}

/**
 * Сцена, где босс СТОИТ (`speed: 0` документа поведения): дистанции стенда
 * постоянны, и оси дистанции решений босса (разгон — только издали, удар —
 * только в упор) читаются по расстановке, а не по тому, куда он успел дойти.
 */
function still(scene: SceneDef = SCENE): SceneDef {
  const npc = (scene as unknown as { npc: { behaviors: readonly Record<string, unknown>[] } }).npc;
  return {
    ...scene,
    npc: {
      ...npc,
      behaviors: npc.behaviors.map((entry) => (entry.name === 'arenaBoss' ? { ...entry, speed: 0 } : entry)),
    },
  } as unknown as SceneDef;
}

/** Сцена с запертым толчком в упор и живучим героем: предмет — невидимость, а не бой. */
function calm(scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) => {
      if (entry.name === 'Boss') {
        return {
          ...entry,
          components: {
            ...entry.components,
            BossHunt: { ...(entry.components.BossHunt as Record<string, number>), repelUntil: 100000 },
          },
        };
      }
      if (entry.name === 'Hero') {
        return { ...entry, components: { ...entry.components, Health: { hp: 400000, hpMax: 400000 } } };
      }
      return entry;
    }),
  };
}

// ------------------------------------------------------------- числа сцены

describe('числа невидимости — зеркала документа сцены', () => {
  const buff = (id: string): { durationTicks: number; statMods?: readonly { value: number }[] } =>
    (SCENE.buffs as unknown as { id: string; durationTicks: number; statMods?: { value: number }[] }[]).find(
      (entry) => entry.id === id,
    )!;
  const ability = (id: string): { cooldownTicks: number } =>
    (SCENE.abilities as unknown as { id: string; cooldownTicks: number }[]).find((entry) => entry.id === id)!;

  it('фазы героя: затухание, силуэт мягким каналом, полная жёстким; семь секунд', () => {
    expect(buff('cloakFade').durationTicks).toBe(FADE_TICKS);
    expect(buff('cloakSoft').durationTicks).toBe(SOFT_TICKS);
    expect(buff('cloakSoft').statMods![0]!.value).toBe(SOFT_MASK);
    expect(buff('cloakHard').durationTicks).toBe(HARD_TICKS);
    expect(buff('cloakHard').statMods![0]!.value).toBe(HARD_MASK);
    expect(CLOAK_TOTAL).toBe(7 * 60);
    expect(ability('cloak').cooldownTicks).toBe(CLOAK_CD);
  });

  it('фазы босса: затухание и силуэт мягким каналом; пять секунд, жёсткой фазы нет', () => {
    expect(buff('bossCloakFade').durationTicks).toBe(FADE_TICKS);
    expect(buff('bossCloak').durationTicks).toBe(BOSS_CLOAK_TICKS);
    expect(buff('bossCloak').statMods![0]!.value).toBe(SOFT_MASK);
    expect(FADE_TICKS + BOSS_CLOAK_TICKS).toBe(5 * 60);
    expect(ability('bossCloak').cooldownTicks).toBe(BOSS_CLOAK_CD);
  });

  it('канал 0 объявлен мягким, канал 1 остаётся жёстким (FOW-12)', () => {
    expect((SCENE as unknown as { softStealthChannels: number[] }).softStealthChannels).toEqual([0]);
  });
});

// -------------------------------------------------------------- инвиз героя

describe('инвиз героя: затухание → силуэт → полная невидимость', () => {
  it('цепочка фаз идёт по времени: маска 0, затем 1, затем 2, затем 0 — семь секунд от каста', () => {
    const a = duel();
    const [p1] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    // Затухание: компонент с тиком начала и длительностью — вход подачи (FOW-13).
    expect(has(a, p1, 'Cloaking')).toBe(true);
    expect(coreWorld.getField(a.state.world, p1, 'Cloaking', 'startTick')).toBe(cast);
    expect(coreWorld.getField(a.state.world, p1, 'Cloaking', 'ticks')).toBe(FADE_TICKS);
    // Кулдаун взведён кастом: способность мгновенная (ABIL-7).
    expect(cooldown(a, slotOf(a, p1, ABILITY_SLOTS.cloak))).toBe(CLOAK_CD - 1);

    // Всё затухание — без канала.
    runTo(a, cast + FADE_TICKS - 1);
    expect(mask(a, p1)).toBe(0);
    expect(has(a, p1, 'Cloaking')).toBe(true);
    expect(has(a, p1, 'Cloaked')).toBe(false);

    const soft = firstTick(a, cast + FADE_TICKS + CHAIN_LAG, () => mask(a, p1) === SOFT_MASK);
    expect(soft).toBeGreaterThanOrEqual(cast + FADE_TICKS);
    expect(has(a, p1, 'Cloaking')).toBe(false);
    expect(has(a, p1, 'Cloaked')).toBe(true);

    const hard = firstTick(a, soft + SOFT_TICKS + CHAIN_LAG, () => mask(a, p1) !== SOFT_MASK);
    expect(mask(a, p1)).toBe(HARD_MASK);
    expect(hard - soft).toBeGreaterThanOrEqual(SOFT_TICKS);

    const over = firstTick(a, hard + HARD_TICKS + CHAIN_LAG, () => mask(a, p1) !== HARD_MASK);
    expect(mask(a, p1)).toBe(0);
    expect(over - hard).toBeGreaterThanOrEqual(HARD_TICKS);
    expect(has(a, p1, 'Cloaked')).toBe(false);
    // Семь секунд от каста — с точностью до латентности цепочки.
    expect(over - cast).toBeGreaterThanOrEqual(CLOAK_TOTAL);
    expect(over - cast).toBeLessThanOrEqual(CLOAK_TOTAL + 3 * CHAIN_LAG);
  });

  it('врагу герой виден на затухании и силуэтом, но не в полной невидимости (FOW-12, NET-15)', () => {
    const a = duel();
    const [p1] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS / 2);
    expect(visibleTo(a, p1, 1)).toBe(true);
    // Силуэт — мягкий канал: бит чужой команды не гаснет (FOW-13).
    runTo(a, cast + FADE_TICKS + SOFT_TICKS / 2);
    expect(mask(a, p1)).toBe(SOFT_MASK);
    expect(visibleTo(a, p1, 1)).toBe(true);
    // Полная — жёсткий: бит гаснет, и фильтр снапшота вырежет героя (NET-12).
    runTo(a, cast + FADE_TICKS + SOFT_TICKS + HARD_TICKS / 2);
    expect(mask(a, p1)).toBe(HARD_MASK);
    expect(visibleTo(a, p1, 1)).toBe(false);
    // Себе герой виден всегда (FOW-3).
    expect(visibleTo(a, p1, 0)).toBe(true);
  });

  it('повторный каст под невидимостью не проходит: условие определения', () => {
    const a = duel();
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS + 10);
    const frames: Frame[] = [{ buttons: CLOAK }];
    expect(a.step(frames)).not.toContain('HeroCloak');
  });
});

describe('что снимает инвиз героя, а что нет', () => {
  /**
   * Каждый разрыв — на силуэте (мягкий канал): бафф снимает себя реакцией на
   * `CloakBreak` (BUFF-5/BUFF-6), и маска гаснет в пределах латентности.
   */
  function breaksOn(name: string, frame: Frame, from = 0) {
    it(`${name} — снимает`, () => {
      const a = duel();
      const [p1] = a.heroes as [EntityId, EntityId];
      runTo(a, from);
      const cast = castCloak(a);
      runTo(a, cast + FADE_TICKS + 20 - 1);
      expect(mask(a, p1)).toBe(SOFT_MASK);
      const events = a.step([frame]);
      expect(events).toContain('CloakBreak');
      expect(has(a, p1, 'Cloaked')).toBe(false);
      const gone = firstTick(a, a.at() + CHAIN_LAG, () => mask(a, p1) === 0);
      expect(gone).not.toBe(-1);
      // Разорванная цепочка не продолжается: жёсткой фазы не наступает.
      runTo(a, cast + CLOAK_TOTAL + CHAIN_LAG);
      expect(mask(a, p1)).toBe(0);
      expect(has(a, p1, 'Cloaked')).toBe(false);
    });
  }

  breaksOn('прыжок', { buttons: JUMP, moveX: FIXED_ONE });
  breaksOn('рывок', { buttons: DODGE, moveX: FIXED_ONE });
  breaksOn('щит', { buttons: SHIELD });
  breaksOn('купол замедления', { buttons: DOME });
  breaksOn('заряд фаербола — уже на старте фазы', { buttons: CAST });
  // Ульта стартует с кулдауном: инвиз кастуется, когда она уже готова.
  breaksOn('ульта отката', { buttons: REWIND }, REWIND_INITIAL_CD);

  it('смерть снимает: труп не невидимка', () => {
    const a = duel();
    const [p1] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS + 20);
    expect(mask(a, p1)).toBe(SOFT_MASK);
    const events = a.step([{ buttons: KILL }]);
    expect(events).toContain('CloakBreak');
    expect(firstTick(a, a.at() + CHAIN_LAG, () => mask(a, p1) === 0)).not.toBe(-1);
  });

  it('движение не снимает: невидимка ходит', () => {
    const a = duel();
    const [p1] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    const walk: Frame[] = [{ moveY: FIXED_ONE }];
    runTo(a, cast + FADE_TICKS + SOFT_TICKS + 60, walk);
    expect(mask(a, p1)).toBe(HARD_MASK);
    expect(has(a, p1, 'Cloaked')).toBe(true);
    expect(a.last.events.map((event) => event.type)).not.toContain('CloakBreak');
  });

  it('урон не снимает: попадание фаербола в полную невидимость её не рвёт', () => {
    const a = duel(6);
    const [p1, p2] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS + SOFT_TICKS + 10);
    expect(mask(a, p1)).toBe(HARD_MASK);
    // Соперник заряжает и отпускает: снаряд летит по точке прицела — то есть в
    // позицию p1, которую стенд подставляет ему как цель.
    const frames: Frame[] = [];
    frames[1] = { buttons: CAST };
    a.step(frames);
    let damaged = -1;
    for (let t = 0; t < 120 && damaged === -1; t++) {
      a.step();
      if (a.last.events.some((event) => event.type === 'Damage' && event.data.entity === p1)) damaged = a.at();
      expect(a.last.events.map((event) => event.type)).not.toContain('CloakBreak');
    }
    expect(damaged).not.toBe(-1);
    expect(coreWorld.getField(a.state.world, p1, 'Health', 'hp')).toBeLessThan(1000);
    expect(mask(a, p1)).toBe(HARD_MASK);
    expect(has(a, p1, 'Cloaked')).toBe(true);
    expect(has(a, p2, 'Cloaked')).toBe(false);
  });

  it('каст на затухании рвёт вход: силуэта не наступает, кулдаун потрачен', () => {
    const a = duel();
    const [p1] = a.heroes as [EntityId, EntityId];
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS / 2 - 1);
    const events = a.step([{ buttons: SHIELD }]);
    expect(events).toContain('CloakBreak');
    expect(has(a, p1, 'Cloaking')).toBe(false);
    runTo(a, cast + FADE_TICKS + SOFT_TICKS + CHAIN_LAG);
    expect(mask(a, p1)).toBe(0);
    expect(has(a, p1, 'Cloaked')).toBe(false);
    expect(cooldown(a, slotOf(a, p1, ABILITY_SLOTS.cloak))).toBeGreaterThan(CLOAK_CD - FADE_TICKS - SOFT_TICKS - 10);
  });
});

// --------------------------------------------------------- невидимость босса

describe('невидимость босса: затухание и силуэт, бафф на живых миньонах', () => {
  it('босс просит невидимость сам и уходит в силуэт на пять секунд от каста', () => {
    const a = stand([[30, 24]], calm(only({ SlotBossCloak: 0 })));
    const cast = until(a, 'BossCloakStart', 120);
    expect(a.last.events.map((event) => event.type)).toContain('BossCloak');
    expect(has(a, a.boss, 'Cloaking')).toBe(true);
    expect(coreWorld.getField(a.state.world, a.boss, 'Cloaking', 'startTick')).toBe(cast);
    expect(cooldown(a, bossSlotOf(a, ABILITY_BOSS_CLOAK))).toBeGreaterThan(BOSS_CLOAK_CD - 5);

    runTo(a, cast + FADE_TICKS - 1);
    expect(mask(a, a.boss)).toBe(0);
    const soft = firstTick(a, cast + FADE_TICKS + CHAIN_LAG, () => mask(a, a.boss) === SOFT_MASK);
    expect(soft).toBeGreaterThanOrEqual(cast + FADE_TICKS);
    expect(has(a, a.boss, 'Cloaked')).toBe(true);
    // Жёсткой фазы нет: герой видит силуэт до самого конца.
    const over = firstTick(a, soft + BOSS_CLOAK_TICKS + CHAIN_LAG, () => mask(a, a.boss) !== SOFT_MASK);
    expect(mask(a, a.boss)).toBe(0);
    expect(over - soft).toBeGreaterThanOrEqual(BOSS_CLOAK_TICKS);
    expect(over - cast).toBeGreaterThanOrEqual(FADE_TICKS + BOSS_CLOAK_TICKS);
    expect(over - cast).toBeLessThanOrEqual(FADE_TICKS + BOSS_CLOAK_TICKS + 2 * CHAIN_LAG);
    expect(has(a, a.boss, 'Cloaked')).toBe(false);
    // Пока босс в силуэте, герою он виден — канал мягкий (FOW-13).
    runTo(a, over + 1);
  });

  it('живые на момент каста миньоны уходят в невидимость вместе с боссом', () => {
    // Призыв готов сразу, невидимость — через 150 тиков: скелеты уже стоят.
    const a = stand([[30, 24]], calm(still(only({ SlotBossSpawn: 0, SlotBossCloak: 150 }))));
    until(a, 'BossSpawned', 200);
    const minions = tagged(a, 'BossMinion');
    expect(minions.length).toBeGreaterThan(0);
    const cast = until(a, 'BossCloakStart', 300);
    for (const minion of minions) expect(has(a, minion, 'Cloaking')).toBe(true);
    const soft = firstTick(a, cast + FADE_TICKS + CHAIN_LAG, () => mask(a, a.boss) === SOFT_MASK);
    expect(soft).not.toBe(-1);
    runTo(a, soft + CHAIN_LAG);
    for (const minion of minions) {
      if (!coreWorld.isAlive(a.state.world, minion)) continue;
      expect(mask(a, minion)).toBe(SOFT_MASK);
      expect(has(a, minion, 'Cloaked')).toBe(true);
    }
  });

  it('миньон, призванный после каста, невидимости не получает', () => {
    // Невидимость сразу, призыв — через 100 тиков: скелеты рождаются под ней.
    const a = stand([[30, 24]], calm(only({ SlotBossCloak: 0, SlotBossSpawn: 100 })));
    const cast = until(a, 'BossCloakStart', 120);
    until(a, 'BossSpawned', 400);
    expect(mask(a, a.boss)).toBe(SOFT_MASK);
    expect(a.at()).toBeLessThan(cast + FADE_TICKS + BOSS_CLOAK_TICKS);
    runTo(a, a.at() + CHAIN_LAG);
    for (const minion of tagged(a, 'BossMinion')) {
      expect(has(a, minion, 'Cloaking')).toBe(false);
      expect(has(a, minion, 'Cloaked')).toBe(false);
      expect(mask(a, minion)).toBe(0);
    }
  });
});

describe('что снимает невидимость босса', () => {
  it('разгон снимает её с босса и миньонов в момент прицеливания', () => {
    const a = stand([[34, 24]], calm(still(only({ SlotBossSpawn: 0, SlotBossCloak: 120, SlotBossCharge: 260 }))));
    until(a, 'BossSpawned', 200);
    const cast = until(a, 'BossCloakStart', 300);
    const cloaked = [a.boss, ...tagged(a, 'BossMinion')];
    runTo(a, cast + FADE_TICKS + CHAIN_LAG);
    expect(mask(a, a.boss)).toBe(SOFT_MASK);
    const aim = until(a, 'BossChargeAim', 400);
    const broken = a.last.events.filter((event) => event.type === 'CloakBreak').map((event) => event.data.entity);
    expect(broken).toContain(a.boss);
    for (const entity of cloaked) {
      if (!coreWorld.isAlive(a.state.world, entity)) continue;
      expect(broken).toContain(entity);
      expect(has(a, entity, 'Cloaked')).toBe(false);
    }
    const gone = firstTick(a, aim + CHAIN_LAG, () => cloaked.every((entity) => !coreWorld.isAlive(a.state.world, entity) || mask(a, entity) === 0));
    expect(gone).not.toBe(-1);
  });

  it('удар не снимает: босс бьёт из силуэта до истечения', () => {
    const a = stand([[27, 24]], calm(still(only({ SlotBossCloak: 0, SlotBossStrike: 90 }))));
    const cast = until(a, 'BossCloakStart', 120);
    const windup = until(a, 'BossStrikeWindup', 400);
    expect(windup).toBeGreaterThan(cast + FADE_TICKS);
    expect(mask(a, a.boss)).toBe(SOFT_MASK);
    runTo(a, windup + 60);
    expect(mask(a, a.boss)).toBe(SOFT_MASK);
    expect(has(a, a.boss, 'Cloaked')).toBe(true);
  });
});

// ---------------------------------------------------- восприятие босса (NPC-10)

describe('босс без детекции теряет невидимку и останавливается', () => {
  it('на затухании охотится, на силуэте забывает жертву и стоит, по концу — снова находит', () => {
    const a = stand([[34, 24]], calm(only({})));
    const [hero] = a.heroes as [EntityId];
    const cast = castCloak(a);
    runTo(a, cast + FADE_TICKS / 2);
    // Затухание — герой ещё цель: босс идёт к нему.
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target')).toBe(hero);
    const before = px(a, a.boss);
    runTo(a, cast + FADE_TICKS - 5);
    expect(px(a, a.boss)).not.toBe(before);

    // Силуэт: цели у босса нет, жертва забыта, и он стоит.
    const lost = firstTick(a, cast + FADE_TICKS + 30, () => coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target') === -1);
    expect(lost).not.toBe(-1);
    expect(coreWorld.getField(a.state.world, a.boss, 'BossHunt', 'hunted')).toBe(-1);
    runTo(a, lost + 10);
    const stopX = px(a, a.boss);
    const stopY = py(a, a.boss);
    runTo(a, cast + FADE_TICKS + SOFT_TICKS + HARD_TICKS - 10);
    expect(px(a, a.boss)).toBe(stopX);
    expect(py(a, a.boss)).toBe(stopY);
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target')).toBe(-1);

    // Невидимость истекла — охота возобновляется жребием (событие `BossHunting`).
    const found = until(a, 'BossHunting', CHAIN_LAG + 30);
    expect(found).toBeGreaterThan(cast + CLOAK_TOTAL - 1);
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target')).toBe(hero);
  });
});
