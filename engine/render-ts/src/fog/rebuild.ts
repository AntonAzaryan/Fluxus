/**
 * Бюджетная перестройка маски видимости (FOW-7, change
 * `fog-mask-budgeted-rebuild`, design D1–D3) — фазовая машина порций и коалесинг
 * доставок.
 *
 * ## Зачем
 *
 * Раньше вся перестройка шла синхронно в таске доставки: на дуэльной маске
 * 384×384 это ~3 мс подряд, и кадр проседал ровно в тот момент, когда обзор
 * менялся сильнее всего. Здесь работа нарезана на порции под ТЕКСЕЛЬНЫЙ бюджет
 * кадра и идёт в `updateFrame`, а результат публикуется свопом растров.
 *
 * ## Три сигнатуры (design D3)
 *
 * - `signature` — входы ОПУБЛИКОВАННОЙ маски;
 * - `building` — входы перестройки В ПОЛЁТЕ, стабильный снимок для её порций;
 * - `pending` — последняя ОТЛОЖЕННАЯ доставка.
 *
 * Доставка перезаписывает `pending` целиком (конфляция «важен только последний
 * вход», как в канале `client-shell` SHELL-4) и НИКОГДА не перезапускает
 * начатую перестройку: при доставках чаще, чем раз в перестройку, рестарт
 * голодил бы маску вечно. Черствость опубликованной маски поэтому ограничена
 * длительностью одной перестройки, и расхождение остаётся консервативным
 * (FOW-9): туман держится дольше, чем нужно, а не пропадает раньше.
 */
import { costSink } from '../cost.js';
import type { FogDirtyBlocks } from './dirty.js';
import type { VisibilityMask } from './mask.js';
import type { FogSegment } from './shadowDepth.js';

/**
 * Слоты конфига в голове сигнатуры входов (design D4): ширина градиента —
 * единственное значение конфигурации, входящее в РАСТР (консервативность едет
 * эффективными радиусами наблюдателей). Дальше — по четыре числа на наблюдателя
 * в порядке доставки.
 *
 * Тона тумана здесь нет намеренно: он вбит в пиксели канваса миникарты, а не в
 * растр, и перестройкой его не сменить — слой перекрашивается прямо на событии
 * правки конфигурации (`subsystems/fog.ts`, FOW-10). Слот под него заставлял бы
 * перестраивать байт в байт тот же растр.
 */
export const SIGNATURE_PREFIX = 1;

/**
 * Бюджет перестройки по умолчанию — столько ПЛОЩАДЕЙ МАСКИ тексель-операций
 * кадр вправе потратить на порции (design D1). Полная перестройка стоит
 * обнуление (1 площадь) + reveal наблюдателей + блюр (2 площади) + разметку
 * окна (≤1 площадь), то есть на дуэльной сцене ~5 площадей: двойка укладывает
 * её в три кадра, и спайк доставки в ~3 мс превращается в ~1 мс на кадр.
 *
 * Ручкой качества (QUAL-1) величина не объявлена намеренно: она правит
 * ЛАТЕНТНОСТЬ маски, а не стоимость кадра (полная перестройка стоит одинаково,
 * как её ни режь), и рычагом объёма работы служит потолок `fog.maskResolution`
 * (FOW-10).
 */
export const REBUILD_BUDGET_MASK_AREAS = 2;

/**
 * Фаза порционной перестройки (design D1): обнуление → reveal наблюдателей по
 * одному → два прохода блюра → публикация. Порядок фаз повторяет синхронный
 * путь один в один, поэтому результат порционной сборки побитово равен
 * синхронной.
 */
type RebuildPhase = 'idle' | 'clear' | 'reveal' | 'smoothH' | 'smoothV' | 'commit';

/** Совпадение занятых префиксов двух сигнатур — сравнение чисел, не JSON (D4). */
function samePrefix(a: Float64Array, b: Float64Array, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Копия занятого префикса сигнатуры в буфер назначения; тесный буфер заменяется
 * ёмким. Копия, а не обмен буферами: три сигнатуры живут своими ёмкостями, и
 * обмен запутал бы, чей буфер сейчас чей.
 */
function copySignature(target: Float64Array, source: Float64Array, length: number): Float64Array {
  const out = target.length < length ? new Float64Array(source.length) : target;
  out.set(source.subarray(0, length));
  return out;
}

/**
 * Последняя строка порции: столько строк, сколько влезает в остаток бюджета, но
 * не меньше одной — продвижение перестройки гарантировано при любом бюджете,
 * вплоть до меньшего, чем строка.
 */
function rowsFor(left: number, perRow: number, from: number, last: number): number {
  const fit = perRow > 0 ? Math.max(1, Math.floor(left / perRow)) : last - from + 1;
  const to = from + fit - 1;
  return to < last ? to : last;
}

export class MaskRebuild {
  /** Входы опубликованной маски; длина −1 — маска не построена ни разу. */
  private signature: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  private signatureLength = -1;
  /** Входы перестройки в полёте; длина −1 — перестройки нет. */
  private building: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  private buildingLength = -1;
  /** Последняя отложенная доставка; длина −1 — отложенного входа нет. */
  private pending: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  private pendingLength = -1;

  private phase: RebuildPhase = 'idle';
  /** Следующая строка текущей фазы; для `reveal` — строка прямоугольника. */
  private cursor = 0;
  /** Смещение текущего наблюдателя в `building`. */
  private observerAt = SIGNATURE_PREFIX;
  /** Наблюдатель подготовлен (depth-буфер построен) — строки можно писать. */
  private observerReady = false;
  /** Буфер наблюдателя для `reveal`: перестройка не аллоцирует по объекту. */
  private readonly scratch = { x: 0, y: 0, radius: 0, level: 0 };
  /** Опубликованных перестроек с создания подсистемы — пробник для тестов. */
  private published = 0;

  /** Бюджет порции, тексель-операций на кадр; правится сменой разрешения. */
  budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Идёт ли перестройка прямо сейчас (фазовая машина не в покое). */
  get running(): boolean {
    return this.phase !== 'idle';
  }

  /** Число ОПУБЛИКОВАННЫХ перестроек: начатая, но не закоммиченная не в счёт. */
  get rebuilds(): number {
    return this.published;
  }

  /** Наблюдателей в опубликованной маске — их сигнатура лежит по четыре числа. */
  get observers(): number {
    return this.signatureLength < 0 ? 0 : (this.signatureLength - SIGNATURE_PREFIX) / 4;
  }

  /**
   * Совпадает ли кандидат с последним ИЗВЕСТНЫМ желаемым входом: отложенный
   * важнее полётного, полётный — опубликованного. Совпал — доставке делать
   * нечего; иначе она станет новым отложенным входом.
   */
  matches(candidate: Float64Array, length: number): boolean {
    const latest =
      this.pendingLength >= 0
        ? this.pending
        : this.buildingLength >= 0
          ? this.building
          : this.signature;
    const latestLength =
      this.pendingLength >= 0
        ? this.pendingLength
        : this.buildingLength >= 0
          ? this.buildingLength
          : this.signatureLength;
    return length === latestLength && samePrefix(latest, candidate, length);
  }

  /** Конфляция: новый вход перезаписывает отложенный целиком (design D3). */
  defer(candidate: Float64Array, length: number): void {
    this.pending = copySignature(this.pending, candidate, length);
    this.pendingLength = length;
  }

  /**
   * Вход опубликован СИНХРОННО, мимо порций (снап при разрыве истории, REND-2):
   * перестройка в полёте брошена, отложенный вход снят — оба несут прежний мир.
   */
  publishSync(candidate: Float64Array, length: number): void {
    this.abort();
    this.signature = copySignature(this.signature, candidate, length);
    this.signatureLength = length;
    this.published++;
  }

  /** Бросает перестройку в полёте и отложенный вход: снап, смена разрешения. */
  abort(): void {
    this.phase = 'idle';
    this.buildingLength = -1;
    this.pendingLength = -1;
    this.observerReady = false;
    this.cursor = 0;
  }

  /** Сигнатура опубликованной маски забыта: ближайшая доставка строит заново. */
  forget(): void {
    this.signatureLength = -1;
  }

  /**
   * Порции кадра под бюджет; `true` — в этом кадре перестройка ОПУБЛИКОВАНА.
   * Перестройка в полёте не перезапускается: кадр её достраивает, публикует и
   * только потом берёт последний отложенный вход (design D3).
   *
   * `dirty` — окно рассеивания, размечаемое на публикации (design D5); `null` —
   * рассеивания нет вовсе, и сравнивать растры незачем.
   */
  advance(
    mask: VisibilityMask,
    segments: readonly FogSegment[],
    dirty: FogDirtyBlocks | null,
  ): boolean {
    if (this.phase === 'idle') {
      if (this.pendingLength < 0) return false;
      this.start(mask);
    }
    const before = this.published;
    let left = this.budget;
    while (this.phase !== 'idle' && left > 0) {
      left -= this.step(mask, segments, dirty, left);
    }
    // Публикация случилась ровно тогда, когда счётчик опубликованных сдвинулся:
    // фаза к этому моменту снова `idle`, и по ней их не отличить от «бюджет
    // кончился посреди перестройки».
    return this.published > before;
  }

  /** Начало перестройки от последнего отложенного входа. */
  private start(mask: VisibilityMask): void {
    this.building = copySignature(this.building, this.pending, this.pendingLength);
    this.buildingLength = this.pendingLength;
    this.pendingLength = -1;
    mask.beginBuild();
    this.phase = 'clear';
    this.cursor = 0;
  }

  /**
   * Одна порция текущей фазы; возвращает потраченный бюджет в тексель-операциях.
   * Каждый вызов ЛИБО делает хотя бы одну строку, ЛИБО двигает фазу — поэтому
   * цикл кадра завершается при любом бюджете, вплоть до нулевого.
   */
  private step(
    mask: VisibilityMask,
    segments: readonly FogSegment[],
    dirty: FogDirtyBlocks | null,
    left: number,
  ): number {
    switch (this.phase) {
      case 'clear': {
        const to = rowsFor(left, mask.width, this.cursor, mask.height - 1);
        const done = mask.clearRows(this.cursor, to);
        this.cursor = to + 1;
        if (this.cursor >= mask.height) {
          this.phase = 'reveal';
          this.observerAt = SIGNATURE_PREFIX;
          this.observerReady = false;
        }
        return done;
      }
      case 'reveal':
        return this.stepReveal(mask, segments, left);
      case 'smoothH':
      case 'smoothV': {
        const horizontal = this.phase === 'smoothH';
        const to = rowsFor(left, mask.width, this.cursor, mask.height - 1);
        const done = mask.smoothRows(horizontal ? 'horizontal' : 'vertical', this.cursor, to);
        this.cursor = to + 1;
        if (this.cursor >= mask.height) {
          this.phase = horizontal ? 'smoothV' : 'commit';
          this.cursor = 0;
        }
        return done;
      }
      case 'commit':
        return this.commit(mask, dirty);
      default:
        return 0; // 'idle' сюда не приходит: цикл кадра его отсекает
    }
  }

  /** Порция reveal: подготовка наблюдателя либо строки его прямоугольника. */
  private stepReveal(
    mask: VisibilityMask,
    segments: readonly FogSegment[],
    left: number,
  ): number {
    if (this.observerAt >= this.buildingLength) {
      this.phase = 'smoothH';
      this.cursor = 0;
      return 0;
    }
    if (!this.observerReady) {
      const at = this.observerAt;
      const observer = this.scratch;
      observer.x = this.building[at]!;
      observer.y = this.building[at + 1]!;
      observer.radius = this.building[at + 2]!;
      observer.level = this.building[at + 3]!;
      // Ширина градиента — из СИГНАТУРЫ полёта, а не из текущего конфига: правка
      // секции по ходу перестройки взводит новую доставку, а начатая
      // достраивается теми входами, с которыми началась (design D3).
      const work = mask.prepareReveal(observer, this.building[0]!, segments);
      this.observerReady = true;
      this.cursor = mask.revealFirstRow;
      return work;
    }
    const last = mask.revealLastRow;
    if (this.cursor > last) {
      this.observerAt += 4;
      this.observerReady = false;
      return 0;
    }
    const to = rowsFor(left, mask.revealRowTexels, this.cursor, last);
    const done = mask.revealRows(this.cursor, to);
    this.cursor = to + 1;
    return done;
  }

  /**
   * Публикация построенного растра (design D2): своп ссылок в маске и разметка
   * грязного окна поблочным сравнением старого и нового переднего растра.
   * Разметка — работа окна рассеивания, и считается она его счётчиком (PERF-3).
   */
  private commit(mask: VisibilityMask, dirty: FogDirtyBlocks | null): number {
    const compared = mask.commit(dirty);
    this.signature = copySignature(this.signature, this.building, this.buildingLength);
    this.signatureLength = this.buildingLength;
    this.buildingLength = -1;
    this.phase = 'idle';
    this.published++;
    const cost = costSink();
    if (cost !== undefined) cost.fogDissolveTexels += compared;
    return compared;
  }
}
