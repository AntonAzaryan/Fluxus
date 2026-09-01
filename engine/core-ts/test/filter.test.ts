import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { getField, isAlive, listAlive, setField, spawn, toPlain } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { indexOf as rawIndexOf } from '../src/ecs/entityIndex.js';
import { ARENA_COMPONENT } from '../src/systems/arena.js';
import { FLOOR_COMPONENT } from '../src/systems/terrain.js';
import {
  eventVisibilityByName,
  filterSnapshot,
  relevantEntityVisible,
  VIEWPOINT_ALL,
} from '../src/sim/filter.js';
import { snapshotToPlain } from '../src/sim/serialization.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import {
  teamBit,
  VisibilitySystem,
  DETECTION_SOURCES_COMPONENT,
  STEALTH_SOURCES_COMPONENT,
  VISIBILITY_COMPONENT,
  VISION_MODIFIER_COMPONENT,
} from '../src/systems/visibility.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import { NO_ENTITY } from '../src/types.js';
import type { EntityId, FieldOverrides, ModifierRegistry, Snapshot } from '../src/types.js';

/** Зависимости пересчёта (FOW-3, FOW-12): все каналы жёсткие — как до канальной модели. */
const fowDeps = (modifiers: ModifierRegistry) => ({
  lists: {
    vision: requireModifierList(modifiers, VISION_MODIFIER_COMPONENT),
    stealth: requireModifierList(modifiers, STEALTH_SOURCES_COMPONENT),
    detection: requireModifierList(modifiers, DETECTION_SOURCES_COMPONENT),
  },
  hardStealthMask: ~0,
});

const F = fixed.fromFloat;

const SCENE: SceneDef = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  fog: true,
  // Ровная сетка: туман войны без террейна отвергается загрузчиком (SER-7),
  // потому что фильтру по уровню (FOW-5) не у кого спросить уровень сущности.
  // Предмет этих тестов — отбор снапшота, а не рельеф, поэтому перепада нет.
  terrain: { width: 2, height: 2, tileSize: F(1), levels: ['00', '00'], flags: ['..', '..'] },
  prefabs: [
    {
      name: 'Watcher',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: F(3) },
        Visibility: { visibleTo: 0 },
        Team: { id: 0 },
        StealthSources: {},
      },
    },
    {
      name: 'Enemy',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: F(3) },
        Visibility: { visibleTo: 0 },
        Team: { id: 1 },
        StealthSources: {},
      },
    },
    /** Обстановка без `Visibility`: секретом не является и режется не должна (NET-12). */
    { name: 'Rock', components: { Position: { x: 0, y: 0 } } },
  ],
};

/**
 * Та же сцена с носителем арены (ARENA-1) вдобавок к носителю карты пола
 * (TERR-6), который есть уже у сцены выше. Компонента `Visibility` загрузчик
 * им не выдаёт, и это и есть предмет проверки NET-12: умолчание «публична»
 * держит в снапшоте ровно их.
 */
const SCENE_WITH_CARRIERS: SceneDef = {
  ...SCENE,
  arena: { center: { x: 0, y: 0 }, radius: F(10) },
};

function harness() {
  const { world, systems, modifiers, terrain } = loadScene(SCENE);
  systems.register(new VisibilitySystem(fowDeps(modifiers)));
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers, terrain: terrain! };
  const state = initialState(world, 1);

  return {
    world,
    state,
    place: (prefab: string, overrides?: FieldOverrides) => spawn(world, prefab, overrides),
    step: () => tick(sim, state),
    mask: (entity: EntityId): number => getField(world, entity, VISIBILITY_COMPONENT, 'visibleTo'),
    present: (snapshot: Snapshot, entity: EntityId): boolean => isAlive(snapshot.world, entity),
  };
}

/** Двое врагов вне обзора друг друга: каждый видит только себя (свою команду). */
function apart() {
  const h = harness();
  const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
  const enemy = h.place('Enemy', { Position: { x: F(50), y: F(50) } });
  const rock = h.place('Rock', { Position: { x: F(1), y: F(1) } });
  h.step();
  return { ...h, watcher, enemy, rock };
}

describe('per-client фильтрация снапшота (NET-12)', () => {
  it('невидимая для команды сущность в снапшот не попадает', () => {
    const h = apart();
    expect(h.mask(h.enemy)).toBe(teamBit(1));

    const forTeam0 = filterSnapshot(h.state, 0);
    expect(h.present(forTeam0, h.watcher)).toBe(true);
    expect(h.present(forTeam0, h.enemy)).toBe(false);

    const forTeam1 = filterSnapshot(h.state, 1);
    expect(h.present(forTeam1, h.watcher)).toBe(false);
    expect(h.present(forTeam1, h.enemy)).toBe(true);
  });

  it('видимого врага снапшот сохраняет', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = h.place('Enemy', { Position: { x: F(2), y: F(0) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(true);
    expect(watcher).toBeGreaterThanOrEqual(0);
  });

  it('сущность без Visibility публична для всех', () => {
    const h = apart();
    for (const viewpoint of [0, 1, VIEWPOINT_ALL]) {
      expect(h.present(filterSnapshot(h.state, viewpoint), h.rock)).toBe(true);
    }
  });

  /**
   * NET-12, сценарий «Носители карты пола и арены». Проверяется не обстановка
   * вообще (это тест выше), а ровно те две сущности, потерей которых обратное
   * умолчание было бы фатальным: без них клиент лишается данных, которые
   * оболочка обязана получить до первого кадра (SHELL-5).
   */
  it('носители карты пола и арены остаются во всех персональных снапшотах', () => {
    const { world, systems, terrain, arena, modifiers } = loadScene(SCENE_WITH_CARRIERS);
    systems.register(new VisibilitySystem(fowDeps(modifiers)));
    const sim: Simulation = {
      systems,
      worldSeed: 1,
      math: mathApi,
      modifiers,
      terrain: terrain!,
      arena: arena!,
    };
    const state = initialState(world, 1);
    spawn(world, 'Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = spawn(world, 'Enemy', { Position: { x: F(50), y: F(50) } });
    tick(sim, state);

    const floorCarrier = [...query(world, { all: [FLOOR_COMPONENT] })][0]!;
    const arenaCarrier = [...query(world, { all: [ARENA_COMPONENT] })][0]!;

    for (const viewpoint of [0, 1, VIEWPOINT_ALL]) {
      const personal = filterSnapshot(state, viewpoint);
      expect(isAlive(personal.world, floorCarrier)).toBe(true);
      expect(isAlive(personal.world, arenaCarrier)).toBe(true);
    }
    // Контроль: фильтр в этой сцене работает — невидимый враг из снапшота ушёл,
    // и носители остались не потому, что резать было нечем.
    expect(isAlive(filterSnapshot(state, 0).world, enemy)).toBe(false);
  });

  it('фильтрация не мутирует ни мир, ни исходный снапшот', () => {
    const h = apart();
    const before = takeSnapshot(h.state);
    const alive = [...listAlive(h.world)];

    filterSnapshot(h.state, 0);
    filterSnapshot(before, 0);

    expect([...listAlive(h.world)]).toEqual(alive);
    expect([...listAlive(before.world)]).toEqual(alive);
    expect(snapshotToPlain(takeSnapshot(h.state))).toEqual(snapshotToPlain(before));
  });

  it('ID-4/NET-12: снапшот расходится с каноническим по поколениям и списку свободных слотов', () => {
    const h = apart();
    const canonical = toPlain(h.world);
    expect(canonical.freeList).toEqual([]); // в каноническом мире никто не умирал

    const personal = toPlain(filterSnapshot(h.state, 0).world);

    // Фильтр вырезает невидимое штатным удалением, поэтому слот врага уходит в
    // список свободных, а его поколение растёт — в каноническом мире ни того,
    // ни другого нет. Счётчик слотов при этом общий: удаление его не двигает (ID-2).
    expect(personal.freeList).toEqual([rawIndexOf(h.enemy)]);
    expect(personal.generations).not.toEqual(canonical.generations);
    expect(personal.nextIndex).toBe(canonical.nextIndex);

    // Расхождение расхождением детерминизма не является: вход следующего тика —
    // канонический мир, и он остался нетронутым (ID-4, NET-12).
    expect(toPlain(h.world)).toEqual(canonical);
  });

  /**
   * NET-12, обоснование («скрыть только в рендере = wallhack/ESP») и NET-18: в
   * проекцию входят данные ECS только уцелевших сущностей. Штатное удаление
   * гасит живость, маску и теги, но SoA-ячейки хранят прошлое сущности, а
   * plain-форма сериализует массивы полей до `nextIndex` независимо от живости
   * — без затирания позиция и статы скрытого врага читались бы модифицированным
   * клиентом прямо из кадра на проводе.
   */
  it('данных скрытой сущности в plain-форме персонального снапшота нет физически (NET-12, NET-18)', () => {
    const scene: SceneDef = {
      ...SCENE,
      // `entity`-поле — отдельный тип со своим нейтральным значением (ECS-6):
      // проверяется, что затирание идёт по типу поля, а не нулём для всех.
      components: [...SCENE.components, { name: 'Link', fields: { other: 'entity' } }],
      prefabs: [
        SCENE.prefabs![0]!,
        {
          ...SCENE.prefabs![1]!,
          components: { ...SCENE.prefabs![1]!.components, Link: { other: NO_ENTITY } },
        },
        SCENE.prefabs![2]!,
      ],
    };
    const { world, systems, modifiers, terrain } = loadScene(scene);
    systems.register(new VisibilitySystem(fowDeps(modifiers)));
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers, terrain: terrain! };
    const state = initialState(world, 1);
    const watcher = spawn(world, 'Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = spawn(world, 'Enemy', {
      Position: { x: F(50), y: F(50) },
      Link: { other: watcher },
    });
    tick(sim, state);

    const slot = rawIndexOf(enemy);
    const personal = toPlain(filterSnapshot(state, 0).world);
    // Сущность вырезана штатным удалением (ID-3)…
    expect(personal.alive[slot]).toBe(0);
    // …и данных её у клиента нет ФИЗИЧЕСКИ: в ячейках — нейтральные значения
    // типов, а не позиция, команда и ссылка скрытого врага.
    expect(personal.components.Position!.x![slot]).toBe(0);
    expect(personal.components.Position!.y![slot]).toBe(0);
    expect(personal.components.Team!.id![slot]).toBe(0);
    expect(personal.components.Link!.other![slot]).toBe(NO_ENTITY);

    // В своём снапшоте данные врага целы: это вырезание, а не глобальная чистка.
    const own = toPlain(filterSnapshot(state, 1).world);
    expect(own.components.Position!.x![slot]).toBe(F(50));
    expect(own.components.Link!.other![slot]).toBe(watcher);
    // И канонический мир фильтр не тронул (NET-12, ID-4).
    expect(getField(world, enemy, 'Position', 'x')).toBe(F(50));
  });

  it('команда вне 32 бит — ошибка (FOW-2)', () => {
    const h = apart();
    expect(() => filterSnapshot(h.state, 32)).toThrow(/FOW-2/);
  });
});

describe('viewpoint = ALL (NET-15, CLI-5)', () => {
  it('отдаёт полный мир — реплеи и golden не слепнут', () => {
    const h = apart();
    const full = filterSnapshot(h.state, VIEWPOINT_ALL);

    expect([...listAlive(full.world)]).toEqual([...listAlive(h.world)]);
    expect(snapshotToPlain(full)).toEqual(snapshotToPlain(takeSnapshot(h.state)));
  });

  it('работает и от готового снапшота, не только от состояния', () => {
    const h = apart();
    const snapshot = takeSnapshot(h.state);
    expect(h.present(filterSnapshot(snapshot, VIEWPOINT_ALL), h.enemy)).toBe(true);
    expect(h.present(filterSnapshot(snapshot, 0), h.enemy)).toBe(false);
  });
});

describe('своя сущность под стелсом (NET-15)', () => {
  it('есть в своём снапшоте и отсутствует в чужом', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = h.place('Enemy', { Position: { x: F(2), y: F(0) } });

    h.step();
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(true);

    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'id0', 7);
    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'value0', 1 << 0);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(1));
    expect(h.present(filterSnapshot(h.state, 1), enemy)).toBe(true);
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(false);
    // Наблюдателя стелс врага не прячет.
    expect(h.present(filterSnapshot(h.state, 0), watcher)).toBe(true);
  });
});

describe('скрытие не равно смерть (NET-14)', () => {
  it('фильтр вырезает сущность и не порождает ни одного события', () => {
    const h = apart();
    h.state.events.emit('EntityDied', { entity: h.watcher });

    const forTeam0 = filterSnapshot(h.state, 0);
    expect(h.present(forTeam0, h.enemy)).toBe(false);
    // Ушедший в туман враг никакого события не получил: единственное событие —
    // то, что эмитила симуляция, и оно про другую сущность.
    expect(forTeam0.events.map((e) => e.type)).toEqual(['EntityDied']);
    expect(forTeam0.events.every((e) => e.data.entity !== h.enemy)).toBe(true);
  });

  it('явная смерть невидимого врага до клиента не доходит, своя — доходит', () => {
    const h = apart();
    h.state.events.emit('EntityDied', { entity: h.enemy });

    expect(filterSnapshot(h.state, 0).events).toHaveLength(0);
    expect(filterSnapshot(h.state, 1).events).toHaveLength(1);
  });
});

describe('фильтрация событий (NET-13)', () => {
  it('действующий предикат (норма NET-13): уходит, если видима хоть одна названная сторона', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });
    h.state.events.emit('DamageDealt', { source: h.enemy, target: h.watcher });
    h.state.events.emit('RoundEnded', { winner: 1 });

    const types = filterSnapshot(h.state, 0).events.map((e) => e.type);
    // Каст невидимого врага не утекает; урон по своей сущности — уходит;
    // событие без ссылок на сущности общее.
    expect(types).toEqual(['DamageDealt', 'RoundEnded']);
  });

  it('предикат подменяется целиком — он параметр механизма, а не константа', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });
    h.state.events.emit('RoundEnded', { winner: 1 });

    // Подменяет предикат тот, кто его называет, — конфиг матча (NTR-9); ядро
    // принимает величину параметром и своей политики поверх неё не имеет.
    const onlyRound = filterSnapshot(h.state, 0, (event) => event.type === 'RoundEnded');
    expect(onlyRound.events.map((e) => e.type)).toEqual(['RoundEnded']);

    // Нормированный предикат доступен и как обычная функция: он значение
    // параметра, а не спрятанное умолчание.
    const nothingVisible = relevantEntityVisible({ type: 'AbilityCast', data: { source: h.enemy } }, () => false);
    expect(nothingVisible).toBe(false);
  });

  it('несуществующая ссылка на сущность видимости не даёт', () => {
    const h = apart();
    // -1 — `STATIC_COLLIDER` физики: сущности за ним нет (PHYS-9).
    h.state.events.emit('Collision', { entity: h.enemy, other: -1 });
    expect(filterSnapshot(h.state, 0).events).toHaveLength(0);
    expect(filterSnapshot(h.state, 1).events).toHaveLength(1);
  });

  /**
   * NET-13 «Действующий предикат»: набор имён ЗАКРЫТ, и оба имени отвечают на
   * открытый геймплейный вопрос «видима цель, источник в тумане» с двух сторон.
   * Здесь и проверяется, что ответы у них разные — иначе поле конфига матча не
   * закрывало бы вопрос ничем.
   */
  it('два имени закрытого набора расходятся ровно на разной видимости сторон', () => {
    const h = apart();
    // Урон видимой своей сущности от невидимого врага: названы обе стороны, и
    // видима из них одна.
    h.state.events.emit('DamageDealt', { source: h.enemy, target: h.watcher });

    const any = filterSnapshot(h.state, 0, eventVisibilityByName('any-referenced'));
    expect(any.events.map((e) => e.type)).toEqual(['DamageDealt']);

    const all = filterSnapshot(h.state, 0, eventVisibilityByName('all-referenced'));
    expect(all.events).toEqual([]);

    // Умолчание фильтра — нормированный NET-13 предикат, то есть `any-referenced`.
    expect(eventVisibilityByName('any-referenced')).toBe(relevantEntityVisible);
  });

  it('событие, не называющее ни одной сущности, общее при обоих именах', () => {
    const h = apart();
    h.state.events.emit('RoundEnded', { winner: 1 });
    for (const name of ['any-referenced', 'all-referenced'] as const) {
      const types = filterSnapshot(h.state, 0, eventVisibilityByName(name)).events.map((e) => e.type);
      expect(types, name).toEqual(['RoundEnded']);
    }
  });

  /**
   * NET-13: значение поля-ссылки, равное коду «ссылки нет» (ECS-6), сущности НЕ
   * называет. Проверяется на `all-referenced`, потому что цена ошибки видна
   * именно там: сочти пустую ссылку названной — и урон от арены, у которого нет
   * источника, погас бы у всех получателей разом, независимо от видимости цели.
   */
  it('пустая ссылка сущности не называет — ни при одном имени набора', () => {
    const h = apart();
    // Урон по своей видимой сущности без источника: поле есть, ссылки в нём нет.
    h.state.events.emit('DamageDealt', { source: NO_ENTITY, target: h.watcher });

    for (const name of ['any-referenced', 'all-referenced'] as const) {
      const types = filterSnapshot(h.state, 0, eventVisibilityByName(name)).events.map((e) => e.type);
      expect(types, name).toEqual(['DamageDealt']);
    }

    // И обратная половина: пустая ссылка не делает событие видимым — решает
    // единственная НАЗВАННАЯ сущность, а она команде 0 не видна.
    const h2 = apart();
    h2.state.events.emit('DamageDealt', { source: NO_ENTITY, target: h2.enemy });
    for (const name of ['any-referenced', 'all-referenced'] as const) {
      expect(filterSnapshot(h2.state, 0, eventVisibilityByName(name)).events, name).toEqual([]);
      expect(filterSnapshot(h2.state, 1, eventVisibilityByName(name)).events, name).toHaveLength(1);
    }
  });

  it('событие, все ссылки которого пусты, общее: названо в нём никого', () => {
    const h = apart();
    h.state.events.emit('ArenaShrink', { source: NO_ENTITY, other: NO_ENTITY });
    for (const name of ['any-referenced', 'all-referenced'] as const) {
      const types = filterSnapshot(h.state, 0, eventVisibilityByName(name)).events.map((e) => e.type);
      expect(types, name).toEqual(['ArenaShrink']);
    }
  });

  it('имя вне закрытого набора — названный отказ, а не молчаливый возврат к норме', () => {
    expect(() => eventVisibilityByName('freeze')).toThrow(/"freeze" неизвестен \(NET-13\)/);
  });

  /**
   * NET-13, сценарий «Ссылка под именем вне набора». Набор имён закрыт нормой, и
   * поле вне него видимости событию не добавляет — ни в плюс (незнакомое имя не
   * делает событие видимым), ни в минус (событие, называющее сущность ТОЛЬКО
   * таким полем, никого не называет и потому общее).
   */
  it('поле-ссылка с именем вне закрытого набора видимости не добавляет', () => {
    const h = apart();
    // `caster` в наборе `EVENT_ENTITY_FIELDS` не значится: для предиката событие
    // не называет ни одной сущности и уходит всем как общее.
    h.state.events.emit('Cast', { caster: h.enemy });
    expect(filterSnapshot(h.state, 0).events.map((e) => e.type)).toEqual(['Cast']);

    // А рядом с именем ИЗ набора незнакомое имя ничего не добавляет: видимость
    // решает только `entity`, и невидимый враг событие не пропускает.
    const h2 = apart();
    h2.state.events.emit('Cast', { caster: h2.watcher, entity: h2.enemy });
    expect(filterSnapshot(h2.state, 0).events).toHaveLength(0);
    expect(filterSnapshot(h2.state, 1).events.map((e) => e.type)).toEqual(['Cast']);
  });
});

/**
 * NET-18, сценарий «Событие невидимого врага в шине снапшота». Шина внутри
 * персонального снапшота — та же отобранная проекция, что уходит потоком, и
 * отобрана она ОДНИМ вызовом фильтра: иначе отбор потока событий обходился бы
 * состоянием, а состав проекции молча расширился бы обратно.
 */
describe('шина внутри персонального снапшота (NET-18)', () => {
  it('событие невидимого врага в шине персонального снапшота отсутствует', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });

    // Канонический мир событие знает — вырезано оно именно проекцией.
    expect([...h.state.events].map((e) => e.type)).toEqual(['AbilityCast']);
    expect(filterSnapshot(h.state, 0).events).toEqual([]);
    // Своему тот же факт доезжает: отбор идёт по видимости, а не по каналу.
    expect(filterSnapshot(h.state, 1).events.map((e) => e.type)).toEqual(['AbilityCast']);
  });

  it('наблюдателю шина не отбирается: фильтр снимается целиком, а не по каналам', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });
    expect(filterSnapshot(h.state, VIEWPOINT_ALL).events.map((e) => e.type)).toEqual(['AbilityCast']);
  });
});

describe('сцена без FoW (DI-3)', () => {
  /**
   * NET-12, сценарий «Сцена без тумана войны»: персональный снапшот совпадает по
   * составу сущностей с каноническим, а не оказывается пустым. Проверяется при
   * любом `viewpoint` — умолчание «публична» не зависит от точки зрения.
   */
  it('без компонента Visibility фильтр ничего не режет', () => {
    const { world } = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [{ name: 'Rock', components: { Position: { x: 0, y: 0 } } }],
    });
    spawn(world, 'Rock');
    spawn(world, 'Rock');
    const state = initialState(world, 1);
    const canonical = [...listAlive(world)];
    expect(canonical).toHaveLength(2);

    for (const viewpoint of [0, 31, VIEWPOINT_ALL]) {
      expect([...listAlive(filterSnapshot(state, viewpoint).world)]).toEqual(canonical);
    }
  });
});

/**
 * REW-11 — стык двух механизмов, каждый из которых по отдельности покрыт:
 * видимость (FOW-*) и перемотка (REW-*). Проверять его надо именно на стыке.
 * `Visibility` — обычный компонент, поэтому он входит в снапшот и откатывается
 * вместе с миром; отсюда следует, что после отката фильтр обязан опираться на
 * видимость ЦЕЛЕВОГО тика. Если бы фильтр брал видимость текущего тика,
 * зритель перемотки увидел бы прошлое глазами настоящего — врага, которого в
 * тот момент не видел, либо пустоту на месте того, кого видел.
 */
describe('видимость откатывается вместе с миром (REW-11)', () => {
  it('после отката враг снова в снапшоте: фильтр берёт Visibility целевого тика', () => {
    const { world, systems, modifiers } = loadScene(SCENE);
    systems.register(new VisibilitySystem(fowDeps(modifiers)));
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers };
    const state = initialState(world, 1);

    spawn(world, 'Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = spawn(world, 'Enemy', { Position: { x: F(1), y: F(0) } });

    // Интервал 1: каждый тик снимается снапшотом, поэтому seekTo восстанавливает
    // целевой тик как есть, без доигрывания — проверяется откат, а не реплей.
    const history = new RingHistory({ interval: 1, capacity: 16 });
    const inputs = createInputLog();
    history.record(state);
    const step = (): void => {
      inputs.record(state.tick + 1, []);
      tick(sim, state);
      history.record(state);
    };

    step();
    step();
    const seen = state.tick;
    // На этом тике враг в зоне обзора и в персональном снапшоте команды 0 есть.
    expect(isAlive(filterSnapshot(state, 0).world, enemy)).toBe(true);

    // Враг ушёл из обзора: следующий пересчёт видимости снимет бит команды 0.
    setField(world, enemy, 'Position', 'x', F(50));
    setField(world, enemy, 'Position', 'y', F(50));
    step();
    step();
    expect(isAlive(filterSnapshot(state, 0).world, enemy)).toBe(false);

    const wsm = createRewindController(sim, state, { history, inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(seen);

    expect(state.tick).toBe(seen);
    expect(isAlive(filterSnapshot(state, 0).world, enemy)).toBe(true);
  });
});
