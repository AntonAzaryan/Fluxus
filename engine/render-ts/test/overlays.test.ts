/**
 * Служебные наложения вьюпорта (REND-16): декларативный набор, закрытый словарь
 * видов, привязка к визуальной поверхности, подсветка без подмены материалов
 * инстанса (REND-6) и пустой набор, не оставляющий в кадре ничего (ED-22).
 * Графического контекста ни один тест не создаёт.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@game-mvp/core';
import {
  validateCurvatureMap,
  type NormalizedModel,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@game-mvp/assets';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  ModelsSubsystem,
  OverlaySubsystem,
  VisualSurfaceSource,
  type OverlayItem,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView, type AssetsStub } from './fixtures.js';

const STEP = 2;
const MODEL_ID = 'models/box.mdx';

function makeBoxModel(halfWidth: number, height: number): NormalizedModel {
  const positions: number[] = [];
  for (const z of [0, height]) {
    for (const [x, y] of [
      [-halfWidth, -halfWidth],
      [halfWidth, -halfWidth],
      [halfWidth, halfWidth],
      [-halfWidth, halfWidth],
    ]) {
      positions.push(x!, y!, z);
    }
  }
  const count = positions.length / 3;
  return {
    bones: [
      {
        index: 0,
        name: 'Bone_Root',
        parentIndex: -1,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
    ],
    meshes: [
      {
        partId: 0,
        positions: new Float32Array(positions),
        normals: null,
        uvs: null,
        indices: new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
        skinIndices: new Uint16Array(count * 4),
        skinWeights: new Float32Array(Array.from({ length: count }, () => [1, 0, 0, 0]).flat()),
        materialIndex: 0,
      },
    ],
    sequences: [],
    materials: [
      {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        normalTexture: null,
        emissiveFactor: [0, 0, 0],
        emissiveTexture: null,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
      },
    ],
    textureSlots: [],
    height,
  };
}

// Ярус явный (ASSET-13): тест смотрит на материалы инстанса — представление
// детального яруса (REND-20).
const MANIFEST: VisualManifest = {
  entities: { Box: { model: MODEL_ID, scale: 2, tier: 'detailed' } },
};

function grid4(): TerrainGrid {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000', '0000', '0000'],
    flags: ['....', '....', '....', '....'],
  });
}

function curvature(rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width: 4, height: 4, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

/** Узловые ряды 5×5: один и тот же ряд на все узловые линии. */
function nodeColumns(row: number[]): number[][] {
  return Array.from({ length: 5 }, () => [...row]);
}

interface Rig {
  readonly ctx: RenderContext;
  readonly models: ModelsSubsystem;
  readonly overlays: OverlaySubsystem;
  readonly source: VisualSurfaceSource;
  readonly assets: AssetsStub;
}

function makeRig(): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = new VisualSurfaceSource(grid4());
  const models = new ModelsSubsystem(MANIFEST, { surface: source, warn: () => {} });
  const overlays = new OverlaySubsystem({ surface: source, instances: models });
  models.init(ctx);
  overlays.init(ctx);
  return { ctx, models, overlays, source, assets };
}

/** Инстанс в клетке (1,1) с загруженной моделью и посчитанной позой кадра. */
function placeBox(rig: Rig, entity = 1, x = 1.5, y = 1.5): void {
  rig.assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
  rig.models.syncTick(
    makeTickView([makeEntityView(entity, { kind: 'Box', currX: x, currY: y, prevX: x, prevY: y })]),
  );
  rig.models.updateFrame(0.016, 1);
}

// ------------------------------------------------------------- пустой набор

describe('пустой набор (REND-16, ED-22)', () => {
  it('подсистема без наложений не оставляет в сцене ни одного своего объекта', () => {
    const { ctx, overlays } = makeRig();
    expect(overlays.size).toBe(0);
    expect(overlays.objectCount).toBe(0);
    // Кадр вьюпорта — тот же, что кадр клиента на этой сцене: подсистема
    // зарегистрирована, а объектов от неё нет.
    expect(ctx.scene.children.length).toBe(0);

    overlays.apply([{ kind: 'grid', key: 'grid' }]);
    expect(ctx.scene.children.length).toBe(1);

    overlays.clear();
    expect(overlays.size).toBe(0);
    expect(overlays.objectCount).toBe(0);
    expect(ctx.scene.children.length).toBe(0);
  });

  it('наложения не трогают объекты и материалы подсистемы моделей', () => {
    const rig = makeRig();
    placeBox(rig);
    const instance = rig.models.instanceFor(1)!;
    const material = instance.model!.materials[0]!;
    const color = material.color.getHex();
    const sceneChildren = rig.ctx.scene.children.length;

    rig.overlays.apply([
      { kind: 'highlight', key: 'sel', entity: 1 },
      { kind: 'grid', key: 'grid' },
    ]);
    rig.overlays.updateFrame(0.016, 1);

    // Подсветка — собственный объект наложения, а не подмена материала (REND-6).
    expect(instance.model!.materials[0]).toBe(material);
    expect(material.color.getHex()).toBe(color);
    // Наложения живут в своей группе: сценовых объектов подсистемы моделей от
    // них не прибавляется (ED-22).
    expect(rig.ctx.scene.children.length).toBe(sceneChildren + 1);
  });
});

// --------------------------------------------------------------- подсветка

describe('подсветка выделения (REND-16)', () => {
  it('стоит в видимой позе инстанса и наследует его наклон по поверхности (REND-10)', () => {
    const rig = makeRig();
    rig.source.setCurvature(curvature(nodeColumns([-14, -7, 7, 7, 0])));
    placeBox(rig);
    rig.overlays.apply([{ kind: 'highlight', key: 'sel', entity: 1 }]);
    rig.overlays.updateFrame(0.016, 1);

    const pose = rig.models.instanceFor(1)!.pose;
    const drawn = rig.ctx.scene.getObjectByName('highlight:1')!;
    expect(drawn).toBeDefined();

    // Рамка получена ТЕМ ЖЕ преобразованием, которым нарисован инстанс: её
    // центр — центр объёма-прокси, переведённый матрицей инстанса.
    const expected = new THREE.Vector3(0, 0, 1)
      .multiplyScalar(pose.scale)
      .applyQuaternion(new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw))
      .add(new THREE.Vector3(pose.x, pose.y, pose.z));
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    drawn.matrix.decompose(position, quaternion, scale);
    expect(position.x).toBeCloseTo(expected.x, 6);
    expect(position.y).toBeCloseTo(expected.y, 6);
    expect(position.z).toBeCloseTo(expected.z, 6);
    // Наклон инстанса рамка повторяет, а не игнорирует.
    expect(Math.abs(quaternion.y)).toBeGreaterThan(0.2);
    expect(scale.z).toBeCloseTo(2, 6);
  });

  it('смена скина (REND-6) подсветку не гасит и не дублирует', () => {
    const rig = makeRig();
    placeBox(rig);
    rig.overlays.apply([{ kind: 'highlight', key: 'sel', entity: 1 }]);
    rig.overlays.updateFrame(0.016, 1);
    const before = rig.ctx.scene.getObjectByName('highlight:1')!;

    expect(rig.models.setSkin(1, 'blue')).toBe(true);
    rig.overlays.updateFrame(0.016, 1);
    const after = rig.ctx.scene.getObjectByName('highlight:1')!;
    expect(after).toBe(before);
    expect(after.visible).toBe(true);
    expect(rig.overlays.size).toBe(1);
  });

  it('сущность, которую рендер не рисует, подсветить нечем', () => {
    const rig = makeRig();
    rig.overlays.apply([{ kind: 'highlight', key: 'sel', entity: 42 }]);
    rig.overlays.updateFrame(0.016, 1);
    expect(rig.ctx.scene.getObjectByName('highlight:42')!.visible).toBe(false);
  });
});

// -------------------------------------------------- наложения по поверхности

describe('наложения по визуальной поверхности (REND-16, REND-9)', () => {
  it('клетка без кривизны — прежний плоский квад по углам поверхности', () => {
    const rig = makeRig();
    rig.overlays.apply([{ kind: 'cells', key: 'brush', cells: [1 * 4 + 1] }]);

    const mesh = rig.ctx.scene.getObjectByName('cells') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    expect(positions.count).toBe(4);
    const heights = rig.source.current!.cornerHeights(1, 1);
    for (let i = 0; i < positions.count; i++) {
      expect(positions.getZ(i)).toBeCloseTo(heights[i]! + 0.02, 6);
    }
  });

  it('ячейка на холме строится той же выборкой, что пол: не проваливается и не висит (REND-9)', () => {
    const rig = makeRig();
    rig.source.setCurvature(curvature([
      [0, 14, 14, 0, 0],
      [0, 14, 14, 0, 0],
      [0, 14, 14, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]));
    rig.overlays.apply([{ kind: 'cells', key: 'brush', cells: [1 * 4 + 1] }]);

    const surface = rig.source.current!;
    expect(surface.hasCellCurvature(1, 1)).toBe(true);
    const mesh = rig.ctx.scene.getObjectByName('cells') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    // Разбита так же, как пол: N × N подквадов вместо одного.
    expect(positions.count).toBe(DEFAULT_CURVATURE_TESSELLATION ** 2 * 4);
    let raised = 0;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      // Каждая вершина — точка поля плюс подъём, а не угол плоского квада.
      expect(positions.getZ(i)).toBeCloseTo(surface.heightInCell(1, 1, x, y) + 0.02, 6);
      if (positions.getZ(i) > 0.02 + 1e-6) raised++;
    }
    expect(raised).toBeGreaterThan(0);
  });

  it('сетка идёт по клеткам той же поверхности; клетка с кривизной — ломаная по полю', () => {
    const rig = makeRig();
    rig.source.setCurvature(curvature(nodeColumns([14, 14, 14, 14, 14])));
    rig.overlays.apply([{ kind: 'grid', key: 'grid', x0: 1, y0: 1, x1: 1, y1: 1 }]);

    const surface = rig.source.current!;
    const lines = rig.ctx.scene.getObjectByName('grid') as THREE.LineSegments;
    const positions = lines.geometry.getAttribute('position');
    // Четыре ребра, каждое из N отрезков по два конца.
    expect(positions.count).toBe(4 * DEFAULT_CURVATURE_TESSELLATION * 2);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      expect(positions.getZ(i)).toBeCloseTo(surface.heightInCell(1, 1, x, y) + 0.02, 6);
    }
  });

  it('правка поверхности перестраивает наложения по ней следующим кадром', () => {
    const rig = makeRig();
    rig.overlays.apply([{ kind: 'cells', key: 'brush', cells: [1 * 4 + 1] }]);
    const before = rig.ctx.scene.getObjectByName('cells') as THREE.Mesh;
    expect(before.geometry.getAttribute('position').getZ(0)).toBeCloseTo(0.02, 6);

    rig.source.setGrid(
      createTerrainGrid({
        width: 4,
        height: 4,
        tileSize: FIXED_ONE,
        levels: ['0000', '0100', '0000', '0000'],
        flags: ['....', '....', '....', '....'],
      }),
    );
    rig.overlays.updateFrame(0.016, 1);
    const after = rig.ctx.scene.getObjectByName('cells') as THREE.Mesh;
    expect(after.geometry.getAttribute('position').getZ(0)).toBeCloseTo(STEP + 0.02, 6);
  });
});

// ---------------------------------------------------------- сведение набора

describe('декларативный набор (REND-16)', () => {
  it('повторный apply тем же набором сценовые объекты не пересоздаёт', () => {
    const rig = makeRig();
    const set: OverlayItem[] = [{ kind: 'cells', key: 'brush', cells: [0, 1, 2] }];
    rig.overlays.apply(set);
    const first = rig.ctx.scene.getObjectByName('cells')!;
    rig.overlays.apply([{ kind: 'cells', key: 'brush', cells: [0, 1, 2] }]);
    expect(rig.ctx.scene.getObjectByName('cells')).toBe(first);

    // Другой набор клеток — та же запись, другая геометрия.
    rig.overlays.apply([{ kind: 'cells', key: 'brush', cells: [0, 1] }]);
    const second = rig.ctx.scene.getObjectByName('cells')!;
    expect(second).not.toBe(first);
    expect(rig.overlays.size).toBe(1);
  });

  it('исчезнувший ключ убирает наложение, новый — создаёт; смена вида пересоздаёт', () => {
    const rig = makeRig();
    rig.overlays.apply([
      { kind: 'cells', key: 'a', cells: [0] },
      { kind: 'grid', key: 'b' },
    ]);
    expect(rig.overlays.size).toBe(2);

    rig.overlays.apply([{ kind: 'grid', key: 'b' }]);
    expect(rig.overlays.size).toBe(1);
    expect(rig.ctx.scene.getObjectByName('cells')).toBeUndefined();

    // Тот же ключ, другой вид — наложение пересобирается целиком.
    rig.overlays.apply([{ kind: 'cells', key: 'b', cells: [0] }]);
    expect(rig.overlays.size).toBe(1);
    expect(rig.ctx.scene.getObjectByName('grid')).toBeUndefined();
    expect(rig.ctx.scene.getObjectByName('cells')).toBeDefined();
  });

  it('дубликат ключа в наборе — ошибка, а не молча потерянное наложение', () => {
    const rig = makeRig();
    expect(() =>
      { rig.overlays.apply([
        { kind: 'grid', key: 'same' },
        { kind: 'grid', key: 'same' },
      ]); },
    ).toThrow(/same/);
  });
});

// ------------------------------------------------------------------- gizmo

describe('ручки gizmo (REND-16)', () => {
  it('наведённая и активная ручки рисуются иначе обычной; что случится при захвате — не рендеру знать', () => {
    const rig = makeRig();
    rig.overlays.apply([
      {
        kind: 'gizmo',
        key: 'move',
        x: 1.5,
        y: 1.5,
        z: 0,
        handles: [
          { id: 'x', axis: 'x', form: 'translate' },
          { id: 'y', axis: 'y', form: 'translate', hovered: true },
          { id: 'z', axis: 'z', form: 'rotate', active: true },
        ],
      },
    ]);
    const plain = rig.ctx.scene.getObjectByName('handle:x') as THREE.Mesh;
    const hovered = rig.ctx.scene.getObjectByName('handle:y') as THREE.Mesh;
    const active = rig.ctx.scene.getObjectByName('handle:z') as THREE.Mesh;
    expect(plain.material).not.toBe(hovered.material);
    expect(hovered.material).not.toBe(active.material);
    // Ручки живут в позе набора, а не в мировом нуле.
    plain.updateWorldMatrix(true, false);
    const world = plain.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBeCloseTo(1.5, 6);
    expect(world.y).toBeCloseTo(1.5, 6);
    // Ось ручки — её собственная ориентация: перемещение по Y развёрнуто на 90°.
    expect(hovered.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(active.rotation.y).toBeCloseTo(0, 6);
  });

  it('ручки отдаются picking’у прокси-объёмами (REND-15)', () => {
    const rig = makeRig();
    rig.overlays.apply([
      {
        kind: 'gizmo',
        key: 'move',
        x: 1.5,
        y: 1.5,
        z: 0,
        handles: [{ id: 'x', axis: 'x', form: 'translate' }],
      },
    ]);
    const seen: string[] = [];
    rig.overlays.eachProxy((proxy) => {
      seen.push(proxy.handle!);
      expect(proxy.entity).toBe(0);
      expect(proxy.maxX).toBeGreaterThan(proxy.minX);
    });
    expect(seen).toEqual(['x']);
  });
});
