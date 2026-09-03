/**
 * Стенд демо-арены, поднятый вместе с dev-сервером страницы.
 *
 * Почему это существует: игра вдвоём требует ДВУХ процессов — страницу отдаёт
 * vite, матч держит выделенный стенд (`bin/demo-serve.mjs`, SES-1 `dedicated`),
 * — и второй из них человек до сих пор запускал руками, узнавая об этом из
 * неудачного соединения. Плагин снимает ровно эту ступеньку и ничего больше:
 * стенд остаётся тем же самостоятельным процессом с теми же флагами, его код
 * не тронут, и запускать его отдельно (`npm run demo:serve`) можно как прежде.
 *
 * Плагин живёт в dev-сервере: `apply: 'serve'`, и `vite build` его не содержит.
 * Собранная статика стенда не поднимает и поднять не может — там нет процесса,
 * который бы это делал, и это честная разница сред, а не недоделка. Кнопка,
 * поднимающая стенд из самого приложения, — вопрос десктоп-контейнера
 * (`desktop-shell`), где хост вправе порождать процессы.
 *
 * Занятый порт — не ошибка: стенд, поднятый руками, и есть тот, к которому
 * страница пойдёт. Плагин молча уступает ему и говорит об этом строкой, потому
 * что второй процесс на том же порту всё равно упал бы с EADDRINUSE, и человек
 * читал бы трассу вместо ответа.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedServerUrls } from 'vite';

export interface DemoStandOptions {
  /** Порт стенда; должен совпадать с `DEMO_SERVER_PORT` страницы (`mode.ts`). */
  readonly port: number;
  /** Путь к запускалке стенда. */
  readonly script?: string;
  /** Сколько ждать человека, прежде чем слот займёт бот (BOT-7); undefined — дефолт стенда. */
  readonly botFillMs?: number | undefined;
  /**
   * Разрешить наблюдателя (`netcode-transport` NTR-9): без него режим страницы
   * `?observer` получает названный отказ. Решением ЗАПУСКА оно и остаётся —
   * сетевой аутентификации нет, а `npm run demo:lan` зовёт второго человека по
   * сети, и полный поток по умолчанию отдал бы ему чужую половину тумана.
   */
  readonly observer?: boolean;
}

const STAND_SCRIPT = fileURLToPath(new URL('../bin/demo-serve.mjs', import.meta.url));

/** Префикс строк стенда в общем логе: две ленты в одной консоли надо различать. */
const TAG = '[стенд]';

/**
 * Аргументы запуска стенда. Отдельной функцией — потому что это единственное
 * место, где сборка выбирает ЗА человека, и проверяться оно должно без спавна.
 */
export function standArgs(options: DemoStandOptions): readonly string[] {
  const args = [options.script ?? STAND_SCRIPT, '--port', String(options.port)];
  if (options.botFillMs !== undefined) args.push('--bot-fill-ms', String(options.botFillMs));
  if (options.observer === true) args.push('--observer');
  return args;
}

/**
 * Ссылка, которую хозяин машины отдаёт второму игроку, — или `null`, если
 * dev-сервер слушает только loopback и звать по ней некуда.
 *
 * Параметр `?server=` намеренно ПУСТОЙ: пустой означает «адрес выводится из
 * страницы» (`demoMode`), то есть ссылка сама приведёт гостя на стенд той
 * машины, чью страницу он открыл. Вписать сюда конкретный адрес значило бы
 * завести второе место, где решается тот же вопрос.
 */
export function shareLink(urls: ResolvedServerUrls | null): string | null {
  const network = urls?.network[0];
  return network === undefined ? null : `${network}${network.includes('?') ? '&' : '?'}server=`;
}

/** Занят ли порт: короткая проба соединением, без ожидания в секунды. */
function portBusy(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (busy: boolean): void => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      done(true);
    });
    socket.once('timeout', () => {
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/**
 * Плагин dev-сервера: поднять стенд рядом со страницей и снять его вместе с ней.
 *
 * Отключается переменной среды `DEMO_STAND=off` — тому, кто гоняет стенд со
 * своими флагами, автозапуск мешает.
 */
export function demoStand(options: DemoStandOptions): Plugin {
  let child: ChildProcess | null = null;
  return {
    name: 'demo-stand',
    apply: 'serve',
    configureServer(server) {
      const log = (line: string): void => {
        server.config.logger.info(line);
      };
      if (process.env.DEMO_STAND === 'off') {
        log(`${TAG} автозапуск выключен (DEMO_STAND=off)`);
        return;
      }
      const started = portBusy(options.port).then((busy) => {
        if (busy) {
          log(`${TAG} порт ${options.port} уже занят — свой не поднимаю`);
          return;
        }
        // Вывод стенда идёт в тот же терминал НЕТРОНУТЫМ: его строка состояния
        // матча переписывает себя `\r`, и пересборка её по строкам превратила
        // бы одну живую строку в ленту из сотен.
        child = spawn(process.execPath, [...standArgs(options)], { stdio: 'inherit' });
        child.once('exit', (code) => {
          child = null;
          if (code !== 0 && code !== null) log(`${TAG} завершился с кодом ${code}`);
        });
      });
      // Стенд живёт ровно столько, сколько dev-сервер: осиротевший процесс
      // держал бы порт и принимал бы игроков в матч, страницы которого уже нет.
      const stop = (): void => {
        void started.then(() => child?.kill());
      };
      server.httpServer?.once('close', stop);
      process.once('exit', stop);

      // Печать — поверх штатной, чтобы попасть в тот же блок адресов и уже
      // после того, как vite их разрешил.
      const printUrls = server.printUrls.bind(server);
      server.printUrls = (): void => {
        printUrls();
        const link = shareLink(server.resolvedUrls);
        if (link === null) {
          log(`  ${TAG} матч вдвоём: перезапустите с --host, чтобы позвать второго игрока`);
          return;
        }
        log(`  ${TAG} матч вдвоём — ссылка второму игроку: ${link}`);
      };
    },
  };
}
