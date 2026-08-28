/**
 * @contribution
 *
 * Сборка узла действия и узла выражения из заполненных слотов — то, что
 * блочный редактор кладёт в документ.
 *
 * Функции чистые: они возвращают JSON, а пишет его операция через сессию
 * (ED-29). Записывать отсюда нечего и незачем — иначе рядом со слоем операций
 * завёлся бы второй путь правки, у которого нет ни отмены, ни истории.
 *
 * Два правила, и оба — форма, а не семантика:
 *
 * 1. **Ровно один ключ** (ACT-1, EXPR-1). Это единственная проверка, которую
 *    сборщик делает сам, и она структурная: узел без имени — не узел. Годно ли
 *    имя, решает ядро (`checkAction`: «неизвестное действие»), а не сборщик.
 * 2. **Незаполненный слот не пишется.** Слоты предлагаются по конвенции SYS-3,
 *    а не по персональному набору аргументов действия (см. `slots.ts`), поэтому
 *    среди них бывают бессмысленные для выбранного действия. В документ уходит
 *    только то, что автор заполнил, — лишний слот стоит ноль байт и ноль
 *    находок.
 *
 * Незаполненным считается `undefined`, и только он. Пустая строка, пустой
 * список и пустая карта — это значения, которые автор задал: `{ "do": [] }`
 * отличается от действия без тела, и решать за автора, что он имел в виду,
 * сборщик не вправе. Область, у которой поле пусто, подаёт `undefined`.
 *
 * Порядок ключей — порядок конвенции (`CONVENTION_SLOTS`), затем аргументы вне
 * конвенции в том порядке, в каком их подали. Не порядок заполнения: два
 * автора, собравшие один и тот же блок, обязаны получить один и тот же JSON,
 * иначе дифф покажет перестановку там, где правки не было (ED-21). Правка уже
 * существующего узла узел не пересобирает — она адресуется путём и идёт
 * `document.setValue`, поэтому чужой порядок ключей этим не тревожится.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../document/json.js';
import { CONVENTION_SLOTS } from './slots.js';

/** Слоты блока: имя аргумента → значение; `undefined` — слот не заполнен. */
export type SlotValues = Readonly<Record<string, JsonValue | undefined>>;

export interface ActionDraft {
  /** Имя действия из закрытого набора ядра (`actionNames`). */
  readonly name: string;
  readonly slots?: SlotValues;
}

function requireName(name: string, kind: string): void {
  // Не проверка имени, а проверка того, что имя есть: `{ "": {} }` — узел, у
  // которого нет ключа-имени, и ядро о нём скажет «неизвестное действие»,
  // спрятав настоящую причину — пустой блок.
  if (typeof name !== 'string' || name === '') throw new Error(`${kind}: имя пусто — узел собрать не из чего`);
}

/**
 * Ключи в порядке конвенции; всё, чего конвенция не знает, — следом, как подали.
 *
 * Экспортируется потому, что тем же порядком блочный редактор показывает слоты
 * уже собранного узла: порядок слотов — правило конвенции SYS-3, и второй его
 * реализации в интерфейсе быть не должно (ED-1).
 */
export function orderedSlotNames(slots: SlotValues): readonly string[] {
  const given = Object.keys(slots);
  const known = CONVENTION_SLOTS.map((slot) => slot.name).filter((name) => given.includes(name));
  return [...known, ...given.filter((name) => !known.includes(name))];
}

/**
 * Узел действия: `{ имя: { аргументы } }`. Действие без единого заполненного
 * слота законно и собирается в `{ имя: {} }` — так выглядит блок, который автор
 * только что поставил и ещё не заполнил; валидацию SYS-3 он проходит, а падает
 * во время вычисления, и это нормировано (SYS-3).
 */
export function buildAction(draft: ActionDraft): JsonObject {
  requireName(draft.name, 'действие');
  const slots = draft.slots ?? {};
  const args: Record<string, JsonValue> = {};
  for (const name of orderedSlotNames(slots)) {
    const value = slots[name];
    if (value !== undefined) args[name] = value;
  }
  return Object.freeze({ [draft.name]: Object.freeze(args) });
}

/**
 * Узел выражения: `{ оператор: [аргументы] }`.
 *
 * Список пишется списком всегда, в том числе из одного аргумента. Ядро читает
 * обе формы одинаково (`Array.isArray(raw) ? raw : [raw]`), и краткая форма —
 * его удобство для JSON, написанного руками, а не второе значение узла. У
 * генератора причины выбирать между ними нет, а правило «всегда список» —
 * одно и не требует таблицы «какому оператору какая форма идёт», то есть того
 * самого дубля семантики, которого не должно быть (ED-1).
 */
export function buildExpression(operator: string, args: readonly JsonValue[] = []): JsonObject {
  requireName(operator, 'выражение');
  return Object.freeze({ [operator]: Object.freeze([...args]) });
}

/**
 * Единственная пара «ключ — значение» узла DSL. Узел действия и узел выражения
 * устроены одинаково — объект с ОДНИМ ключом (ACT-1, EXPR-1), — и `undefined`
 * здесь означает «это не узел» для обоих разборов сразу.
 */
function singleEntry(node: JsonValue): readonly [string, JsonValue] | undefined {
  if (!isJsonObject(node)) return undefined;
  const entries = Object.entries(node);
  return entries.length === 1 ? entries[0] : undefined;
}

/**
 * Имя действия узла и его аргументы — обратный разбор той же формы. Нужен
 * блочному редактору, чтобы показать уже записанный узел: `undefined` означает
 * «это не узел действия», и сказать о нём что-то ещё — дело ядра, а не разбора.
 */
export function readActionNode(node: JsonValue): { readonly name: string; readonly args: JsonObject } | undefined {
  const entry = singleEntry(node);
  if (entry === undefined) return undefined;
  const [name, args] = entry;
  return { name, args: isJsonObject(args) ? args : {} };
}

/**
 * Оператор узла и его аргументы. Краткая форма разворачивается в список тем же
 * правилом, каким её разворачивает ядро, — иначе редактор показал бы
 * `{ "var": "e" }` узлом без аргументов.
 */
export function readExpressionNode(
  node: JsonValue,
): { readonly operator: string; readonly args: readonly JsonValue[] } | undefined {
  const entry = singleEntry(node);
  if (entry === undefined) return undefined;
  const [operator, raw] = entry;
  return { operator, args: Array.isArray(raw) ? raw : [raw] };
}
