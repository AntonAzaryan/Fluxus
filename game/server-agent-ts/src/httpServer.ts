/**
 * Раздача клиента тестерам (SRV-8, решение D10): собранный клиентский бандл и
 * дерево контента дистрибутива по HTTP — «человеку достаточно браузера и
 * ссылки».
 *
 * ТОЛЬКО чтение: записи в дерево контента через агента не существует — не
 * запрещена проверкой, а не реализована вовсе, и любой метод, кроме `GET` и
 * `HEAD`, получает отказ. Дерево контента раздаётся тем же адресным
 * пространством, что и бандл, и бандл идёт первым слоем: ID-путь ассета
 * (`assets` ASSET-2) обязан работать так же, как в dev-сервере игры.
 *
 * Обычный HTTP, а не HTTPS, и это не упущение: игровой транспорт сегодня —
 * незашифрованный `ws` (граница доверия игрового порта названа в Non-Goals
 * дизайна), и https-страница не смогла бы к нему подключиться из-за mixed
 * content. Шифруется управляющий канал (SRV-3), а не страница игрока.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';

/** Типы, которых достаточно клиентскому бандлу и дереву контента. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mdx': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot < 0 ? undefined : MIME[path.slice(dot)]) ?? 'application/octet-stream';
}

/**
 * Публичный хост из объявленного и слушающего: явный побеждает, иначе — сам
 * `host`, если он называет конкретный интерфейс, а не «все» (`0.0.0.0`/`::`).
 * Общее правило для раздачи и для адреса игрового эндпоинта (`registry.ts`).
 */
export function advertiseOf(explicit: string | undefined, host: string | undefined): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  if (host !== undefined && host !== '' && host !== '0.0.0.0' && host !== '::') return host;
  return '127.0.0.1';
}

/**
 * Путь запроса внутри корня либо `undefined`. Выход за корень — не находка
 * проверки, а отсутствие пути: `..` разрешается ДО обращения к диску, ровно как
 * это делает мост контейнера (DSK-5).
 */
function insideOf(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // `decodeURIComponent` бросает `URIError` на битой процент-последовательности
    // (`/%`, `/%zz`). Раздача НЕ АУТЕНТИФИЦИРОВАНА и слушает наружу, а
    // необработанное исключение в обработчике запроса уронило бы весь агент —
    // процесс, супервизирующий КАЖДЫЙ сервер матча. Битый путь — это отсутствие
    // пути, ровно как выход за корень, а не повод падать.
    return undefined;
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(root, relative);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return undefined;
  return full;
}

export interface HttpServeOptions {
  readonly port: number;
  /** Интерфейс, на котором раздача СЛУШАЕТ; по умолчанию — все (`0.0.0.0`). */
  readonly host?: string;
  /**
   * Публичный хост, которым раздача НАЗЫВАЕТ себя в ссылке входа (SRV-8). Отличен
   * от `host`: слушать на всех интерфейсах и при этом отдавать тестеру
   * `127.0.0.1` — значит отдать ему ссылку на его же машину. По умолчанию —
   * `host`, если он не «все интерфейсы», иначе loopback (агент называет реальное
   * имя, `agent.ts`).
   */
  readonly advertiseHost?: string;
  /** Каталог собранного клиентского бандла; пустая строка — бандла в дистрибутиве нет. */
  readonly bundleDir: string;
  /** Корень дерева контента дистрибутива. */
  readonly contentRoot: string;
}

export interface HttpServe {
  readonly port: number;
  /** Публичный хост раздачи — тот, что в ссылке входа (SRV-8). */
  readonly host: string;
  /** Ссылка входа игрока для сервера по его адресу (SRV-8). */
  joinUrl(address: string): string;
  close(): Promise<void>;
}

/** Слои раздачи: бандл закрывает дерево при совпадении имён — как в контейнере (DSK-4). */
function layerFile(layers: readonly string[], pathname: string): string | undefined {
  for (const root of layers) {
    if (root === '') continue;
    try {
      const candidate = insideOf(root, pathname);
      if (candidate === undefined) continue;
      if (!existsSync(candidate)) continue;
      const stat = statSync(candidate);
      if (stat.isDirectory()) {
        const index = join(candidate, 'index.html');
        // Именно ФАЙЛ: каталог по имени `index.html` (или сокет, или fifo) открыть
        // потоком нельзя, и раздача превратилась бы в отказ на уровне ОС.
        if (existsSync(index) && statSync(index).isFile()) return index;
        continue;
      }
      if (!stat.isFile()) continue;
      return candidate;
    } catch {
      // `statSync` вправе бросить ПОСЛЕ `existsSync`: файл убрали в окне между
      // ними (сборка, чистка каталога), прав на каталог нет, битая ссылка. Без
      // этого перехвата исключение уходит из обработчика запроса и уносит вместе
      // с собой агента и супервизию ВСЕХ его серверов (SRV-1) — с порта, который
      // не аутентифицирует никого (SRV-8). Слой, о котором нельзя сказать, что в
      // нём лежит, — это слой без такого файла: пробуем следующий.
      continue;
    }
  }
  return undefined;
}

export async function startHttpServe(options: HttpServeOptions): Promise<HttpServe> {
  const layers = [options.bundleDir, options.contentRoot];
  const server: Server = createServer((request, response) => {
    // Раздача ТОЛЬКО на чтение (SRV-8): записи через агента не существует.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('раздача агента доступна только на чтение (SRV-8)\n');
      return;
    }
    const pathname = (request.url ?? '/').split('?')[0] ?? '/';
    const file = layerFile(layers, pathname === '/' ? '/index.html' : pathname);
    if (file === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('не найдено\n');
      return;
    }
    response.writeHead(200, { 'content-type': mimeOf(file) });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    // Открытие файла вправе не удаться ПОСЛЕ проверки: файл перезаписан сборкой,
    // прав нет, имя оказалось не файлом. Без слушателя это событие `error` —
    // необработанное, и раздача (порт без всякой аутентификации, SRV-8) уносила
    // бы вместе с собой агента и супервизию всех его серверов (SRV-1).
    createReadStream(file)
      .on('error', () => { response.destroy(); })
      .pipe(response);
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.removeListener('error', fail);
      done();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const host = advertiseOf(options.advertiseHost, options.host);

  return {
    port,
    host,
    joinUrl(serverAddress) {
      // Ссылка входа — СТРАНИЦА АГЕНТА с адресом сервера в параметре (решение
      // D10): игрок открывает её и попадает в матч, ничего не устанавливая.
      // Хост — ПУБЛИЧНЫЙ, а не loopback: ссылка уходит тестеру на другой машине.
      return `http://${host}:${String(port)}/?server=${encodeURIComponent(serverAddress)}`;
    },
    close() {
      return new Promise<void>((done) => {
        server.close(() => { done(); });
        server.closeAllConnections();
      });
    },
  };
}
