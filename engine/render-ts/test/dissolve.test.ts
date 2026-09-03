/**
 * Растворение трупа (REND-4, ASSET-6): после фиксации последнего кадра клипа
 * смерти инстанс выжидает авторскую задержку, растворяется прозрачностью тем же
 * каналом, что и уход в туман (FOW-8), и уходит из КАДРА — оставаясь в
 * доставленном состоянии, пока `Dead` с сущности не снимет сцена.
 *
 * Возврат проверяется всеми тремя дорогами, которыми сущность перестаёт быть
 * мёртвой: событие возрождения, снятый маркер состояния и разрыв непрерывности.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
/** Бит состояния смерти в `EntityView.states` (CAM-6, SHELL-2). */
const DEAD_BIT = 1;

function makeManifest(dissolve: { delay?: number; duration: number } | null): VisualManifest {
  const entry: VisualManifest['entities'][string] = {
    model: MODEL_ID,
    animations: { states: { idle: 'Stand' }, events: { EntityDied: 'Death' } },
  };
  if (dissolve !== null) entry.dissolve = dissolve;
  return { entities: { Runner: entry } };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
}

function makeRig(
  dissolve: { delay?: number; duration: number } | null = { delay: 0.5, duration: 1 },
  options: { readonly reviveEvent?: string; readonly fadeSeconds?: number } = {},
): Rig {
  const assets = makeAssets();
  const subsystem = new ModelsSubsystem(makeManifest(dissolve), {
    ...options,
    stateComponents: ['Dead'],
    deadState: 'Dead',
    warn: () => {},
  });
  subsystem.init({
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  });
  assets.resolve('model', MODEL_ID, makeModel());
  return { subsystem };
}

/** Доля проявленности записи в инстанс-буфере батча (FOW-8, REND-4). */
function fadeAttribute(subsystem: ModelsSubsystem): number | undefined {
  const mesh = subsystem.batchMeshes()[0];
  if (mesh === undefined) return undefined;
  return (mesh.geometry.getAttribute('instanceFade').array as Float32Array)[0];
}

/** Доставка живой сущности; `dead` поднимает маркер состояния (REND-4). */
function tick(dead: boolean, partial: Parameters<typeof makeTickView>[1] = {}) {
  return makeTickView([makeEntityView(1, { states: dead ? DEAD_BIT : 0 })], partial);
}

/** Гибель на глазах: маркер состояния плюс событие того же тика. */
function deathTick() {
  return tick(true, { events: [{ type: 'EntityDied', data: { entity: 1 } }], freshEvents: true });
}

describe('растворение трупа (REND-4)', () => {
  it('выжидает задержку, растворяется и уходит из кадра, оставаясь в доставке', () => {
    const { subsystem } = makeRig({ delay: 0.5, duration: 1 });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(0.1, 1);
    // Задержка идёт — труп цел и нарисован.
    expect(fadeAttribute(subsystem)).toBeCloseTo(1, 6);

    subsystem.updateFrame(0.4, 1); // задержка кончилась ровно сейчас
    subsystem.updateFrame(0.5, 1); // половина растворения
    expect(fadeAttribute(subsystem)).toBeCloseTo(0.5, 5);

    subsystem.updateFrame(0.5, 1); // растворение доиграно
    // Нарисованного нет: батч отпустил запись, и рисовать ему нечего.
    expect(subsystem.batchStats().records).toBe(0);
    // Инстанс в наборе остался: `Dead` с сущности снимает сцена, а не рендер.
    expect(subsystem.instanceFor(1)).not.toBeNull();
    expect(subsystem.instanceFor(1)!.model).toBeNull();
  });

  it('запись без блока не растворяется вовсе — прежнее поведение', () => {
    const { subsystem } = makeRig(null);
    subsystem.syncTick(deathTick());
    for (let i = 0; i < 60; i++) subsystem.updateFrame(0.1, 1);
    expect(fadeAttribute(subsystem)).toBeCloseTo(1, 6);
    expect(subsystem.batchStats().records).toBe(1);
  });

  it('событие возрождения посреди растворения собирает труп обратно', () => {
    const { subsystem } = makeRig({ duration: 1 }, { reviveEvent: 'HeroRespawned' });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(0.4, 1);
    expect(fadeAttribute(subsystem)).toBeCloseTo(0.6, 5);

    subsystem.syncTick(
      tick(false, { events: [{ type: 'HeroRespawned', data: { entity: 1 } }], freshEvents: true }),
    );
    subsystem.updateFrame(1 / 60, 1);
    // Возвращается МГНОВЕННО, а не обратным ходом растворения: возрождение —
    // возвращение в бой, а не перемотка похорон.
    expect(fadeAttribute(subsystem)).toBeCloseTo(1, 6);
  });

  it('снятый маркер состояния возвращает уже РАСТВОРИВШИЙСЯ инстанс в кадр', () => {
    const { subsystem } = makeRig({ duration: 0.5 });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(0.6, 1);
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.model).toBeNull();
    expect(subsystem.batchStats().records).toBe(0);

    subsystem.syncTick(tick(false));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats().records).toBe(1);
    expect(fadeAttribute(subsystem)).toBeCloseTo(1, 6);
  });

  it('разрыв непрерывности (snapAll) возвращает труп в кадр (REND-2)', () => {
    const { subsystem } = makeRig({ duration: 0.5 });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(0.6, 1);
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats().records).toBe(0);

    // Перемотка через момент смерти: сущность в мире снова жива, а `EntityDied`
    // в прошлом не разэмитится — фиксацию снимает сам разрыв.
    subsystem.syncTick(tick(false, { snapAll: true }));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats().records).toBe(1);
  });

  it('уход в туман посреди растворения перемножает обе доли (FOW-8)', () => {
    // Задержка растворения покрывает прогревочный кадр: первый кадр после
    // появления доигрывает короткий fade-in до единицы (FOW-8), и мерить обе
    // доли надо уже после него.
    const { subsystem } = makeRig({ delay: 1, duration: 1 }, { fadeSeconds: 1 });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(1, 1);
    expect(fadeAttribute(subsystem)).toBeCloseTo(1, 6);
    subsystem.syncTick(tick(true));
    subsystem.updateFrame(0.5, 1);
    expect(fadeAttribute(subsystem)).toBeCloseTo(0.5, 5);

    // Сущность выпала из доставки без события смерти в ЭТОМ тике: уход в туман.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(0.25, 1);
    // Растворение 0.25 × проявленность 0.75 — бледнее каждой из долей по
    // отдельности.
    expect(fadeAttribute(subsystem)).toBeCloseTo(0.25 * 0.75, 5);
  });

  it('снятая переподачей запись блока собирает труп обратно (REND-17)', () => {
    const { subsystem } = makeRig({ duration: 0.5 });
    subsystem.syncTick(deathTick());
    subsystem.updateFrame(0.6, 1);
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats().records).toBe(0);

    subsystem.applyManifest(makeManifest(null));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats().records).toBe(1);
  });
});
