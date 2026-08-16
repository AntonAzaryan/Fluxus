/**
 * Таблица маркеров миникарты и реестр именованных отрисовщиков (HUD-6).
 *
 * Представление маркера по визуальному типу сущности — данные, а не код:
 * запись таблицы задаёт имя отрисовщика, окраску (командную или
 * фиксированную), размер и приоритет; тип без записи получает поведение по
 * объявленной политике таблицы — default-маркер либо пропуск, но не ошибку
 * (HUD-6, сценарий «тип без записи в таблице»). Расширение миникарты новым
 * типом сущности — запись в данных, а не правка кода.
 *
 * Отрисовщики — реестр по образцу реестров композиции (HUD-4, design
 * Decision 9): специальные маркеры (иконка героя, пинг) регистрируются по
 * именам за единым интерфейсом, и встроенные формы (dot/square/triangle) —
 * такие же именованные отрисовщики того же реестра. Таблица всегда ссылается
 * на отрисовщик по имени — один механизм, особых случаев нет.
 *
 * Таблица JSON-сериализуема и живёт в параметрах записи композиции (HUD-4):
 * с переездом композиции на JSON-документ она уезжает вместе с ней.
 */
import type { HudJsonValue } from '../composition.js';

// --------------------------------------------------------------- 2D-контекст

/**
 * 2D-контекст глазами миникарты: структурное подмножество
 * `CanvasRenderingContext2D` — ровно та поверхность, которую зовут
 * отрисовщики. Настоящий контекст подходит структурно; тест подставляет
 * записывающую заглушку и обходится без браузера (образец — `delivery.ts`,
 * структурные подмножества вместо импорта чужих типов).
 */
export interface MinimapContext2D {
  /** У настоящего контекста тип шире (`string | CanvasGradient | ...`); пишем сюда строку цвета. */
  fillStyle: unknown;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  /**
   * Прозрачность последующих операций и блит изображения — их использует слой
   * тумана (`fog-of-war` FOW-7 → HUD-6). Необязательны: сборка без тумана
   * живёт узким контекстом, а виджет без них слоя не рисует.
   */
  globalAlpha?: number;
  drawImage?(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
}

// ------------------------------------------------------- сущность для маркера

/**
 * Сущность глазами отрисовщика маркера — структурное подмножество
 * `HudEntityView` (`delivery.ts`).
 *
 * `team` — команда для командной окраски. Поля пока НЕТ в доставленной
 * плоской форме: когда командная окраска понадобится всерьёз, поле добавляется
 * на стороне воркера штатным механизмом SHELL-2 (HUD-1 — побочного пути чтения
 * не существует), и тип здесь его уже ждёт. До тех пор сущность без `team`
 * красится в `fallback` командной записи.
 */
export interface MinimapEntityView {
  readonly id: number;
  /** Визуальный тип (ключ манифеста визуалов); null — сущность не рисуется. */
  readonly kind: string | null;
  /** Позиция последнего доставленного тика (float, мировые единицы). */
  readonly currX: number;
  readonly currY: number;
  readonly team?: number;
}

// ------------------------------------------------------------------- таблица

/* eslint-disable @typescript-eslint/consistent-type-definitions --
 * type, а не interface: неявная индексная подпись есть только у type-алиасов,
 * без неё таблица не присваивается `HudJsonValue` и не может лежать в
 * параметрах записи композиции (HUD-4, HUD-6). */

/**
 * Окраска маркера: фиксированный цвет либо командная — словарь
 * «команда → цвет» с обязательным запасным цветом (сущность без команды или
 * с командой вне словаря не ошибка, а `fallback`).
 */
export type MinimapColorSpec =
  | { readonly mode: 'fixed'; readonly color: string }
  | {
      readonly mode: 'team';
      /** Ключ — номер команды строкой: JSON не умеет числовых ключей. */
      readonly byTeam: Readonly<Record<string, string>>;
      readonly fallback: string;
    };

/** Представление маркера одного визуального типа (HUD-6): данные, не код. */
export type MinimapMarkerSpec = {
  /** Имя отрисовщика в реестре — встроенная форма или специальный маркер. */
  readonly renderer: string;
  readonly color: MinimapColorSpec;
  /** Размер маркера в px миникарты. */
  readonly size: number;
  /** Порядок отрисовки: больший приоритет рисуется поверх меньшего. */
  readonly priority: number;
};

/** Политика типа без записи: default-маркер либо пропуск, но не ошибка (HUD-6). */
export type MinimapUnknownKindPolicy =
  | { readonly policy: 'skip' }
  | { readonly policy: 'default'; readonly marker: MinimapMarkerSpec };

/**
 * Таблица маркеров миникарты: визуальный тип → представление, плюс объявленная
 * политика неизвестного типа. Часть параметров записи композиции — значение,
 * JSON-сериализуемое по построению (HUD-4).
 */
export type MinimapMarkerTable = {
  readonly markers: Readonly<Record<string, MinimapMarkerSpec>>;
  readonly unknownKind: MinimapUnknownKindPolicy;
};

/* eslint-enable @typescript-eslint/consistent-type-definitions */

// -------------------------------------------------------- реестр отрисовщиков

/** Разрешённые данные отрисовки: цвет уже выбран по записи и команде сущности. */
export interface MinimapMarkerDraw {
  readonly color: string;
  readonly size: number;
  readonly spec: MinimapMarkerSpec;
}

/**
 * Единый интерфейс отрисовщика маркера (HUD-6): встроенная форма и специальный
 * маркер неразличимы для таблицы — она ссылается на имя, реестр знает функцию.
 * `x`/`y` — центр маркера в px поверхности миникарты.
 */
export type MinimapMarkerRenderer = (
  ctx: MinimapContext2D,
  x: number,
  y: number,
  entity: MinimapEntityView,
  draw: MinimapMarkerDraw,
) => void;

/** Реестр именованных отрисовщиков — по образцу `HudRegistry` (HUD-4). */
export class MinimapRendererRegistry {
  private readonly renderers = new Map<string, MinimapMarkerRenderer>();

  register(name: string, renderer: MinimapMarkerRenderer): void {
    if (this.renderers.has(name)) {
      throw new Error(`отрисовщик маркера "${name}" уже зарегистрирован`);
    }
    this.renderers.set(name, renderer);
  }

  renderer(name: string): MinimapMarkerRenderer {
    const renderer = this.renderers.get(name);
    if (renderer === undefined) throw new Error(`отрисовщик маркера "${name}" не зарегистрирован`);
    return renderer;
  }
}

const TWO_PI = Math.PI * 2;

const drawDot: MinimapMarkerRenderer = (ctx, x, y, _entity, draw) => {
  ctx.fillStyle = draw.color;
  ctx.beginPath();
  ctx.arc(x, y, draw.size / 2, 0, TWO_PI);
  ctx.fill();
};

const drawSquare: MinimapMarkerRenderer = (ctx, x, y, _entity, draw) => {
  ctx.fillStyle = draw.color;
  ctx.fillRect(x - draw.size / 2, y - draw.size / 2, draw.size, draw.size);
};

const drawTriangle: MinimapMarkerRenderer = (ctx, x, y, _entity, draw) => {
  const half = draw.size / 2;
  ctx.fillStyle = draw.color;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y + half);
  ctx.lineTo(x - half, y + half);
  ctx.closePath();
  ctx.fill();
};

/**
 * Реестр со встроенными формами. Встроенное регистрируется тем же `register`,
 * что и специальные отрисовщики сборки, — один механизм, без особых случаев
 * (HUD-6): таблица не отличает `dot` от будущего `heroIcon`.
 */
export function builtinMarkerRenderers(): MinimapRendererRegistry {
  const registry = new MinimapRendererRegistry();
  registry.register('dot', drawDot);
  registry.register('square', drawSquare);
  registry.register('triangle', drawTriangle);
  return registry;
}

// ------------------------------------------------------------------ резолв

/** Цвет маркера по записи и сущности: команда вне словаря — `fallback`, не ошибка. */
export function markerColor(spec: MinimapColorSpec, entity: MinimapEntityView): string {
  if (spec.mode === 'fixed') return spec.color;
  const team = entity.team;
  if (team === undefined) return spec.fallback;
  return spec.byTeam[String(team)] ?? spec.fallback;
}

/** Запись таблицы, разрешённая против реестра: спека плюс сама функция отрисовки. */
export interface ResolvedMarker {
  readonly spec: MinimapMarkerSpec;
  readonly render: MinimapMarkerRenderer;
}

/**
 * Разрешённая таблица: `markerFor` тотальна по видам — неизвестный тип получает
 * default-маркер или `null` (пропуск) по политике таблицы, но не ошибку (HUD-6).
 */
export interface ResolvedMarkerTable {
  markerFor(kind: string): ResolvedMarker | null;
}

function resolveMarker(
  renderers: MinimapRendererRegistry,
  spec: MinimapMarkerSpec,
  where: string,
): ResolvedMarker {
  try {
    return { spec, render: renderers.renderer(spec.renderer) };
  } catch {
    throw new Error(`таблица маркеров, ${where}: неизвестный отрисовщик "${spec.renderer}"`);
  }
}

/**
 * Резолв таблицы против реестра отрисовщиков — целиком и до первой отрисовки,
 * по образцу `resolveComposition` (HUD-4): ошибка конфигурации (неизвестное
 * имя отрисовщика) падает при создании виджета и называет запись, а не молчит
 * до первой доставки. Неизвестный ВИД сущности ошибкой не бывает — это
 * политика таблицы (HUD-6).
 */
export function resolveMarkerTable(
  table: MinimapMarkerTable,
  renderers: MinimapRendererRegistry,
): ResolvedMarkerTable {
  const byKind = new Map<string, ResolvedMarker>();
  for (const [kind, spec] of Object.entries(table.markers)) {
    byKind.set(kind, resolveMarker(renderers, spec, `тип "${kind}"`));
  }
  const fallback =
    table.unknownKind.policy === 'default'
      ? resolveMarker(renderers, table.unknownKind.marker, 'default-маркер политики unknownKind')
      : null;
  return { markerFor: (kind) => byKind.get(kind) ?? fallback };
}

// ------------------------------------------------- чтение таблицы из params

function isRecord(value: HudJsonValue | undefined): value is Readonly<Record<string, HudJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function colorFrom(value: HudJsonValue | undefined, where: string): MinimapColorSpec {
  if (!isRecord(value)) throw new Error(`${where}: окраска должна быть объектом`);
  const mode = value.mode;
  if (mode === 'fixed') {
    const color = value.color;
    if (typeof color !== 'string') throw new Error(`${where}: у окраски "fixed" нужен строковый "color"`);
    return { mode, color };
  }
  if (mode === 'team') {
    const byTeamValue = value.byTeam;
    const fallback = value.fallback;
    if (!isRecord(byTeamValue)) throw new Error(`${where}: у окраски "team" нужен объект "byTeam"`);
    if (typeof fallback !== 'string') throw new Error(`${where}: у окраски "team" нужен строковый "fallback"`);
    const byTeam: Record<string, string> = {};
    for (const [team, color] of Object.entries(byTeamValue)) {
      if (typeof color !== 'string') throw new Error(`${where}: цвет команды "${team}" должен быть строкой`);
      byTeam[team] = color;
    }
    return { mode, byTeam, fallback };
  }
  throw new Error(`${where}: неизвестный режим окраски ${JSON.stringify(mode)}`);
}

function specFrom(value: HudJsonValue | undefined, where: string): MinimapMarkerSpec {
  if (!isRecord(value)) throw new Error(`${where}: запись маркера должна быть объектом`);
  const renderer = value.renderer;
  const size = value.size;
  const priority = value.priority;
  if (typeof renderer !== 'string') throw new Error(`${where}: нужно строковое имя "renderer"`);
  if (typeof size !== 'number') throw new Error(`${where}: нужен числовой "size"`);
  if (typeof priority !== 'number') throw new Error(`${where}: нужен числовой "priority"`);
  return { renderer, color: colorFrom(value.color, where), size, priority };
}

/**
 * Читает таблицу маркеров из параметра композиции. Сегодня композицию собирает
 * типизированный TS и проверка — страховка формы; с переездом композиции на
 * JSON-документ (HUD-4) она становится входной границей и падает громко, с
 * именем записи. Ошибка здесь — ошибка КОНФИГУРАЦИИ таблицы; неизвестный вид
 * сущности в рантайме ошибкой не бывает (HUD-6, политика `unknownKind`).
 */
export function markerTableFromParams(value: HudJsonValue | undefined): MinimapMarkerTable {
  if (!isRecord(value)) {
    throw new Error('миникарта: параметр "markers" обязателен и должен быть таблицей маркеров (HUD-6)');
  }
  const markersValue = value.markers;
  if (!isRecord(markersValue)) {
    throw new Error('миникарта: поле "markers" таблицы должно быть объектом «тип → запись» (HUD-6)');
  }
  const markers: Record<string, MinimapMarkerSpec> = {};
  for (const [kind, spec] of Object.entries(markersValue)) {
    markers[kind] = specFrom(spec, `таблица маркеров, тип "${kind}"`);
  }
  const unknownValue = value.unknownKind;
  if (!isRecord(unknownValue)) {
    throw new Error('миникарта: таблица маркеров обязана объявлять политику "unknownKind" (HUD-6)');
  }
  const policy = unknownValue.policy;
  if (policy === 'skip') return { markers, unknownKind: { policy } };
  if (policy === 'default') {
    return {
      markers,
      unknownKind: { policy, marker: specFrom(unknownValue.marker, 'политика unknownKind') },
    };
  }
  throw new Error(`миникарта: неизвестная политика unknownKind ${JSON.stringify(policy)} (HUD-6)`);
}
