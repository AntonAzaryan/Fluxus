/**
 * Панель отладочных источников демо (`render-debug` RDBG-1, design D10) и
 * версионированная ручка дампа на `globalThis`.
 *
 * ## Почему это DOM приложения, а не виджет HUD
 *
 * Панель — НАСТРОЙКА СТРАНИЦЫ, как переключатель качества картинки рядом с ней
 * (`render-quality` design D4), а не действие внутри матча: композиция HUD
 * описывает то, что живёт в матче (HUD-2, HUD-4), и отладке там места нет.
 * Заодно так держится «в пакете рендера DOM не появляется» (REND-19): текстовая
 * часть инспектора печатается ЗДЕСЬ, из дампа, а в кадре рисуются только
 * примитивы (RDBG-3).
 *
 * ## Список строится из реестра
 *
 * Строки панели — то, что зарегистрировано в слое (RDBG-1), сгруппированное по
 * владельцу `id`. Новый источник появляется в панели сам: ни разметка страницы,
 * ни этот файл его не перечисляют. Выбор переживает перезагрузку через
 * localStorage — тем же способом, что выбор пресета качества, и незнакомый
 * сохранённый `id` игнорируется молча (реестр про него отвечает `false`).
 *
 * ## Текст панели собирается не каждым кадром
 *
 * Дамп снимается ПО ЗАПРОСУ (RDBG-7), и запрос здесь — щелчок галочки плюс
 * редкий таймер, а не кадр: покадровая сборка была бы аллокацией на кадр
 * (REND-26) ради текста, который человек всё равно читает глазами. Без единого
 * включённого источника панель не делает и этого — одно сравнение (RDBG-4).
 *
 * ## Ручка дампа
 *
 * По образцу `__benchProbe` (PERF-7): версионированное поле на `globalThis`,
 * кладёт его сборка приложения, собирает дамп рендер. CDP-харнесс и модель берут
 * дамп тем же способом, каким браузерный бенч берёт отчёт, и второй конвенции не
 * заводится.
 */
import type { DebugDump, DebugSourceInfo, RenderDebugLayer } from '@fluxus/render';
import { DEBUG_DUMP_VERSION } from '@fluxus/render';
import { qualityStorageOf, type QualityStorage } from './quality.js';

/** Имя ручки на `window`, по которому дамп забирает харнесс и модель. */
export const DEBUG_GLOBAL_KEY = '__renderDebug';

/** Ключ хранения выбранных источников; выбор переживает перезагрузку, а не матч. */
export const DEBUG_STORAGE_KEY = 'demo.debugSources';

/** Ручка отладки на `window`: всё, что внешнему потребителю нужно от страницы. */
export interface DebugGlobal {
  readonly version: number;
  /** Реестр источников: `id`, владелец, подпись и состояние переключателя. */
  sources: () => readonly DebugSourceInfo[];
  /** Включить/выключить источник; `false` — реестр такого `id` не знает. */
  setEnabled: (id: string, enabled: boolean) => boolean;
  /** Дамп кадра (RDBG-7) — по запросу, а не покадрово. */
  dump: () => DebugDump;
}

/** Носитель ручки: `window` страницы, а в тестах — обычный объект. */
export interface DebugGlobalHost {
  [DEBUG_GLOBAL_KEY]?: DebugGlobal;
}

/** Запомненный выбор источников; нет хранилища или записи — пусто. */
export function storedDebugSources(storage: QualityStorage | undefined): readonly string[] {
  if (storage === undefined) return [];
  try {
    const raw = storage.getItem(DEBUG_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // Ни отказ хранилища, ни битая запись не повод не пустить человека в матч.
    return [];
  }
}

/** Запомнить выбор. Отказ хранилища молчалив: источники уже включены. */
export function rememberDebugSources(
  storage: QualityStorage | undefined,
  ids: readonly string[],
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Пусто намеренно: не запомнить выбор — не повод ломать кадр.
  }
}

/**
 * Восстановление сохранённого выбора: незнакомый `id` — молча мимо (реестр
 * отвечает `false`), а не отказ страницы. Источник мог уехать вместе со сборкой,
 * которая его регистрировала, и это нормальная жизнь настройки.
 */
export function restoreDebugSources(layer: RenderDebugLayer, ids: readonly string[]): void {
  for (const id of ids) layer.setEnabled(id, true);
}

/**
 * Как часто панель пересобирает свой текст, миллисекунды. Дамп снимается ПО
 * ЗАПРОСУ и MUST NOT собираться каждый кадр (RDBG-7): покадровая сборка была бы
 * аллокацией на кадр (REND-26) ради текста, который человек читает глазами.
 * Четыре обновления в секунду — тот темп, на котором числа успевают читаться.
 */
const TEXT_INTERVAL_MS = 250;

export interface DebugPanelOptions {
  readonly layer: RenderDebugLayer;
  /** Контейнер панели — элемент разметки страницы рядом с выбором качества. */
  readonly container: HTMLElement;
  /** Хранилище выбора; нет — выбор не переживает перезагрузку. */
  readonly storage?: QualityStorage | undefined;
  /** Период пересборки текста; по умолчанию `TEXT_INTERVAL_MS`. */
  readonly textIntervalMs?: number;
}

export interface DebugPanel {
  /** Перестроить список и сверить галочки с реестром: источники приходят со сценой. */
  refresh(): void;
  /**
   * Кадровый вызов панели. Текст пересобирается НЕ каждый кадр: по щелчку
   * галочки — сразу, дальше не чаще периода (RDBG-7). Выключенная отладка не
   * стоит и того: без единого включённого источника здесь одно сравнение
   * (RDBG-4).
   *
   * @param nowMs — часы главного потока кадра (тот же `now`, что у rAF).
   */
  update(nowMs: number): void;
}

/** Строка панели — сама печатает своё состояние; DOM создаётся один раз. */
interface Row {
  readonly id: string;
  readonly input: HTMLInputElement;
}

/**
 * Панель переключателей и текстовый вывод дампа. Строится из реестра, а не из
 * разметки: новый источник — новая строка без правок этого файла.
 */
export function createDebugPanel(options: DebugPanelOptions): DebugPanel {
  const { layer, container } = options;
  const storage = options.storage ?? qualityStorageOf(globalThis);
  const interval = options.textIntervalMs ?? TEXT_INTERVAL_MS;
  const list = document.createElement('div');
  list.className = 'debug-panel__list';
  const text = document.createElement('pre');
  text.className = 'debug-panel__text';
  container.append(list, text);
  const rows: Row[] = [];
  /** Текст просрочен: щёлкнули галочку — пересобрать ближайшим кадром. */
  let stale = true;
  /** Когда текст собран в последний раз; NaN — ещё ни разу. */
  let textAt = Number.NaN;
  /** В `pre` что-то напечатано: по флагу, а не чтением DOM каждым кадром. */
  let printed = false;

  const remember = (): void => {
    rememberDebugSources(storage, layer.enabled);
  };

  const sync = (): void => {
    for (const row of rows) row.input.checked = layer.isEnabled(row.id);
  };

  const refresh = (): void => {
    const sources = layer.sources;
    if (sources.length === rows.length) {
      // Состав реестра прежний — но выбор мог измениться мимо панели (ручка
      // `__renderDebug`, восстановление запомненного): галочки сверяются здесь,
      // а не покадрово (RDBG-4).
      sync();
      stale = true;
      return;
    }
    list.replaceChildren();
    rows.length = 0;
    let owner = '';
    for (const source of sources) {
      // Группировка по владельцу `id` (design Risks): реестр плоский, а панель
      // читается человеком, и десяток источников без групп — свалка.
      if (source.owner !== owner) {
        owner = source.owner;
        const title = document.createElement('div');
        title.className = 'debug-panel__owner';
        title.textContent = owner;
        list.append(title);
      }
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = source.enabled;
      input.addEventListener('change', () => {
        layer.setEnabled(source.id, input.checked);
        remember();
        // Текст пересобирается по СОБЫТИЮ, а не покадровым опросом: щелчок
        // виден сразу, а между щелчками панель молчит (RDBG-7).
        stale = true;
      });
      const caption = document.createElement('span');
      caption.textContent = source.title;
      caption.title = source.id;
      label.append(input, caption);
      list.append(label);
      rows.push({ id: source.id, input });
    }
  };

  const update = (nowMs: number): void => {
    if (layer.enabledCount === 0) {
      // Вся цена выключенной отладки на стороне приложения: одно сравнение
      // (RDBG-4). Текст стирается один раз — на переходе, а не каждым кадром.
      if (printed) {
        text.textContent = '';
        printed = false;
      }
      stale = true;
      textAt = Number.NaN;
      return;
    }
    if (!stale && nowMs - textAt < interval) return;
    stale = false;
    textAt = nowMs;
    text.textContent = describeDump(layer.dump());
    printed = true;
  };

  refresh();
  return { refresh, update };
}

/**
 * Текстовая часть панели из дампа (RDBG-3): имена, числа и перечни печатает
 * приложение, а не рендер. Печатается ровно то, что в дампе, — панель и модель
 * читают одно и то же, и «на экране одно, в дампе другое» невозможно.
 */
export function describeDump(dump: DebugDump): string {
  const lines: string[] = [
    `тик ${dump.tick} · режим ${dump.mode} · формат ${dump.version}`,
  ];
  for (const [id, section] of Object.entries(dump.sections)) {
    const body = section as { noData?: string };
    lines.push(body.noData === undefined ? `${id}: ${summarize(section)}` : `${id}: ${body.noData}`);
  }
  return lines.join('\n');
}

/** Одна строка о секции: скаляры как есть, перечни — длиной и признаком усечения. */
function summarize(section: unknown): string {
  if (typeof section !== 'object' || section === null) return String(section);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (key === 'noData') continue;
    if (typeof value === 'number') {
      parts.push(`${key}=${Number.isInteger(value) ? value : value.toFixed(3)}`);
    } else if (typeof value === 'boolean' || typeof value === 'string') {
      parts.push(`${key}=${String(value)}`);
    } else if (value !== null && typeof value === 'object' && 'items' in value) {
      const list = value as { items: unknown[]; total: number; truncated: boolean };
      parts.push(`${key}=${list.items.length}/${list.total}${list.truncated ? '…' : ''}`);
    }
  }
  return parts.join(' ');
}

/**
 * Ручка дампа на носителе (PERF-7-образец). Кладёт её сборка приложения, а
 * собирает дамп рендер: механизм остаётся в движке, а конвенция страницы — здесь.
 */
export function attachDebugGlobal(host: DebugGlobalHost, layer: RenderDebugLayer): DebugGlobal {
  const handle: DebugGlobal = {
    version: DEBUG_DUMP_VERSION,
    sources: () => layer.sources,
    setEnabled: (id, enabled) => layer.setEnabled(id, enabled),
    dump: () => layer.dump(),
  };
  host[DEBUG_GLOBAL_KEY] = handle;
  return handle;
}
