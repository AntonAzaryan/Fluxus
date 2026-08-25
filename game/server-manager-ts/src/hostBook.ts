/**
 * Книга хостов менеджера (`server-manager` MGR-1, решение D11): адреса, токены
 * и закреплённые отпечатки известных агентов.
 *
 * Живёт она в ХРАНИЛИЩЕ СТРАНИЦЫ, и это осознанная цена: токены и отпечатки
 * лежат там открытым текстом. Приемлемо для админ-инструмента на своей машине —
 * тот же уровень доверия, что у каталога состояния агента, где токены лежат
 * файлом. Переход на шифрованное хранилище ОС (safeStorage контейнера) — это
 * отдельное расширение моста, и смешивать его с этим change'ем нельзя: риск
 * назван здесь, чтобы его не пришлось искать.
 *
 * Локальный хост в книге НЕ хранится (MGR-5): его адрес и материал автопейринга
 * приезжают через объявленный сервис на каждом запуске, и запомненный адрес
 * прошлого запуска был бы вторым мнением о том, где агент.
 */

/** Известный хост: всё, что нужно, чтобы подключиться к нему заново. */
export interface KnownHost {
  /** Идентификатор в книге: адрес, приведённый к origin. */
  readonly id: string;
  readonly label: string;
  /** Адрес управляющего эндпоинта: `wss://host:port`. */
  readonly url: string;
  /** Долгоживущий токен (SRV-3); пустая строка — не паровались. */
  readonly token: string;
  /** Закреплённый отпечаток (TOFU, SRV-3); пустая строка — ещё не закрепляли. */
  readonly fingerprint: string;
}

/** Хранилище страницы: ровно та часть `Storage`, которой пользуется книга. */
export interface PageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Ключ записи в хранилище страницы. */
export const HOST_BOOK_KEY = 'fluxus.server-manager.hosts';

export interface HostBook {
  list(): readonly KnownHost[];
  /** Запомнить хост либо обновить его запись: ключ — адрес. */
  remember(host: KnownHost): void;
  forget(id: string): void;
  get(id: string): KnownHost | undefined;
}

/** Идентификатор хоста — origin адреса: `wss://host:port` без пути и параметров. */
export function hostIdOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function parse(raw: string | null): KnownHost[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is KnownHost =>
        typeof entry === 'object' && entry !== null && typeof (entry as KnownHost).url === 'string',
    );
  } catch {
    // Испорченная книга не роняет приложение и не «чинится» молча: считаем, что
    // известных хостов нет, — добавить их заново можно пейрингом.
    return [];
  }
}

export function hostBook(storage: PageStorage): HostBook {
  const read = (): KnownHost[] => parse(storage.getItem(HOST_BOOK_KEY));
  const write = (hosts: readonly KnownHost[]): void => {
    storage.setItem(HOST_BOOK_KEY, JSON.stringify(hosts));
  };
  return {
    list: () => read(),
    get: (id) => read().find((host) => host.id === id),
    remember(host) {
      const rest = read().filter((known) => known.id !== host.id);
      write([...rest, host]);
    },
    forget(id) {
      write(read().filter((known) => known.id !== id));
    },
  };
}

/** Книга в памяти: страница без хранилища (приватное окно) работает так же. */
export function memoryStorage(): PageStorage {
  const cells = new Map<string, string>();
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      cells.set(key, value);
    },
  };
}

/**
 * Хранилище страницы, если оно доступно, и память, если нет. Обращение к
 * `localStorage` бросает в приватном окне и при запрещённых данных сайта, а
 * менеджер обязан работать и там — без памяти о хостах, но работать.
 */
export function pageStorage(scope: { localStorage?: PageStorage }): PageStorage {
  try {
    const storage = scope.localStorage;
    if (storage === undefined) return memoryStorage();
    storage.getItem(HOST_BOOK_KEY);
    return storage;
  } catch {
    return memoryStorage();
  }
}
