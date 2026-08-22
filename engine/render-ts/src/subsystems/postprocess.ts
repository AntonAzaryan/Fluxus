/**
 * Подсистема пост-обработки кадра (REND-34) за контрактом REND-8: bloom и tone
 * mapping собственными полноэкранными проходами (design D1), без EffectComposer.
 *
 * ## Что она делает
 *
 * - Держит действующую конфигурацию — секцию `postprocess` парного
 *   presentation-документа (PRES-2) под потолками пресета качества (QUAL-1) — и
 *   отдаёт её цепочке проходов (`postprocess/chain.ts`), которой принадлежат
 *   цели, материалы и порядок кадра.
 * - Рисует кадр: `render` — цепочка на экран, `renderToTexture` — цепочка в
 *   цель, чей цвет и глубину читает маскирующий проход тумана (FOW-7, design
 *   D2). Обе точки — один и тот же кадр цепочки, различается только назначение
 *   последнего прохода.
 * - При умолчаниях (нет секции, оператор `none`, bloom выключен) не добавляет в
 *   кадр НИ ОДНОЙ цели и НИ ОДНОГО прохода: `render` делает ровно прямую
 *   отрисовку сцены, как её делал потребитель до появления capability (REND-34,
 *   PERF-2).
 *
 * ## Кадрового пути мимо `render` у неё нет
 *
 * `syncTick` и `updateFrame` пусты намеренно: пост-обработка не зависит ни от
 * доставленного состояния, ни от хода мира — она про КАДР, и вся её работа
 * происходит там, где потребитель рисует. Присутствие в реестре подсистем нужно
 * ей ради трёх вещей контракта REND-8: инициализации сценой, ручек качества
 * (QUAL-1) и точки освобождения (REND-31).
 *
 * ## Один кадр у всех потребителей (ED-22)
 *
 * Подсистему регистрируют и игровой клиент, и вьюпорт редактора, и собственной
 * пост-обработки поверх неё не ведёт ни один из них (REND-34): картинка автора
 * и картинка игрока совпадают по построению, а не дисциплиной копирования чисел.
 */
import type * as THREE from 'three';
import type { PresentationPostprocess } from '@game-mvp/assets';
import type {
  PostRendererLike,
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  ScenePostFrame,
  ScenePostSource,
  TickView,
} from '../types.js';
import { PostprocessChain } from '../postprocess/chain.js';
import {
  isPostprocessActive,
  resolvePostprocessConfig,
  type PostprocessRenderConfig,
} from '../postprocess/config.js';

/**
 * Ручки качества подсистемы (QUAL-1, QUAL-3; design D5). Обе — ПОТОЛКИ над
 * авторскими значениями: пресет вправе удешевить кадр, но MUST NOT поднять его
 * выше авторского и MUST NOT тронуть документ сцены.
 *
 * - `postprocess.bloom` — потолок-выключатель: `false` гасит авторски включённый
 *   bloom, `true` (умолчание — «потолка нет») выключенный НЕ включает;
 * - `postprocess.bloomResolution` — потолок ширины вершины пирамиды в текселях,
 *   `min(производное от кадра, потолок)`.
 */
export const POSTPROCESS_BLOOM = 'postprocess.bloom';
export const POSTPROCESS_BLOOM_RESOLUTION = 'postprocess.bloomResolution';

/**
 * Нижняя граница потолка разрешения пирамиды: у вершины уже кадра во столько-то
 * раз свечение перестаёт быть свечением и становится заливкой. Шестнадцать
 * текселей — та граница, ниже которой автор пресета не выигрывает ничего:
 * пирамида и так вдвое мельче кадра, а её ярусы — вдвое мельче друг друга.
 */
const MIN_BLOOM_RESOLUTION = 16;

/**
 * Верхняя граница — сторона кадра сегодняшних экранов. Выше неё потолок ничего
 * не ограничивает: производное разрешение вершины и так вдвое меньше кадра.
 */
const MAX_BLOOM_RESOLUTION = 4096;

export interface PostprocessOptions {
  /** Секция `postprocess` парного документа (PRES-2); нет — умолчания (REND-34). */
  readonly config?: PresentationPostprocess;
  /** Канал предупреждений; не задан — `console.warn` (деградация в LDR, design D6). */
  readonly warn?: (message: string) => void;
}

export class PostprocessSubsystem implements RenderSubsystem, ScenePostSource {
  readonly name = 'postprocess';

  /**
   * Авторская секция как есть — ИСТОЧНИК (REND-34, QUAL-1). Она здесь только
   * читается: пресет качества документ не правит ни байтом, а `current` ниже —
   * уже действующая конфигурация.
   */
  private section: PresentationPostprocess | undefined;
  /** Разрешает ли пресет авторски включённый bloom (QUAL-1): `false` — гасит. */
  private bloomAllowed = true;
  private current: PostprocessRenderConfig;
  private readonly chain: PostprocessChain;
  private ctx: RenderContext | null = null;

  constructor(options: PostprocessOptions = {}) {
    this.section = options.config;
    this.current = this.effective();
    this.chain = new PostprocessChain(options.warn === undefined ? {} : { warn: options.warn });
    this.chain.apply(this.current);
  }

  /** Действующая конфигурация — авторская секция под потолками пресета (QUAL-1). */
  get config(): PostprocessRenderConfig {
    return this.current;
  }

  /** Цели и материалы цепочки — вход тестов и диагностики (REND-34, REND-31). */
  get passes(): PostprocessChain['passes'] {
    return this.chain.passes;
  }

  /** Есть ли у цепочки работа (REND-34): false — кадр как до появления capability. */
  get active(): boolean {
    return isPostprocessActive(this.current);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
  }

  /**
   * Снос (REND-31): цели цепочки, пирамида bloom, материалы проходов и
   * геометрия полноэкранного квада. Сцена подсистеме не принадлежит — в неё она
   * только рисует.
   */
  dispose(): void {
    this.chain.dispose();
  }

  /**
   * Доставленное состояние подсистеме не нужно (REND-34): пост-обработка не
   * знает ни о сущностях, ни о видимости — она про яркость КАДРА. Пустой метод
   * здесь честнее отсутствия: контракт REND-8 требует его от каждой подсистемы,
   * и «нечего делать» — это ответ, а не пропуск.
   */
  syncTick(_view: TickView): void {
    // Ничего: вход подсистемы — кадр, а не доставка.
  }

  /** Покадрового обновления у подсистемы нет: вся её работа — в `render`. */
  updateFrame(_dt: number, _alpha: number): void {
    // Ничего: цепочка исполняется там, где потребитель рисует кадр.
  }

  /**
   * Кадр потребителя (REND-34): активная цепочка — её проходы на экран,
   * неактивная — ровно прямая отрисовка сцены, без единого лишнего прохода.
   *
   * Потребитель зовёт ЭТО вместо `renderer.render(scene, camera)` — и своей
   * пост-обработки поверх не ведёт (REND-34, ED-22). Сцена с туманом зовёт
   * подсистему тумана, а та берёт цепочку портом (FOW-7, design D2).
   */
  render(renderer: PostRendererLike, camera: THREE.Camera): void {
    if (this.active) {
      this.chain.render(renderer, this.scene(), camera, false);
      return;
    }
    // Прямая отрисовка сцены — проход ПОТРЕБИТЕЛЯ, а не подсистемы: он сделал бы
    // ровно его и без неё. Счётчика он поэтому не двигает (PERF-2): стоимость
    // пост-обработки начинается там, где её включили.
    renderer.render(this.scene(), camera);
  }

  /**
   * Кадр цепочки на экран — маски нет, маскирующего прохода за ним не будет
   * (FOW-7). То же самое, что `render`, и намеренно: владелец порта не обязан
   * знать, что цепочка выключена, — выключенная рисует сцену напрямую, а не
   * гоняет проход-тождество.
   */
  renderToScreen(renderer: PostRendererLike, camera: THREE.Camera): void {
    this.render(renderer, camera);
  }

  /**
   * Кадр цепочки в цель (design D2): вход маскирующего прохода — цвет выхода
   * сведения и глубина сцены. Зовёт её подсистема тумана при построенной маске
   * и только при АКТИВНОЙ цепочке (`active`): выключенной рисовать в цель
   * нечего — туман рисует сцену сам, как до REND-34.
   */
  renderToTexture(renderer: PostRendererLike, camera: THREE.Camera): ScenePostFrame {
    const frame = this.chain.render(renderer, this.scene(), camera, true);
    if (frame === null) throw new Error('PostprocessSubsystem: цепочка не отдала кадр (REND-34)');
    return frame;
  }

  /**
   * Обновление секции в рантайме (ED-15): применяется на живой подсистеме —
   * смена оператора или наличия bloom пересобирает ОДИН материал прохода
   * (design D3), смена чисел правит униформы. Пересоздания подсистемы или
   * рендера нет.
   */
  applyConfig(section?: PresentationPostprocess): void {
    this.section = section;
    this.applyResolved();
  }

  /**
   * Ручки качества подсистемы (QUAL-1, QUAL-3; design D5). Стоимость цепочки
   * растёт разрешением кадра и числом проходов, поэтому рычагов ровно два:
   * выключить самую дорогую часть и ограничить её разрешение. Сведение яркости
   * ручки не имеет намеренно: это ОДИН проход постоянной стоимости, и выключать
   * его пресетом значило бы менять облик кадра, а не его цену (QUAL-2).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: POSTPROCESS_BLOOM,
          cost: 'проходы bloom: порог и пирамида даунсемплов — по проходу на ярус, каждый размером в свой ярус (REND-34)',
          semantics: 'ceiling',
          // Потолка нет — действует авторское значение секции (REND-34, QUAL-1).
          default: true,
          values: [true, false],
        },
        {
          name: POSTPROCESS_BLOOM_RESOLUTION,
          cost: 'тексели пирамиды bloom: работа каждого прохода растёт квадратом стороны его яруса (REND-34)',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: MIN_BLOOM_RESOLUTION,
          max: MAX_BLOOM_RESOLUTION,
        },
      ],
    };
  }

  /**
   * Потолки пресета (QUAL-1): документ сцены не меняется — потолки живут в
   * подсистеме, а действующая конфигурация считается заново.
   */
  applyQuality(values: QualityValues): void {
    const bloom = values.get(POSTPROCESS_BLOOM);
    this.bloomAllowed = typeof bloom === 'boolean' ? bloom : true;
    const resolution = values.get(POSTPROCESS_BLOOM_RESOLUTION);
    this.chain.applyResolutionCeiling(
      typeof resolution === 'number' ? resolution : Number.POSITIVE_INFINITY,
    );
    this.applyResolved();
  }

  /** Сцена подсистем (REND-8); без `init` рисовать нечего и не во что. */
  private scene(): THREE.Object3D {
    const ctx = this.ctx;
    if (ctx === null) throw new Error('PostprocessSubsystem: init() не вызван (REND-8)');
    return ctx.scene;
  }

  /**
   * Действующая конфигурация = авторская секция под потолком пресета (design
   * D5): `min` — и только он. Потолок `true` выключенный автором bloom не
   * включает: авторское «выключено» остаётся авторским (QUAL-1).
   */
  private effective(): PostprocessRenderConfig {
    const authored = resolvePostprocessConfig(this.section);
    const bloomEnabled = authored.bloomEnabled && this.bloomAllowed;
    return bloomEnabled === authored.bloomEnabled ? authored : { ...authored, bloomEnabled };
  }

  /** Общий шов применения: и правка секции автором, и потолок пресета — сюда. */
  private applyResolved(): void {
    this.current = this.effective();
    this.chain.apply(this.current);
  }
}
