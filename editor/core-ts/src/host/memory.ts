/**
 * Хост среды в памяти. У него две работы, и обе настоящие.
 *
 * 1. **Тестовый дубль.** Проверка ED-12 — «редактор вне шва не знает о среде» —
 *    выполнима только если существует среда, в которой нет ни файловой системы,
 *    ни окна: код, который её переживает, никакой другой не выделяет.
 * 2. **Подложка несохранённого.** Наложенный поверх дискового хоста
 *    (`createOverlayHost`), он держит байты, которых на диске нет: документы с
 *    правками и мир превью. Так превью получает текущее состояние документов, не
 *    записав ничего в дерево контента (ED-9), и `content/` остаётся нетронутым
 *    (CONT-1).
 *
 * Каталоги не хранятся: они выводятся из путей файлов. Пустой каталог в дереве
 * контента ничего не значит — контент это документы, а не места под них.
 */
import { compareContentNames, contentPathName, normalizeContentPath } from './paths.js';
import type { ContentPath } from './paths.js';
import type {
  ChoiceRequest,
  CloseRequestHandler,
  ContentChange,
  ContentEntry,
  ContentPicker,
  ContentRootInfo,
  ContentTreeHost,
  ContentWatcher,
  EnvironmentHost,
  WindowHost,
} from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Содержимое файла при наполнении хоста: текст удобнее для документов, байты — для ассетов. */
export type MemoryFileContent = string | Uint8Array | ArrayBuffer;

export interface MemoryHostOptions {
  readonly name?: string;
  readonly files?: Readonly<Record<ContentPath, MemoryFileContent>>;
  readonly root?: ContentRootInfo;
  /** Ответы диалогов выбора. Отсутствие ответа — отказ пользователя, то есть `undefined`. */
  readonly choices?: MemoryChoices;
}

export interface MemoryChoices {
  readonly root?: ContentRootInfo;
  readonly file?: ContentPath;
  readonly directory?: ContentPath;
}

/** Что записало окно — среда его не показывает, но тест обязан видеть (ED-21). */
export interface MemoryWindowState {
  readonly title: string | undefined;
  readonly unsaved: boolean;
}

export interface MemoryHost extends EnvironmentHost {
  /** Пути, записанные через `content.write`, в порядке записи: ED-21 требует, чтобы их было ровно столько, сколько документов с правками. */
  readonly writes: readonly ContentPath[];
  /** Запросы, дошедшие до диалогов, — для проверки того, что интерфейс спросил среду, а не решил сам. */
  readonly choiceRequests: readonly { readonly kind: 'root' | 'file' | 'directory'; readonly request?: ChoiceRequest }[];
  readonly windowState: MemoryWindowState;
  /** Правка «извне»: меняет дерево и уведомляет наблюдателей, но записью редактора не считается. */
  set(path: ContentPath, content: MemoryFileContent): void;
  /** Удаление «извне». */
  remove(path: ContentPath): void;
  has(path: ContentPath): boolean;
  /** Байты файла синхронно — тесту не нужен `await` ради проверки записанного. */
  bytes(path: ContentPath): Uint8Array;
  text(path: ContentPath): string;
  /** Все пути файлов в нормированном порядке. */
  paths(): readonly ContentPath[];
  /** Сообщает редактору о запросе закрытия и отдаёт его ответ. */
  requestClose(): boolean;
}

function toBytes(content: MemoryFileContent): Uint8Array {
  if (typeof content === 'string') return encoder.encode(content);
  if (content instanceof Uint8Array) return new Uint8Array(content);
  return new Uint8Array(content.slice(0));
}

/**
 * Синхронный отказ, приведённый к промису. Шов объявляет асинхронные методы, и
 * реализация, бросающая до возврата промиса, заставила бы каждого вызывающего
 * оборачивать вызов и в `try`, и в `catch` — то есть писать по-разному под
 * разные среды, чего ED-12 не допускает.
 */
function settled<T>(compute: () => T): Promise<T> {
  try {
    return Promise.resolve(compute());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Копия, а не `bytes.buffer`: наружу отдаётся байтовый буфер, и вернуть тот
  // же, что лежит в хранилище, значило бы отдать дерево контента на правку мимо
  // `write` — ровно тот обход шва, который ED-12 называет дефектом.
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function createMemoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const files = new Map<ContentPath, Uint8Array>();
  const watchers = new Set<ContentWatcher>();
  const closeHandlers = new Set<CloseRequestHandler>();
  const writes: ContentPath[] = [];
  const choiceRequests: { kind: 'root' | 'file' | 'directory'; request?: ChoiceRequest }[] = [];
  let root = options.root;
  let title: string | undefined;
  let unsaved = false;

  const notify = (change: ContentChange): void => {
    for (const watcher of [...watchers]) watcher(change);
  };

  const put = (path: ContentPath, content: MemoryFileContent): ContentPath => {
    const at = normalizeContentPath(path);
    if (at === '') throw new Error('корень дерева контента файлом не бывает');
    const existed = files.has(at);
    files.set(at, toBytes(content));
    notify({ path: at, kind: existed ? 'modified' : 'created' });
    return at;
  };

  for (const [path, content] of Object.entries(options.files ?? {})) {
    // Наполнение конструктором наблюдателей не имеет — уведомлять некого.
    files.set(normalizeContentPath(path), toBytes(content));
  }

  const requireFile = (path: ContentPath): Uint8Array => {
    const at = normalizeContentPath(path);
    const bytes = files.get(at);
    if (bytes === undefined) throw new Error(`файл "${at}" отсутствует в дереве контента`);
    return bytes;
  };

  const content: ContentTreeHost = {
    read: (path) => settled(() => toArrayBuffer(requireFile(path))),

    write: (path, bytes) =>
      settled(() => {
        writes.push(put(path, bytes));
      }),

    stat: (path) =>
      settled((): ContentEntry | undefined => {
        const at = normalizeContentPath(path);
        if (at === '') return { path: '', name: '', kind: 'directory' };
        if (files.has(at)) return { path: at, name: contentPathName(at), kind: 'file' };
        const prefix = `${at}/`;
        for (const known of files.keys()) {
          if (known.startsWith(prefix)) return { path: at, name: contentPathName(at), kind: 'directory' };
        }
        return undefined;
      }),

    list: (path) =>
      settled((): readonly ContentEntry[] => {
        const at = normalizeContentPath(path);
        const prefix = at === '' ? '' : `${at}/`;
        const seen = new Map<string, ContentEntry>();
        for (const known of files.keys()) {
          if (!known.startsWith(prefix)) continue;
          const rest = known.slice(prefix.length);
          if (rest === '') continue;
          const cut = rest.indexOf('/');
          const name = cut < 0 ? rest : rest.slice(0, cut);
          if (seen.has(name)) continue;
          seen.set(name, { path: `${prefix}${name}`, name, kind: cut < 0 ? 'file' : 'directory' });
        }
        return [...seen.values()].sort((a, b) => compareContentNames(a.name, b.name));
      }),

    watch(listener) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  };

  const picker: ContentPicker = {
    chooseRoot() {
      choiceRequests.push({ kind: 'root' });
      const chosen = options.choices?.root;
      if (chosen !== undefined) root = chosen;
      return Promise.resolve(chosen);
    },
    chooseFile(request) {
      choiceRequests.push(request === undefined ? { kind: 'file' } : { kind: 'file', request });
      return Promise.resolve(options.choices?.file);
    },
    chooseDirectory(request) {
      choiceRequests.push(request === undefined ? { kind: 'directory' } : { kind: 'directory', request });
      return Promise.resolve(options.choices?.directory);
    },
  };

  const windowHost: WindowHost = {
    setTitle(next) {
      title = next;
    },
    setUnsaved(next) {
      unsaved = next;
    },
    onCloseRequest(handler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
  };

  return {
    name: options.name ?? 'memory',
    get root() {
      return root;
    },
    content,
    picker,
    window: windowHost,

    get writes() {
      return writes;
    },
    get choiceRequests() {
      return choiceRequests;
    },
    get windowState() {
      return { title, unsaved };
    },

    set(path, value) {
      put(path, value);
    },

    remove(path) {
      const at = normalizeContentPath(path);
      if (!files.delete(at)) return;
      notify({ path: at, kind: 'removed' });
    },

    has: (path) => files.has(normalizeContentPath(path)),
    bytes: (path) => new Uint8Array(requireFile(path)),
    text: (path) => decoder.decode(requireFile(path)),
    paths: () => [...files.keys()].sort(compareContentNames),

    requestClose() {
      for (const handler of [...closeHandlers]) if (!handler()) return false;
      return true;
    },
  };
}
