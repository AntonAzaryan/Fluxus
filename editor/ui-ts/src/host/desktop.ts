/**
 * Десктопная реализация хоста среды (ED-12) — поверх моста контейнера
 * (`desktop-shell` DSK-2).
 *
 * Адаптер живёт здесь, а не в контейнере, и это требование, а не вкус: «типы
 * движка, JSON-схемы контента и предметные операции MUST NOT пересекать
 * границу контейнера», а `ContentTreeHost`, `ContentPicker` и `WindowHost` —
 * предметные интерфейсы редактора (DSK-2). Контейнер знает пути, байты и
 * события; редактор знает документы. Переводит одно в другое этот файл — и
 * ничего, кроме него.
 *
 * ## Зависимость направлена от приложения к границе
 *
 * Отсюда импортируются типы `@fluxus/desktop-shell/bridge` — слой без единой
 * зависимости, описывающий ГРАНИЦУ. Обратной связи нет: контейнер о редакторе
 * не знает и знать не может, это проверяется гейтом (DSK-3).
 *
 * ## Чего среда не даёт, она говорит честно
 *
 * Профиль объявляет whitelist (DSK-5), и возможность, которой он не дал, не
 * приходит в страницу вовсе — соответствующего поля моста просто нет. Шов
 * среды ровно на этот случай и написан: наблюдения нет — `watch` отдаёт
 * отписку и молчит; диалога нет — `undefined`; окна нет — заголовок никуда не
 * идёт. А вот чтения и записи молча не бывает: их отсутствие — отказ,
 * называющий путь и возможность, а не пустое дерево и не притворно удавшееся
 * сохранение (то же правило, что у веб-хоста в статической выкладке).
 *
 * ## Корень выбирается профилем, а не диалогом
 *
 * `chooseRoot` отдаёт корень, объявленный профилем, и не открывает системный
 * диалог: выдать доступ к произвольному каталогу значило бы расширить профиль
 * на живой сессии, чего DSK-5 не допускает. Диалоги выбора файла и каталога
 * при этом работают — они выбирают путь ВНУТРИ объявленного корня.
 */
import type {
  BridgeCapability,
  BridgePath,
  BridgeRootId,
  DesktopBridge,
} from '@fluxus/desktop-shell/bridge';
import {
  normalizeContentPath,
  type ChoiceRequest,
  type CloseRequestHandler,
  type ContentEntry,
  type ContentPath,
  type ContentPicker,
  type ContentRootInfo,
  type ContentTreeHost,
  type ContentWatcher,
  type EnvironmentHost,
  type WindowHost,
} from '@fluxus/editor-core';

export interface DesktopHostOptions {
  /** Имя реализации для диагностики; ветвиться по нему запрещено (ED-12). */
  readonly name?: string;
  /**
   * Имя корня дерева контента в профиле контейнера. По умолчанию — первый
   * объявленный: у профиля редактора он единственный.
   */
  readonly root?: BridgeRootId;
  /**
   * Строковые ресурсы для заголовка системного диалога (ED-27). Нет
   * переводчика — заголовка нет: показать автору ключ ресурса хуже, чем
   * показать заголовок среды по умолчанию.
   */
  readonly translate?: (key: string) => string | undefined;
}

/** Отказ, называющий и путь, и возможность, которой профиль не дал. */
function refuse(what: string, path: ContentPath, capability: BridgeCapability): Error {
  return new Error(
    `дерево контента: ${what} "${path}" — профиль контейнера не даёт возможности "${capability}" (DSK-5)`,
  );
}

/** Байты моста → буфер шва. Копия своя: чужим буфером мост дальше не владеет. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function entryOf(path: BridgePath, name: string, kind: 'file' | 'directory'): ContentEntry {
  return { path, name, kind };
}

export function createDesktopHost(
  bridge: DesktopBridge,
  options: DesktopHostOptions = {},
): EnvironmentHost {
  const declared = options.root ?? bridge.session.roots[0]?.id;
  if (declared === undefined) {
    throw new Error('мост контейнера не объявил ни одного корня: дереву контента негде быть (DSK-5)');
  }
  const root = declared;
  const view = bridge.session.roots.find((entry) => entry.id === root);
  const info: ContentRootInfo = { label: view?.label ?? root };

  const content: ContentTreeHost = {
    async read(path) {
      const at = normalizeContentPath(path);
      if (bridge.read === undefined) throw refuse('чтение', at, 'read');
      return toBuffer(await bridge.read(root, at));
    },

    async write(path, bytes) {
      const at = normalizeContentPath(path);
      if (bridge.write === undefined) throw refuse('запись', at, 'write');
      // Копия, а не байты вызывающего: за границу уходит буфер, которым
      // дальше владеет контейнер.
      const payload = new Uint8Array(bytes.byteLength);
      payload.set(bytes);
      await bridge.write(root, at, payload);
      // О собственной записи наблюдатели узнают от контейнера — он же и
      // видит её на диске. Второго уведомления отсюда не нужно.
    },

    async stat(path) {
      const at = normalizeContentPath(path);
      if (bridge.stat === undefined) throw refuse('поиск', at, 'read');
      const found = await bridge.stat(root, at);
      return found === undefined ? undefined : entryOf(found.path, found.name, found.kind);
    },

    async list(path) {
      const at = normalizeContentPath(path);
      if (bridge.list === undefined) throw refuse('перечисление', at, 'read');
      const entries = await bridge.list(root, at);
      // Порядок нормирован обеими сторонами одинаково (`host/paths.ts`
      // контейнера и `compareContentNames` шва), поэтому пересортировки нет.
      return entries.map((entry) => entryOf(entry.path, entry.name, entry.kind));
    },

    watch(listener: ContentWatcher) {
      // Наблюдения профиль мог не дать — тогда хост молчит: корректность
      // редактора от уведомления не зависит, только свежесть картинки (ED-12).
      if (bridge.watch === undefined) return () => undefined;
      return bridge.watch(root, (change) => {
        if (change.root !== root) return;
        listener({ path: change.path, kind: change.kind });
      });
    },
  };

  const choose = async (
    kind: 'file' | 'directory',
    request?: ChoiceRequest,
  ): Promise<ContentPath | undefined> => {
    if (bridge.choose === undefined) return undefined;
    const title = request?.titleKey === undefined ? undefined : options.translate?.(request.titleKey);
    const answer = await bridge.choose({
      root,
      kind,
      ...(request?.startIn === undefined ? {} : { startIn: request.startIn }),
      ...(request?.extensions === undefined ? {} : { extensions: request.extensions }),
      ...(title === undefined ? {} : { title }),
    });
    return answer?.path;
  };

  const picker: ContentPicker = {
    // Корень открытого проекта — свойство профиля контейнера (DSK-5), как в
    // вебе он свойство оболочки (CONT-5). Диалога здесь поэтому нет.
    chooseRoot: () => Promise.resolve(info),
    chooseFile: (request) => choose('file', request),
    chooseDirectory: (request) => choose('directory', request),
  };

  const windowHost: WindowHost = {
    setTitle(value) {
      // Возможности `window` профиль мог не дать — тогда заголовок никуда не
      // идёт, и это нормальный ответ среды, а не отказ (ED-12).
      if (bridge.setTitle !== undefined) bridge.setTitle(value);
    },
    setUnsaved(unsaved) {
      if (bridge.setUnsaved !== undefined) bridge.setUnsaved(unsaved);
    },
    onCloseRequest(handler: CloseRequestHandler) {
      if (bridge.onCloseRequest === undefined) return () => undefined;
      return bridge.onCloseRequest(handler);
    },
  };

  return {
    name: options.name ?? 'desktop',
    root: info,
    content,
    picker,
    window: windowHost,
  };
}
