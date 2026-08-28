/**
 * Общие примитивы разбора data-driven документов модуля ассетов: словарь типов
 * для находки, распознавание записи и конечного числа, закрытый состав ключей,
 * форма цвета и причина исключения текстом.
 *
 * Живут в одном месте, потому что документов у модуля много — манифест визуалов
 * (ASSET-6) и блок света его записи (ASSET-16), парный presentation-документ и
 * его секции (`presentation-scene` PRES-2), эмиттерный ассет (ASSET-14), карта
 * кривизны (ASSET-7), таблица цвета (REND-34), — а язык находок у них ОДИН:
 * разошедшиеся тексты читаются автором как разные форматы, хотя формат один.
 *
 * Границы те же, что у каждого из документов: здесь проверяется ФОРМА данных, а
 * не политика картинки — сами умолчания живут у подсистем рендера.
 */

/** Ответ «получено что-то не то» — одним словарём на все документы модуля. */
export function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

/** Запись документа: объект, но не массив и не `null`. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Число документа: только конечное — `NaN` и бесконечности прочтения не имеют. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Ключ, которого формат не знает, — ошибка с перечнем допустимых соседей.
 * В data-driven документе неизвестное поле почти всегда опечатка автора, и
 * молчаливый игнор прячет её до самого кадра.
 */
export function closedKeys(
  node: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  errors: string[],
): void {
  for (const key of Object.keys(node)) {
    if (keys.includes(key)) continue;
    errors.push(`${path}.${key}: неизвестное поле (допустимы: ${keys.join(', ')})`);
  }
}

/**
 * Цвет в документе — `#rrggbb`: одна форма записи на все документы модуля,
 * чтобы дифф правки не гадал о синонимах и чтобы тон тумана, тон света секции
 * и тон локального источника читались одинаково.
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Причина исключения текстом — тем же одним способом на весь модуль. Загрузчик,
 * не сумевший разобрать файл, называет причину, а не прячет её за «не удалось»:
 * сообщение уходит в состояние `failed` ассета (ASSET-4), и по нему автор
 * правит файл.
 */
export function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Разбор JSON-документа ассета из байтов файла (ASSET-3). Одно место на все
 * документные загрузчики модуля: `what` — как документ называется в отказе
 * («манифест», «карта кривизны»), и текст отказа у всех один — иначе автор
 * читал бы одну и ту же поломку как разные форматы.
 */
export function parseAssetJson(bytes: ArrayBuffer, what: string, id: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`${what} "${id}": некорректный JSON — ${reasonOf(e)}`);
  }
}

/**
 * Находки документа перечнем — одна форма списка на все отказы модуля. Сам
 * глагол отказа остаётся у вызывающего: «карта не прошлА», «манифест не
 * прошЁЛ» — согласование живёт там, где живёт имя документа.
 */
export function findingsList(errors: readonly string[]): string {
  return `\n- ${errors.join('\n- ')}`;
}
