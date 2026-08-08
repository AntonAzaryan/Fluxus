/**
 * Серверная половина веб-хоста среды (ED-12): перечисление дерева контента,
 * запись документа и канал внешних изменений.
 *
 * Почему это вообще существует: у HTTP нет перечисления каталога и нет записи
 * файла, а ED-12 требует, чтобы набор возможностей авторинга совпадал в вебе и
 * на десктопе. Дерево читает тот, у кого оно есть, — сервер оболочки; браузер
 * остаётся браузером. Обоснование выбора и его границы — в шапке
 * `src/host/web.ts`; здесь только исполнение.
 *
 * Плагин живёт в dev-сервере. Сборка `vite build` его не содержит: выложенная
 * статикой, она даёт редактору чтение и не даёт ни перечисления, ни записи —
 * и говорит об этом ошибкой, а не пустым деревом.
 *
 * Наружу за корень дерева не выходит ничего: путь нормализуется и проверяется
 * на принадлежность корню (та же граница, что у загрузчика ассетов, ASSET-3).
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Connect, Plugin, ViteDevServer } from 'vite';

export interface ContentEndpointOptions {
  /** Абсолютный путь корня дерева контента на диске. */
  readonly root: string;
  /** Маршрут эндпойнта; должен совпадать с `route` веб-хоста. */
  readonly route?: string;
  /** Имя события, которым сервер сообщает вкладке о правке дерева извне. */
  readonly event?: string;
}

const DEFAULT_ROUTE = '/__content';
const DEFAULT_EVENT = 'fx:content';

type Kind = 'file' | 'directory' | 'missing';

/**
 * Путь внутри дерева или `null` — попытка выйти за корень. Экспортирована ради
 * теста намеренно: между dev-сервером и файловой системой машины стоит одна эта
 * функция, и проверять её через живой HTTP значило бы не проверять вовсе.
 */
export function resolveInside(root: string, path: string): string | null {
  const cleaned = path.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (cleaned.includes('..')) return null;
  const absolute = resolve(join(root, ...cleaned));
  const inside = resolve(root);
  if (absolute !== inside && !absolute.startsWith(inside + sep)) return null;
  return absolute;
}

async function kindOf(absolute: string): Promise<Kind> {
  try {
    const info = await stat(absolute);
    return info.isDirectory() ? 'directory' : 'file';
  } catch {
    return 'missing';
  }
}

async function body(request: Connect.IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const part = chunk as Uint8Array;
    chunks.push(part);
    length += part.byteLength;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

export function contentEndpoint(options: ContentEndpointOptions): Plugin {
  const route = options.route ?? DEFAULT_ROUTE;
  const event = options.event ?? DEFAULT_EVENT;
  const root = resolve(options.root);

  return {
    name: 'fluxus-content-endpoint',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(route)) {
          next();
          return;
        }
        const parsed = new URL(url, 'http://localhost');
        const path = parsed.searchParams.get('path') ?? '';
        const absolute = resolveInside(root, path);
        if (absolute === null) {
          // Отказ со своей причиной: за корень дерева не выходит ничего
          // (CONT-1, ASSET-3), и путать это с «эндпойнта здесь нет» нельзя.
          reply(response, 400, { kind: 'missing', reason: `путь "${path}" выходит за корень дерева` });
          return;
        }

        const method = request.method ?? 'GET';
        const done = (async (): Promise<void> => {
          if (method === 'GET') {
            const kind = await kindOf(absolute);
            if (kind !== 'directory') {
              reply(response, 200, { kind });
              return;
            }
            const found = await readdir(absolute, { withFileTypes: true });
            reply(response, 200, {
              kind,
              entries: found.map((entry) => ({
                name: entry.name,
                kind: entry.isDirectory() ? 'directory' : 'file',
              })),
            });
            return;
          }
          if (method === 'PUT') {
            const existed = (await kindOf(absolute)) === 'file';
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, await body(request));
            reply(response, existed ? 200 : 201, { kind: 'file', created: !existed });
            return;
          }
          reply(response, 405, { kind: 'missing', reason: `метод ${method} эндпойнту дерева неизвестен` });
        })();
        done.catch((error: unknown) => {
          reply(response, 500, {
            kind: 'missing',
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      });

      // Канал внешних изменений (ED-12): у вкладки своего наблюдателя за
      // деревом нет и быть не может — за неё смотрит сервер.
      const inside = (file: string): string | null => {
        const absolute = resolve(file);
        if (!absolute.startsWith(root + sep)) return null;
        return absolute.slice(root.length + 1).split(sep).join('/');
      };
      const send = (kind: 'created' | 'modified' | 'removed') => (file: string): void => {
        const path = inside(file);
        if (path === null) return;
        server.hot.send({ type: 'custom', event, data: { path, kind } });
      };
      server.watcher.add(root);
      server.watcher.on('add', send('created'));
      server.watcher.on('change', send('modified'));
      server.watcher.on('unlink', send('removed'));
    },
  };
}
