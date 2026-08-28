import type {
  AssetKind,
  AssetLoader,
  AssetSource,
  AssetState,
  Handle,
  LoaderContext,
} from './types.js';
import { reasonOf } from './validation.js';

/**
 * Запись кэша: одна на ID, разделяется всеми потребителями (ASSET-2 —
 * повторный запрос возвращает тот же handle и тот же ассет, не копию).
 */
interface Entry {
  readonly handle: Handle;
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
 * Ключ реестра — пара «вид + формат» (ASSET-3). Не одно расширение: `.json`
 * принадлежит и манифесту визуалов, и нативному формату моделей three.js, и при
 * ключе по расширению второй загрузчик молча вытеснил бы первый.
 * `\u0000` в путях и видах не встречается, поэтому склейка однозначна.
 */
function registryKey(kind: AssetKind, ext: string): string {
  return `${kind}\u0000${ext.toLowerCase()}`;
}

/**
 * Путь зависимости ассета, разрешённый относительно ЕГО ID (ASSET-3): `id` —
 * путь в дереве контента, поэтому база — его директория. Путь с ведущим `/`
 * считается от корня дерева. Выход выше корня запрещён: загрузчик работает в
 * дереве контента, а не в файловой системе хоста.
 */
export function resolveDependencyPath(baseId: string, relativePath: string): string {
  const rel = relativePath.replace(/\\/g, '/');
  const fromRoot = rel.startsWith('/');
  const out = fromRoot ? [] : baseId.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new Error(`путь зависимости "${relativePath}" выходит за корень дерева контента`);
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Сервис presentation-ассетов: кэш по ID, реестр загрузчиков по паре
 * «вид + формат», асинхронная загрузка с наблюдаемыми состояниями
 * (ASSET-2, ASSET-3, ASSET-4).
 */
export class AssetService {
  private readonly source: AssetSource;
  private readonly loaders = new Map<string, AssetLoader>();
  private readonly cache = new Map<string, Entry>();

  constructor(source: AssetSource) {
    this.source = source;
  }

  /**
   * Регистрация загрузчика под парой «его вид + его расширения» (ASSET-3).
   * Повторная регистрация той же пары перекрывает предыдущий загрузчик — это
   * штатная точка замены формата (например, PNG → рантайм-BLP) без правки
   * сервиса; уже загруженные ассеты перерегистрация не трогает. Увести формат
   * у чужого вида она при этом не может: ключ включает вид.
   */
  registerLoader(loader: AssetLoader): void {
    for (const ext of loader.extensions) {
      this.loaders.set(registryKey(loader.kind, ext), loader);
    }
  }

  /**
   * Запрос ассета. Идемпотентен по ID (ASSET-2): повторный запрос возвращает
   * тот же handle и тот же разделяемый ассет из кэша — файл не загружается и
   * не парсится второй раз. Первый запрос стартует асинхронную загрузку и не
   * блокирует вызывающего (ASSET-4); перезапуск после `failed` — только явным
   * `retry`.
   *
   * Запрос ID, уже закэшированного под другим видом, — синхронный throw: это
   * ошибка в коде вызывающего, видная сразу и до всякого ввода-вывода, и отдать
   * её асинхронным `failed` значило бы спрятать баг в состоянии ассета, который
   * вызывающему всё равно бесполезен. Отсутствие загрузчика под пару
   * «вид + формат» — наоборот, вопрос комплектации рантайма (формат могут
   * зарегистрировать позже), и это `failed` (ASSET-3).
   */
  request<T = unknown>(kind: AssetKind, id: string): Handle<T> {
    const existing = this.cache.get(id);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `ассет "${id}" уже запрошен как "${existing.kind}" — запрос как "${kind}" вернул бы данные другого типа (ASSET-2)`,
        );
      }
      return existing.handle;
    }
    const handle = Object.freeze({ id, kind }) as Handle;
    const entry: Entry = {
      handle,
      kind,
      state: Object.freeze({ status: 'loading' as const }),
      subscribers: new Set(),
    };
    this.cache.set(id, entry);
    this.startLoad(entry);
    return handle;
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

  private entryOf(handle: Handle): Entry {
    const entry = this.cache.get(handle.id);
    if (entry?.kind !== handle.kind) {
      throw new Error(`handle "${handle.id}" (${handle.kind}) не выдавался этим сервисом`);
    }
    return entry;
  }

  /** Виды, под которыми расширение зарегистрировано, — для диагностики. */
  private kindsForExtension(ext: string): string[] {
    const suffix = `\u0000${ext.toLowerCase()}`;
    const kinds: string[] = [];
    for (const key of this.loaders.keys()) {
      if (key.endsWith(suffix)) kinds.push(key.slice(0, key.length - suffix.length));
    }
    return kinds;
  }

  /**
   * Старт (или перезапуск) загрузки. Единственность попытки гарантирована
   * вызывающими: `request` зовёт один раз для нового ID, `retry` — только из
   * `failed`, то есть когда предыдущая попытка уже завершилась.
   */
  private startLoad(entry: Entry): void {
    const ext = extensionOf(entry.handle.id);
    const loader = ext == null ? undefined : this.loaders.get(registryKey(entry.kind, ext));
    if (loader == null) {
      // ASSET-3: нет загрузчика под пару — failed с внятной причиной, не
      // исключение; загрузка остальных ассетов продолжается. Если расширение
      // знакомо, но под другим видом, называем эти виды: это ровно тот случай,
      // когда потребитель перепутал вид, и молчать о нём — вредить отладке.
      const others = ext == null ? [] : this.kindsForExtension(ext);
      const hint =
        others.length > 0
          ? ` (для этого формата зарегистрированы виды: ${others.join(', ')})`
          : '';
      this.setState(entry, {
        status: 'failed',
        reason:
          `нет загрузчика для вида "${entry.kind}" и формата ` +
          `"${ext ?? '(без расширения)'}" (ассет "${entry.handle.id}")${hint}`,
      });
      return;
    }
    this.setState(entry, { status: 'loading' });
    void this.runLoad(entry, loader);
  }

  /**
   * Контекст загрузки: чтение соседних файлов по путям, относительным от ID
   * ассета (ASSET-3). Сбой чтения зависимости переоформляется в ошибку,
   * называющую и ассет, и недостающий файл, — иначе в `failed` приезжает
   * «файл не найден» без единого намёка, какой именно и чей.
   */
  private contextFor(id: string): LoaderContext {
    return {
      id,
      read: async (relativePath: string): Promise<ArrayBuffer> => {
        const depId = resolveDependencyPath(id, relativePath);
        try {
          return await this.source.read(depId);
        } catch (e) {
          throw new Error(
            `ассет "${id}": не удалось прочитать зависимость "${depId}" — ${reasonOf(e)}`,
          );
        }
      },
    };
  }

  private async runLoad(entry: Entry, loader: AssetLoader): Promise<void> {
    let data: unknown;
    try {
      const bytes = await this.source.read(entry.handle.id);
      data = await loader.load(bytes, this.contextFor(entry.handle.id));
    } catch (e) {
      this.setState(entry, {
        status: 'failed',
        reason: reasonOf(e),
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
