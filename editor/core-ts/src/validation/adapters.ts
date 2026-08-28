/**
 * Переходники от валидаторов движка к структурному результату (ED-30).
 *
 * Правило редактора не проверяет данные само — оно зовёт того, чьё это правило
 * (ED-1). Отсюда ровно две формы, в которых валидаторы движка отвечают, и по
 * переходнику на каждую:
 *
 * 1. Бросок на первом нарушении: так устроены `loadScene`, `createTerrainGrid`,
 *    `validateSystem`. Адреса в документе такой ответ не содержит вовсе, и
 *    вытащить его можно только разбором прозы сообщения. Разбор здесь не
 *    делается: формулировки принадлежат чужому модулю, и переписывание текста
 *    там молча ломало бы адресацию здесь. Находка получает путь, который дало
 *    само правило (обычно — корень документа), а сообщение доезжает дословно.
 * 2. Список строк «путь: текст», собранный не-fail-fast: так устроены
 *    `validateManifest` и `validateCurvatureMap`. Здесь адрес в сообщении есть,
 *    и терять его жалко — ED-30 требует именно пути в документе.
 *
 * Про второй случай стоит сказать прямо, потому что решение спорное. Разбирать
 * собственный текстовый продукт обратно — плохая практика; правильное решение
 * — чтобы валидатор возвращал путь структурой, и это записано как работа для
 * пакета ассетов. Пока он возвращает строки, здесь применяется разбор с
 * проверкой: адрес из сообщения не принимается на веру, а прикладывается к
 * документу шаг за шагом, и в находку попадает только та часть, которая в
 * документе действительно есть. Ошибка разбора в этой схеме даёт путь короче
 * настоящего (в пределе — корень документа), но никогда не даёт пути в чужое
 * место: находка либо адресует точно, либо адресует шире, и потребитель
 * доопределяет её по дословному сообщению.
 */
import { getAtPath, type JsonPath, type JsonValue } from '../document/index.js';
import type { ReasonParams, ValidationRun } from './types.js';

/**
 * Ответ валидатора, собирающего все нарушения разом.
 *
 * `warnings` необязательны: их сообщает не всякий валидатор (`validateCurvatureMap`
 * — нет, `validateManifest` — да, ASSET-8), а «нарушение есть, но документ
 * валиден» иначе не выразить. Приходят они и в удачной ветке — именно там они и
 * бывают чаще всего.
 */
export type ErrorListResult =
  | { readonly ok: true; readonly warnings?: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings?: readonly string[] };

export interface AdapterOptions {
  /** Кто проверял: `пакет:функция`. Уезжает в ожидание находки. */
  readonly by: string;
  /** Код причины; по умолчанию `rejected`. */
  readonly code?: string;
  /** Путь, от которого отсчитывается адрес; по умолчанию — корень документа. */
  readonly base?: JsonPath;
  readonly params?: ReasonParams;
}

/**
 * Код причины обоих переходников: «чужой валидатор отверг». Константа, а не
 * литерал в двух местах, потому что то же значение объявляет правило в
 * `reasonCodes` — набранное там заново, оно разошлось бы с сообщаемым молча.
 */
export const REJECTED = 'rejected';

const EMPTY_PATH: JsonPath = Object.freeze([]);

/**
 * Зовёт валидатор, бросающий на первом нарушении, и превращает бросок в
 * находку. Возвращает `true`, если валидатор принял данные, — вызывающему это
 * нужно, чтобы не продолжать проверку по заведомо негодным данным.
 */
export function reportThrown(run: ValidationRun, options: AdapterOptions, body: () => void): boolean {
  try {
    body();
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    run.report({
      path: options.base ?? EMPTY_PATH,
      expected: { kind: 'accepted', by: options.by, detail },
      code: options.code ?? REJECTED,
      params: { ...options.params, by: options.by, detail },
    });
    return false;
  }
}

/**
 * Превращает список сообщений «путь: текст» в находки — по одной на сообщение.
 * Ни одно сообщение не теряется и не склеивается: не-fail-fast валидатор
 * отвечает всеми нарушениями разом именно затем, чтобы автор чинил их за один
 * проход, а свод их в одну находку вернул бы его к «исправил — узнал про
 * следующее».
 */
export function reportErrorList(run: ValidationRun, options: AdapterOptions, result: ErrorListResult): boolean {
  const base = options.base ?? EMPTY_PATH;
  const value = run.valueOf(run.document.id);
  const root = base.length === 0 ? value : value === undefined ? undefined : getAtPath(value, base);
  const report = (message: string, severity: 'error' | 'warning'): void => {
    run.report({
      path: [...base, ...probePath(root, message)],
      expected: { kind: 'accepted', by: options.by, detail: message },
      code: options.code ?? REJECTED,
      params: { ...options.params, by: options.by, detail: message },
      severity,
    });
  };
  // Предупреждения разбираются тем же разбором адреса и отличаются от ошибок
  // ровно важностью: то, что чужой валидатор переживает (пропуск записи), автор
  // видит, но сохранению это не мешает (ED-3).
  for (const message of result.warnings ?? []) report(message, 'warning');
  if (result.ok) return true;
  for (const message of result.errors) report(message, 'error');
  return false;
}

/**
 * Адрес из сообщения, проверенный по документу. Возвращается самый длинный
 * префикс разобранного пути, который в документе есть; всё, что не сошлось,
 * отбрасывается вместе с остатком.
 */
export function probePath(root: JsonValue | undefined, message: string): JsonPath {
  const steps = parseAddress(message);
  const found: (string | number)[] = [];
  let node: JsonValue | undefined = root;
  for (const step of steps) {
    if (node === undefined) break;
    const next = getAtPath(node, [step]);
    if (next === undefined) break;
    found.push(step);
    node = next;
  }
  return Object.freeze(found);
}

/**
 * Символы, на которых адрес заведомо кончился: сообщение продолжается прозой.
 * Пробел в их числе — ключа с пробелом разбор не увидит, и это осознанный
 * размен: такой ключ встречается реже, чем проза после адреса.
 */
const STOP = new Set([' ', '\t', ',', ';', '"', "'", '(', ')', ':', '=', '»', '«']);

/**
 * Индекс списка `[N]`, начинающийся на `at`. `undefined` — на этом месте адреса
 * нет, разбор кончился.
 *
 * Символ берётся `charAt`, а не индексом: за пределами строки он даёт пустую
 * строку, которая ни одной из проверок не проходит, — то же самое, что даёт
 * `undefined` индексного доступа, но без утверждения о непустоте.
 */
function readIndex(head: string, at: number): { readonly step: number; readonly next: number } | undefined {
  let cursor = at + 1;
  let digits = '';
  while (cursor < head.length && head.charAt(cursor) >= '0' && head.charAt(cursor) <= '9') {
    digits += head.charAt(cursor);
    cursor++;
  }
  if (digits === '' || head.charAt(cursor) !== ']') return undefined;
  return { step: Number(digits), next: cursor + 1 };
}

/**
 * Имя поля, начинающееся на `at`. `undefined` — имени нет, разбор кончился;
 * `stop` — имя упёрлось в символ, за которым идёт проза сообщения.
 */
function readName(
  head: string,
  at: number,
): { readonly step: string; readonly next: number; readonly stop: boolean } | undefined {
  let cursor = at;
  let name = '';
  while (
    cursor < head.length &&
    head.charAt(cursor) !== '.' &&
    head.charAt(cursor) !== '[' &&
    !STOP.has(head.charAt(cursor))
  ) {
    name += head.charAt(cursor);
    cursor++;
  }
  if (name === '') return undefined;
  return { step: name, next: cursor, stop: cursor < head.length && STOP.has(head.charAt(cursor)) };
}

function parseAddress(message: string): readonly (string | number)[] {
  const head = message.split(':')[0] ?? '';
  const steps: (string | number)[] = [];
  let at = 0;
  while (at < head.length) {
    const char = head.charAt(at);
    if (char === '.') {
      at++;
      continue;
    }
    if (char === '[') {
      const index = readIndex(head, at);
      if (index === undefined) break;
      steps.push(index.step);
      at = index.next;
      continue;
    }
    const name = readName(head, at);
    if (name === undefined) break;
    steps.push(name.step);
    at = name.next;
    if (name.stop) break;
  }
  return steps;
}
