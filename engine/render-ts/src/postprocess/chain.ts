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
 * Заяркостный диапазон живёт в half-float цели; расширения WebGL2 проверяются
 * один раз, на первом кадре, — раньше рендерера у подсистемы нет. Нет ни
 * одного — цепочка идёт в LDR с предупреждением: кадр остаётся корректным, а
 * bloom теряет запас яркости, но не работу. Последнее не даром: в байтовой цели
 * ничего ярче единицы не бывает, поэтому вместе с диапазоном прижимается и порог
 * (`LDR_BLOOM_THRESHOLD_MAX`) — иначе авторское «светится то, что ярче белого»
 * не пропускало бы в свечение ни одного текселя, и bloom молча не работал бы
 * вовсе.
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
  createFxaaMaterial,
  createLutTexture,
  createResolveMaterial,
  toneMappingFunction,
} from './passes.js';
import { BloomPyramid } from './bloom.js';
import { own } from '../footprint.js';

/**
 * Расширения WebGL2, любое из которых делает цель half-float рисуемой (design
 * D6). Спрашиваются у рендерера один раз: реестра расширений у тестового
 * двойника нет вовсе, и тогда спрашивать нечего — цепочка идёт полным путём, а
 * настоящий `WebGLRenderer` этот реестр несёт всегда.
 *
 * Их два, и второго ДОСТАТОЧНО: цель цепочки — RGBA16F, и рисуемой её делает
 * `EXT_color_buffer_half_float`; `EXT_color_buffer_float` шире (он добавляет ещё
 * и 32-битные цели), и требовать именно его значило бы уводить в LDR
 * устройства, на которых половинная точность есть, — то есть ровно слабые, где
 * запас яркости и нужен.
 */
const FLOAT_TARGET_EXTENSIONS = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'] as const;

/**
 * Потолок порога bloom в LDR-фолбэке (design D6). Байтовая цель не хранит
 * ничего ярче единицы, поэтому авторский порог 1 — умолчание секции, «светится
 * то, что ярче белого», — не пропускает в свечение ни одного текселя: bloom там
 * не «теряет запас яркости», а не работает вовсе, притом молча. Порог поэтому
 * прижимается: в LDR светятся самые светлые тексели кадра, и это честная
 * деградация, названная вслух предупреждением.
 *
 * Значение 0.8, а не «чуть ниже единицы»: разница порога и белой точки и есть
 * запас, из которого считается вклад (`over / luma`), и на 0.99 свечение было бы
 * неотличимо от его отсутствия.
 */
const LDR_BLOOM_THRESHOLD_MAX = 0.8;

/**
 * Сэмплов мультисэмплинга у цели сцены по умолчанию — значение ручки
 * `postprocess.antialias` (QUAL-1, QUAL-3). Четыре: столько же даёт `antialias:
 * true` ДЕФОЛТНОМУ фреймбуферу рендерера, а включённая цепочка рисует сцену в
 * свою цель, и без этого числа кадр с пост-обработкой терял бы сглаживание
 * рёбер, которое тот же кадр без неё имеет.
 */
export const DEFAULT_ANTIALIAS_SAMPLES = 4;

/**
 * Один проход цепочки (L-12 аудита 2026-09-03): единица, из которых складывается
 * кадр, вместо фиксированной последовательности внутри одной функции. Новый
 * полноэкранный проход — сглаживание, виньетка, контур — добавляется ЗАПИСЬЮ
 * СПИСКА, а не правкой программы сведения и не ещё одной веткой в `render`.
 *
 * `input` — текстура, которую проход читает как кадр; `output` — куда лечь его
 * результату, `null` — на канвас. Цель прохода выбирает ЦЕПОЧКА: только она
 * знает, какой проход последний и чем кадр заканчивается — целью захвата для
 * маскирующего прохода тумана (FOW-7) или экраном.
 */
export interface PostPass {
  /** Имя прохода: вход тестов и диагностики — порядок кадра читается по именам. */
  readonly name: string;
  /**
   * Двигает ли проход КАДР. `true` — его выход читает следующий проход
   * (сведение, экранное сглаживание); `false` — проход готовит СВОИ цели, а
   * кадр остаётся прежним: так работает пирамида bloom — её результат читает не
   * следующий проход, а сведение, из своей униформы.
   */
  readonly advances: boolean;
  render(
    renderer: PostRendererLike,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null,
  ): void;
}

export interface PostprocessChainOptions {
  /** Канал предупреждений; не задан — `console.warn` (деградация в LDR, design D6). */
  readonly warn?: (message: string) => void;
}

export class PostprocessChain {
  private config: PostprocessRenderConfig = DEFAULT_POSTPROCESS_CONFIG;
  /**
   * Сэмплов мультисэмплинга у цели сцены — значение ручки `postprocess.antialias`
   * (QUAL-1). Ноль — цель обычная, сглаживания у кадра цепочки нет.
   */
  private samples = DEFAULT_ANTIALIAS_SAMPLES;

  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  /** Выход последнего прохода для маскирующего прохода (design D2); null — на экран. */
  private outputTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * Промежуточная цель между двумя двигающими кадр проходами: её заводит только
   * экранное сглаживание — сведению нужно куда-то лечь, чтобы FXAA прочитал уже
   * готовый кадр. Одного прохода в кадре достаточно, чтобы её не было вовсе.
   */
  private relayTarget: THREE.WebGLRenderTarget | null = null;
  /** Пирамида свечения (design D4) — её цели, материалы и ход живут в `bloom.ts`. */
  private readonly pyramid = new BloomPyramid((renderer, material, target) => {
    this.draw(renderer, material, target);
  });
  private resolveMaterial: THREE.ShaderMaterial | null = null;
  private fxaaMaterial: THREE.ShaderMaterial | null = null;
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
  /** Размер буфера отрисовки этого кадра: его читают пирамида и экранный проход. */
  private frameWidth = 1;
  private frameHeight = 1;
  /** Сток стоимости этого кадра: спрашивается раз за кадр, а не раз за проход. */
  private frameCost: RenderCostCounters | undefined;

  /**
   * Проходы кадра списком (L-12). Записи постоянны — они лишь зовут методы
   * цепочки, — а СОСТАВ списка пересобирается СОБЫТИЕМ (правка секции, смена
   * значений ручек, готовность таблицы цвета): кадровый путь не аллоцирует
   * (REND-26).
   */
  private readonly bloomPass: PostPass = {
    name: 'bloom',
    advances: false,
    render: (renderer, input) => {
      this.renderBloom(renderer, input);
    },
  };

  private readonly resolvePass: PostPass = {
    name: 'resolve',
    advances: true,
    render: (renderer, input, output) => {
      this.draw(renderer, this.ensureResolve(input), output);
    },
  };

  private readonly fxaaPass: PostPass = {
    name: 'fxaa',
    advances: true,
    render: (renderer, input, output) => {
      this.draw(renderer, this.ensureFxaa(input), output);
    },
  };

  private passList: readonly PostPass[] = [];

  constructor(options: PostprocessChainOptions = {}) {
    this.warnOnce = createWarnOnce(options.warn);
    this.rebuildPasses();
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
    readonly relay: THREE.WebGLRenderTarget | null;
    readonly resolve: THREE.ShaderMaterial | null;
    readonly threshold: THREE.ShaderMaterial | null;
    readonly fxaa: THREE.ShaderMaterial | null;
    readonly lut: THREE.Data3DTexture | null;
    readonly hdr: boolean;
  } {
    return {
      scene: this.sceneTarget,
      output: this.outputTarget,
      pyramid: this.pyramid.targets,
      relay: this.relayTarget,
      resolve: this.resolveMaterial,
      threshold: this.pyramid.threshold,
      fxaa: this.fxaaMaterial,
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
    this.rebuildPasses();
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
    if (!next.bloomEnabled) this.pyramid.release();
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
    this.rebuildPasses();
    if (!this.active) this.release();
  }

  /** Потолок ширины вершины пирамиды (QUAL-1): `min(производное, потолок)`. */
  applyResolutionCeiling(ceiling: number): void {
    this.pyramid.applyCeiling(ceiling);
  }

  /**
   * Число сэмплов цели сцены (ручка `postprocess.antialias`, QUAL-1). Смена —
   * СОБЫТИЕ (смена пресета): мультисэмплинг — свойство самой цели, и другое их
   * число означает другую цель, поэтому прежняя отдаётся, а новая заводится
   * ближайшим кадром — как при смене размера окна.
   */
  applyAntialias(samples: number): void {
    const next = Math.max(0, Math.round(samples));
    if (next === this.samples) return;
    this.samples = next;
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.sceneTarget = null;
    // Ноль сэмплов ставит в конец списка экранное сглаживание, ненулевое —
    // снимает его вместе с промежуточной целью (design D2).
    this.rebuildPasses();
    if (this.samples !== 0) this.releaseRelay();
  }

  /**
   * Состав списка проходов (design D1) — СОБЫТИЕМ, а не кадром. Порядок один и
   * тот же и читается прямо здесь: свечение готовит пирамиду, сведение сводит
   * кадр, экранное сглаживание — последний проход цепочки (маска тумана
   * остаётся финальным проходом кадра, FOW-7).
   */
  private rebuildPasses(): void {
    if (!this.active) {
      this.passList = [];
      return;
    }
    const passes: PostPass[] = [];
    if (this.config.bloomEnabled) passes.push(this.bloomPass);
    passes.push(this.resolvePass);
    // Сглаживание экранным проходом — только там, где мультисэмплинга цели нет
    // вовсе: он дешёвый запасной путь, а не второе сглаживание поверх первого.
    if (this.samples === 0) passes.push(this.fxaaPass);
    this.passList = passes;
  }

  /** Проходы кадра в порядке исполнения — вход тестов и диагностики (REND-34). */
  get passNames(): readonly string[] {
    return this.passList.map((pass) => pass.name);
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
    this.frameCost = cost;
    const size = renderer.getDrawingBufferSize(this.size);
    // Целые тексели — и целями, и счётчиками (PERF-3): дробный размер буфера
    // сделал бы число текселей прохода зависимым от устройства.
    const width = Math.max(1, Math.floor(size.x));
    const height = Math.max(1, Math.floor(size.y));
    this.frameWidth = width;
    this.frameHeight = height;
    this.frameTexels = width * height;
    this.checkFloatTarget(renderer);
    const target = this.ensureSceneTarget(width, height);

    // Сцена — в HDR-цель: порог bloom и оператор работают ДО кодирования, то
    // есть по линейным значениям кадра (REND-34).
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (cost !== undefined) cost.postprocessPasses++;

    // Кадр идёт СПИСКОМ проходов (design D1): вход первого — цель сцены, вход
    // следующего — выход предыдущего, а выход последнего двигающего кадр
    // прохода и есть конец кадра.
    const passes = this.passList;
    const output = capture ? this.ensureOutputTarget(width, height) : null;
    let advancing = 0;
    for (const pass of passes) if (pass.advances) advancing++;
    let input = target.texture;
    let done = 0;
    for (const pass of passes) {
      if (!pass.advances) {
        pass.render(renderer, input, null);
        continue;
      }
      done++;
      const last = done === advancing;
      const into = last ? output : this.ensureRelayTarget(width, height);
      pass.render(renderer, input, into);
      if (into !== null) input = into.texture;
    }
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

  /**
   * Порог и пирамида (design D4): вершина от цели сцены, вниз — даунсемплы,
   * вверх — ПРОГРЕССИВНЫЙ АПСЕМПЛ (L-7). Ярусы складываются по дороге наверх, а
   * не в сведении: мелкий ярус (кадр/32) билинейно растянутый сразу на весь кадр
   * даёт вокруг яркой точки коробчатую звезду, а не свечение. Схемы без
   * гауссианы на каждом ярусе именно этой цепочки и требуют, а сведение читает
   * одну текстуру — вершину.
   */
  private renderBloom(renderer: PostRendererLike, input: THREE.Texture): void {
    this.pyramid.render(
      renderer,
      input,
      { width: this.frameWidth, height: this.frameHeight },
      {
        threshold: this.thresholdValue,
        radius: this.config.bloomRadius,
        type: this.texelType,
      },
    );
  }

  /** Один полноэкранный проход: материал на квад, цель, счётчики (PERF-2, PERF-3). */
  private draw(
    renderer: PostRendererLike,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    const cost = this.frameCost;
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
    if (extensions === undefined) return;
    if (FLOAT_TARGET_EXTENSIONS.some((name) => extensions.has(name))) return;
    this.hdr = false;
    this.warnOnce(
      FLOAT_TARGET_EXTENSIONS[0],
      `пост-обработка: ни одного из расширений ${FLOAT_TARGET_EXTENSIONS.join(', ')} нет — ` +
        `цепочка идёт в LDR (REND-34): кадр корректен, запаса ярче белого у него нет, ` +
        `а порог bloom прижат к ${LDR_BLOOM_THRESHOLD_MAX} — выше него байтовая цель не хранит ничего, ` +
        `и авторский порог не пропускал бы в свечение ни одного текселя`,
    );
  }

  /**
   * Действующий порог bloom: авторский, а в LDR — прижатый к потолку фолбэка
   * (см. `LDR_BLOOM_THRESHOLD_MAX`). Правится он в двух местах — при создании
   * материала порога и при правке секции, — и оба берут число ЗДЕСЬ: разойдись
   * они, кадр после правки соседнего поля молча менял бы свечение.
   */
  private get thresholdValue(): number {
    const authored = this.config.bloomThreshold;
    return this.hdr ? authored : Math.min(authored, LDR_BLOOM_THRESHOLD_MAX);
  }

  /** Тип текселя целей цепочки: half-float, а без расширения — байт (design D6). */
  private get texelType(): THREE.TextureDataType {
    return this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  /**
   * HDR-цель сцены с текстурой глубины: глубину читает маскирующий проход
   * (FOW-7), а мультисэмплинг делает рёбра кадра с цепочкой такими же гладкими,
   * какими их держит `antialias: true` у кадра без неё.
   *
   * Мультисэмплинг и текстура глубины уживаются (three r185): цель заводит
   * многосэмпловые рендербуферы, а на смене цели сводит их блитом — цвет в
   * текстуру цели, глубину в текстуру глубины (`resolveDepthBuffer` по
   * умолчанию включён). Маскирующий проход тумана поэтому читает сведённую
   * глубину, а не многосэмпловую, и знать о сглаживании ему не нужно.
   */
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
        samples: this.samples,
      }),
    );
    this.sceneTarget = target;
    return target;
  }

  /**
   * Цель выхода сведения: её читает маскирующий проход тумана (design D2).
   *
   * В ней лежит СВЕДЁННЫЙ кадр — тонемапленный и отгрейженный, то есть значения
   * отображаемого диапазона, — и точность её байтов не безразлична: маска
   * умножает их на свою величину и кодирует sRGB уже на канвасе (FOW-7).
   * Байтовая цель БЕЗ объявленного цветового пространства хранила бы их
   * ЛИНЕЙНО, а линейный байт — это 13 нижних уровней дисплея, схлопнутых в
   * один: затемнённое туманом большинство арены и градиент края FOW-7 строились
   * бы из квантованного источника. Поэтому:
   *
   * - есть half-float (обычный путь) — цель half-float, потерь нет вовсе;
   * - нет (LDR-фолбэк) — байтовая цель с `SRGBColorSpace`: three выделяет ей
   *   SRGB8_ALPHA8, и кодирование с декодированием делает сам GL — запись
   *   прохода и выборка маски остаются линейными, а хранится кадр по кривой
   *   sRGB, то есть с той же точностью, что видит глаз.
   */
  private ensureOutputTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = this.ensureFrameTarget(this.outputTarget, width, height);
    this.outputTarget = target;
    return target;
  }

  /**
   * Промежуточная цель между двумя двигающими кадр проходами (design D1, D2):
   * сведение пишет в неё, экранное сглаживание читает её как готовый кадр.
   * Свойства те же, что у выхода, и по тем же причинам — это тот же кадр, лишь
   * на проход раньше.
   */
  private ensureRelayTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = this.ensureFrameTarget(this.relayTarget, width, height);
    this.relayTarget = target;
    return target;
  }

  /** Общее тело обеих полноразмерных целей кадра: один их вид — одно место. */
  private ensureFrameTarget(
    existing: THREE.WebGLRenderTarget | null,
    width: number,
    height: number,
  ): THREE.WebGLRenderTarget {
    if (existing !== null && existing.width === width && existing.height === height) return existing;
    existing?.dispose();
    const target = own(
      'renderTarget',
      'postprocess',
      new THREE.WebGLRenderTarget(width, height, { depthBuffer: false, type: this.texelType }),
    );
    // Цветовое пространство объявляется только байтовой цели: у half-float
    // диапазон и так линейный и полный, а объявленный sRGB заставил бы GL
    // кодировать её значения без всякой на то нужды.
    if (!this.hdr) target.texture.colorSpace = THREE.SRGBColorSpace;
    return target;
  }

  /** Материал сведения; вход — цель сцены и ярусы пирамиды (design D3, D4). */
  private ensureResolve(scene: THREE.Texture): THREE.ShaderMaterial {
    const config = this.config;
    const material =
      this.resolveMaterial ??
      createResolveMaterial({
        operator: config.operator,
        exposure: config.exposure,
        bloom: config.bloomEnabled,
        strength: config.bloomStrength,
        lut: this.lutTexture,
        lutAmount: config.lutAmount,
      });
    this.resolveMaterial = material;
    uniformOf(material, 'tScene').value = scene;
    if (config.bloomEnabled) {
      // Вершина пирамиды и есть свечение кадра: ярусы сложены в неё цепочкой
      // апсемплов (design D4, L-7), и второй текстуры сведению не нужно.
      const uniform = material.uniforms.tBloom0;
      if (uniform !== undefined) uniform.value = this.pyramid.top;
    }
    return material;
  }

  /**
   * Материал экранного сглаживания (REND-34): источник — ГОТОВЫЙ кадр, шаг
   * выборки — его тексель. Заводится лениво, первым кадром со снятым
   * мультисэмплингом, и отдаётся вместе с остальными целями (REND-31).
   */
  private ensureFxaa(input: THREE.Texture): THREE.ShaderMaterial {
    const material = this.fxaaMaterial ?? createFxaaMaterial();
    this.fxaaMaterial = material;
    uniformOf(material, 'tSource').value = input;
    (material.uniforms.uTexel as { value: THREE.Vector2 }).value.set(
      1 / this.frameWidth,
      1 / this.frameHeight,
    );
    return material;
  }

  /** Числа секции на живые материалы (ED-15): пересборки они не требуют. */
  private pushUniforms(): void {
    const config = this.config;
    this.pyramid.applyThreshold(this.thresholdValue);
    const resolve = this.resolveMaterial;
    if (resolve === null) return;
    const exposure = resolve.uniforms.toneMappingExposure;
    if (exposure !== undefined) exposure.value = config.exposure;
    const strength = resolve.uniforms.uStrength;
    if (strength !== undefined) strength.value = config.bloomStrength;
    // Ширина свечения правится не в сведении, а на ступенях апсемпла: её вклад
    // читается с конфигурации каждым кадром пирамиды (`renderBloom`), поэтому
    // униформы здесь у неё нет вовсе.
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
    this.pyramid.release();
    // Текстуру глубины HDR-цели завела ЦЕПОЧКА, а не цель: `dispose()` цели
    // рассылает только собственное событие, и без этой строки текстура
    // пережила бы и смену размера окна, и снос (REND-31, PERF-9).
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.sceneTarget = null;
    this.outputTarget?.dispose();
    this.outputTarget = null;
    this.releaseRelay();
    this.resolveMaterial?.dispose();
    this.resolveMaterial = null;
  }

  /** Промежуточная цель и материал экранного сглаживания — вместе: они пара. */
  private releaseRelay(): void {
    this.relayTarget?.dispose();
    this.relayTarget = null;
    this.fxaaMaterial?.dispose();
    this.fxaaMaterial = null;
  }

  /** Трёхмерная текстура таблицы цвета — её строила цепочка, ей и отдавать. */
  private releaseLut(): void {
    this.lutTexture?.dispose();
    this.lutTexture = null;
  }

}
