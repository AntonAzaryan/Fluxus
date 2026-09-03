/**
 * Отсечение работы VFX по камере и потолок дробления наземных фигур
 * (REND-23, REND-24, REND-43, QUAL-1, QUAL-3).
 *
 * Проверяется наблюдаемое и СЧЁТНОЕ: эмиттер за кромкой кадра не шагает своей
 * системой частиц, наземная фигура за кромкой не переписывает вершин, обе
 * экономии видны счётчиками стока стоимости (PERF-3), а сборка без камеры
 * делает ровно ту же работу, что делала до отсечения. Потолок дробления
 * (`effects.shapeDetail`) делает фигуру грубее, не меняя её формы (QUAL-2).
 *
 * Отсечение здесь — стоимость, а не поведение: ни одна частица им не гасится и
 * ни одна зона не пропадает — за кромкой кадра их и так никто не видит.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import type { ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  ParticlesSubsystem,
  VisualSurfaceSource,
  createCostCounters,
  withCostSink,
  type QualityValues,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

/** Документ зацикленного факела — тот же, которым живут прочие тесты частиц. */
const TORCH = 'vfx/torch.effect.json';
const torchDoc = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/torch.effect.json', import.meta.url)), 'utf8'),
) as ParticleEffectDocument;

/**
 * Камера стенда, смотрящая в начало координат: мир Z-вверх, поэтому «верх»
 * камеры — ось Z, как её ставит поза кадра сборки (CAM-1).
 */
function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -12, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/**
 * Камера, смотрящая ВДОЛЬ поля: далёкая точка на его оси остаётся в пирамиде
 * кадра, и отсечь её вправе только предел расстояния — вход ручки.
 */
function makeFlatCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -10, 0);
  camera.lookAt(0, 100, 0);
  camera.updateMatrixWorld();
  return camera;
}

function makeValues(entries: Record<string, number>): QualityValues {
  return new Map(Object.entries(entries));
}

// ------------------------------------------------ 1: эмиттеры частиц (REND-24)

const EMITTER_MANIFEST: VisualManifest = {
  entities: {},
  particles: { byKind: { Torch: { effect: TORCH } } },
};

function makeParticlesRig(camera?: THREE.Camera) {
  const assets = makeAssets();
  assets.resolve('particle-effect', TORCH, torchDoc);
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ParticlesSubsystem(EMITTER_MANIFEST, {
    stateComponents: [],
    ...(camera === undefined ? {} : { camera }),
    warn: () => {},
  });
  subsystem.init(ctx);
  return subsystem;
}

/** Оболочка эмиттера в точке `(x, y)` — вход обоих правил отсечения. */
function placeEmitter(subsystem: ParticlesSubsystem, x: number, y: number): void {
  subsystem.syncTick(
    makeTickView([
      makeEntityView(1, { kind: 'Torch', currX: x, prevX: x, currY: y, prevY: y }),
    ]),
  );
}

/** Кадры со стоком стоимости: считаем ровно ту работу, что кадр и сделал. */
function frames(subsystem: { updateFrame(dt: number, alpha: number): void }, count = 4) {
  const counters = createCostCounters();
  withCostSink(counters, () => {
    for (let i = 0; i < count; i++) subsystem.updateFrame(0.1, 1);
  });
  return counters;
}

describe('Эмиттер вне кадра не шагает своей системой частиц (REND-24, QUAL-3)', () => {
  it('за кромкой кадра: ни одного шага системы, и экономия названа счётчиком', () => {
    const subsystem = makeParticlesRig(makeCamera());
    // Далеко ЗА СПИНОЙ камеры: ни пирамида, ни запас вокруг якоря сюда не
    // дотягиваются.
    placeEmitter(subsystem, 0, 400);

    const counters = frames(subsystem);

    expect(counters.particlesShellsCulled).toBe(4);
    expect(counters.particlesSystemsStepped).toBe(0);
    // Оболочка при этом ЖИВА: отсечение — стоимость, а не гашение (REND-24).
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.particleCount).toBe(0);
  });

  it('в кадре: система шагает и частицы появляются', () => {
    const subsystem = makeParticlesRig(makeCamera());
    placeEmitter(subsystem, 0, 0);

    const counters = frames(subsystem);

    expect(counters.particlesShellsCulled).toBe(0);
    expect(counters.particlesSystemsStepped).toBeGreaterThan(0);
    expect(subsystem.particleCount).toBeGreaterThan(0);
  });

  it('вернувшись в кадр, эмиттер продолжает с того же места: пауза ничего не гасит', () => {
    const subsystem = makeParticlesRig(makeCamera());
    placeEmitter(subsystem, 0, 0);
    frames(subsystem, 4);
    const played = subsystem.particleCount;
    expect(played).toBeGreaterThan(0);

    // Уходит за кромку и возвращается: живые частицы всё это время на месте.
    placeEmitter(subsystem, 0, 400);
    frames(subsystem, 4);
    expect(subsystem.particleCount).toBe(played);
    placeEmitter(subsystem, 0, 0);
    frames(subsystem, 2);
    expect(subsystem.particleCount).toBeGreaterThanOrEqual(played);
  });

  it('сборка без камеры отсечения не имеет вовсе (headless, вьюпорт без позы)', () => {
    const subsystem = makeParticlesRig();
    placeEmitter(subsystem, 0, 400);

    const counters = frames(subsystem);

    expect(counters.particlesShellsCulled).toBe(0);
    expect(counters.particlesSystemsStepped).toBeGreaterThan(0);
  });

  it('ручка дальности гасит ВИДИМЫЙ, но далёкий эмиттер (QUAL-1, particles.cullDistance)', () => {
    const subsystem = makeParticlesRig(makeFlatCamera());
    // В пирамиде кадра, но за сотню единиц от глаза: умолчание ручки — «предела
    // нет», и такой эмиттер шагает.
    placeEmitter(subsystem, 0, 90);
    expect(frames(subsystem).particlesShellsCulled).toBe(0);

    subsystem.applyQuality(makeValues({ 'particles.cullDistance': 20 }));

    expect(frames(subsystem).particlesShellsCulled).toBe(4);
  });
});

// ------------------------------------------- 2: наземные фигуры (REND-43)

/** Арена со ступенью: под фигурой есть чему дробиться (design D2). */
const LEVELS = ['0011', '0011', '0011', '0011'];

const ZONE: VisualManifest = {
  entities: {},
  effects: { byKind: { Zone: { primitive: 'disc', color: '#6fd3ff', radius: 1.5, alpha: 0.4 } } },
};

function makeEffectsRig(camera?: THREE.Camera, manifest: VisualManifest = ZONE) {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 2 },
  };
  const grid: TerrainGrid = createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: [...LEVELS],
    flags: Array.from({ length: 4 }, () => '....'),
  });
  const source = new VisualSurfaceSource(grid);
  source.init(ctx);
  const subsystem = new EffectsSubsystem(manifest, {
    surface: source,
    stateComponents: [],
    ...(camera === undefined ? {} : { camera }),
    warn: () => {},
  });
  subsystem.init(ctx);
  return subsystem;
}

function placeZone(subsystem: EffectsSubsystem, x: number, y: number): void {
  subsystem.syncTick(
    makeTickView([makeEntityView(1, { kind: 'Zone', currX: x, prevX: x, currY: y, prevY: y })]),
  );
}

describe('Наземная фигура вне кадра не переписывает вершин (REND-43)', () => {
  it('за кромкой кадра: ни одной вершины, меш погашен, экономия названа счётчиком', () => {
    const subsystem = makeEffectsRig(makeCamera());
    placeZone(subsystem, 0, 400);

    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.updateFrame(0.016, 1);
    });

    expect(counters.effectsShapesCulled).toBe(1);
    expect(counters.effectsShapeVertices).toBe(0);
    expect(subsystem.effectFor(1)!.object.visible).toBe(false);
    // Эффект при этом ЖИВ: доставленное состояние его не теряло (REND-23).
    expect(subsystem.activeCount).toBe(1);
  });

  it('в кадре: вершины переписаны, счётчик отсечения пуст, меш виден', () => {
    const subsystem = makeEffectsRig(makeCamera());
    placeZone(subsystem, 1, 1);

    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.updateFrame(0.016, 1);
    });

    expect(counters.effectsShapesCulled).toBe(0);
    expect(counters.effectsShapeVertices).toBeGreaterThan(0);
    expect(subsystem.effectFor(1)!.object.visible).toBe(true);
  });

  it('сборка без камеры отсечения не имеет вовсе', () => {
    const subsystem = makeEffectsRig();
    placeZone(subsystem, 0, 400);

    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.updateFrame(0.016, 1);
    });

    expect(counters.effectsShapesCulled).toBe(0);
    expect(counters.effectsShapeVertices).toBeGreaterThan(0);
  });

  it('вспышка за кромкой кадра тоже вершин не переписывает (REND-23)', () => {
    const subsystem = makeEffectsRig(makeCamera(), {
      entities: {},
      effects: {
        byEvent: {
          Boom: { primitive: 'ring', color: '#fff', radius: 1, radiusTo: 3, durationMs: 500 },
        },
      },
    });
    subsystem.syncTick(
      makeTickView([], {
        freshEvents: true,
        events: [{ type: 'Boom', tick: 1, data: { x: 0, y: 400 } }],
      }),
    );

    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.updateFrame(0.016, 1);
    });

    expect(counters.effectsShapesCulled).toBeGreaterThan(0);
    expect(counters.effectsShapeVertices).toBe(0);
  });
});

/** Габариты фигуры по её мировым вершинам, округлённые до сотых. */
function extentOf(subsystem: EffectsSubsystem): Record<string, number> {
  const attribute = (subsystem.effectFor(1)!.object as THREE.Mesh).geometry.getAttribute(
    'position',
  );
  const round = (value: number): number => Math.round(value * 100) / 100;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < attribute.count; i++) {
    minX = Math.min(minX, attribute.getX(i));
    maxX = Math.max(maxX, attribute.getX(i));
    minY = Math.min(minY, attribute.getY(i));
    maxY = Math.max(maxY, attribute.getY(i));
  }
  return { minX: round(minX), maxX: round(maxX), minY: round(minY), maxY: round(maxY) };
}

describe('Потолок дробления наземных фигур (QUAL-1, effects.shapeDetail)', () => {
  it('грубее — меньше вершин, а форма и место те же (QUAL-2)', () => {
    const authored = makeEffectsRig();
    placeZone(authored, 1, 1);
    authored.updateFrame(0.016, 1);
    const rich = (authored.effectFor(1)!.object as THREE.Mesh).geometry.getAttribute('position')
      .count;

    const capped = makeEffectsRig();
    capped.applyQuality(makeValues({ 'effects.shapeDetail': 1 }));
    placeZone(capped, 1, 1);
    capped.updateFrame(0.016, 1);
    const poor = (capped.effectFor(1)!.object as THREE.Mesh).geometry.getAttribute('position').count;

    expect(rich).toBeGreaterThan(poor);
    // Место и РАЗМЕР фигуры от потолка не зависят: зона накрывает те же клетки,
    // потолок правит лишь дробление внутри неё (QUAL-2).
    expect(extentOf(capped)).toEqual(extentOf(authored));
  });

  it('смена потолка переснимает ЖИВЫЕ оболочки: топология фиксируется взятием (REND-26)', () => {
    const subsystem = makeEffectsRig();
    placeZone(subsystem, 1, 1);
    subsystem.updateFrame(0.016, 1);
    const before = (subsystem.effectFor(1)!.object as THREE.Mesh).geometry.getAttribute('position')
      .count;

    subsystem.applyQuality(makeValues({ 'effects.shapeDetail': 1 }));
    subsystem.updateFrame(0.016, 1);

    const after = (subsystem.effectFor(1)!.object as THREE.Mesh).geometry.getAttribute('position')
      .count;
    expect(after).toBeLessThan(before);
  });
});
