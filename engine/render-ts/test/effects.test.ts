/**
 * Подсистема транзиентных эффектов (REND-23): оболочки от доставленного
 * состояния, вспышки от reliable-событий, параметры — записи манифеста.
 *
 * Проверяется наблюдаемое: эффект появляется и исчезает вместе с сущностью,
 * вспышка играет свою длительность ровно один раз и умирает, новая запись
 * манифеста не требует кода, разрыв непрерывности гасит проигрываемое, а
 * picking эффектов не видит.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  ModelsSubsystem,
  createPickProxy,
  type PickProxy,
  type RenderContext,
} from '../src/index.js';
import { createStateReader, stateTableNames } from '../src/subsystems/shellSupport.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

/** Манифест только с секцией эффектов: моделей у этих типов нет и не нужно. */
function makeManifest(): VisualManifest {
  return {
    entities: {},
    effects: {
      byKind: {
        Fireball: {
          primitive: 'sphere',
          color: '#ff8a3c',
          radius: 0.25,
          alpha: 0.95,
          height: 0.6,
          verticalOffset: { flightArc: 0.4 },
        },
      },
      byState: {
        Shielded: { primitive: 'sphere', color: '#4aa3ff', radius: 0.9, alpha: 0.3, height: 0.9 },
      },
      byEvent: {
        FireballExploded: {
          primitive: 'sphere',
          color: '#ff4020',
          radius: 0.2,
          radiusTo: 1.6,
          alpha: 0.7,
          alphaTo: 0,
          durationMs: 400,
        },
      },
    },
  };
}

/** Порядок состояний сборки — он же словарь битов `EntityView.states` (CAM-6). */
const STATE_COMPONENTS = ['Falling', 'Shielded'];
/** Бит состояния `Shielded` в маске доставленных состояний. */
const SHIELDED = 1 << 1;

function makeRig(manifest: VisualManifest = makeManifest()) {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const warnings: string[] = [];
  const subsystem = new EffectsSubsystem(manifest, {
    stateComponents: STATE_COMPONENTS,
    warn: (m) => warnings.push(m),
  });
  subsystem.init(ctx);
  return { subsystem, scene, warnings, assets, ctx };
}

describe('EffectsSubsystem: оболочка живёт с сущностью (REND-23)', () => {
  it('появляется с сущностью своего типа и исчезает вместе с ней', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.effectFor(1)!.record.color).toBe('#ff8a3c');

    // Сущность исчезла из доставленного состояния — оболочки не стало.
    subsystem.syncTick(makeTickView([]));
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.effectFor(1)).toBeNull();
  });

  it('тип без записи эффекта оболочки не получает', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero' })]));
    expect(subsystem.activeCount).toBe(0);
  });

  it('оболочка садится по позиции сущности, подъёму записи и полётной дуге (REND-12)', () => {
    const { subsystem } = makeRig();
    const flying = (phase: number) =>
      makeEntityView(1, { kind: 'Fireball', prevX: 2, currX: 2, prevY: 3, currY: 3, flightPhase: phase });

    subsystem.syncTick(makeTickView([flying(0)]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.effectFor(1)!.object;
    expect(object.position.x).toBeCloseTo(2, 6);
    expect(object.position.y).toBeCloseTo(3, 6);
    // Начало пути: дуги ещё нет, только подъём записи.
    expect(object.position.z).toBeCloseTo(0.6, 6);

    subsystem.syncTick(makeTickView([flying(0.5)]));
    subsystem.updateFrame(0.016, 1);
    expect(object.position.z).toBeCloseTo(0.6 + 0.4, 6);

    subsystem.syncTick(makeTickView([flying(1)]));
    subsystem.updateFrame(0.016, 1);
    expect(object.position.z).toBeCloseTo(0.6, 6);
  });
});

describe('EffectsSubsystem: оболочка по доставленному состоянию (REND-23)', () => {
  const hero = (states: number) => makeEntityView(1, { kind: 'Hero', states });

  it('состояние появилось — сфера появилась; исчезло — исчезла (сценарий «Сфера щита»)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([hero(0)]));
    expect(subsystem.activeCount).toBe(0);

    subsystem.syncTick(makeTickView([hero(SHIELDED)]));
    expect(subsystem.effectFor(1, 'state:Shielded')!.record.color).toBe('#4aa3ff');
    expect(subsystem.activeCount).toBe(1);

    subsystem.syncTick(makeTickView([hero(0)]));
    expect(subsystem.effectFor(1, 'state:Shielded')).toBeNull();
    expect(subsystem.activeCount).toBe(0);
  });

  it('перемотка восстанавливает оболочку из доставленного состояния (REND-2)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([hero(SHIELDED)]));
    // Разрыв непрерывности: состояние в доставке есть — оболочка остаётся,
    // потому что она производна от него, а не от собственного счётчика.
    subsystem.syncTick(makeTickView([hero(SHIELDED)], { snapAll: true }));
    expect(subsystem.effectFor(1, 'state:Shielded')).not.toBeNull();
    // Отмотали в тик до щита — оболочки нет.
    subsystem.syncTick(makeTickView([hero(0)], { snapAll: true }));
    expect(subsystem.activeCount).toBe(0);
  });

  it('оболочки типа и состояния сосуществуют на одной сущности', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Fireball', states: SHIELDED })]),
    );
    expect(subsystem.activeCount).toBe(2);
    expect(subsystem.effectFor(1, 'kind:Fireball')!.record.color).toBe('#ff8a3c');
    expect(subsystem.effectFor(1, 'state:Shielded')!.record.color).toBe('#4aa3ff');
  });

  it('состояние вне списка сборки — предупреждение один раз, а не молчание', () => {
    const { subsystem, warnings } = makeRig({
      entities: {},
      effects: { byState: { Burning: { primitive: 'sphere', color: '#f80', radius: 0.5 } } },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: 0xff })]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: 0xff })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((message) => message.includes('Burning'))).toHaveLength(1);
  });
});

describe('EffectsSubsystem: вспышка по событию (REND-23, HUD-5)', () => {
  const explosion = (data: Record<string, number>) =>
    makeTickView([], { freshEvents: true, events: [{ type: 'FireballExploded', data }] });

  it('играет свою длительность и исчезает; повторно не возникает', () => {
    const { subsystem } = makeRig();
    // Координаты события — Q16.16, как их эмитировала система (REND-1).
    subsystem.syncTick(explosion({ x: 65536 * 4, y: 65536 * 5 }));
    expect(subsystem.activeCount).toBe(1);

    subsystem.updateFrame(0.2, 1); // половина длительности
    expect(subsystem.activeCount).toBe(1);

    // Тик без событий вспышку не переигрывает — она доигрывает свою жизнь.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(0.2, 1);
    expect(subsystem.activeCount).toBe(0);
  });

  it('растёт и гаснет по записи: радиус и альфа идут от начала к концу', () => {
    const { subsystem, scene } = makeRig();
    subsystem.syncTick(explosion({ x: 0, y: 0 }));
    const group = scene.children.find((child) => child.name === 'effects')!;
    const mesh = group.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(mesh.scale.x).toBeCloseTo(0.2, 6);
    expect(material.opacity).toBeCloseTo(0.7, 6);

    subsystem.updateFrame(0.2, 1); // фаза 0.5
    expect(mesh.scale.x).toBeCloseTo(0.2 + (1.6 - 0.2) * 0.5, 6);
    expect(material.opacity).toBeCloseTo(0.35, 6);
  });

  it('событие без записи в манифесте вспышки не порождает', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([], { freshEvents: true, events: [{ type: 'CastFireball', data: { x: 0, y: 0 } }] }),
    );
    expect(subsystem.activeCount).toBe(0);
  });

  it('нечестный проход событий не проигрывает (OBS-5)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([], {
        freshEvents: false,
        events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }],
      }),
    );
    expect(subsystem.activeCount).toBe(0);
  });

  it('вне Running вспышка замирает: часы презентации её не двигают (REND-25)', () => {
    const { subsystem, scene } = makeRig();
    subsystem.syncTick(explosion({ x: 0, y: 0 }));
    const group = scene.children.find((child) => child.name === 'effects')!;
    const mesh = group.children[0] as THREE.Mesh;
    subsystem.updateFrame(0.2, 1); // фаза 0.5
    const frozen = mesh.scale.x;

    // Пауза и обратный ход вспышку не доигрывают и не отматывают: отмотать
    // её нечем, а играть вперёд в стоящем мире REND-25 запрещает.
    subsystem.updateFrame(0, 1);
    for (let i = 0; i < 20; i++) subsystem.updateFrame(-1 / 60, 1);
    expect(subsystem.activeCount).toBe(1);
    expect(mesh.scale.x).toBeCloseTo(frozen, 6);
  });

  it('разрыв непрерывности гасит вспышку, а оболочку восстанавливает доставка (REND-2)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(explosion({ x: 0, y: 0 }));
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    expect(subsystem.activeCount).toBe(2);

    // Перемотка: проигрываемое исчезает, производное от состояния — остаётся.
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })], { snapAll: true }));
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.effectFor(1)).not.toBeNull();
  });
});

describe('EffectsSubsystem: данные, а не код (REND-23)', () => {
  it('новый эффект — запись манифеста; переподача её доносит (REND-17)', () => {
    const manifest = makeManifest();
    const { subsystem } = makeRig(manifest);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Rune' })]));
    expect(subsystem.activeCount).toBe(0);

    // Правится только документ — код подсистемы тот же.
    subsystem.applyManifest({
      ...manifest,
      effects: {
        ...manifest.effects,
        byKind: {
          ...manifest.effects!.byKind,
          Rune: { primitive: 'sphere', color: '#80ff80', radius: 0.5 },
        },
      },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Rune' })]));
    expect(subsystem.effectFor(1)!.record.color).toBe('#80ff80');
  });

  it('неизвестный примитив — предупреждение один раз и пропуск, а не отказ кадра', () => {
    const { subsystem, warnings } = makeRig({
      entities: {},
      effects: { byKind: { Ghost: { primitive: 'hologram', color: '#fff', radius: 1 } } },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' })]));
    subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Ghost' })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((message) => message.includes('hologram'))).toHaveLength(1);
  });

  it('меши переиспользуются пулом: число эффектов растёт, число мешей — нет', () => {
    const { subsystem } = makeRig();
    for (let i = 0; i < 3; i++) {
      subsystem.syncTick(
        makeTickView([], { freshEvents: true, events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }] }),
      );
    }
    expect(subsystem.pooledCount).toBe(3);
    subsystem.updateFrame(1, 1); // все отжили
    expect(subsystem.activeCount).toBe(0);

    subsystem.syncTick(
      makeTickView([], { freshEvents: true, events: [{ type: 'FireballExploded', data: { x: 0, y: 0 } }] }),
    );
    // Новая вспышка взяла меш из пула — заводить четвёртый не пришлось.
    expect(subsystem.pooledCount).toBe(3);
  });
});

describe('Эффекты и picking (REND-15, REND-23)', () => {
  it('эффект не попадает в набор объёмов-прокси: попадать в изображение нечем', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    // Источником прокси подсистема эффектов не является по построению —
    // зарегистрировать её в picking'е невозможно, и это и есть гарантия.
    expect('eachProxy' in subsystem).toBe(false);
    expect('proxyOf' in subsystem).toBe(false);
  });

  it('тип с записью эффекта не получает magenta-заглушки моделей (ASSET-4)', () => {
    const { assets, ctx } = makeRig();
    const warnings: string[] = [];
    const models = new ModelsSubsystem(makeManifest(), { warn: (m) => warnings.push(m) });
    models.init({ ...ctx, assets: assets.service });
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    models.updateFrame(0.016, 1);

    // Ни объёма-прокси (рисовать нечего), ни жалобы на отсутствующую запись.
    expect(models.instanceFor(1)!.placeholder).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('купол эффекта остаётся невыделяемым: объёма-прокси у него нет (сценарий REND-37)', () => {
    // Решение осознанное, а не недосмотр: габариты оболочки записаны в самой
    // записи (примитив, радиус, высота), и фиксированный объём эмиттера был бы
    // для купола радиусом в метры заведомо неверной целью. Выбор между ним и
    // объёмом, производным от записи, — отдельное решение, и здесь оно не
    // принято: поведение таких видов прежнее.
    const { assets, ctx } = makeRig();
    const models = new ModelsSubsystem(makeManifest(), { warn: () => {} });
    models.init({ ...ctx, assets: assets.service });
    // Рядом — тип, о котором манифест не говорит ничего. Он позируется тем же
    // кадром и прокси даёт, поэтому «прокси нет» у `Fireball` — это решение о
    // нём, а не непозированный инстанс.
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Fireball' }), makeEntityView(2, { kind: 'Ghost' })]),
    );
    models.updateFrame(0.016, 1);

    const proxy: PickProxy = createPickProxy();
    expect(models.proxyOf(2, proxy)).toBe(true);
    expect(models.proxyOf(1, proxy)).toBe(false);
  });
});

// ---------------------------------------------------------------- находки §2.6

describe('EffectsSubsystem: возраст события доставки (REND-23, SHELL-4) — V-1', () => {
  /** Манифест с одной вспышкой известной длительности: 400 мс. */
  function flashManifest(): VisualManifest {
    return {
      entities: {},
      effects: {
        byEvent: {
          Boom: {
            primitive: 'sphere',
            color: '#ff4020',
            radius: 1,
            radiusTo: 3,
            durationMs: 400,
            height: 0,
          },
        },
      },
    };
  }

  function makeAgedRig() {
    const assets = makeAssets();
    const scene = new THREE.Scene();
    const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 1 } };
    const warnings: string[] = [];
    const subsystem = new EffectsSubsystem(flashManifest(), {
      // Шаг тика 100 мс: четыре тика — ровно длительность вспышки.
      tickSeconds: 0.1,
      warn: (m) => warnings.push(m),
    });
    subsystem.init(ctx);
    return { subsystem, warnings };
  }

  /** Событие тика `tick` в точке (0,0). */
  const boom = (tick: number) => ({ type: 'Boom', tick, data: { x: 0, y: 0 } });

  it('пачка событий разных тиков стартует с РАЗНЫМ возрастом, а не одним кадром', () => {
    const { subsystem } = makeAgedRig();
    // Доставка тика 10 несёт события тиков 10, 9 и 8: конфляция отправителя
    // (SHELL-4). Возрасты — 0, 100 и 200 мс при длительности 400.
    subsystem.syncTick(
      makeTickView([], {
        tick: 10,
        freshEvents: true,
        events: [boom(10), boom(9), boom(8)],
      }),
    );
    expect(subsystem.activeCount).toBe(3);

    // Радиус растёт линейно 1 → 3, значит фаза видна в масштабе меша.
    const scales = subsystem.pooledCount; // просто зафиксировать, что пул завёл три меша
    expect(scales).toBe(3);

    // 150 мс кадров: старший дожил до 350 из 400 — живы все трое.
    subsystem.updateFrame(0.15, 1);
    expect(subsystem.activeCount).toBe(3);
    // Ещё 100 мс: старший (200 + 250 = 450) отжил, двое младших живы.
    subsystem.updateFrame(0.1, 1);
    expect(subsystem.activeCount).toBe(2);
    // И ещё 60 мс: средний (100 + 310 = 410) отжил, младший (310) жив.
    subsystem.updateFrame(0.06, 1);
    expect(subsystem.activeCount).toBe(1);
  });

  it('отжившее к доставке событие не проигрывается вовсе', () => {
    const { subsystem } = makeAgedRig();
    // Пять тиков по 100 мс — 500 мс при длительности 400.
    subsystem.syncTick(
      makeTickView([], { tick: 10, freshEvents: true, events: [boom(5)] }),
    );
    expect(subsystem.activeCount).toBe(0);
    // И пула он не тронул: меш не заводился.
    expect(subsystem.pooledCount).toBe(0);
  });

  it('событие без тика (документный источник) идёт с нуля', () => {
    const { subsystem } = makeAgedRig();
    subsystem.syncTick(
      makeTickView([], { tick: 10, freshEvents: true, events: [{ type: 'Boom', data: { x: 0, y: 0 } }] }),
    );
    expect(subsystem.activeCount).toBe(1);
    // Полная длительность впереди: 390 мс кадров её не исчерпывают.
    subsystem.updateFrame(0.39, 1);
    expect(subsystem.activeCount).toBe(1);
  });
});

describe('EffectsSubsystem: точка события и пустой словарь состояний — V-9, V-10', () => {
  it('пустой список состояний сборки — законная сборка: таблица byState молча пропускается', () => {
    // Вьюпорт редактора (ED-15) тика в кадре правки не имеет, и словаря
    // состояний у него нет вовсе. Прежде эффекты печатали предупреждение на
    // каждое открытие сцены, а частицы — молчали; трактовка теперь одна.
    const assets = makeAssets();
    const warnings: string[] = [];
    const subsystem = new EffectsSubsystem(makeManifest(), { warn: (m) => warnings.push(m) });
    subsystem.init({
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 1 },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Hero', states: 0xff })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('незеркалируемое состояние обругано один раз на ИМЯ, а не на сущность × доставку', () => {
    const { subsystem, warnings } = makeRig({
      entities: {},
      effects: { byState: { Burning: { primitive: 'sphere', color: '#f80', radius: 0.5 } } },
    });
    const crowd = [1, 2, 3, 4, 5].map((id) => makeEntityView(id, { states: 0xff }));
    for (let i = 0; i < 3; i++) subsystem.syncTick(makeTickView(crowd));
    expect(warnings.filter((m) => m.includes('Burning'))).toHaveLength(1);
  });

  it('событие только с `target` играет: поля сущностей события — четыре (filter.ts)', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(
      makeTickView([makeEntityView(7, { kind: 'Hero', currX: 4, currY: 5, prevX: 4, prevY: 5 })], {
        freshEvents: true,
        events: [{ type: 'FireballExploded', tick: 1, data: { target: 7 } }],
      }),
    );
    expect(subsystem.activeCount).toBe(1);
  });

  it('событие без координат и без доставленной сущности — предупреждение один раз', () => {
    const { subsystem, warnings } = makeRig();
    for (let i = 0; i < 3; i++) {
      subsystem.syncTick(
        makeTickView([], { freshEvents: true, events: [{ type: 'FireballExploded', tick: 1, data: {} }] }),
      );
    }
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((m) => m.includes('FireballExploded'))).toHaveLength(1);
  });
});

describe('EffectsSubsystem: масштаб размещения и ведение статом (REND-23) — V-10', () => {
  it('оболочка учитывает `EntityView.scale`, как эмиттер частиц', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball', scale: 3 })]));
    subsystem.updateFrame(0.016, 1);
    // Радиус записи 0.25 × множитель размещения 3.
    expect(subsystem.effectFor(1)!.object.scale.x).toBeCloseTo(0.75, 6);
  });

  /** Манифест шара заряда: окно стата, вынос вперёд, порог цвета и мигание. */
  function chargeManifest(): VisualManifest {
    return {
      entities: {},
      effects: {
        byState: {
          Charging: {
            primitive: 'sphere',
            color: '#ff8a3c',
            radius: 0.15,
            alpha: 0.8,
            height: 0.3,
            offset: 0.5,
            radiusFromStat: { stat: 'charge', min: 1, max: 61, from: 1, to: 2 },
            colorAt: { phase: 0.5, color: '#ff7020' },
            blink: { periodMs: 180, alpha: 0.4 },
          },
        },
      },
    };
  }

  /** Сущность с состоянием `Charging` (бит 0 списка стенда) и статом заряда. */
  function charging(ticks: number | undefined, aim: number | null = 0) {
    const stats = ticks === undefined ? undefined : new Map([['charge', ticks]]);
    return makeEntityView(1, {
      kind: 'Hero',
      states: 1,
      aimYaw: aim,
      ...(stats === undefined ? {} : { stats }),
    });
  }

  function makeChargeRig() {
    const assets = makeAssets();
    const subsystem = new EffectsSubsystem(chargeManifest(), {
      stateComponents: ['Charging'],
      warn: () => {},
    });
    subsystem.init({
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 1 },
    });
    return subsystem;
  }

  it('радиус растёт по окну стата, а вынос идёт по доставленному прицелу', () => {
    const subsystem = makeChargeRig();
    subsystem.syncTick(makeTickView([charging(1)]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.effectFor(1, 'state:Charging')!.object;
    // Начало окна: множитель 1 — радиус записи как он есть.
    expect(object.scale.x).toBeCloseTo(0.15, 6);
    // Вынос вперёд по прицелу (0 радиан — вдоль +X).
    expect(object.position.x).toBeCloseTo(0.5, 6);
    expect(object.position.z).toBeCloseTo(0.3, 6);

    // Половина окна: множитель 1.5.
    subsystem.syncTick(makeTickView([charging(31)]));
    subsystem.updateFrame(0.016, 1);
    expect(object.scale.x).toBeCloseTo(0.15 * 1.5, 6);

    // Конец окна и дальше: множитель 2 и не больше — заряд сверх окна не растёт.
    subsystem.syncTick(makeTickView([charging(61)]));
    subsystem.updateFrame(0.016, 1);
    expect(object.scale.x).toBeCloseTo(0.3, 6);
    subsystem.syncTick(makeTickView([charging(200)]));
    subsystem.updateFrame(0.016, 1);
    expect(object.scale.x).toBeCloseTo(0.3, 6);
  });

  it('порог цвета берётся с названной фазы окна, а не плавным переходом', () => {
    const subsystem = makeChargeRig();
    const material = () =>
      (subsystem.effectFor(1, 'state:Charging')!.object as THREE.Mesh)
        .material as THREE.MeshBasicMaterial;

    subsystem.syncTick(makeTickView([charging(30)])); // фаза 0.483 — ещё базовый
    subsystem.updateFrame(0.016, 1);
    expect(material().color.getHexString()).toBe('ff8a3c');

    subsystem.syncTick(makeTickView([charging(31)])); // фаза 0.5 — порог взят
    subsystem.updateFrame(0.016, 1);
    expect(material().color.getHexString()).toBe('ff7020');

    // И обратно: заряд сброшен — цвет вернулся.
    subsystem.syncTick(makeTickView([charging(2)]));
    subsystem.updateFrame(0.016, 1);
    expect(material().color.getHexString()).toBe('ff8a3c');
  });

  it('за концом окна шар мигает; часы презентации стоят — мигание замирает', () => {
    const subsystem = makeChargeRig();
    const opacity = () =>
      (
        (subsystem.effectFor(1, 'state:Charging')!.object as THREE.Mesh)
          .material as THREE.MeshBasicMaterial
      ).opacity;

    subsystem.syncTick(makeTickView([charging(61)]));
    subsystem.updateFrame(0, 1); // часы на нуле — тёмная половина цикла
    expect(opacity()).toBeCloseTo(0.8 * 0.4, 6);
    subsystem.updateFrame(0.1, 1); // 100 мс — светлая половина (полупериод 90)
    expect(opacity()).toBeCloseTo(0.8, 6);

    // Внутри окна мигания нет вовсе.
    subsystem.syncTick(makeTickView([charging(30)]));
    subsystem.updateFrame(0.1, 1);
    expect(opacity()).toBeCloseTo(0.8, 6);
  });

  it('стата в доставленном состоянии нет — оболочка рисуется числами записи', () => {
    const subsystem = makeChargeRig();
    subsystem.syncTick(makeTickView([charging(undefined)]));
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.effectFor(1, 'state:Charging')!.object;
    expect(object.scale.x).toBeCloseTo(0.15, 6);
    expect(((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.8, 6);
  });

  it('прицела нет — вынос идёт по курсу движения (REND-2)', () => {
    const subsystem = makeChargeRig();
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Hero', states: 1, aimYaw: null, facingYaw: Math.PI / 2 })]),
    );
    subsystem.updateFrame(0.016, 1);
    const object = subsystem.effectFor(1, 'state:Charging')!.object;
    expect(object.position.x).toBeCloseTo(0, 6);
    expect(object.position.y).toBeCloseTo(0.5, 6);
  });
});

describe('createStateReader: колбэк промаха зовётся один раз на имя — V-9', () => {
  it('второй и третий промах того же имени колбэка не будят', () => {
    // Колбэк вызывающего строит ДВЕ шаблонные строки (ключ и текст) до дедупа
    // `warnOnce`, а читатель зовётся на каждый источник каждой сущности каждой
    // доставки — 30 Гц. Память о промахе живёт здесь, а не в дедупе текста.
    const said: string[] = [];
    const read = createStateReader(['Falling'], (name) => said.push(name));
    const view = makeEntityView(1, { states: 0xff });
    for (let i = 0; i < 5; i++) {
      expect(read(view, 'Burning')).toBe(false);
      expect(read(view, 'Poisoned')).toBe(false);
    }
    expect(said).toEqual(['Burning', 'Poisoned']);
    // Зеркалируемое имя читается как обычно и колбэка не трогает.
    expect(read(view, 'Falling')).toBe(true);
    expect(said).toHaveLength(2);
  });
});

describe('stateTableNames: пустой словарь сборки — короткое замыкание — V-9', () => {
  it('без списка состояний сборки таблица byState не перечисляется вовсе', () => {
    const table = { Shielded: {}, Burning: {} };
    expect(stateTableNames(table, [])).toHaveLength(0);
    expect(stateTableNames(undefined, ['Shielded'])).toHaveLength(0);
    expect(stateTableNames(table, ['Shielded'])).toEqual(['Shielded', 'Burning']);
  });
});
