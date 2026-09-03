/**
 * Величины занятой памяти рендера (`performance-budget` PERF-8) — второй сток
 * рядом со счётчиками стоимости (`cost.ts`), с другой арифметикой.
 *
 * ## Почему сток отдельный, а не поля `RenderCostCounters`
 *
 * У стоимости арифметика `+=`: работа за прогон складывается. У памяти —
 * `max` и «создано минус освобождено»: память есть СОСТОЯНИЕ, а не работа, и
 * «сколько всего» для неё бессмысленно (PERF-8). Смешав их в одной структуре,
 * гейт эталона пришлось бы учить различать поля по имени — суммировать одни и
 * брать пик у других. Отдельный сток снимает вопрос: гейт стоимости остаётся
 * суммирующим, гейт памяти — пиковым.
 *
 * По той же причине эти величины НЕ входят в `COST_COUNTER_STAGES` и стадией
 * конвейера (PERF-2) не помечаются: создание ресурса — событие (инициализация,
 * приход ассета, переподача документа, смена размера окна), а не стадия кадра, а
 * величина состояния — не работа. Тест `render-ts`, требующий стадию у каждого
 * счётчика стоимости, остаётся от этого честным.
 *
 * ## Ресурсы GPU: живое число как разность
 *
 * `own(kind, owner, resource)` вызывается НА МЕСТЕ создания ресурса: он
 * увеличивает `created` по виду × владельцу и подписывает на событие `dispose`
 * самого ресурса слушателя, увеличивающего `disposed`. Живое число — разность,
 * и держит её сток, а не измеряемый объект (то же соображение, что у DIAG-1:
 * накопление внутри измеряемого пришлось бы где-то обнулять и не забыть про
 * него в следующей подсистеме).
 *
 * Геометрии, материалы, текстуры и цели отрисовки THREE — `EventDispatcher`'ы, и
 * `dispose()` каждого рассылает событие `dispose`. Живого WebGL для этого не
 * нужно: «отдали ли объект» видно headless — на этом же держатся тесты
 * `lifetime.test.ts`, только шпионом на заранее выбранных объектах, а не учётом
 * всего созданного (PERF-9).
 *
 * ## Аллокации: на событии, не на кадре
 *
 * Замыкание слушателя — аллокация, и она лежит рядом с созданием ресурса GPU,
 * то есть на пути, который сам по себе многократно дороже. Горячие пути тика и
 * кадра учёт не трогает вовсе (PERF-3): величины состояния пишутся `peak`, а
 * это `Math.max` в заранее созданное поле под одним сравнением стока.
 *
 * ## Граница метода
 *
 * Внутренности сторонних библиотек стоку не видны и видны быть не могут:
 * буферы батчей эмиттеров, которые строит `BatchedRenderer` (`three.quarks`),
 * заводит библиотека, а не мы. Подсистема частиц регистрирует то, чем владеет по
 * документу эффекта (материал и геометрию систем); остальное — зона сторожа
 * кучи (PERF-10) и `renderer.info.memory` браузерного бенча (PERF-7).
 */

/** Вид ресурса GPU (PERF-8). Перечень закрыт: он же — словарь правила сканера (PERF-9). */
export const FOOTPRINT_RESOURCE_KINDS = ['geometry', 'material', 'texture', 'renderTarget'] as const;

export type FootprintResourceKind = (typeof FOOTPRINT_RESOURCE_KINDS)[number];

/**
 * Ресурс глазами учёта — ровно та поверхность, которая ему нужна: подписка на
 * собственное событие освобождения. Структурный минимум, а не класс THREE, по
 * той же причине, по какой её берут спаи тестов: сток обязан работать headless и
 * не тянуть за собой три четверти библиотеки в сигнатуру.
 */
export interface FootprintResource {
  addEventListener(type: 'dispose', listener: (event: unknown) => void): void;
}

/** Создано и освобождено по одному виду ресурса одного владельца. */
export interface ResourceTally {
  created: number;
  disposed: number;
  /**
   * Наибольшее ЖИВОЕ число за прогон — то, что идёт в эталон (PERF-8): память
   * есть состояние, и «сколько всего создано» для неё бессмысленно, а «сколько
   * держалось одновременно» — ровно та величина, которую бюджет и нормирует.
   * Текущее живое число (разность) при этом остаётся входом инварианта PERF-9.
   */
  peakLive: number;
}

/**
 * Величины состояния подсистем и швов тракта (PERF-8): размеры структур,
 * которыми владеют ОБЕ половины потока тиков — и главная, и воркерная
 * (`client-shell` SHELL-2). Плоские целые поля, как у счётчиков стоимости;
 * арифметика — максимум за прогон.
 */
export interface FootprintState {
  /**
   * Записи сущностей в приёме доставки (`ViewBuffer`, SHELL-2): размер карты
   * после применения тика. Оборот доставки обязан возвращать их — на нагрузке с
   * вращающимися идентификаторами это число расти MUST NOT (PERF-9).
   */
  viewRecords: number;
  /**
   * Курсов в памяти приёма доставки (`ViewBuffer.facingMemory`): своя строка,
   * потому что чистится она по своему правилу — потолком и разрывом
   * непрерывности, — а не вместе с записями.
   */
  viewFacingMemory: number;
  /**
   * Байты ёмкости ВОРКЕР-половины доставки (`client-shell` SHELL-2, SHELL-3):
   * колонки плоской формы с их разреженной секцией статов, буферы обхода живых
   * и списка исчезнувших, плюс те же величины зеркала последнего доставленного
   * кадра. Одно поле на обе структуры: растут они одним событием — ростом
   * сцены, — и раздельные строки показывали бы одно и то же дважды.
   *
   * Байты, а не число сущностей: ширины колонок разные (таблица плоской формы
   * — союз четырёх типов), и «ёмкость на 256 сущностей» без ширин не сравнима
   * с ёмкостью после добавления колонки.
   */
  extractStateBytes: number;
  /** Инстансы моделей в пулах подсистемы (REND-3, REND-18): сущности и декорации вместе. */
  modelsInstances: number;
  /** Записи в батчах (REND-20) — то, что кадр компактует в инстанс-буферы. */
  modelsBatchRecords: number;
  /** Батчей в кэше подсистемы моделей — та самая граница кэша, которую нормирует REND-31. */
  modelsBatches: number;
  /** Экземпляры эффектов в пуле подсистемы частиц (REND-24): живые и отдыхающие вместе. */
  particlesPooled: number;
  /** Чанки геометрии террейна (REND-7): по одному мешу пола и стенок на чанк. */
  terrainChunks: number;
  /** Байты растра маски видимости (FOW-7): длина буфера, уезжающего в текстуру. */
  fogMaskBytes: number;
}

/** Имя величины состояния — ключ `peak`. */
export type FootprintStateField = keyof FootprintState;

/**
 * Сток величин занятой памяти. Таблица владельцев заводится по мере первых
 * `own` — то есть на инициализации подсистем, а не в кадре.
 */
export interface RenderFootprint {
  /** Владелец → вид ресурса → «создано / освобождено». */
  readonly resources: Map<string, Map<FootprintResourceKind, ResourceTally>>;
  readonly state: FootprintState;
}

/** Свежий сток — все величины нулями, таблица владельцев пуста. Создаётся раз на замер. */
export function createFootprint(): RenderFootprint {
  return {
    resources: new Map(),
    state: {
      viewRecords: 0,
      viewFacingMemory: 0,
      extractStateBytes: 0,
      modelsInstances: 0,
      modelsBatchRecords: 0,
      modelsBatches: 0,
      particlesPooled: 0,
      terrainChunks: 0,
      fogMaskBytes: 0,
    },
  };
}

let current: RenderFootprint | undefined;

/**
 * Стоки, ОТПУЩЕННЫЕ владельцем под чужим замером. Та же механика и та же
 * причина, что у `releaseCostSink` (`cost.ts`): обмен «поставил — вернул
 * предыдущий» строго стековый, а долгоживущий владелец в этот стек не
 * укладывается.
 */
const abandoned = new WeakSet<RenderFootprint>();

function restore(sink: RenderFootprint | undefined): void {
  current = sink !== undefined && abandoned.delete(sink) ? undefined : sink;
}

/** Подключённый сток или `undefined`. Читается ОДИН раз на вызов (PERF-3). */
export function footprintSink(): RenderFootprint | undefined {
  return current;
}

/** Подключает сток и возвращает предыдущий — для замеров длиннее одного вызова. */
export function attachFootprintSink(
  sink: RenderFootprint | undefined,
): RenderFootprint | undefined {
  const previous = current;
  restore(sink);
  return previous;
}

/** Отпускает ДОЛГОЖИВУЩИЙ сток — см. `releaseCostSink` (`cost.ts`), правило то же. */
export function releaseFootprintSink(sink: RenderFootprint): void {
  if (current === sink) {
    current = undefined;
    return;
  }
  abandoned.add(sink);
}

/**
 * Исполняет тело замера с подключённым стоком. Предыдущее значение
 * возвращается в `finally`: обрыв исключением не должен оставить чужой сток
 * подключённым.
 */
export function withFootprintSink<T>(sink: RenderFootprint, body: () => T): T {
  const previous = current;
  restore(sink);
  try {
    return body();
  } finally {
    restore(previous);
  }
}

/** Счётчики вида ресурса у владельца; заводятся при первом `own` этой пары. */
function tallyOf(
  sink: RenderFootprint,
  owner: string,
  kind: FootprintResourceKind,
): ResourceTally {
  let byKind = sink.resources.get(owner);
  if (byKind === undefined) {
    byKind = new Map();
    sink.resources.set(owner, byKind);
  }
  let tally = byKind.get(kind);
  if (tally === undefined) {
    tally = { created: 0, disposed: 0, peakLive: 0 };
    byKind.set(kind, tally);
  }
  return tally;
}

/**
 * Регистрирует созданный ресурс GPU и возвращает его же (PERF-8) — обёртка
 * вокруг выражения создания, не меняющая ни владения, ни порядка:
 *
 * ```ts
 * const geometry = own('geometry', 'terrain', new THREE.BufferGeometry());
 * ```
 *
 * Без подключённого стока не делает НИЧЕГО, кроме одного сравнения: обычный
 * матч за бенчмарк не платит (PERF-3, сценарий «Выключенный учёт бесплатен»).
 *
 * Слушатель одноразовый: `dispose()` рассылает событие при каждом вызове, а
 * повторное освобождение уже отданного ресурса — не второе освобождение, и
 * уводить живое число в минус ему нечем.
 */
export function own<T extends FootprintResource>(
  kind: FootprintResourceKind,
  owner: string,
  resource: T,
): T {
  const sink = current;
  if (sink === undefined) return resource;
  const tally = tallyOf(sink, owner, kind);
  tally.created++;
  const alive = tally.created - tally.disposed;
  if (alive > tally.peakLive) tally.peakLive = alive;
  let released = false;
  // Замыкание держит счётчики СТОКА, при котором ресурс создан: отданный позже,
  // под другим замером, он уменьшит живое число там, где его прибавил.
  resource.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    tally.disposed++;
  });
  return resource;
}

/**
 * Пик величины состояния (PERF-8): `Math.max` в заранее созданное поле. Зовётся
 * швом, которому размер уже известен, — один раз на доставку или на пересборку,
 * а не на инстанс.
 */
export function peak(field: FootprintStateField, value: number): void {
  const sink = current;
  if (sink === undefined) return;
  if (value > sink.state[field]) sink.state[field] = value;
}

/**
 * Живые ресурсы стока плоским документом: владелец → вид → разность. Порядок
 * ключей — лексикографический (SER-6): документ эталона и текст находки теста
 * не должны зависеть от того, в каком порядке подсистемы завели своих
 * владельцев.
 *
 * Пары с нулевым `created` не опускаются: владелец, заведший ресурс и отдавший
 * его, обязан читаться нулём, а не отсутствием строки — «ноль живых» и «никто
 * не создавал» на ревью разные утверждения (PERF-9).
 */
export function footprintLive(sink: RenderFootprint): Record<string, Record<string, number>> {
  return report(sink, (tally) => tally.created - tally.disposed);
}

/**
 * ПИК живых ресурсов стока — то, что идёт в эталон (PERF-8). Отличается от
 * `footprintLive` ровно тем, чем эталон отличается от инварианта: инварианту
 * PERF-9 нужно «сколько осталось после сноса», эталону — «сколько держалось
 * одновременно», и величина эта от порядка сноса не зависит.
 */
export function footprintPeakLive(sink: RenderFootprint): Record<string, Record<string, number>> {
  return report(sink, (tally) => tally.peakLive);
}

function report(
  sink: RenderFootprint,
  value: (tally: ResourceTally) => number,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const owner of [...sink.resources.keys()].sort()) {
    const byKind = sink.resources.get(owner)!;
    const kinds: Record<string, number> = {};
    for (const kind of FOOTPRINT_RESOURCE_KINDS) {
      const tally = byKind.get(kind);
      if (tally !== undefined) kinds[kind] = value(tally);
    }
    out[owner] = kinds;
  }
  return out;
}
