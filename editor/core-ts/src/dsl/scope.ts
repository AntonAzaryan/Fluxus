/**
 * @contribution
 *
 * Какие имена связаны в этом месте тела системы — то, что пикер слота `var`
 * предлагает автору.
 *
 * Правило связывания нормативно (SYS-3) и повторяется здесь ровно в том объёме,
 * в каком его исполняет `checkAction`:
 *
 * - имена, введённые действием (`as` и ключи `bindings`), видны только его телу
 *   — слотам `do`/`then`/`else`;
 * - `bindings` при этом вычисляются во ВНЕШНЕЙ области (параллельное
 *   связывание, ACT-1), поэтому внутри самой карты биндингов их имена ещё не
 *   видны;
 * - система с `query` разворачивается в `forEach`, и её `as` (по умолчанию
 *   `entity`) виден телу `do`, но не самому запросу.
 *
 * Почему это законно, хотя ED-1 запрещает вторую реализацию правил DSL: здесь
 * не выносится вердикт. Область видимости считается ради ПОДСКАЗКИ, и ошибка
 * подсказки не проходит молча — `var` с несвязанным именем отвергает
 * `checkExpression` («переменная "x" не связана»), то есть находкой ядра на
 * своей записи (ED-8). Обратная ошибка — имя связано, а пикер его не предложил
 * — стоит автору лишнего ввода, но не корректности документа. Это и есть
 * «аффорданс может быть производным, вердикт всегда за ядром».
 */
import { isJsonArray, isJsonObject, type JsonPath, type JsonValue } from '../document/json.js';
import { BINDING_SLOT, BINDINGS_SLOT, BODY_SLOTS, DEFAULT_ITERATION_NAME } from './slots.js';

/** Накопитель имён: порядок объявления, без повторов. */
interface Names {
  readonly list: string[];
  readonly seen: Set<string>;
}

function add(names: Names, value: JsonValue | undefined): void {
  if (typeof value !== 'string' || value === '' || names.seen.has(value)) return;
  names.seen.add(value);
  names.list.push(value);
}

/**
 * Спуск по списку действий: `path[at]` — индекс записи, `path[at + 1]` — имя
 * действия, `path[at + 2]` — имя его аргумента. Та же тройка шагов, которой
 * узел действия адресуется в документе (`do[0].if.then`).
 */
function descend(list: JsonValue, path: JsonPath, at: number, names: Names): void {
  if (!isJsonArray(list)) return;
  const index = path[at];
  if (typeof index !== 'number') return;
  const node = list[index];
  if (!isJsonObject(node)) return;
  const action = path[at + 1];
  if (typeof action !== 'string') return;
  const args = node[action];
  if (!isJsonObject(args)) return;
  const slot = path[at + 2];
  if (typeof slot !== 'string' || !BODY_SLOTS.includes(slot)) return;

  // Имена этого действия видны его телу — и только начиная отсюда.
  add(names, args[BINDING_SLOT]);
  const bindings = args[BINDINGS_SLOT];
  if (isJsonObject(bindings)) for (const key of Object.keys(bindings)) add(names, key);

  const body = args[slot];
  if (body !== undefined) descend(body, path, at + 3, names);
}

/**
 * Имена, связанные в точке `path` внутри записи системы (SYS-1). Путь — тот же
 * адрес, каким узел адресуется в документе-носителе и в находке валидации,
 * только относительно самой записи: `['do', 0, 'if', 'then', 1]`.
 *
 * `outer` — имена, связанные снаружи; сегодня это параметр `bound` самого
 * `validateSystem`, который пуст и ждёт входных параметров систем (этап 9).
 *
 * Порядок — от внешнего к внутреннему: пикер показывает `entity` перед именем
 * ближайшего `let`, а не по алфавиту. Порядок — представление, а не семантика:
 * ядро держит область видимости множеством.
 */
export function boundNamesAt(
  system: JsonValue,
  path: JsonPath,
  outer: readonly string[] = [],
): readonly string[] {
  const names: Names = { list: [], seen: new Set<string>() };
  for (const name of outer) add(names, name);
  if (!isJsonObject(system)) return Object.freeze(names.list);

  const body = system['do'];
  if (path[0] === 'do' && body !== undefined) {
    // Сахар `query` (SYS-1): тело системы с запросом — тело развёрнутого
    // `forEach`, и его переменная итерации связана так же, как у действия.
    if (system['query'] !== undefined) {
      const as = system[BINDING_SLOT];
      add(names, typeof as === 'string' ? as : DEFAULT_ITERATION_NAME);
    }
    descend(body, path, 1, names);
  }
  return Object.freeze(names.list);
}
