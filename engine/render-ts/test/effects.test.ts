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
import { EffectsSubsystem, ModelsSubsystem, type RenderContext } from '../src/index.js';
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
      effects: { byKind: { Ghost: { primitive: 'ribbon', color: '#fff', radius: 1 } } },
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' })]));
    subsystem.syncTick(makeTickView([makeEntityView(2, { kind: 'Ghost' })]));
    expect(subsystem.activeCount).toBe(0);
    expect(warnings.filter((message) => message.includes('ribbon'))).toHaveLength(1);
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
});
