/**
 * Маска видимости команды игрока (FOW-7, FOW-9) — CPU-растр в мировых
 * координатах (design D1): ПАРА grayscale-буферов, покрывающих прямоугольник
 * террейна, — опубликованный передний и задний, в который порции кадра строят
 * следующую маску. Каденс перестройки задаёт доставка (с конфляцией, design
 * D3), а исполняется она кадрами; публикация — своп ссылок (см. ниже).
 *
 * Для каждого наблюдателя своей команды рисуется reveal-полигон: круг
 * эффективного радиуса с радиальным градиентом края настраиваемой ширины
 * (FOW-7), обрезанный 2D shadow-casting'ом по cliff-отрезкам в радиусе (FOW-9).
 * Радиальный фронт тени гаснет той же кромкой, что и граница круга: свет
 * спадает за `edgeWidth` до укрытия и обнуляется на нём (полутень, FOW-7) —
 * иначе граница тени читалась бы швом, который блюр в тексель не прячет.
 * Глубину полутени ограничивает путь до укрытия (`penumbraOf`): стоящему у
 * самой скалы она не гасит свет под ногами.
 * Тени направлены по высоте, как перекрытие симуляции (PHYS-13): ребро
 * отбрасывает тень, только если его верхний уровень выше уровня наблюдателя —
 * с плато открыты и низ, и плато того же уровня за низиной.
 * Наблюдатели складываются максимумом: пересечение кругов не темнее одного.
 *
 * Тени считаются полярным depth-буфером на наблюдателя (design D3 change
 * `fow-directional-cliff-vision`): по блокирующим отрезкам в радиусе строится
 * 1D-буфер «угол → дистанция ближайшей тени», и каждый тексель платит O(1)
 * вместо теста против каждого отрезка. Стоимость перестройки — O(тексели +
 * бины × отрезки), и на плато с десятками отрезков в радиусе она не проседает.
 * Нарезка её не удешевляет и не удорожает: тот же объём, разложенный по кадрам.
 *
 * Вся геометрия здесь — float и приближение (REND-1): побайтового совпадения с
 * `raycast` симуляции не требуется, а расхождение консервативно — минимум по
 * соседним бинам расширяет тень, наблюдатель на линии ребра считается нижней
 * стороной, то есть там, где приближение сомневается, туман, а не свет (FOW-9).
 *
 * Точка входной границы Q16.16 → float — `fogRectOf`/`fogSegmentsOf`: сетка и
 * cliff-отрезки приезжают из ядра fixed-point (TERR-2, TERR-5), конверсия — в
 * точке приёма, глубже по маске fixed-point не существует (REND-1).
 *
 * Перестройка нарезается на порции (change `fog-mask-budgeted-rebuild`, design
 * D1–D2): проходы `clear`/`reveal`/`smooth` умеют работать по диапазону строк в
 * ЗАДНИЙ растр, а `commit()` публикует построенное свопом ссылок. Потребители
 * маски видят только целиком построенный передний растр — полупостроенного
 * состояния не наблюдает никто.
 */
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import { costSink } from '../cost.js';
import type { FogDirtyBlocks } from './dirty.js';
import { ShadowDepth, binOf, type FogSegment } from './shadowDepth.js';

/** Прямоугольник мира, который покрывает маска, — прямоугольник террейна. */
export interface FogWorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Наблюдатель своей команды: позиция и эффективный радиус в мировых единицах.
 * Уровень — доставленный `EntityView.currLevel` (TERR-4 производное): по нему
 * рёбра не выше наблюдателя не отбрасывают тень (`segmentCasts`, PHYS-13); он
 * же — слот сигнатуры перестройки маски (design D4).
 */
export interface FogObserver {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly level: number;
}

/** Прямоугольник маски из сетки террейна — приём `tileSize` (REND-1, TERR-2). */
export function fogRectOf(grid: TerrainGrid): FogWorldRect {
  const tile = grid.tileSize / FIXED_ONE;
  return { x: 0, y: 0, width: grid.width * tile, height: grid.height * tile };
}

/**
 * Cliff-отрезки сетки во float (REND-1): те же отрезки, что несут `blocksVision`
 * в симуляции (TERR-5, FOW-9), — не выведенные заново, а переиспользованные,
 * вместе с уровнями сторон (PHYS-13).
 */
export function fogSegmentsOf(grid: TerrainGrid): readonly FogSegment[] {
  return grid.cliffs.map((edge) => ({
    x1: edge.from.x / FIXED_ONE,
    y1: edge.from.y / FIXED_ONE,
    x2: edge.to.x / FIXED_ONE,
    y2: edge.to.y / FIXED_ONE,
    levelNeg: edge.levelNeg,
    levelPos: edge.levelPos,
  }));
}

/**
 * Градиент края видимой области (FOW-7): доля света по расстоянию до
 * наблюдателя. Монотонно не возрастает с расстоянием; сглажен smoothstep'ом,
 * чтобы кромка не читалась ни ступенью, ни изломом. Нулевая ширина — резкий
 * край: законная конфигурация, а не деление на ноль.
 */
export function edgeGradient(distance: number, radius: number, edgeWidth: number): number {
  if (distance >= radius) return 0;
  if (edgeWidth <= 0) return 1;
  const t = Math.min((radius - distance) / edgeWidth, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Доля пути до укрытия, глубже которой полутень фронта не заходит (FOW-7).
 *
 * Кромка задана в МИРОВЫХ единицах и подобрана под простор арены, а укрытие
 * может стоять к наблюдателю вплотную: без этой границы полоса гашения
 * дотягивалась бы до его собственных ног — и до открытого пола вокруг, куда
 * короткую дистанцию угла заносит консервативный минимум по тройке бинов
 * (`depthMin`). Свет тогда убывал бы НАЗАД, к наблюдателю, читаясь размазанным
 * пятном вместо тени. Половина пути оставляет полутени весь простор там, где он
 * есть, и не даёт ей коснуться наблюдателя там, где его нет.
 */
const PENUMBRA_REACH = 0.5;

/**
 * Действующая глубина полутени фронта на дистанции тени `shadowDistance`
 * (FOW-7): настроенная кромка, ограниченная доступным до укрытия путём
 * (`PENUMBRA_REACH`). Монотонно не убывает с дистанцией тени — на этом стоит
 * порог `penumbraStartSq`.
 */
function penumbraOf(shadowDistance: number, edgeWidth: number): number {
  return Math.min(edgeWidth, shadowDistance * PENUMBRA_REACH);
}

/**
 * Проход разделяемого блюра кромки (FOW-7): горизонталь пишет промежуточный
 * буфер, вертикаль читает только его. Порционная перестройка идёт ими по
 * очереди — сперва весь горизонтальный, затем весь вертикальный (design D1).
 */
export type FogSmoothPass = 'horizontal' | 'vertical';

/**
 * Растр маски: байт на тексель, 0 — туман, 255 — видно. Ряд 0 — минимальный
 * `y` мира (v = 0 текстуры); переворот для canvas-потребителей — дело блита,
 * а не растра.
 *
 * Растра ДВА (design D2 change `fog-mask-budgeted-rebuild`): передний —
 * опубликованный, его и видят потребители (`data`, `valueAt`, рассеивание,
 * миникарта, отладочный источник); задний — тот, в который пишут порции
 * незавершённой перестройки. `commit()` меняет их ссылки местами, и
 * полупостроенное состояние не наблюдаемо ни в одном кадре. Синхронный путь
 * (`clear` → `reveal` → `smooth`) пишет ПЕРЕДНИЙ растр и остаётся за снапом
 * (REND-2) и автономным использованием маски.
 */
export class VisibilityMask {
  readonly rect: FogWorldRect;
  /** Текселей на мировую единицу — разрешение маски (FOW-10). */
  readonly texelsPerUnit: number;
  readonly width: number;
  readonly height: number;
  /** Опубликованный растр — единственное, что видят потребители маски. */
  private front: Uint8Array;
  /** Задний растр порционной перестройки; null — порционного пути не было. */
  private backing: Uint8Array | null = null;

  /**
   * Полярный depth-буфер теней текущего наблюдателя (design D3). Один на маску
   * и переиспользуемый: наблюдатели идут строго по одному, и горячий путь
   * перестройки не аллоцирует.
   */
  private readonly shadow = new ShadowDepth();
  /** Переиспользуемый буфер разделяемого блюра `smooth()`. */
  private temp: Uint8Array | null = null;
  /**
   * Счётчики текущего `writeReveal`, копящиеся по строкам (PERF-3). Поля по
   * той же причине: строка отчитывается вызывающему, не создавая объекта.
   */
  private revealWritten = 0;
  private revealShadowTests = 0;

  /**
   * Подготовленный наблюдатель порционного reveal (design D1): границы его
   * прямоугольника и пороги, которые читает цикл по текселям. Запись одна и
   * переиспользуется — подготовка наблюдателя не аллоцирует.
   */
  private readonly staged = {
    x0: 0,
    x1: 0,
    y0: 0,
    y1: -1,
    ox: 0,
    oy: 0,
    radiusSq: 0,
    innerSq: 0,
    edgeWidth: 0,
    radius: 0,
    shadowed: false,
    /** Считать ли полутень фронта: есть тени и есть ненулевая кромка (FOW-7). */
    penumbra: false,
    penumbraStartSq: 0,
  };

  constructor(rect: FogWorldRect, texelsPerUnit: number) {
    this.rect = rect;
    this.texelsPerUnit = texelsPerUnit;
    this.width = Math.max(1, Math.round(rect.width * texelsPerUnit));
    this.height = Math.max(1, Math.round(rect.height * texelsPerUnit));
    this.front = new Uint8Array(this.width * this.height);
  }

  /** Опубликованный растр: то, что видят потребители маски (design D2). */
  get data(): Uint8Array {
    return this.front;
  }

  /** Всё в туман — начало перестройки, синхронный путь (design D1). */
  clear(): void {
    this.clearInto(this.front, 0, this.height - 1);
  }

  // ------------------------------------------- порционная перестройка (D1, D2)

  /**
   * Начало порционной перестройки: задний растр заводится при первом же
   * обращении и дальше переиспользуется — перестройка не аллоцирует.
   */
  beginBuild(): void {
    this.backing ??= new Uint8Array(this.front.length);
  }

  /** Обнуление строк [y0, y1] ЗАДНЕГО растра; возвращает объём работы. */
  clearRows(y0: number, y1: number): number {
    return this.clearInto(this.back(), y0, y1);
  }

  /**
   * Строки [y0, y1] подготовленного наблюдателя — в ЗАДНИЙ растр. Порядок
   * записей внутри наблюдателя тот же, что у синхронного пути: нарезка идёт по
   * строкам, и результат порционной сборки побитово равен синхронной.
   */
  revealRows(y0: number, y1: number): number {
    return this.writeReveal(this.back(), y0, y1);
  }

  /** Один проход блюра кромки по строкам [y0, y1] ЗАДНЕГО растра (FOW-7). */
  smoothRows(pass: FogSmoothPass, y0: number, y1: number): number {
    return this.smoothInto(this.back(), pass, y0, y1);
  }

  /**
   * Публикация построенного растра (design D2): передний и задний меняются
   * ссылками, и потребители в тот же момент начинают видеть целиком построенную
   * маску. Прежний передний растр остаётся под рукой задним — по нему считается
   * грязное окно рассеивания (design D5).
   *
   * Возвращает число текселей, сравнённых при разметке окна (PERF-3).
   */
  commit(dirty: FogDirtyBlocks | null): number {
    const built = this.back();
    const previous = this.front;
    this.front = built;
    this.backing = previous;
    return dirty === null ? 0 : dirty.markChanged(previous, built, this.width, this.height);
  }

  /** Первая строка прямоугольника подготовленного наблюдателя (design D1). */
  get revealFirstRow(): number {
    return this.staged.y0;
  }

  /** Последняя его строка; меньше первой — рисовать нечего. */
  get revealLastRow(): number {
    return this.staged.y1;
  }

  /** Текселей в строке его прямоугольника — знаменатель порции (PERF-3). */
  get revealRowTexels(): number {
    return this.staged.x1 - this.staged.x0 + 1;
  }

  /**
   * Reveal-полигон одного наблюдателя (FOW-7, FOW-9): круг эффективного
   * радиуса с градиентом края, обрезанный тенями укрытий в радиусе. Складывается
   * с уже нарисованным максимумом. Синхронный путь: подготовка и все строки
   * сразу, в ПЕРЕДНИЙ растр.
   */
  reveal(observer: FogObserver, edgeWidth: number, segments: readonly FogSegment[]): void {
    this.prepareReveal(observer, edgeWidth, segments);
    this.writeReveal(this.front, this.staged.y0, this.staged.y1);
  }

  /**
   * Подготовка наблюдателя к записи (design D1): границы прямоугольника, отбор
   * укрытий в радиусе и полярный depth-буфер — то, что нарезать нечего и что
   * строки потом только читают. Возвращает объём работы подготовки в единицах
   * бюджета: тесты «отрезок в радиусе» плюс пройденные бины (PERF-3).
   */
  prepareReveal(
    observer: FogObserver,
    edgeWidth: number,
    segments: readonly FogSegment[],
  ): number {
    const staged = this.staged;
    staged.y1 = -1; // рисовать нечего, пока границы не сошлись
    const radius = observer.radius;
    if (radius <= 0) return 0;
    const scale = this.texelsPerUnit;
    const x0 = Math.max(0, Math.floor((observer.x - radius - this.rect.x) * scale));
    const x1 = Math.min(this.width - 1, Math.ceil((observer.x + radius - this.rect.x) * scale));
    const y0 = Math.max(0, Math.floor((observer.y - radius - this.rect.y) * scale));
    const y1 = Math.min(this.height - 1, Math.ceil((observer.y + radius - this.rect.y) * scale));
    if (x1 < x0 || y1 < y0) return 0;

    const radiusSq = radius * radius;
    const shadow = this.shadow;
    shadow.collect(observer.x, observer.y, observer.level, segments, radiusSq);
    // Считать ли полутень фронта вообще (FOW-7). Решается ДО свёртки: при
    // нулевой кромке (законная конфигурация FOW-10) полутени нет, линейные
    // дистанции никто не прочтёт — и тысяча корней на наблюдателя не берётся,
    // тем более что на нетронутых бинах это корни из бесконечности.
    const penumbra = edgeWidth > 0 && shadow.casting;
    const shadowRays = shadow.build(observer.x, observer.y, penumbra);

    // Сток читается один раз на наблюдателя, не на тексель (PERF-3): объём
    // просмотра — арифметика границ прямоугольника, а не счёт в цикле.
    const cost = costSink();
    if (cost !== undefined) {
      cost.fogRevealCalls++;
      cost.fogSegmentRangeTests += segments.length;
      cost.fogNearSegments += shadow.nearCount;
      cost.fogShadowRayTests += shadowRays;
      cost.fogMaskTexels += (x1 - x0 + 1) * (y1 - y0 + 1);
    }

    // Порог ПОЛНОГО света в квадрате расстояния: до него `edgeGradient` равен
    // единице тождественно, то есть значение текселя — 255, и ни корень, ни
    // сглаживание кромки его не уточняют. На арене демо (радиус обзора 24,
    // кромка 4) внутрь порога попадает ~67 % круга, на умолчаниях (кромка 2,5)
    // ~80 % — ровно столько текселей проходят цикл без `Math.sqrt`. Вырожденные
    // случаи разведены: нулевая кромка делает полным светом весь круг, кромка
    // шире радиуса — ни один тексель (порог −1 недостижим для квадрата
    // расстояния).
    const inner = radius - edgeWidth;
    staged.x0 = x0;
    staged.x1 = x1;
    staged.y0 = y0;
    staged.y1 = y1;
    staged.ox = observer.x;
    staged.oy = observer.y;
    staged.radius = radius;
    staged.radiusSq = radiusSq;
    staged.innerSq = edgeWidth <= 0 ? radiusSq : inner > 0 ? inner * inner : -1;
    staged.edgeWidth = edgeWidth;
    staged.shadowed = shadow.casting;
    staged.penumbra = penumbra;
    // Порог, за которым тексель обязан спросить у полярного буфера свой угол.
    // Прежде им была ближайшая тень ЛЮБОГО направления — ближе неё затенения
    // нет. Полутень фронта (см. `writeReveal`) начинается ДО тени, поэтому
    // порог отодвигается на её глубину: иначе на окружности ближайшей тени свет
    // обрывался бы ступенью — той самой, ради которой полутень и заведена.
    //
    // Глубина полутени монотонно растёт с дистанцией тени (`penumbraOf`),
    // значит и начало полосы растёт вместе с ней: минимум по бинам достигается
    // на ближайшей тени, и одного числа на наблюдателя хватает. Тени нет вовсе
    // — порог бесконечен, и ветка мертва.
    const nearestShadowSq = shadow.nearestShadowSq;
    const nearestShadow = Math.sqrt(nearestShadowSq);
    staged.penumbraStartSq = penumbra
      ? (nearestShadow - penumbraOf(nearestShadow, edgeWidth)) ** 2
      : nearestShadowSq;
    // Подготовка стоит бюджету своей работы: отбор укрытий идёт по всем
    // отрезкам сетки, растеризация — по дугам бинов (design D1).
    return segments.length + shadowRays;
  }

  /**
   * Строки [y0, y1] подготовленного наблюдателя в растр `target`.
   *
   * Два здешних счётчика зависят от ПОРЯДКА наблюдателей, и по одной причине:
   * оба стоят за выходом «не ярче уже лежащего», а лежащее — это написанное
   * соседним кругом. `fogMaskTexelsWritten` считает записи (в перекрытии
   * текселю достаётся одна или две — смотря кто пришёл первым),
   * `fogShadowTexelTests` — тексели, дошедшие до `Math.atan2` и полутени за
   * ним (пришедший вторым до угла не доходит). Порядок задаёт вставка
   * сущностей в доставку: перестановка сущностей двигает оба поля на проценты,
   * не меняя ни картинки, ни настоящей стоимости, — диффом эталона по ним в
   * одиночку удорожание не доказывается (`cost.ts`). Поднять счёт углов выше
   * выхода нельзя: он тогда перестанет быть счётом `Math.atan2`.
   *
   * Нарезка на порции не двигает ни того, ни другого: строки идут тем же
   * порядком, и решение текселя зависит только от уже лежащего значения.
   */
  private writeReveal(target: Uint8Array, y0: number, y1: number): number {
    const staged = this.staged;
    if (y1 > staged.y1) y1 = staged.y1;
    if (y1 < y0) return 0;
    const scale = this.texelsPerUnit;
    const rectY = this.rect.y;
    const oy = staged.oy;
    this.revealWritten = 0;
    this.revealShadowTests = 0;
    for (let ty = y0; ty <= y1; ty++) {
      const wy = rectY + (ty + 0.5) / scale;
      this.revealRow(target, ty, wy - oy);
    }
    const cost = costSink();
    if (cost !== undefined) {
      cost.fogMaskTexelsWritten += this.revealWritten;
      cost.fogShadowTexelTests += this.revealShadowTests;
    }
    return (y1 - y0 + 1) * (staged.x1 - staged.x0 + 1);
  }

  /**
   * Одна строка reveal-полигона подготовленного наблюдателя; `dy` — её отступ
   * от центра наблюдателя по мировой оси Y.
   *
   * Всё, что цикл по текселям читает сотню тысяч раз за перестройку, лежит в
   * локальных, а не в полях объекта; счёт записей и углов копится тоже в
   * локальных и уходит в поля один раз на строку, а не на тексель (PERF-3).
   */
  private revealRow(target: Uint8Array, ty: number, dy: number): void {
    const staged = this.staged;
    const { x0, x1, ox, radius, radiusSq, innerSq, edgeWidth, shadowed, penumbra } = staged;
    const penumbraStartSq = staged.penumbraStartSq;
    const scale = this.texelsPerUnit;
    const rectX = this.rect.x;
    const dySq = dy * dy;
    const row = ty * this.width;
    let written = 0;
    let shadowTests = 0;
    for (let tx = x0; tx <= x1; tx++) {
      const dx = rectX + (tx + 0.5) / scale - ox;
      const distSq = dx * dx + dySq;
      if (distSq >= radiusSq) continue;
      const current = target[row + tx]!;
      if (current === 255) continue; // уже полностью открыт другим наблюдателем
      // Корень берут не все тексели: во внутреннем круге полного света он
      // ничего не уточняет. Отрицательное значение — «ещё не брали».
      let dist = -1;
      let value = 255;
      if (distSq > innerSq) {
        dist = Math.sqrt(distSq);
        value = Math.round(edgeGradient(dist, radius, edgeWidth) * 255);
      }
      // Ранний выход до самой дорогой операции цикла: тексель, чьё значение и
      // без гашения не превосходит лежащего, не стоит ни угла, ни корня.
      if (value <= current) continue;
      if (shadowed && distSq >= penumbraStartSq) {
        shadowTests++;
        value = this.shadeTexel(value, dist, distSq, dx, dy, edgeWidth, penumbra);
      }
      // Монотонность записи: значение кладётся, только пока растёт, — иначе
      // погашенный полутенью тексель затирал бы более светлый вклад соседнего
      // наблюдателя (максимум по наблюдателям, FOW-7). Ноль полного среза
      // (`shadeTexel`) этой же проверкой и отсеивается.
      if (value <= current) continue;
      target[row + tx] = value;
      written++;
    }
    this.revealWritten += written;
    this.revealShadowTests += shadowTests;
  }

  /**
   * Гашение текселя тенью укрытия: жёсткий срез за фронтом и полутень перед ним
   * (FOW-9, FOW-7). Возвращает новое значение текселя; 0 — тексель за фронтом,
   * и монотонная запись строки его отбросит.
   *
   * Дистанция тени — минимум своего и соседних бинов: консервативность на
   * разрыве силуэта (интерполяция дала бы свет в тени), тень шире, а не уже
   * (FOW-9). Тройка свёрнута до цикла (`depthMin`), сравнение идёт в КВАДРАТАХ
   * — буфер хранит их же: возведение монотонно на неотрицательных, и срез тот
   * же самый.
   *
   * Полутень фронта укрытия (FOW-7): свет гаснет ТОЙ ЖЕ кромкой, что и на
   * границе круга обзора, — потому и считает её `edgeGradient`, где роль
   * радиуса играет дистанция тени. Своего числа в конфигурации у полутени нет
   * намеренно: кромка обзора и кромка тени — одна ширина размытия границы
   * видимого (FOW-10), и вторая ручка расходилась бы с первой; глубину же её
   * ограничивает путь до укрытия (`penumbraOf`), иначе близкое укрытие гасило
   * бы свет под ногами наблюдателя.
   *
   * Гасить — только гасить: сторона тени этой веткой не светлеет ни на единицу
   * (за фронтом стоит ноль), а освещённая сторона к фронту темнеет. Расхождение
   * приближения остаётся в сторону тумана, а не света (FOW-9). Новой ручки
   * качества полутень не требует (QUAL-3): её объём правит тот же потолок
   * `fog.maskResolution`, что и весь растр маски.
   */
  private shadeTexel(
    value: number,
    dist: number,
    distSq: number,
    dx: number,
    dy: number,
    edgeWidth: number,
    penumbra: boolean,
  ): number {
    const bin = binOf(Math.atan2(dy, dx));
    if (distSq >= this.shadow.depthMin[bin]!) return 0; // за фронтом — срез жёсткий
    if (!penumbra) return value;
    const shadow = this.shadow.depthEdge[bin]!;
    const linear = dist < 0 ? Math.sqrt(distSq) : dist;
    return Math.round(value * edgeGradient(linear, shadow, penumbraOf(shadow, edgeWidth)));
  }

  /** Обнуление строк [y0, y1] растра `target` — общий шов обоих путей. */
  private clearInto(target: Uint8Array, y0: number, y1: number): number {
    if (y1 < y0) return 0;
    const from = y0 * this.width;
    const to = (y1 + 1) * this.width;
    const cost = costSink();
    // Обнуление стоит всей маски и растёт квадратом разрешения — счётчик
    // видит это удорожание даже там, где наблюдателей нет вовсе (PERF-3).
    if (cost !== undefined) cost.fogMaskClearTexels += to - from;
    target.fill(0, from, to);
    return to - from;
  }

  /** Задний растр порционной перестройки; без `beginBuild` его не бывает. */
  private back(): Uint8Array {
    const back = this.backing;
    if (back === null) {
      throw new Error('порционная перестройка маски не начата: beginBuild() не вызван');
    }
    return back;
  }

  /**
   * Полутоновая кромка (FOW-7): разделяемый box-блюр радиуса 1 текселя по всей
   * маске ПОСЛЕ всех reveal. Полярная растеризация даёт жёсткий срез на угловых
   * сторонах конуса тени — блюр превращает его в полутон ~текселя одинаково для
   * любого направления кромки (замена прежних 2×2 субсэмплов). Радиальный фронт
   * тени блюра уже не ждёт: его гасит полутень шириной `edgeWidth`
   * (`writeReveal`) — тексель размытия был бы для неё слишком узок.
   * Симметричный перенос света ≤ полтекселя за геометрию тени покрыт
   * консервативным запасом радиуса (FOW-9, коэффициент FOW-10).
   */
  smooth(): void {
    this.smoothInto(this.front, 'horizontal', 0, this.height - 1);
    this.smoothInto(this.front, 'vertical', 0, this.height - 1);
  }

  /**
   * Один проход блюра по строкам [y0, y1] растра `target` — общий шов
   * синхронного и порционного путей.
   *
   * Проходы разделены и идут строго по очереди: горизонтальный пишет только
   * `temp`, вертикальный только его и читает — поэтому нарезка по строкам ничего
   * не путает, лишь бы ВЕСЬ горизонтальный проход закончился до первой строки
   * вертикального (это порядок фаз, design D1).
   *
   * Объём блюра — 2 × растр и растёт квадратом разрешения, как обнуление и
   * загрузка. Новой ручки качества это не требует (QUAL-3): объём правит тот же
   * потолок `fog.maskResolution` (FOW-10), а сток читается один раз на порцию —
   * величина арифметическая, в циклах по текселям счёта нет (PERF-3).
   */
  private smoothInto(target: Uint8Array, pass: FogSmoothPass, y0: number, y1: number): number {
    if (y1 < y0) return 0;
    const cost = costSink();
    const texels = (y1 - y0 + 1) * this.width;
    if (cost !== undefined) cost.fogMaskSmoothTexels += texels;
    if (this.temp?.length !== target.length) {
      this.temp = new Uint8Array(target.length);
    }
    const temp = this.temp;
    if (pass === 'horizontal') this.smoothHorizontal(target, temp, y0, y1);
    else this.smoothVertical(target, temp, y0, y1);
    return texels;
  }

  /** Горизонтальная половина блюра: читает `target`, пишет промежуточный буфер. */
  private smoothHorizontal(target: Uint8Array, temp: Uint8Array, y0: number, y1: number): void {
    const width = this.width;
    const last = width - 1;
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      // Скользящее окно вместо трёх чтений на тексель: горизонтальный проход
      // читает подряд, и сосед слева — это середина прошлого шага. Края
      // повторяют себя ровно как прежние зажимы индекса.
      let left = target[row]!;
      let mid = left;
      for (let x = 0; x < width; x++) {
        const right = x === last ? mid : target[row + x + 1]!;
        temp[row + x] = (left + mid + right + 1) / 3;
        left = mid;
        mid = right;
      }
    }
  }

  /** Вертикальная половина блюра: читает только промежуточный буфер. */
  private smoothVertical(target: Uint8Array, temp: Uint8Array, y0: number, y1: number): void {
    const { width, height } = this;
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      const up = (y === 0 ? 0 : y - 1) * width;
      const down = (y === height - 1 ? y : y + 1) * width;
      for (let x = 0; x < width; x++) {
        target[row + x] = (temp[up + x]! + temp[row + x]! + temp[down + x]! + 1) / 3;
      }
    }
  }

  /** Доля света в мировой точке [0, 1] — ближайший тексель; вне маски — туман. */
  valueAt(worldX: number, worldY: number): number {
    const tx = Math.floor((worldX - this.rect.x) * this.texelsPerUnit);
    const ty = Math.floor((worldY - this.rect.y) * this.texelsPerUnit);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this.front[ty * this.width + tx]! / 255;
  }
}
