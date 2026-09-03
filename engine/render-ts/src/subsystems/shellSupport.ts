/**
 * Общая опора подсистем-оболочек (REND-23, REND-24): НАБОР оболочек с его
 * сведением, чтение бита состояния, поза оболочки в кадре, точка события и
 * возраст события доставки.
 *
 * Подсистемы транзиентных эффектов и частиц остаются разными — у них разные
 * ассеты, разные конвейеры отрисовки и разные наборы оболочек, — но источники
 * они делят один-в-один (см. шапку `particles.ts`), и производное от источников
 * тоже: бит состояния расшифровывается ОДНИМ списком `stateComponents` сборки
 * (CAM-6, SHELL-2), поза оболочки — той же интерполяцией двух доставленных
 * тиков и той же опорной высотой (REND-2, REND-7, REND-9), а сведение набора с
 * доставленным состоянием — тем же обходом «визуальный тип плюс каждое
 * доставленное состояние» с тем же ключом и тем же гашением не помеченных
 * живыми. Второго ответа на эти вопросы рендер не заводит, поэтому и кода
 * здесь один.
 *
 * Владельцев набора сегодня два, и третий (наземные эффекты) встанет сюда же:
 * подсистеме принадлежат ровно три ответа — чем оболочка ЯВЛЯЕТСЯ, как она
 * берётся и отдаётся и как ставится её поза; всё остальное общее.
 *
 * Тексты предупреждений остаются у вызывающих: требование, на которое ссылается
 * сообщение, у каждой подсистемы своё, а «эффект-оболочка» и «эмиттер» — разные
 * вещи для того, кто это предупреждение читает. Сам приём «сказать один раз» —
 * `warnOnce.ts`: им пользуется и камера, подсистемой не являющаяся.
 */
import type { EntityId } from '@fluxus/core';
import type { EntityView, TickView } from '../types.js';
import type { VisualSurface } from '../visualSurface.js';
import type { WarnOnce } from '../warnOnce.js';

/**
 * Читатель бита состояния доставки — форма, которую держат у себя обе
 * подсистемы-оболочки. Имя типа, а не переписанная в каждом месте подпись.
 */
export type StateReader = (view: EntityView, name: string) => boolean;

/**
 * Читатель бита состояния: несёт ли доставленное состояние сущности названное
 * состояние. Бит ищется в списке `stateComponents` сборки — том же, которым
 * Extractor их и зеркалировал (SHELL-2, CAM-6); имени вне списка соответствовать
 * нечему, и об этом говорится один раз, а не молча — текстом вызывающего.
 *
 * «Один раз» держится ЗДЕСЬ, а не только в `warnOnce` вызывающего: читатель
 * зовётся на каждый источник каждой сущности каждой доставки (30 Гц), и
 * вызывающий, чтобы сказать своё сообщение, собирает две шаблонные строки —
 * ключ и текст — ДО дедупа. Пропущенное имя запоминается множеством, и после
 * первого промаха колбэк не зовётся вовсе: строк на сущность × имя × доставку
 * не появляется.
 */
export function createStateReader(
  stateComponents: readonly string[],
  onUnmirrored: (name: string) => void,
): StateReader {
  // Словарь «имя → бит» строится один раз на сборку: читатель зовётся на
  // каждый источник каждой сущности каждой доставки (30 Гц), и линейный поиск
  // по списку был бы работой по числу состояний сборки на каждый такой вызов.
  const bits = new Map<string, number>();
  stateComponents.forEach((name, bit) => bits.set(name, bit));
  const said = new Set<string>();
  return (view: EntityView, name: string): boolean => {
    const bit = bits.get(name);
    if (bit === undefined) {
      if (!said.has(name)) {
        said.add(name);
        onUnmirrored(name);
      }
      return false;
    }
    return ((view.states >>> bit) & 1) === 1;
  };
}

/** Пустой список имён состояний — чтобы доставка без таблицы `byState` не аллоцировала. */
const NO_STATE_NAMES: readonly string[] = [];

/**
 * Имена таблицы `byState` секции, снимаемые ОДИН раз на манифест (кэш до
 * переподачи, REND-17), а не на доставку.
 *
 * Пустой словарь состояний сборки — ЛЕГАЛЬНАЯ сборка без доставленных состояний
 * (вьюпорт редактора: тика в кадре правки нет, ED-15), а не забытая прокидка:
 * оболочек состояния в ней не бывает по построению, и таблица пропускается
 * целиком — молча. Предупреждает `createStateReader` о другом: о списке,
 * который есть, но названного состояния не несёт. Обе подсистемы-оболочки
 * трактуют это одинаково: расхождение стоило редактору предупреждения на каждое
 * открытие сцены.
 */
export function stateTableNames(
  table: Readonly<Record<string, unknown>> | undefined,
  stateComponents: readonly string[],
): readonly string[] {
  return table === undefined || stateComponents.length === 0 ? NO_STATE_NAMES : Object.keys(table);
}

/** Ключ оболочки: сущность плюс имя источника (тип, состояние или набор). */
export function shellKey(entity: EntityId, source: string): string {
  return `${String(entity)}|${source}`;
}

/** Поза оболочки в кадре; переиспользуется — аллокаций на оболочку на кадр нет. */
export interface ShellPose {
  x: number;
  y: number;
  /** Опорная высота под оболочкой: поверхность либо ступень уровня. */
  base: number;
}

/** Переиспользуемая поза для одного места вызова. */
export function createShellPose(): ShellPose {
  return { x: 0, y: 0, base: 0 };
}

/**
 * Поза оболочки в кадре: горизонталь — интерполяция двух доставленных тиков
 * (REND-2), опорная высота — визуальная поверхность (REND-9), а без неё либо при
 * override уровня — ступень уровня (REND-7). Что подсистема добавит сверх
 * опорной высоты — подъём записи, дуга полёта (REND-12), — её дело.
 */
export function poseShell(
  view: EntityView,
  alpha: number,
  heightStep: number,
  surface: VisualSurface | null,
  out: ShellPose,
): void {
  const t = view.snap ? 1 : alpha;
  const x = view.prevX + (view.currX - view.prevX) * t;
  const y = view.prevY + (view.currY - view.prevY) * t;
  out.x = x;
  out.y = y;
  out.base =
    surface !== null && !view.levelOverride
      ? surface.heightAt(x, y)
      : (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
}

// ------------------------------------------------------------- набор оболочек

/**
 * Оболочка: изображение, привязанное к сущности доставленного состояния либо к
 * размещённому объекту набора (REND-18). Ключ — пара «сущность + источник»
 * (`kind:<тип>`, `state:<состояние>`, имя набора): на одной сущности законны
 * несколько — шарик снаряда и сфера щита поверх героя.
 *
 * Запись манифеста оболочка ДЕРЖИТ: её читают и поза, и сведение с правленым
 * документом. Разобранное из записи — кэш найденного узла-сокета — владелец
 * добавляет своим типом поверх этого.
 */
export interface Shell<R, I> {
  readonly key: string;
  /** Имя источника оболочки: `kind:<тип>`, `state:<состояние>` либо имя набора. */
  readonly source: string;
  /** Из какого набора сущность: presentation-состояние или декорации (REND-18). */
  readonly decoration: boolean;
  instance: I;
  record: R;
  view: EntityView;
}

/**
 * Три ответа, которыми владелец набора отличается от других владельцев.
 * Остальное — общий механизм.
 */
export interface ShellSetHooks<R, I, S extends Shell<R, I>> {
  /**
   * Завести оболочку источника. null — заводить нечем (ассет не доехал,
   * примитив рендеру неизвестен): источник пропускается с предупреждением
   * владельца, а не отказом кадра.
   */
  acquire(key: string, source: string, view: EntityView, record: R): S | null;
  /** Погасить оболочку и вернуть её изображение в свой пул. */
  release(shell: S): void;
  /**
   * Правленая запись на живой оболочке (REND-17). `false` — прежним
   * изображением новую запись не сыграть (другой ассет): оболочка гасится и
   * заводится заново. Зовётся, только когда запись сменилась.
   */
  rebind?(shell: S, record: R): boolean;
  /** Поза оболочки в кадре; `pose` — переиспользуемая запись набора. */
  pose(
    shell: S,
    alpha: number,
    heightStep: number,
    surface: VisualSurface | null,
    pose: ShellPose,
  ): void;
}

/**
 * Набор оболочек одного владельца: карта «ключ → оболочка», её сведение с
 * доставленным состоянием и её поза в кадре.
 *
 * Сведение идёт двумя фазами — `begin()` … `ensure()` … `sweep()`, — и набор
 * живых ключей между ними ПЕРЕИСПОЛЬЗУЕТСЯ: аллокаций на доставку, растущих с
 * числом оболочек, у сведения нет.
 */
export class ShellSet<R, I, S extends Shell<R, I> = Shell<R, I>> {
  private readonly hooks: ShellSetHooks<R, I, S>;
  private readonly shells = new Map<string, S>();
  /** Переиспользуемый набор ключей живых оболочек: сведение без аллокаций на кадр. */
  private readonly live = new Set<string>();
  /** Переиспользуемая поза: аллокаций на оболочку на кадр нет. */
  private readonly scratch = createShellPose();

  constructor(hooks: ShellSetHooks<R, I, S>) {
    this.hooks = hooks;
  }

  get size(): number {
    return this.shells.size;
  }

  values(): IterableIterator<S> {
    return this.shells.values();
  }

  get(key: string): S | undefined {
    return this.shells.get(key);
  }

  /** Первая оболочка сущности в порядке создания; undefined — оболочек нет. */
  first(entity: EntityId): S | undefined {
    const prefix = `${String(entity)}|`;
    for (const [key, shell] of this.shells) {
      if (key.startsWith(prefix)) return shell;
    }
    return undefined;
  }

  /** Начало сведения: набор живых ключей пуст. */
  begin(): void {
    this.live.clear();
  }

  /**
   * Оболочка источника: создаётся, обновляется правленой записью и помечается
   * живой. Возвращает её; null — заводить нечем (см. `acquire`).
   */
  ensure(view: EntityView, source: string, record: R): S | null {
    const key = shellKey(view.id, source);
    let shell = this.shells.get(key);
    if (shell !== undefined && shell.record !== record) {
      // Другая запись: владелец либо переснимает её на месте, либо говорит,
      // что прежним изображением её не сыграть (другой ассет) — и это не
      // «мигание», а честная смена (REND-17).
      if (this.hooks.rebind?.(shell, record) === false) {
        this.hooks.release(shell);
        this.shells.delete(key);
        shell = undefined;
      } else {
        shell.record = record;
      }
    }
    if (shell === undefined) {
      shell = this.hooks.acquire(key, source, view, record) ?? undefined;
      if (shell === undefined) return null;
      this.shells.set(key, shell);
    }
    shell.view = view;
    this.live.add(key);
    return shell;
  }

  /** Оболочки, не помеченные живыми в этом сведении, гасятся и уходят в пул. */
  sweep(): void {
    for (const [key, shell] of this.shells) {
      if (this.live.has(key)) continue;
      this.hooks.release(shell);
      this.shells.delete(key);
    }
  }

  /** Гасит весь набор ТЕМ ЖЕ путём, что сведение: второго «удалить всё» не заводится. */
  clear(): void {
    this.begin();
    this.sweep();
  }

  /**
   * Поза каждой оболочки набора в кадре. Возвращает число поставленных поз —
   * вход счётчика стоимости владельца (PERF-3): тащить сток стоимости в общую
   * опору ради него незачем.
   */
  poseAll(alpha: number, heightStep: number, surface: VisualSurface | null): number {
    let posed = 0;
    for (const shell of this.shells.values()) {
      this.hooks.pose(shell, alpha, heightStep, surface, this.scratch);
      posed++;
    }
    return posed;
  }
}

/**
 * Обход ИСТОЧНИКОВ доставленного состояния (REND-23, REND-24): визуальный тип
 * сущности и каждое доставленное состояние таблицы. Один на обе подсистемы —
 * правило «какие оболочки существуют» одно.
 *
 * Возвращает число сведённых источников С ЗАПИСЬЮ — величину, которую владелец
 * кладёт в свой счётчик стоимости (PERF-2): сток стоимости в общую опору не
 * тащится, а считать сведения дважды не приходится.
 */
export function syncShellSources<R, I, S extends Shell<R, I>>(
  set: ShellSet<R, I, S>,
  entities: Iterable<EntityView>,
  stateNames: readonly string[],
  hasState: StateReader,
  byKind: (kind: string) => R | undefined,
  byState: (name: string) => R | undefined,
): number {
  let synced = 0;
  set.begin();
  for (const view of entities) {
    // Оболочка визуального типа: живёт, пока жива сущность такого типа.
    if (view.kind !== null) {
      const record = byKind(view.kind);
      if (record !== undefined) {
        synced++;
        set.ensure(view, `kind:${view.kind}`, record);
      }
    }
    // Оболочка состояния: живёт, пока состояние доставляется (REND-23, REND-24).
    for (const name of stateNames) {
      if (!hasState(view, name)) continue;
      const record = byState(name);
      if (record === undefined) continue;
      synced++;
      set.ensure(view, `state:${name}`, record);
    }
  }
  set.sweep();
  return synced;
}

// -------------------------------------------------------------- точка события

/** Мировая точка события; переиспользуется — аллокаций на событие нет. */
export interface EventPoint {
  x: number;
  y: number;
}

/**
 * Поля события, называющие СУЩНОСТЬ, — в порядке предпочтения. Перечень тот же,
 * которым фильтр снапшота ядра переводит сущности события (`core-ts`
 * `sim/filter.ts`): событие, доехавшее только с `target` либо только с `other`,
 * играть тоже есть где, и молчаливого пропуска оно не заслуживает.
 */
const EVENT_ENTITY_FIELDS = ['entity', 'other', 'source', 'target'] as const;

/**
 * Точка события в мировых координатах (REND-23, REND-24): координатные поля
 * события, а нет их — позиция сущности события. `false` — играть событие негде,
 * и об этом сказано один раз на ТИП события, а не молча: запись манифеста,
 * которая никогда не играет, иначе выглядит как сломанный эффект.
 *
 * Обе величины — float: координаты события приведены на входной границе рендера
 * (REND-1, `eventData.ts`), позиция сущности приезжает такой же из
 * presentation-состояния. Разбор один на обе подсистемы-оболочки: второй его
 * записью «нет координат — возьми сущность» разошёлся бы с первой.
 */
export function eventPointOf(
  type: string,
  data: Readonly<Record<string, number>>,
  view: TickView,
  out: EventPoint,
  warnOnce: WarnOnce,
  requirement: string,
): boolean {
  if (data.x !== undefined && data.y !== undefined) {
    out.x = data.x;
    out.y = data.y;
    return true;
  }
  for (const field of EVENT_ENTITY_FIELDS) {
    const entity = data[field];
    if (entity === undefined) continue;
    const entityView = view.entities.get(entity);
    if (entityView === undefined) continue;
    out.x = entityView.currX;
    out.y = entityView.currY;
    return true;
  }
  warnOnce(
    `event-point:${type}`,
    `render: у события "${type}" нет ни координат, ни доставленной сущности — играть его негде (${requirement})`,
  );
  return false;
}

/**
 * Поля события, называющие ВТОРОЙ конец — цель (REND-23, design D5). Координаты
 * события сюда не входят намеренно: их уже взял первый конец (`eventPointOf`), и
 * второй смысл у одной пары чисел сделал бы луч «из точки в ту же точку».
 */
const EVENT_TARGET_FIELDS = ['target', 'other'] as const;

/**
 * Второй конец эффекта-луча в мировых координатах; `false` — цели у события нет,
 * и рисовать отрезок не из чего. Молчит: событие без цели — обычное событие, а
 * не сломанная запись, и луч по нему просто не играет.
 */
export function eventEndOf(
  data: Readonly<Record<string, number>>,
  view: TickView,
  out: EventPoint,
): boolean {
  for (const field of EVENT_TARGET_FIELDS) {
    const entity = data[field];
    if (entity === undefined) continue;
    const entityView = view.entities.get(entity);
    if (entityView === undefined) continue;
    out.x = entityView.currX;
    out.y = entityView.currY;
    return true;
  }
  return false;
}

/**
 * Курс фигуры события, радианы: вектор направления события (`dirX`/`dirY` — та
 * же конвенция, которой Extractor берёт направление каста для bone-контроля,
 * REND-5), а без него — ноль. Выдумывать направление рендер не вправе.
 */
export function eventYawOf(data: Readonly<Record<string, number>>): number {
  const dx = data.dirX;
  const dy = data.dirY;
  if (dx === undefined || dy === undefined) return 0;
  return Math.atan2(dy, dx);
}

/**
 * Возраст эффекта, порождённого событием доставки, в секундах (REND-23,
 * REND-24, SHELL-4).
 *
 * Доставка вправе привезти события НЕСКОЛЬКИХ тиков: отправитель конфлирует
 * (`client-shell` SHELL-4), и любой затык главного потока — GC, скрытая
 * вкладка — сложит их в один конверт. Проигранные с нулевого возраста, они
 * начались бы и кончились одним кадром: N взрывов, разнесённых в мире на сотни
 * миллисекунд, слились бы в один. Возраст считается от тика события до тика
 * доставки; событие без тика (документный источник, REND-11) — нулевой.
 *
 * Знак ошибки здесь односторонний: возраст не бывает отрицательным, а занижение
 * шага тика продлевает эффект, но не гасит его.
 */
export function eventAgeSeconds(
  view: TickView,
  tick: number | undefined,
  tickSeconds: number,
): number {
  if (tick === undefined) return 0;
  const ticks = view.tick - tick;
  return ticks > 0 ? ticks * tickSeconds : 0;
}
