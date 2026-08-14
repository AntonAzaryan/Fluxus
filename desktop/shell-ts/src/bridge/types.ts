/**
 * Словарь границы контейнера (DSK-2): пути, байты, события, диалоги, окно — и
 * ничего сверх того.
 *
 * Этот файл — единственная нормативная поверхность десктоп-контейнера. Он
 * НИЧЕГО не импортирует, и это не аккуратность, а условие: типы движка, схемы
 * контента и предметные операции границу не пересекают (DSK-2), а приложениям
 * (редактору, игровому клиенту) эти типы импортировать можно — направление
 * зависимости «приложение → контракт», контейнер о приложениях не знает
 * (DSK-3).
 *
 * ## Почему поверхность плоская, а возможности — необязательные поля
 *
 * Профиль объявляет whitelist возможностей (DSK-5), и «возможность, не
 * объявленная профилем, MUST NOT быть достижима» проверяется здесь же типом:
 * непредоставленная операция не приходит в страницу вовсе — поле отсутствует.
 * Альтернатива — метод, отвечающий отказом, — оставляла бы в странице вызов,
 * который «почти работает», и превращала бы границу профиля в проверку времени
 * исполнения вместо отсутствия канала.
 *
 * ## Чего здесь нет намеренно
 *
 * - **Удаления файла.** Ни одно требование его не просит, а разрушающая
 *   операция, которую обязана реализовать каждая реализация контейнера,
 *   заводится под требование, а не про запас (то же основание, по которому его
 *   нет в шве среды редактора, ED-12).
 * - **Открытия произвольного каталога.** Диалог выбирает путь ВНУТРИ уже
 *   объявленного корня; выдать доступ к новому каталогу он не может — это было
 *   бы расширение профиля на живой сессии, которое DSK-5 запрещает.
 * - **Строк интерфейса.** Заголовок диалога приходит готовой строкой: ресурсы и
 *   локали — дело приложения (редактор — ED-27), контейнер текстов не знает.
 */

/** Имя контракта в странице: по нему приложение опознаёт мост. */
export const BRIDGE_API = 'fluxus-desktop-bridge';

/**
 * Версия контракта. Растёт при несовместимой смене поверхности; приложение
 * вправе на неё смотреть, реализация контейнера обязана её сообщать.
 */
export const BRIDGE_VERSION = 1;

/** Имя поля в `globalThis`, под которым контейнер публикует мост. */
export const BRIDGE_GLOBAL = 'fluxusDesktop';

/**
 * Путь внутри объявленного корня. Разделитель всегда `/`, ведущего слэша нет,
 * пустая строка — сам корень. Форма пути — свойство дерева, а не той ОС, где
 * контейнер сегодня запущен (то же правило, что у путей дерева контента,
 * `assets` ASSET-2).
 */
export type BridgePath = string;

/** Имя объявленного профилем корня: `content`, `bundle`. */
export type BridgeRootId = string;

export type BridgeEntryKind = 'file' | 'directory';

export interface BridgeEntry {
  readonly path: BridgePath;
  /** Последний сегмент пути: вызывающему он нужен без повторного разбора. */
  readonly name: string;
  readonly kind: BridgeEntryKind;
}

export type BridgeChangeKind = 'created' | 'modified' | 'removed';

/** Изменение в корне. Приходит и о чужих правках, и о собственных записях моста. */
export interface BridgeChange {
  readonly root: BridgeRootId;
  readonly path: BridgePath;
  readonly kind: BridgeChangeKind;
}

export type BridgeChangeListener = (change: BridgeChange) => void;

/** Отписка. Возвращается синхронно там, где подписка синхронна. */
export type BridgeUnsubscribe = () => void;

/**
 * Возможности моста — единица whitelist'а профиля (DSK-5).
 *
 * `read` — это чтение дерева целиком: байты, `stat` и перечисление каталога.
 * Дробить их незачем: приложение, которому позволено прочитать файл, ничего не
 * узнаёт нового, перечислив каталог, а профиль без перечисления не описывает ни
 * одного реального применения.
 */
export type BridgeCapability = 'read' | 'write' | 'watch' | 'dialog' | 'window';

/** Все возможности контракта. Реализация профиля сверяется с этим списком. */
export const BRIDGE_CAPABILITIES: readonly BridgeCapability[] = [
  'read',
  'write',
  'watch',
  'dialog',
  'window',
];

/** Что приложение знает о корне, объявленном профилем. */
export interface BridgeRootView {
  readonly id: BridgeRootId;
  /** Показываемое имя корня. Пути ОС наружу не выходят: в вебе их не бывает. */
  readonly label: string;
  /** Разрешена ли запись в этот корень. Профиль игры даёт `false` (DSK-5). */
  readonly writable: boolean;
  /**
   * Базовый адрес раздачи корня; пустая строка — корень не раздаётся (DSK-4).
   * Адрес сообщает контейнер: схему и транспорт своей раздачи он вправе менять,
   * и приложение их у себя не зашивает.
   */
  readonly base: string;
}

/**
 * Описание сессии: что за профиль запущен, какие корни объявлены и какие
 * возможности объявлены. Фиксируется на старте окна и на живой сессии не
 * меняется (DSK-5).
 */
export interface BridgeSession {
  /** Идентификатор профиля — для диагностики; ветвление по нему приложением — дефект. */
  readonly profile: string;
  readonly capabilities: readonly BridgeCapability[];
  readonly roots: readonly BridgeRootView[];
}

/** Запрос к диалогу выбора. Всё в нём — подсказка среде, а не проверка. */
export interface BridgeChoiceRequest {
  /** Корень, внутри которого идёт выбор: наружу диалог не выпускает (DSK-5). */
  readonly root: BridgeRootId;
  readonly kind: BridgeEntryKind;
  /** Каталог, с которого открывается диалог. */
  readonly startIn?: BridgePath;
  /** Расширения с точкой: `['.mdx']`. */
  readonly extensions?: readonly string[];
  /** Готовая строка заголовка: ресурсы и локали — дело приложения. */
  readonly title?: string;
}

/** Что выбрал автор. Отказ автора и отсутствие диалога — одинаково `undefined`. */
export interface BridgeChoice {
  readonly root: BridgeRootId;
  readonly path: BridgePath;
}

/**
 * Ответ приложения на запрос закрытия окна: `true` — закрывать безопасно.
 * Асинхронный, потому что у окна контейнера, в отличие от вкладки браузера,
 * ответа дождаться можно.
 */
export type BridgeCloseHandler = () => boolean | Promise<boolean>;

/**
 * Мост контейнера — вся поверхность хостовых возможностей страницы (DSK-5:
 * «единственная поверхность хостовых возможностей — мост, объявленный
 * профилем»).
 */
export interface DesktopBridge {
  /** Имя контракта: `BRIDGE_API`. Отличает мост от чужого объекта в странице. */
  readonly api: string;
  readonly version: number;
  readonly session: BridgeSession;

  /** capability `read`: байты файла. Отсутствие файла — отказ, называющий путь. */
  readonly read?: (root: BridgeRootId, path: BridgePath) => Promise<Uint8Array>;
  /** capability `read`: что лежит по пути; `undefined` — ничего. */
  readonly stat?: (root: BridgeRootId, path: BridgePath) => Promise<BridgeEntry | undefined>;
  /** capability `read`: содержимое каталога на один уровень, порядок нормирован. */
  readonly list?: (root: BridgeRootId, path: BridgePath) => Promise<readonly BridgeEntry[]>;
  /** capability `write`: запись байтов; недостающие каталоги создаёт контейнер. */
  readonly write?: (root: BridgeRootId, path: BridgePath, bytes: Uint8Array) => Promise<void>;
  /** capability `watch`: подписка на изменения корня. */
  readonly watch?: (root: BridgeRootId, listener: BridgeChangeListener) => BridgeUnsubscribe;
  /** capability `dialog`: выбор пути внутри объявленного корня. */
  readonly choose?: (request: BridgeChoiceRequest) => Promise<BridgeChoice | undefined>;
  /** capability `window`: заголовок окна. */
  readonly setTitle?: (title: string) => void;
  /** capability `window`: признак несохранённого — метка окна и вопрос при закрытии. */
  readonly setUnsaved?: (unsaved: boolean) => void;
  /** capability `window`: контейнер спрашивает, приложение отвечает. */
  readonly onCloseRequest?: (handler: BridgeCloseHandler) => BridgeUnsubscribe;
}

/**
 * Мост страницы, если он там есть. Один вход для приложений: признак десктопа —
 * наличие моста, а не строка user-agent и не флаг сборки (DSK-1 — приложение
 * остаётся тем же веб-приложением).
 */
export function desktopBridgeOf(scope: unknown): DesktopBridge | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const candidate = (scope as Record<string, unknown>)[BRIDGE_GLOBAL];
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const bridge = candidate as { api?: unknown; session?: unknown };
  if (bridge.api !== BRIDGE_API) return undefined;
  if (typeof bridge.session !== 'object' || bridge.session === null) return undefined;
  return candidate as DesktopBridge;
}

/** Объявлена ли возможность сессией. Проверка одна на все реализации. */
export function sessionGrants(session: BridgeSession, capability: BridgeCapability): boolean {
  return session.capabilities.includes(capability);
}

/** Описание корня по имени; `undefined` — профиль такого корня не объявлял. */
export function sessionRoot(session: BridgeSession, root: BridgeRootId): BridgeRootView | undefined {
  return session.roots.find((entry) => entry.id === root);
}
