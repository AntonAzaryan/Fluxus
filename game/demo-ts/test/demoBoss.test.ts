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
 * Ротация — политика ДОКУМЕНТА (NPC-7), и с появлением входа `abilityReady`
 * она вся уместилась в скоринг: одно состояние, в нём `seekTarget` и три
 * `cast`-действия, у каждого ось готовности своего слота (`slotIndex`, ABIL-1)
 * и ось дистанции. Готовность спрашивается тем же предикатом, каким гейт
 * триггера решает, стартовать ли каст (ABIL-7), поэтому просьбы, которую гейт
 * уронил бы, документ не публикует вовсе — системы-сенсора, пересказывавшей
 * кулдауны событиями `Boss*Ready`, в сцене больше нет.
 *
 * Сцена оставляет за собой ровно одно — ЗАНЯТОСТЬ владельца (`BossBusy`,
 * order −798): пока идёт чей-то каст, рывок или назревший толчок, ротационные
 * слоты держатся недоступными, иначе следующая просьба обрывала бы текущий
 * замах штатным `supersede` (ABIL-6). Это политика сцены, а не словаря NPC:
 * платформа про «занят другим слотом» ничего не обещает.
 *
 * Держит она их ТЕМ ЖЕ полем, которым платформа держит откат, — `remaining`
 * кулдауна слота, — и это законно ровно при одном инварианте: удержание пишет
 * ЕДИНИЦУ И ТОЛЬКО В НУЛЕВОЙ остаток, а снимает её тем же тиком система
 * кулдаунов (order 800), поэтому настоящий кулдаун, взведённый завершением
 * каста по `cooldownTicks` (ABIL-7), им нельзя ни укоротить, ни продлить.
 * Выбор поля не косметический: вход `abilityReady` спрашивает у платформы
 * ровно её гейт, и подавление, выраженное чем-то другим, снова роняло бы
 * просьбы в гейте вместо того, чтобы их не публиковать (NPC-7). Оба слагаемых
 * инварианта пиннит describe «занятость босса», а не только этот текст.
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

/** Радиус тела босса: от него считаны и ширина волны, и взрыв слэма. */
const BOSS_RADIUS = 39321;
const HERO_RADIUS = 19661;
/**
 * «Средняя дистанция» боя с боссом — 5 мировых единиц. Одно число на три
 * величины: досягаемость волны удара, отброс слэма и отброс в упор. Мерка
 * взята от арены (радиус 21) и от собственного рывка героя (3.6): дальше
 * рывка, но далеко не через арену.
 */
const MEDIUM = 327680;
/** Ширина волны — радиус тела босса; её досягаемость — скорость × время жизни. */
const WAVE_RADIUS = BOSS_RADIUS;
const WAVE_SPEED = 32768;
const WAVE_TICKS = 10;
/** Взрыв слэма — три радиуса тела. */
const SLAM_RADIUS = 3 * BOSS_RADIUS;
/**
 * Пятно огня вдвое меньше тела босса, а шаг рывка — РОВНО его диаметр: пятна
 * ложатся по одному на тик и соседние касаются, не перекрываясь. Шире шаг —
 * между пятнами щель, которую оболочка манифеста всё равно рисует сплошной
 * полосой; уже — нахлёст, и стоящий на стыке горит вдвое, потому что каждое
 * пятно жжёт своим кастером.
 */
const FIRE_RADIUS = 19661;
const DASH_SPEED = 2 * FIRE_RADIUS;

const STRIKE_WINDUP = 48; // 800 мс
const STRIKE_CD = 60; // 1 с
const STRIKE_DAMAGE = 300;
const SLAM_ROAR = 90; // 1.5 с
const SLAM_DAMAGE = 500;
const CHARGE_AIM = 120; // 2 с
const DASH_DAMAGE = 500;
const FIRE_LIFE = 240; // 4 с
/**
 * «Сто урона в секунду» — СКОРОСТЬ, а не проба раз в секунду: полоса шириной в
 * 0.6 единицы пересекается бегущим героем за семь-восемь тиков, и проба раз в
 * шестьдесят ловила бы его один раз из десяти. Десять проб в секунду по
 * десятке дают ту же сотню стоящему и честную долю пробегающему.
 */
const FIRE_PERIOD = 6;
const FIRE_DAMAGE = 10;
/** Та самая сотня в секунду, которую эта пара обязана давать. */
const FIRE_DPS = (FIRE_DAMAGE * 60) / FIRE_PERIOD;
const REPEL_DAMAGE = 200;
const REPEL_CD = 45;
/** Микровзрыв в упор — радиальный: разлетается всё, что стоит вплотную. */
const REPEL_RADIUS = 98304;

/** Окно охоты за одной целью и окно возрождения — оба по 10 с при 60 Гц. */
const HUNT_TICKS = 600;
const BOSS_RESPAWN_TICKS = 600;
/** Вероятность переключиться на обидчика — 0.5 в Q16.16. */
const RAGE_CHANCE = 32768;

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

// ------------------------------------------------- документ поведения босса

/** Ось полезности, как её пишет документ сцены (NPC-3). */
interface Axis {
  readonly input: string;
  /** Индекс слота — только у входа `abilityReady` (NPC-7, ABIL-1). */
  readonly slot?: number;
  readonly curve: { readonly type: string; readonly slope?: number; readonly intercept?: number };
  readonly weight: number;
}

interface RotationAction {
  readonly executor: string;
  /** Тип публикуемой просьбы — только у исполнителя `cast`. */
  readonly event?: string;
  readonly considerations: readonly Axis[];
}

interface BossDoc {
  readonly name: string;
  readonly speed: number;
  /** Радиус чутья — он же масштаб входа `targetDistance` (NPC-3). */
  readonly ranges: { readonly sense: number };
  readonly states: readonly {
    readonly name: string;
    readonly actions: readonly RotationAction[];
    readonly transitions?: readonly Record<string, unknown>[];
  }[];
}

const bossDoc = (): BossDoc =>
  (SCENE as unknown as { npc: { behaviors: readonly BossDoc[] } }).npc.behaviors.find(
    (entry) => entry.name === 'arenaBoss',
  )!;

/** Просьба ротации → prefab слота, который её исполняет. */
const SLOT_PREFAB: Record<string, string> = {
  BossStrike: 'SlotBossStrike',
  BossSlam: 'SlotBossSlam',
  BossCharge: 'SlotBossCharge',
};

/**
 * Просьба ротации → `slotIndex`, которым её адресует документ. Список
 * ОТДЕЛЬНЫЙ от prefab'ов намеренно: тест сверяет две стороны адресации, и
 * разъехавшийся индекс читался бы в бою нулевой готовностью, а не ошибкой.
 */
const ASK_SLOT: Record<string, number> = { BossStrike: 0, BossSlam: 1, BossCharge: 2 };

/** Ротационных слотов три; четвёртый — толчок, его документ не адресует. */
const BOSS_ROTATION_SLOTS = 3;

const slotPrefabField = (prefab: string, field: string): number =>
  (SCENE.prefabs!.find((entry) => entry.name === prefab)!.components.AbilitySlot as Record<
    string,
    number
  >)[field]!;

const bossSlotIndex = (prefab: string): number => slotPrefabField(prefab, 'slotIndex');

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

describe('босс переключается на обидчика с вероятностью 50%', () => {
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
        // Цель читается ДО тика: после него удачный бросок уже переписал её на
        // самого обидчика, и то самое попадание выпало бы из знаменателя —
        // доля вышла бы завышенной.
        const target = coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target');
        a.step([{ buttons: fire }, { buttons: fire }]);
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
    // Доля вокруг объявленных 50%: полоса широкая намеренно — предмет проверки
    // то, что переключение случайно, а не точное число выпавших орлов.
    const percent = (enraged * 100) / rollable;
    expect(percent).toBeGreaterThan(30);
    expect(percent).toBeLessThan(70);
  });

  it('вероятность живёт в системе, а не в коде', () => {
    expect(numbers(systemDef('BossRage'))).toContain(RAGE_CHANCE);
    expect(RAGE_CHANCE / FIXED_ONE).toBeCloseTo(0.5, 3);
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

  it('микровзрыв радиальный: разлетаются все, кто стоит вплотную', () => {
    // «При столкновении происходит микровзрыв» — взрыв, а не тычок в одного:
    // иначе при двух подбежавших в один тик толчок доставался бы тому, кого
    // раньше вернул запрос физики (QUERY-2), и пассивка читалась бы как
    // «иногда не срабатывает».
    const a = stand([[22.5, 24], [25.5, 24]], repelOnly());
    const forward = [{ moveX: FIXED_ONE }, { moveX: -FIXED_ONE }];
    until(a, 'BossRepelLanded', 200, forward);
    for (const hero of a.heroes) {
      expect(distance(a.state, hero, a.boss)).toBeLessThan(REPEL_RADIUS + DODGE_SPEED * KNOCKBACK_TICKS);
      expect(hp(a.state, hero)).toBe(HERO_HP - REPEL_DAMAGE);
    }
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
    // Волна — отдельная сущность-снаряд, и урон несёт ОНА (ABIL-9): на тике
    // приземления жертва ещё цела, а триста hp снимает долетевшая волна.
    expect(hp(a.state, hero)).toBe(HERO_HP);
    expect(tagged(a, 'BossWave')).toHaveLength(1);
    // Кулдаун взводится приземлением, а не попаданием волны (ABIL-7).
    expect(
      coreWorld.getField(a.state.world, slotOf(a, ABILITY_STRIKE), 'AbilityCooldown', 'remaining'),
    ).toBe(STRIKE_CD - 1);

    let hits = 0;
    for (let t = 1; t <= WAVE_TICKS; t++) {
      a.step();
      for (const event of a.last.events) {
        if (event.type === 'Damage' && event.data.entity === hero) hits += 1;
      }
    }
    // Ровно один удар за волну, сколько бы тиков тела ни перекрывались:
    // пересечение публикуется каждый тик (PHYS-12), клеймо `HitMark.wave`
    // держит однократность.
    expect(hits).toBe(1);
    expect(hp(a.state, hero)).toBe(HERO_HP - STRIKE_DAMAGE);

    // Кулдаун взведён на приземлении и убывает: второй просьбы секунду не будет.
    for (let t = WAVE_TICKS; t < STRIKE_CD; t++) expect(a.step()).not.toContain('BossStrike');
  });

  it('волна бьёт вперёд, а не кругом', () => {
    // Крест героев на равном расстоянии: кого бы жребий ни выбрал целью,
    // задет обязан быть ровно он — остальные трое стоят вбок и назад.
    const a = stand([[27, 24], [21, 24], [24, 27], [24, 21]]);
    until(a, 'BossStrikeLanded', 200);
    const landed = a.last.events.find((event) => event.type === 'BossStrikeLanded')!;
    const dirX = landed.data.dirX!;
    const dirY = landed.data.dirY!;
    for (let t = 1; t <= WAVE_TICKS; t++) a.step();

    let hit = 0;
    for (const hero of a.heroes) {
      const dx = px(a.state, hero) - (landed.data.x ?? 0);
      const dy = py(a.state, hero) - (landed.data.y ?? 0);
      const along = (dx * dirX + dy * dirY) / FIXED_ONE;
      const side = Math.abs(dx * dirY - dy * dirX) / FIXED_ONE;
      const inside = along >= 0 && along <= WAVE_SPEED * WAVE_TICKS && side <= WAVE_RADIUS + HERO_RADIUS;
      expect(hp(a.state, hero), `герой на ${along / FIXED_ONE}/${side / FIXED_ONE}`).toBe(
        inside ? HERO_HP - STRIKE_DAMAGE : HERO_HP,
      );
      if (inside) hit += 1;
    }
    // Контроль: волна кого-то накрыла, иначе проверялось бы пустое множество.
    expect(hit).toBe(1);
  });

  it('за досягаемостью волны урона нет: убежавший от неё цел', () => {
    // Босс на замахе СТОИТ (`BossCastHold` гасит ему скорость), и герой успевает
    // уйти дальше, чем волна пролетает за свою жизнь.
    const reach = WAVE_SPEED * WAVE_TICKS;
    const away = stand([[28.5, 24]]);
    until(away, 'BossStrikeLanded', 200, [{ moveX: FIXED_ONE }]);
    for (let t = 1; t <= WAVE_TICKS + 2; t++) away.step([{ moveX: FIXED_ONE }]);
    expect(hp(away.state, away.heroes[0]!)).toBe(HERO_HP);
    expect(px(away.state, away.heroes[0]!) - px(away.state, away.boss)).toBeGreaterThan(reach);
    // И волна погасла сама, а не застряла в мире.
    expect(tagged(away, 'BossWave')).toHaveLength(0);

    // Тот же стенд без бегства — попадание: разница ровно в дистанции.
    const held = stand([[28.5, 24]]);
    until(held, 'BossStrikeLanded', 200);
    for (let t = 1; t <= WAVE_TICKS; t++) held.step();
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

describe('занятость босса: сцена держит просьбы, пока идёт каст', () => {
  /**
   * `BossBusy` (order −798) — вся политика занятости, которую словарь NPC не
   * несёт и нести не обязан (NPC-7): готовность слота говорит о САМОМ слоте, а
   * «владелец занят другим» — знание сцены. Держит она просьбы тем же полем,
   * которым платформа держит кулдаун (ABIL-7), поэтому проверяются РОВНО два
   * её свойства: пока слот в фазе, новых просьб нет, и живой кулдаун
   * удержанием не тронут.
   */
  const rotationSlots = (a: Stand): readonly EntityId[] =>
    ['SlotBossStrike', 'SlotBossSlam', 'SlotBossCharge'].map((prefab) =>
      slotOf(a, slotPrefabField(prefab, 'abilityId')),
    );

  it('пока слот в фазе, второй просьбы не публикуется', () => {
    // Без удержания следующая же готовая способность просилась бы поверх
    // идущего замаха, и штатный `supersede` (ABIL-6) его обрывал бы: замеры
    // отладочного прогона до этой системы — четыре сорванных слэма из пяти.
    const a = stand([[25.5, 24]]);
    a.step();
    const slots = rotationSlots(a);
    const phase = (slot: EntityId): number =>
      coreWorld.getField(a.state.world, slot, 'AbilitySlot', 'phase');

    let busyTicks = 0;
    let asks = 0;
    let asksWhileBusy = 0;
    for (let t = 1; t <= 400; t++) {
      // Занятость читается ДО тика: её же видит система на −798, а решение
      // документа принимается на −795 этого самого тика.
      const busy = slots.some((slot) => phase(slot) >= 0);
      const asked = a.step().filter((type) => ASK_SLOT[type] !== undefined).length;
      asks += asked;
      if (busy) {
        busyTicks += 1;
        asksWhileBusy += asked;
      }
    }
    // Контроль: босс и просил, и был занят — иначе проверялось бы пустое место.
    expect(asks).toBeGreaterThanOrEqual(2);
    expect(busyTicks).toBeGreaterThan(50);
    expect(asksWhileBusy).toBe(0);
  });

  it('удержание пишет только в нулевой остаток: живой кулдаун цел', () => {
    // Единственное, что делает подмену безопасной относительно ABIL-7:
    // удержание трогает слот, у которого остатка нет, и снимается тем же тиком
    // системой кулдаунов (order 800). Сорвись гейт `remaining <= 0` — настоящий
    // кулдаун обрезался бы до единицы, то есть способность возвращалась бы в
    // ротацию раньше срока, и увидеть это можно было бы только в бою.
    const a = stand([[25.5, 24]]);
    a.step();
    const slots = rotationSlots(a);
    const state = (slot: EntityId): { readonly phase: number; readonly remaining: number } => ({
      phase: coreWorld.getField(a.state.world, slot, 'AbilitySlot', 'phase'),
      remaining: coreWorld.getField(a.state.world, slot, 'AbilityCooldown', 'remaining'),
    });

    let before = slots.map(state);
    let watched = 0;
    for (let t = 1; t <= 400; t++) {
      a.step();
      const after = slots.map(state);
      for (let i = 0; i < slots.length; i++) {
        // Слот вне фазы, у которого кулдаун идёт: взвести его на этом тике
        // некому (взводят завершение каста и прерывание, а оба требуют фазы),
        // поэтому единственное законное изменение — убывание ровно на тик.
        if (before[i]!.remaining <= 1 || before[i]!.phase >= 0) continue;
        watched += 1;
        expect(after[i]!.remaining, `слот ${i}, тик ${a.at()}`).toBe(before[i]!.remaining - 1);
      }
      before = after;
    }
    // Контроль: живой кулдаун под удержанием вообще случался.
    expect(watched).toBeGreaterThan(50);
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
    // Ровно одно попадание за рывок — метка `HitMark.dash` жертвы держит счёт.
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
    // И полоса СПЛОШНАЯ: соседние пятна отстоят ровно на два своих радиуса,
    // то есть касаются. Щель между ними горела бы не по всей полосе, а
    // оболочка манифеста рисовала бы её сплошной — игрок стоял бы в огне и не
    // получал урона.
    const along = patches
      .map((patch) => coreWorld.getField(a.state.world, patch, 'Position', 'x'))
      .sort((left, right) => left - right);
    for (let i = 1; i < along.length; i++) {
      expect(along[i]! - along[i - 1]!).toBe(2 * FIRE_RADIUS);
    }
    expect(
      coreWorld.getField(a.state.world, patches[0]!, 'AbilityDuration', 'remaining'),
    ).toBeGreaterThan(FIRE_LIFE - patches.length - 2);

    // Тики огня: по десятке десять раз в секунду, источник — пятно, а не сам
    // босс. Считается СКОРОСТЬ: стоящему в полосе она обязана дать ровно сто
    // за секунду, и меряется это на целой секунде, а не на одной пробе.
    const burns = new Map<EntityId, number[]>();
    const perSecond: number[] = [];
    let total = 0;
    const measureFrom = a.at();
    let second = 0;
    while (a.at() < ended + 4 * 60) {
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
        second += event.data.amount!;
      }
      if ((a.at() - measureFrom) % 60 === 0) {
        perSecond.push(second);
        second = 0;
      }
    }
    expect(total).toBeGreaterThanOrEqual(2);
    // Каждое пятно жжёт своим счётом — ровно десять раз в секунду.
    let periodic = 0;
    for (const ticks of burns.values()) {
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]! - ticks[i - 1]!).toBe(FIRE_PERIOD);
        periodic += 1;
      }
    }
    expect(periodic).toBeGreaterThan(0);
    // Целая секунда стояния в полосе стоит ровно объявленной сотни. Секунды
    // на краях окна неполные — берётся та, где герой простоял всю.
    expect(perSecond.some((sum) => sum === FIRE_DPS), `посекундно: ${perSecond.join(',')}`).toBe(
      true,
    );

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

  it('не идёт за падающим и не делает шага в пустоту', () => {
    // Улетевший с арены герой мёртв не сразу: `FallDeath` копит глубину триста
    // тиков, и всё это время он остаётся ЖИВОЙ целью. Отказаться от него сцена
    // не может: `NpcAgent.target` принадлежит платформе, и `chooseTarget`
    // (NPC-5) переписывает поле каждый тик, а про полёт не знает — её запасной
    // `nearestEnemy` фильтрует только по команде и смерти. Поэтому отказ
    // выражается не полем, а ДЕЙСТВИЯМИ: босс не шагает к падающему и не
    // кастует по нему.
    const a = stand([[44.5, 24]]);
    const hero = a.heroes[0]!;
    let fell = -1;
    while (a.at() < 900 && fell < 0) {
      a.step();
      if (coreWorld.hasComponent(a.state.world, hero, 'Falling')) fell = a.at();
    }
    // Контроль: герой действительно улетел с арены — иначе проверялся бы
    // сценарий, в котором падать было некому.
    expect(fell).toBeGreaterThan(0);

    // Платформа цель ДЕРЖИТ — вот то самое, чего сцена изменить не может:
    // запись `target = -1` из `BossTarget` (-796) переписывается обратно
    // системой поведения на -795 тем же тиком. Отпустит она падающего сама,
    // и не скоро — когда тело улетит за радиус чутья. Поэтому проверки ниже
    // меряют ШАГ и КАСТ, а не поле.
    expect(coreWorld.getField(a.state.world, a.boss, 'NpcAgent', 'target')).toBe(hero);

    // С тика падения босс СТОИТ: ни единицы Q16.16 в сторону улетающего тела.
    //
    // Меряются ПРОСЬБЫ, а не замахи: замах есть только у удара
    // (`BossStrikeWindup`), рёв слэма и наводка разгона зовутся иначе, и фильтр
    // по «Windup» проверял бы одну способность из трёх.
    const frozen = { x: px(a.state, a.boss), y: py(a.state, a.boss) };
    const strike = slotOf(a, ABILITY_STRIKE);
    const asked: string[] = [];
    let strikeReady = false;
    for (let t = 1; t <= 200; t++) {
      for (const type of a.step()) {
        if (type === 'BossStrike' || type === 'BossSlam') asked.push(type);
      }
      if (coreWorld.getField(a.state.world, strike, 'AbilityCooldown', 'remaining') <= 0) {
        strikeReady = true;
      }
      expect(px(a.state, a.boss), `тик ${a.at()}`).toBe(frozen.x);
      expect(py(a.state, a.boss), `тик ${a.at()}`).toBe(frozen.y);
      expect(coreWorld.hasComponent(a.state.world, a.boss, 'Falling')).toBe(false);
      expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(false);
      expect(coreWorld.hasComponent(a.state.world, hero, 'Falling'), `тик ${a.at()}`).toBe(true);
    }
    // Ближний бой по падающему не просится, и держит это ДИСТАНЦИЯ, а не знание
    // о полёте: шага босс не делает (`BossFooting` гасит скорость в сторону
    // падающего), ближе своих порогов цель не становится, а за ними оси удара и
    // слэма — ноль (NPC-3).
    //
    // Контроль ровно на это: удар внутри окна БЫЛ готов, то есть молчал он не
    // кулдауном. Слэму такого контроля не поставить — его откат (360 тиков)
    // переживает весь полёт героя, — но пара доказывается включением: порог
    // просьбы слэма (1.8) лежит СТРОГО ВНУТРИ порога удара (5.0), и цель,
    // недостижимая для второго, недостижима и для первого.
    expect(strikeReady).toBe(true);
    // Разгон в список не входит НАМЕРЕННО: его ось дистанции растёт с
    // расстоянием, то есть далёкая цель его как раз поощряет, и по падающему он
    // просится — молчит он здесь только своим кулдауном, потраченным в начале
    // боя. Отказаться от падающей цели документ не может вовсе: про полёт
    // закрытый словарь входов не знает и знать не обязан — у платформы «цель»
    // это живая сущность, и падающий ею остаётся (NPC-5).
    expect(asked).toEqual([]);
  });

  it('бегущего к краю догоняет, но за край не выходит', () => {
    // Второй заход того же: герой сам убегает за край, босс идёт следом.
    const a = stand([[26, 24]]);
    for (let t = 1; t <= 700; t++) {
      a.step([{ moveX: FIXED_ONE }]);
      expect(coreWorld.hasComponent(a.state.world, a.boss, 'Falling'), `тик ${t}`).toBe(false);
    }
    expect(coreWorld.hasComponent(a.state.world, a.heroes[0]!, 'Falling')).toBe(true);
  });

  it('герой упирается в босса и не оказывается за ним', () => {
    // Способности запаркованы: предмет проверки — ТЕЛО босса, а не его толчок.
    const a = stand([[21, 24]], only());
    const hero = a.heroes[0]!;
    const contact = BOSS_RADIUS + HERO_RADIUS;
    for (let t = 0; t < 90; t++) {
      a.step([{ moveX: FIXED_ONE }]);
      expect(px(a.state, hero)).toBeLessThan(px(a.state, a.boss));
      expect(distance(a.state, hero, a.boss)).toBeGreaterThanOrEqual(contact);
    }
  });

  it('герой героя по-прежнему не блокирует: слой босса свой, а не общий', () => {
    const collider = (name: string): Record<string, number> =>
      SCENE.prefabs!.find((prefab) => prefab.name === name)!.components.Collider as Record<string, number>;
    const hero = collider('Hero');
    const boss = collider('Boss');
    expect(hero.layer).toBe(2);
    expect(boss.layer).toBe(BOSS_LAYER);
    // Герой держится боссом и обрывами, но не героем.
    expect(hero.blockMask! & boss.layer!).toBe(boss.layer);
    expect(hero.blockMask! & hero.layer!).toBe(0);
    // Босс держится героями — «друг сквозь друга» верно в обе стороны.
    expect(boss.blockMask! & hero.layer!).toBe(hero.layer);
    // Снаряд видит в боссе сенсорную цель и НЕ блокируется им.
    for (const name of ['Fireball', 'HeavyFireball']) {
      const ball = collider(name);
      expect(ball.hitMask! & boss.layer!).toBe(boss.layer);
      expect(ball.hitMask! & hero.layer!).toBe(hero.layer);
      expect(ball.blockMask! & boss.layer!).toBe(0);
    }
  });

  it('мёртвый босс не отталкивает и не задерживает снаряды', () => {
    const a = stand([[20, 24]], health('Boss', HIT_DAMAGE));
    let events: readonly string[] = [];
    for (let t = 0; t < 40 && !events.includes('EntityDied'); t++) {
      events = a.step([{ buttons: t === 0 ? CAST : 0 }]);
    }
    expect(coreWorld.hasComponent(a.state.world, a.boss, 'Dead')).toBe(true);
    expect(coreWorld.getField(a.state.world, a.boss, 'Collider', 'layer')).toBe(0);

    // Герой бежит НА труп и дальше сквозь него, дольше кулдауна толчка: запрос
    // системы контакта мертвеца не касается, а слой коллизий смерть погасила.
    const hero = a.heroes[0]!;
    const healthy = hp(a.state, hero);
    let crossed = false;
    for (let t = 0; t < REPEL_CD + 60; t++) {
      expect(a.step([{ moveX: FIXED_ONE }])).not.toContain('BossRepelLanded');
      if (px(a.state, hero) > px(a.state, a.boss)) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(hp(a.state, hero)).toBe(healthy);
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
    for (const id of ['bossSlam', 'bossRepel', 'bossFireAura']) walk(abilityDef(id));
    walk(systemDef('BossDashDrive'));
    // Удар в этот перечень не входит намеренно: его урон едет снарядом, а не
    // выборкой, и «только по героям» держит там условие `HitMark` — компонент,
    // которого нет ни у босса, ни у его спутников.
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
      expect.arrayContaining([STRIKE_DAMAGE, STRIKE_CD, STRIKE_WINDUP]),
    );
    // Досягаемость волны — числа её prefab'а, а не определения: скорость и
    // время жизни (ABIL-9).
    const wave = SCENE.prefabs!.find((prefab) => prefab.name === 'BossWave')!;
    expect((wave.components.AbilityProjectile as Record<string, number>).ticksLeft).toBe(WAVE_TICKS);
    expect((wave.components.Velocity as Record<string, number>)).toBeDefined();
    expect((wave.components.Collider as Record<string, number>).radius).toBe(WAVE_RADIUS);
    // Волна видит ГЕРОЕВ и только их: слой босса (8) в её маску не входит.
    expect((wave.components.Collider as Record<string, number>).hitMask).toBe(2);
    expect((wave.components.Collider as Record<string, number>).blockMask).toBe(0);
    expect(numbers(abilityDef('bossSlam'))).toEqual(
      expect.arrayContaining([SLAM_DAMAGE, SLAM_ROAR, SLAM_RADIUS, MEDIUM]),
    );
    expect(numbers(abilityDef('bossCharge'))).toEqual(expect.arrayContaining([CHARGE_AIM]));
    expect(numbers(abilityDef('bossRepel'))).toEqual(
      expect.arrayContaining([REPEL_DAMAGE, REPEL_CD, REPEL_RADIUS, MEDIUM]),
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
    // Оба множителя проверяются ПРОТИВ СЦЕНЫ, а не сами против себя: радиус
    // тела и шаг рывка читаются из документа, и производные от них величины
    // обязаны сойтись с тем, что там же и записано.
    const bodyRadius = (boss.components.Collider as Record<string, number>).radius!;
    expect(numbers(abilityDef('bossSlam'))).toContain(3 * bodyRadius);
    const dashStep = numbers(systemDef('BossDashDrive')).find((value) => value === DASH_SPEED);
    expect(dashStep, 'шаг рывка не найден в BossDashDrive').toBe(DASH_SPEED);
    expect(numbers(abilityDef('bossFireAura'))).toContain(FIRE_RADIUS);
    // Полоса сплошная и без нахлёста ровно тогда, когда шаг равен диаметру.
    expect(dashStep).toBe(2 * FIRE_RADIUS);
    // И «сто в секунду» — произведение периода на урон, а не отдельное число.
    expect(FIRE_DPS).toBe(100);
    expect(numbers(abilityDef('bossFireAura'))).toEqual(
      expect.arrayContaining([FIRE_DAMAGE, FIRE_PERIOD]),
    );
    // Таблица угрозы остаётся на боссе, хотя политики угрозы у него нет:
    // `chooseTarget` (NPC-5) читает её слоты безусловно, и без компонента это
    // четыре чтения без владения за тик (ECS-7) — трейс тонет в записях
    // сломанного инварианта (FP-4) и перестаёт годиться для отладки боя.
    expect(boss.components.NpcThreat).toBeDefined();
    const behaviors = (SCENE as unknown as { npc: { behaviors: readonly Record<string, unknown>[] } })
      .npc.behaviors;
    expect(behaviors[0]!.threat).toBeUndefined();
    // Возрождение: окно и точка — зеркало `arena.center` сцены.
    const respawn = numbers(systemDef('BossRespawn'));
    expect(respawn).toContain(BOSS_RESPAWN_TICKS);
    expect(respawn).toContain(ARENA_CENTER);
    const center = (SCENE as unknown as { arena: { center: { x: number; y: number } } }).arena.center;
    expect(center).toEqual({ x: ARENA_CENTER, y: ARENA_CENTER });
  });

  it('ротация — политика документа: одно состояние, оси готовности и дистанции', () => {
    // NPC-7: «Ротации способностей — приоритеты, условия, правила цели — SHALL
    // быть политикой документа; сам каст SHALL идти существующей машиной
    // способностей». Здесь это и пиннится: ротация — СКОРИНГ одного состояния,
    // где каждое cast-действие оценивается готовностью своего слота
    // (`abilityReady`, тот же гейт, что у триггера, ABIL-7) и дистанцией до
    // цели. Приоритет — веса и кривые, а не порядок переходов: состояний на
    // способность больше нет.
    const behavior = bossDoc();
    const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
    // Босс не медленнее идущего героя — иначе преследование не преследование.
    expect(behavior.speed).toBeGreaterThanOrEqual(
      (hero.components.Locomotion as Record<string, number>).maxSpeed!,
    );

    // Ровно одно состояние и ни одного перехода: ротацией больше не правит
    // автомат — её решает скоринг каждый тик.
    expect(behavior.states).toHaveLength(1);
    const rotation = behavior.states[0]!;
    expect(rotation.transitions ?? []).toEqual([]);
    expect(rotation.actions.map((action) => action.executor)).toEqual([
      'seekTarget',
      'cast',
      'cast',
      'cast',
    ]);
    // Базовое действие — сближение: оно и выигрывает, пока не готова ни одна
    // способность, поэтому босс не замирает между кастами.
    const seek = rotation.actions[0]!;
    expect(seek.considerations.map((axis) => axis.input)).toEqual(['always']);

    for (const [event, slot] of Object.entries(ASK_SLOT)) {
      const action = rotation.actions.find((entry) => entry.event === event)!;
      expect(action, `в ротации нет просьбы ${event}`).toBeDefined();
      // Ось готовности адресует РЕАЛЬНЫЙ слот босса — тот самый `slotIndex`,
      // который кладёт в мир prefab (ABIL-1). Разъедься они, ось молча читалась
      // бы нулём: слота с таким индексом у босса нет (NPC-7).
      const ready = action.considerations.find((axis) => axis.input === 'abilityReady')!;
      expect(ready, `у ${event} нет оси готовности`).toBeDefined();
      expect(ready.slot).toBe(slot);
      expect(bossSlotIndex(SLOT_PREFAB[event]!)).toBe(slot);
      // Кривая готовности читает сам вход, а не подменяет его константой:
      // `constant` вернула бы единицу и на неготовом слоте.
      expect(ready.curve.type).toBe('linear');
      expect(ready.weight).toBeGreaterThan(0);
    }
  });

  it('дистанционные оси ротации — зеркала порогов боя', () => {
    // Пороги те же, что были у снесённого сенсора, только выражены кривой:
    // ось обнуляется там, где кончается применимость способности. Считается
    // это ИЗ ДОКУМЕНТА (наклон, свободный член и радиус чутья), поэтому ретюн
    // любой из трёх величин виден здесь, а не только в бою.
    const rotation = bossDoc().states[0]!;
    const reach = (event: string): number => {
      const axis = rotation.actions
        .find((entry) => entry.event === event)!
        .considerations.find((entry) => entry.input === 'targetDistance')!;
      expect(axis.curve.type).toBe('linear');
      // Прямая обнуляется на `x = -intercept / slope`, а `x` — доля радиуса
      // чутья: масштаб входа `targetDistance` задаёт документ (NPC-3).
      return (-axis.curve.intercept! / axis.curve.slope!) * bossDoc().ranges.sense;
    };
    // Удар достаёт на среднюю дистанцию — ровно на длину полёта своей волны.
    expect(Math.abs(reach('BossStrike') - MEDIUM)).toBeLessThan(FIXED_ONE / 100);
    expect(WAVE_SPEED * WAVE_TICKS).toBe(MEDIUM);
    // Слэм просится вплотную — в радиусе собственного взрыва.
    expect(Math.abs(reach('BossSlam') - SLAM_RADIUS)).toBeLessThan(FIXED_ONE / 100);
    // Разгон — наоборот, ЗА средней дистанцией: его ось растёт с расстоянием.
    expect(Math.abs(reach('BossCharge') - MEDIUM)).toBeLessThan(FIXED_ONE / 100);
    const charge = rotation.actions.find((entry) => entry.event === 'BossCharge')!;
    expect(
      charge.considerations.find((axis) => axis.input === 'targetDistance')!.curve.slope!,
    ).toBeGreaterThan(0);
    // И разгон не просится вслепую: без цели `targetDistance` отвечает «дальше
    // некуда» (NPC-3), и без оси `targetKnown` босс разгонялся бы в пустоту.
    expect(charge.considerations.map((axis) => axis.input)).toContain('targetKnown');
  });

  it('сенсора готовности в сцене нет, а занятость держит отдельная система', () => {
    // Половина утверждения — отрицательная: система, пересказывавшая кулдауны
    // и дистанции событиями `Boss*Ready`, снесена целиком, и вернуться она
    // может только вместе с этими именами.
    expect(SCENE.systems!.map((system) => system.name)).not.toContain('BossReady');
    expect(JSON.stringify(sceneJson)).not.toMatch(/Boss(Slam|Strike|Charge)Ready/);

    // Вторая половина — положительная: занятость владельца словарь NPC не
    // видит и видеть не обязан (NPC-7), поэтому её держит сцена — раньше
    // системы поведения (−795), чтобы решение этого же тика её увидело.
    const busy = systemDef('BossBusy');
    expect(busy.order).toBeLessThan(-795);
    // Держатся ровно ротационные слоты: толчок просит своя система со своим
    // гейтом, и запертый кулдаун отнял бы у неё пассивку.
    expect(JSON.stringify(busy)).toContain('slotIndex');
    expect(numbers(busy)).toContain(BOSS_ROTATION_SLOTS - 1);
  });

  it('радиус вспышки слэма — радиус, по которому он бьёт', () => {
    // Та же связь, что у оболочки купола: картинка обязана совпадать с зоной
    // урона, иначе игрок учится не тому. Число некруглое намеренно — 1.8
    // мировой единицы в Q16.16 точно не представимо, а врать картинке нельзя.
    expect(MANIFEST.effects.byEvent.BossSlamLanded!.radiusTo).toBe(SLAM_RADIUS / FIXED_ONE);
    // Волна и полоса огня рисуются записями по ВИДУ: моделей у них нет, как у
    // купола. Оболочка вправе быть ЧУТЬ шире зоны урона — пятна огня ложатся с
    // шагом в 0.6 единицы, и полоса обязана читаться сплошной, — но не уже её:
    // невидимый урон под ногами учит игрока ровно неверному.
    expect(MANIFEST.effects.byKind.BossWave!.radius).toBeGreaterThanOrEqual(
      WAVE_RADIUS / FIXED_ONE,
    );
    // Пятно огня — РОВНО зона урона: и радиус, и шаг выражаются в целых долях
    // мировой единицы, так что округлять нечего.
    expect(MANIFEST.effects.byKind.BossFire!.radius).toBe(FIRE_RADIUS / FIXED_ONE);
    // Толчок в упор стал радиальным взрывом — вспышка обязана назвать его радиус.
    expect(MANIFEST.effects.byEvent.BossRepelLanded!.radiusTo).toBe(REPEL_RADIUS / FIXED_ONE);
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
