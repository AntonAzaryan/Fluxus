/**
 * Пост-обработка кадра (REND-34): цепочка собственных полноэкранных проходов —
 * порог bloom, пирамида даунсемплов и сведение яркости, — её ручки качества
 * (QUAL-1), счётчики стоимости (PERF-2, PERF-3), точка освобождения (REND-31) и
 * пересечение с маскирующим проходом тумана (FOW-7).
 *
 * WebGL здесь нет, как и во всём пакете: проходы проверяются записывающим
 * стабом рендерера — подсистема требует от него структурный минимум
 * (`PostRendererLike`), а «что за проход нарисован» видно по материалу
 * полноэкранного квада.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ColorLut, PresentationPostprocess } from '@fluxus/assets';
import {
  BLOOM_LEVELS,
  DEFAULT_ANTIALIAS_SAMPLES,
  DEFAULT_POSTPROCESS_CONFIG,
  FogSubsystem,
  POSTPROCESS_ANTIALIAS,
  POSTPROCESS_BLOOM,
  POSTPROCESS_BLOOM_RESOLUTION,
  POSTPROCESS_LUT,
  PostprocessSubsystem,
  PresentationStage,
  QualityController,
  createCostCounters,
  resolvePostprocessConfig,
  withCostSink,
  type EntityView,
  type PostRendererLike,
  type RenderContext,
} from '../src/index.js';
import { RESOLVE_FRAGMENT, createResolveMaterial } from '../src/postprocess/passes.js';
import {
  buildFogMask,
  flatGrid,
  fogCanvasFactory,
  makeAssets,
  makeEntityView,
  makeRenderContext,
  makeTickView,
} from './fixtures.js';

/** Размер кадра стенда: вершина пирамиды от него производна (design D4). */
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 48;

/**
 * Записывающий стаб рендерера: помимо целей и нарисованных сцен запоминает
 * МАТЕРИАЛ полноэкранного квада на момент прохода — по нему и видно, какой
 * проход цепочка заказала и в каком порядке.
 */
class PostRendererSpy implements PostRendererLike {
  readonly rendered: THREE.Object3D[] = [];
  readonly targets: (THREE.WebGLRenderTarget | null)[] = [];
  readonly materials: (THREE.Material | null)[] = [];
  readonly extensions?: { has(name: string): boolean };

  /**
   * `true` — расширение half-float есть, `false` — реестр отвечает «нет»,
   * `'unknown'` — реестра нет вовсе (спрашивать нечего, design D6).
   */
  constructor(float: boolean | 'unknown' = true) {
    if (float !== 'unknown') this.extensions = { has: () => float };
  }

  render(scene: THREE.Object3D): void {
    this.rendered.push(scene);
    const first = scene.children[0];
    this.materials.push(first instanceof THREE.Mesh ? (first.material as THREE.Material) : null);
  }

  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.targets.push(target);
  }

  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(FRAME_WIDTH, FRAME_HEIGHT);
  }
}

function subsystem(
  config?: PresentationPostprocess,
  warn?: (message: string) => void,
): { post: PostprocessSubsystem; ctx: RenderContext } {
  const ctx = makeRenderContext();
  const post = new PostprocessSubsystem({
    ...(config === undefined ? {} : { config }),
    ...(warn === undefined ? {} : { warn }),
  });
  post.init(ctx);
  return { post, ctx };
}

const camera = (): THREE.Camera => new THREE.PerspectiveCamera();

/** Секция «оператор без свечения»: сведение яркости — один проход цепочки. */
const TONE_ONLY: PresentationPostprocess = { toneMapping: { operator: 'aces', exposure: 1.2 } };

/** Секция «оператор и свечение»: порог, пирамида и сведение. */
const TONE_AND_BLOOM: PresentationPostprocess = {
  toneMapping: { operator: 'aces' },
  bloom: { enabled: true, strength: 0.5, threshold: 0.8, radius: 0.25 },
};

// -------------------------------------------- 2.1: умолчания ничего не стоят

describe('REND-34: умолчания не добавляют в кадр ни цели, ни прохода', () => {
  it('сцена без секции рисуется ровно прямой отрисовкой', () => {
    const { post, ctx } = subsystem();
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    expect(post.active).toBe(false);
    expect(renderer.rendered).toEqual([ctx.scene]);
    // Ни промежуточной цели, ни возврата на канвас: целей не заводилось вовсе.
    expect(renderer.targets).toEqual([]);
    expect(post.passes.scene).toBeNull();
    expect(post.passes.pyramid).toEqual([]);
    expect(post.passes.resolve).toBeNull();
  });

  it('секция умолчаний неотличима от её отсутствия: оператор none, bloom выключен', () => {
    for (const config of [
      {},
      { toneMapping: {} },
      { toneMapping: { operator: 'none' as const }, bloom: { enabled: false } },
    ] satisfies PresentationPostprocess[]) {
      const { post, ctx } = subsystem(config);
      const renderer = new PostRendererSpy();

      post.render(renderer, camera());

      expect(post.active, JSON.stringify(config)).toBe(false);
      expect(post.config).toEqual(DEFAULT_POSTPROCESS_CONFIG);
      expect(renderer.rendered).toEqual([ctx.scene]);
      expect(renderer.targets).toEqual([]);
    }
  });

  it('умолчания секции — документированные значения, а не нули', () => {
    expect(resolvePostprocessConfig(undefined)).toEqual(DEFAULT_POSTPROCESS_CONFIG);
    expect(resolvePostprocessConfig({ bloom: { enabled: true } })).toEqual({
      ...DEFAULT_POSTPROCESS_CONFIG,
      bloomEnabled: true,
    });
    // Оператор `none` и выключенный bloom — это и есть «кадр как прежде».
    expect(DEFAULT_POSTPROCESS_CONFIG.operator).toBe('none');
    expect(DEFAULT_POSTPROCESS_CONFIG.bloomEnabled).toBe(false);
  });

  it('неактивная цепочка не двигает счётчиков стоимости (PERF-2)', () => {
    const { post } = subsystem();
    const counters = createCostCounters();

    withCostSink(counters, () => {
      post.render(new PostRendererSpy(), camera());
    });

    expect(counters.postprocessPasses).toBe(0);
    expect(counters.postprocessTexels).toBe(0);
  });
});

// ------------------------------------------------- 2.1: порядок проходов

describe('REND-34: порядок проходов — сцена, bloom, сведение', () => {
  it('оператор без свечения — сцена в HDR-цель и один проход сведения', () => {
    const { post, ctx } = subsystem(TONE_ONLY);
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    expect(post.active).toBe(true);
    const passes = post.passes;
    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered).toHaveLength(2);
    expect(renderer.materials[1]).toBe(passes.resolve);
    // Цель сцены — half-float (design D6), выход сведения — на канвас.
    expect(passes.scene?.texture.type).toBe(THREE.HalfFloatType);
    expect(renderer.targets).toEqual([passes.scene, null, null]);
    // Пирамиды у сцены без свечения нет вовсе: платить за неё нечем.
    expect(passes.pyramid).toEqual([]);
    expect(passes.threshold).toBeNull();
  });

  it('оператор чанка three выбран define\'ом материала (design D3)', () => {
    const { post } = subsystem(TONE_ONLY);
    post.render(new PostRendererSpy(), camera());

    const defines = post.passes.resolve?.defines as Record<string, string>;
    expect(defines.POST_TONE_MAPPING).toBe('ACESFilmicToneMapping');
    // Экспозиция названа именем чанка: униформа материала грузится ПОСЛЕ
    // значения рендерера и потому действует авторское число секции.
    expect(post.passes.resolve?.uniforms.toneMappingExposure?.value).toBe(1.2);
  });

  it('свечение — порог, пирамида даунсемплов и сведение', () => {
    const { post, ctx } = subsystem(TONE_AND_BLOOM);
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    const passes = post.passes;
    expect(passes.pyramid).toHaveLength(BLOOM_LEVELS);
    // Сцена, порог, четыре даунсемпла, сведение — по проходу на ярус.
    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered).toHaveLength(2 + BLOOM_LEVELS);
    expect(renderer.materials[1]).toBe(passes.threshold);
    expect(renderer.materials.at(-1)).toBe(passes.resolve);
    // Ярус вдвое мельче предыдущего, вершина — вдвое мельче кадра (design D4).
    expect(passes.pyramid[0]?.width).toBe(FRAME_WIDTH / 2);
    expect(passes.pyramid[1]?.width).toBe(FRAME_WIDTH / 4);
    expect(passes.pyramid.at(-1)?.width).toBe(FRAME_WIDTH / 2 / 2 ** (BLOOM_LEVELS - 1));
    // Цели проходов записаны в порядке цепочки: сцена, ярусы, канвас.
    expect(renderer.targets).toEqual([
      passes.scene,
      ...passes.pyramid.map((level) => level),
      null,
      null,
    ]);
  });

  it('порог берётся от ЦЕЛИ СЦЕНЫ, то есть до сведения яркости (REND-34)', () => {
    const { post } = subsystem(TONE_AND_BLOOM);
    post.render(new PostRendererSpy(), camera());

    const passes = post.passes;
    // Вход порога — линейные значения кадра, а не выход оператора.
    expect(passes.threshold?.uniforms.tScene?.value).toBe(passes.scene?.texture);
    expect(passes.threshold?.uniforms.uThreshold?.value).toBe(0.8);
    // …и в проходе сведения свечение складывается ДО вызова оператора.
    const glow = RESOLVE_FRAGMENT.indexOf('uStrength * glow');
    const tone = RESOLVE_FRAGMENT.indexOf('POST_TONE_MAPPING(color)');
    expect(glow).toBeGreaterThan(0);
    expect(tone).toBeGreaterThan(glow);
  });

  it('свечение без оператора — сведение без тонемапа, а не отсутствие прохода', () => {
    const { post } = subsystem({ bloom: { enabled: true } });
    post.render(new PostRendererSpy(), camera());

    expect(post.active).toBe(true);
    const defines = post.passes.resolve?.defines as Record<string, string>;
    expect(defines.POST_TONE_MAPPING).toBeUndefined();
    expect(defines.POST_BLOOM).toBe('');
  });

  it('проходы и их тексели уходят в сток стоимости (PERF-2, PERF-3)', () => {
    const { post } = subsystem(TONE_AND_BLOOM);
    const counters = createCostCounters();

    withCostSink(counters, () => {
      post.render(new PostRendererSpy(), camera());
    });

    // Отрисовка сцены плюс полноэкранные проходы цепочки.
    expect(counters.postprocessPasses).toBe(2 + BLOOM_LEVELS);
    const pyramid = post.passes.pyramid.reduce(
      (sum, level) => sum + level.width * level.height,
      0,
    );
    // Тексели назначения: ярусы пирамиды плюс кадр прохода сведения.
    expect(counters.postprocessTexels).toBe(pyramid + FRAME_WIDTH * FRAME_HEIGHT);
  });
});

// ------------------------------------------------------- 2.3: ручки качества

describe('QUAL-1: ручки пост-обработки режут только вниз', () => {
  function withPreset(
    config: PresentationPostprocess,
    preset: Record<string, boolean | number>,
  ): PostprocessSubsystem {
    const ctx = makeRenderContext();
    const stage = new PresentationStage(ctx);
    const post = new PostprocessSubsystem({ config });
    stage.register(post);
    new QualityController(stage, preset);
    return post;
  }

  it('пресет вправе выключить авторски включённое свечение', () => {
    const post = withPreset(TONE_AND_BLOOM, { [POSTPROCESS_BLOOM]: false });
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    expect(post.config.bloomEnabled).toBe(false);
    // Оператор остался: сведение — по-прежнему проход, пирамиды больше нет.
    expect(post.active).toBe(true);
    expect(post.passes.pyramid).toEqual([]);
    expect(renderer.rendered).toHaveLength(2);
  });

  it('включить выключенное автором свечение пресет не может', () => {
    const post = withPreset({ toneMapping: { operator: 'aces' } }, { [POSTPROCESS_BLOOM]: true });

    expect(post.config.bloomEnabled).toBe(false);
  });

  it('потолок разрешения пирамиды — min(производное, потолок)', () => {
    // Ниже производной вершины (половина кадра) и не ниже границы ручки.
    const ceiling = 16;
    const post = withPreset(TONE_AND_BLOOM, { [POSTPROCESS_BLOOM_RESOLUTION]: ceiling });
    post.render(new PostRendererSpy(), camera());

    const top = post.passes.pyramid[0];
    expect(top?.width).toBe(ceiling);
    // Пропорции кадра держатся: потолок режет обе стороны одним множителем.
    expect(top?.height).toBe(Math.floor((FRAME_HEIGHT / 2) * (ceiling / (FRAME_WIDTH / 2))));
  });

  it('потолок выше производного разрешения картинки не улучшает', () => {
    const post = withPreset(TONE_AND_BLOOM, { [POSTPROCESS_BLOOM_RESOLUTION]: 4096 });
    post.render(new PostRendererSpy(), camera());

    expect(post.passes.pyramid[0]?.width).toBe(FRAME_WIDTH / 2);
  });

  it('документ сцены пресет не правит ни байтом', () => {
    const section: PresentationPostprocess = {
      toneMapping: { operator: 'aces' },
      bloom: { enabled: true },
    };
    const frozen = JSON.stringify(section);
    withPreset(section, { [POSTPROCESS_BLOOM]: false });

    expect(JSON.stringify(section)).toBe(frozen);
  });

  // --------------------------------- сглаживание рёбер (ручка `antialias`)

  it('цель сцены мультисэмплится: кадр с цепочкой сглажен так же, как без неё', () => {
    // `antialias: true` рендерера мультисэмплит ДЕФОЛТНЫЙ фреймбуфер, а
    // включённая цепочка рисует сцену в свою цель: без сэмплов на ней сцена с
    // пост-обработкой рисовалась бы каждым кадром без сглаживания вовсе.
    const { post } = subsystem(TONE_ONLY);
    post.render(new PostRendererSpy(), camera());

    expect(DEFAULT_ANTIALIAS_SAMPLES).toBe(4);
    expect(post.passes.scene?.samples).toBe(DEFAULT_ANTIALIAS_SAMPLES);
    // Текстура глубины при этом жива: её читает маскирующий проход тумана
    // (FOW-7), и three сводит многосэмпловую глубину в неё блитом.
    expect(post.passes.scene?.depthTexture).not.toBeNull();
    expect(post.passes.scene?.resolveDepthBuffer).toBe(true);
  });

  it('ручка `postprocess.antialias` снимает сэмплы, и цель заводится заново', () => {
    const post = withPreset(TONE_ONLY, { [POSTPROCESS_ANTIALIAS]: 0 });
    post.render(new PostRendererSpy(), camera());

    expect(post.passes.scene?.samples).toBe(0);
  });

  it('смена значения ручки в рантайме пересоздаёт цель сцены (ED-15)', () => {
    const ctx = makeRenderContext();
    const stage = new PresentationStage(ctx);
    const post = new PostprocessSubsystem({ config: TONE_ONLY });
    stage.register(post);
    const controller = new QualityController(stage);
    post.render(new PostRendererSpy(), camera());
    const before = post.passes.scene;
    expect(before?.samples).toBe(DEFAULT_ANTIALIAS_SAMPLES);

    controller.apply({ [POSTPROCESS_ANTIALIAS]: 2 });
    post.render(new PostRendererSpy(), camera());

    // Мультисэмплинг — свойство самой цели: другое число сэмплов означает
    // другую цель, а прежняя отдана (REND-31).
    expect(post.passes.scene).not.toBe(before);
    expect(post.passes.scene?.samples).toBe(2);
  });

  it('перечень значений ручки закрыт: 0, 2, 4 — и ничего между ними', () => {
    const ctx = makeRenderContext();
    const stage = new PresentationStage(ctx);
    stage.register(new PostprocessSubsystem());
    const knob = new QualityController(stage).knobs.find(
      (entry) => entry.name === POSTPROCESS_ANTIALIAS,
    );

    expect(knob?.semantics).toBe('value');
    expect(knob?.default).toBe(DEFAULT_ANTIALIAS_SAMPLES);
    expect(knob?.values).toEqual([0, 2, 4]);
  });
});

// ------------------------------------------------ 2.2: правка в рантайме

describe('ED-15: правка секции применяется на живой подсистеме', () => {
  it('смена оператора пересобирает ОДИН материал прохода, цели остаются', () => {
    const { post } = subsystem(TONE_ONLY);
    const renderer = new PostRendererSpy();
    post.render(renderer, camera());
    const before = { resolve: post.passes.resolve, scene: post.passes.scene };

    post.applyConfig({ toneMapping: { operator: 'agx' } });
    post.render(renderer, camera());

    const after = post.passes;
    expect(after.resolve).not.toBe(before.resolve);
    expect((after.resolve?.defines as Record<string, string>).POST_TONE_MAPPING).toBe(
      'AgXToneMapping',
    );
    // Цель сцены — та же: пересобран материал, а не цепочка.
    expect(after.scene).toBe(before.scene);
  });

  it('смена чисел — униформы, тот же материал', () => {
    const { post } = subsystem(TONE_AND_BLOOM);
    const renderer = new PostRendererSpy();
    post.render(renderer, camera());
    const resolve = post.passes.resolve;

    post.applyConfig({
      toneMapping: { operator: 'aces', exposure: 2 },
      bloom: { enabled: true, strength: 0.1, threshold: 3, radius: 0.9 },
    });

    expect(post.passes.resolve).toBe(resolve);
    expect(resolve?.uniforms.toneMappingExposure?.value).toBe(2);
    expect(resolve?.uniforms.uStrength?.value).toBe(0.1);
    expect(resolve?.uniforms.uRadius?.value).toBe(0.9);
    expect(post.passes.threshold?.uniforms.uThreshold?.value).toBe(3);
  });

  it('выключенная правкой цепочка отдаёт цели и возвращает прежний кадр', () => {
    const { post, ctx } = subsystem(TONE_AND_BLOOM);
    const renderer = new PostRendererSpy();
    post.render(renderer, camera());
    const target = post.passes.scene;
    expect(target).not.toBeNull();
    const released = vi.spyOn(target!, 'dispose');

    post.applyConfig(undefined);
    const after = new PostRendererSpy();
    post.render(after, camera());

    expect(released).toHaveBeenCalledTimes(1);
    expect(post.passes.scene).toBeNull();
    expect(post.passes.pyramid).toEqual([]);
    expect(after.rendered).toEqual([ctx.scene]);
    expect(after.targets).toEqual([]);
  });
});

// ------------------------------------------------------ 2.4: точка сноса

describe('REND-31: снос отдаёт цели, пирамиду и материалы', () => {
  it('всё, что цепочка положила в GPU, отдано, и кадр после сноса — прямой', () => {
    const { post, ctx } = subsystem(TONE_AND_BLOOM);
    post.render(new PostRendererSpy(), camera());
    const passes = post.passes;
    const spies = [
      vi.spyOn(passes.scene!, 'dispose'),
      vi.spyOn(passes.resolve!, 'dispose'),
      vi.spyOn(passes.threshold!, 'dispose'),
      ...passes.pyramid.map((level) => vi.spyOn(level, 'dispose')),
    ];

    post.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(post.passes.scene).toBeNull();
    expect(post.passes.pyramid).toEqual([]);
    // Кадр после сноса — ровно прямая отрисовка: цепочка снова ничего не стоит.
    const renderer = new PostRendererSpy();
    post.applyConfig(undefined);
    post.render(renderer, camera());
    expect(renderer.rendered).toEqual([ctx.scene]);
  });
});

// ----------------------------------------------- design D6: деградация в LDR

describe('REND-34: без расширения half-float цепочка идёт в LDR', () => {
  it('кадр остаётся корректным, а предупреждение сказано один раз', () => {
    const said: string[] = [];
    const { post } = subsystem(TONE_AND_BLOOM, (message) => {
      said.push(message);
    });
    const renderer = new PostRendererSpy(false);

    post.render(renderer, camera());
    post.render(renderer, camera());

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('EXT_color_buffer_float');
    expect(post.passes.hdr).toBe(false);
    expect(post.passes.scene?.texture.type).toBe(THREE.UnsignedByteType);
    // Проходы на месте: цепочка деградировала, а не отказала.
    expect(renderer.rendered).toHaveLength(2 * (2 + BLOOM_LEVELS));
  });

  it('у рендерера без реестра расширений спрашивать нечего — путь полный', () => {
    const { post } = subsystem(TONE_ONLY);
    post.render(new PostRendererSpy('unknown'), camera());

    expect(post.passes.hdr).toBe(true);
    expect(post.passes.scene?.texture.type).toBe(THREE.HalfFloatType);
  });

  it('половинной точности ДОСТАТОЧНО: EXT_color_buffer_half_float держит путь полным', () => {
    // Цель цепочки — RGBA16F, и рисуемой её делает именно это расширение.
    // Требовать более широкое `EXT_color_buffer_float` значило бы уводить в LDR
    // устройства, на которых запас яркости есть, — то есть ровно слабые.
    const said: string[] = [];
    const { post } = subsystem(TONE_AND_BLOOM, (message) => {
      said.push(message);
    });
    const renderer = new PostRendererSpy(true);
    Object.assign(renderer, {
      extensions: { has: (name: string) => name === 'EXT_color_buffer_half_float' },
    });

    post.render(renderer, camera());

    expect(post.passes.hdr).toBe(true);
    expect(post.passes.scene?.texture.type).toBe(THREE.HalfFloatType);
    expect(said).toEqual([]);
  });

  it('в LDR порог bloom прижат ниже единицы: иначе свечения нет вовсе, и молча', () => {
    // Умолчание секции — порог 1, «светится то, что ярче белого». В байтовой
    // цели ярче единицы не бывает ничего, и авторский порог не пропускал бы в
    // пирамиду ни одного текселя: bloom не терял бы диапазон, а не работал бы.
    const said: string[] = [];
    const { post } = subsystem({ bloom: { enabled: true } }, (message) => {
      said.push(message);
    });
    expect(post.config.bloomThreshold).toBe(1);

    post.render(new PostRendererSpy(false), camera());

    const threshold = post.passes.threshold?.uniforms.uThreshold?.value as number;
    expect(threshold).toBeLessThan(1);
    expect(threshold).toBe(0.8);
    // Деградация названа вслух, а не оставлена на догадку.
    expect(said[0]).toContain('0.8');

    // Правка соседнего поля секции не возвращает порог наверх: действующее
    // число считается одним кодом и в момент создания материала, и при правке.
    post.applyConfig({ bloom: { enabled: true, strength: 0.9 } });
    expect(post.passes.threshold?.uniforms.uThreshold?.value).toBe(0.8);
  });

  it('в HDR порог остаётся авторским: прижимает его именно фолбэк', () => {
    const { post } = subsystem({ bloom: { enabled: true } });
    post.render(new PostRendererSpy(true), camera());

    expect(post.passes.threshold?.uniforms.uThreshold?.value).toBe(1);
  });
});

// --------------------------- 2.5: точность выхода сведения (вход маски FOW-7)

describe('REND-34: цель выхода сведения хранит кадр без квантования', () => {
  it('в HDR выход half-float, как и цель сцены', () => {
    const { post } = subsystem(TONE_ONLY);

    post.renderToTexture(new PostRendererSpy(), camera());

    expect(post.passes.output?.texture.type).toBe(THREE.HalfFloatType);
  });

  it('в LDR выход байтовый, но в sRGB: линейный байт схлопывал бы тени', () => {
    // Байтовая цель БЕЗ цветового пространства хранит тонемапленный кадр
    // ЛИНЕЙНО: 1/255 линейного — это ~13/255 sRGB, то есть тринадцать нижних
    // уровней дисплея в одном. Маска тумана умножает этот кадр на свою величину
    // и кодирует sRGB уже на канвасе (FOW-7), поэтому затемнённое большинство
    // арены строилось бы из квантованного источника. Объявленное sRGB заставляет
    // three выделить SRGB8_ALPHA8 — кодирование и декодирование делает сам GL.
    const { post } = subsystem(TONE_ONLY);

    post.renderToTexture(new PostRendererSpy(false), camera());

    expect(post.passes.output?.texture.type).toBe(THREE.UnsignedByteType);
    expect(post.passes.output?.texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });
});

// ------------------------------- 2.6: экспозиция без оператора сведения

describe('REND-34: экспозиция действует и при операторе `none`', () => {
  it('цепочка со свечением и без оператора: экспозиция — голое умножение', () => {
    // Проход сведения на такой сцене существует (его завёл bloom), и молча
    // терять в нём авторское число секции нельзя: одно и то же поле работало бы
    // при пяти операторах и ничего не значило при шестом.
    const { post } = subsystem({
      toneMapping: { operator: 'none', exposure: 1.5 },
      bloom: { enabled: true },
    });
    post.render(new PostRendererSpy(), camera());

    const defines = post.passes.resolve?.defines as Record<string, string>;
    expect(defines.POST_TONE_MAPPING).toBeUndefined();
    expect(defines.POST_EXPOSURE).toBe('');
    expect(post.passes.resolve?.uniforms.toneMappingExposure?.value).toBe(1.5);
    // Множитель стоит там же, где вызов оператора: ПОСЛЕ сложения со свечением.
    const glow = RESOLVE_FRAGMENT.indexOf('uStrength * glow');
    const exposure = RESOLVE_FRAGMENT.indexOf('color *= toneMappingExposure');
    expect(exposure).toBeGreaterThan(glow);
  });

  it('правка числа идёт униформой, а не пересборкой материала (ED-15)', () => {
    const { post } = subsystem({
      toneMapping: { operator: 'none', exposure: 1.5 },
      bloom: { enabled: true },
    });
    post.render(new PostRendererSpy(), camera());
    const material = post.passes.resolve;

    post.applyConfig({ toneMapping: { operator: 'none', exposure: 0.5 }, bloom: { enabled: true } });

    expect(post.passes.resolve).toBe(material);
    expect(post.passes.resolve?.uniforms.toneMappingExposure?.value).toBe(0.5);
  });

  it('сцена без секции по-прежнему рисуется без единого прохода: экспозиция его не заводит', () => {
    const { post, ctx } = subsystem({ toneMapping: { operator: 'none', exposure: 2 } });
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    expect(post.active).toBe(false);
    expect(renderer.rendered).toEqual([ctx.scene]);
    expect(post.passes.resolve).toBeNull();
  });
});

// ------------------------------- 3: пересечение с маскирующим проходом (FOW-7)

describe('FOW-7, REND-34: маска остаётся финальным проходом кадра', () => {
  const STATS = { visionRadius: 'vision', team: 'team' } as const;

  function observer(): EntityView {
    return makeEntityView(1, {
      currX: 4,
      currY: 4,
      prevX: 4,
      prevY: 4,
      stats: new Map([
        [STATS.team, 0],
        [STATS.visionRadius, 3],
      ]),
    });
  }

  /** Стенд: туман с портом пост-обработки; маску строит вызывающий. */
  function stand(config?: PresentationPostprocess): {
    fog: FogSubsystem;
    post: PostprocessSubsystem;
    ctx: RenderContext;
  } {
    const ctx = makeRenderContext();
    const post = new PostprocessSubsystem(config === undefined ? {} : { config });
    post.init(ctx);
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      createCanvas: fogCanvasFactory(),
      post,
    });
    fog.init(ctx);
    return { fog, post, ctx };
  }

  it('без маски и без цепочки кадр — ровно прямая отрисовка', () => {
    const { fog, ctx } = stand();
    const renderer = new PostRendererSpy();

    fog.render(renderer, camera());

    expect(renderer.rendered).toEqual([ctx.scene]);
    expect(renderer.targets).toEqual([]);
  });

  it('без маски, но с цепочкой кадр — ровно её проходы, без маскирующего', () => {
    const { fog, post, ctx } = stand(TONE_ONLY);
    const renderer = new PostRendererSpy();

    fog.render(renderer, camera());

    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered).toHaveLength(2);
    // Последним нарисован проход СВЕДЕНИЯ, а не маскирующий: маски нет.
    expect(renderer.materials.at(-1)).toBe(post.passes.resolve);
    expect(renderer.targets).toEqual([post.passes.scene, null, null]);
  });

  it('с маской и без цепочки — сегодняшний кадр: сцена в цель, затем маска', () => {
    const { fog, ctx } = stand();
    fog.syncTick(makeTickView([observer()]));
    buildFogMask(fog);
    const renderer = new PostRendererSpy();

    fog.render(renderer, camera());

    expect(renderer.rendered).toHaveLength(2);
    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered[1]).toBe(fog.postPass.scene);
    expect(renderer.targets).toEqual([fog.postPass.target, null]);
  });

  it('с маской и цепочкой — сцена, сведение в цель, маска последней', () => {
    const { fog, post, ctx } = stand(TONE_AND_BLOOM);
    fog.syncTick(makeTickView([observer()]));
    buildFogMask(fog);
    const renderer = new PostRendererSpy();

    fog.render(renderer, camera());

    // Своей цели у тумана нет вовсе: сцену рисует цепочка.
    expect(fog.postPass.target).toBeNull();
    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered.at(-1)).toBe(fog.postPass.scene);
    expect(renderer.rendered).toHaveLength(3 + BLOOM_LEVELS);
    // Вход маскирующего прохода — выход сведения и глубина СЦЕНЫ (design D2).
    const uniforms = (fog.postPass.scene.children[0] as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    expect(uniforms.uniforms.tScene?.value).toBe(post.passes.output?.texture);
    expect(uniforms.uniforms.tDepth?.value).toBe(post.passes.scene?.depthTexture);
    // Маска рисуется на канвас: цепочка вернула цель кадра до неё.
    expect(renderer.targets.at(-1)).toBeNull();
  });

  it('переключение цепочки в рантайме меняет кадр не позже следующего (ED-15)', () => {
    const { fog, post } = stand();
    fog.syncTick(makeTickView([observer()]));
    buildFogMask(fog);
    const before = new PostRendererSpy();
    fog.render(before, camera());
    expect(before.rendered).toHaveLength(2);
    // Своя цель тумана заведена: сцену рисовал он сам.
    const own = fog.postPass.target;
    expect(own).not.toBeNull();
    const released = vi.spyOn(own!, 'dispose');

    post.applyConfig(TONE_ONLY);
    const after = new PostRendererSpy();
    fog.render(after, camera());

    // Цепочка взяла отрисовку на себя — своя цель отдана сразу, а не на сносе.
    expect(released).toHaveBeenCalledTimes(1);
    expect(fog.postPass.target).toBeNull();

    // Сцена, сведение, маска — и своя цель тумана больше не заводится.
    expect(after.rendered).toHaveLength(3);
    expect(after.rendered.at(-1)).toBe(fog.postPass.scene);
    expect(after.targets).toEqual([post.passes.scene, post.passes.output, null]);
  });

  it('выключение цепочки в рантайме возвращает кадр тумана к прежнему (ED-15)', () => {
    // Обратное направление того же переключения: владение отрисовкой сцены
    // возвращается туману, и кадр обязан стать в точности тем, каким был до
    // REND-34, — своя цель и два прохода (design Risks, FOW-7).
    const { fog, post } = stand(TONE_AND_BLOOM);
    fog.syncTick(makeTickView([observer()]));
    buildFogMask(fog);
    fog.render(new PostRendererSpy(), camera());
    expect(fog.postPass.target).toBeNull();

    post.applyConfig(undefined);
    const after = new PostRendererSpy();
    const counters = createCostCounters();
    withCostSink(counters, () => {
      fog.render(after, camera());
    });

    // Своя цель заведена заново, проходов снова два: сцена в цель и маска.
    const own = fog.postPass.target;
    expect(own).not.toBeNull();
    expect(after.rendered).toHaveLength(2);
    expect(after.rendered.at(-1)).toBe(fog.postPass.scene);
    expect(after.targets).toEqual([own, null]);
    expect(counters.fogRenderPasses).toBe(2);
    // Проходов цепочки в кадре нет вовсе — она выключена (REND-34, PERF-2).
    expect(counters.postprocessPasses).toBe(0);
    expect(post.passes.scene).toBeNull();
  });

  it('проходы тумана и цепочки считаются своими счётчиками (PERF-2)', () => {
    const { fog } = stand(TONE_ONLY);
    fog.syncTick(makeTickView([observer()]));
    buildFogMask(fog);
    const counters = createCostCounters();

    withCostSink(counters, () => {
      fog.render(new PostRendererSpy(), camera());
    });

    // У тумана — один проход (маскирующий): сцену рисовала цепочка.
    expect(counters.fogRenderPasses).toBe(1);
    expect(counters.postprocessPasses).toBe(2);
  });
});

// ------------------------------------------------ 4: цветокоррекция (LUT)

/** Тождественная таблица стороны 2 — форма данных ассета важнее её содержимого. */
function identityLut(size = 2): ColorLut {
  const data = new Float32Array(size * size * size * 3);
  const last = size - 1;
  let at = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[at++] = r / last;
        data[at++] = g / last;
        data[at++] = b / last;
      }
    }
  }
  return { size, data };
}

const LUT_ID = 'visuals/luts/warm.cube';
const WITH_LUT: PresentationPostprocess = { lut: { asset: LUT_ID, amount: 0.75 } };

/** Стенд с настоящим стабом ассетов: таблица приезжает асинхронно (ASSET-4). */
function lutStand(
  config: PresentationPostprocess = WITH_LUT,
  warn?: (message: string) => void,
): { post: PostprocessSubsystem; assets: ReturnType<typeof makeAssets>; ctx: RenderContext } {
  const assets = makeAssets();
  const ctx: RenderContext = { ...makeRenderContext(), assets: assets.service };
  const post = new PostprocessSubsystem({ config, ...(warn === undefined ? {} : { warn }) });
  post.init(ctx);
  return { post, assets, ctx };
}

describe('REND-34: LUT — цветокоррекция после сведения яркости', () => {
  it('до готовности таблицы кадр рисуется БЕЗ LUT и без единого прохода', () => {
    const { post, assets, ctx } = lutStand();
    const renderer = new PostRendererSpy();

    post.render(renderer, camera());

    // Ассет запрошен видом `lut` (ASSET-3), но кадром он ещё не рисует:
    // «наполовину загруженной таблицей» кадр не бывает.
    expect(assets.requests).toEqual([{ kind: 'lut', id: LUT_ID }]);
    expect(post.active).toBe(false);
    expect(post.passes.lut).toBeNull();
    // Ровно прямая отрисовка сцены: ни промежуточной цели, ни прохода (PERF-2).
    expect(renderer.rendered).toEqual([ctx.scene]);
    expect(renderer.targets).toEqual([]);
    expect(post.passes.scene).toBeNull();
  });

  it('готовая таблица включает проход: define, трёхмерная текстура и доля', () => {
    const { post, assets } = lutStand();

    assets.resolve('lut', LUT_ID, identityLut());
    post.render(new PostRendererSpy(), camera());

    expect(post.active).toBe(true);
    const texture = post.passes.lut;
    expect(texture).not.toBeNull();
    // Сторона решётки едет в униформу — выборка нормируется по ней.
    expect(texture!.image.width).toBe(2);
    const resolve = post.passes.resolve!;
    expect((resolve.defines as Record<string, string>).POST_LUT).toBe('');
    expect(resolve.uniforms.tLut?.value).toBe(texture);
    expect(resolve.uniforms.uLutSize?.value).toBe(2);
    expect(resolve.uniforms.uLutAmount?.value).toBe(0.75);
  });

  it('выборка стоит ПОСЛЕ оператора сведения и до кодирования кадра', () => {
    const tone = RESOLVE_FRAGMENT.indexOf('POST_TONE_MAPPING(color)');
    const lut = RESOLVE_FRAGMENT.indexOf('lutLookup(color)');
    // Именно директива включения, а не упоминание чанка в комментарии выше.
    const encode = RESOLVE_FRAGMENT.indexOf('#include <colorspace_fragment>');
    expect(tone).toBeGreaterThan(0);
    expect(lut).toBeGreaterThan(tone);
    expect(encode).toBeGreaterThan(lut);
  });

  it('домен таблицы — ОТОБРАЖАЕМЫЙ кадр: вход кодируется, выход декодируется', () => {
    // `.cube` автор снимает с той картинки, которую видит (REND-34: «таблица
    // авторится по итоговому виду кадра»), то есть с sRGB-кодированных значений.
    // Отдай мы решётке линейное рабочее пространство — грейд читался бы неверно
    // на всём кадре. Перенос идёт вокруг ВЫБОРКИ, а не вокруг прохода: проход
    // остаётся линейным и не зависит от своего назначения (цель или канвас).
    const encode = RESOLVE_FRAGMENT.indexOf('sRGBTransferOETF');
    const sample = RESOLVE_FRAGMENT.indexOf('texture(tLut');
    const decode = RESOLVE_FRAGMENT.indexOf('sRGBTransferEOTF');
    expect(encode).toBeGreaterThan(0);
    expect(sample).toBeGreaterThan(encode);
    expect(decode).toBeGreaterThan(sample);
  });

  it('материал сведения остаётся GLSL1-записью: явный GLSL3 снял бы шим three', () => {
    // Не-raw `ShaderMaterial` three компилирует как `#version 300 es` всегда, и
    // `sampler3D` там законен без всякого `glslVersion`. А вот ЯВНЫЙ GLSL3
    // выключает совместимость GLSL1-записи — `layout(location = 0) out highp
    // vec4 pc_fragColor` и `#define gl_FragColor pc_fragColor` добавляются
    // только при `glslVersion !== GLSL3` (`WebGLProgram`), — и текст этого
    // прохода, пишущий `gl_FragColor`, перестал бы компилироваться на каждом
    // кадре с таблицей. Программы здесь компилирует GPU, тесты пакета headless:
    // поймать такое можно только тут.
    const lut = new THREE.Data3DTexture(new Uint8Array(8 * 4), 2, 2, 2);
    const material = createResolveMaterial({
      operator: 'aces',
      exposure: 1,
      bloom: false,
      strength: 0,
      radius: 0,
      lut,
      lutAmount: 1,
    });
    expect(material.glslVersion).toBeNull();
    // …и без таблицы — тоже: версия материала от LUT не зависит вовсе.
    expect(
      createResolveMaterial({
        operator: 'aces',
        exposure: 1,
        bloom: false,
        strength: 0,
        radius: 0,
        lut: null,
        lutAmount: 1,
      }).glslVersion,
    ).toBeNull();
    material.dispose();
    lut.dispose();
  });

  it('недоступный ассет — кадр без LUT и предупреждение с причиной, а не падение', () => {
    const said: string[] = [];
    const { post, assets } = lutStand(WITH_LUT, (message) => {
      said.push(message);
    });

    expect(() => {
      assets.fail('lut', LUT_ID, 'файл не найден');
    }).not.toThrow();
    const renderer = new PostRendererSpy();
    post.render(renderer, camera());

    expect(post.passes.lut).toBeNull();
    expect(post.active).toBe(false);
    // Кадр — ровно прямая отрисовка сцены: ни цели, ни прохода (PERF-2).
    expect(renderer.targets).toEqual([]);
    expect(said.some((message) => message.includes('файл не найден'))).toBe(true);
    expect(said.some((message) => message.includes(LUT_ID))).toBe(true);
  });

  it('правка доли применения идёт униформой, смена таблицы — новым запросом (ED-15)', () => {
    const { post, assets } = lutStand();
    assets.resolve('lut', LUT_ID, identityLut());
    post.render(new PostRendererSpy(), camera());
    const resolve = post.passes.resolve;

    post.applyConfig({ lut: { asset: LUT_ID, amount: 0.25 } });
    post.render(new PostRendererSpy(), camera());

    // Материал тот же: число — униформа, а не define.
    expect(post.passes.resolve).toBe(resolve);
    expect(resolve?.uniforms.uLutAmount?.value).toBe(0.25);

    // Другой ассет — новый запрос и новая подписка.
    post.applyConfig({ lut: { asset: 'visuals/luts/cold.cube' } });
    expect(assets.requests.at(-1)).toEqual({ kind: 'lut', id: 'visuals/luts/cold.cube' });
    // Прежняя таблица снята сразу: рисовать кадр чужой коррекцией нельзя.
    expect(post.passes.lut).toBeNull();
  });

  it('снятая подсекция снимает таблицу и возвращает кадр к прямой отрисовке', () => {
    const { post, assets, ctx } = lutStand();
    assets.resolve('lut', LUT_ID, identityLut());
    post.render(new PostRendererSpy(), camera());
    const texture = post.passes.lut!;
    const released = vi.spyOn(texture, 'dispose');

    post.applyConfig(undefined);
    const renderer = new PostRendererSpy();
    post.render(renderer, camera());

    expect(released).toHaveBeenCalledTimes(1);
    expect(post.passes.lut).toBeNull();
    expect(post.active).toBe(false);
    expect(renderer.rendered).toEqual([ctx.scene]);
  });

  it('снос отдаёт трёхмерную текстуру таблицы (REND-31)', () => {
    const { post, assets } = lutStand();
    assets.resolve('lut', LUT_ID, identityLut());
    post.render(new PostRendererSpy(), camera());
    const released = vi.spyOn(post.passes.lut!, 'dispose');

    post.dispose();

    expect(released).toHaveBeenCalledTimes(1);
    expect(post.passes.lut).toBeNull();
  });

  it('потолок пресета выключает LUT, документ сцены не трогается (QUAL-1)', () => {
    const frozen = JSON.stringify(WITH_LUT);
    const assets = makeAssets();
    const ctx: RenderContext = { ...makeRenderContext(), assets: assets.service };
    const stage = new PresentationStage(ctx);
    const post = new PostprocessSubsystem({ config: WITH_LUT });
    stage.register(post);
    assets.resolve('lut', LUT_ID, identityLut());
    expect(post.passes.lut).not.toBeNull();

    new QualityController(stage, { [POSTPROCESS_LUT]: false });

    expect(post.config.lutAsset).toBeNull();
    expect(post.passes.lut).toBeNull();
    expect(post.active).toBe(false);
    expect(JSON.stringify(WITH_LUT)).toBe(frozen);
  });

  it('потолок `true` ненаписанную таблицу не заводит: `min` работает в одну сторону', () => {
    const assets = makeAssets();
    const ctx: RenderContext = { ...makeRenderContext(), assets: assets.service };
    const stage = new PresentationStage(ctx);
    const post = new PostprocessSubsystem({ config: TONE_ONLY });
    stage.register(post);

    new QualityController(stage, { [POSTPROCESS_LUT]: true });

    expect(post.config.lutAsset).toBeNull();
    expect(assets.requests).toEqual([]);
  });
});
