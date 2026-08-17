/**
 * Референс-профиль устройства (`performance-budget` PERF-1): формат и проверка
 * формы.
 *
 * Профиль — ДАННЫЕ: имя, класс устройства, человеческое описание и числа
 * бюджетов по перцентилям. Числа в код не переезжают и в требования не
 * пишутся — появление нового целевого устройства (планшет, средний мобильный)
 * означает новый файл в `bench/profiles/`, а не правку кода замера и не правку
 * спеки (PERF-1, сценарий «Новый класс устройства»).
 *
 * Ключи бюджетов — `frame` (весь кадр) плюс стадии PERF-2, и список стадий
 * берётся у probe (`app/benchProbe.ts`), а не пишется здесь второй раз:
 * разойдись эти два списка, и опечатка в имени стадии стоила бы ровно того
 * бюджета, ради которого профиль заводился.
 *
 * Проверка формы живёт здесь, а зовёт её тот, кто профиль загружает
 * (`bin/bench-demo.mjs`): битый профиль обязан назвать себя списком причин до
 * запуска браузера, а не молча пропустить половину бюджетов.
 */
import { BENCH_STAGES, type BenchStage, type BenchPercentiles, type BenchSummary } from '../app/benchProbe.js';

/** Ключ бюджета: кадр целиком либо одна из стадий конвейера (PERF-2). */
export const BENCH_BUDGET_KEYS = ['frame', ...BENCH_STAGES] as const;

export type BenchBudgetKey = (typeof BENCH_BUDGET_KEYS)[number];

/** Бюджет одной величины в миллисекундах: минимум p50 и p99 (PERF-1). */
export interface BenchBudget {
  readonly p50: number;
  readonly p99: number;
}

export interface BenchProfile {
  /** Имя профиля — оно же имя файла в `bench/profiles/`. */
  readonly name: string;
  /** Класс устройства: `desktop`, `mobile`, `tablet` — что именно, решает автор профиля. */
  readonly deviceClass: string;
  /** Человеческое описание: чем меряли и что считается этой машиной. */
  readonly description: string;
  /**
   * Бюджеты. `frame` обязателен — он и есть продуктовая цель (60 fps ⇒ ~16.6 мс
   * по p99); бюджеты стадий необязательны: профиль вправе держать потолок
   * только на кадре, и незаявленная стадия печатается замером без вердикта.
   */
  readonly budgetsMs: { readonly frame: BenchBudget } & Readonly<
    Partial<Record<BenchStage, BenchBudget>>
  >;
}

export type BenchProfileResult =
  | { readonly ok: true; readonly profile: BenchProfile }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Непустая строка — поля профиля, по которым его узнаёт человек. */
function textField(raw: Record<string, unknown>, field: string, errors: string[]): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`поле "${field}": ожидалась непустая строка`);
    return '';
  }
  return value;
}

/**
 * Одна пара перцентилей. Требования к числам ровно три, и каждое ловит свою
 * ошибку: конечность (опечатка `"16.6 мс"` строкой), положительность (нулевой
 * бюджет не сходится никогда) и `p50 <= p99` (переставленные местами
 * перцентили дали бы вердикт наоборот).
 */
function budgetField(raw: unknown, where: string, errors: string[]): BenchBudget | null {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`бюджет "${where}": ожидался объект с p50 и p99`);
    return null;
  }
  const record = raw as Record<string, unknown>;
  const values: number[] = [];
  for (const key of ['p50', 'p99'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(`бюджет "${where}", ${key}: ожидалось положительное число миллисекунд`);
      values.push(Number.NaN);
      continue;
    }
    values.push(value);
  }
  const [p50, p99] = values as [number, number];
  if (Number.isNaN(p50) || Number.isNaN(p99)) return null;
  if (p50 > p99) {
    errors.push(`бюджет "${where}": p50 (${p50}) больше p99 (${p99}) — перцентили переставлены`);
    return null;
  }
  return { p50, p99 };
}

/**
 * Проверка формы профиля. Возвращает либо профиль, либо ВСЕ причины отказа
 * разом: чинить битый файл по одной ошибке за прогон — худший из способов.
 */
export function validateBenchProfile(raw: unknown, source: string): BenchProfileResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [`профиль "${source}": ожидался объект`] };
  }
  const record = raw as Record<string, unknown>;
  const name = textField(record, 'name', errors);
  const deviceClass = textField(record, 'deviceClass', errors);
  const description = textField(record, 'description', errors);

  const budgets = record.budgetsMs;
  const parsed: Partial<Record<BenchBudgetKey, BenchBudget>> = {};
  if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) {
    errors.push('поле "budgetsMs": ожидался объект бюджетов');
  } else {
    for (const [key, value] of Object.entries(budgets)) {
      // Неизвестный ключ — ошибка, а не лишнее поле: опечатка в имени стадии
      // иначе означала бы бюджет, который никогда ни с чем не сверяется.
      if (!(BENCH_BUDGET_KEYS as readonly string[]).includes(key)) {
        errors.push(
          `бюджет "${key}" неизвестен; известные: ${BENCH_BUDGET_KEYS.join(', ')}`,
        );
        continue;
      }
      const budget = budgetField(value, key, errors);
      if (budget !== null) parsed[key as BenchBudgetKey] = budget;
    }
    if (parsed.frame === undefined && !errors.some((line) => line.includes('"frame"'))) {
      errors.push('бюджет "frame" обязателен: это и есть продуктовая цель по кадру (PERF-1)');
    }
  }

  if (errors.length > 0) return { ok: false, errors: errors.map((line) => `${source}: ${line}`) };
  return {
    ok: true,
    profile: {
      name,
      deviceClass,
      description,
      budgetsMs: parsed as BenchProfile['budgetsMs'],
    },
  };
}

/** Строка отчёта: измеренное против бюджета, с вердиктом по каждому перцентилю. */
export interface BenchVerdictLine {
  readonly key: BenchBudgetKey;
  readonly measured: BenchPercentiles;
  /** null — профиль этой стадии бюджета не назначал: печатаем замер без вердикта. */
  readonly budget: BenchBudget | null;
  readonly p50Fits: boolean;
  readonly p99Fits: boolean;
}

/** Сходится ли строка целиком: незаявленный бюджет не проваливается никогда. */
export function benchLineFits(line: BenchVerdictLine): boolean {
  return line.p50Fits && line.p99Fits;
}

/**
 * Держится ли ТЕМП: p99 периода кадра против того же бюджета `frame`.
 *
 * Отдельная величина рядом со стоимостью кадра, и обе нужны. Стоимость кадра —
 * это работа, которую делает главный поток, и по ней атрибутируется регрессия
 * (PERF-2). Период — то, что видит игрок: главный поток может уложиться в
 * миллисекунды и всё равно ждать GPU или vsync, и «60 fps» — утверждение
 * именно о периоде (PERF-1).
 */
export function benchPaceFits(profile: BenchProfile, summary: BenchSummary): boolean {
  return summary.intervalMs.p99 <= profile.budgetsMs.frame.p99;
}

/**
 * Замер против профиля (PERF-7): по строке на кадр и на каждую стадию, в том
 * же порядке, в каком стадии идут в кадре. Сравнение — простое «не больше
 * бюджета»: вердикт обязан читаться без интерпретации сырых чисел.
 */
export function benchVerdict(
  profile: BenchProfile,
  summary: BenchSummary,
): readonly BenchVerdictLine[] {
  const lines: BenchVerdictLine[] = [];
  for (const key of BENCH_BUDGET_KEYS) {
    const measured = key === 'frame' ? summary.frameMs : summary.stagesMs[key];
    const budget = profile.budgetsMs[key] ?? null;
    lines.push({
      key,
      measured,
      budget,
      p50Fits: budget === null || measured.p50 <= budget.p50,
      p99Fits: budget === null || measured.p99 <= budget.p99,
    });
  }
  return lines;
}
