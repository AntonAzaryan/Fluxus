/**
 * Строковые ресурсы редактора (ED-27) и разрешение описаний полей (ED-28).
 *
 * Бандл локали — плоская карта «ключ → строка», по файлу на локаль: такой файл
 * правит любой инструмент и любой переводчик, и ничего, кроме строк, в нём
 * нет. Машинные данные о переводах (отпечатки) лежат отдельно —
 * `fingerprints.ts`.
 *
 * Разрешение двухуровневое: бандл проекта поверх бандла редактора. Описания
 * полей компонентов, объявленных контентом, пишет тот, кто объявил компонент,
 * и живут они в дереве контента; строки хрома редактора живут с редактором и в
 * `content/` не попадают (`game-content` CONT-1) — дерево контента не хранит
 * подписи чужого инструмента.
 *
 * Порядок цепочки — локаль снаружи, источник внутри: текущая локаль (проект,
 * затем редактор) → `en` (проект, затем редактор) → сам ключ. Показ ключа —
 * не аварийный режим, а требование ED-28: отсутствие ресурса должно быть
 * видно, а пустая подсказка прячет его.
 *
 * Локаль здесь — состояние в памяти и ничего больше. Ни одна функция этого
 * модуля не пишет на диск и не касается редактируемых документов: ED-27
 * требует, чтобы смена языка не меняла ни байта, и держится это на том, что
 * менять нечем. Имена компонентов, полей, префабов, систем и ассетов сюда не
 * попадают вовсе — они принадлежат документам и одинаковы во всех локалях.
 */
import { descriptionKey, type SchemaPath } from './keys.js';
import { reportResources, type ResourceReport } from './report.js';

export type LocaleId = string;

/** Локаль, на которую опирается цепочка разрешения и от которой считается протухание перевода. */
export const SOURCE_LOCALE = 'en';

/** Локали, которые редактор везёт с собой. `ru` и `en` равноправны (ED-27). */
export const SHIPPED_LOCALES: readonly LocaleId[] = ['en', 'ru'];

export type LocaleBundle = Readonly<Record<string, string>>;
export type LocaleBundles = Readonly<Record<LocaleId, LocaleBundle>>;

/**
 * Каталог бандлов проекта в дереве контента: `i18n/<locale>.json`. Здесь —
 * только соглашение об имени; чтение файлов — дело хоста среды (ED-12), у
 * headless-слоя файловой системы нет.
 */
export const PROJECT_BUNDLE_DIR = 'i18n';

export function projectBundlePath(locale: LocaleId): string {
  return `${PROJECT_BUNDLE_DIR}/${locale}.json`;
}

/** Откуда пришла строка — нужно отчёту и диагностике, а не показу. */
export interface ResourceHit {
  readonly text: string;
  readonly locale: LocaleId;
  readonly source: 'project' | 'editor';
}

/** Подсказка к полю: то, что показывает интерфейс, и признак того, что показывать. */
export interface Hint {
  readonly path: SchemaPath;
  readonly key: string;
  /** Никогда не пусто: при отсутствии ресурса — сам ключ (ED-28). */
  readonly text: string;
  /** `undefined` — ресурса нет ни в текущей локали, ни в `en`; текст равен ключу. */
  readonly hit?: ResourceHit;
}

/**
 * Узкий интерфейс для потребителей описаний — инспектора (ED-24) и машинного
 * каталога (ED-30). Каталогу нужен `describeIn(SOURCE_LOCALE, …)`: описания в
 * нём — те же английские строки, что видит человек на английской локали, и
 * второго набора формулировок «для машины» не заводится.
 */
export interface DescriptionSource {
  describe(path: SchemaPath): string;
  describeIn(locale: LocaleId, path: SchemaPath): string;
  hint(path: SchemaPath): Hint;
}

/** Разрешение произвольного ключа — то, чем пользуется хром интерфейса. */
export interface TextSource {
  text(key: string): string;
}

export interface StringResourcesInit {
  /** Локаль — настройка пользователя, а не свойство проекта (ED-27). */
  readonly locale: LocaleId;
  readonly editor: LocaleBundles;
  readonly project?: LocaleBundles;
}

const EMPTY_BUNDLES: LocaleBundles = {};

/**
 * Ресурс, разрешившийся в пустую строку, считается отсутствующим и цепочку не
 * останавливает: ED-28 запрещает показывать пустую подсказку, а пустое
 * значение в бандле — тот же «ресурса нет», только записанный явно.
 */
function textOf(bundle: LocaleBundle | undefined, key: string): string | undefined {
  const value = bundle?.[key];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export class StringResources implements TextSource, DescriptionSource {
  private current: LocaleId;
  private editor: LocaleBundles;
  private project: LocaleBundles;
  private readonly listeners = new Set<() => void>();

  constructor(init: StringResourcesInit) {
    this.current = init.locale;
    this.editor = init.editor;
    this.project = init.project ?? EMPTY_BUNDLES;
  }

  get locale(): LocaleId {
    return this.current;
  }

  /**
   * Смена языка без перезапуска (ED-27): меняется поле и рассылается
   * уведомление — ни файлов, ни документов при этом не трогается.
   */
  setLocale(locale: LocaleId): void {
    if (locale === this.current) return;
    this.current = locale;
    this.notify();
  }

  /** Бандлы проекта приходят и уходят вместе с открытым проектом. */
  setProjectBundles(bundles: LocaleBundles): void {
    this.project = bundles;
    this.notify();
  }

  /** Подписка на смену языка и состава бандлов: интерфейс перерисовывается, а не перезапускается. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  text(key: string): string {
    return this.textIn(this.current, key);
  }

  textIn(locale: LocaleId, key: string): string {
    return this.lookupIn(locale, key)?.text ?? key;
  }

  lookup(key: string): ResourceHit | undefined {
    return this.lookupIn(this.current, key);
  }

  lookupIn(locale: LocaleId, key: string): ResourceHit | undefined {
    const chain = locale === SOURCE_LOCALE ? [locale] : [locale, SOURCE_LOCALE];
    for (const step of chain) {
      const fromProject = textOf(this.project[step], key);
      if (fromProject !== undefined) return { text: fromProject, locale: step, source: 'project' };
      const fromEditor = textOf(this.editor[step], key);
      if (fromEditor !== undefined) return { text: fromEditor, locale: step, source: 'editor' };
    }
    return undefined;
  }

  describe(path: SchemaPath): string {
    return this.describeIn(this.current, path);
  }

  describeIn(locale: LocaleId, path: SchemaPath): string {
    return this.textIn(locale, descriptionKey(path));
  }

  hint(path: SchemaPath): Hint {
    const key = descriptionKey(path);
    const hit = this.lookup(key);
    return hit === undefined ? { path, key, text: key } : { path, key, text: hit.text, hit };
  }

  /**
   * Ключи, на которые локаль отвечает непустой строкой, — обе стороны отчёта
   * ED-28 считаются по ним. Ключ с пустым значением в множество не попадает:
   * поле, «описанное» пустой строкой, остаётся недокументированным.
   */
  keys(locale: LocaleId = this.current): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const bundles of [this.editor, this.project]) {
      const bundle = bundles[locale];
      if (bundle === undefined) continue;
      for (const key of Object.keys(bundle)) {
        if (textOf(bundle, key) !== undefined) keys.add(key);
      }
    }
    return keys;
  }

  /** Двусторонний отчёт ED-28 по видимым в этой локали ресурсам. */
  report(paths: Iterable<SchemaPath>, locale: LocaleId = this.current): ResourceReport {
    return reportResources(paths, this.keys(locale));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
