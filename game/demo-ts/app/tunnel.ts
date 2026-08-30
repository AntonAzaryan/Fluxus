/**
 * Туннель наружу: игра вдвоём ЧЕРЕЗ ИНТЕРНЕТ без аренды сервера и без установки
 * чего-либо у второго игрока (`npm run demo:tunnel`).
 *
 * Почему это существует: `demo:lan` зовёт друга по адресу локальной сети, и
 * дальше её этот адрес не работает — NAT домашнего роутера входящих не пускает.
 * Аренда VPS или VPN-инструменты (Hamachi, Tailscale) решают это ценой установки
 * у ОБОИХ игроков; quick-туннель cloudflared — ценой установки только у хоста:
 * второму игроку уходит обычная https-ссылка.
 *
 * Туннель ОДИН, и это держится на двух существующих решениях сборки:
 * dev-сервер отдаёт и страницу, и — прокси-путём `/stand` (`vite.config.ts`) —
 * WebSocket стенда, поэтому обе ленты едут одним https/wss-адресом; а явный
 * `?server=<url>` страница уже понимает (`mode.ts`), и ссылка сама приводит
 * гостя на стенд хоста. Схема в ссылке — `wss`: страница за `https` блокирует
 * `ws://` как mixed content, TLS терминирует сам туннель.
 *
 * cloudflared — не библиотека, а отдельный процесс (Go-демон), поэтому плагин
 * его СПАВНИТ, как `demoStand` спавнит стенд, и снимает вместе с dev-сервером.
 * Отсутствие бинаря — названный отказ с подсказкой установки, а не трасса
 * ENOENT: ставит его только хост, и ровно один раз.
 *
 * Плата известна и честна: адрес quick-туннеля случаен и живёт до перезапуска
 * процесса (ссылку надо прислать другу заново), а трафик идёт через edge
 * Cloudflare — то есть пинг длиннее прямого. Для теста движка вдвоём это
 * приемлемо; выделенному серверу интернет-матча отвечает `server-control`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Plugin } from 'vite';

/**
 * Путь WebSocket-прокси до стенда на dev-сервере страницы. Константа сборки,
 * как `DEMO_SERVER_PORT` (`mode.ts`): её знают конфиг vite (слушающая сторона)
 * и ссылка туннеля (зовущая), и жить она обязана в одном месте — разъехавшийся
 * путь означал бы ссылку, по которой матч «не отвечает».
 */
export const STAND_PROXY_PATH = '/stand';

/** Адрес quick-туннеля в строке вывода cloudflared; `null` — в этой строке его нет. */
export function quickTunnelUrl(line: string): string | null {
  const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
  return found === null ? null : found[0];
}

/**
 * Ссылка второму игроку: страница туннеля с ЯВНЫМ адресом стенда — `wss` на тот
 * же хост, путём прокси. Вывести адрес из страницы (пустой `?server=`,
 * `demoServerUrl`) здесь нельзя: вывод целится в порт стенда, а у туннеля
 * наружу открыт только https-порт, и оба потока едут через него.
 */
export function tunnelShareLink(tunnelUrl: string): string {
  const page = new URL(tunnelUrl);
  page.searchParams.set('server', `wss://${page.hostname}${STAND_PROXY_PATH}`);
  return page.toString();
}

/**
 * Аргументы запуска cloudflared. Отдельной функцией по той же причине, что
 * `standArgs` (`demoStand.ts`): единственное место, где сборка выбирает за
 * человека, и проверяться оно должно без спавна. `--no-autoupdate` — запущенный
 * рядом с матчем процесс не должен посреди него перекачивать сам себя.
 */
export function tunnelArgs(pagePort: number): readonly string[] {
  return ['tunnel', '--url', `http://127.0.0.1:${pagePort}`, '--no-autoupdate'];
}

/** Префикс строк туннеля в общем логе — тот же приём, что `[стенд]`. */
const TAG = '[туннель]';

/** Подсказка установки: отсутствие бинаря — ожидаемый первый запуск, а не поломка. */
const INSTALL_HINT =
  'cloudflared не найден — установите его хосту (второму игроку не нужно):\n' +
  '  macOS:   brew install cloudflared\n' +
  '  Windows: winget install Cloudflare.cloudflared\n' +
  '  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

/**
 * Сколько вывода cloudflared копится в поиске адреса. Адрес приезжает в первых
 * же строках баннера; потолок нужен потому, что процесс, так его и не назвавший,
 * иначе копил бы свой лог в памяти стенда до конца сессии.
 */
const SCAN_LIMIT = 64 * 1024;

/**
 * Плагин dev-сервера: поднять quick-туннель cloudflared на порт страницы и
 * напечатать ссылку второму игроку. Живёт только в dev (`apply: 'serve'`) и
 * только под `--mode tunnel` (см. `vite.config.ts`): туннель наружу — действие
 * с последствиями (страница становится доступна из интернета), и включаться он
 * обязан явным намерением, а не каждым `npm run demo`.
 */
export function demoTunnel(): Plugin {
  let child: ChildProcess | null = null;
  return {
    name: 'demo-tunnel',
    apply: 'serve',
    configureServer(server) {
      const log = (line: string): void => {
        server.config.logger.info(line);
      };
      // Порт известен только после listen: спавнить раньше значило бы туннелить
      // адрес, которого ещё нет.
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        if (typeof address !== 'object' || address === null) {
          log(`${TAG} dev-сервер слушает не TCP-порт — туннелить нечего`);
          return;
        }
        child = spawn('cloudflared', [...tunnelArgs(address.port)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.once('error', (error: NodeJS.ErrnoException) => {
          child = null;
          log(error.code === 'ENOENT' ? `${TAG} ${INSTALL_HINT}` : `${TAG} ${error.message}`);
        });
        // Адрес cloudflared печатает в stderr, но это деталь его версии, а не
        // контракт — сканируются оба потока. Кусок вправе разрезать адрес
        // пополам, поэтому копится лента, а не проверяется строка.
        let seen = '';
        let announced = false;
        const scan = (chunk: unknown): void => {
          if (announced || seen.length > SCAN_LIMIT) return;
          seen += String(chunk);
          const url = quickTunnelUrl(seen);
          if (url === null) return;
          announced = true;
          seen = '';
          log(`${TAG} матч через интернет — ссылка второму игроку: ${tunnelShareLink(url)}`);
          log(`${TAG} адрес случайный и живёт до остановки dev-сервера`);
        };
        child.stdout?.on('data', scan);
        child.stderr?.on('data', scan);
        child.once('exit', (code) => {
          child = null;
          if (code !== 0 && code !== null) log(`${TAG} cloudflared завершился с кодом ${code}`);
        });
      });
      // Туннель живёт ровно столько, сколько dev-сервер: осиротевший процесс
      // держал бы страницу открытой в интернет после того, как хост всё закрыл.
      const stop = (): void => {
        child?.kill();
      };
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}
