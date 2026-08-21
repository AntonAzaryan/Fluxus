/**
 * Дамп кадра — машинно-читаемая грань пробы (`render-debug` RDBG-7).
 *
 * ## Что дамп такое
 *
 * Структурное описание состояния ВКЛЮЧЁННЫХ источников, пригодное для
 * headless-разбора: версия формата, номер доставленного тика, режим мира и
 * секции по `id`. Секции выключенного источника в дампе НЕТ — «выключено» и
 * «данных нет» обязаны различаться так же, как различаются отсутствующий стат и
 * стат, равный нулю (`match-hud` HUD-8).
 *
 * ## Три границы, которые держит сборка, а не дисциплина источника
 *
 * - **Плоские данные.** Значение, которого не выражает JSON (Map, Set, класс,
 *   функция, типизированный массив), отвергается адресно — с путём поля.
 *   Проверка держит ВИД значения, а не его происхождение: обычный массив и
 *   обычный объект копируются молча, и живой массив рендера, положенный в пробу
 *   ссылкой, эту проверку прошёл бы. Самодостаточность пробы (RDBG-2) — правило
 *   источника, и стережёт его тест «проба пережила доставку», а не сборка дампа;
 *   здесь же гарантируется, что снятый дамп не изменится задним числом: он
 *   копия, а не вид на пробу.
 * - **Растры не едут.** Растровая плашка (RDBG-3) сериализуется описанием:
 *   разрешение, прямоугольник и ЧИСЛО текселей вместо десятков тысяч значений
 *   (RDBG-7, сценарий «Маска не едет растром»).
 * - **Часовые величины отдельно.** Поле `clock` пробы поднимается в секцию
 *   `clock` дампа под именем `<id>.<поле>`: альфа интерполяции (SHELL-7),
 *   частота кадров и сглаженные оценки каденса невоспроизводимы по определению,
 *   и смешанные с остальными они превратили бы всякий дифф в шум.
 *
 * ## Воспроизводимость
 *
 * Дамп — чистая функция от (состояние кадра, набор включённых источников):
 * два дампа на одном входе совпадают, кроме секции часовых величин. Назначение
 * то же, ради которого детерминирован трейс ядра (`diagnostics` DIAG-6): дампы
 * сравнимы построчно, и расхождение локализуется, а не обсуждается.
 */
import type { DebugProbe, DebugRaster, DebugWorldMode } from './contract.js';

/** Версия формата дампа: потребитель сверяет её, прежде чем читать поля. */
export const DEBUG_DUMP_VERSION = 1;

/**
 * Дамп кадра. Единицы названы в именах полей (мировые единицы, тики, тексели,
 * радианы): читатель — человек и модель, а не отладчик с исходником под рукой.
 */
export interface DebugDump {
  readonly version: number;
  /** Номер последнего доставленного тика; -1 — доставок ещё не было. */
  readonly tick: number;
  readonly mode: DebugWorldMode;
  /** Включённые источники по `id`, в порядке регистрации. */
  readonly enabled: readonly string[];
  /**
   * Величины, выведенные из часов главного потока (RDBG-7). Невоспроизводимы, и
   * потому названы отдельно: ключ — `<id источника>.<поле>` либо `frame.<поле>`
   * у величин самого кадра.
   */
  readonly clock: Readonly<Record<string, number>>;
  /** Секции по `id` источников; выключенного источника здесь нет вовсе. */
  readonly sections: Readonly<Record<string, unknown>>;
}

/** Растровое поле пробы в дампе: описание вместо текселей (RDBG-7). */
interface DumpedRaster {
  readonly raster: true;
  readonly widthTexels: number;
  readonly heightTexels: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly worldZ: number;
  /** Тексели опущены намеренно (RDBG-7); их число — вся оставшаяся правда о растре. */
  readonly texelsOmitted: number;
}

function isRaster(value: object): value is DebugRaster {
  return (value as { raster?: unknown }).raster === true;
}

function dumpRaster(raster: DebugRaster): DumpedRaster {
  return {
    raster: true,
    widthTexels: raster.widthTexels,
    heightTexels: raster.heightTexels,
    worldX: raster.worldX,
    worldY: raster.worldY,
    worldWidth: raster.worldWidth,
    worldHeight: raster.worldHeight,
    worldZ: raster.worldZ,
    texelsOmitted: raster.texels.length,
  };
}

/** Как значение названо в отказе: важен вид, а не содержимое. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'массив';
  if (ArrayBuffer.isView(value)) return 'типизированный массив';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (typeof value === 'object') {
    const name = (value).constructor.name;
    return name === 'Object' ? 'объект' : `экземпляр ${name}`;
  }
  return typeof value;
}

/**
 * Копия значения пробы в плоскую JSON-форму. Копия, а не ссылка: проба
 * ПЕРЕИСПОЛЬЗУЕТСЯ между кадрами (RDBG-2), и дамп, державший её ссылкой,
 * менялся бы задним числом от следующей доставки.
 *
 * Отказ адресный — с путём поля: «в дампе что-то не то» на десятке секций не
 * ищется.
 */
function copyValue(value: unknown, path: string): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number' || type === 'string' || type === 'boolean') return value;
  if (type === 'undefined') return undefined;
  if (type !== 'object') {
    throw new Error(refusal(path, kindOf(value)));
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => copyValue(item, `${path}[${index}]`));
  }
  if (isRaster(value as object)) return dumpRaster(value as DebugRaster);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(refusal(path, kindOf(value)));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const copied = copyValue(item, `${path}.${key}`);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

function refusal(path: string, kind: string): string {
  return (
    `дамп отладки: поле "${path}" несёт ${kind} — проба обязана быть самодостаточными ` +
    'плоскими данными (RDBG-2), ссылку на живую структуру рендера дамп не сериализует'
  );
}

/** Секция одного источника: проба без часовых величин (они уезжают в `clock`). */
export function dumpSection(id: string, probe: DebugProbe): unknown {
  const section: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(probe)) {
    if (key === 'clock') continue;
    const copied = copyValue(value, `${id}.${key}`);
    if (copied !== undefined) section[key] = copied;
  }
  return section;
}

/** Часовые величины пробы под именем `<id>.<поле>` (RDBG-7). */
export function dumpClock(id: string, probe: DebugProbe, out: Record<string, number>): void {
  const clock = probe.clock;
  if (clock === undefined) return;
  for (const [key, value] of Object.entries(clock)) out[`${id}.${key}`] = value;
}
