/**
 * Vite-конфиг демо. Корень — сам каталог app/ (index.html и main.ts здесь),
 * контент раздаётся из корня дерева контента `content/` (CONT-5: путь до корня
 * дерева — свойство оболочки, а сами документы ссылаются друг на друга
 * относительно). Пакеты @fluxus/* подключены как file: симлинки на каталоги
 * engine/ соседнего верхнего уровня, поэтому dev-серверу разрешается читать
 * весь репозиторий, а кэш оптимизатора уводится в node_modules пакета.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { demoStand } from './demoStand.js';
import { demoTunnel, STAND_PROXY_PATH } from './tunnel.js';
import { DEMO_SERVER_PORT } from './mode.js';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const contentRoot = fileURLToPath(new URL('../../../content', import.meta.url));

export default defineConfig(({ mode }) => ({
  // Стенд матча поднимается вместе с dev-сервером: игра вдвоём — это два
  // процесса, и второй из них человеку запускать незачем. Обоснование и
  // границы — в шапке `demoStand.ts`. Туннель наружу (`npm run demo:tunnel`) —
  // только по явному режиму: страница становится доступна из интернета, и
  // включаться это обязано намерением, а не каждым `npm run demo` (`tunnel.ts`).
  plugins: [
    demoStand({
      port: DEMO_SERVER_PORT,
      botFillMs:
        process.env.DEMO_BOT_FILL_MS !== undefined
          ? Number(process.env.DEMO_BOT_FILL_MS)
          : undefined,
      // Наблюдатель (NTR-9) — по намерению, а не по умолчанию: `DEMO_OBSERVER=on
      // npm run demo` поднимает стенд, который пускает страницу `?observer`.
      // Симметрично `DEMO_STAND=off` и по той же причине, по которой флаг вообще
      // существует: поток без фильтрации на машине, зовущей второго игрока по
      // сети (`npm run demo:lan`), включается решением человека.
      observer: process.env.DEMO_OBSERVER === 'on',
    }),
    ...(mode === 'tunnel' ? [demoTunnel()] : []),
  ],
  root: appRoot,
  publicDir: contentRoot,
  cacheDir: '../node_modules/.vite-demo',
  server: {
    fs: { allow: [repoRoot] },
    // WebSocket стенда — прокси-путём на порту САМОЙ страницы: снаружи (туннель,
    // `tunnel.ts`) открыт ровно один порт, и оба потока обязаны ехать через
    // него. Слушающая сторона стенда путь не читает (`webSocketTransportServer`),
    // локальной игре прокси не мешает — прямой адрес `:8080` работает как прежде.
    proxy: {
      [STAND_PROXY_PATH]: { target: `ws://127.0.0.1:${DEMO_SERVER_PORT}`, ws: true },
    },
    // Запросы туннеля приходят с Host случайного адреса quick-туннеля, и без
    // этого dev-сервер их отбивал бы защитой от DNS rebinding. Разрешение — на
    // домен quick-туннелей и только в режиме туннеля.
    ...(mode === 'tunnel' ? { allowedHosts: ['.trycloudflare.com'] } : {}),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
}));
