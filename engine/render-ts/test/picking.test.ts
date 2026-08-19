/**
 * Picking вьюпорта (REND-15, ED-17): попадание считается по тому же, чем
 * нарисован кадр. Ни один тест не создаёт графического контекста — по образцу
 * headless-теста позы камеры (CAM-1): согласованность picking'а с изображением
 * и есть его единственное содержание, и проверять её глазами нечем.
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
  DecorationSet,
  DocumentSource,
  ModelsSubsystem,
  OverlaySubsystem,
  PresentationStage,
  ViewportPicking,
  VisualSurfaceSource,
  applyCameraPose,
  createPickProxy,
  type CameraPose,
  type RenderContext,
  type ViewportPoint,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView, type AssetsStub } from './fixtures.js';

const STEP = 2;
const MODEL_ID = 'models/box.mdx';
const TALL_ID = 'models/tower.mdx';
const BRIDGE_ID = 'models/bridge.glb';

// -------------------------------------------------------------------- фикстуры

/**
 * Коробка в канонических осях (ASSET-5): основание в нуле, высота вверх по Z.
 * Границы модели берутся picking'ом именно отсюда, а не из константы кода.
 */
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
        skinWeights: new Float32Array(
          Array.from({ length: count }, () => [1, 0, 0, 0]).flat(),
        ),
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

function makeManifest(): VisualManifest {
  return {
    entities: {
      // Масштаб записи равен высоте модели: нормализация даёт множитель 1, и
      // габариты инстанса совпадают с каноническими (проверять проще).
      Box: { model: MODEL_ID, scale: 2 },
      Tower: { model: TALL_ID, scale: 4 },
    },
    decorations: {
      // Walkable-настил REND-9: коробка 2×2×1, верх на высоте 1.
      Bridge: { model: BRIDGE_ID, scale: 1 },
    },
  };
}

function curvature(width: number, height: number, rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

interface Rig {
  readonly ctx: RenderContext;
  readonly models: ModelsSubsystem;
  readonly overlays: OverlaySubsystem;
  readonly source: VisualSurfaceSource;
  readonly picking: ViewportPicking;
  readonly assets: AssetsStub;
}

function makeRig(grid: TerrainGrid): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = new VisualSurfaceSource(grid);
  const models = new ModelsSubsystem(makeManifest(), { surface: source, warn: () => {} });
  const overlays = new OverlaySubsystem({ surface: source, instances: models });
  models.init(ctx);
  overlays.init(ctx);
  const picking = new ViewportPicking({ surface: source, instances: models, handles: overlays });
  return { ctx, models, overlays, source, picking, assets };
}

/** Прямоугольник вьюпорта и его центр — точка, через которую идёт луч. */
const VIEWPORT: ViewportPoint = { x: 50, y: 50, width: 100, height: 100 };

/**
 * Поза, дающая из центра вьюпорта строго вертикальный луч вниз через (x, y):
 * камера над точкой, взгляд в надир. Так тест адресует мировую точку, а не
 * подбирает пиксель.
 */
function lookDown(x: number, y: number, z = 10): CameraPose {
  return { posX: x, posY: y, posZ: z, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45 };
}

/** Поза со взглядом вдоль +X и наклоном 45° вниз — луч в стенку обрыва. */
function lookEastDown(x: number, y: number, z: number): CameraPose {
  return { posX: x, posY: y, posZ: z, yaw: 0, pitch: Math.PI / 4, roll: 0, fovDeg: 45 };
}

function flatGrid(width = 4, height = 4, flags?: string[]): TerrainGrid {
  return createTerrainGrid({
    width,
    height,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: height }, () => '0'.repeat(width)),
    flags: flags ?? Array.from({ length: height }, () => '.'.repeat(width)),
  });
}

// ----------------------------------------------------------------------- луч

describe('луч из позы камеры (CAM-1, REND-15)', () => {
  it('строится общей реализацией посадки позы — без графического контекста', () => {
    const { picking } = makeRig(flatGrid());
    const ray = picking.ray(lookDown(1.5, 2.5, 7), VIEWPORT);
    expect(ray.originX).toBeCloseTo(1.5, 6);
    expect(ray.originY).toBeCloseTo(2.5, 6);
    expect(ray.originZ).toBeCloseTo(7, 6);
    expect(ray.dirX).toBeCloseTo(0, 6);
    expect(ray.dirY).toBeCloseTo(0, 6);
    expect(ray.dirZ).toBeCloseTo(-1, 6);
  });

  /**
   * Луч под курсором обязан совпадать с картинкой НЕ ТОЛЬКО в центре вьюпорта.
   * Своя камера сервиса и камера кадра — разные объекты (передавать её не
   * обязательно), но позу на обе сажает `applyCameraPose` через `lookAt`, а
   * `lookAt` берёт крен из `camera.up`. Камера сервиса с верхом THREE по
   * умолчанию (0,1,0) дала бы луч, повёрнутый вокруг оси взгляда: в центре
   * вьюпорта он совпал бы с нарисованным, а в углу разошёлся бы на десятки
   * градусов — и инспектор показывал бы не то, что под курсором, оставаясь при
   * этом самосогласованным.
   */
  it('под курсором вне центра вьюпорта совпадает с камерой кадра, а не только в центре', () => {
    const { picking } = makeRig(flatGrid());
    const pose: CameraPose = {
      posX: 2,
      posY: 1,
      posZ: 9,
      yaw: 0.7,
      pitch: 0.9,
      roll: 0,
      fovDeg: 45,
    };
    // Камера кадра — ровно та, какую заводит сборка движка: мир Z-up.
    const frame = new THREE.PerspectiveCamera(pose.fovDeg, 4 / 3, 0.1, 300);
    frame.up.set(0, 0, 1);
    applyCameraPose(frame, pose);
    frame.updateMatrixWorld(true);

    const viewport = { width: 400, height: 300 };
    const corner = new THREE.Vector3();
    for (const [ndcX, ndcY] of [[0, 0], [0.6, 0.4], [-1, 1], [1, -1]] as const) {
      const point: ViewportPoint = {
        x: ((ndcX + 1) / 2) * viewport.width,
        y: ((1 - ndcY) / 2) * viewport.height,
        ...viewport,
      };
      const ray = picking.ray(pose, point);
      corner.set(ndcX, ndcY, 0.5).unproject(frame).sub(frame.position).normalize();
      expect(ray.dirX).toBeCloseTo(corner.x, 6);
      expect(ray.dirY).toBeCloseTo(corner.y, 6);
      expect(ray.dirZ).toBeCloseTo(corner.z, 6);
    }
  });
});

// -------------------------------------------------------------- поверхность

describe('попадание в поверхность (REND-15)', () => {
  it('клик мимо объектов даёт мировую точку, клетку и наличие пола', () => {
    const { picking } = makeRig(flatGrid());
    const hit = picking.pick(lookDown(1.25, 2.75), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.x).toBeCloseTo(1.25, 4);
    expect(hit.y).toBeCloseTo(2.75, 4);
    expect(hit.z).toBeCloseTo(0, 4);
    expect(hit.cellX).toBe(1);
    expect(hit.cellY).toBe(2);
    expect(hit.cell).toBe(2 * 4 + 1);
    expect(hit.noFloor).toBe(false);
    expect(hit.wall).toBe(false);
    // Клетка — целое число сетки; квантование позиции остаётся редактору (ED-16).
    expect(Number.isInteger(hit.cell)).toBe(true);
  });

  it('клик по клетке без пола называет ту же клетку и сообщает, что пола нет (ED-10)', () => {
    const grid = flatGrid(4, 4, ['....', '._..', '....', '....']);
    const { picking } = makeRig(grid);
    const hit = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.cell).toBe(1 * 4 + 1);
    expect(hit.noFloor).toBe(true);
    // Дыра — это дыра в геометрии, но клетка сетки: кисть пола в неё попадает.
    expect(grid.floor[hit.cell]).toBe(0);
  });

  it('клик по стенке обрыва разрешается в клетку верхнего уровня (REND-7)', () => {
    const grid = createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0011', '0011', '0011', '0011'],
      flags: ['....', '....', '....', '....'],
    });
    const { picking } = makeRig(grid);
    // Луч идёт с запада вниз под 45° и пересекает плоскость x = 2 на z = 1 —
    // внутри стенки между низиной (0) и плато (уровень 1 × шаг 2).
    const hit = picking.pick(lookEastDown(0, 1.5, 3), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.wall).toBe(true);
    expect(hit.cellX).toBe(2); // клетка плато, а не низина за ней
    expect(hit.cellY).toBe(1);
    expect(hit.z).toBeCloseTo(1, 4);
  });

  it('правило верхней клетки то же на границе по Y, а не только по X', () => {
    const grid = createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0000', '1111', '1111'],
      flags: ['....', '....', '....', '....'],
    });
    const { picking } = makeRig(grid);
    // Луч идёт с юга вниз под 45° и пересекает плоскость y = 2 на z = 1.5 —
    // внутри стенки, подпирающей площадку уровня 1.
    const hit = picking.pick(
      { posX: 1.5, posY: 0.5, posZ: 3, yaw: Math.PI / 2, pitch: Math.PI / 4, roll: 0, fovDeg: 45 },
      VIEWPORT,
    )!;
    expect(hit.wall).toBe(true);
    expect(hit.cellX).toBe(1);
    expect(hit.cellY).toBe(2); // клетка плато, а не низина перед ней
    expect(hit.z).toBeCloseTo(1.5, 4);
  });

  it('рампа стенкой не считается: перепад на ней непрерывен (TERR-5)', () => {
    const grid = createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0111', '0111', '0111', '0111'],
      flags: ['^...', '^...', '^...', '^...'],
    });
    const { picking } = makeRig(grid);
    // Наклонная площадка рампы поднимается от 0 до уровня 1 внутри клетки —
    // луч приходит на саму поверхность, а не на вертикальную грань.
    const hit = picking.pick(lookEastDown(0, 1.5, 1.8), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.wall).toBe(false);
    expect(hit.cellX).toBe(0);
    expect(hit.x).toBeCloseTo(0.6, 3);
    expect(hit.z).toBeCloseTo(1.2, 3);
  });

  it('попадание по холму считается по сглаженному полю, а не по билинейной хорде (REND-9)', () => {
    const { picking, source } = makeRig(flatGrid(3, 3));
    // Северный ряд поднят кривизной: внутри клетки (1,1) поле меняется по Y.
    source.setCurvature(curvature(3, 3, [
      [14, 14, 14, 14],
      [7, 7, 7, 7],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]));
    const surface = source.current!;
    expect(surface.hasCellCurvature(1, 1)).toBe(true);

    const px = 1.5;
    const py = 1.25;
    const hit = picking.pickSurface(lookDown(px, py), VIEWPORT)!;
    expect(hit.cellX).toBe(1);
    expect(hit.cellY).toBe(1);
    // Марш идёт тем же `heightInCell`, каким геометрия ставит свои вершины:
    // попадание лежит НА поверхности, а не на её хорде.
    expect(hit.z).toBeCloseTo(surface.heightInCell(1, 1, px, py), 4);

    // Билинейная форма по углам клетки (то, чем поле было до сглаживания) в
    // этой точке даёт заметно другую высоту — тест не вырожден.
    const [h00, h10, h11, h01] = surface.cornerHeights(1, 1);
    const u = px - 1;
    const v = py - 1;
    const chord =
      h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h11 * u * v + h01 * (1 - u) * v;
    expect(Math.abs(hit.z - chord)).toBeGreaterThan(1e-3);
  });

  it('правка сетки меняет ответ без пересоздания сервиса; повтор без правок даёт то же', () => {
    const { picking, source } = makeRig(flatGrid());
    const first = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    const firstZ = first.z;
    expect(firstZ).toBeCloseTo(0, 4);
    // Повторный запрос без изменений — тот же ответ (REND-15).
    const again = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(again.z).toBeCloseTo(firstZ, 6);
    expect(again.cell).toBe(first.cell);

    // Кисть подняла клетку: сетку пересчитало ядро, рендер её только принял.
    source.setGrid(
      createTerrainGrid({
        width: 4,
        height: 4,
        tileSize: FIXED_ONE,
        levels: ['0000', '0100', '0000', '0000'],
        flags: ['....', '....', '....', '....'],
      }),
    );
    const raised = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(raised.z).toBeCloseTo(STEP, 4);
    expect(raised.cell).toBe(first.cell);
  });
});

// ------------------------------------------------------------------ объекты

describe('попадание в размещённый объект (REND-15, ED-17)', () => {
  /**
   * Сценарий ED-17: юнит стоит на склоне кривизны и наклонён по нормали
   * поверхности (REND-10). Прокси стоит там же, где нарисован инстанс, —
   * матрица у них одна, — поэтому попадание приходится туда, где автор видит
   * модель, а не туда, куда её поставил бы расчёт «уровень × heightStep».
   */
  it('клик по юниту на склоне кривизны выделяет его — расчёт по высоте уровня промахнулся бы', () => {
    const { picking, models, source, assets } = makeRig(flatGrid(3, 3));
    // Ступенька кривизны поперёк арены: слева вогнутость, справа выпуклость.
    source.setCurvature(curvature(3, 3, [
      [-14, -7, 7, 14],
      [-14, -7, 7, 14],
      [-14, -7, 7, 14],
      [-14, -7, 7, 14],
    ]));
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 })]));
    models.updateFrame(0.016, 1);

    const pose = models.instanceFor(1)!.pose;
    const quaternion = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);
    // Инстанс наклонён: его верх ушёл по X далеко за габариты вертикальной позы.
    expect(Math.abs(new THREE.Euler().setFromQuaternion(quaternion).y)).toBeGreaterThan(0.5);

    // Верх модели в НАРИСОВАННОЙ позе уехал по X далеко от основания...
    const top = new THREE.Vector3(0, 0, 2)
      .multiplyScalar(pose.scale)
      .applyQuaternion(quaternion)
      .add(new THREE.Vector3(pose.x, pose.y, pose.z));
    expect(top.x).toBeLessThan(0.5);
    // ...а точка пробы лежит под силуэтом наклонённой модели и при этом вне
    // габаритов вертикального инстанса на высоте уровня ([1.3..1.7] по X).
    const probeX = 0.5;
    expect(probeX).toBeGreaterThan(top.x);
    expect(probeX).toBeLessThan(1.5 - 0.2);

    const hit = picking.pick(lookDown(probeX, 1.5), VIEWPORT)!;
    expect(hit.kind).toBe('entity');
    expect(hit.entity).toBe(1);

    // Тот же луч без наклона не попал бы никуда, кроме поверхности: проверяем
    // это, спросив picking о точке, где стоял бы вертикальный инстанс, — там
    // нарисованного объекта уже нет.
    const beside = picking.pick(lookDown(1.5 + 0.6, 1.5), VIEWPORT)!;
    expect(beside.kind).toBe('surface');
  });

  it('две модели разного размера выделяются каждая по своему объёму', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    assets.resolve('model', TALL_ID, makeBoxModel(0.6, 4));
    models.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 }),
        makeEntityView(2, { kind: 'Tower', currX: 3.5, currY: 1.5, prevX: 3.5, prevY: 1.5 }),
      ]),
    );
    models.updateFrame(0.016, 1);

    // Башня шире камня: точка в 0.5 от её центра — внутри её объёма...
    expect(picking.pick(lookDown(3, 1.5), VIEWPORT)!.entity).toBe(2);
    // ...а та же дистанция от центра камня — уже мимо него: объём каждого
    // инстанса производен от границ ЕГО модели, а не от общего размера.
    expect(picking.pick(lookDown(2, 1.5), VIEWPORT)!.kind).toBe('surface');
  });

  it('масштаб набора инстансов (REND-11) входит в объём', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    const view = makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 });
    models.syncTick(makeTickView([view]));
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(1.9, 1.5), VIEWPORT)!.kind).toBe('surface');

    // Набор увеличил размещение вчетверо — объём вырос вместе с картинкой.
    models.syncTick(makeTickView([{ ...view, scale: 4 }]));
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(1.9, 1.5), VIEWPORT)!.entity).toBe(1);
  });

  it('ближайший по лучу побеждает', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    models.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 }),
        // Второй стоит там же, но приподнят override'ом уровня — он ближе к камере.
        makeEntityView(2, {
          kind: 'Box',
          currX: 1.5,
          currY: 1.5,
          prevX: 1.5,
          prevY: 1.5,
          currLevel: 2,
          prevLevel: 2,
          levelOverride: true,
        }),
      ]),
    );
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(1.5, 1.5), VIEWPORT)!.entity).toBe(2);
  });

  it('инстанс с заглушкой выделяется (ASSET-4), невизуальная сущность — нет', () => {
    const { picking, models } = makeRig(flatGrid());
    models.syncTick(
      makeTickView([
        // Модель ещё грузится: в кадре заглушка, и автор вправе её двигать.
        makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 }),
        // Резолвер отнёс сущность к невизуальным — рендер её не рисует.
        makeEntityView(2, { kind: null, currX: 2.5, currY: 1.5, prevX: 2.5, prevY: 1.5 }),
      ]),
    );
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(1.5, 1.5), VIEWPORT)!.entity).toBe(1);
    expect(picking.pick(lookDown(2.5, 1.5), VIEWPORT)!.kind).toBe('surface');
  });

  it('объём заглушки — габариты её же геометрии, а не отдельно назначенный размер', () => {
    const { models, ctx } = makeRig(flatGrid());
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 })]),
    );
    models.updateFrame(0.016, 1);

    // Заглушку тест находит в сцене, а не в контракте подсистемы: узлов наружу
    // рендер не отдаёт (REND-3), а сравнивать нужно именно с НАРИСОВАННЫМ.
    expect(models.instanceFor(1)!.placeholder).toBe(true);
    const placeholder = ctx.scene.getObjectByName('entity:1')!.children[0] as THREE.Mesh;
    placeholder.geometry.computeBoundingBox();
    const box = placeholder.geometry.boundingBox!;
    const proxy = createPickProxy();
    expect(models.proxyOf(1, proxy)).toBe(true);
    // Заглушка сама и есть нарисованное: разъедься эти два места — picking
    // промахивался бы по видимому объекту (REND-15, ASSET-4).
    expect(proxy.minX).toBeCloseTo(box.min.x, 6);
    expect(proxy.minY).toBeCloseTo(box.min.y, 6);
    expect(proxy.minZ).toBeCloseTo(box.min.z, 6);
    expect(proxy.maxX).toBeCloseTo(box.max.x, 6);
    expect(proxy.maxY).toBeCloseTo(box.max.y, 6);
    expect(proxy.maxZ).toBeCloseTo(box.max.z, 6);
  });

  it('инстанс, не получивший позы кадра, не участвует: в кадре его нет', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    // Сущность появилась в presentation-состоянии, но кадра ещё не было: holder
    // стоит в мировом нуле, и попадание в него было бы попаданием в пустоту.
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Box', currX: 3.5, currY: 3.5, prevX: 3.5, prevY: 3.5 })]),
    );
    expect(picking.pick(lookDown(0.1, 0.1), VIEWPORT)!.kind).toBe('surface');

    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(0.1, 0.1), VIEWPORT)!.kind).toBe('surface');
    expect(picking.pick(lookDown(3.5, 3.5), VIEWPORT)!.entity).toBe(1);
  });

  it('инстанс, схлопнутый нулевым масштабом, не забирает попадания себе', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    const view = makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 });
    models.syncTick(makeTickView([{ ...view, scale: 0 }]));
    models.updateFrame(0.016, 1);

    // Преобразование схлопнутого инстанса необратимо: не отсекать по нему
    // значило бы отдавать ему весь экран на нулевой дистанции.
    expect(picking.pick(lookDown(3.5, 3.5), VIEWPORT)!.kind).toBe('surface');
    expect(picking.pick(lookDown(1.5, 1.5), VIEWPORT)!.kind).toBe('surface');
  });

  /**
   * Единственное место, где picking мог бы разойтись с кадром, — интерполяция
   * (REND-2): в режиме правки её нет (REND-11), но в превью инстанс рисуется
   * между двумя тиками. Расхождения не возникает и там: прокси — узел, а узел
   * стоит ровно там, куда его поставил ПОСЛЕДНИЙ кадр, со своей альфой.
   */
  it('в интерполированном кадре попадание идёт по нарисованной позе, а не по позе тика', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    models.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Box', prevX: 1.5, currX: 2.5, prevY: 1.5, currY: 1.5 })]),
    );
    models.updateFrame(0.016, 0.5);
    expect(picking.pick(lookDown(2, 1.5), VIEWPORT)!.entity).toBe(1);
    // Поза конца тика в этом кадре ещё не нарисована — и попадания не даёт.
    expect(picking.pick(lookDown(2.45, 1.5), VIEWPORT)!.kind).toBe('surface');

    // Следующий кадр довёл инстанс до конца тика — ответ поехал вместе с картинкой.
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(2.45, 1.5), VIEWPORT)!.entity).toBe(1);
  });

  it('ответ — сущность presentation-состояния; ключ документа даёт REND-11, а не picking', () => {
    const { ctx, models, source, assets } = makeRig(flatGrid());
    const stage = new PresentationStage(ctx);
    stage.register(models);
    const document = new DocumentSource(stage, { clock: () => 0 });
    const picking = new ViewportPicking({ surface: source, instances: models });

    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    document.apply([{ key: 'unit-1', kind: 'Box', x: 1.5, y: 1.5 }]);
    document.frame(0);

    const hit = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(hit.kind).toBe('entity');
    // Picking о документах не знает: перевод делает тот, кому ключ принадлежит.
    expect(document.keyOf(hit.entity)).toBe('unit-1');
  });
});

// -------------------------------------------------------- порядок разрешения

describe('порядок разрешения (REND-15)', () => {
  it('ручка наложения выигрывает у объекта, стоящего перед ней', () => {
    const { picking, models, overlays, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 })]));
    models.updateFrame(0.016, 1);

    // Без наложений выигрывает объект.
    expect(picking.pick(lookDown(1.5, 1.5), VIEWPORT)!.entity).toBe(1);

    // Ручка стоит НИЖЕ объекта, то есть дальше по лучу сверху вниз, — и всё
    // равно выигрывает: gizmo нарисован поверх кадра.
    overlays.apply([
      {
        kind: 'gizmo',
        key: 'move',
        x: 1.5,
        y: 1.5,
        z: -2,
        handles: [{ id: 'axis-z', axis: 'z', form: 'translate' }],
      },
    ]);
    const hit = picking.pick(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(hit.kind).toBe('handle');
    expect(hit.handle).toBe('axis-z');
    expect(hit.entity).toBe(0);
  });

  it('размер набора ручек виден picking’у той же матрицей, какой ручка нарисована', () => {
    const { picking, overlays } = makeRig(flatGrid());
    const gizmo = {
      kind: 'gizmo',
      key: 'move',
      x: 1.5,
      y: 1.5,
      z: 0,
      handles: [{ id: 'axis-x', axis: 'x', form: 'translate' }],
    } as const;
    overlays.apply([gizmo]);
    // Ручка длиной в единицу кончается на x = 2.5 — проба за ней мимо.
    expect(picking.pick(lookDown(2.8, 1.5), VIEWPORT)!.kind).toBe('surface');

    // Экранно-постоянный gizmo — состояние инструмента (ED-16): набор назвал
    // размер, и попадание выросло вместе с картинкой.
    overlays.apply([{ ...gizmo, scale: 2 }]);
    const hit = picking.pick(lookDown(2.8, 1.5), VIEWPORT)!;
    expect(hit.kind).toBe('handle');
    expect(hit.handle).toBe('axis-x');
  });

  it('запрос только поверхности игнорирует объект над клеткой (ED-10, ED-11)', () => {
    const { picking, models, assets } = makeRig(flatGrid());
    assets.resolve('model', MODEL_ID, makeBoxModel(0.2, 2));
    models.syncTick(makeTickView([makeEntityView(1, { kind: 'Box', currX: 1.5, currY: 1.5, prevX: 1.5, prevY: 1.5 })]));
    models.updateFrame(0.016, 1);
    expect(picking.pick(lookDown(1.5, 1.5), VIEWPORT)!.kind).toBe('entity');
    const surface = picking.pickSurface(lookDown(1.5, 1.5), VIEWPORT)!;
    expect(surface.kind).toBe('surface');
    expect(surface.cell).toBe(1 * 4 + 1);
  });

  it('курсор мимо арены не попадает ни во что', () => {
    const { picking } = makeRig(flatGrid());
    expect(picking.pick(lookDown(-5, -5), VIEWPORT)).toBeNull();
  });
});

// -------------------------------------------------- walkable-поверхности

describe('попадание в walkable-поверхность (REND-15, REND-9)', () => {
  /** Рядом с обычным rig'ом — набор декораций, кормящий подсистему моделей. */
  function makeWalkableRig(grid: TerrainGrid): Rig & { decorations: DecorationSet } {
    const rig = makeRig(grid);
    const stage = new PresentationStage(rig.ctx).register(rig.models);
    return { ...rig, decorations: new DecorationSet(stage) };
  }

  it('кисть по настилу попадает в настил, а не в лощину под ним; клетка — под мировой точкой', () => {
    const grid = flatGrid(4, 4, ['....', '.._.', '....', '....']);
    const rig = makeWalkableRig(grid);
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([{ key: 'bridge', kind: 'Bridge', x: 2, y: 2, walkable: true }]);

    // Запрос только поверхности — путь кистей: побеждает настил (min-t),
    // а не марш до террейн-формы под ним.
    const hit = rig.picking.pickSurface(lookDown(2.2, 1.8), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.z).toBeCloseTo(1, 4); // верх настила, террейн-форма здесь 0
    expect(hit.x).toBeCloseTo(2.2, 4);
    expect(hit.y).toBeCloseTo(1.8, 4);
    // Клетка сетки — под мировой точкой попадания (REND-15); стенкой не является.
    expect(hit.cellX).toBe(2);
    expect(hit.cellY).toBe(1);
    expect(hit.wall).toBe(false);
    // Дыра в полу под настилом остаётся видимой в ответе: noFloor — из клетки.
    const overHole = rig.picking.pickSurface(lookDown(2.5, 1.5), VIEWPORT)!;
    expect(overHole.z).toBeCloseTo(1, 4);
    expect(overHole.noFloor).toBe(true);
  });

  it('в общем порядке клик по мосту разрешается в его decoration-инстанс раньше поверхности', () => {
    const rig = makeWalkableRig(flatGrid());
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([{ key: 'bridge', kind: 'Bridge', x: 2, y: 2, walkable: true }]);
    rig.models.updateFrame(0.016, 1);

    const hit = rig.picking.pick(lookDown(2, 2), VIEWPORT)!;
    expect(hit.kind).toBe('entity');
    expect(hit.decoration).toBe(true);
    expect(hit.entity).toBe(rig.decorations.entityOf('bridge'));
    // Запрос только поверхности тем же лучом — walkable-поверхность как поверхность.
    const surface = rig.picking.pickSurface(lookDown(2, 2), VIEWPORT)!;
    expect(surface.kind).toBe('surface');
    expect(surface.z).toBeCloseTo(1, 4);
  });

  it('walkable незагруженной модели в поверхность не входит — попадать нечем (ASSET-4)', () => {
    const rig = makeWalkableRig(flatGrid());
    // Модель не резолвится: вклада в поле нет, и рейкаст по мешу невозможен.
    rig.decorations.apply([{ key: 'bridge', kind: 'Bridge', x: 2, y: 2, walkable: true }]);
    const hit = rig.picking.pickSurface(lookDown(2, 2), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.z).toBeCloseTo(0, 4); // террейн-форма, настила в поле нет

    // Ассет доехал — тот же запрос попадает в настил (REND-9: не позже
    // следующего кадра; пересоздания picking'а не требуется).
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    expect(rig.picking.pickSurface(lookDown(2, 2), VIEWPORT)!.z).toBeCloseTo(1, 4);
  });

  it('террейн ближе настила побеждает по min-t: марш не обрезается раньше времени', () => {
    // Настил посажен в низине (верх на 1), его bbox заходит под кромку плато
    // уровня 1 (высота 2): луч сверху вниз над плато обязан попасть в площадку
    // плато — она ближе по лучу, хотя walkable-меш под ней есть.
    const grid = createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0000', '1100', '1100'],
      flags: ['....', '....', '....', '....'],
    });
    const rig = makeWalkableRig(grid);
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([{ key: 'bridge', kind: 'Bridge', x: 1, y: 1.4, walkable: true }]);
    // Настил стоит на террейн-форме низины, а bbox накрывает точку пробы.
    expect(rig.source.current!.terrainFormHeightAt(1, 1.4)).toBeCloseTo(0, 6);

    const hit = rig.picking.pickSurface(lookDown(1, 2.2), VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.z).toBeCloseTo(STEP, 4); // площадка плато выше настила
    expect(hit.cellY).toBe(2);
  });
});
