/**
 * Босс демо-арены как КОНТЕНТ (`content/scenes/duel.scene.json`: prefab'ы
 * `Boss`/`BossMinion`/`BossField`, определения `bossStrike`/`bossSlam`/
 * `bossCharge`/`bossFireAura`/`bossField`/`bossFieldAura`/`bossSpawn`/
 * `bossMinionMelee`, системы `Boss*`/`Minion*` и документы поведения
 * `arenaBoss`/`arenaMinion`).
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
 * Отталкивание в упор — НЕ способность и намеренно: способности одного
 * владельца взаимоисключающи (`supersede`, ABIL-6), и пассивка, у которой нет
 * ни фазы, ни телеграфа, срывала бы боссу каждый замах чужим телом. Поэтому
 * она живёт JSON-системой `BossRepel` со сроком в поле `BossHunt.repelUntil`, а
 * не слотом с кулдауном, — и работает независимо от того, что босс кастует.
 *
 * Ротация — политика ДОКУМЕНТА (NPC-7), и с появлением входа `abilityReady`
 * она вся уместилась в скоринг: одно состояние, в нём `seekTarget` и пять
 * `cast`-действий, у каждого ось готовности своего слота (`slotIndex`, ABIL-1)
 * и ось дистанции. Готовность спрашивается тем же предикатом, каким гейт
 * триггера решает, стартовать ли каст (ABIL-7), поэтому просьбы, которую гейт
 * уронил бы, документ не публикует вовсе — системы-сенсора, пересказывавшей
 * кулдауны событиями `Boss*Ready`, в сцене больше нет.
 *
 * ПРИОРИТЕТ ротации выражают ВЕСА осей, а не порядок переходов: полезность
 * действия есть произведение оценок его осей (NPC-3), и редкое стоит выше
 * частого — поле (1.0), призыв (0.95), слэм (0.9), удар (0.75). Порядок был бы
 * приоритетом у автомата состояний, которого больше нет.
 *
 * Сцена оставляет за собой ровно одно — ЗАНЯТОСТЬ владельца (`BossBusy`,
 * order −798): пока идёт чей-то каст или рывок, ротационные слоты держатся
 * недоступными, иначе следующая просьба обрывала бы текущий замах штатным
 * `supersede` (ABIL-6). Это политика сцены, а не словаря NPC: платформа про
 * «занят другим слотом» ничего не обещает.
 *
 * Держит она их ТЕМ ЖЕ полем, которым платформа держит откат, — `remaining`
 * кулдауна слота, — и это законно ровно при одном инварианте: удержание пишет
 * ЕДИНИЦУ И ТОЛЬКО В НУЛЕВОЙ остаток, а снимает её тем же тиком система
 * кулдаунов (order 800), поэтому настоящий кулдаун, взведённый завершением
 * каста по `cooldownTicks` (ABIL-7), им нельзя ни укоротить, ни продлить.
 * Оба слагаемых инварианта пиннит describe «занятость босса», а не этот текст.
 *
 * Толчка в упор `BossBusy` не касается намеренно: он больше не способность и
 * слота не занимает, а гейт на рывок несёт своя система (`BossRepel`).
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
import * as THREE from 'three';
import { mdxLoader, type NormalizedModel } from '@fluxus/assets';
import { MixerAnimationBackend, ViewBuffer, resolveClip, type TickView } from '@fluxus/render';
import { DEMO_AIM_EVENTS, createDemoExtractor } from '../app/extractor.js';
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
  readonly entities: Record<
    string,
    { readonly scale: number; readonly animations: { readonly events: Record<string, string> } }
  >;
  readonly effects: {
    readonly byKind: Record<string, EffectEntry | undefined>;
    readonly byEvent: Record<string, EffectEntry>;
  };
  readonly particles: {
    readonly byKind?: Record<string, { readonly effect: string }>;
    readonly byEvent: Record<string, { readonly effect: string }>;
  };
  readonly cameraEffects: { readonly events: Record<string, { readonly effect: string }> };
};

/** Корень дерева контента — из него читаются модель и ассеты эмиттеров. */
const CONTENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../content');

/**
 * Радиус формы эмиттера частиц в мировых единицах — то, чем ассет эмиттера
 * заменяет поле `radius` записи-сферы. Читается из самого документа: у секции
 * `particles` манифеста своего радиуса нет вовсе (ASSET-14), и связь картинки с
 * зоной урона иначе держать не на чем.
 */
function emitterRadius(assetId: string): number {
  const doc = JSON.parse(readFileSync(join(CONTENT_ROOT, assetId), 'utf8')) as {
    object: { children: readonly { ps: { shape: { radius: number } } }[] };
  };
  return doc.object.children[0]!.ps.shape.radius;
}

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
 * «Средняя дистанция» отброса — 5 мировых единиц: на столько улетает жертва и
 * от слэма, и от толчка в упор. Мерка взята от арены (радиус 21) и от
 * собственного рывка героя (3.6): дальше рывка, но далеко не через арену.
 */
const MEDIUM = 327680;
/**
 * Досягаемость удара — 4 единицы: ближе неё босс бьёт волной, дальше просит
 * разгон. Число живёт В ДВУХ местах и обязано совпадать: ось дистанции
 * документа обнуляется ровно на нём, а сама волна дотягивается на «скорость ×
 * время жизни». Разъедутся — босс будет замахиваться по тому, до кого волна не
 * долетит.
 */
const WAVE_SPEED = 32768;
const WAVE_TICKS = 8;
const STRIKE_REACH = WAVE_SPEED * WAVE_TICKS;
/** Ширина волны — радиус тела босса. */
const WAVE_RADIUS = BOSS_RADIUS;
/** Взрыв слэма — шесть радиусов тела. */
const SLAM_RADIUS = 6 * BOSS_RADIUS;
/**
 * Пятно огня — РОВНО шаг рывка, и ложится оно через тик: соседние центры тогда
 * отстоят на два радиуса, то есть касаются, не перекрываясь. Шире шаг — между
 * пятнами щель, которую оболочка манифеста всё равно рисует сплошной полосой;
 * уже — нахлёст, и стоящий на стыке горит вдвое, потому что каждое пятно жжёт
 * своим кастером.
 */
const FIRE_RADIUS = 39322;
const DASH_SPEED = FIRE_RADIUS;

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
 * 1.2 единицы пересекается бегущим героем за полтора десятка тиков, и проба раз
 * в шестьдесят ловила бы его один раз из четырёх. Десять проб в секунду по
 * десятке дают ту же сотню стоящему и честную долю пробегающему.
 */
const FIRE_PERIOD = 6;
const FIRE_DAMAGE = 10;
/** Та самая сотня в секунду, которую эта пара обязана давать. */
const FIRE_DPS = (FIRE_DAMAGE * 60) / FIRE_PERIOD;
const REPEL_DAMAGE = 200;
/** Пауза между толчками — поле `BossHunt.repelUntil`, а не кулдаун слота. */
const REPEL_INTERVAL = 45;
/** Микровзрыв в упор — радиальный: разлетается всё, что стоит вплотную. */
const REPEL_RADIUS = 98304;

/**
 * Поле замедления. Радиус — полтора купола героя, и считается он ИМЕННО так:
 * 196610 × 3 / 2 = 294915. Спад — с единицы до 0.2 за первые четыре секунды,
 * дальше держится; жизнь 12 с, кулдаун 20 с (кулдаун строго больше жизни —
 * поэтому полей в мире не бывает двух, и постоянный id источника законен).
 */
const DOME_RADIUS = 196610;
const FIELD_RADIUS = (DOME_RADIUS * 3) / 2;
const FIELD_LIFE = 720;
const FIELD_CD = 1200;
const FIELD_RAMP = 240;
/**
 * Окно спада У СНАРЯДА — своё и намеренно крошечное. Геройские четыре секунды
 * снаряду не мерка: он живёт пятьдесят тиков, а в поле проводит единицы, и на
 * общем окне «замедляет снаряды» превращалось бы в процент. Прецедент рядом:
 * купол героя кладёт свои 0.25× на чужой снаряд СРАЗУ, без всякого спада, —
 * шесть тиков (одна десятая секунды) держат правило «отсчёт от входа жертвы»
 * и при этом дают снаряду дойти до пола на первой же трети пролёта.
 */
const FIELD_PROJECTILE_RAMP = 6;
const FIELD_FLOOR = 13107;
/** Глубина спада: на столько множитель падает за всё окно. */
const FIELD_FLOOR_STEP = FIXED_ONE - FIELD_FLOOR;
/** Идентификатор источника замедления поля в списке `TimeScaleModifiers`. */
const FIELD_MODIFIER_ID = 7001;

/**
 * Скелет-прислужник: тело в полтора раза меньше героя (19661 / 1.5), жизнь 10 с.
 *
 * Шаг — на треть ШИРЕ героического, и решает здесь не отношение, а РАЗНОСТЬ:
 * догоняющий сокращает дистанцию ровно на неё. Героическим шагом он её не
 * сокращает вовсе — но и не отстаёт: бот бежит по дуге, а не по прямой, и на
 * поворотах преследователь срезает, поэтому даже при равном шаге он иногда
 * оказывается в зоне укуса. На пятнадцати процентах разность — 786 (0.012
 * единицы за тик), и пять единиц отрыва закрываются четырьмястами тиками из
 * шестисот отпущенных ему на жизнь; на трети разность вдвое больше.
 *
 * Замер по убегающему по дуге герою (1200 тиков от призыва, стенд `chase`
 * ниже): доля времени в зоне укуса 4.4% / 8.5% / 19.3% и укусов 1 / 4 / 7 на
 * шагах ×1.0 / ×1.15 / ×1.3. Дальше (×1.5 — 26.3%, ×1.75 — 32.0%) растёт время
 * в контакте, но урон почти нет: кулдаун укуса в секунду ограничивает частоту.
 */
const MINION_RADIUS = 13107;
const HERO_SPEED = 5243;
const MINION_SPEED = 6816;
/**
 * Запас скелета — 500, и это ОСОЗНАННОЕ отступление от «хп мало, умирает с
 * одного фаербола». Мерка взята из боя, а не из головы: за отладочный матч все
 * до единого попадания по скелетам были ЗАРЯЖЕННЫМИ фаерболами на 480, потому
 * что бот копит заряд, — и сотня умирала от них ровно так же, как умирали бы
 * двести. Пятьсот меняют исход: недокачанный выстрел (480) скелет переживает,
 * полностью заряженный (200 × 2² = 800) снимает его по-прежнему с одного, а
 * базовых двухсот нужно три. «Умирает с одного фаербола» осталось верным для
 * заряженного и перестало быть верным для базового — связь пиннит тест ниже.
 */
const MINION_HP = 500;
/**
 * Досягаемость призыва — 12 единиц. Своей зоны у него нет вовсе, и ось нужна
 * только затем, чтобы не звать скелетов по цели, до которой им не дойти за
 * десять секунд жизни. Число не выдумано: `bossCharge` тем же 786432 меряет
 * свой запасной рывок «в никуда» — это уже принятая в сцене «длинная»
 * дистанция босса.
 */
const SPAWN_REACH = 786432;
/**
 * Окно накопления заряда фаербола в тиках и множитель на полном заряде (2.0 в
 * Q16.16) — оба зеркала определения `fireball`, и оба сверяются с ним ниже.
 * Урон растёт КВАДРАТОМ множителя: `200 × scale²`, то есть от 200 до 800.
 */
const CHARGE_TICKS = 60;
const CHARGE_MAX_SCALE = 131072;
const MINION_LIFE = 600;
const MINION_MELEE = 50;
const MINION_MELEE_CD = 60;
/** Удар в контакт — сумма тел: скелет достаёт ровно того, в кого упёрся. */
const MINION_REACH = MINION_RADIUS + HERO_RADIUS;
/** Взрыв на смерти — та же зона, что у толчка босса в упор. */
const MINION_BURST = 200;
const MINION_BURST_RADIUS = REPEL_RADIUS;
const MINION_COUNT = 3;
const SPAWN_ROAR = 90; // 1.5 с — тот же рёв, что у слэма
const SPAWN_CD = 900;
/** Слой коллизий скелета — свой: ни герой, ни босс им не блокируются. */
const MINION_LAYER = 16;

/** Окно охоты за одной целью и окно возрождения — оба по 10 с при 60 Гц. */
const HUNT_TICKS = 600;
const BOSS_RESPAWN_TICKS = 600;
/** Вероятность переключиться на обидчика — 0.5 в Q16.16. */
const RAGE_CHANCE = 32768;

const BOSS_HP = 8000;
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
  /**
   * Presentation-состояние последнего тика глазами рендера (SHELL-2): то, что
   * доехало бы до кадра. Живёт только у стенда с `{ extract: true }` — обычному
   * тесту политики сцены доставка не нужна, а платить за неё каждым тиком незачем.
   */
  view(): TickView;
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
  options: { readonly extract?: boolean } = {},
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
  // Доставка — та же, что у сборки демо (SHELL-8): свой экстрактор тест не
  // сочиняет, иначе проверялся бы он, а не то, что видит игрок.
  const extractor = options.extract === true ? createDemoExtractor(undefined) : null;
  const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
  return {
    sim: built.sim,
    state: built.state,
    boss: bossEntity,
    heroes,
    last,
    at: () => tick,
    view: () => buffer.view,
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
      const result = simTick(built.sim, built.state, inputs);
      last.events = [...result.events];
      if (extractor !== null) buffer.apply(extractor.extract(result));
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
 * же тик уводит босса в поле замедления и рёв призыва (они первые в ротации), а
 * `supersede` (ABIL-6) делает соседние касты взаимоисключающими.
 *
 * Толчка в упор в этом списке нет и быть не может: он больше не способность, а
 * система, и запирается отдельно — `noRepel`.
 */
const BOSS_SLOTS = [
  'SlotBossStrike',
  'SlotBossSlam',
  'SlotBossCharge',
  'SlotBossField',
  'SlotBossSpawn',
] as const;

function only(...keep: readonly string[]): SceneDef {
  const parked = new Set(BOSS_SLOTS.filter((name) => !keep.includes(name)));
  return {
    ...SCENE,
    prefabs: SCENE.prefabs!.map((entry) =>
      parked.has(entry.name as (typeof BOSS_SLOTS)[number])
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

/** Сцена с ретюненным шагом скелета — ею меряется, что решает именно шаг. */
function minionSpeed(speed: number, scene: SceneDef = SCENE): SceneDef {
  const npc = (scene as unknown as { npc: { behaviors: readonly Record<string, unknown>[] } }).npc;
  return {
    ...scene,
    npc: {
      ...npc,
      behaviors: npc.behaviors.map((entry) =>
        entry.name === 'arenaMinion' ? { ...entry, speed } : entry,
      ),
    },
  } as unknown as SceneDef;
}

/**
 * Сцена с запертым толчком: срок паузы отодвинут за горизонт прогона. Нужна
 * там, где предмет проверки — ТЕЛО босса или его каст, а не пассивка: толчок
 * радиальный и срабатывает раньше, чем герой успевает упереться.
 */
function noRepel(scene: SceneDef = SCENE): SceneDef {
  return {
    ...scene,
    prefabs: scene.prefabs!.map((entry) =>
      entry.name === 'Boss'
        ? {
            ...entry,
            components: {
              ...entry.components,
              BossHunt: {
                ...(entry.components.BossHunt as Record<string, number>),
                repelUntil: 100000,
              },
            },
          }
        : entry,
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
  BossField: 'SlotBossField',
  BossSpawn: 'SlotBossSpawn',
};

/**
 * Просьба ротации → `slotIndex`, которым её адресует документ. Список
 * ОТДЕЛЬНЫЙ от prefab'ов намеренно: тест сверяет две стороны адресации, и
 * разъехавшийся индекс читался бы в бою нулевой готовностью, а не ошибкой.
 */
const ASK_SLOT: Record<string, number> = {
  BossStrike: 0,
  BossSlam: 1,
  BossCharge: 2,
  BossField: 3,
  BossSpawn: 4,
};

/** Ротационных слотов пять; толчок и аура в ротацию не входят вовсе. */
const BOSS_ROTATION_SLOTS = 5;

const slotPrefabField = (prefab: string, field: string): number =>
  (SCENE.prefabs!.find((entry) => entry.name === prefab)!.components.AbilitySlot as Record<
    string,
    number
  >)[field]!;

const bossSlotIndex = (prefab: string): number => slotPrefabField(prefab, 'slotIndex');

/**
 * Дистанция, на которой ось `targetDistance` действия обнуляется, в мировых
 * единицах Q16.16. Считается ИЗ ДОКУМЕНТА — наклон, свободный член и радиус
 * чутья, — поэтому ретюн любой из трёх величин виден в тесте, а не в бою.
 */
const axisReach = (event: string): number => {
  const axis = bossDoc()
    .states[0]!.actions.find((entry) => entry.event === event)!
    .considerations.find((entry) => entry.input === 'targetDistance')!;
  expect(axis.curve.type).toBe('linear');
  return (-axis.curve.intercept! / axis.curve.slope!) * bossDoc().ranges.sense;
};

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
    // Способности боссу запаркованы, толчок заперт: он только преследует,
    // героев не задевает и потому не выбивает их с арены. Предмет проверки —
    // СРОК охоты, и посторонние смерти сдвигали бы его, ничего не сообщая о нём
    // самом: двести урона раз в сорок пять тиков убивают героя за четыре
    // секунды, и мерилась бы его живучесть.
    const picks: { tick: number; target: EntityId }[] = [];
    const a = stand([[20, 24], [28, 24]], noRepel(only()), 1);
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
    // Сидов больше, чем кажется нужным, и это не запас «на всякий случай»:
    // скелеты босса ловят снаряды своим слоем (16 в маске снаряда), то есть
    // часть выстрелов до самого босса не доезжает, и подходящих попаданий на
    // сид приходится меньше. Доля меряется по знаменателю, и знаменатель
    // обязан быть больше пары десятков, иначе полоса ниже ничего не значит.
    for (let seed = 1; seed <= 20; seed++) {
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

describe('отталкивание: пассивный микровзрыв в упор', () => {
  it('подошедшего вплотную бьёт на 200 и уносит на среднюю дистанцию', () => {
    // Жалоба дизайнера дословно: «подхожу к боссу вплотную — и ничего». Стенд
    // её и воспроизводит: герой идёт в босса и упирается. Способности заперты —
    // предмет проверки ПАССИВКА, а не то, чем босс занят.
    const a = stand([[20, 24]], only());
    const hero = a.heroes[0]!;
    const forward = [{ moveX: FIXED_ONE }];

    // Толчок ждёт не столкновения, а расстояния: `Collision` физика публикует
    // только на ЗАБЛОКИРОВАННОМ шаге (PHYS-9), и стоящему вплотную его не
    // видать вовсе. Порог — радиус микровзрыва, и герой доходит до него сам.
    // Точка отсчёта снимается ДО тика толчка: `LocomotionSystem` (order 0)
    // стоит позже системы толчка (-793) и первый шаг отброса отрабатывает уже
    // на нём.
    let before = { x: 0, y: 0 };
    let landed = -1;
    for (let t = 1; t <= 300 && landed < 0; t++) {
      before = { x: px(a.state, hero), y: py(a.state, hero) };
      if (a.step(forward).includes('BossRepelLanded')) landed = a.at();
    }
    // Допуск — один шаг рывка: толчок сработал внутри радиуса, а `Locomotion`
    // того же тика уже унёс жертву на первый шаг отброса.
    expect(distance(a.state, hero, a.boss)).toBeLessThanOrEqual(REPEL_RADIUS + DODGE_SPEED);
    expect(hp(a.state, hero)).toBe(HERO_HP - REPEL_DAMAGE);
    // Контроль: до порога он шёл, а не получил толчок с первого тика издалека.
    expect(landed).toBeGreaterThan(1);

    // Отброс — БУКВАЛЬНО рывок жертвы: тот же `LOCOMOTION_DODGE`, что ставит
    // герою его собственный уклон (LOC-3, LOC-4), и число тиков считается от
    // его же `dodgeSpeed`. Единица разницы служебная: система пишет состояние
    // командой, а `LocomotionSystem` того же тика уже отрабатывает первый шаг.
    const away = distance(a.state, hero, a.boss);
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'state')).toBe(LOCOMOTION_DODGE);
    const left = coreWorld.getField(a.state.world, hero, 'LocomotionState', 'ticksLeft');
    expect(left).toBe(KNOCKBACK_TICKS - 1);

    for (let t = 0; t < left; t++) a.step();
    const moved = Math.hypot(px(a.state, hero) - before.x, py(a.state, hero) - before.y);
    // Допуск — один тик рывка: столько стоит служебная единица выше.
    expect(Math.abs(moved - MEDIUM)).toBeLessThanOrEqual(DODGE_SPEED);
    expect(distance(a.state, hero, a.boss)).toBeGreaterThan(away);
  });

  it('пока герой держится вплотную, толчок повторяется — но не чаще интервала', () => {
    // Вторая половина жалобы: «и второй раз ничего». Прежняя реализация
    // ВЫБРАСЫВАЛА запомненный контакт на следующем тике, поэтому подошедший в
    // неудачный момент не получал толчка ни разу. Здесь герой давит вперёд всё
    // время, и меряются ОБА свойства: повтор случается и случается не чаще
    // объявленного интервала.
    const a = stand([[20, 24]], only());
    const forward = [{ moveX: FIXED_ONE }];
    const at: number[] = [];
    for (let t = 1; t <= 900; t++) {
      if (a.step(forward).includes('BossRepelLanded')) at.push(a.at());
    }
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i++) {
      expect(at[i]! - at[i - 1]!, `толчки на тиках ${at.join(',')}`).toBeGreaterThanOrEqual(
        REPEL_INTERVAL,
      );
    }
  });

  it('микровзрыв радиальный: разлетаются все, кто стоит вплотную', () => {
    // «При столкновении происходит микровзрыв» — взрыв, а не тычок в одного:
    // иначе при двух подбежавших в один тик толчок доставался бы тому, кого
    // раньше вернул запрос физики (QUERY-2), и пассивка читалась бы как
    // «иногда не срабатывает».
    const a = stand([[22.5, 24], [25.5, 24]], only());
    const forward = [{ moveX: FIXED_ONE }, { moveX: -FIXED_ONE }];
    until(a, 'BossRepelLanded', 300, forward);
    for (const hero of a.heroes) {
      expect(distance(a.state, hero, a.boss)).toBeLessThan(REPEL_RADIUS + DODGE_SPEED * KNOCKBACK_TICKS);
      expect(hp(a.state, hero)).toBe(HERO_HP - REPEL_DAMAGE);
    }
  });

  it('разворот к жертве едет направлением события, а не позой', () => {
    // Курс инстанса производен от скорости (REND-13), и стоящего босса он не
    // поворачивает. Событие несёт `dirX`/`dirY` на жертву — по ним рендер
    // доворачивает корпус (REND-5).
    const a = stand([[24, 20]], only());
    const hero = a.heroes[0]!;
    until(a, 'BossRepelLanded', 300, [{ moveY: FIXED_ONE }]);
    const landed = a.last.events.find((event) => event.type === 'BossRepelLanded')!;
    expect(landed.data.entity).toBe(a.boss);
    expect(landed.data.target).toBe(hero);
    // Герой ЮЖНЕЕ босса: направление на него — почти чистый −y.
    expect(landed.data.dirY!).toBeLessThan(0);
    expect(Math.abs(landed.data.dirX!)).toBeLessThan(Math.abs(landed.data.dirY!));
    expect(coreWorld.getField(a.state.world, hero, 'LocomotionState', 'dirY')).toBeLessThan(0);
  });

  it('идущий каст толчок НЕ срывает и толчку каст не мешает', () => {
    // Ровно то, ради чего пассивка перестала быть способностью: `supersede`
    // (ABIL-6) обрывает чужой каст того же владельца безусловно, и прежняя
    // реализация вынуждена была молчать, пока идёт любая фаза, — то есть почти
    // всегда, потому что замах в 48 тиков стоит на кулдауне в 60. Теперь
    // толчок — система, и обе половины проверяются на одном прогоне: он
    // случается ВНУТРИ замаха, а замах доживает до волны ровно за свои 800 мс.
    const a = stand([[21, 24]], only('SlotBossStrike'));
    const forward = [{ moveX: FIXED_ONE }];
    const windup = until(a, 'BossStrikeWindup', 60, forward);
    let repelled = -1;
    let landed = -1;
    while (a.at() < windup + STRIKE_WINDUP) {
      const events = a.step(forward);
      if (events.includes('BossRepelLanded') && repelled < 0) repelled = a.at();
      if (events.includes('BossStrikeLanded')) landed = a.at();
    }
    // Толчок сработал, пока слот был В ФАЗЕ, — прежний гейт этого не допускал.
    expect(repelled, 'толчок не сработал за замах').toBeGreaterThan(0);
    expect(repelled).toBeLessThanOrEqual(windup + STRIKE_WINDUP);
    // И замах не оборвался: волна вышла ровно через свои 48 тиков.
    expect(landed).toBe(windup + STRIKE_WINDUP);
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
    Object.values(SLOT_PREFAB).map((prefab) => slotOf(a, slotPrefabField(prefab, 'abilityId')));

  it('пока слот в фазе, второй просьбы не публикуется', () => {
    // Без удержания следующая же готовая способность просилась бы поверх
    // идущего замаха, и штатный `supersede` (ABIL-6) его обрывал бы.
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

  it('толчок в упор удержанием не глушится: он не способность и слота не занимает', () => {
    // Половина смысла системы толчка: она работает поверх любой занятости. Если
    // бы `BossBusy` дотягивалась до неё, пассивка замолкала бы ровно тогда,
    // когда герой подошёл вплотную к занятому кастом боссу. Берётся рёв слэма,
    // а не замах удара: замах закрыт своей проверкой выше, а рёв — вторая, и
    // единственная другая, длинная фаза босса.
    const a = stand([[21, 24]], only('SlotBossSlam'));
    const forward = [{ moveX: FIXED_ONE }];
    const roar = until(a, 'BossSlamRoar', 120, forward);
    let repelled = false;
    let landed = -1;
    while (a.at() < roar + SLAM_ROAR) {
      const events = a.step(forward);
      if (events.includes('BossRepelLanded')) repelled = true;
      if (events.includes('BossSlamLanded')) landed = a.at();
    }
    expect(repelled, 'под рёв слэма толчок не сработал').toBe(true);
    // И рёв дожил до взрыва ровно за свои полторы секунды: толчок его не оборвал.
    expect(landed).toBe(roar + SLAM_ROAR);
  });
});

describe('удар: замах и волна вперёд', () => {
  it('замах длится 800 мс, потом волна — и кулдаун в секунду', () => {
    // Удар в изоляции: поле и призыв стоят в ротации ВЫШЕ него (они реже
    // готовы), и на полной сцене первые полторы секунды босса заняты ими.
    const a = stand([[27, 24]], only('SlotBossStrike'));
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
    const a = stand([[27, 24], [21, 24], [24, 27], [24, 21]], only('SlotBossStrike'));
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
    const away = stand([[27.5, 24]], only('SlotBossStrike'));
    until(away, 'BossStrikeLanded', 200, [{ moveX: FIXED_ONE }]);
    for (let t = 1; t <= WAVE_TICKS + 2; t++) away.step([{ moveX: FIXED_ONE }]);
    expect(hp(away.state, away.heroes[0]!)).toBe(HERO_HP);
    expect(px(away.state, away.heroes[0]!) - px(away.state, away.boss)).toBeGreaterThan(
      STRIKE_REACH,
    );
    // И волна погасла сама, а не застряла в мире.
    expect(tagged(away, 'BossWave')).toHaveLength(0);

    // Тот же стенд без бегства — попадание: разница ровно в дистанции.
    const held = stand([[27.5, 24]], only('SlotBossStrike'));
    until(held, 'BossStrikeLanded', 200);
    for (let t = 1; t <= WAVE_TICKS; t++) held.step();
    expect(hp(held.state, held.heroes[0]!)).toBe(HERO_HP - STRIKE_DAMAGE);
  });
});

describe('слэм: рёв и круговой взрыв', () => {
  it('рёв 1.5 с, взрыв в шесть радиусов тела, 500 урона и отброс', () => {
    // Ближний герой внутри взрыва, дальний — снаружи: радиус проверяется
    // границей, а не фактом попадания. Слэм в изоляции: рёв длинный, и сосед по
    // ротации успел бы отобрать у него ход.
    const a = stand([[26, 24], [28, 24]], only('SlotBossSlam'));
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
    const a = stand([[36, 24]], noRepel(only('SlotBossCharge')));
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
    // цели, то есть в том, дотягивается ли до неё удар или просится разгон:
    // порог ровно один и тот же — досягаемость волны.
    const flat = noRepel(
      bossCollider({ cliffRise: 0 }, bossAt(14, 8, health('Hero', 400000, only('SlotBossCharge')))),
    );
    const near = 8 + STRIKE_REACH / FIXED_ONE - 0.2;
    const far = 8 + STRIKE_REACH / FIXED_ONE + 2;

    const walk = stand([[14, near]], flat);
    for (let t = 1; t <= 400; t++) walk.step();
    expect(py(walk.state, walk.boss)).toBeLessThan(11 * FIXED_ONE);

    const dash = stand([[14, far]], flat);
    for (let t = 1; t <= 400; t++) dash.step();
    expect(py(dash.state, dash.boss)).toBeGreaterThan(11 * FIXED_ONE);
  });

  it('на рывке толчок молчит: 500 за проход не складываются с 200 в упор', () => {
    // Босс проходит СКВОЗЬ тела намеренно (`blockMask` на рывке снят), и плата
    // за этот проход — урон самого рывка. Толчок в упор поверх него был бы
    // вторым счётом за одно и то же движение, поэтому система толчка на рывке
    // молчит. Это НЕ прежний гейт «пока идёт любой каст»: замах удара и рёв
    // слэма толчку не мешают, и держат это две отдельные проверки — «идущий
    // каст толчок НЕ срывает» (замах) и «толчок в упор удержанием не глушится»
    // (рёв слэма) в describe занятости.
    const a = stand([[36, 24]], health('Hero', 400000, only('SlotBossCharge')));
    const hero = a.heroes[0]!;
    until(a, 'BossChargeStarted', 300);

    let dashTicks = 0;
    let repelsOnDash = 0;
    let armedAndClose = 0;
    while (coreWorld.getField(a.state.world, a.boss, 'BossDash', 'ticksLeft') > 0) {
      // Оба входа гейта читаются ДО тика — на нём система толчка и решает.
      // Мало показать, что босс проходил вплотную: молчание объяснялось бы и
      // недоистёкшей паузой `repelUntil`. Считается тик, на котором пауза УЖЕ
      // истекла И жертва в радиусе, — на таком толчок обязан был бы сработать,
      // не будь гейта рывка.
      const armed =
        a.at() >= coreWorld.getField(a.state.world, a.boss, 'BossHunt', 'repelUntil');
      if (armed && distance(a.state, hero, a.boss) <= REPEL_RADIUS) armedAndClose += 1;
      if (a.step().includes('BossRepelLanded')) repelsOnDash += 1;
      dashTicks += 1;
      if (dashTicks > 60) break;
    }
    expect(dashTicks).toBeGreaterThan(0);
    // Контроль: такой тик за рывок был — значит молчал именно гейт рывка.
    expect(armedAndClose, 'за рывок не было ни одного тика «пауза истекла и цель в упор»')
      .toBeGreaterThan(0);
    expect(repelsOnDash).toBe(0);

    // А как только рывок кончился, пассивка снова работает: босс стоит рядом с
    // жертвой, и толчок обязан прилететь.
    let after = -1;
    for (let t = 1; t <= 120 && after < 0; t++) {
      if (a.step().includes('BossRepelLanded')) after = a.at();
    }
    expect(after, 'после рывка толчок так и не сработал').toBeGreaterThan(0);
    expect(coreWorld.getField(a.state.world, a.boss, 'BossDash', 'ticksLeft')).toBe(0);
  });

  it('оставляет полосу огня: 4 с жизни и 100 урона в секунду', () => {
    // Разгон в изоляции: после рывка босс стоит вплотную и герою нечем мешать
    // гореть — иначе тики огня перемешались бы с ударами и отбросами.
    const a = stand([[36, 24]], noRepel(health('Hero', 400000, only('SlotBossCharge'))));
    const started = until(a, 'BossChargeStarted', 300);
    const ended = until(a, 'BossChargeEnded', 100);
    const patches = tagged(a, 'BossFire');
    // Полоса, а не одно пятно: пятно ЧЕРЕЗ тик рывка — по одному на каждый
    // нечётный остаток, последнее в конечной точке (`left == 1`).
    expect(patches.length).toBe(Math.ceil((ended - started + 1) / 2));
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
    ).toBeGreaterThan(FIRE_LIFE - 2 * patches.length - 2);

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

describe('поле замедления: жёлтый купол, гасящий время', () => {
  /** Множитель времени сущности (TIME-2); без компонента — обычный темп. */
  const timeScale = (a: Stand, entity: EntityId): number =>
    coreWorld.hasComponent(a.state.world, entity, 'TimeScale')
      ? coreWorld.getField(a.state.world, entity, 'TimeScale', 'value')
      : FIXED_ONE;

  it('гасит время героя ПЛАВНО: с единицы до 0.2 за четыре секунды, дальше держит', () => {
    // Толчок заперт: он уносит жертву на пять единиц, то есть за край поля, —
    // а предмет проверки здесь спад, а не пассивка.
    const a = stand([[26, 24]], noRepel(only('SlotBossField')));
    const hero = a.heroes[0]!;
    const cast = until(a, 'BossFieldCast', 60);
    expect(tagged(a, 'BossField')).toHaveLength(1);

    const trace: number[] = [];
    for (let t = 1; t <= FIELD_RAMP + 240; t++) {
      a.step();
      trace.push(timeScale(a, hero));
    }
    // Спад монотонный — ни ступеньки вверх.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!, `тик ${i}`).toBeLessThanOrEqual(trace[i - 1]!);
    }
    // И он именно ПЛАВНЫЙ, а не «через четыре секунды вдруг 0.2»: за окно спада
    // множитель принимает сотни разных значений, а не два.
    const distinct = new Set(trace.slice(0, FIELD_RAMP));
    expect(distinct.size).toBeGreaterThan(100);
    // Середина окна — строго между единицей и полом: ни там, ни там.
    const middle = trace[FIELD_RAMP / 2]!;
    expect(middle).toBeLessThan(FIXED_ONE);
    expect(middle).toBeGreaterThan(FIELD_FLOOR);
    // К концу окна — ровно объявленные 0.2, и дальше они держатся.
    expect(trace[FIELD_RAMP + 2]).toBe(FIELD_FLOOR);
    expect(trace[trace.length - 1]).toBe(FIELD_FLOOR);
    // Контроль: герой всё это время внутри поля, иначе мерился бы выход из него.
    const field = tagged(a, 'BossField')[0]!;
    expect(distance(a.state, hero, field)).toBeLessThan(FIELD_RADIUS);
    expect(cast).toBeGreaterThan(0);
  });

  it('отсчёт спада — у каждой жертвы свой: вошедший позже получает свои 4 секунды', () => {
    // Спад описан ОТ ВХОДА жертвы, а не от рождения зоны: подошедший на пятой
    // секунде обязан получить свои четыре секунды спада, а не готовые 0.2.
    // Отсчёт живёт меткой `Chilled` на самой жертве — общий на всех множитель
    // зоны выражал бы ровно ту ошибку, которую эта проверка и ловит.
    const a = stand([[26, 24], [31, 24]], noRepel(only('SlotBossField')));
    const early = a.heroes[0]!;
    const late = a.heroes[1]!;
    until(a, 'BossFieldCast', 60);
    const field = tagged(a, 'BossField')[0]!;

    // Первый простоял всё окно и лежит на полу; второй ещё снаружи.
    for (let t = 1; t <= FIELD_RAMP + 20; t++) a.step();
    expect(timeScale(a, early)).toBe(FIELD_FLOOR);
    expect(timeScale(a, late)).toBe(FIXED_ONE);
    expect(distance(a.state, late, field)).toBeGreaterThan(FIELD_RADIUS);
    expect(coreWorld.hasComponent(a.state.world, late, 'Chilled')).toBe(false);

    // Второй заходит внутрь — и начинает С ЕДИНИЦЫ.
    const walk = [{}, { moveX: -FIXED_ONE }];
    let entered = -1;
    for (let t = 1; t <= 200 && entered < 0; t++) {
      a.step(walk);
      if (timeScale(a, late) < FIXED_ONE) entered = a.at();
    }
    expect(entered, 'второй так и не вошёл в поле').toBeGreaterThan(0);
    expect(coreWorld.hasComponent(a.state.world, late, 'Chilled')).toBe(true);
    // Первый тик внутри — почти не замедлен: пол ему ещё далеко.
    expect(timeScale(a, late)).toBeGreaterThan((FIXED_ONE + FIELD_FLOOR) / 2);
    // А первый всё это время лежит на полу: чужой отсчёт его не сдвинул.
    expect(timeScale(a, early)).toBe(FIELD_FLOOR);

    // И за своё окно второй доходит до того же пола.
    for (let t = 1; t <= FIELD_RAMP + 4; t++) a.step(walk);
    expect(timeScale(a, late)).toBe(FIELD_FLOOR);
    expect(timeScale(a, early)).toBe(FIELD_FLOOR);
  });

  it('вышел и вернулся — отсчёт начинается заново, а не продолжается', () => {
    // Решение, которого дизайнер не называл: возврат в поле — то же состояние
    // «только что вошёл». Память о прошлом пребывании была бы вторым, никем не
    // заказанным механизмом, и потребовала бы своего правила забывания.
    const a = stand([[31, 24]], noRepel(only('SlotBossField')));
    const hero = a.heroes[0]!;
    until(a, 'BossFieldCast', 60);
    const inward = [{ moveX: -FIXED_ONE }];
    const outward = [{ moveX: FIXED_ONE }];

    let entered = -1;
    for (let t = 1; t <= 200 && entered < 0; t++) {
      a.step(inward);
      if (timeScale(a, hero) < FIXED_ONE) entered = a.at();
    }
    expect(entered).toBeGreaterThan(0);
    // Полокна внутри — множитель заметно ниже единицы, но выше пола.
    for (let t = 1; t <= FIELD_RAMP / 2; t++) a.step(inward);
    const middle = timeScale(a, hero);
    expect(middle).toBeLessThan(FIXED_ONE);
    expect(middle).toBeGreaterThan(FIELD_FLOOR);

    // Выходит: метка и источник снимаются вместе.
    let left = -1;
    for (let t = 1; t <= 300 && left < 0; t++) {
      a.step(outward);
      if (timeScale(a, hero) === FIXED_ONE) left = a.at();
    }
    expect(left, 'герой так и не вышел из поля').toBeGreaterThan(0);
    expect(coreWorld.hasComponent(a.state.world, hero, 'Chilled')).toBe(false);

    // Возвращается — и первый же тик внутри снова почти не замедлен: половина
    // окна, накопленная до выхода, не сохранилась.
    let again = -1;
    for (let t = 1; t <= 300 && again < 0; t++) {
      a.step(inward);
      if (timeScale(a, hero) < FIXED_ONE) again = a.at();
    }
    expect(again, 'герой не вернулся в поле').toBeGreaterThan(0);
    expect(timeScale(a, hero)).toBeGreaterThan(middle);
    expect(timeScale(a, hero)).toBeGreaterThan((FIXED_ONE + FIELD_FLOOR) / 2);
  });

  it('гаснет через 12 секунд и снимает своё замедление', () => {
    const a = stand([[26, 24]], noRepel(only('SlotBossField')));
    const hero = a.heroes[0]!;
    const cast = until(a, 'BossFieldCast', 60);
    for (let t = 1; t <= FIELD_RAMP + 10; t++) a.step();
    expect(timeScale(a, hero)).toBe(FIELD_FLOOR);

    const expired = until(a, 'BossFieldExpired', FIELD_LIFE + 20);
    // Минус тик служебный: зона появляется на тике каста, а система
    // длительности (order 810) успевает убавить остаток уже на нём же.
    expect(expired - cast).toBe(FIELD_LIFE - 1);
    expect(tagged(a, 'BossField')).toHaveLength(0);
    // Источник снят: иначе герой остался бы замедленным навсегда — списки
    // источников (TIME-7) сами не рассасываются.
    a.step();
    expect(timeScale(a, hero)).toBe(FIXED_ONE);
  });

  it('замедляет и снаряды — по СВОЕМУ, короткому окну, а самого босса не трогает', () => {
    // Двое по краям поля: босс подходит к одному вплотную, и выстрел ВТОРОГО
    // летит через всё поле. Стенд с одним героем мерил бы не то — снаряд, разо-
    // рвавшийся о босса в тот же тик, замедляться просто не успевает.
    // Призыв разрешён рядом с полем НАМЕРЕННО: скелет — единственный носитель
    // списка источников, который аура обязана НЕ выбрать. Мерить это на самом
    // боссе нечем: списка он не несёт вовсе, и `TimeScale` ему не появился бы,
    // какие бы теги в запросах ауры ни стояли.
    const a = stand([[20, 24], [28, 24]], noRepel(only('SlotBossField', 'SlotBossSpawn')));
    until(a, 'BossFieldCast', 60);
    const field = tagged(a, 'BossField')[0]!;

    // Скелеты встают в полутора единицах перед боссом, то есть внутри его же
    // поля. Проверка делается СРАЗУ: они быстрее героя и за жертвой уходят.
    until(a, 'BossSpawned', 200);
    for (let t = 1; t <= 5; t++) a.step();
    const inside = tagged(a, 'BossMinion').filter(
      (minion) => distance(a.state, minion, field) <= FIELD_RADIUS,
    );
    expect(inside.length, 'ни одного скелета внутри поля — проверять нечего').toBeGreaterThan(0);
    for (const minion of inside) {
      expect(coreWorld.hasComponent(a.state.world, minion, 'TimeScaleModifiers')).toBe(true);
      expect(coreWorld.hasComponent(a.state.world, minion, 'Chilled')).toBe(false);
      expect(timeScale(a, minion)).toBe(FIXED_ONE);
    }
    // И сам босс списка источников не несёт вовсе — второй, независимый повод
    // тому, что аура его не трогает.
    expect(coreWorld.hasComponent(a.state.world, a.boss, 'TimeScaleModifiers')).toBe(false);

    // Поле к этому моменту заведомо старше ГЕРОЙСКОГО окна спада: если бы
    // отсчёт был общий на всех, влетевший сейчас снаряд получил бы пол сразу.
    for (let t = 1; t <= FIELD_RAMP + 10; t++) a.step();

    /** Сколько тиков снаряд уже внутри поля — по его собственной метке входа. */
    const residency = (ball: EntityId): number =>
      coreWorld.hasComponent(a.state.world, ball, 'Chilled')
        ? a.at() - coreWorld.getField(a.state.world, ball, 'Chilled', 'sinceTick')
        : -1;

    let fresh = 0;
    let settled = 0;
    let longest = -1;
    for (let t = 1; t <= 150; t++) {
      const fire = t % 30 === 1 ? CAST : 0;
      a.step([{ buttons: fire }, { buttons: fire }]);
      for (const ball of tagged(a, 'Fireball')) {
        const inField = residency(ball);
        longest = Math.max(longest, inField);
        if (inField < 0) continue;
        // Первый тик внутри — множитель ещё нетронутый: спад считается от
        // ВХОДА снаряда, и старость поля ему не передаётся.
        if (inField === 0) {
          expect(timeScale(a, ball), 'снаряд получил пол в тик входа').toBe(FIXED_ONE);
          fresh += 1;
        }
        // За своим окном — РОВНО пол, без допусков: окно короткое именно затем,
        // чтобы снаряд успевал до него дожить. Единица сверху служебная —
        // `TimeScaleSystem` (−900) видит источник, поставленный аурой (−790), с
        // отставанием в тик.
        if (inField > FIELD_PROJECTILE_RAMP) {
          expect(timeScale(a, ball), `снаряд ${ball} на ${inField}-м тике внутри`).toBe(
            FIELD_FLOOR,
          );
          settled += 1;
        }
      }
    }
    // Контроль обеих половин: снаряды и влетали свежими, и доживали до пола.
    expect(fresh, 'ни один снаряд не был замечен в тик входа').toBeGreaterThan(0);
    expect(settled, 'ни один снаряд не дожил до своего пола').toBeGreaterThan(0);
    expect(longest).toBeGreaterThan(FIELD_PROJECTILE_RAMP);
    // И окно снаряда СТРОГО короче геройского — иначе «замедляет снаряды»
    // выродилось бы в проценты: снаряд живёт пятьдесят тиков и в поле проводит
    // единицы, а геройское окно — четыре секунды.
    expect(FIELD_PROJECTILE_RAMP).toBeLessThan(FIELD_RAMP);
    expect(numbers(abilityDef('bossFieldAura'))).toEqual(
      expect.arrayContaining([FIELD_RAMP, FIELD_PROJECTILE_RAMP]),
    );
  });

  it('поле кастуется, только когда цели есть до чего мешать', () => {
    // Дальняя цель — за краем поля: ось дистанции обнулена, и босс идёт
    // сближаться, а не тратит двадцатисекундный кулдаун в пустоту. Меряется САМ
    // каст: сигналов готовности в сцене больше нет, документ спрашивает
    // готовность у платформы сам (NPC-7).
    const far = stand([[38, 24]], noRepel(only('SlotBossField')));
    for (let t = 1; t <= 30; t++) {
      expect(far.step(), `тик ${t}`).not.toContain('BossField');
      expect(distance(far.state, far.heroes[0]!, far.boss)).toBeGreaterThan(FIELD_RADIUS);
    }
    // Тот же стенд вблизи — каст есть: разница ровно в дистанции.
    const near = stand([[26, 24]], noRepel(only('SlotBossField')));
    expect(until(near, 'BossFieldCast', 30)).toBeGreaterThan(0);
    // И порог оси — РОВНО радиус поля: рисовать зону там, куда она не дотянется,
    // значило бы учить игрока не тому.
    expect(Math.abs(axisReach('BossField') - FIELD_RADIUS)).toBeLessThan(FIXED_ONE / 100);
  });

  /**
   * Потребитель-доказательство REND-38 на настоящем контенте: замедление,
   * которое кладёт аура сцены, обязано доехать до кадра и повести часы
   * презентации героя. Пока этого не было, картинка врала о состоянии мира —
   * герой двигался в пятую часть темпа и перебирал ногами в полный.
   */
  it('замедление доезжает до кадра и ведёт часы презентации героя (REND-38)', () => {
    const a = stand([[26, 24]], noRepel(only('SlotBossField')), MATCH.seed, { extract: true });
    const hero = a.heroes[0]!;
    until(a, 'BossFieldCast', 60);
    for (let t = 1; t <= FIELD_RAMP + 20; t++) a.step();
    expect(timeScale(a, hero)).toBe(FIELD_FLOOR);

    // Доставка несёт ровно ту же величину, переведённую во float на входной
    // границе рендера (REND-1): 13107 / 65536 ≈ 0.2.
    const delivered = a.view().entities.get(hero)!;
    expect(delivered.timeScale).toBeCloseTo(FIELD_FLOOR / FIXED_ONE, 5);
    // У босса шкалы нет вовсе — его собственное поле его не трогает: он идёт
    // множителем 1, а не нулём несуществующего компонента (TIME-3).
    expect(a.view().entities.get(a.boss)!.timeScale).toBe(1);

    // И носитель воспроизведения (REND-20), ведомый этой величиной, проходит за
    // секунду кадров ровно пятую часть клипа. Клип здесь синтетический —
    // предмет проверки темп, а не разбор MDX: трек ведёт `b0.position.z` от
    // нуля к единице ровно за секунду, поэтому z и есть пройденная фаза.
    const root = new THREE.Group();
    const bone = new THREE.Object3D();
    bone.name = 'b0';
    root.add(bone);
    const clip = new THREE.AnimationClip('Run', 1, [
      new THREE.VectorKeyframeTrack('b0.position', [0, 1], [0, 0, 0, 0, 0, 1]),
    ]);
    const backend = new MixerAnimationBackend(new THREE.AnimationMixer(root), [clip]);
    backend.playLoop(0, 0);
    for (let i = 0; i < 60; i++) backend.update(1 / 60, delivered.timeScale);
    expect(bone.position.z).toBeCloseTo(0.2, 2);
  });
});

describe('призыв: три скелета перед боссом', () => {
  const minions = (a: Stand): readonly EntityId[] => tagged(a, 'BossMinion');

  it('рёв 1.5 с — и трое встают ПЕРЕД боссом, по его прицелу', () => {
    const a = stand([[30, 24]], noRepel(only('SlotBossSpawn')));
    const roar = until(a, 'BossSpawnRoar', 30);
    expect(minions(a)).toHaveLength(0);
    const born = until(a, 'BossSpawned', SPAWN_ROAR + 10);
    expect(born - roar).toBe(SPAWN_ROAR);
    expect(minions(a)).toHaveLength(MINION_COUNT);

    const aimX = coreWorld.getField(a.state.world, a.boss, 'BossAim', 'dirX');
    const aimY = coreWorld.getField(a.state.world, a.boss, 'BossAim', 'dirY');
    for (const minion of minions(a)) {
      const dx = px(a.state, minion) - px(a.state, a.boss);
      const dy = py(a.state, minion) - py(a.state, a.boss);
      // «Перед боссом» — проекция на прицел строго положительна.
      expect((dx * aimX + dy * aimY) / FIXED_ONE).toBeGreaterThan(0);
      // И не внутри его тела: они стоят снаружи, а не в кастере.
      expect(Math.hypot(dx, dy)).toBeGreaterThan(BOSS_RADIUS + MINION_RADIUS);
    }
  });

  it('трое — это трое: расходятся телами, а не сливаются в одну точку', () => {
    // Без локального расхождения (NPC-6) все трое сходятся на одной окружности
    // `ranges.attack` вокруг жертвы и встают друг в друге: маска блокировки у
    // них своего слоя не несёт, и растолкать их нечему. На экране это ОДИН
    // скелет, и «спаунит скелетов» перестаёт читаться.
    //
    // Проверяется НЕ «тела не пересекаются никогда»: вес расхождения — половина
    // веса сближения (NPC-6), поэтому на подходе к жертве соседи иногда слегка
    // задевают друг друга, и это структурное свойство настройки, а не сбой.
    // Пиннится то, что действительно держится всё окно: пачка не схлопывается —
    // центры не сходятся ближе полутора радиусов тела. Замер: без расхождения
    // минимум по парам 0.0036 единицы, с ним — 0.34.
    const a = stand([[30, 24]], noRepel(health('Hero', 400000, only('SlotBossSpawn'))));
    until(a, 'BossSpawned', 200);
    let closest = Number.POSITIVE_INFINITY;
    let samples = 0;
    for (let t = 1; t <= 400; t++) {
      a.step();
      const live = minions(a);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          closest = Math.min(closest, distance(a.state, live[i]!, live[j]!));
          samples += 1;
        }
      }
    }
    // Контроль: пары вообще были, иначе минимум остался бы бесконечностью.
    expect(samples).toBeGreaterThan(100);
    expect(closest, `ближайшая пара за окно: ${(closest / FIXED_ONE).toFixed(4)}`).toBeGreaterThan(
      1.5 * MINION_RADIUS,
    );
    const alive = minions(a);
    expect(alive).toHaveLength(MINION_COUNT);
    // И расхождение — политика ДОКУМЕНТА, а не случайность расстановки: обе
    // ручки NPC-6 включены, и любая из них, сброшенная в ноль, гасит механизм
    // целиком (`NpcMovementSystem.separation` выходит по первому же нулю).
    const doc = (SCENE as unknown as {
      npc: { behaviors: readonly { name: string; separationWeight?: number; ranges: { separation: number } }[] };
    }).npc.behaviors.find((entry) => entry.name === 'arenaMinion')!;
    expect(doc.ranges.separation).toBeGreaterThan(2 * MINION_RADIUS);
    expect(doc.separationWeight).toBeGreaterThan(0);
  });

  it('идут за той же жертвой, что и хозяин — и после того, как он её сменил', () => {
    // Ловушка платформы: `chooseTarget` (NPC-5) переписывает `NpcAgent.target`
    // каждый тик, поэтому одноразовой записи при спавне не хватило бы —
    // система сцены переписывает цель ПОСЛЕ поведения, каждый тик.
    const a = stand([[30, 24], [18, 24]], noRepel(only('SlotBossSpawn')));
    until(a, 'BossSpawned', 200);
    const hunted = (): EntityId => coreWorld.getField(a.state.world, a.boss, 'BossHunt', 'hunted');
    const first = hunted();
    for (let t = 1; t <= 30; t++) a.step();
    for (const minion of minions(a)) {
      expect(coreWorld.getField(a.state.world, minion, 'NpcAgent', 'target')).toBe(hunted());
    }
    // Смена жертвы: окно охоты истекает, и скелеты обязаны переехать вместе с
    // хозяином, а не остаться на прежней цели.
    let switched = -1;
    for (let t = 1; t <= HUNT_TICKS + 60 && switched < 0; t++) {
      a.step();
      if (hunted() !== first) switched = a.at();
    }
    expect(switched, 'босс так и не сменил цель').toBeGreaterThan(0);
    const alive = minions(a);
    expect(alive.length).toBeGreaterThan(0);
    for (const minion of alive) {
      expect(coreWorld.getField(a.state.world, minion, 'NpcAgent', 'target')).toBe(hunted());
    }
  });

  it('догоняют убегающего: героическим шагом не догнали бы', () => {
    // Убегающий бот не бежит по прямой — он забирает по дуге, и стенд повторяет
    // ровно это. Меряется РАЗНИЦА между двумя прогонами, отличающимися одним
    // числом документа: со своим шагом скелеты держатся в зоне укуса заметную
    // долю жизни, с героическим — тащатся позади. Абсолютный порог тут сказал бы
    // мало: он зависел бы от того, куда бота занесло.
    //
    // Считается ВРЕМЯ В ЗОНЕ, а не сами укусы: кулдаун укуса в секунду грубо
    // квантует их число, и на коротком окне два разных шага дают одинаковый
    // счёт при вдвое разной близости.
    const chase = (speed: number): { reach: number; ticks: number; bites: number } => {
      const a = stand(
        [[30, 24]],
        minionSpeed(speed, noRepel(health('Hero', 400000, only('SlotBossSpawn')))),
      );
      const hero = a.heroes[0]!;
      until(a, 'BossSpawned', 200);
      let reach = 0;
      let ticks = 0;
      let bites = 0;
      for (let t = 1; t <= 900; t++) {
        // Бег по дуге вокруг центра арены: за край он так не выйдет.
        const angle = (t / 300) * Math.PI * 2;
        a.step([
          {
            moveX: Math.round(Math.cos(angle) * FIXED_ONE),
            moveY: Math.round(Math.sin(angle) * FIXED_ONE),
          },
        ]);
        for (const event of a.last.events) {
          if (event.type !== 'Damage') continue;
          if (event.data.entity !== hero) continue;
          if (event.data.amount === MINION_MELEE) bites += 1;
        }
        for (const minion of minions(a)) {
          ticks += 1;
          if (distance(a.state, minion, hero) <= MINION_REACH) reach += 1;
        }
      }
      return { reach, ticks, bites };
    };
    const own = chase(MINION_SPEED);
    const parity = chase(HERO_SPEED);
    // Контроль: скелеты в мире были, иначе делилось бы на ноль.
    expect(own.ticks).toBeGreaterThan(0);
    expect(parity.ticks).toBeGreaterThan(0);
    // Своим шагом они ДЕРЖАТСЯ на убегающем, а не отстают.
    expect(own.reach / own.ticks).toBeGreaterThan(0.1);
    // И это заслуга ШАГА: с героическим — в разы меньше.
    expect(own.reach / own.ticks).toBeGreaterThan((2 * parity.reach) / parity.ticks);
    // Укусы при этом повторяются, а не случаются раз в минуту.
    expect(own.bites).toBeGreaterThan(1);
  });

  it('в контакте грызут по 50 раз в секунду', () => {
    const a = stand([[30, 24]], noRepel(only('SlotBossSpawn', 'SlotBossStrike')));
    const hero = a.heroes[0]!;
    until(a, 'BossSpawned', 200);
    const bites = new Map<EntityId, number[]>();
    for (let t = 1; t <= 400; t++) {
      a.step();
      for (const event of a.last.events) {
        if (event.type !== 'Damage') continue;
        if (event.data.entity !== hero) continue;
        if (event.data.amount !== MINION_MELEE) continue;
        const source = event.data.source!;
        expect(coreWorld.hasTag(a.state.world, source, 'BossMinion')).toBe(true);
        bites.set(source, [...(bites.get(source) ?? []), a.at()]);
      }
    }
    expect(bites.size).toBeGreaterThan(0);
    let periodic = 0;
    for (const ticks of bites.values()) {
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]! - ticks[i - 1]!).toBe(MINION_MELEE_CD);
        periodic += 1;
      }
    }
    // Контроль: мерился ПЕРИОД, а не единственный укус.
    expect(periodic).toBeGreaterThan(0);
  });

  it('живёт десять секунд и уходит взрывом на 200', () => {
    // Скелеты всё это время висят на герое, поэтому истечение срока проверяется
    // не только событием: взрыв обязан снять с него свои двести — по одному
    // разу на каждого. Запас hp герою поднят: предмет проверки ВЗРЫВ, а не то,
    // сколько он проживёт под тремя скелетами.
    const a = stand([[30, 24]], noRepel(health('Hero', 400000, only('SlotBossSpawn'))));
    const hero = a.heroes[0]!;
    const born = until(a, 'BossSpawned', 200);
    const bursts: number[] = [];
    let blasted = 0;
    for (let t = 1; t <= MINION_LIFE + 30; t++) {
      a.step();
      for (const event of a.last.events) {
        if (event.type === 'BossMinionBurst') bursts.push(a.at());
        if (
          event.type === 'Damage' &&
          event.data.entity === hero &&
          event.data.amount === MINION_BURST
        ) {
          blasted += 1;
        }
      }
    }
    expect(bursts).toHaveLength(MINION_COUNT);
    for (const at of bursts) expect(at - born).toBe(MINION_LIFE);
    expect(blasted).toBe(MINION_COUNT);
    expect(tagged(a, 'BossMinion')).toHaveLength(0);
  });

  it('заряженный фаербол снимает скелета с одного попадания, и тот взрывается на 200', () => {
    // Скелет ЛОВИТ снаряд (его слой в маске снаряда) и умирает — но теперь от
    // ЗАРЯЖЕННОГО: пятьсот hp против двухсот базовых он переживает, поэтому
    // герой держит кнопку, а не щёлкает. Взрыв на смерти — вторая ветка того же
    // исхода, что и истечение срока, и стреляет герой в упор именно ради неё:
    // убитый вплотную скелет обязан достать взрывом того, кто его добил.
    const a = stand([[30, 24]], noRepel(health('Hero', 400000, only('SlotBossSpawn'))));
    const hero = a.heroes[0]!;
    until(a, 'BossSpawned', 200);
    const before = tagged(a, 'BossMinion').length;
    expect(before).toBe(MINION_COUNT);

    // Заряд копится, пока скелет идёт, и отпускается, когда тот уже в зоне
    // собственного взрыва: иначе снаряд снял бы его на подходе, и по герою бить
    // было бы нечему. Окно заряда — 60 тиков, дольше держать бессмысленно.
    let killed = -1;
    let burst = -1;
    let hurt = -1;
    let held = 0;
    for (let t = 1; t <= 900 && burst < 0; t++) {
      const close = tagged(a, 'BossMinion').some(
        (minion) => distance(a.state, minion, hero) <= MINION_BURST_RADIUS,
      );
      // Держим, пока не набрали полный заряд; отпускаем, когда цель в упор.
      const charging = killed < 0 && (held < CHARGE_TICKS || !close);
      const press = charging && held < CHARGE_TICKS;
      if (press) held += 1;
      else held = 0;
      const hpBefore = hp(a.state, hero);
      a.step([{ buttons: press ? CAST : 0 }]);
      for (const event of a.last.events) {
        if (
          event.type === 'EntityDied' &&
          killed < 0 &&
          coreWorld.hasTag(a.state.world, event.data.entity!, 'BossMinion')
        ) {
          killed = a.at();
        }
        if (event.type === 'BossMinionBurst' && killed > 0) burst = a.at();
        if (
          event.type === 'Damage' &&
          event.data.entity === hero &&
          event.data.amount === MINION_BURST
        ) {
          hurt = hpBefore - hp(a.state, hero);
        }
      }
    }
    expect(killed, 'скелет не погиб от снаряда').toBeGreaterThan(0);
    // Взрыв — на СЛЕДУЮЩЕМ тике после смерти: урон обязан успеть к системе
    // применения (order 320), а система смерти стоит позже неё (322).
    expect(burst).toBe(killed + 1);
    expect(tagged(a, 'BossMinion').length).toBeLessThan(before);
    // И добивший получил свои двести: он стоял в зоне взрыва — за тем скелет
    // к нему и шёл.
    expect(hurt).toBeGreaterThanOrEqual(MINION_BURST);
  });

  it('купол героя гасит время скелетам', () => {
    const a = stand([[30, 24]], noRepel(only('SlotBossSpawn')));
    until(a, 'BossSpawned', 200);
    // Ждём, пока скелеты подойдут, и ставим купол под ноги.
    for (let t = 1; t <= 90; t++) a.step();
    a.step([{ buttons: 1 << ACTION_BITS.slowDome }]);
    expect(tagged(a, 'SlowDome')).toHaveLength(1);
    const dome = tagged(a, 'SlowDome')[0]!;
    let slowed = 0;
    for (let t = 1; t <= 10; t++) {
      a.step();
      for (const minion of tagged(a, 'BossMinion')) {
        if (distance(a.state, minion, dome) > DOME_RADIUS) continue;
        if (!coreWorld.hasComponent(a.state.world, minion, 'TimeScale')) continue;
        if (coreWorld.getField(a.state.world, minion, 'TimeScale', 'value') < FIXED_ONE) slowed += 1;
      }
    }
    expect(slowed, 'ни один скелет под куполом не замедлился').toBeGreaterThan(0);
  });
});

describe('босс, арена и собственная шкура', () => {
  it('всходит на плато: допуск подъёма против нулевого', () => {
    // Единственная разница между прогонами — `Collider.cliffRise` босса: с
    // допуском в один уровень он вступает на плато ровно там же, где герой
    // запрыгивает (PHYS-11), без допуска — упирается в обрыв. Способности
    // заперты: предмет проверки — ШАГ, и разгон сквозь обрыв (своя проверка
    // выше) здесь только мешал бы.
    const scene = only();
    const walkable = bossAt(14, 8, health('Hero', 400000, scene));
    const climbs = stand([[14, 12.5]], walkable);
    for (let t = 1; t <= 400; t++) climbs.step();
    expect(py(climbs.state, climbs.boss)).toBeGreaterThan(11 * FIXED_ONE);

    const stalls = stand([[14, 12.5]], bossCollider({ cliffRise: 0 }, walkable));
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
    // по «Windup» проверял бы одну способность из пяти.
    const frozen = { x: px(a.state, a.boss), y: py(a.state, a.boss) };
    const strike = slotOf(a, ABILITY_STRIKE);
    const asked: string[] = [];
    let strikeReady = false;
    for (let t = 1; t <= 200; t++) {
      for (const type of a.step()) {
        if (type === 'BossStrike' || type === 'BossSlam' || type === 'BossField') asked.push(type);
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
    // падающего), ближе своих порогов цель не становится, а за ними оси удара,
    // слэма и поля — ноль (NPC-3).
    //
    // Контроль ровно на это: удар внутри окна БЫЛ готов, то есть молчал он не
    // кулдауном. Слэму и полю такого контроля не поставить — их откаты (360 и
    // 1200 тиков) переживают весь полёт героя, — но пара доказывается
    // включением: пороги слэма (3.6) и поля (4.5) лежат по обе стороны порога
    // удара (4.0), и цель, недостижимая для него, недостижима и для них.
    expect(strikeReady).toBe(true);
    // Разгон и призыв в список не входят НАМЕРЕННО: ось разгона растёт с
    // расстоянием, то есть далёкая цель его как раз поощряет, а порог призыва
    // (12 единиц) шире всех прочих. Отказаться от падающей цели документ не
    // может вовсе: про полёт закрытый словарь входов не знает и знать не обязан
    // — у платформы «цель» это живая сущность, и падающий ею остаётся (NPC-5).
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
    // Способности запаркованы, толчок заперт: предмет проверки — ТЕЛО босса, а
    // не пассивка. Толчок радиальный и срабатывает за полторы единицы до
    // контакта — с ним герой до тела просто не дошёл бы.
    const a = stand([[21, 24]], noRepel(only()));
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
    for (let t = 0; t < REPEL_INTERVAL + 60; t++) {
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
    for (let t = 1; t <= 900; t++) {
      for (const type of a.step()) seen.add(type);
      expect(hp(a.state, a.boss)).toBe(BOSS_HP);
    }
    // Контроль: за прогон отработали все пять активных способностей и пассивка
    // — иначе «себя не задевает» проверялось бы на том, чего не случилось.
    expect(seen).toContain('BossStrikeLanded');
    expect(seen).toContain('BossSlamLanded');
    expect(seen).toContain('BossChargeStarted');
    expect(seen).toContain('BossFieldCast');
    expect(seen).toContain('BossSpawned');
    expect(seen).toContain('BossRepelLanded');
    // Скелеты — тоже «свои»: ни их удар, ни их взрыв босса не касаются.
    expect(seen).toContain('BossMinionBurst');
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
    for (const id of ['bossSlam', 'bossFireAura', 'bossMinionMelee']) walk(abilityDef(id));
    for (const name of ['BossDashDrive', 'BossRepel', 'MinionEnd']) walk(systemDef(name));
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
    // Толчок — СИСТЕМА, а не определение: и урон, и радиус, и отброс, и срок
    // паузы читаются из неё.
    expect(numbers(systemDef('BossRepel'))).toEqual(
      expect.arrayContaining([REPEL_DAMAGE, REPEL_INTERVAL, REPEL_RADIUS, MEDIUM]),
    );
    expect(numbers(abilityDef('bossFireAura'))).toEqual(
      expect.arrayContaining([FIRE_DAMAGE, FIRE_PERIOD, FIRE_RADIUS]),
    );
    // Поле замедления: радиус, жизнь, кулдаун и окно спада — все в определении.
    expect(numbers(abilityDef('bossField'))).toEqual(
      expect.arrayContaining([FIELD_RADIUS, FIELD_LIFE, FIELD_CD, FIELD_MODIFIER_ID]),
    );
    expect(numbers(abilityDef('bossFieldAura'))).toEqual(
      expect.arrayContaining([FIELD_RAMP, FIELD_FLOOR_STEP, FIELD_MODIFIER_ID]),
    );
    // Срока самой зоны в ауре больше нет и быть не должно: она считает спад по
    // метке входа ЖЕРТВЫ, и число 720 в ней означало бы возврат к общему на всех
    // отсчёту.
    expect(numbers(abilityDef('bossFieldAura'))).not.toContain(FIELD_LIFE);
    // Постоянный id источника замедления законен ровно потому, что полей в мире
    // не бывает двух: кулдаун строго длиннее жизни зоны. Сойдутся — два поля
    // начнут переписывать один и тот же слот списка, и снятие одним сняло бы
    // замедление, наложенное другим.
    expect(FIELD_CD).toBeGreaterThan(FIELD_LIFE);
    // Призыв и скелет: рёв, кулдаун, удар в контакт и взрыв на смерти.
    expect(numbers(abilityDef('bossSpawn'))).toEqual(
      expect.arrayContaining([SPAWN_ROAR, SPAWN_CD, MINION_COUNT]),
    );
    expect(numbers(abilityDef('bossMinionMelee'))).toEqual(
      expect.arrayContaining([MINION_MELEE, MINION_MELEE_CD, MINION_REACH]),
    );
    expect(numbers(systemDef('MinionEnd'))).toEqual(
      expect.arrayContaining([MINION_BURST, MINION_BURST_RADIUS, MINION_LIFE]),
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
    expect(numbers(abilityDef('bossSlam'))).toContain(6 * bodyRadius);
    const dashStep = numbers(systemDef('BossDashDrive')).find((value) => value === DASH_SPEED);
    expect(dashStep, 'шаг рывка не найден в BossDashDrive').toBe(DASH_SPEED);
    expect(numbers(abilityDef('bossFireAura'))).toContain(FIRE_RADIUS);
    // Полоса сплошная и без нахлёста ровно тогда, когда пятно ложится через
    // тик, а его радиус равен шагу: центры соседних тогда отстоят на диаметр.
    expect(dashStep).toBe(FIRE_RADIUS);
    // Досягаемость удара и жизнь волны — одно и то же число, посчитанное
    // дважды: ось дистанции обнуляется на нём, волна пролетает его сама.
    expect(Math.abs(axisReach('BossStrike') - STRIKE_REACH)).toBeLessThan(FIXED_ONE / 100);
    expect(WAVE_SPEED * WAVE_TICKS).toBe(STRIKE_REACH);
    // Полтора купола героя — та самая связь, ради которой поле и заведено.
    const dome = SCENE.prefabs!.find((prefab) => prefab.name === 'SlowDome')!;
    const field = SCENE.prefabs!.find((prefab) => prefab.name === 'BossField')!;
    expect((field.components.FieldState as Record<string, number>).radius).toBe(
      ((dome.components.DomeState as Record<string, number>).radius! * 3) / 2,
    );
    // Тело скелета — героическое, делённое на полтора; шаг — героический ровно.
    const minion = SCENE.prefabs!.find((prefab) => prefab.name === 'BossMinion')!;
    const heroPrefab = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
    const heroRadius = (heroPrefab.components.Collider as Record<string, number>).radius!;
    expect((minion.components.Collider as Record<string, number>).radius).toBe(
      Math.floor(heroRadius / 1.5),
    );
    expect((minion.components.Health as Record<string, number>).hp).toBe(MINION_HP);
    // Та же полуторакратность и в КАРТИНКЕ — решение о ЭТОЙ паре видов, а не
    // общее правило манифеста: `scale` записи (ASSET-6) — мировая высота, и с
    // коллайдером её ничто не связывает (у босса они и расходятся: 2.6 / 1.6
    // против 39321 / 19661). Скелет же задуман как герой, уменьшенный в полтора
    // раза, и глазами дизайнер меряет именно это.
    expect(
      MANIFEST.entities.Hero!.scale / MANIFEST.entities.BossMinion!.scale,
    ).toBeCloseTo(heroRadius / MINION_RADIUS, 2);
    expect((minion.components.Collider as Record<string, number>).cliffRise).toBe(BOSS_CLIFF_RISE);
    expect((minion.components.Collider as Record<string, number>).layer).toBe(MINION_LAYER);
    const minionBehavior = (SCENE as unknown as { npc: { behaviors: readonly { name: string; speed: number }[] } })
      .npc.behaviors.find((entry) => entry.name === 'arenaMinion')!;
    // Скорость сверяется С ГЕРОЕМ, а не сама с собой: догоняющий обязан быть
    // быстрее убегающего, иначе преследование не преследование.
    const heroSpeed = (heroPrefab.components.Locomotion as Record<string, number>).maxSpeed!;
    expect(heroSpeed).toBe(HERO_SPEED);
    expect(minionBehavior.speed).toBe(MINION_SPEED);
    expect(minionBehavior.speed).toBeGreaterThan(heroSpeed);
    expect(minionBehavior.speed / heroSpeed).toBeCloseTo(1.3, 2);
    // Скелет ловим снарядом: его слой в маске снаряда, иначе фаербол пролетал
    // бы сквозь него.
    const ball = SCENE.prefabs!.find((prefab) => prefab.name === 'Fireball')!;
    expect((ball.components.Collider as Record<string, number>).hitMask! & MINION_LAYER).toBe(
      MINION_LAYER,
    );
    // Запас скелета лежит МЕЖДУ базовым выстрелом и полностью заряженным — та
    // самая правка, которой отступление от «умирает с одного фаербола» и
    // выражено. Оба числа читаются ИЗ СЦЕНЫ: базовый урон — поле prefab'а
    // снаряда, максимум — тот же урон, помноженный на квадрат предельного
    // множителя заряда определения (`200 × scale²`, ABIL-2).
    const base = (ball.components.Projectile as Record<string, number>).damage!;
    const fireball = numbers(abilityDef('fireball'));
    expect(fireball).toContain(base);
    expect(fireball).toContain(CHARGE_MAX_SCALE);
    expect(fireball).toContain(CHARGE_TICKS);
    const charged = Math.trunc((base * CHARGE_MAX_SCALE * CHARGE_MAX_SCALE) / (FIXED_ONE * FIXED_ONE));
    expect(charged).toBe(800);
    expect(MINION_HP, 'базовый выстрел обязан НЕ убивать').toBeGreaterThan(base);
    expect(MINION_HP, 'заряженный обязан убивать по-прежнему').toBeLessThanOrEqual(charged);
    // И втроём базовых хватает: скелет не становится губкой.
    expect(MINION_HP).toBeLessThanOrEqual(3 * base);
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
    // Каждый запрос, ключуемый платформенным `NpcAgent` или маркером скелета,
    // отбирает СВОЕГО агента тегом: без этого скелет получил бы слоты
    // способностей босса (`GrantBossSlots`), возрождался бы в центре арены
    // (`BossRespawn`) и стоял бы на чужом касте (`BossCastHold`). Проверка
    // механическая: забытый тег виден здесь, а не в бою.
    //
    // Обход идёт по ВСЕМУ дереву системы, а не по её верхнему запросу: тот же
    // промах во вложенном `forEach` стоил бы ровно столько же, а увидеть его
    // было бы негде.
    const unscoped: string[] = [];
    const keyed = (node: unknown, site: string): void => {
      if (Array.isArray(node)) {
        for (const item of node) keyed(item, site);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const query = record as { all?: unknown; withTag?: unknown };
      const all = Array.isArray(query.all) ? (query.all as string[]) : [];
      if (all.includes('NpcAgent') || all.includes('Minion')) {
        if (query.withTag !== 'Boss' && query.withTag !== 'BossMinion') {
          unscoped.push(`${site}: ${JSON.stringify(query.all)} → ${String(query.withTag)}`);
        }
      }
      for (const value of Object.values(record)) keyed(value, site);
    };
    for (const system of SCENE.systems!) keyed(system, system.name);
    expect(unscoped).toEqual([]);
    // Контроль: обход и правда нашёл такие запросы, иначе он проверял бы пустое
    // множество — ровно тот отказ, ради которого он и написан.
    let scoped = 0;
    const counted = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) counted(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as { all?: unknown };
      if (Array.isArray(record.all) && (record.all as string[]).includes('NpcAgent')) scoped += 1;
      for (const value of Object.values(node as Record<string, unknown>)) counted(value);
    };
    for (const system of SCENE.systems!) counted(system);
    expect(scoped).toBeGreaterThanOrEqual(10);
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

  it('приоритет ротации — веса осей: редкое обходит частое', () => {
    // Полезность действия есть ПРОИЗВЕДЕНИЕ оценок его осей (NPC-3), поэтому
    // при готовности и попадании в дистанцию она равна произведению весов. Ими
    // приоритет и выражен: у автомата состояний его выражал порядок переходов,
    // а автомата больше нет.
    //
    // Порядок ровно тот же, каким он был у переходов, и он несущий: удар готов
    // почти всегда (замах 48 тиков на кулдауне 60), и, стой он выше, до поля с
    // призывом очередь не доходила бы вовсе.
    const rotation = bossDoc().states[0]!;
    const utility = (event: string): number =>
      rotation.actions
        .find((entry) => entry.event === event)!
        .considerations.reduce((acc, axis) => (acc * axis.weight) / FIXED_ONE, FIXED_ONE);
    const order = ['BossField', 'BossSpawn', 'BossSlam', 'BossStrike'];
    for (let i = 1; i < order.length; i++) {
      expect(utility(order[i - 1]!), `${order[i - 1]!} против ${order[i]!}`).toBeGreaterThan(
        utility(order[i]!),
      );
    }
    // И любая способность обходит сближение — иначе босс ходил бы, не кастуя.
    const seek = rotation.actions[0]!.considerations.reduce(
      (acc, axis) => (acc * axis.weight) / FIXED_ONE,
      FIXED_ONE,
    );
    for (const event of order) expect(utility(event)).toBeGreaterThan(seek);

    // Кулдауны редких способностей и правда длиннее: иначе «редкое вперёд» было
    // бы не правилом, а произволом.
    const cooldownOf = (slot: string): number =>
      (SCENE.prefabs!.find((prefab) => prefab.name === slot)!.components.AbilityCooldown as Record<
        string,
        number
      >).total!;
    expect(cooldownOf('SlotBossField')).toBeGreaterThan(cooldownOf('SlotBossSpawn'));
    expect(cooldownOf('SlotBossSpawn')).toBeGreaterThan(cooldownOf('SlotBossSlam'));
    expect(cooldownOf('SlotBossSlam')).toBeGreaterThan(cooldownOf('SlotBossStrike'));
  });

  it('дистанционные оси ротации — зеркала порогов боя', () => {
    // Пороги те же, что были у снесённого сенсора, только выражены кривой: ось
    // обнуляется там, где кончается применимость способности. Считается это ИЗ
    // ДОКУМЕНТА (наклон, свободный член и радиус чутья), поэтому ретюн любой из
    // трёх величин виден здесь, а не только в бою.
    const rotation = bossDoc().states[0]!;
    const near = (event: string, reach: number): void => {
      expect(Math.abs(axisReach(event) - reach), event).toBeLessThan(FIXED_ONE / 100);
    };
    // Удар достаёт ровно на длину полёта своей волны.
    near('BossStrike', STRIKE_REACH);
    // Слэм просится вплотную — в радиусе собственного взрыва.
    near('BossSlam', SLAM_RADIUS);
    // Поле — в радиусе самого поля: ставить его туда, где оно никого не
    // накроет, значит потратить двадцатисекундный откат впустую.
    near('BossField', FIELD_RADIUS);
    // Разгон — наоборот, ЗА досягаемостью удара: его ось растёт с расстоянием.
    near('BossCharge', STRIKE_REACH);
    const charge = rotation.actions.find((entry) => entry.event === 'BossCharge')!;
    expect(
      charge.considerations.find((axis) => axis.input === 'targetDistance')!.curve.slope!,
    ).toBeGreaterThan(0);
    // И разгон не просится вслепую: без цели `targetDistance` отвечает «дальше
    // некуда» (NPC-3), и без оси `targetKnown` босс разгонялся бы в пустоту.
    expect(charge.considerations.map((axis) => axis.input)).toContain('targetKnown');
    // Призыв — единственный, чей порог не переиспользует чужой радиус: своей
    // зоны у него нет вовсе, и ось нужна ему только затем, чтобы не звать
    // скелетов по цели, до которой им не дойти за десять секунд жизни.
    near('BossSpawn', SPAWN_REACH);
    expect(SPAWN_REACH).toBeGreaterThan(STRIKE_REACH);
  });

  it('сенсора готовности в сцене нет, а занятость держит отдельная система', () => {
    // Половина утверждения — отрицательная: система, пересказывавшая кулдауны
    // и дистанции событиями `Boss*Ready`, снесена целиком, и вернуться она
    // может только вместе с этими именами.
    expect(SCENE.systems!.map((system) => system.name)).not.toContain('BossReady');
    expect(JSON.stringify(sceneJson)).not.toMatch(/Boss(Slam|Strike|Charge|Field|Spawn)Ready/);

    // Вторая половина — положительная: занятость владельца словарь NPC не
    // видит и видеть не обязан (NPC-7), поэтому её держит сцена — раньше
    // системы поведения (−795), чтобы решение этого же тика её увидело.
    const busy = systemDef('BossBusy');
    expect(busy.order).toBeLessThan(-795);
    // Держатся ровно ротационные слоты: толчок просит своя система со своим
    // гейтом, а ауры пятна огня, поля и скелета принадлежат другим владельцам.
    expect(JSON.stringify(busy)).toContain('slotIndex');
    expect(numbers(busy)).toContain(BOSS_ROTATION_SLOTS - 1);
  });

  it('второй документ — скелет: он только преследует', () => {
    // Цель ему пишет система сцены `MinionTarget`, и пишет ПОСЛЕ системы
    // поведения (−795): та переписывает `NpcAgent.target` каждый тик (NPC-5), и
    // запись раньше неё пропала бы молча.
    const minion = (SCENE as unknown as { npc: { behaviors: readonly BossDoc[] } }).npc.behaviors.find(
      (entry) => entry.name === 'arenaMinion',
    )!;
    expect(minion.states.map((state) => state.name)).toEqual(['chase']);
    expect(minion.states[0]!.actions.map((action) => action.executor)).toEqual(['seekTarget']);
    expect(systemDef('MinionTarget').order).toBeGreaterThan(-795);
    expect(systemDef('MinionTarget').order).toBeLessThan(0);
    // Ротацию скелет не носит: осей готовности у него нет вовсе — способность
    // у него `always`-аура, и просить её некому.
    expect(
      minion.states[0]!.actions.flatMap((action) => action.considerations.map((axis) => axis.input)),
    ).not.toContain('abilityReady');
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
    // Поле замедления — купол по виду, как и купол героя: радиус оболочки равен
    // зоне действия.
    expect(MANIFEST.effects.byKind.BossField!.radius).toBe(FIELD_RADIUS / FIXED_ONE);
    // Пятно огня рисуется ЭМИТТЕРОМ, а не сферой: примитив у манифеста один, и
    // горящую полосу им честно не изобразить. Зона урона поэтому сверяется с
    // собственным радиусом ассета эмиттера — записи-сферы у пятна больше нет.
    expect(MANIFEST.effects.byKind.BossFire).toBeUndefined();
    const emitter = MANIFEST.particles.byKind!.BossFire!.effect;
    expect(emitter).toMatch(/\.effect\.json$/);
    expect(emitterRadius(emitter)).toBe(FIRE_RADIUS / FIXED_ONE);
    // Толчок в упор стал радиальным взрывом — вспышка обязана назвать его радиус.
    expect(MANIFEST.effects.byEvent.BossRepelLanded!.radiusTo).toBe(REPEL_RADIUS / FIXED_ONE);
    // Взрыв скелета — та же связь: вспышка ровно по зоне урона.
    expect(MANIFEST.effects.byEvent.BossMinionBurst!.radiusTo).toBe(
      MINION_BURST_RADIUS / FIXED_ONE,
    );
    // Замахи озвучены частицами, приземления — тряской камеры.
    for (const type of ['BossStrikeWindup', 'BossSlamRoar', 'BossChargeAim']) {
      expect(MANIFEST.particles.byEvent[type]!.effect).toBe(
        MANIFEST.particles.byEvent.CastFireball!.effect,
      );
    }
    // Рёв призыва — исключение, и оно несущее: он длится те же полторы секунды,
    // что рёв слэма, но слэм при этом бьёт на 3.6 единицы и на 500, а призыв не
    // бьёт вовсе. Совпади у них клип и всполох — игрок не отличил бы, от чего
    // отбегать, и телеграф перестал бы быть телеграфом.
    const clips = MANIFEST.entities.Boss!.animations.events;
    expect(clips.BossSpawnRoar).not.toBe(clips.BossSlamRoar);
    expect(MANIFEST.particles.byEvent.BossSpawnRoar!.effect).not.toBe(
      MANIFEST.particles.byEvent.BossSlamRoar!.effect,
    );
    for (const type of [
      'BossStrikeLanded',
      'BossSlamLanded',
      'BossChargeStarted',
      'BossRepelLanded',
      'BossMinionBurst',
    ]) {
      expect(MANIFEST.cameraEffects.events[type]!.effect).toBe('shake');
    }
  });

  it('клипы, названные манифестом, у модели есть', () => {
    // Запись, не совпавшая ни с одним клипом, гасит анимацию молча (REND-4):
    // рендер предупреждает один раз в консоль и рисует позу покоя. Разрешение
    // здесь — то же самое, что у рендера, а не второе правило рядом.
    const bytes = readFileSync(join(CONTENT_ROOT, 'visuals/models/SkeletonBarbarian.mdx'));
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
