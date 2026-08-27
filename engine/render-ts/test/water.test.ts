/**
 * Подсистема воды (`rendering` REND-35) и рябь от движущихся сущностей
 * (REND-36): состав секции, геометрия тел, глубинная текстура из единого поля
 * высот (REND-9), два источника детали за одним ядром материала, ручки качества
 * (QUAL-1) и счётчики стоимости (PERF-2, PERF-3).
 *
 * WebGL здесь нет, как и во всём пакете (design D9): картинка проверяется
 * ДАННЫМИ и ГЕОМЕТРИЕЙ — числом квадов, содержимым глубинной текстуры,
 * униформами и `#define` материала, — а глазами она смотрится через
 * `npm run demo`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  validateCurvatureMap,
  validatePresentationScene,
  type NormalizedModel,
  type PresentationWater,
  type TerrainCurvatureMap,
} from '@fluxus/assets';
import {
  DEFAULT_WATER_DEPTH_TEXELS_PER_CELL,
  DEFAULT_WATER_DETAIL,
  DEFAULT_WATER_RIPPLES,
  PresentationStage,
  QualityController,
  VisualSurfaceSource,
  WATER_DEPTH_TEXELS_PER_CELL,
  WATER_DETAIL_LAYERS,
  WATER_RENDER_ORDER,
  WATER_RIPPLE_SOURCES,
  WaterRippleField,
  WaterSubsystem,
  createCostCounters,
  createWaterMaterial,
  fillWaterDepth,
  greedyRects,
  linearColorOf,
  resolveWaterConfig,
  waterDepthLayout,
  waterFragmentShader,
  waterRegionsOf,
  withCostSink,
  type RenderContext,
  type WaterRippleOptions,
} from '../src/index.js';
import { flatGrid, makeAssets, makeEntityView, makeRenderContext, makeTickView } from './fixtures.js';

/** Шаг высоты стенда: урез секции — в шкале уровней, перевод делает рендер (REND-7). */
const STEP = 0.6;
/** Сторона клетки: `flatGrid` строит арену по клетке в мировую единицу. */
const TILE = 1;

/**
 * Прямоугольный водоём в середине арены 8×8 — шесть на шесть клеток. Он ШИРЕ
 * лощины кривизны намеренно: кромка региона стоит на полу нулевого уровня, и
 * берег там рождается сам — карта лишь ограничила меш (REND-35).
 */
const BASIN_CELLS = [
  '........',
  '.000000.',
  '.000000.',
  '.000000.',
  '.000000.',
  '.000000.',
  '.000000.',
  '........',
];

/** Секция минимального состава: обязательны урез и два цвета (REND-35). */
function basin(over: Partial<PresentationWater['bodies'][number]> = {}): PresentationWater {
  return {
    cells: BASIN_CELLS,
    bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e', ...over }],
  };
}

/**
 * Лощина кривизны: узлы 2..6 опущены на полшага высоты. Клетка 3,3 целиком в
 * лощине, клетка 0,0 — на полу нулевого уровня: одна под водой, другая берег.
 */
function basinCurvature(): TerrainCurvatureMap {
  const rows = Array.from({ length: 9 }, (_, ny) =>
    Array.from({ length: 9 }, (_, nx) => (nx >= 2 && nx <= 6 && ny >= 2 && ny <= 6 ? -16 : 0)),
  );
  const result = validateCurvatureMap({ width: 8, height: 8, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

function surfaceWithBasin(): VisualSurfaceSource {
  const source = new VisualSurfaceSource(flatGrid());
  source.setCurvature(basinCurvature());
  return source;
}

interface Rig {
  readonly ctx: RenderContext;
  readonly water: WaterSubsystem;
  readonly warnings: string[];
  readonly surface: VisualSurfaceSource | undefined;
}

function makeRig(
  options: {
    config?: PresentationWater;
    surface?: VisualSurfaceSource | null;
    ctx?: RenderContext;
  } = {},
): Rig {
  const ctx = options.ctx ?? { ...makeRenderContext(), config: { heightStep: STEP } };
  const warnings: string[] = [];
  const surface = options.surface === null ? undefined : (options.surface ?? surfaceWithBasin());
  const water = new WaterSubsystem({
    grid: flatGrid(),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(surface === undefined ? {} : { surface }),
    warn: (message) => warnings.push(message),
  });
  water.init(ctx);
  return { ctx, water, warnings, surface };
}

/** Глубина, лежащая в текстуре тела: половинная точность декодируется как есть. */
function depthTexels(water: WaterSubsystem, body = 0): Float32Array {
  const view = water.drawnBodies[body]!;
  const texture = view.material.uniforms.tDepth!.value as THREE.DataTexture;
  const data = texture.image.data as Uint16Array;
  return Float32Array.from(data, (half) => THREE.DataUtils.fromHalfFloat(half));
}

/** Глубина в мировой точке — та же выборка, что делает фрагмент (design D1). */
function depthAt(water: WaterSubsystem, wx: number, wy: number, body = 0): number {
  const view = water.drawnBodies[body]!;
  const rect = view.material.uniforms.uDepthRect!.value as THREE.Vector4;
  const texture = view.material.uniforms.tDepth!.value as THREE.DataTexture;
  const width = texture.image.width;
  const height = texture.image.height;
  const u = (wx - rect.x) / rect.z;
  const v = (wy - rect.y) / rect.w;
  const tx = Math.min(Math.max(Math.floor(u * width), 0), width - 1);
  const ty = Math.min(Math.max(Math.floor(v * height), 0), height - 1);
  return depthTexels(water, body)[ty * width + tx]!;
}

// ------------------------------------------------ 2.1: геометрия тела (design D1)

describe('REND-35: клеточный регион и greedy-меш тела воды', () => {
  it('прямоугольный водоём — один квад, покрытие равно числу клеток', () => {
    const regions = waterRegionsOf(BASIN_CELLS, 8, 8, 1);
    const region = regions[0]!;
    expect(region.cells).toBe(36);
    expect(region.rects).toEqual([{ x0: 1, y0: 1, w: 6, h: 6 }]);
    expect([region.minX, region.minY, region.maxX, region.maxY]).toEqual([1, 1, 6, 6]);
  });

  it('фигурный регион: квадов больше одного, а покрытие — ровно клетки маски', () => {
    const shaped = [
      '00000000',
      '00000000',
      '00....00',
      '00....00',
      '00....00',
      '00....00',
      '00000000',
      '00000000',
    ];
    const region = waterRegionsOf(shaped, 8, 8, 1)[0]!;
    const covered = region.rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
    expect(covered).toBe(region.cells);
    expect(region.rects.length).toBe(4);
    // Прямоугольники не пересекаются: сумма площадей равна числу клеток маски,
    // а каждая клетка маски накрыта ровно одним из них.
    const hits = new Uint8Array(64);
    for (const rect of region.rects) {
      for (let y = rect.y0; y < rect.y0 + rect.h; y++) {
        for (let x = rect.x0; x < rect.x0 + rect.w; x++) hits[y * 8 + x]!++;
      }
    }
    expect([...hits]).toEqual([...region.mask]);
  });

  it('два тела в одной карте разбираются в два независимых региона', () => {
    const map = [
      '00..11..',
      '00..11..',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
    ];
    const [first, second] = waterRegionsOf(map, 8, 8, 2);
    expect(first!.cells).toBe(4);
    expect(second!.cells).toBe(4);
    expect(first!.rects).toEqual([{ x0: 0, y0: 0, w: 2, h: 2 }]);
    expect(second!.rects).toEqual([{ x0: 4, y0: 0, w: 2, h: 2 }]);
    // Маски не пересекаются: клетка принадлежит ровно одному телу (design D4).
    for (let i = 0; i < 64; i++) expect(first!.mask[i]! + second!.mask[i]!).toBeLessThanOrEqual(1);
  });

  it('greedy повторяем: два разбора одной маски дают один и тот же список', () => {
    const mask = new Uint8Array(16);
    for (const cell of [0, 1, 4, 5, 6, 9, 10]) mask[cell] = 1;
    expect(greedyRects(mask, 4, 4)).toEqual(greedyRects(mask, 4, 4));
  });
});

// ------------------------------------- 2.2: глубинная текстура из поля (REND-9)

describe('REND-35: глубина — разность уреза и единого поля высот', () => {
  it('контрольные точки: «урез − поле» с кривизной, берег — там, где поле выше', () => {
    const { water } = makeRig({ config: basin() });
    // Заполнение идёт кадром — «не позже следующего» (REND-35).
    water.updateFrame(0, 0);
    // Урез −0.1 уровня = −0.06 мировой; дно лощины −0.5 шага = −0.3 мировой.
    expect(depthAt(water, 3.5, 3.5)).toBeCloseTo(-0.1 * STEP - -0.5 * STEP, 3);
    // Клетка 1,1 стоит на полу нулевого уровня: её поле выше уреза — это берег,
    // и фрагмент там отбрасывается (глубина не положительна).
    expect(depthAt(water, 1.05, 1.05)).toBeLessThanOrEqual(0);
  });

  it('walkable-вклад поля (REND-9) поднимает дно и убирает воду над настилом', () => {
    const surface = surfaceWithBasin();
    const { water } = makeRig({ config: basin(), surface });
    water.updateFrame(0, 0);
    const before = depthAt(water, 3.5, 3.5);
    expect(before).toBeGreaterThan(0);

    surface.setWalkable(1, deckPlacement(3.5, 3.5));
    // Инвалидация приезжает подписчикам источника; перезаполнение — кадром.
    water.updateFrame(0, 0);
    expect(depthAt(water, 3.5, 3.5)).toBeLessThan(before);
  });

  it('сборка без порта источника поверхности: полем служит высота уровня (REND-7)', () => {
    const { water } = makeRig({ config: basin(), surface: null });
    water.updateFrame(0, 0);
    // Поле — уровень 0, урез −0.1 уровня: воды нет нигде, но и ошибки нет.
    const texels = depthTexels(water);
    expect(texels.length).toBeGreaterThan(0);
    for (const depth of texels) expect(depth).toBeCloseTo(-0.1 * STEP, 3);
    expect(water.drawnBodies.length).toBe(1);
  });

  it('урез в шкале уровней: смена шага высоты масштабирует воду, документ не правится', () => {
    // Абсолютной высоты документ не несёт (REND-35): в мировую урез переводит
    // рендер своим шагом (REND-7). Проверяется, что все три перевода —
    // плоскость меша, глубина текстуры и пороги материала — идут одним шагом и
    // не разъезжаются с полем, посчитанным источником поверхности.
    const section = basin();
    const snapshot = JSON.stringify(section);
    const atStep = (step: number) => {
      const ctx: RenderContext = { ...makeRenderContext(), config: { heightStep: step } };
      const rig = makeRig({ config: section, ctx });
      rig.water.updateFrame(0, 0);
      const body = rig.water.drawnBodies[0]!;
      const plane = (body.mesh.geometry.getAttribute('position').array as Float32Array)[2]!;
      return {
        depth: depthAt(rig.water, 3.5, 3.5),
        plane,
        maxDepth: body.material.uniforms.uMaxDepth!.value as number,
        foamWidth: body.material.uniforms.uFoamWidth!.value as number,
      };
    };

    const single = atStep(STEP);
    const doubled = atStep(STEP * 2);
    // Вода остаётся в той же лощине: и плоскость уреза, и глубина, и пороги
    // материала следуют за террейном ровно вдвое.
    expect(doubled.depth / single.depth).toBeCloseTo(2, 2);
    expect(doubled.plane).toBeCloseTo(single.plane * 2, 6);
    expect(doubled.maxDepth).toBeCloseTo(single.maxDepth * 2, 6);
    expect(doubled.foamWidth).toBeCloseTo(single.foamWidth * 2, 6);
    // Документ сцены при этом не правится ни байтом.
    expect(JSON.stringify(section)).toBe(snapshot);
  });

  it('плотность выборки — текселей на клетку, раскладка кроет ровно охват региона', () => {
    const region = waterRegionsOf(BASIN_CELLS, 8, 8, 1)[0]!;
    const layout = waterDepthLayout(region, TILE, DEFAULT_WATER_DEPTH_TEXELS_PER_CELL);
    expect(layout.width).toBe(6 * DEFAULT_WATER_DEPTH_TEXELS_PER_CELL);
    expect(layout.height).toBe(6 * DEFAULT_WATER_DEPTH_TEXELS_PER_CELL);
    expect(layout.originX).toBe(1);
    expect(layout.sizeX).toBe(6);
    // Заполнение возвращает число текселей — счётную величину стоимости (PERF-3).
    const data = new Uint16Array(layout.width * layout.height);
    expect(fillWaterDepth(data, layout, () => 0, 1)).toBe(layout.width * layout.height);
    expect(THREE.DataUtils.fromHalfFloat(data[0]!)).toBeCloseTo(1, 3);
  });
});

// ------------------------------- 2.3: инвалидация по затронутым клеткам (REND-14)

describe('REND-35: изменение поля видно в глубине не позже следующего кадра', () => {
  it('правка кривизны под телом перезаполняет тексели затронутых клеток', () => {
    const surface = surfaceWithBasin();
    const { water } = makeRig({ config: basin(), surface });
    water.updateFrame(0, 0);
    const before = depthAt(water, 3.5, 3.5);

    // Кисть кривизны углубляет лощину (ED-11): узлы 3..4 уходят ещё на полшага.
    const rows = Array.from({ length: 9 }, (_, ny) =>
      Array.from({ length: 9 }, (_, nx) =>
        nx >= 3 && nx <= 4 && ny >= 3 && ny <= 4 ? -32 : nx >= 2 && nx <= 6 && ny >= 2 && ny <= 6 ? -16 : 0,
      ),
    );
    const deeper = validateCurvatureMap({ width: 8, height: 8, rows });
    if (!deeper.ok) throw new Error(deeper.errors.join('; '));
    surface.setCurvature(deeper.map);
    water.updateFrame(0, 0);

    expect(depthAt(water, 3.5, 3.5)).toBeGreaterThan(before);
  });

  it('секция, поданная ПОСЛЕ init, тоже следует за полем: подписка не за проверкой секции', () => {
    // Так поднимает воду вьюпорт редактора: подсистема заводится пустой, а
    // секция приезжает черновиком позже (ED-15). Канал затронутых клеток —
    // единственное, чем до воды доезжают асинхронные правки поля (догрузка
    // карты кривизны, walkable-вклад доехавшей модели), и подписка за проверкой
    // секции оставила бы такую воду навсегда отставшей от дна (REND-35).
    const surface = surfaceWithBasin();
    const rig = makeRig({ surface });
    expect(rig.water.drawnBodies).toEqual([]);

    rig.water.applyConfig(basin());
    rig.water.updateFrame(0, 0);
    const before = depthAt(rig.water, 3.5, 3.5);
    expect(before).toBeGreaterThan(0);

    const rows = Array.from({ length: 9 }, (_, ny) =>
      Array.from({ length: 9 }, (_, nx) =>
        nx >= 3 && nx <= 4 && ny >= 3 && ny <= 4 ? -32 : nx >= 2 && nx <= 6 && ny >= 2 && ny <= 6 ? -16 : 0,
      ),
    );
    const deeper = validateCurvatureMap({ width: 8, height: 8, rows });
    if (!deeper.ok) throw new Error(deeper.errors.join('; '));
    surface.setCurvature(deeper.map);
    rig.water.updateFrame(0, 0);

    expect(depthAt(rig.water, 3.5, 3.5)).toBeGreaterThan(before);
  });

  it('кадр устоявшейся сцены текселей не перезаполняет — счётчик остаётся нулём', () => {
    const { water } = makeRig({ config: basin() });
    water.updateFrame(0, 0);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      water.updateFrame(0.016, 0.5);
    });
    expect(counters.waterDepthTexels).toBe(0);
    expect(counters.waterBodiesDrawn).toBe(1);
  });
});

// ------------------------------- 3: материал-ядро и два источника детали (D2, D3)

describe('REND-35: одно ядро материала, два источника детали', () => {
  it('процедурная вода не обращается к модулю ассетов ни разу', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    // Карта кривизны у источника поверхности задана из памяти, ассет ей не нужен.
    makeRig({ config: basin(), ctx });
    expect(assets.requests).toEqual([]);
  });

  it('материал прозрачен, не пишет глубину и стоит до прочих прозрачных', () => {
    const { water } = makeRig({ config: basin() });
    const body = water.drawnBodies[0]!;
    expect(body.material.transparent).toBe(true);
    expect(body.material.depthWrite).toBe(false);
    expect(body.mesh.renderOrder).toBe(WATER_RENDER_ORDER);
    expect(WATER_RENDER_ORDER).toBeLessThan(0);
    // Свет приходит механизмом three, а не ссылкой на подсистему освещения.
    expect(body.material.lights).toBe(true);
  });

  it('оба варианта детали держат ОДНИ униформы ядра — глубина, пена, берег', () => {
    const shared = [
      'uShallowColor',
      'uDeepColor',
      'uFoamColor',
      'uMaxDepth',
      'uBanding',
      'uFoamWidth',
      'uFoamHardness',
      'tDepth',
      'uDepthRect',
    ];
    const input = {
      body: resolveWaterConfig(basin())!.bodies[0]!,
      heightStep: STEP,
      layers: 2,
      rippleSources: 4,
      depth: new THREE.DataTexture(new Uint16Array(4), 2, 2),
      depthRect: new THREE.Vector4(0, 0, 1, 1),
    };
    const procedural = createWaterMaterial(input);
    const textured = createWaterMaterial({
      ...input,
      body: {
        ...input.body,
        detail: { ...input.body.detail, source: 'textured' },
      },
      detailNormal: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      detailFoam: new THREE.DataTexture(new Uint8Array(4), 1, 1),
    });
    for (const name of shared) {
      expect(Object.keys(procedural.uniforms), name).toContain(name);
      expect(Object.keys(textured.uniforms), name).toContain(name);
      expect(procedural.uniforms[name]!.value).not.toBeUndefined();
    }
    // Различает варианты ровно `#define` источника детали (design D2).
    expect(procedural.defines.WATER_DETAIL_TEXTURED).toBeUndefined();
    expect(textured.defines.WATER_DETAIL_TEXTURED).toBe('');
    expect(procedural.fragmentShader).toContain('sampleWaterDetail');
    expect(textured.fragmentShader).toContain('sampleWaterDetail');
    expect(procedural.fragmentShader).not.toContain('tDetailNormal');
    expect(textured.fragmentShader).toContain('tDetailNormal');
  });

  it('снятая правкой текстура детали отдаётся GPU, а оставшаяся — живёт (REND-31, ED-15)', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    const image = { width: 1, height: 1, format: 'rgba8' as const, pixels: new Uint8Array(4) };
    const textured = (normalMap: string): PresentationWater =>
      basin({ detail: { source: 'textured', normalMap, foamNoise: 'water/foam.png' } });
    const rig = makeRig({ config: textured('water/a.png'), ctx });
    assets.resolve('texture', 'water/a.png', image);
    assets.resolve('texture', 'water/foam.png', image);

    const body = rig.water.drawnBodies[0]!;
    expect(body.material.defines.WATER_DETAIL_TEXTURED).toBe('');
    const dropped = body.material.uniforms.tDetailNormal!.value as THREE.Texture;
    const kept = body.material.uniforms.tDetailFoam!.value as THREE.Texture;
    const released: string[] = [];
    dropped.addEventListener('dispose', () => released.push('a'));
    kept.addEventListener('dispose', () => released.push('foam'));

    // Автор переписал ID карты нормалей: прежняя карта секцией больше не
    // названа и держать её незачем, а шум пены она называет по-прежнему.
    rig.water.applyConfig(textured('water/b.png'));

    expect(released).toEqual(['a']);
    expect(assets.requests.map((request) => request.id)).toContain('water/b.png');
  });

  it('та же поломка после правки звучит заново: причины не копятся навсегда', () => {
    const broken = {
      cells: BASIN_CELLS.slice(0, 6),
      bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
    };
    const rig = makeRig({ config: broken });
    expect(rig.warnings).toHaveLength(1);

    // Починил — воду видно; сломал так же — предупреждение обязано прозвучать
    // ещё раз, иначе автор чинит вслепую.
    rig.water.applyConfig(basin());
    expect(rig.water.drawnBodies).toHaveLength(1);
    rig.water.applyConfig(broken);
    expect(rig.water.drawnBodies).toEqual([]);
    expect(rig.warnings).toHaveLength(2);
  });

  it('источник "textured" без ID текстур — авторская находка предупреждением', () => {
    const rig = makeRig({ config: basin({ detail: { source: 'textured' } }) });
    expect(rig.warnings.join('\n')).toContain('не назвал normalMap либо foamNoise');
    expect(rig.water.drawnBodies[0]!.material.defines.WATER_DETAIL_TEXTURED).toBeUndefined();
  });

  it('сборка фрагмента замкнута: каждое имя униформы в тексте объявлено в нём же', () => {
    /**
     * Компилятора GLSL в гейте нет — WebGL-контекста у пакета не бывает
     * (design D9), и картинка проверяется глазами через `npm run demo`. Но
     * САМАЯ дешёвая ошибка сборки текста — потерянное объявление униформы при
     * правке одной из веток `#define` — ловится без компилятора: имена наших
     * униформ следуют конвенции (`uЧисло`, `tТекстура`), и каждое использованное
     * обязано быть объявлено в том же тексте. Имена, которые кладёт три
     * (`viewMatrix`, `cameraPosition`, `ambientLightColor`, `directionalLights`),
     * под конвенцию не попадают и проверке не мешают.
     */
    const declared = (source: string): Set<string> =>
      new Set([...source.matchAll(/uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gu)].map((m) => m[1]!));
    const used = (source: string): Set<string> =>
      new Set([...source.matchAll(/\b([ut][A-Z]\w*)/gu)].map((m) => m[1]!));

    for (const textured of [false, true]) {
      for (const ripples of [0, 8]) {
        const where = `detail=${textured ? 'textured' : 'procedural'} ripples=${ripples}`;
        const source = waterFragmentShader(textured, ripples);
        const names = declared(source);
        for (const name of used(source)) {
          expect(names.has(name), `${where}: имя ${name} использовано, но не объявлено`).toBe(true);
        }
        // Ядро одно: две реализации семпла детали одновременно не попадают.
        expect([...source.matchAll(/vec3 sampleWaterDetail/gu)], where).toHaveLength(1);
        // Блок ряби вырезан целиком, а не погашен препроцессором.
        expect(source.includes('vec2 waterRippleSlope'), where).toBe(ripples > 0);
        expect(names.has('uRipples'), where).toBe(ripples > 0);
        // Кромка cel-бэнда сглажена, а не ступенчата (design D3): жёсткая
        // граница на почти горизонтальной воде ползёт ступеньками пикселей.
        const banded = /float waterBanded\(float t\) \{[\s\S]*?\n\}/u.exec(source)![0];
        expect(banded, where).toContain('smoothstep');
        expect(banded, where).toContain('fwidth');
      }
    }
  });

  it('недоступная текстура детали: procedural-фолбэк и предупреждение с причиной', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    const config = basin({
      detail: { source: 'textured', normalMap: 'water/normal.png', foamNoise: 'water/foam.png' },
    });
    const rig = makeRig({ config, ctx });
    // Пока ассет грузится, предупреждения нет: он доедет и пересоберёт материал
    // сам (ASSET-4). Предупреждение — только у НЕДОСТУПНОГО (REND-35).
    expect(rig.warnings).toEqual([]);
    assets.fail('texture', 'water/normal.png', 'файл не читается');

    expect(assets.requests.map((request) => request.id)).toContain('water/normal.png');
    expect(rig.warnings.join('\n')).toContain('файл не читается');
    expect(rig.warnings.join('\n')).toContain('деталь procedural');
    // Ядро не отличается от рабочего варианта: глубина и берег на месте.
    rig.water.updateFrame(0, 0);
    const body = rig.water.drawnBodies[0]!;
    expect(body.material.defines.WATER_DETAIL_TEXTURED).toBeUndefined();
    expect(depthAt(rig.water, 3.5, 3.5)).toBeGreaterThan(0);
  });
});

// -------------------------------------------- 4: подсистема и кадр (D6, REND-8)

describe('REND-35: подсистема за контрактом REND-8', () => {
  it('сцена без секции не создаёт ни мешей, ни текстур и не платит ничем', () => {
    const rig = makeRig();
    expect(rig.water.drawnBodies).toEqual([]);
    expect(rig.ctx.scene.children).toEqual([]);
    const counters = createCostCounters();
    withCostSink(counters, () => {
      rig.water.syncTick(makeTickView([]));
      rig.water.updateFrame(0.016, 0.5);
    });
    expect(counters.waterBodiesDrawn).toBe(0);
    expect(counters.waterQuads).toBe(0);
    expect(counters.waterDepthTexels).toBe(0);
    expect(counters.waterRippleSources).toBe(0);
  });

  it('тело без клеток в карте меша не получает: секция назвала, карта не разместила', () => {
    const config: PresentationWater = {
      cells: BASIN_CELLS,
      bodies: [
        { surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' },
        { surfaceLevel: 0, shallowColor: '#4db8c4', deepColor: '#16505e' },
      ],
    };
    const { water } = makeRig({ config });
    expect(water.drawnBodies.length).toBe(1);
  });

  it('неизменившаяся секция не пересобирает ничего (ED-15, PERF-2)', () => {
    // Подают её каждым грязным черновиком вьюпорта — правкой декорации, мазком
    // кисти; пересборка тела на такую подачу стоила бы новых геометрии,
    // материала и глубинной текстуры в тысячи текселей ни за что.
    const rig = makeRig({ config: basin() });
    const first = rig.water.drawnBodies[0]!;
    // Первый кадр заполняет глубинную текстуру — дальше устоявшаяся сцена.
    rig.water.updateFrame(0, 0);
    // Другой объект с тем же содержимым — документ разбирается заново на каждую
    // правку, поэтому сравнение идёт содержимым, а не ссылкой.
    rig.water.applyConfig(JSON.parse(JSON.stringify(basin())) as PresentationWater);
    expect(rig.water.drawnBodies[0]).toBe(first);

    const counters = createCostCounters();
    withCostSink(counters, () => {
      rig.water.updateFrame(0, 0);
    });
    // Тексели не перезаполнялись: пересборки не было, и метить было нечего.
    expect(counters.waterDepthTexels).toBe(0);

    // А настоящая правка тело пересобирает.
    rig.water.applyConfig(basin({ banding: 0 }));
    expect(rig.water.drawnBodies[0]).not.toBe(first);
  });

  it('переподача секции в рантайме (ED-15): меши обновлены, старые освобождены', () => {
    const rig = makeRig({ config: basin() });
    const first = rig.water.drawnBodies[0]!;
    const disposed: string[] = [];
    first.material.addEventListener('dispose', () => disposed.push('material'));
    first.mesh.geometry.addEventListener('dispose', () => disposed.push('geometry'));

    rig.water.applyConfig({
      cells: BASIN_CELLS.map((row, y) => (y === 4 ? row : row.replaceAll('0', '.'))),
      bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
    });

    expect(disposed).toContain('material');
    expect(disposed).toContain('geometry');
    expect(rig.water.drawnBodies.length).toBe(1);
    expect(rig.water.drawnBodies[0]).not.toBe(first);
    expect(rig.ctx.scene.children).toEqual([rig.water.drawnBodies[0]!.mesh]);

    // Снятие секции целиком (сцена без воды) не оставляет в сцене ничего.
    rig.water.applyConfig(undefined);
    expect(rig.water.drawnBodies).toEqual([]);
    expect(rig.ctx.scene.children).toEqual([]);
  });

  it('переподача сетки другой арены (REND-14) пересобирает тела по новой сетке', () => {
    const rig = makeRig({ config: basin() });
    const first = rig.water.drawnBodies[0]!;
    // Та же сетка — тела прежние: форму тела задаёт карта, а глубину поле, и
    // менять здесь нечего.
    rig.water.applyGrid(flatGrid());
    expect(rig.water.drawnBodies[0]).toBe(first);

    // Другая арена без новой карты — воды нет и есть предупреждение: карта 8×8
    // на сетку 4×4 не ложится, а дополнить её умолчанием REND-35 запрещает.
    rig.water.applyGrid(flatGrid(4));
    expect(rig.water.drawnBodies).toEqual([]);
    expect(rig.warnings.join('\n')).toContain('не ложится на сетку террейна 4×4');

    // Карта новой арены — тело собирается на ней.
    rig.water.applyConfig({
      cells: ['....', '.00.', '.00.', '....'],
      bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
    });
    expect(rig.water.drawnBodies).toHaveLength(1);
    expect(rig.water.drawnBodies[0]).not.toBe(first);
    expect(rig.ctx.scene.children).toEqual([rig.water.drawnBodies[0]!.mesh]);
  });

  it('карта не по сетке отвергается подсистемой: рядов не хватает — воды нет (REND-35)', () => {
    // Валидация загрузчика ассета сетки не видит (ASSET-3), поэтому последней
    // линией стоит сама подсистема: недостающие ряды НЕ дополняются точками.
    const rig = makeRig({
      config: {
        cells: BASIN_CELLS.slice(0, 6),
        bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
      },
    });
    expect(rig.water.drawnBodies).toEqual([]);
    expect(rig.ctx.scene.children).toEqual([]);
    expect(rig.warnings.join('\n')).toContain('не ложится на сетку террейна 8×8');
  });

  it('снос подсистемы (REND-31) отдаёт меши, материалы и глубинные текстуры', () => {
    const rig = makeRig({ config: basin() });
    const body = rig.water.drawnBodies[0]!;
    const released: string[] = [];
    body.material.addEventListener('dispose', () => released.push('material'));
    (body.material.uniforms.tDepth!.value as THREE.DataTexture).addEventListener('dispose', () =>
      released.push('depth'),
    );
    rig.water.dispose();
    expect(released.sort()).toEqual(['depth', 'material']);
    expect(rig.ctx.scene.children).toEqual([]);
  });
});

// ------------------------------------------------------------ 5: рябь (REND-36)

/** Опции отбора: тело — вся арена, порог и амплитуда из умолчаний секции. */
function rippleOptions(over: Partial<WaterRippleOptions> = {}): WaterRippleOptions {
  return {
    limit: 2,
    minSpeed: DEFAULT_WATER_RIPPLES.minSpeed,
    amplitude: DEFAULT_WATER_RIPPLES.amplitude,
    decaySeconds: DEFAULT_WATER_RIPPLES.decaySeconds,
    tile: TILE,
    nearWater: () => true,
    centerX: 0,
    centerY: 0,
    ...over,
  };
}

/** Множитель затухания кольца в шейдере: `1 − возраст/период` (material.ts). */
function fadeOf(age: number, decaySeconds: number): number {
  return Math.max(0, 1 - age / decaySeconds);
}

/** Сущность, идущая со скоростью `speed` мировых единиц за тик из точки. */
function walker(id: number, x: number, y: number, speed: number) {
  return makeEntityView(id, { prevX: x, prevY: y, currX: x + speed, currY: y, moving: speed > 0 });
}

describe('REND-36: рябь — производная presentation-состояния', () => {
  it('движущаяся в воде сущность становится источником, стоящая — нет', () => {
    const field = new WaterRippleField();
    const view = makeTickView([walker(1, 1, 1, 0.2), walker(2, 2, 2, 0)]);
    const sources = field.update(view, 1, 0.016, rippleOptions());
    expect(sources.map((source) => source.id)).toEqual([1]);
    expect(sources[0]!.amplitude).toBeGreaterThan(0);
  });

  it('два прогона над одним состоянием дают один набор, переполнение не мигает', () => {
    const view = makeTickView([
      walker(7, 5, 0, 0.2),
      walker(3, 1, 0, 0.2),
      walker(5, 3, 0, 0.2),
      walker(9, 1, 0, 0.2),
    ]);
    const first = new WaterRippleField().update(view, 1, 0, rippleOptions()).map((s) => s.id);
    const second = new WaterRippleField().update(view, 1, 0, rippleOptions()).map((s) => s.id);
    expect(second).toEqual(first);
    // Ближайшие к центру тела; равное расстояние разводит ID (сущности 3 и 9
    // стоят в одной точке, побеждает меньший).
    expect(first).toEqual([3, 9]);

    const field = new WaterRippleField();
    const frames = Array.from({ length: 4 }, () =>
      field.update(view, 1, 0.016, rippleOptions()).map((s) => s.id).join(','),
    );
    expect(new Set(frames).size).toBe(1);
  });

  it('отбор вставкой даёт тот же порядок, что полная сортировка кандидатов', () => {
    // Кандидатов вдвое больше потолка, два из них — на в точности равном
    // расстоянии от центра: порядок обязан быть функцией состояния, а не
    // порядка обхода карты сущностей (REND-36). Отбор идёт префиксом-вставкой
    // (REND-26), и эталон здесь считается независимо — сортировкой.
    const entities = [11, 4, 9, 2, 7, 5, 3, 8].map((id, index) =>
      walker(id, index % 2 === 0 ? index : index - 1, 0, 0.2),
    );
    const options = rippleOptions({ limit: 4, centerX: 0, centerY: 0 });
    const chosen = new WaterRippleField().update(makeTickView(entities), 1, 0, options);

    const expected = entities
      .map((entity) => ({ id: entity.id, distance: entity.currX * entity.currX }))
      .sort((a, b) => a.distance - b.distance || a.id - b.id)
      .slice(0, 4)
      .map((entry) => entry.id);
    expect(chosen.map((source) => source.id)).toEqual(expected);
  });

  it('пауза замораживает возраст кольца, ход мира его двигает (REND-25)', () => {
    const field = new WaterRippleField();
    const view = makeTickView([walker(1, 1, 1, 0.2)]);
    field.update(view, 1, 0.5, rippleOptions());
    expect(field.sources[0]!.age).toBeCloseTo(0.5, 6);
    field.update(view, 1, 0, rippleOptions());
    expect(field.sources[0]!.age).toBeCloseTo(0.5, 6);
    field.update(view, 1, 0.25, rippleOptions());
    expect(field.sources[0]!.age).toBeCloseTo(0.75, 6);
  });

  it('разрыв непрерывности сбрасывает накопленное: рябь не переезжает телепорт', () => {
    const field = new WaterRippleField();
    const moving = makeTickView([walker(1, 1, 1, 0.2)]);
    field.update(moving, 1, 0.8, rippleOptions());
    expect(field.sources[0]!.age).toBeCloseTo(0.8, 6);

    const teleported = makeTickView([
      makeEntityView(1, { prevX: 6, prevY: 6, currX: 6.2, currY: 6, snap: true }),
    ]);
    field.update(teleported, 1, 0.1, rippleOptions());
    expect(field.sources[0]!.age).toBeCloseTo(0.1, 6);
  });

  it('сущности вне отфильтрованного снапшота источником не становится (QUAL-2)', () => {
    const field = new WaterRippleField();
    // Врага в состоянии нет вовсе — фильтр видимости его не доставил (NET-12).
    const visible = makeTickView([walker(1, 1, 1, 0.2)]);
    expect(field.update(visible, 1, 0.016, rippleOptions()).map((s) => s.id)).toEqual([1]);
    const alone = makeTickView([]);
    expect(field.update(alone, 1, 0.016, rippleOptions())).toEqual([]);
  });

  it('вне клеток тела источника нет: рябь не расходится по суше', () => {
    const field = new WaterRippleField();
    const view = makeTickView([walker(1, 7, 7, 0.2)]);
    const options = rippleOptions({ nearWater: (cellX, cellY) => cellX < 4 && cellY < 4 });
    expect(field.update(view, 1, 0.016, options)).toEqual([]);
  });

  it('нулевой предел выключает рябь целиком', () => {
    const field = new WaterRippleField();
    const view = makeTickView([walker(1, 1, 1, 0.2)]);
    expect(field.update(view, 1, 0.016, rippleOptions({ limit: 0 }))).toEqual([]);
  });

  it('источники уезжают в униформу материала четвёрками (x, y, возраст, амплитуда)', () => {
    const field = new WaterRippleField();
    field.update(makeTickView([walker(1, 2, 3, 0.2)]), 0, 0.4, rippleOptions());
    const target = new Float32Array(8);
    expect(field.writeUniform(target, 2)).toBe(1);
    expect([target[0], target[1]]).toEqual([2, 3]);
    expect(target[2]).toBeCloseTo(0.4, 6);
    expect(target[3]).toBeGreaterThan(0);
    // Хвост — нули: амплитуда 0 означает «источника нет» (шейдер его пропускает).
    expect([...target.slice(4)]).toEqual([0, 0, 0, 0]);
  });

  it('идущая в воде сущность рябит НЕПРЕРЫВНО: источник переизлучает, а не выгорает', () => {
    // Кольцо живёт период `decaySeconds`; выгори источник за один период — юнит
    // рябил бы полторы секунды и дальше шёл по стеклу, а REND-36 требует колец,
    // пока сущность движется в воде.
    const field = new WaterRippleField();
    const options = rippleOptions({ limit: 1, decaySeconds: 0.5 });
    const view = makeTickView([walker(1, 1, 1, 0.2)]);
    let wraps = 0;
    let previous = 0;
    for (let frame = 0; frame < 200; frame++) {
      const [source] = field.update(view, 1, 0.05, options);
      expect(source, `кадр ${frame}`).toBeDefined();
      // Множитель затухания шейдера — `1 − возраст/период`: он обязан остаться
      // положительным на любом кадре, иначе кольца попросту нет.
      expect(fadeOf(source!.age, options.decaySeconds), `кадр ${frame}`).toBeGreaterThan(0);
      if (source!.age < previous) wraps++;
      previous = source!.age;
    }
    // Кольцо действительно переизлучилось много раз, а не застряло у нуля.
    expect(wraps).toBeGreaterThan(10);
  });

  it('перемотка ведёт кольца назад, но не усиливает их (REND-25)', () => {
    // Отрицательный `dt` — ход мира назад: возраст обязан остаться в периоде,
    // иначе множитель `1 − возраст/период` уходит ВЫШЕ единицы и кольцо в
    // скрабе растёт вместо того, чтобы гаснуть.
    const field = new WaterRippleField();
    const options = rippleOptions({ limit: 1, decaySeconds: 0.5 });
    const view = makeTickView([walker(1, 1, 1, 0.2)]);
    for (let frame = 0; frame < 40; frame++) {
      const [source] = field.update(view, 1, -0.05, options);
      expect(source!.age, `кадр ${frame}`).toBeGreaterThanOrEqual(0);
      expect(source!.age, `кадр ${frame}`).toBeLessThan(options.decaySeconds);
      const fade = fadeOf(source!.age, options.decaySeconds);
      expect(fade, `кадр ${frame}`).toBeGreaterThan(0);
      expect(fade, `кадр ${frame}`).toBeLessThanOrEqual(1);
    }
  });

  it('snap-тик рисуется без интерполяции: кольцо не идёт по линии телепорта', () => {
    const field = new WaterRippleField();
    const teleported = makeTickView([
      makeEntityView(1, { prevX: 1, prevY: 1, currX: 7, currY: 7, snap: true }),
    ]);
    // Кадр в НАЧАЛЕ тика (alpha 0): без правила REND-2 источник стоял бы в
    // точке отправления, пока модель уже на том берегу.
    const [source] = field.update(teleported, 0, 0.016, rippleOptions({ limit: 1 }));
    expect([source!.x, source!.y]).toEqual([7, 7]);
    // Обычный тик той же длины интерполируется как прежде.
    const moving = makeTickView([makeEntityView(2, { prevX: 1, prevY: 1, currX: 3, currY: 1 })]);
    const [smooth] = new WaterRippleField().update(moving, 0.5, 0.016, rippleOptions({ limit: 1 }));
    expect(smooth!.x).toBeCloseTo(2, 6);
  });

  it('разрыв непрерывности мира сбрасывает кольца всех тел (REND-2)', () => {
    const { water } = makeRig({ config: basin() });
    const ripples = (): Float32Array =>
      water.drawnBodies[0]!.material.uniforms.uRipples!.value as Float32Array;
    water.syncTick(makeTickView([walker(1, 3.5, 3.5, 0.2)]));
    water.updateFrame(0.5, 1);
    // Возраст кольца — третья компонента четвёрки источника.
    expect(ripples()[2]).toBeCloseTo(0.5, 5);

    const counters = createCostCounters();
    withCostSink(counters, () => {
      water.syncTick(makeTickView([walker(1, 3.5, 3.5, 0.2)], { snapAll: true }));
      water.updateFrame(0.016, 1);
    });
    expect(counters.waterRippleSources).toBe(1);
    // Возраст после сброса начинается заново — кольцо не «проехало» разрыв.
    expect(ripples()[2]).toBeCloseTo(0.016, 5);
  });
});

// ------------------------------------ 6: ручки качества и счётчики (QUAL-1, PERF-3)

describe('REND-35: ручки качества воды — потолки над авторским (QUAL-1)', () => {
  it('реестр сцены знает три ручки воды с семантикой потолка', () => {
    const stage = new PresentationStage({ ...makeRenderContext(), config: { heightStep: STEP } });
    const water = new WaterSubsystem({ grid: flatGrid(), config: basin() });
    stage.register(water);
    const knobs = new QualityController(stage).knobs;
    expect(knobs.map((knob) => knob.name)).toEqual([
      WATER_RIPPLE_SOURCES,
      WATER_DETAIL_LAYERS,
      WATER_DEPTH_TEXELS_PER_CELL,
    ]);
    for (const knob of knobs) {
      expect(knob.semantics).toBe('ceiling');
      expect(knob.default).toBe(Number.POSITIVE_INFINITY);
      expect(knob.cost.length).toBeGreaterThan(0);
    }
  });

  it('действующее значение — min(авторское, потолок); документ не мутируется', () => {
    const section = basin({ ripples: { sources: 6 }, detail: { layers: 3 } });
    const snapshot = JSON.stringify(section);
    const { water } = makeRig({ config: section });
    const authored = resolveWaterConfig(section)!.bodies[0]!;

    expect(water.limitsOf(authored).rippleSources).toBe(6);
    water.applyQuality(new Map([[WATER_RIPPLE_SOURCES, 2]]));
    expect(water.limitsOf(authored).rippleSources).toBe(2);
    // Потолок ВЫШЕ авторского авторское не поднимает.
    water.applyQuality(new Map([[WATER_RIPPLE_SOURCES, 16]]));
    expect(water.limitsOf(authored).rippleSources).toBe(6);
    // Слои детали и плотность глубины — тем же правилом.
    water.applyQuality(
      new Map<string, number>([
        [WATER_DETAIL_LAYERS, 2],
        [WATER_DEPTH_TEXELS_PER_CELL, 2],
      ]),
    );
    expect(water.limitsOf(authored).detailLayers).toBe(2);
    expect(water.limitsOf(authored).depthTexelsPerCell).toBe(2);

    expect(JSON.stringify(section)).toBe(snapshot);
  });

  it('потолок 0 источников выключает рябь, не трогая остального ядра', () => {
    const { water } = makeRig({ config: basin() });
    water.applyQuality(new Map([[WATER_RIPPLE_SOURCES, 0]]));
    const body = water.drawnBodies[0]!;
    expect(body.material.defines.WATER_RIPPLES).toBe('0');
    expect(body.material.fragmentShader).not.toContain('vec2 waterRippleSlope');

    const counters = createCostCounters();
    withCostSink(counters, () => {
      water.syncTick(makeTickView([walker(1, 3.5, 3.5, 0.2)]));
      water.updateFrame(0.016, 1);
    });
    expect(counters.waterRippleSources).toBe(0);
    // Глубина, пена и деталь действуют по-прежнему.
    expect(depthAt(water, 3.5, 3.5)).toBeGreaterThan(0);
    expect(body.material.uniforms.uMaxDepth!.value).toBeGreaterThan(0);
    expect(counters.waterBodiesDrawn).toBe(1);
  });

  it('потолок плотности глубины режет тексели квадратом', () => {
    const fine = makeRig({ config: basin() });
    const coarse = makeRig({ config: basin() });
    coarse.water.applyQuality(new Map([[WATER_DEPTH_TEXELS_PER_CELL, 2]]));
    const counted = (rig: Rig): number => {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        rig.water.updateFrame(0, 0);
      });
      return counters.waterDepthTexels;
    };
    expect(counted(fine)).toBe(4 * counted(coarse));
  });

  it('счётчики стоимости детерминированы: повтор кадра даёт те же числа (PERF-3)', () => {
    const run = (): number[] => {
      const { water } = makeRig({ config: basin() });
      const counters = createCostCounters();
      withCostSink(counters, () => {
        for (let frame = 0; frame < 4; frame++) {
          water.syncTick(makeTickView([walker(1, 3.5, 3.5, 0.2), walker(2, 3.2, 3.2, 0.3)]));
          water.updateFrame(0.016, 0.5);
        }
      });
      return [
        counters.waterBodiesDrawn,
        counters.waterQuads,
        counters.waterRippleSources,
        counters.waterDepthTexels,
      ];
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first[0]).toBe(4);
    expect(first[1]).toBe(4);
    expect(first[2]).toBe(8);
    expect(first[3]).toBe(36 * DEFAULT_WATER_DEPTH_TEXELS_PER_CELL ** 2);
  });
});

// ------------------------------------------- 1: секция документа (PRES-2, REND-35)

describe('PRES-2: секция water в документе и её умолчания', () => {
  it('валидная секция проходит документ и раскрывается умолчаниями (REND-35)', () => {
    const result = validatePresentationScene({ decorations: [], water: basin() });
    expect(result.ok).toBe(true);
    const config = resolveWaterConfig(basin())!;
    const body = config.bodies[0]!;
    expect(body.detail).toEqual(DEFAULT_WATER_DETAIL);
    expect(body.ripples).toEqual(DEFAULT_WATER_RIPPLES);
    expect(body.banding).toBe(3);
    // Цвет конвертируется в линейное пространство на приёме (REND-34).
    expect(body.shallowColor).toEqual(linearColorOf('#4db8c4'));
    expect(linearColorOf('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(linearColorOf('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(linearColorOf('#808080').r).toBeCloseTo(0.2158605, 6);
  });

  it('секции нет — воды нет: конфигурация null, а не пустая карта', () => {
    expect(resolveWaterConfig(undefined)).toBeNull();
  });
});

/** Настил над лощиной: горизонтальный квад на высоте 0 в канонических осях. */
function deckPlacement(x: number, y: number) {
  const model: NormalizedModel = {
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
        positions: new Float32Array([-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]),
        normals: null,
        uvs: null,
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        skinIndices: new Uint16Array(16),
        skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
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
    height: 1,
  };
  return { x, y, yaw: 0, tiltFactor: 0, tiltMaxRad: null, scale: 1, model };
}
