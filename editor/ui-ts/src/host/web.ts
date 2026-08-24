/**
 * Веб-реализация хоста среды (ED-12). Вторая — десктопная — пишется оболочкой;
 * весь остальной редактор ни о той, ни о другой не знает: он видит один
 * интерфейс из `@fluxus/editor-core`.
 *
 * ## Чтение — тот же шов, что у модуля ассетов
 *
 * Дерево контента раздаётся оболочкой как статика (CONT-5: путь до корня —
 * свойство оболочки), поэтому `read(path)` — это `fetch` по пути от корня.
 * Совпадение с `AssetSource.read(id)` (ASSET-2) не случайно и не подгонка: ID
 * ассета и есть путь в дереве, дерево одно (CONT-1), и шов к нему один —
 * `createHostAssetSource` поверх этого же хоста отдаёт модулю ассетов ровно те
 * байты, которые редактор показывает автору.
 *
 * ## Перечисление каталога: решение и его честные границы
 *
 * У HTTP перечисления каталога нет. Три варианта, и выбран третий:
 *
 * 1. **Индексный файл в дереве контента.** Отвергнут: это артефакт инструмента
 *    внутри `content/` (CONT-1 — контент это документы, а не служебные записи
 *    инструмента), и он устаревает от любой правки дерева мимо редактора —
 *    ровно того случая, ради которого ED-12 требует реакции на изменение извне.
 * 2. **Обход по ссылкам документов.** Отвергнут: он показывает не дерево, а
 *    достижимое из открытого документа, тогда как ED-20 требует навигации по
 *    дереву — файл, на который ещё никто не сослался, в нём и есть.
 * 3. **Эндпойнт оболочки** (`app/contentEndpoint.ts`) — принят. Дерево читает
 *    тот, у кого оно есть: сервер. Редактор остаётся в браузере, а форма ответа
 *    — `list`/`stat` шва, а не вторая модель дерева.
 *
 * Граница честная и названа: в сборке без такого сервера (`vite build`,
 * выложенный статикой) перечисления и записи нет — `list`, `stat` и `write`
 * отказывают ошибкой, называющей путь, а не притворяются пустым каталогом и
 * успешной записью. Чтение при этом работает: статика есть статика. Десктопный
 * хост ни того, ни другого ограничения не имеет — там дерево лежит рядом.
 *
 * ## Наблюдение за деревом
 *
 * Файловой системы у браузера нет, и подписаться ему не на что: канал наружу
 * приносит оболочка (`changes` — сокет dev-сервера). Без канала хост уведомляет
 * только о собственных записях; шов это допускает прямо («хост, у которого
 * наблюдения нет, отдаёт отписку и молчит»), а корректность редактора от
 * уведомления не зависит — только свежесть картинки.
 */
import {
  compareContentNames,
  contentPathName,
  joinContentPath,
  normalizeContentPath,
  type ChoiceRequest,
  type CloseRequestHandler,
  type ContentChange,
  type ContentChangeKind,
  type ContentEntry,
  type ContentEntryKind,
  type ContentPath,
  type ContentPicker,
  type ContentRootInfo,
  type ContentTreeHost,
  type ContentWatcher,
  type EnvironmentHost,
  type WindowHost,
} from '@fluxus/editor-core';

/**
 * Минимум от `fetch`, которым пользуется хост. Объявлен структурно, а не
 * взят типом `typeof fetch`, по той же причине, по которой `AssetSource`
 * объявлен структурно в `editor-core`: тест подставляет сюда функцию из трёх
 * строк, а не поднимает сеть, и подпись обязана это допускать.
 */
export interface HttpRequest {
  readonly method?: string;
  /** Тело запроса — байты документа; `BodyInit` их принимает как есть. */
  readonly body?: BodyInit;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type HttpFetch = (url: string, init?: HttpRequest) => Promise<HttpResponse>;

/** Оконная часть среды: вкладка браузера. Подставляется тестом целиком. */
export interface BrowserWindowLike {
  addEventListener(type: string, listener: (event: BeforeUnloadEventLike) => void): void;
  removeEventListener(type: string, listener: (event: BeforeUnloadEventLike) => void): void;
}

export interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue?: unknown;
}

/** Куда хост пишет заголовок окна: у вкладки это заголовок документа. */
export interface DocumentTitleSink {
  set(value: string): void;
}

export interface WebHostOptions {
  /** Имя реализации для диагностики; ветвиться по нему запрещено (ED-12). */
  readonly name?: string;
  /** Показываемое имя открытого корня. */
  readonly root?: ContentRootInfo;
  /** Префикс URL раздаваемого дерева; по умолчанию корень сайта. */
  readonly base?: string;
  /** Маршрут эндпойнта перечисления и записи; по умолчанию `/__content`. */
  readonly route?: string;
  readonly fetch?: HttpFetch;
  /**
   * Канал внешних изменений дерева от оболочки: вызывает слушателя путём
   * изменившегося файла. Нет канала — хост молчит о чужих правках.
   */
  readonly changes?: (listener: (path: ContentPath, kind: ContentChangeKind) => void) => () => void;
  readonly window?: BrowserWindowLike;
  readonly documentTitle?: DocumentTitleSink;
}

/** Ответ эндпойнта: что лежит по пути и, для каталога, его содержимое. */
interface ContentReply {
  readonly kind: ContentEntryKind | 'missing';
  readonly entries?: readonly { readonly name: string; readonly kind: ContentEntryKind }[];
  readonly created?: boolean;
  /** Причина отказа, названная самим эндпойнтом; у успешного ответа её нет. */
  readonly reason?: string;
}

const DEFAULT_ROUTE = '/__content';

function query(route: string, path: ContentPath): string {
  return `${route}?path=${encodeURIComponent(path)}`;
}

/** Путь файла в URL раздаваемого дерева: сегменты кодируются, разделители — нет. */
function assetUrl(base: string, path: ContentPath): string {
  return base + path.split('/').map(encodeURIComponent).join('/');
}

function isReply(value: unknown): value is ContentReply {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'file' || kind === 'directory' || kind === 'missing';
}

/** Причина отказа, названная самим эндпойнтом; `null` — ответ её не несёт. */
async function refusalReason(response: HttpResponse): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const reason = (body as { reason?: unknown }).reason;
    return typeof reason === 'string' && reason !== '' ? reason : null;
  } catch {
    return null;
  }
}

/**
 * Ответ эндпойнта либо отказ, называющий путь. Отдельная функция потому, что
 * «эндпойнта в этой сборке нет» и «по пути ничего нет» обязаны различаться:
 * первое — отсутствие возможности у среды, второе — обычный ответ о дереве, и
 * свести их к пустому списку значило бы показать автору пустой проект вместо
 * сообщения о том, что перечисления здесь не бывает.
 *
 * Различаются и два отказа. Эндпойнт, отказавший со своей причиной (выход за
 * корень дерева, сорвавшаяся запись), эту причину и называет: подменять её
 * догадкой «в этой среде записи не бывает» значило бы отправить автора чинить
 * не то. Догадка остаётся там, где отказ нем, — это и есть случай статической
 * выкладки.
 */
async function reply(
  http: HttpFetch,
  url: string,
  path: ContentPath,
  init?: HttpRequest,
): Promise<ContentReply> {
  let response: HttpResponse;
  try {
    response = await http(url, init);
  } catch (error) {
    throw new Error(
      `дерево контента: запрос "${path}" не прошёл: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const reason = await refusalReason(response);
    throw new Error(
      reason === null
        ? `дерево контента: "${path}" — HTTP ${response.status}; похоже, эта среда перечисления и записи не предоставляет (ED-12)`
        : `дерево контента: "${path}" — HTTP ${response.status}: ${reason}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`дерево контента: ответ по "${path}" — не JSON; эндпойнта дерева в этой сборке нет`);
  }
  if (!isReply(body)) {
    throw new Error(`дерево контента: ответ по "${path}" не описывает узел дерева`);
  }
  return body;
}

export function createWebHost(options: WebHostOptions = {}): EnvironmentHost {
  const http: HttpFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const base = options.base ?? '/';
  const route = options.route ?? DEFAULT_ROUTE;
  const watchers = new Set<ContentWatcher>();
  const closeHandlers = new Set<CloseRequestHandler>();
  let unsaved = false;

  const notify = (change: ContentChange): void => {
    for (const watcher of [...watchers]) watcher(change);
  };

  options.changes?.((path, kind) => {
    notify({ path: normalizeContentPath(path), kind });
  });

  const content: ContentTreeHost = {
    async read(path) {
      const at = normalizeContentPath(path);
      const response = await http(assetUrl(base, at), {});
      if (!response.ok) {
        throw new Error(`дерево контента: "${at}" не прочитан — HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    },

    async write(path, bytes) {
      const at = normalizeContentPath(path);
      // Копия, а не сами байты вызывающего: наружу уходит буфер, которым
      // дальше владеет сеть, и отдать чужой значило бы отдать его на правку
      // после возврата из `write`.
      const payload = new Uint8Array(bytes.byteLength);
      payload.set(bytes);
      const answer = await reply(http, query(route, at), at, { method: 'PUT', body: payload });
      // Наблюдатели узнают и о собственной записи редактора: шов требует
      // именно этого, а `HostAssetSource` держит на уведомлении свежесть кэша.
      notify({ path: at, kind: answer.created === true ? 'created' : 'modified' });
    },

    async stat(path) {
      const at = normalizeContentPath(path);
      if (at === '') return { path: at, name: '', kind: 'directory' };
      const answer = await reply(http, query(route, at), at);
      if (answer.kind === 'missing') return undefined;
      return { path: at, name: contentPathName(at), kind: answer.kind };
    },

    async list(path) {
      const at = normalizeContentPath(path);
      const answer = await reply(http, query(route, at), at);
      // Каталога нет — пустой список, как и у хоста в памяти: перечисление
      // одинаково во всех средах, и различие сред здесь было бы дефектом.
      if (answer.kind !== 'directory') return [];
      const entries: ContentEntry[] = (answer.entries ?? []).map((entry) => ({
        path: joinContentPath(at, entry.name),
        name: entry.name,
        kind: entry.kind,
      }));
      return entries.sort((a, b) => compareContentNames(a.name, b.name));
    },

    watch(listener) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  };

  /**
   * Диалогов выбора у вкладки нет: корень дерева здесь — свойство оболочки
   * (CONT-5), а не выбор автора. Шов ровно на этот случай и различает «автор
   * отказался» от «диалога нет» одинаковым `undefined` — вызывающий пишется
   * один раз, а выбор ассета ED-20 всё равно делает просмотрщиком, а не
   * системным диалогом.
   */
  const picker: ContentPicker = {
    chooseRoot: () => Promise.resolve(options.root),
    chooseFile: (_request?: ChoiceRequest) => Promise.resolve(undefined),
    chooseDirectory: (_request?: ChoiceRequest) => Promise.resolve(undefined),
  };

  const onBeforeUnload = (event: BeforeUnloadEventLike): void => {
    // Ответ редактора на запрос закрытия (ED-21): пока есть несохранённое и
    // хоть один обработчик отвечает «нельзя», вкладка спрашивает.
    if (!unsaved) return;
    for (const handler of [...closeHandlers]) {
      if (!handler()) {
        event.preventDefault();
        event.returnValue = '';
        return;
      }
    }
  };
  options.window?.addEventListener('beforeunload', onBeforeUnload);

  const windowHost: WindowHost = {
    setTitle(value) {
      options.documentTitle?.set(value);
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
    name: options.name ?? 'web',
    root: options.root,
    content,
    picker,
    window: windowHost,
  };
}
