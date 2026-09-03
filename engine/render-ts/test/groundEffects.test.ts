/**
 * Наземные примитивы, лучи и ленты подсистемы эффектов (REND-43, REND-23).
 *
 * Проверяется наблюдаемое: фигура ЛЕЖИТ на визуальной поверхности — её вершины
 * совпадают с полем в своих точках и на ступени обрыва, и на кривизне (REND-9);
 * луч тянется от сущности к цели доставленного стата и гаснет, когда цели нет;
 * лента строится по недавним позициям, гаснет к хвосту и сбрасывается разрывом
 * непрерывности (REND-2). Место среди прозрачных и тест глубины — там же:
 * телеграф обязан читаться сквозь воду и прятаться за обрывом (design D3).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type EntityId, type TerrainGrid } from '@fluxus/core';
import { validateCurvatureMap, type TerrainCurvatureMap, type VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  VisualSurfaceSource,
  WATER_RENDER_ORDER,
  createCostCounters,
  withCostSink,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

/** Шаг высоты уровня стенда: ступень обрыва видна в числах, а не в шуме. */
const STEP = 2;

function grid(levels: readonly string[]): TerrainGrid {
  const height = levels.length;
  const width = levels[0]!.length;
  return createTerrainGrid({
    width,
    height,
    tileSize: FIXED_ONE,
    levels: [...levels],
    flags: Array.from({ length: height }, () => '.'.repeat(width)),
  });
}

function curvature(width: number, height: number, rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

/** Арена со ступенью: левая половина на уровне 0, правая — на уровне 1. */
const STEPPED = ['00111', '00111', '00111', '00111', '00111'];
/** Ровная арена того же размера — фон для проверок без рельефа. */
const FLAT = ['00000', '00000', '00000', '00000', '00000'];

interface RigOptions {
  readonly levels?: readonly string[];
  readonly curvatureMap?: TerrainCurvatureMap;
  readonly tessellation?: number;
}

function makeRig(manifest: VisualManifest, options: RigOptions = {}) {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = {
    scene,
    assets: assets.service,
    config: {
      heightStep: STEP,
      ...(options.tessellation === undefined ? {} : { curvatureTessellation: options.tessellation }),
    },
  };
  const source = new VisualSurfaceSource(grid(options.levels ?? FLAT));
  source.init(ctx);
  if (options.curvatureMap !== undefined) source.setCurvature(options.curvatureMap);
  const warnings: string[] = [];
  const subsystem = new EffectsSubsystem(manifest, {
    surface: source,
    stateComponents: ['Slowed'],
    warn: (m) => warnings.push(m),
  });
  subsystem.init(ctx);
  return { subsystem, scene, warnings, source };
}

/** Меш эффекта сущности; у наземной фигуры вершины МИРОВЫЕ (REND-43). */
function meshOf(subsystem: EffectsSubsystem, entity: EntityId): THREE.Mesh {
  return subsystem.effectFor(entity)!.object as THREE.Mesh;
}

/** Позиции вершин фигуры как тройки. */
function verticesOf(mesh: THREE.Mesh): { x: number; y: number; z: number }[] {
  const attribute = mesh.geometry.getAttribute('position');
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < attribute.count; i++) {
    out.push({ x: attribute.getX(i), y: attribute.getY(i), z: attribute.getZ(i) });
  }
  return out;
}

/** Альфа вершин фигуры. */
function alphasOf(mesh: THREE.Mesh): number[] {
  const attribute = mesh.geometry.getAttribute('color');
  const out: number[] = [];
  for (let i = 0; i < attribute.count; i++) out.push(attribute.getW(i));
  return out;
}

const DISC: VisualManifest = {
  entities: {},
  effects: {
    byKind: {
      Zone: { primitive: 'disc', color: '#6fd3ff', radius: 1.5, alpha: 0.4, edgeSoftness: 0.25 },
    },
  },
};

describe('Наземная фигура лежит на визуальной поверхности (REND-43)', () => {
  it('каждая вершина диска сидит на поле в своей точке', () => {
    const { subsystem, source } = makeRig(DISC);
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Zone', currX: 2, prevX: 2, currY: 2, prevY: 2 })]),
    );
    subsystem.updateFrame(0.016, 1);

    const surface = source.current!;
    const vertices = verticesOf(meshOf(subsystem, 1));
    expect(vertices.length).toBeGreaterThan(8);
    for (const vertex of vertices) {
      // Подъём над полем — единственная разница: совпадение с полом дало бы
      // z-fighting, а не изображение.
      expect(vertex.z - surface.heightAt(vertex.x, vertex.y)).toBeCloseTo(0.02, 6);
    }
  });

  it('диск на обрыве СТУПАЕТ: вершины двух уровней стоят на своих полах', () => {
    // Ровно тот случай, ради которого сфера и не годилась: половина зоны на
    // плато, половина под ним.
    const { subsystem } = makeRig(DISC, { levels: STEPPED });
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Zone', currX: 2, prevX: 2, currY: 2, prevY: 2 })]),
    );
    subsystem.updateFrame(0.016, 1);

    const vertices = verticesOf(meshOf(subsystem, 1));
    const heights = new Set(vertices.map((v) => Math.round(v.z * 1000) / 1000));
    // Две ступени — две высоты в буфере: плоская фигура дала бы одну. И обе —
    // полы своих уровней плюс подъём записи, а не что-то среднее между ними.
    // Сверка идёт с уровнями, а не с `heightAt` вершины: координаты живут в
    // буфере float32, и вершина, севшая ровно на границу клеток, читается
    // обратно то с одной её стороны, то с другой.
    expect(heights).toEqual(new Set([0.02, STEP + 0.02]));
  });

  it('на кривизне фигура дробится тесселяцией конфига (REND-9)', () => {
    // Карта кривизны узловая: рядов и узлов на один больше, чем клеток.
    const rows = [
      [0, 0, 0, 0, 0, 0],
      [0, 4, 4, 4, 0, 0],
      [0, 4, 4, 4, 0, 0],
      [0, 4, 4, 4, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ];
    const coarse = makeRig(DISC, { curvatureMap: curvature(5, 5, rows), tessellation: 1 });
    const fine = makeRig(DISC, { curvatureMap: curvature(5, 5, rows), tessellation: 4 });
    for (const rig of [coarse, fine]) {
      rig.subsystem.syncTick(
        makeTickView([makeEntityView(1, { kind: 'Zone', currX: 2, prevX: 2, currY: 2, prevY: 2 })]),
      );
      rig.subsystem.updateFrame(0.016, 1);
    }
    // Дробление следует конфигу: тесселяция 4 даёт больше колец, чем 1.
    expect(verticesOf(meshOf(fine.subsystem, 1)).length).toBeGreaterThan(
      verticesOf(meshOf(coarse.subsystem, 1)).length,
    );
  });

  it('мягкость кромки гасит альфу вершин к краю, а центр оставляет плотным', () => {
    const { subsystem } = makeRig(DISC);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    subsystem.updateFrame(0.016, 1);
    const alphas = alphasOf(meshOf(subsystem, 1));
    expect(Math.max(...alphas)).toBeCloseTo(1, 6);
    expect(Math.min(...alphas)).toBeCloseTo(0, 6);
  });

  it('кольцо гаснет к ОБЕИМ кромкам, диск — только к внешней', () => {
    const ringRig = makeRig({
      entities: {},
      effects: {
        byKind: {
          Zone: {
            primitive: 'ring',
            color: '#fff',
            radius: 2,
            innerRadius: 1.4,
            edgeSoftness: 0.5,
          },
        },
      },
    });
    ringRig.subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    ringRig.subsystem.updateFrame(0.016, 1);
    const alphas = alphasOf(meshOf(ringRig.subsystem, 1));
    // Первая и последняя строка — внутренняя и внешняя кромка кольца.
    expect(alphas[0]).toBeCloseTo(0, 6);
    expect(alphas[alphas.length - 1]).toBeCloseTo(0, 6);
  });

  it('сектор занимает свой раствор и заякорен на сущности', () => {
    const { subsystem } = makeRig({
      entities: {},
      effects: {
        byKind: {
          Zone: { primitive: 'sector', color: '#fff', radius: 2, halfAngleDeg: 30 },
        },
      },
    });
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Zone', currX: 1, prevX: 1, currY: 1, prevY: 1, aimYaw: 0 }),
      ]),
    );
    subsystem.updateFrame(0.016, 1);
    const vertices = verticesOf(meshOf(subsystem, 1));
    // Вершина сектора — сама сущность: первая строка сетки сидит в её точке.
    expect(vertices[0]!.x).toBeCloseTo(1, 6);
    expect(vertices[0]!.y).toBeCloseTo(1, 6);
    // Раствор 60°: крайние вершины внешнего кольца отстоят на ±30° от курса.
    const outer = vertices.slice(-1)[0]!;
    expect(Math.atan2(outer.y - 1, outer.x - 1)).toBeCloseTo(Math.PI / 6, 5);
  });
});

describe('Наземная фигура в кадре: глубина и порядок (REND-43, design D3)', () => {
  it('рисуется после воды, тестируется по глубине и её не пишет', () => {
    const { subsystem } = makeRig(DISC);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    const mesh = meshOf(subsystem, 1);
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(mesh.renderOrder).toBeGreaterThan(WATER_RENDER_ORDER);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    // Вершины мировые: масштаб и позиция меша остаются нейтральными.
    expect(mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(mesh.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('переписанные вершины входят в сток стоимости (PERF-3)', () => {
    const { subsystem } = makeRig(DISC);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.updateFrame(0.016, 1);
    });
    // Вершины фигуры — покадровая работа подсистемы: сфера сюда не входит.
    expect(counters.effectsShapeVertices).toBeGreaterThan(0);

    const idle = createCostCounters();
    const { subsystem: spheres } = makeRig({
      entities: {},
      effects: { byKind: { Zone: { primitive: 'sphere', color: '#fff', radius: 1 } } },
    });
    spheres.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    withCostSink(idle, () => {
      spheres.updateFrame(0.016, 1);
    });
    expect(idle.effectsShapeVertices).toBe(0);
  });

  it('в picking не участвует: телеграф — изображение, а не сущность (REND-15)', () => {
    const { subsystem, scene } = makeRig(DISC);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Zone' })]));
    subsystem.updateFrame(0.016, 1);
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(scene, true)).toEqual([]);
  });
});

describe('Луч между сущностью и целью (REND-23, design D5)', () => {
  const BEAM: VisualManifest = {
    entities: {},
    effects: {
      byKind: {
        Caster: {
          primitive: 'beam',
          color: '#ff0',
          width: 0.4,
          height: 1,
          targetFromStat: 'link',
        },
      },
    },
  };

  const caster = (target: number | undefined) =>
    makeEntityView(1, {
      kind: 'Caster',
      currX: 1,
      prevX: 1,
      currY: 1,
      prevY: 1,
      ...(target === undefined ? {} : { stats: new Map([['link', target]]) }),
    });
  const victim = makeEntityView(2, { kind: 'Other', currX: 4, prevX: 4, currY: 1, prevY: 1 });

  it('концы луча — сущность и цель доставленного стата', () => {
    const { subsystem } = makeRig(BEAM);
    subsystem.syncTick(makeTickView([caster(2), victim]));
    subsystem.updateFrame(0.016, 1);

    const mesh = meshOf(subsystem, 1);
    expect(mesh.visible).toBe(true);
    const vertices = verticesOf(mesh);
    const xs = vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(1, 6);
    expect(Math.max(...xs)).toBeCloseTo(4, 6);
    // Ширина записи — поперёк отрезка: полуширина 0.2 по обе стороны.
    const ys = vertices.map((v) => v.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.4, 6);
    // Высота записи над полем — у обоих концов.
    for (const vertex of vertices) expect(vertex.z).toBeCloseTo(1, 6);
  });

  it('цель не доехала — луч в этом кадре не рисуется и не жалуется (NET-12)', () => {
    const { subsystem, warnings } = makeRig(BEAM);
    subsystem.syncTick(makeTickView([caster(9)]));
    subsystem.updateFrame(0.016, 1);
    expect(meshOf(subsystem, 1).visible).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('стата цели у сущности нет — то же самое', () => {
    const { subsystem, warnings } = makeRig(BEAM);
    subsystem.syncTick(makeTickView([caster(undefined)]));
    subsystem.updateFrame(0.016, 1);
    expect(meshOf(subsystem, 1).visible).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('луч по событию берёт концы из его полей, а событие без цели — предупреждение', () => {
    const { subsystem, warnings } = makeRig({
      entities: {},
      effects: {
        byEvent: {
          Zap: { primitive: 'beam', color: '#ff0', width: 0.4, height: 1, durationMs: 300 },
        },
      },
    });
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { currX: 0, prevX: 0 }), makeEntityView(2, { currX: 3, prevX: 3 })], {
        freshEvents: true,
        events: [{ type: 'Zap', tick: 1, data: { entity: 1, target: 2 } }],
      }),
    );
    expect(subsystem.activeCount).toBe(1);

    subsystem.syncTick(
      makeTickView([makeEntityView(1, { currX: 0, prevX: 0 })], {
        freshEvents: true,
        events: [{ type: 'Zap', tick: 1, data: { entity: 1 } }],
      }),
    );
    // Второй луч не завёлся: отрезок из точки в ту же точку не рисуется.
    expect(subsystem.activeCount).toBe(1);
    expect(warnings.filter((m) => m.includes('Zap'))).toHaveLength(1);
  });
});

describe('Лента-след по недавним позициям (REND-23, design D6)', () => {
  const RIBBON: VisualManifest = {
    entities: {},
    effects: {
      byKind: {
        Bolt: { primitive: 'ribbon', color: '#f80', width: 0.5, trailSamples: 8, alpha: 0.9 },
      },
    },
  };

  const bolt = (x: number, snap = false) =>
    makeEntityView(1, { kind: 'Bolt', currX: x, prevX: x, currY: 0, prevY: 0, snap });

  it('след тянется за сущностью и гаснет к хвосту', () => {
    const { subsystem } = makeRig(RIBBON);
    for (let i = 0; i < 5; i++) {
      subsystem.syncTick(makeTickView([bolt(i)]));
      subsystem.updateFrame(0.016, 1);
    }
    const mesh = meshOf(subsystem, 1);
    const vertices = verticesOf(mesh);
    const xs = vertices.map((v) => v.x);
    // Голова — последняя поза, хвост — самая старая из положенных.
    expect(Math.max(...xs)).toBeCloseTo(4, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    // Альфа падает от головы к хвосту.
    const alphas = alphasOf(mesh);
    expect(alphas[0]).toBeCloseTo(1, 6);
    expect(alphas[alphas.length - 1]).toBeCloseTo(0, 6);
  });

  it('длина следа — `trailSamples` записи: старшее вытесняется кольцом', () => {
    const { subsystem } = makeRig(RIBBON);
    for (let i = 0; i < 20; i++) {
      subsystem.syncTick(makeTickView([bolt(i)]));
      subsystem.updateFrame(0.016, 1);
    }
    const vertices = verticesOf(meshOf(subsystem, 1));
    // Восемь выборок × две кромки: сетка ленты постоянна и не растёт.
    expect(vertices).toHaveLength(16);
    const xs = vertices.map((v) => v.x);
    expect(Math.max(...xs)).toBeCloseTo(19, 6);
    // Хвост отстоит ровно на семь шагов, а не на девятнадцать.
    expect(Math.min(...xs)).toBeCloseTo(12, 6);
  });

  it('разрыв непрерывности сбрасывает историю (REND-2)', () => {
    const { subsystem } = makeRig(RIBBON);
    for (let i = 0; i < 6; i++) {
      subsystem.syncTick(makeTickView([bolt(i)]));
      subsystem.updateFrame(0.016, 1);
    }
    // Телепорт: сущность приехала снапом в другую точку.
    subsystem.syncTick(makeTickView([bolt(40, true)]));
    subsystem.updateFrame(0.016, 1);
    const xs = verticesOf(meshOf(subsystem, 1)).map((v) => v.x);
    // Полосы через всю арену нет: весь след сидит в новой точке.
    expect(Math.min(...xs)).toBeCloseTo(40, 6);
    expect(Math.max(...xs)).toBeCloseTo(40, 6);
  });
});
