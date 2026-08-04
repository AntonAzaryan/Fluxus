import type { AssetKind, AssetLoader, AssetSource, AssetState, Handle } from './types.js';

/**
 * Запись кэша: одна на ID, разделяется всеми потребителями (ASSET-2 —
 * повторный запрос возвращает тот же handle и тот же ассет, не копию).
 */
interface Entry {
  readonly handle: Handle<unknown>;
  readonly kind: AssetKind;
  state: AssetState<unknown>;
  readonly subscribers: Set<(s: AssetState<unknown>) => void>;
}

/** Расширение ID в нижнем регистре (с точкой) или null, если расширения нет. */
function extensionOf(id: string): string | null {
  const slash = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'));
  const dot = id.lastIndexOf('.');
  if (dot <= slash) return null;
  return id.slice(dot).toLowerCase();
}

/**
 * Сервис presentation-ассетов: кэш по ID, реестр загрузчиков по расширению,
 * асинхронная загрузка с наблюдаемыми состояниями (ASSET-2, ASSET-3, ASSET-4).
 */
export class AssetService {
  private readonly source: AssetSource;
  private readonly loaders = new Map<string, AssetLoader>();
  private readonly cache = new Map<string, Entry>();

  constructor(source: AssetSource) {
    this.source = source;
  }

  /**
   * Регистрация загрузчика под его расширениями (ASSET-3). Повторная
   * регистрация того же расширения перекрывает предыдущий загрузчик — это
   * штатная точка замены формата (например, PNG → рантайм-BLP) без правки
   * сервиса; уже загруженные ассеты перерегистрация не трогает.
   */
  registerLoader(loader: AssetLoader): void {
    for (const ext of loader.extensions) {
      this.loaders.set(ext.toLowerCase(), loader);
    }
  }

  /**
   * Запрос ассета. Идемпотентен по ID (ASSET-2): повторный запрос возвращает
   * тот же handle и тот же разделяемый ассет из кэша — файл не загружается и
   * не парсится второй раз. Первый запрос стартует асинхронную загрузку и не
   * блокирует вызывающего (ASSET-4); перезапуск после `failed` — только явным
   * `retry`.
   *
   * Ошибка вида ассета — всегда синхронный throw, проблема доступности —
   * всегда `failed` (ASSET-2). Под «ошибку вида» подпадают оба случая, когда
   * несовпадение видно СРАЗУ, до всякого ввода-вывода: ID уже закэширован под
   * другим видом, и зарегистрированный для расширения загрузчик производит
   * другой вид. Оба — ошибка в коде вызывающего, а не сбой окружения: отдавать
   * их асинхронным `failed` значило бы прятать баг в состоянии ассета, который
   * вызывающему всё равно бесполезен. Отсутствие загрузчика — наоборот,
   * вопрос комплектации рантайма (формат могут зарегистрировать позже), и это
   * по-прежнему `failed` (ASSET-3).
   */
  request<T = unknown>(kind: AssetKind, id: string): Handle<T> {
    const existing = this.cache.get(id);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `ассет "${id}" уже запрошен как "${existing.kind}" — запрос как "${kind}" вернул бы данные другого типа (ASSET-2)`,
        );
      }
      return existing.handle as Handle<T>;
    }
    // Проверка ДО записи в кэш: ассет с заведомо неверным видом не должен
    // оставлять после себя ни записи, ни handle — повторный (уже правильный)
    // запрос обязан начаться с чистого листа.
    const ext = extensionOf(id);
    const loader = ext == null ? undefined : this.loaders.get(ext);
    if (loader != null && loader.kind !== kind) {
      throw new Error(
        `загрузчик формата "${ext}" производит "${loader.kind}" — запрос ассета "${id}" ` +
          `как "${kind}" вернул бы данные другого типа (ASSET-2)`,
      );
    }
    const handle = Object.freeze({ id, kind }) as Handle<unknown>;
    const entry: Entry = {
      handle,
      kind,
      state: Object.freeze({ status: 'loading' as const }),
      subscribers: new Set(),
    };
    this.cache.set(id, entry);
    this.startLoad(entry);
    return handle as Handle<T>;
  }

  /** Синхронный опрос состояния (ASSET-4). */
  state<T>(handle: Handle<T>): AssetState<T> {
    return this.entryOf(handle).state as AssetState<T>;
  }

  /**
   * Подписка на состояние (ASSET-4): колбэк вызывается немедленно с текущим
   * состоянием и затем на каждую смену. Возвращает функцию отписки.
   */
  subscribe<T>(handle: Handle<T>, cb: (s: AssetState<T>) => void): () => void {
    const entry = this.entryOf(handle);
    const sub = cb as (s: AssetState<unknown>) => void;
    entry.subscribers.add(sub);
    // Немедленный вызов защищён так же, как уведомления о смене: правило
    // «подписчик не роняет сервис» не должно зависеть от того, в каком именно
    // состоянии ассет застали в момент подписки.
    this.notify(entry, sub, entry.state);
    return () => {
      entry.subscribers.delete(sub);
    };
  }

  /**
   * Повторная попытка загрузки для `failed` (ASSET-4: повторный явный запрос
   * MAY инициировать новую попытку). Для `loading` и `ready` — no-op: загрузка
   * либо уже идёт, либо не нужна. Загрузчик ищется заново, поэтому retry
   * подхватывает формат, зарегистрированный после сбоя (ASSET-3).
   */
  retry(handle: Handle): void {
    const entry = this.entryOf(handle);
    if (entry.state.status !== 'failed') return;
    this.startLoad(entry);
  }

  private entryOf(handle: Handle<unknown>): Entry {
    const entry = this.cache.get(handle.id);
    if (!entry || entry.kind !== handle.kind) {
      throw new Error(`handle "${handle.id}" (${handle.kind}) не выдавался этим сервисом`);
    }
    return entry;
  }

  /**
   * Старт (или перезапуск) загрузки. Единственность попытки гарантирована
   * вызывающими: `request` зовёт один раз для нового ID, `retry` — только из
   * `failed`, то есть когда предыдущая попытка уже завершилась.
   */
  private startLoad(entry: Entry): void {
    const ext = extensionOf(entry.handle.id);
    const loader = ext == null ? undefined : this.loaders.get(ext);
    if (loader == null) {
      // ASSET-3: неизвестный формат — failed с внятной причиной, не
      // исключение; загрузка остальных ассетов продолжается.
      this.setState(entry, {
        status: 'failed',
        reason: `нет загрузчика для формата "${ext ?? '(без расширения)'}" (ассет "${entry.handle.id}")`,
      });
      return;
    }
    if (loader.kind !== entry.kind) {
      // Страховка для пути `retry()`. Из `request()` сюда с несовпадающим
      // видом уже не попасть — там это синхронный throw (см. выше), причём до
      // записи в кэш. А вот retry ищет загрузчик заново: ассет мог упасть с
      // «нет загрузчика», после чего расширение зарегистрировали — и оказалось,
      // что новый загрузчик производит не тот вид, под которым ассет запрошен.
      // Бросать здесь нельзя: retry вызывают из чужого кода, не готового к
      // исключению от давно запрошенного ассета, поэтому — `failed` с причиной.
      this.setState(entry, {
        status: 'failed',
        reason:
          `загрузчик формата "${ext}" производит "${loader.kind}", ` +
          `а ассет "${entry.handle.id}" запрошен как "${entry.kind}"`,
      });
      return;
    }
    this.setState(entry, { status: 'loading' });
    void this.runLoad(entry, loader);
  }

  private async runLoad(entry: Entry, loader: AssetLoader): Promise<void> {
    let data: unknown;
    try {
      const bytes = await this.source.read(entry.handle.id);
      data = await loader.load(bytes, entry.handle.id);
    } catch (e) {
      this.setState(entry, {
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    // setState вне try: исключение подписчика не должно перевести успешно
    // загруженный ассет в failed.
    this.setState(entry, { status: 'ready', data });
  }

  private setState(entry: Entry, next: AssetState<unknown>): void {
    // `state()` и подписчики получают внутреннюю запись состояния как есть —
    // морозим её, чтобы потребитель не мог подменить status/reason у себя и
    // тем самым у всех остальных наблюдателей (ASSET-5: разделяемые данные
    // иммутабельны). Заморозка мелкая: сам ассет в `data` морозит загрузчик.
    const frozen = Object.freeze(next);
    entry.state = frozen;
    // копия — подписчик вправе отписаться (или подписать другого) из колбэка
    for (const cb of [...entry.subscribers]) this.notify(entry, cb, frozen);
  }

  /**
   * Вызов одного подписчика в изоляции. Бросивший подписчик — его собственная
   * беда, и она не должна становиться бедой сервиса: без перехвата (а) все
   * подписчики после него в очереди остались бы без уведомления, (б) на
   * успешном пути исключение улетело бы из `runLoad`, запущенного как
   * `void this.runLoad(...)`, то есть в unhandled rejection — а это дефолтное
   * падение процесса в Node. Ошибка не глотается молча: пишем в console.error
   * с id и видом ассета, чтобы виновника было видно.
   */
  private notify(
    entry: Entry,
    cb: (s: AssetState<unknown>) => void,
    state: AssetState<unknown>,
  ): void {
    try {
      cb(state);
    } catch (e) {
      console.error(
        `подписчик ассета "${entry.handle.id}" (${entry.kind}) бросил исключение ` +
          `на состоянии "${state.status}":`,
        e,
      );
    }
  }
}
