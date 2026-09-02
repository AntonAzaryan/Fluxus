/**
 * Цепочка проходов пост-обработки кадра (REND-34, design D1, D2, D4, D6): цели,
 * материалы, пирамида bloom и порядок проходов. Подсистема
 * (`subsystems/postprocess.ts`) держит контракт REND-8, конфигурацию и ручки
 * качества, а здесь — сам кадр.
 *
 * ## Порядок и владение (design D2)
 *
 * `сцена → порог → пирамида → сведение`. Цель сцены (half-float) заводит и
 * держит цепочка: при построенной маске тумана она отдаёт маскирующему проходу
 * ЦВЕТ (выход сведения) и ГЛУБИНУ сцены и не рисует на экран сама — маска
 * остаётся финальным проходом кадра (FOW-7). Без маски последний проход
 * цепочки пишет прямо на канвас.
 *
 * ## Ноль при умолчаниях (REND-34, PERF-2)
 *
 * Неактивная цепочка не заводит НИ ОДНОЙ цели и не делает НИ ОДНОГО прохода:
 * потребитель рисует сцену ровно так, как рисовал до появления capability. Всё,
 * что здесь создаётся, создаётся лениво — первым кадром активной цепочки — и
 * отдаётся обратно и на сносе (REND-31), и когда автор выключил цепочку правкой
 * секции.
 *
 * ## Half-float и деградация (design D6)
 *
 * Заяркостный диапазон живёт в half-float цели; расширение WebGL2 проверяется
 * один раз, на первом кадре, — раньше рендерера у подсистемы нет. Нет
 * расширения — цепочка идёт в LDR с предупреждением: кадр остаётся корректным,
 * bloom теряет запас яркости, а не падает.
 */
import * as THREE from 'three';
import type { ColorLut } from '@fluxus/assets';
import { costSink, type RenderCostCounters } from '../cost.js';
import { createWarnOnce, type WarnOnce } from '../warnOnce.js';
import { uniformOf } from '../uniforms.js';
import type { PostRendererLike, ScenePostFrame } from '../types.js';
import {
  DEFAULT_POSTPROCESS_CONFIG,
  isPostprocessActive,
  type PostprocessRenderConfig,
} from './config.js';
import {
  BLOOM_LEVELS,
  createDownsampleMaterial,
  createLutTexture,
  createResolveMaterial,
  createThresholdMaterial,
  toneMappingFunction,
} from './passes.js';
import { own } from '../footprint.js';

/**
 * Расширение WebGL2, без которого цель half-float не является рисуемой
 * (design D6). Спрашивается у рендерера один раз: реестра расширений у
 * тестового двойника нет вовсе, и тогда спрашивать нечего — цепочка идёт полным
 * путём, а настоящий `WebGLRenderer` этот реестр несёт всегда.
 */
const FLOAT_TARGET_EXTENSION = 'EXT_color_buffer_float';

/** Ярус пирамиды: цель и материал даунсемпла В НЕЁ; у вершины его нет — её пишет порог. */
interface BloomLevel {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial | null;
}

export interface PostprocessChainOptions {
  /** Канал предупреждений; не задан — `console.warn` (деградация в LDR, design D6). */
  readonly warn?: (message: string) => void;
}

export class PostprocessChain {
  private config: PostprocessRenderConfig = DEFAULT_POSTPROCESS_CONFIG;
  /**
   * Потолок ширины вершины пирамиды от пресета качества (QUAL-1, design D5);
   * бесконечность — потолка нет, действует производное от кадра разрешение.
   */
  private ceiling = Number.POSITIVE_INFINITY;

  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  /** Выход сведения для маскирующего прохода (design D2); null — цепочка пишет на экран. */
  private outputTarget: THREE.WebGLRenderTarget | null = null;
  private levels: BloomLevel[] = [];
  private thresholdMaterial: THREE.ShaderMaterial | null = null;
  private resolveMaterial: THREE.ShaderMaterial | null = null;
  /**
   * Трёхмерная таблица цвета (REND-34); `null` — подсекции `lut` нет, ассет ещё
   * грузится либо не загрузился. Строит её цепочка из разделяемых данных ассета
   * (ASSET-5) и владеет ею до своего сноса (REND-31).
   */
  private lutTexture: THREE.Data3DTexture | null = null;

  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh | null = null;

  /** Доступен ли half-float (design D6); проверяется на первом кадре цепочки. */
  private hdr = true;
  private checked = false;
  private readonly warnOnce: WarnOnce;
  private readonly size = new THREE.Vector2();
  /** Тексели кадра этой отрисовки — знаменатель прохода, пишущего на канвас. */
  private frameTexels = 0;

  constructor(options: PostprocessChainOptions = {}) {
    this.warnOnce = createWarnOnce(options.warn);
  }

  /** Действующая конфигурация цепочки — её пушит подсистема (QUAL-1, ED-15). */
  get current(): PostprocessRenderConfig {
    return this.config;
  }

  /**
   * Есть ли у цепочки работа: false — ни целей, ни проходов (REND-34).
   *
   * Таблица цвета входит сюда НАЛИЧИЕМ, а не объявлением: подсекция названа
   * документом, а таблица приезжает ассетом (ASSET-4), и до её готовности кадр
   * рисуется без LUT — «кадром, нарисованным наполовину загруженной таблицей»,
   * он не бывает ни на одном кадре (REND-34).
   */
  get active(): boolean {
    return isPostprocessActive(this.config) || this.lutTexture !== null;
  }

  /**
   * Цели и материалы цепочки — вход тестов и диагностики (REND-34): цель сцены,
   * выход сведения, ярусы пирамиды и материалы проходов. После сноса (REND-31)
   * не остаётся живым ни одного из них.
   */
  get passes(): {
    readonly scene: THREE.WebGLRenderTarget | null;
    readonly output: THREE.WebGLRenderTarget | null;
    readonly pyramid: readonly THREE.WebGLRenderTarget[];
    readonly resolve: THREE.ShaderMaterial | null;
    readonly threshold: THREE.ShaderMaterial | null;
    readonly lut: THREE.Data3DTexture | null;
    readonly hdr: boolean;
  } {
    return {
      scene: this.sceneTarget,
      output: this.outputTarget,
      pyramid: this.levels.map((level) => level.target),
      resolve: this.resolveMaterial,
      threshold: this.thresholdMaterial,
      lut: this.lutTexture,
      hdr: this.hdr,
    };
  }

  /**
   * Новая действующая конфигурация (ED-15): смена оператора или наличия bloom —
   * пересборка ОДНОГО материала сведения (design D3), смена чисел — униформы.
   * Выключенная цепочка отдаёт всё, чем владела: «ни целей, ни проходов»
   * действует и после правки, а не только на сцене, которая секции не имела.
   */
  apply(next: PostprocessRenderConfig): void {
    const previous = this.config;
    this.config = next;
    if (!this.active) {
      this.release();
      return;
    }
    const rebuilt =
      toneMappingFunction(next.operator) !== toneMappingFunction(previous.operator) ||
      next.bloomEnabled !== previous.bloomEnabled;
    if (rebuilt) {
      this.resolveMaterial?.dispose();
      this.resolveMaterial = null;
    }
    if (!next.bloomEnabled) this.releaseBloom();
    this.pushUniforms();
  }

  /**
   * Загруженная таблица цвета либо её отсутствие (REND-34, ED-15). Наличие
   * таблицы — DEFINE материала сведения (design D5, `POST_LUT`), поэтому смена
   * наличия пересобирает ОДИН этот материал: событие догрузки ассета (ASSET-4),
   * правки секции или потолка пресета (QUAL-1), а не кадровый путь.
   *
   * Данные ассета разделяемы и иммутабельны (ASSET-5) — GPU-объект из них
   * цепочка строит СВОЙ и им же владеет: снос отдаёт его (REND-31).
   */
  applyLut(lut: ColorLut | null): void {
    // «Таблицы не было и нет» — не событие: снятие несуществующей таблицы не
    // должно пересобирать материал сведения на каждом отказе ассета.
    if (lut === null && this.lutTexture === null) return;
    this.releaseLut();
    if (lut !== null) this.lutTexture = createLutTexture(lut);
    // Материал сведения пересобирается всегда: и появление таблицы, и её
    // снятие меняют define, а старая униформа держала бы снесённую текстуру.
    this.resolveMaterial?.dispose();
    this.resolveMaterial = null;
    if (!this.active) this.release();
  }

  /** Потолок ширины вершины пирамиды (QUAL-1): `min(производное, потолок)`. */
  applyResolutionCeiling(ceiling: number): void {
    if (ceiling === this.ceiling) return;
    this.ceiling = ceiling;
    // Пирамида другого разрешения — другие цели; они заведутся ближайшим кадром.
    this.releaseBloom();
  }

  /**
   * Кадр цепочки (design D2). `capture` — писать выход сведения в цель и вернуть
   * её вместе с глубиной сцены: так его читает маскирующий проход тумана
   * (FOW-7). Иначе последний проход пишет на канвас, и возвращается `null`.
   */
  render(
    renderer: PostRendererLike,
    scene: THREE.Object3D,
    camera: THREE.Camera,
    capture: boolean,
  ): ScenePostFrame | null {
    const cost = costSink();
    const size = renderer.getDrawingBufferSize(this.size);
    // Целые тексели — и целями, и счётчиками (PERF-3): дробный размер буфера
    // сделал бы число текселей прохода зависимым от устройства.
    const width = Math.max(1, Math.floor(size.x));
    const height = Math.max(1, Math.floor(size.y));
    this.frameTexels = width * height;
    this.checkFloatTarget(renderer);
    const target = this.ensureSceneTarget(width, height);

    // Сцена — в HDR-цель: порог bloom и оператор работают ДО кодирования, то
    // есть по линейным значениям кадра (REND-34).
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (cost !== undefined) cost.postprocessPasses++;

    if (this.config.bloomEnabled) this.renderBloom(renderer, width, height, cost);
    const output = capture ? this.ensureOutputTarget(width, height) : null;
    this.draw(renderer, this.ensureResolve(target), output, cost);
    // Цель кадра всегда возвращается на канвас: следующий проход — чужой
    // (маскирующий проход тумана), и оставлять ему свою цель нельзя.
    renderer.setRenderTarget(null);
    if (output === null) return null;
    // ponytail (REND-26): запись входа маски — две ссылки, ОДНА на кадр и
    // только на кадр С МАСКОЙ; ни с числом сущностей, ни с объёмом контента
    // давление на GC от неё не растёт. Переиспользуемое поле держало бы ссылки
    // на цели после сноса (REND-31) — цена, которую платить стоит по замеру на
    // реальной сцене, а не по вкусу.
    return { color: output.texture, depth: target.depthTexture };
  }

  /**
   * Снос (REND-31): цели, пирамида, материалы проходов и геометрия квада. Сцена
   * проходов принадлежит цепочке, сцена мира — нет: в неё она только рисует.
   */
  dispose(): void {
    this.release();
    this.releaseLut();
    this.quad?.geometry.dispose();
    this.quad?.removeFromParent();
    this.quad = null;
  }

  // ------------------------------------------------------------- проходы

  /** Порог и пирамида (design D4): вершина от цели сцены, дальше — даунсемплы. */
  private renderBloom(
    renderer: PostRendererLike,
    width: number,
    height: number,
    cost: RenderCostCounters | undefined,
  ): void {
    const levels = this.ensurePyramid(width, height);
    const threshold = this.ensureThreshold();
    uniformOf(threshold, 'tScene').value = this.sceneTarget?.texture ?? null;
    this.draw(renderer, threshold, levels[0]?.target ?? null, cost);
    for (let index = 1; index < levels.length; index++) {
      const level = levels[index];
      const source = levels[index - 1];
      if (level === undefined || source === undefined || level.material === null) continue;
      const material = level.material;
      uniformOf(material, 'tSource').value = source.target.texture;
      (material.uniforms.uTexel as { value: THREE.Vector2 }).value.set(
        1 / source.target.width,
        1 / source.target.height,
      );
      this.draw(renderer, material, level.target, cost);
    }
  }

  /** Один полноэкранный проход: материал на квад, цель, счётчики (PERF-2, PERF-3). */
  private draw(
    renderer: PostRendererLike,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
    cost: RenderCostCounters | undefined,
  ): void {
    const quad = this.ensureQuad(material);
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.passScene, this.passCamera);
    if (cost === undefined) return;
    cost.postprocessPasses++;
    cost.postprocessTexels += target === null ? this.frameTexels : target.width * target.height;
  }

  private ensureQuad(material: THREE.ShaderMaterial): THREE.Mesh {
    const existing = this.quad;
    if (existing !== null) return existing;
    const quad = new THREE.Mesh(own('geometry', 'postprocess', new THREE.PlaneGeometry(2, 2)), material);
    quad.frustumCulled = false;
    this.passScene.add(quad);
    this.quad = quad;
    return quad;
  }

  // ---------------------------------------------------- цели и материалы

  /**
   * Проверка расширения half-float (design D6) — один раз за жизнь цепочки, на
   * первом её кадре: рендерер приезжает кадром, а не инициализацией (REND-8).
   */
  private checkFloatTarget(renderer: PostRendererLike): void {
    if (this.checked) return;
    this.checked = true;
    const extensions = renderer.extensions;
    if (extensions === undefined || extensions.has(FLOAT_TARGET_EXTENSION)) return;
    this.hdr = false;
    this.warnOnce(
      FLOAT_TARGET_EXTENSION,
      `пост-обработка: расширения ${FLOAT_TARGET_EXTENSION} нет — цепочка идёт в LDR (REND-34): кадр корректен, но bloom теряет заяркостный диапазон`,
    );
  }

  /** Тип текселя целей цепочки: half-float, а без расширения — байт (design D6). */
  private get texelType(): THREE.TextureDataType {
    return this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  /** HDR-цель сцены с текстурой глубины: глубину читает маскирующий проход (FOW-7). */
  private ensureSceneTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const existing = this.sceneTarget;
    if (existing !== null && existing.width === width && existing.height === height) return existing;
    // Пересоздание по размеру окна отдаёт и цель, и её текстуру глубины —
    // тем же правилом, что и снос (см. `release`).
    existing?.depthTexture?.dispose();
    existing?.dispose();
    const depthTexture = own('texture', 'postprocess', new THREE.DepthTexture(width, height));
    const target = own(
      'renderTarget',
      'postprocess',
      new THREE.WebGLRenderTarget(width, height, {
        depthTexture,
        depthBuffer: true,
        type: this.texelType,
      }),
    );
    this.sceneTarget = target;
    return target;
  }

  /** LDR-цель выхода сведения: её читает маскирующий проход тумана (design D2). */
  private ensureOutputTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const existing = this.outputTarget;
    if (existing !== null && existing.width === width && existing.height === height) return existing;
    existing?.dispose();
    const target = own(
      'renderTarget',
      'postprocess',
      new THREE.WebGLRenderTarget(width, height, { depthBuffer: false }),
    );
    this.outputTarget = target;
    return target;
  }

  /**
   * Пирамида bloom (design D4): вершина вдвое мельче кадра и не крупнее потолка
   * пресета (`min(производное, потолок)`, QUAL-1), каждый следующий ярус вдвое
   * мельче предыдущего. Пропорции кадра держатся: потолок режет обе стороны
   * одним множителем, иначе свечение растягивалось бы по одной оси.
   */
  private ensurePyramid(width: number, height: number): readonly BloomLevel[] {
    const half = Math.max(1, Math.floor(width / 2));
    const topWidth = Math.max(1, Math.floor(Math.min(half, this.ceiling)));
    const topHeight = Math.max(1, Math.floor((height / 2) * (topWidth / half)));
    const top = this.levels[0]?.target;
    if (top?.width === topWidth && top.height === topHeight) return this.levels;
    this.releaseBloom();
    const levels: BloomLevel[] = [];
    for (let index = 0; index < BLOOM_LEVELS; index++) {
      const divisor = 2 ** index;
      const target = own(
        'renderTarget',
        'postprocess',
        new THREE.WebGLRenderTarget(
          Math.max(1, Math.floor(topWidth / divisor)),
          Math.max(1, Math.floor(topHeight / divisor)),
          {
            depthBuffer: false,
            type: this.texelType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
          },
        ),
      );
      levels.push({ target, material: index === 0 ? null : createDownsampleMaterial() });
    }
    this.levels = levels;
    return levels;
  }

  private ensureThreshold(): THREE.ShaderMaterial {
    const existing = this.thresholdMaterial;
    if (existing !== null) return existing;
    const material = createThresholdMaterial(this.config.bloomThreshold);
    this.thresholdMaterial = material;
    return material;
  }

  /** Материал сведения; вход — цель сцены и ярусы пирамиды (design D3, D4). */
  private ensureResolve(sceneTarget: THREE.WebGLRenderTarget): THREE.ShaderMaterial {
    const config = this.config;
    const material =
      this.resolveMaterial ??
      createResolveMaterial({
        operator: config.operator,
        exposure: config.exposure,
        bloom: config.bloomEnabled,
        strength: config.bloomStrength,
        radius: config.bloomRadius,
        lut: this.lutTexture,
        lutAmount: config.lutAmount,
      });
    this.resolveMaterial = material;
    uniformOf(material, 'tScene').value = sceneTarget.texture;
    if (config.bloomEnabled) {
      for (let index = 0; index < BLOOM_LEVELS; index++) {
        const uniform = material.uniforms[`tBloom${index}`];
        if (uniform !== undefined) uniform.value = this.levels[index]?.target.texture ?? null;
      }
    }
    return material;
  }

  /** Числа секции на живые материалы (ED-15): пересборки они не требуют. */
  private pushUniforms(): void {
    const config = this.config;
    const threshold = this.thresholdMaterial;
    if (threshold !== null) {
      uniformOf(threshold, 'uThreshold').value = config.bloomThreshold;
    }
    const resolve = this.resolveMaterial;
    if (resolve === null) return;
    const exposure = resolve.uniforms.toneMappingExposure;
    if (exposure !== undefined) exposure.value = config.exposure;
    const strength = resolve.uniforms.uStrength;
    if (strength !== undefined) strength.value = config.bloomStrength;
    const radius = resolve.uniforms.uRadius;
    if (radius !== undefined) radius.value = config.bloomRadius;
    // Доля применения таблицы — число, а не define: правка `amount` в рантайме
    // идёт униформой и пересборки материала не требует (ED-15).
    const amount = resolve.uniforms.uLutAmount;
    if (amount !== undefined) amount.value = config.lutAmount;
  }

  // ---------------------------------------------------------- освобождение

  /**
   * Всё, чем цепочка владеет в GPU, кроме квада: он переживает выключение.
   *
   * Таблица цвета сюда НЕ входит: выключение цепочки — следствие того, что
   * таблицы нет (`active`), и снимает её `applyLut`; выключение по другому
   * поводу при живой таблице невозможно по построению.
   */
  private release(): void {
    this.releaseBloom();
    // Текстуру глубины HDR-цели завела ЦЕПОЧКА, а не цель: `dispose()` цели
    // рассылает только собственное событие, и без этой строки текстура
    // пережила бы и смену размера окна, и снос (REND-31, PERF-9).
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.sceneTarget = null;
    this.outputTarget?.dispose();
    this.outputTarget = null;
    this.resolveMaterial?.dispose();
    this.resolveMaterial = null;
  }

  /** Трёхмерная текстура таблицы цвета — её строила цепочка, ей и отдавать. */
  private releaseLut(): void {
    this.lutTexture?.dispose();
    this.lutTexture = null;
  }

  /** Пирамида и порог: их отдаёт и выключение bloom, и смена его разрешения. */
  private releaseBloom(): void {
    for (const level of this.levels) {
      level.target.dispose();
      level.material?.dispose();
    }
    this.levels = [];
    this.thresholdMaterial?.dispose();
    this.thresholdMaterial = null;
  }
}
