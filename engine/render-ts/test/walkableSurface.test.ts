/**
 * Walkable-вклад единого поля высот (REND-9): decoration с флагом `walkable`
 * (PRES-2, REND-18) добавляет в поле верхнюю поверхность своего меша. Путь тот
 * же, что в приложении: набор → подсистема моделей → реестр источника
 * поверхности — внутренности реестра отдельно не проверяются, проверяется
 * форма поля и её уведомления. Без графического контекста, как picking.test.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import {
  validateCurvatureMap,
  type NormalizedModel,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@fluxus/assets';
import {
  DecorationSet,
  ModelsSubsystem,
  PresentationStage,
  VisualSurfaceSource,
  WalkableSurfaceRegistry,
  type RenderContext,
  type SurfaceNormal,
  type TerrainFormSampler,
  type WalkablePlacement,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView, type AssetsStub } from './fixtures.js';

const STEP = 2;
const BRIDGE_ID = 'models/bridge.glb';
const PLANK_ID = 'models/plank.glb';
const DECK_ID = 'models/deck.glb';
const UNIT_ID = 'models/runner.mdx';

/**
 * Коробка в канонических осях (ASSET-5): верхняя и нижняя грани, основание в
 * нуле. Верхняя грань и есть walkable-настил.
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
        emissiveStrength: 1,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
      },
    ],
    textureSlots: [],
    height,
  };
}

/**
 * Модель из двух частей: part 0 — горизонтальный квад [-1,1]² на z=1, part 1 —
 * такой же на z=2. Высота модели 2; масштаб записи 2 даёт множитель 1 —
 * мировые высоты частей совпадают с каноническими.
 */
function makeTwoDeckModel(): NormalizedModel {
  const deckMesh = (partId: number, z: number): NormalizedModel['meshes'][number] => ({
    partId,
    positions: new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
    normals: null,
    uvs: null,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    skinIndices: new Uint16Array(4 * 4),
    skinWeights: new Float32Array(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat()),
    materialIndex: 0,
  });
  const box = makeBoxModel(1, 2);
  return {
    ...box,
    meshes: [deckMesh(0, 1), deckMesh(1, 2)],
  };
}

function makeManifest(): VisualManifest {
  return {
    entities: {
      // Масштаб записи равен высоте модели — нормализация даёт множитель 1.
      Runner: { model: UNIT_ID, scale: 2 },
    },
    decorations: {
      // Настил: коробка 2×2×1, верх на высоте 1 мировой единицы.
      Bridge: { model: BRIDGE_ID, scale: 1 },
      // Второй настил повыше — для правила max.
      Plank: { model: PLANK_ID, scale: 1.5 },
      // Двухэтажная модель: с записью «верх скрыт» и без — для hiddenParts.
      Deck: { model: DECK_ID, scale: 2, hiddenParts: [1] },
      DeckFull: { model: DECK_ID, scale: 2 },
    },
  };
}

function flatGrid(width = 4, height = 4): TerrainGrid {
  return createTerrainGrid({
    width,
    height,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: height }, () => '0'.repeat(width)),
    flags: Array.from({ length: height }, () => '.'.repeat(width)),
  });
}

function curvature(width: number, height: number, rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

interface Rig {
  readonly ctx: RenderContext;
  readonly source: VisualSurfaceSource;
  readonly models: ModelsSubsystem;
  readonly decorations: DecorationSet;
  readonly assets: AssetsStub;
  frame(): void;
}

function makeRig(grid: TerrainGrid = flatGrid()): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = new VisualSurfaceSource(grid);
  const models = new ModelsSubsystem(makeManifest(), { surface: source, warn: () => {} });
  const stage = new PresentationStage(ctx).register(models);
  return {
    ctx,
    source,
    models,
    decorations: new DecorationSet(stage),
    assets,
    frame: () => { stage.frame(0.016, 1); },
  };
}

function bridgeAt(x: number, y: number, extra: Record<string, unknown> = {}): {
  key: string;
  kind: string;
  x: number;
  y: number;
  walkable: boolean;
} & Record<string, unknown> {
  return { key: 'bridge', kind: 'Bridge', x, y, walkable: true, ...extra };
}

// --------------------------------------------------------------- форма поля

describe('walkable-вклад поля высот (REND-9)', () => {
  it('юнит на настиле над лощиной: высота поля — настил, а не террейн под ним', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.assets.resolve('model', UNIT_ID, makeBoxModel(0.2, 2));
    rig.decorations.apply([bridgeAt(2, 2)]);

    const surface = rig.source.current!;
    // Поле — верх настила; террейн-форма под ним прежняя.
    expect(surface.heightAt(2, 2)).toBeCloseTo(1, 6);
    expect(surface.terrainFormHeightAt(2, 2)).toBeCloseTo(0, 6);
    // Юнит (не декорация) сажается по полю — на настил (REND-10).
    rig.models.syncTick(
      makeTickView([makeEntityView(1, { currX: 2, currY: 2, prevX: 2, prevY: 2 })]),
    );
    rig.frame();
    expect(rig.models.instanceFor(1)!.pose.z).toBeCloseTo(1, 6);
  });

  it('пересечение двух walkable-мешей — правило max, порядок записей не влияет', () => {
    const forward = makeRig();
    forward.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    forward.assets.resolve('model', PLANK_ID, makeBoxModel(1, 1.5));
    const records = [
      bridgeAt(2, 2),
      { key: 'plank', kind: 'Plank', x: 2, y: 2, walkable: true },
    ];
    forward.decorations.apply(records);
    // Побеждает верхняя поверхность (Plank: верх на 1.5), а не последняя запись.
    expect(forward.source.current!.heightAt(2, 2)).toBeCloseTo(1.5, 6);

    const reversed = makeRig();
    reversed.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    reversed.assets.resolve('model', PLANK_ID, makeBoxModel(1, 1.5));
    reversed.decorations.apply([...records].reverse());
    expect(reversed.source.current!.heightAt(2, 2)).toBeCloseTo(1.5, 6);
  });

  it('до готовности ассета поле — террейн-форма; по готовности подписчики узнают клетки под bbox', () => {
    const rig = makeRig();
    const notifications: { cells: readonly number[] | null; walkableOnly: boolean | undefined }[] = [];
    rig.source.onChange((cells, walkableOnly) => { notifications.push({ cells, walkableOnly }); });

    rig.decorations.apply([bridgeAt(2, 2)]);
    // Модель ещё грузится (ASSET-4): вклада нет, поле — ступени террейна.
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(0, 6);
    expect(notifications.length).toBe(0);

    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    // Вклад появился, и подписчики уведомлены клетками под bbox — walkable-only:
    // террейн-форма не менялась, и квады пола пересобирать не из-за чего.
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.walkableOnly).toBe(true);
    expect(notifications[0]!.cells).toContain(2 * 4 + 2); // клетка точки (2, 2)
    expect(notifications[0]!.cells).toContain(1 * 4 + 1); // угол bbox [1..3]²
  });

  it('сцена без walkable — поле байт-в-байт прежнее (обычные декорации его не трогают)', () => {
    const grid = flatGrid(4, 4);
    const rig = makeRig(grid);
    rig.source.setCurvature(curvature(4, 4, [
      [0, 7, 14, 7, 0],
      [0, 7, 14, 7, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]));
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));

    // Эталон — поверхность, собранная без реестра вовсе.
    const bare = new VisualSurfaceSource(createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0000', '0000', '0000'],
      flags: ['....', '....', '....', '....'],
    }));
    const bareModels = new ModelsSubsystem(makeManifest(), { surface: bare, warn: () => {} });
    bareModels.init(rig.ctx);
    bare.setCurvature(curvature(4, 4, [
      [0, 7, 14, 7, 0],
      [0, 7, 14, 7, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]));

    // Декорация без флага walkable в реестр не попадает (PRES-2: отсутствие =
    // false), и поле остаётся террейн-формой.
    rig.decorations.apply([{ key: 'rock', kind: 'Bridge', x: 2, y: 2 }]);

    const normal: SurfaceNormal = { x: 0, y: 0, z: 1 };
    const bareNormal: SurfaceNormal = { x: 0, y: 0, z: 1 };
    for (let i = 0; i <= 16; i++) {
      const x = (i / 16) * 4;
      const y = ((i * 7) % 17) / 17 * 4;
      expect(rig.source.current!.heightAt(x, y)).toBe(bare.current!.heightAt(x, y));
      rig.source.current!.normalAt(x, y, normal);
      bare.current!.normalAt(x, y, bareNormal);
      expect(normal).toEqual(bareNormal);
    }
  });

  it('сам walkable-инстанс сажается по террейн-форме: два моста не сажаются друг на друга', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.assets.resolve('model', PLANK_ID, makeBoxModel(1, 1.5));
    rig.decorations.apply([
      bridgeAt(2, 2),
      { key: 'plank', kind: 'Plank', x: 2, y: 2, walkable: true },
    ]);
    rig.frame();

    // Оба стоят на земле (террейн-форма 0), а не на поверхности соседа —
    // рекурсии посадки нет (REND-9); поле при этом — max их верхов.
    const bridge = rig.models.instanceFor(rig.decorations.entityOf('bridge')!, true)!;
    const plank = rig.models.instanceFor(rig.decorations.entityOf('plank')!, true)!;
    expect(bridge.pose.z).toBeCloseTo(0, 6);
    expect(plank.pose.z).toBeCloseTo(0, 6);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1.5, 6);
  });

  it('hiddenParts записи: в поле попадает только нарисованная часть (REND-9)', () => {
    // Запись Deck скрывает верхний квад (part 1): поверхность обязана совпадать
    // с картинкой — поле отдаёт верх видимой части, а не скрытой геометрии.
    const rig = makeRig();
    rig.assets.resolve('model', DECK_ID, makeTwoDeckModel());
    rig.decorations.apply([{ key: 'deck', kind: 'Deck', x: 2, y: 2, walkable: true }]);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);

    // Контроль: та же модель без hiddenParts даёт верх скрытой ранее части —
    // индексы по разным наборам частей не путаются (ASSET-11).
    const control = makeRig();
    control.assets.resolve('model', DECK_ID, makeTwoDeckModel());
    control.decorations.apply([{ key: 'deck', kind: 'DeckFull', x: 2, y: 2, walkable: true }]);
    expect(control.source.current!.heightAt(2, 2)).toBeCloseTo(2, 6);
  });

  it('нормаль на настиле — нормаль треугольника меша, вне bbox — прежняя нормаль поля', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    // Курс в четверть оборота: верхняя грань горизонтальна и после поворота —
    // нормаль треугольника вертикальна в мировых осях.
    rig.decorations.apply([bridgeAt(2, 2, { yaw: Math.PI / 4 })]);

    const normal: SurfaceNormal = { x: 0, y: 0, z: 0 };
    rig.source.current!.normalAt(2, 2, normal);
    expect(normal.x).toBeCloseTo(0, 6);
    expect(normal.y).toBeCloseTo(0, 6);
    expect(normal.z).toBeCloseTo(1, 6);
    // Вне bbox настила — обычная нормаль террейна.
    rig.source.current!.normalAt(0.2, 0.2, normal);
    expect(normal.z).toBeCloseTo(1, 6);
  });
});

// ------------------------------------------------- правки набора и инвалидация

describe('правка walkable-записи (REND-18 → REND-9)', () => {
  it('смена флага — обновление инстанса, не пересоздание; поле следует за флагом', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([bridgeAt(2, 2)]);
    const entity = rig.decorations.entityOf('bridge')!;
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);

    // Флаг снят: та же запись, тот же инстанс (ключ устойчив), вклада нет.
    rig.decorations.apply([{ key: 'bridge', kind: 'Bridge', x: 2, y: 2, walkable: false }]);
    expect(rig.decorations.entityOf('bridge')).toBe(entity);
    expect(rig.models.decorationCount).toBe(1);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(0, 6);

    // Флаг вернулся — вклад вернулся без пересоздания.
    rig.decorations.apply([bridgeAt(2, 2)]);
    expect(rig.decorations.entityOf('bridge')).toBe(entity);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);
  });

  it('перенос walkable-инстанса инвалидирует клетки под старым ∪ новым bbox', () => {
    const rig = makeRig(flatGrid(8, 4));
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([bridgeAt(1, 1)]);

    const notifications: { cells: readonly number[] | null; walkableOnly: boolean | undefined }[] = [];
    rig.source.onChange((cells, walkableOnly) => { notifications.push({ cells, walkableOnly }); });

    rig.decorations.apply([bridgeAt(6, 2)]);
    expect(notifications.length).toBe(1);
    const { cells, walkableOnly } = notifications[0]!;
    expect(walkableOnly).toBe(true);
    expect(cells).toContain(1 * 8 + 1); // старое место
    expect(cells).toContain(2 * 8 + 6); // новое место
    // Поле переехало вместе с инстансом.
    expect(rig.source.current!.heightAt(1, 1)).toBeCloseTo(0, 6);
    expect(rig.source.current!.heightAt(6, 2)).toBeCloseTo(1, 6);

    // Уход записи из документа освобождает клетки под прежним bbox.
    notifications.length = 0;
    rig.decorations.apply([]);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.cells).toContain(2 * 8 + 6);
    expect(rig.source.current!.heightAt(6, 2)).toBeCloseTo(0, 6);
  });

  it('правка не-walkable поля (скин) поле не трогает', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([bridgeAt(2, 2)]);

    const notifications: unknown[] = [];
    rig.source.onChange((cells) => notifications.push(cells));
    rig.decorations.apply([bridgeAt(2, 2, { skin: 'mossy' })]);
    expect(notifications.length).toBe(0);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);
  });

  it('правка террейн-формы пересаживает настил вместе с землёй под ним', () => {
    const rig = makeRig();
    rig.assets.resolve('model', BRIDGE_ID, makeBoxModel(1, 1));
    rig.decorations.apply([bridgeAt(2, 2)]);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(1, 6);

    // Кисть подняла клетки под мостом на уровень 1 (шаг 2): настил стоит на
    // террейн-форме и поднимается вместе с ней (design §5).
    rig.source.setGrid(createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0110', '0110', '0000'],
      flags: ['....', '....', '....', '....'],
    }));
    expect(rig.source.current!.terrainFormHeightAt(2, 2)).toBeCloseTo(STEP, 6);
    expect(rig.source.current!.heightAt(2, 2)).toBeCloseTo(STEP + 1, 6);
  });
});

// ------------------------------------------------------- смена размера арены

describe('WalkableSurfaceRegistry: смена размера арены', () => {
  const flatForm: TerrainFormSampler = {
    terrainFormHeightAt: () => 0,
    terrainFormNormalAt: (_wx, _wy, out) => {
      out.x = 0;
      out.y = 0;
      out.z = 1;
      return out;
    },
  };

  function placementAt(x: number, y: number): WalkablePlacement {
    return {
      x,
      y,
      yaw: 0,
      tiltFactor: 0,
      tiltMaxRad: null,
      scale: 1,
      model: makeBoxModel(1, 1),
    };
  }

  it('удаление записи после resize не оставляет фантомных клеток (регрессия)', () => {
    // Ключ клетки — cy * width + cx: привязки, сделанные под шириной 8, нельзя
    // снимать по формуле ширины 16. Порядок вызовов — как у setGrid источника:
    // configure ДО reseatAll.
    const registry = new WalkableSurfaceRegistry();
    registry.configure(8, 8, 1);
    registry.set(1, placementAt(2, 2), flatForm);
    expect(registry.coversCell(2 * 8 + 2)).toBe(true);

    registry.configure(16, 16, 1);
    registry.reseatAll(flatForm);
    expect(registry.coversCell(2 * 16 + 2)).toBe(true);

    registry.set(1, null, flatForm);
    expect(registry.size).toBe(0);
    // Ни одной накрытой клетки не осталось — в том числе клеток старой
    // раскладки [9, 10, 11, 25, 26, 27], которые терялись до исправления.
    for (let cell = 0; cell < 16 * 16; cell++) {
      expect(registry.coversCell(cell)).toBe(false);
    }
  });
});
