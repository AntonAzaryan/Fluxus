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
import { LUT_ASSET_KIND, type ColorLut, type PresentationPostprocess } from '@fluxus/assets';
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
 * `postprocess.lut` — потолок-выключатель цветокоррекции по образцу
 * `postprocess.bloom` (QUAL-1): `false` снимает авторски объявленную таблицу,
 * `true` (умолчание — «потолка нет») ненаписанную не заводит.
 *
 * Стоимость прохода константна относительно контента сцены (QUAL-3) — одна
 * выборка таблицы на пиксель, — но не нулевая: на слабом устройстве это
 * трёхмерная выборка на каждый пиксель кадра, и рычаг снять её пресет иметь
 * обязан. Своей «разрешающей» ручки у LUT нет: сторона решётки — свойство
 * авторского файла, а не пресета.
 */
export const POSTPROCESS_LUT = 'postprocess.lut';

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
  /** Разрешает ли пресет авторски объявленный LUT-проход (QUAL-1). */
  private lutAllowed = true;
  private current: PostprocessRenderConfig;
  private readonly chain: PostprocessChain;
  private ctx: RenderContext | null = null;
  /** Канал предупреждений: недоступная таблица цвета — кадр без LUT (REND-34). */
  private readonly warn: (message: string) => void;
  /**
   * ID таблицы, на которую подписка уже сделана; `null` — подписки нет. Ассет
   * запрашивается ровно на смене ID (ASSET-2 идемпотентен по ID, но лишняя
   * подписка пережила бы правку секции и слала бы состояния снятой таблицы).
   */
  private lutId: string | null = null;
  private unsubscribeLut: (() => void) | null = null;

  constructor(options: PostprocessOptions = {}) {
    this.section = options.config;
    this.current = this.effective();
    this.warn =
      options.warn ??
      ((message): void => {
        console.warn(message);
      });
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

  /**
   * Есть ли у цепочки работа (REND-34): false — кадр как до появления
   * capability. Спрашивается у ЦЕПОЧКИ, а не у конфигурации: объявленная, но
   * ещё не приехавшая (или не приехавшая вовсе) таблица цвета работы не даёт.
   */
  get active(): boolean {
    return this.chain.active;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.syncLut();
  }

  /**
   * Снос (REND-31): цели цепочки, пирамида bloom, материалы проходов и
   * геометрия полноэкранного квада. Сцена подсистеме не принадлежит — в неё она
   * только рисует.
   */
  dispose(): void {
    this.unsubscribeLut?.();
    this.unsubscribeLut = null;
    this.lutId = null;
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
   * Ручки качества подсистемы (QUAL-1, QUAL-3; design D5) — по рычагу на каждую
   * ось стоимости цепочки, и осей три:
   *
   * - число и размер проходов bloom — самая дорогая часть: её выключает
   *   `postprocess.bloom`, а разрешение её пирамиды ограничивает
   *   `postprocess.bloomResolution`;
   * - выборка трёхмерной таблицы цвета — своего прохода LUT не добавляет, но
   *   выборка есть у КАЖДОГО пикселя кадра; стоимость её константна
   *   относительно контента сцены (QUAL-3), а не нулевая, и снимает её
   *   `postprocess.lut`. Своей «разрешающей» ручки у таблицы нет: сторона
   *   решётки — свойство авторского файла, а не пресета.
   *
   * Сведение яркости ручки не имеет намеренно: это ОДИН проход постоянной
   * стоимости, и выключать его пресетом значило бы менять облик кадра, а не его
   * цену (QUAL-2).
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
        {
          name: POSTPROCESS_LUT,
          cost: 'выборка трёхмерной таблицы цвета на каждый пиксель кадра: своего прохода LUT не добавляет, но выборка есть у каждого пикселя (REND-34)',
          semantics: 'ceiling',
          // Потолка нет — действует авторская секция (REND-34, QUAL-1).
          default: true,
          values: [true, false],
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
    const lut = values.get(POSTPROCESS_LUT);
    this.lutAllowed = typeof lut === 'boolean' ? lut : true;
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
    // Потолок `false` снимает ТАБЛИЦУ, а не долю её применения: действующая
    // конфигурация просто перестаёт называть ассет, и вместе с ним уходят и
    // запрос ассета, и текстура, и define материала (QUAL-1).
    const lutAsset = this.lutAllowed ? authored.lutAsset : null;
    if (bloomEnabled === authored.bloomEnabled && lutAsset === authored.lutAsset) return authored;
    return { ...authored, bloomEnabled, lutAsset };
  }

  /** Общий шов применения: и правка секции автором, и потолок пресета — сюда. */
  private applyResolved(): void {
    this.current = this.effective();
    this.chain.apply(this.current);
    this.syncLut();
  }

  /**
   * Ассет таблицы цвета (REND-34, ASSET-3/ASSET-4): подписка на его состояние и
   * передача данных цепочке. Смена ID — снятие прежней подписки и новый запрос;
   * отсутствие ID (нет подсекции либо потолок пресета) — снятие таблицы.
   *
   * Недоступный или невалидный ассет НЕ роняет рендер: кадр рисуется без LUT, а
   * причина уходит предупреждением — тем же каналом, каким о деградации говорит
   * цепочка. Пока ассет грузится, таблицы тоже нет: кадром, нарисованным
   * наполовину загруженной таблицей, LUT не бывает.
   */
  private syncLut(): void {
    const ctx = this.ctx;
    const id = this.current.lutAsset;
    if (ctx === null || id === this.lutId) return;
    this.unsubscribeLut?.();
    this.unsubscribeLut = null;
    this.lutId = id;
    if (id === null) {
      this.chain.applyLut(null);
      return;
    }
    const handle = ctx.assets.request<ColorLut>(LUT_ASSET_KIND, id);
    this.unsubscribeLut = ctx.assets.subscribe(handle, (state) => {
      // Состояние ассета, на который подписка уже снята правкой секции, кадру
      // не адресовано: сервис вправе уведомить синхронно на отписке.
      if (this.lutId !== id) return;
      if (state.status === 'ready') {
        this.chain.applyLut(state.data);
        return;
      }
      this.chain.applyLut(null);
      if (state.status === 'failed') {
        this.warn(
          `render: таблица цвета "${id}" не загрузилась: ${state.reason} — кадр без LUT (REND-34)`,
        );
      }
    });
  }
}
