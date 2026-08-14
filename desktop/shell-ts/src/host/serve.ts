/**
 * Раздача бандла и дерева контента (DSK-4) — байтами, без единого знания о том,
 * что за документ раздаётся.
 *
 * ## Одно адресное пространство на бандл и дерево
 *
 * Слои перечислены по порядку, первое попадание выигрывает: сперва бандл, потом
 * раздаваемые корни. Ровно так дерево контента раздают dev-сервера обоих
 * веб-приложений (`publicDir: content/` в конфигах vite редактора и демо), и
 * поэтому адресация ассета путём от корня дерева (`assets` ASSET-2) работает в
 * контейнере без единой правки приложения: `fetch('/<id>')` попадает в тот же
 * файл, что и в браузере. Своё пространство имён у дерева (`/@content/...`)
 * потребовало бы от приложения знать адрес контейнера — то, что DSK-4 прямо
 * запрещает.
 *
 * Совпадение имён разрешается порядком: файл бандла закрывает одноимённый файл
 * дерева. Это свойство названо, а не случайно, — то же правило и у vite.
 *
 * ## Отказ — значение, а не исключение
 *
 * Раздача стоит на пути запроса страницы: сорвавшийся запрос обязан стать
 * ответом «нет такого» с причиной, а не исключением в главном процессе
 * контейнера. Отказывает и слой: путь, разрешающийся за корень по ссылке
 * внутри дерева, корень отвергает (DSK-5), и раздача превращает этот отказ в
 * ответ 400 — не притворяясь, что файла просто нет, и не роняя обработчик.
 */
import type { BridgeRootId } from '../bridge/types.js';
import { hostPathExtension, normalizeHostPath, type HostPath } from './paths.js';
import type { HostRoot } from './root.js';

export interface ServedFile {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** Из какого слоя пришли байты — нужно диагностике, не приложению. */
  readonly root: BridgeRootId;
  readonly path: HostPath;
}

export interface ServeRefusal {
  readonly ok: false;
  /** 400 — запрос выходит за корни, 404 — такого файла нет ни в одном слое. */
  readonly status: 400 | 404;
  readonly reason: string;
}

export type ServeResult = ServedFile | ServeRefusal;

export interface StaticServerOptions {
  /** Слои по порядку разрешения: бандл, затем раздаваемые корни. */
  readonly layers: readonly HostRoot[];
  /** Документ каталога; по умолчанию `index.html`. */
  readonly entry?: string;
}

export interface StaticServer {
  /** Путь запроса (без схемы и хоста, `/` в начале допустим). */
  serve(pathname: string): Promise<ServeResult>;
  readonly layers: readonly HostRoot[];
}

const DEFAULT_ENTRY = 'index.html';

/**
 * Тип содержимого по расширению. Список — данные модуля: он про то, чем
 * репозиторий раздаёт бандл и контент, и правка обязана попадать в дифф.
 * Неизвестное расширение раздаётся байтами — `fetch` их и ждёт (ASSET-3
 * ключует загрузчики расширением сам).
 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeOf(path: HostPath): string {
  return MIME[hostPathExtension(path)] ?? 'application/octet-stream';
}

/** Путь запроса → путь дерева. `null` — запрос выходит за корни. */
export function requestPath(pathname: string): HostPath | null {
  const withoutQuery = pathname.split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  try {
    return normalizeHostPath(decoded);
  } catch {
    return null;
  }
}

export function createStaticServer(options: StaticServerOptions): StaticServer {
  const entry = options.entry ?? DEFAULT_ENTRY;
  const layers = options.layers;

  const fileIn = async (root: HostRoot, path: HostPath): Promise<ServedFile | null> => {
    const found = await root.stat(path);
    if (found === undefined) return null;
    const target = found.kind === 'directory' ? `${path === '' ? '' : `${path}/`}${entry}` : path;
    if (found.kind === 'directory' && (await root.stat(target)) === undefined) return null;
    return { ok: true, bytes: await root.read(target), mime: mimeOf(target), root: root.id, path: target };
  };

  return {
    layers,
    async serve(pathname) {
      const path = requestPath(pathname);
      if (path === null) {
        return { ok: false, status: 400, reason: `запрос "${pathname}" выходит за корни контейнера (DSK-5)` };
      }
      for (const layer of layers) {
        let served: ServedFile | null;
        try {
          served = await fileIn(layer, path);
        } catch (error) {
          // Отказ слоя — не «нет такого»: слой сказал, что путь за его корнем
          // (ссылка наружу) или файл не читается. Перебор слоёв на этом
          // прекращается: отказ разрешения — ответ, а не промах.
          return {
            ok: false,
            status: 400,
            reason: `запрос "${pathname}" отвергнут слоем "${layer.id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        if (served !== null) return served;
      }
      return {
        ok: false,
        status: 404,
        reason: `"${path}" не найден ни в одном раздаваемом слое (${layers.map((l) => l.id).join(', ')})`,
      };
    },
  };
}
