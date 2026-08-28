/**
 * Шар заряда каста (`app/chargeBalls.ts`) — картинка главного потока, у которой
 * нет второго владельца.
 *
 * Записью манифеста она не выражается: эффект-оболочка (`rendering` REND-23)
 * живёт, пока доставлено состояние, и рисуется РАДИУСОМ ЗАПИСИ в позиции
 * сущности, а заряд обязан и расти, и висеть перед кастером — в этом весь смысл
 * фазы заряда (`ability-system` ABIL-4). Отсюда модуль, и отсюда же то, что
 * проверяется здесь и не проверяется ничем в движке:
 *
 * — шар рисуется КАЖДОЙ доставленной сущности со статом `charge`, а не одному
 *   своему герою: соперник копит тот же заряд до того же удара, и видеть его
 *   игрок обязан из ДОСТАВЛЕННОГО состояния (`match-hud` HUD-1) — сущность-слот
 *   способности видна только своей стороне (`netcode` NET-12, ABIL-8), поэтому
 *   и заряд, и прицел едут статами НА ГЕРОЕ;
 * — направление: своё — прицел ЭТОГО кадра (курсор идёт впереди тика), чужое —
 *   доставленный стат `aim` (`Input.aimDir`, доли оборота), нет ни того, ни
 *   другого — курс сущности;
 * — числа картинки приезжают из записей манифеста и из зеркала чисел
 *   определения (`CHARGE_VISUAL` сборки), переведённых в мировые единицы на
 *   границе рендера (REND-1); отсутствие записи или поля — громкая ошибка
 *   сборки, а не молчаливое умолчание, которое разошлось бы с манифестом;
 * — поза берётся от точки пола под инстансом — общей визуальной поверхности
 *   кадра (REND-9), а не от позы инстанса, поднятой дугой манёвра.
 *
 * Браузер для этого не нужен: фабрика собрана на инъекции — сцена THREE,
 * манифест и покадровые доступы к доставке, к инстансам и к прицелу, — и стенд
 * подаёт их сам. Манифест читается прямо из дерева контента: демо — игра, и
 * `content/` ему принадлежит (CONT-4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, type EntityId } from '@fluxus/core';
import type { VisualEffect, VisualManifest } from '@fluxus/assets';
import { TURN_UNITS } from '@fluxus/client';
import type { EntityView, ModelInstanceView } from '@fluxus/render';
import { createChargeBalls, type ChargeBalls } from '../app/chargeBalls.js';
import { CHARGE_VISUAL, STATS } from '../app/sim.js';
import manifestJson from '../../../content/visuals/manifest.json';

const MANIFEST = manifestJson as unknown as VisualManifest;
const FIREBALL = MANIFEST.effects!.byKind!.Fireball!;
const HEAVY = MANIFEST.effects!.byKind!.HeavyFireball!;
/** Числа картинки — из записи манифеста: у теста своей копии их нет. */
const RADIUS = FIREBALL.radius;
const HEIGHT = FIREBALL.height!;
const ALPHA = FIREBALL.alpha!;
/** Числа заряда — из зеркала определения, в мировых единицах и долях (REND-1). */
const OFFSET = CHARGE_VISUAL.offset / FIXED_ONE;
const MAX_SCALE = CHARGE_VISUAL.maxScale / FIXED_ONE;
const HEAVY_SCALE = CHARGE_VISUAL.heavyScale / FIXED_ONE;
const GROW = CHARGE_VISUAL.ticks;

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------- стенд

/** Покадровый вход шаров: тест двигает эти поля между вызовами `update()`. */
interface Frame {
  /** Доставленные сущности кадра; undefined — доставки ещё нет. */
  entities: Map<EntityId, EntityView> | undefined;
  /** Свой герой (handshake воркера); null — handshake ещё не пришёл. */
  hero: EntityId | null;
  /** Последний непустой прицел кадра в единицах угла ядра (FP-7). */
  aim: number | null;
  /** Точка пола под инстансом (REND-9); нет записи — инстанса в кадре нет. */
  ground: Map<EntityId, { x: number; y: number; z: number }>;
}

interface Stand {
  readonly scene: THREE.Scene;
  readonly balls: ChargeBalls;
  readonly frame: Frame;
}

/** Инстанс кадра подсистемы моделей: шар читает у него только точку пола. */
function instanceOf(entity: EntityId): ModelInstanceView {
  return { entity } as unknown as ModelInstanceView;
}

function stand(manifest: VisualManifest = MANIFEST): Stand {
  const scene = new THREE.Scene();
  const frame: Frame = { entities: undefined, hero: null, aim: null, ground: new Map() };
  const balls = createChargeBalls({
    scene,
    manifest,
    entities: () => frame.entities,
    instanceFor: (entity) => (frame.ground.has(entity) ? instanceOf(entity) : null),
    heroId: () => frame.hero,
    lastAim: () => frame.aim,
    // Одна переиспользуемая запись здесь не нужна: читает её шар сразу.
    groundUnder: (instance) => frame.ground.get(instance.entity) ?? { x: 0, y: 0, z: 0 },
  });
  return { scene, balls, frame };
}

/** Доставленная сущность: шару значимы только статы и курс. */
function entityView(id: EntityId, partial: Partial<EntityView> = {}): EntityView {
  return {
    id,
    kind: 'Hero',
    prevX: 0,
    prevY: 0,
    currX: 0,
    currY: 0,
    prevLevel: 0,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: false,
    levelOverride: false,
    facingYaw: 0,
    aimYaw: null,
    states: 0,
    motion: 0,
    prevMotion: 0,
    prevMotionPhase: Number.NaN,
    currMotionPhase: Number.NaN,
    flightPhase: Number.NaN,
    ...partial,
  };
}

/** Разреженные пары статов доставки (HUD-8): чего нет — того нет. */
function stats(entries: Record<string, number>): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries));
}

/**
 * Доставка кадра. Пол под сущностью кладётся по её позиции — то есть инстанс в
 * кадре есть; `instances: false` — доставка пришла, а рисовать ещё нечего.
 */
function deliver(frame: Frame, views: readonly EntityView[], instances = true): void {
  frame.entities = new Map(views.map((view) => [view.id, view]));
  frame.ground.clear();
  if (!instances) return;
  for (const view of views) frame.ground.set(view.id, { x: view.currX, y: view.currY, z: 0 });
}

/** Шары в сцене — в порядке появления: меш рождается при первом кадре заряда. */
function meshes(scene: THREE.Scene): THREE.Mesh[] {
  return scene.children.filter((child): child is THREE.Mesh => child.name === 'charge-ball');
}

function only(scene: THREE.Scene): THREE.Mesh {
  const drawn = meshes(scene);
  expect(drawn).toHaveLength(1);
  return drawn[0]!;
}

function materialOf(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
  return mesh.material as THREE.MeshBasicMaterial;
}

/** Манифест с подменённой записью `Fireball` — остальное как в дереве контента. */
function withFireball(fireball: VisualEffect): VisualManifest {
  return { entities: {}, effects: { byKind: { Fireball: fireball, HeavyFireball: HEAVY } } };
}

// ------------------------------------------------- числа картинки — из манифеста

describe('числа шара — записи манифеста, а не умолчания кода (REND-23)', () => {
  it('нет записи effects.byKind.Fireball — сборка падает, называя запись', () => {
    expect(() => stand({ entities: {} })).toThrow(/effects\.byKind\.Fireball/);
  });

  it('нет записи HeavyFireball — падает так же: цвет тяжёлого брать неоткуда', () => {
    const manifest: VisualManifest = { entities: {}, effects: { byKind: { Fireball: FIREBALL } } };
    expect(() => stand(manifest)).toThrow(/effects\.byKind\.HeavyFireball/);
  });

  it('в записи Fireball нет alpha — падает: прозрачность шара брать неоткуда', () => {
    const noAlpha: VisualEffect = { primitive: 'sphere', color: '#ffffff', radius: 1, height: HEIGHT };
    expect(() => stand(withFireball(noAlpha))).toThrow(/alpha\/height/);
  });

  it('в записи Fireball нет height — падает: высоту шара брать неоткуда', () => {
    const noHeight: VisualEffect = { primitive: 'sphere', color: '#ffffff', radius: 1, alpha: ALPHA };
    expect(() => stand(withFireball(noHeight))).toThrow(/alpha\/height/);
  });
});

// ------------------------------------------- шар КАЖДОМУ заряжающему (HUD-1)

describe('шар рисуется каждой доставленной сущности со статом charge (HUD-1, NET-12)', () => {
  it('заряжающий соперник телеграфирует удар: шаров два, у каждого своя точка', () => {
    const s = stand();
    s.frame.hero = 1;
    s.frame.aim = 0;
    deliver(s.frame, [
      entityView(1, { currX: 1, stats: stats({ [STATS.charge]: 10 }) }),
      entityView(2, { currX: 5, stats: stats({ [STATS.charge]: 10 }) }),
    ]);
    s.balls.update();
    const drawn = meshes(s.scene);
    expect(drawn).toHaveLength(2);
    expect(drawn.every((mesh) => mesh.visible)).toBe(true);
    // Порядок мешей — порядок появления, то есть порядок доставки кадра.
    expect(drawn[0]!.position.x).toBeCloseTo(1 + OFFSET, 6);
    expect(drawn[1]!.position.x).toBeCloseTo(5 + OFFSET, 6);
    // Геометрия одна на все шары (REND-3): размер даёт `scale` меша.
    expect(drawn[0]!.geometry).toBe(drawn[1]!.geometry);
  });

  it('сущность без стата заряда шара не получает — «нет данных», а не ноль', () => {
    const s = stand();
    deliver(s.frame, [
      entityView(1, { stats: stats({ [STATS.charge]: 4 }) }),
      // Заряжает не всякий: у одного статы есть, но заряда среди них нет,
      // у другого статов нет вовсе (снаряд, декорация).
      entityView(2, { currX: 3, stats: stats({ [STATS.hp]: 100 }) }),
      entityView(3, { currX: 6 }),
    ]);
    s.balls.update();
    expect(meshes(s.scene)).toHaveLength(1);
    expect(only(s.scene).position.x).toBeCloseTo(OFFSET, 6);
  });

  it('доставки ещё нет — кадр молчит', () => {
    const s = stand();
    s.balls.update();
    expect(meshes(s.scene)).toHaveLength(0);
  });

  it('инстанса сущности в кадре ещё нет — шар не рисуется и не падает', () => {
    const s = stand();
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 10 }) })], false);
    expect(() => {
      s.balls.update();
    }).not.toThrow();
    expect(meshes(s.scene)).toHaveLength(0);
  });
});

// ------------------------------------------------ направление (ABIL-4, ABIL-8)

describe('направление шара: свой прицел кадра, чужой доставленный (ABIL-8)', () => {
  it('свой шар целится прицелом ЭТОГО кадра, а не доставленным статом', () => {
    const s = stand();
    s.frame.hero = 1;
    // Четверть оборота в единицах угла ядра — против доставленного полуоборота:
    // курсор идёт впереди тика, и выигрывает прицел кадра.
    s.frame.aim = TURN_UNITS / 4;
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 5, [STATS.aim]: 0.5 }) })]);
    s.balls.update();
    const ball = only(s.scene);
    expect(ball.position.x).toBeCloseTo(0, 6);
    expect(ball.position.y).toBeCloseTo(OFFSET, 6);
  });

  it('чужой шар — доставленным прицелом: `Input.aimDir` в долях оборота', () => {
    const s = stand();
    s.frame.hero = 1;
    s.frame.aim = 0;
    deliver(s.frame, [
      entityView(1, { stats: stats({ [STATS.charge]: 5 }) }),
      entityView(2, { currX: 5, stats: stats({ [STATS.charge]: 5, [STATS.aim]: 0.5 }) }),
    ]);
    s.balls.update();
    const drawn = meshes(s.scene);
    // Свой — по прицелу кадра (0 радиан), чужой — по своему доставленному
    // полуобороту: вынос ушёл в противоположную сторону.
    expect(drawn[0]!.position.x).toBeCloseTo(OFFSET, 6);
    expect(drawn[1]!.position.x).toBeCloseTo(5 - OFFSET, 6);
    expect(drawn[1]!.position.y).toBeCloseTo(0, 6);
  });

  it('handshake ещё не пришёл — своего героя нет, и все шары чужие', () => {
    const s = stand();
    s.frame.hero = null;
    s.frame.aim = TURN_UNITS / 4;
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 5, [STATS.aim]: 0.5 }) })]);
    s.balls.update();
    expect(only(s.scene).position.x).toBeCloseTo(-OFFSET, 6);
  });

  it('свой герой без прицела кадра берёт доставленный стат', () => {
    const s = stand();
    s.frame.hero = 1;
    s.frame.aim = null;
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 5, [STATS.aim]: 0.5 }) })]);
    s.balls.update();
    expect(only(s.scene).position.x).toBeCloseTo(-OFFSET, 6);
  });

  it('ни прицела кадра, ни стата — курс сущности: aimYaw, иначе facingYaw', () => {
    const s = stand();
    deliver(s.frame, [
      entityView(1, { aimYaw: Math.PI, stats: stats({ [STATS.charge]: 5 }) }),
      entityView(2, { currX: 5, facingYaw: Math.PI / 2, stats: stats({ [STATS.charge]: 5 }) }),
    ]);
    s.balls.update();
    const drawn = meshes(s.scene);
    expect(drawn[0]!.position.x).toBeCloseTo(-OFFSET, 6);
    expect(drawn[1]!.position.x).toBeCloseTo(5, 6);
    expect(drawn[1]!.position.y).toBeCloseTo(OFFSET, 6);
  });
});

// ------------------------------------------------- рост, цвет и место (REND-9)

describe('шар растёт с зарядом и садится на пол под инстансом (ABIL-4, REND-9)', () => {
  it.each<[number, number]>([
    // Тик нажатия окном роста не считается — шар стартует базовым радиусом.
    [1, 1],
    [GROW / 2 + 1, 1 + (MAX_SCALE - 1) / 2],
    [GROW + 1, MAX_SCALE],
    // Сверх окна заряд не растёт: дальше он только передержан.
    [GROW + 30, MAX_SCALE],
  ])('заряд в %i тиков — радиус записи, умноженный на %f', (ticks, multiplier) => {
    const s = stand();
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: ticks }) })]);
    s.balls.update();
    const ball = only(s.scene);
    expect(ball.scale.x).toBeCloseTo(RADIUS * multiplier, 6);
    expect(ball.scale.y).toBeCloseTo(RADIUS * multiplier, 6);
    expect(ball.scale.z).toBeCloseTo(RADIUS * multiplier, 6);
  });

  it('с порога heavyScale шар красится цветом того снаряда, который родится', () => {
    const s = stand();
    const light = new THREE.Color(FIREBALL.color).getHex();
    const heavy = new THREE.Color(HEAVY.color).getHex();
    expect(light).not.toBe(heavy);
    // Заряд, которому до порога один тик, — ещё обычного цвета.
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: GROW / 2 }) })]);
    s.balls.update();
    const below = only(s.scene);
    expect(below.scale.x).toBeLessThan(RADIUS * HEAVY_SCALE);
    expect(materialOf(below).color.getHex()).toBe(light);
    // Ровно на пороге (`>=`) — уже цвет `HeavyFireball`.
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: GROW / 2 + 1 }) })]);
    s.balls.update();
    const ball = only(s.scene);
    expect(ball.scale.x).toBeCloseTo(RADIUS * HEAVY_SCALE, 6);
    expect(materialOf(ball).color.getHex()).toBe(heavy);
  });

  it('шар висит на высоте записи над полом под инстансом, а не над его позой', () => {
    const s = stand();
    deliver(s.frame, [entityView(1, { currX: 2, currY: 3, stats: stats({ [STATS.charge]: 1 }) })]);
    // Пол под инстансом — общая визуальная поверхность кадра (REND-9): её
    // высоту шар и берёт, прибавляя высоту записи манифеста.
    s.frame.ground.set(1, { x: 2, y: 3, z: 1.25 });
    s.balls.update();
    const ball = only(s.scene);
    expect(ball.position.x).toBeCloseTo(2 + OFFSET, 6);
    expect(ball.position.y).toBeCloseTo(3, 6);
    expect(ball.position.z).toBeCloseTo(1.25 + HEIGHT, 6);
    expect(materialOf(ball).opacity).toBeCloseTo(ALPHA, 6);
  });
});

// ------------------------------------------------------ передержка (ABIL-4)

describe('передержанный заряд не растёт, а мигает', () => {
  it('альфа записи МОДУЛИРУЕТСЯ миганием, а не подменяется своим числом', () => {
    const s = stand();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    // Передержка видна в СЫРЫХ тиках: окно роста уже пройдено.
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: GROW + 1 }) })]);
    s.balls.update();
    expect(materialOf(only(s.scene)).opacity).toBeCloseTo(ALPHA * 0.4, 6);
    // Вторая фаза тех же кадровых часов — полная альфа записи.
    now.mockReturnValue(90);
    s.balls.update();
    expect(materialOf(only(s.scene)).opacity).toBeCloseTo(ALPHA, 6);
  });

  it('заряд в пределах окна роста не мигает ни в одной фазе часов', () => {
    const s = stand();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: GROW }) })]);
    s.balls.update();
    expect(materialOf(only(s.scene)).opacity).toBeCloseTo(ALPHA, 6);
    now.mockReturnValue(90);
    s.balls.update();
    expect(materialOf(only(s.scene)).opacity).toBeCloseTo(ALPHA, 6);
  });
});

// ---------------------------------------------------------------------- пул

describe('меши шаров переиспользуются: кадр не аллоцирует', () => {
  it('переставший заряжать отпускает меш, а следующий заряжающий его берёт', () => {
    const s = stand();
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 10 }) })]);
    s.balls.update();
    const mesh = only(s.scene);
    expect(mesh.visible).toBe(true);
    // Заряд отпущен: стата в доставке больше нет — шар гаснет, оставаясь в пуле.
    deliver(s.frame, [entityView(1)]);
    s.balls.update();
    expect(mesh.visible).toBe(false);
    expect(meshes(s.scene)).toHaveLength(1);
    // Следующему заряжающему достаётся ТОТ ЖЕ объект: детей в сцене не прибыло.
    deliver(s.frame, [entityView(2, { currX: 4, stats: stats({ [STATS.charge]: 10 }) })]);
    s.balls.update();
    expect(only(s.scene)).toBe(mesh);
    expect(mesh.visible).toBe(true);
    expect(mesh.position.x).toBeCloseTo(4 + OFFSET, 6);
  });

  it('доставка прервалась — живые шары гаснут, а не остаются висеть', () => {
    const s = stand();
    deliver(s.frame, [entityView(1, { stats: stats({ [STATS.charge]: 10 }) })]);
    s.balls.update();
    const mesh = only(s.scene);
    s.frame.entities = undefined;
    s.balls.update();
    expect(mesh.visible).toBe(false);
    expect(meshes(s.scene)).toHaveLength(1);
  });
});
