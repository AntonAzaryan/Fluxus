/**
 * Объявленные профилем сервисы (DSK-7): поднять, остановить, спросить состояние.
 *
 * Возможность опасна ровно настолько, насколько широко объявление, поэтому из
 * страницы сюда приходит ОДНО имя. Чем запускать, с какими аргументами и по
 * какому адресу — читается из профиля, зафиксированного на старте окна (DSK-5),
 * и подмешать туда что-либо на живой сессии нечем.
 *
 * Что здесь НЕ происходит: разбор вывода процесса, знание его протокола,
 * перезапуск, healthcheck. Контейнер не знает, что за сервис он поднял (DSK-2,
 * DSK-3), — он знает только «процесс жив» и «по адресу отвечают».
 *
 * Модуль — чистый Node: ни Electron, ни IPC. Он и проверяется контрактным
 * сьютом в гейте (DSK-6), а клей реализации только маршрутизирует вызовы.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { profileService, type AppProfile, type ProfileService } from '../bridge/profile.js';
import type { BridgeServiceId, BridgeServiceState } from '../bridge/types.js';
import {
  defaultServiceStateDir,
  detachedFiles,
  detachedSurvivor,
  forgetDetached,
  forgetPin,
  readAddressFile,
  readPinFile,
  servicePinFile,
  serviceSpawnOptions,
  stopPid,
  writePid,
  type DetachedFiles,
} from './detached.js';

/** Сколько ждать готовности сервиса после запуска. */
const READY_TIMEOUT_MS = 10_000;
/** Шаг опроса адреса, пока сервис поднимается. */
const READY_STEP_MS = 50;
/** Сколько ждать штатного выхода после SIGTERM, прежде чем убивать. */
const GRACE_MS = 2000;
/** Проба соединения: короткая, потому что адрес свой же, локальный. */
const PROBE_MS = 300;

export interface HostServicesOptions {
  readonly profile: AppProfile;
  /**
   * Рантайм, которым запускается скрипт сервиса. По умолчанию — тот же
   * исполняемый файл, которым запущен контейнер: у упакованного приложения
   * `node` в `PATH` пользовательской машины может не быть вовсе.
   */
  readonly runtime?: string;
  /** Что добавить к среде процесса: Electron просит `ELECTRON_RUN_AS_NODE`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly readyTimeoutMs?: number;
  readonly graceMs?: number;
  readonly report?: (text: string) => void;
  /**
   * Каталог состояния сервисов (решение D6): там живут адресный файл и pid
   * отвязываемого сервиса, которыми он пере-обнаруживается через границу
   * сессий. Реализация контейнера называет свой (у Electron — каталог данных
   * приложения); умолчание — временный каталог системы.
   */
  readonly stateDir?: string;
}

export interface HostServices {
  /** Поднять объявленный сервис; уже работающему — вернуть его адрес (DSK-7). */
  start(id: BridgeServiceId): Promise<BridgeServiceState>;
  /** Остановить сервис, поднятый ЭТИМ контейнером; чужой — оставить как есть. */
  stop(id: BridgeServiceId): Promise<BridgeServiceState>;
  state(id: BridgeServiceId): Promise<BridgeServiceState>;
  /**
   * Закрепления сертификатов объявленных сервисов (DSK-8, решение D3): те, что
   * сервисы написали сами и что прочитались как отпечатки.
   *
   * Множество, а не адрес и не origin: привязка закрепления к адресу
   * потребовала бы разбирать адресную строку, чего контейнер не вправе (DSK-7).
   * Закрепление по идентичности сертификата строже модели CA и в такой привязке
   * не нуждается.
   *
   * Отвязываемость закрепление не ограничивает: назвать своё вправе ЛЮБОЙ
   * объявленный сервис (DSK-8). Ограничивается СРОК — закрепление отвязываемого
   * читается и через границу сессий, закрепление обычного действует, пока жив
   * поднявший его процесс.
   *
   * Наружу страницы это не выходит: спрашивает реализация контейнера, когда
   * платформа отвергла сертификат, — словарь границы (DSK-2) отсюда ничего не
   * получает.
   */
  certificatePins(): readonly string[];
  /** Сколько процессов контейнер поднял и держит. Нужно проверкам, не странице. */
  owned(): number;
  /** Снять всё поднятое: закрытие сессии и завершение контейнера (DSK-7). */
  closeAll(): Promise<void>;
}

/** Хост и порт адреса, если они в нём есть. Смысла адресу это не придаёт. */
export function endpointOf(address: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.port === '' || url.hostname === '') return undefined;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) };
}

/**
 * Аргументы запуска: `{port}` и `{host}` приезжают из адреса, а не второй
 * записью числа в манифесте (см. `ProfileService`), а `{addressFile}` и
 * `{pinFile}` — из каталога состояния сервисов: пути выбирает контейнер, и
 * страница на них не влияет никак (DSK-7).
 *
 * `{pinFile}` — единственный признак того, что сервис обещает закрепление
 * сертификата (DSK-8, решение D2): новых полей схема профиля не получает, как не
 * получала их и подстановка адресного файла. Сервис, чьё объявление её не
 * подставляет, живёт как жил. Отвязываемости этот признак не спрашивает:
 * закрепление вправе назвать ЛЮБОЙ объявленный сервис, чей канал существует
 * только шифрованным (DSK-8), — см. `servicePinFile`.
 */
export function serviceArgs(
  service: ProfileService,
  addressFile = '',
  pinFile = '',
): readonly string[] {
  const endpoint = endpointOf(service.address);
  return service.args.map((arg) =>
    arg
      .replaceAll('{port}', endpoint === undefined ? '' : String(endpoint.port))
      .replaceAll('{host}', endpoint?.host ?? '')
      .replaceAll('{addressFile}', addressFile)
      .replaceAll('{pinFile}', pinFile),
  );
}

/** Отвечают ли по адресу. Ни одного байта в соединение не пишется. */
function answers(address: string, timeoutMs = PROBE_MS): Promise<boolean> {
  const endpoint = endpointOf(address);
  if (endpoint === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
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

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Живой сервис контейнера: процесс и признак его смерти. */
interface Owned {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  alive: boolean;
  /** Объявленная отвязываемость (DSK-7): такой процесс переживает сессию. */
  readonly detached: boolean;
  /**
   * Файл закрепления, если объявление его подставляет; иначе пустая строка
   * (DSK-8). Держится рядом с процессом, потому что у НЕотвязываемого сервиса
   * закрепление живёт ровно столько же, сколько он.
   */
  readonly pinFile: string;
}

/**
 * Обещает ли объявление закрепление сертификата (DSK-8, решение D2): признак —
 * сама подстановка `{pinFile}` в аргументах, отдельного поля у сервиса нет.
 */
function promisesPin(declared: ProfileService): boolean {
  return declared.args.some((arg) => arg.includes('{pinFile}'));
}

function refuse(what: string): Error {
  return new Error(`сервисы контейнера: ${what}`);
}

export function createHostServices(options: HostServicesOptions): HostServices {
  const { profile } = options;
  const runtime = options.runtime ?? process.execPath;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  const report = options.report ?? ((): void => undefined);
  const stateDir = options.stateDir ?? defaultServiceStateDir();
  const owned = new Map<BridgeServiceId, Owned>();

  const declaredOf = (id: BridgeServiceId): ProfileService => {
    const declared = profileService(profile, id);
    if (declared === undefined) {
      throw refuse(`сервис "${id}" профилем "${profile.id}" не объявлен (DSK-5)`);
    }
    return declared;
  };

  /**
   * Файлы отвязываемого сервиса; у обычного их нет — ему нечего переживать.
   *
   * Закрепление сертификата (DSK-8) лежит среди них по той же причине, по
   * которой оно объявлено рядом с адресным файлом (решение D1): его читает и та
   * сессия, которая сервиса не поднимала. Обычному сервису путь закрепления
   * даёт `pinFileOf` — из той же раскладки, но без адреса и pid: переживать
   * сессию ему нечем и незачем.
   */
  const filesOf = (declared: ProfileService): DetachedFiles | undefined =>
    declared.detached ? detachedFiles(stateDir, declared.id) : undefined;

  /**
   * Путь закрепления ЛЮБОГО объявленного сервиса, который его подставляет
   * (DSK-8); `undefined` — объявление закрепления не обещает.
   *
   * Оговорки «только отвязываемый» в требовании нет, и её здесь тоже нет: сервис,
   * живущий ровно одну сессию, называет своё закрепление тем же способом. Разница
   * — в СРОКЕ: закрепление отвязываемого читает и новая сессия, закрепление
   * обычного действует, пока жив поднявший его процесс (`certificatePins`).
   *
   * Файла эта функция не создаёт — только каталог состояния: закрепление пишет
   * САМ процесс сервиса, и контейнер строить его не вправе (DSK-8).
   */
  const pinFileOf = (declared: ProfileService): string | undefined =>
    promisesPin(declared) ? servicePinFile(stateDir, declared.id) : undefined;

  /**
   * Адрес сервиса: объявленный профилем либо написанный САМИМ процессом
   * (DSK-7). Контейнер эту строку не разбирает и не строит — он передаёт её как
   * есть, а истолковывает приложение.
   */
  const addressOf = (declared: ProfileService, files: DetachedFiles | undefined): string => {
    const written = files === undefined ? '' : readAddressFile(files.addressFile);
    return written === '' ? declared.address : written;
  };

  const stateOf = (declared: ProfileService, running: boolean): BridgeServiceState => ({
    id: declared.id,
    running,
    address: running ? addressOf(declared, filesOf(declared)) : '',
  });

  /** Ждёт, пока по адресу ответят; смерть процесса прекращает ожидание сразу. */
  const untilReady = async (declared: ProfileService, live: Owned): Promise<void> => {
    if (endpointOf(declared.address) === undefined) {
      // Адреса с портом у сервиса нет — проверять нечем, но «нечем проверить» не
      // значит «поднялся»: процесс, умерший на первом тике, объявлялся бы
      // запущенным (DSK-7 обещает обратное). Один шаг ожидания даёт его выходу
      // дойти до нас, дальше верим на слово.
      await wait(READY_STEP_MS);
      if (!live.alive) throw refuse(`сервис "${declared.id}" завершился сразу после запуска`);
      return;
    }
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (await answers(declared.address)) return;
      if (!live.alive) throw refuse(`сервис "${declared.id}" завершился, не начав слушать`);
      if (Date.now() >= deadline) {
        throw refuse(`сервис "${declared.id}" не ответил по адресу ${declared.address}`);
      }
      await wait(READY_STEP_MS);
    }
  };

  const launch = (declared: ProfileService, files: DetachedFiles | undefined): Owned => {
    const pinFile = pinFileOf(declared) ?? '';
    // Закрепление ПРОШЛОЙ сессии — не закрепление этой: неотвязываемый сервис
    // сессию не переживает (DSK-8), и оставленный файл читался бы как закрепление
    // процесса, который его ещё не писал. Отвязываемого это не касается — его
    // файл принадлежит живому процессу, и уносит его `forgetDetached`.
    if (pinFile !== '' && !declared.detached) forgetPin(pinFile);
    const args = serviceArgs(declared, files?.addressFile ?? '', pinFile);
    const child = spawn(runtime, [declared.script, ...args], {
      ...serviceSpawnOptions(declared.detached, process.platform),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    });
    // Отвязанный процесс не держит контейнер живым и не умирает вместе с ним:
    // ссылку на него в цикле событий мы отпускаем сразу (DSK-7).
    if (declared.detached) {
      child.unref();
      if (files !== undefined && child.pid !== undefined) writePid(files.pidFile, child.pid);
    }
    const live: Owned = {
      child,
      alive: true,
      detached: declared.detached,
      pinFile,
      exited: new Promise<void>((done) => {
        child.once('exit', () => {
          live.alive = false;
          done();
        });
        child.once('error', () => {
          live.alive = false;
          done();
        });
      }),
    };
    return live;
  };

  const kill = async (id: BridgeServiceId, live: Owned): Promise<void> => {
    owned.delete(id);
    // Закрепление НЕотвязываемого сервиса действует ровно на срок жизни его
    // процесса (DSK-8: через границу сессий действует закрепление отвязываемого),
    // и уходит вместе с ним. У отвязываемого его уносит `forgetDetached` — там,
    // где уносятся адрес и pid.
    if (live.pinFile !== '' && !live.detached) forgetPin(live.pinFile);
    if (!live.alive) return;
    live.child.kill('SIGTERM');
    const killed = await Promise.race([live.exited.then(() => true), wait(graceMs).then(() => false)]);
    if (!killed) live.child.kill('SIGKILL');
  };

  /**
   * Адрес пережившего процесса: написанный САМИМ процессом, а объявленный
   * профилем — только если он молчал (DSK-7).
   */
  const survivorAddress = (declared: ProfileService, survivor: { readonly address: string }): string =>
    survivor.address === '' ? declared.address : survivor.address;

  /**
   * Ответ о пережившем сервисе — он же строка отчёта. Одним местом на оба пути
   * к пережившему (мгновенный ответ и ожидание): расходиться им нечем, а
   * молчаливый второй ответ означал бы адрес без записи в отчёте.
   */
  const survivorRunning = (declared: ProfileService, address: string): BridgeServiceState => {
    report(`сервис "${declared.id}": пережил прежнюю сессию, адрес ${address}`);
    return { id: declared.id, running: true, address };
  };

  /**
   * Отвязанный сервис, переживший ПРЕЖНЮЮ сессию (DSK-7, решение D6): его
   * процесс жив, а владения им у этой сессии нет. Повторный запрос на запуск
   * обязан вернуть его адрес и не породить второго процесса — в том числе через
   * границу сессий.
   */
  const survivorState = async (
    declared: ProfileService,
    files: DetachedFiles | undefined,
  ): Promise<BridgeServiceState | undefined> => {
    if (files === undefined) return undefined;
    const survivor = detachedSurvivor(files);
    if (survivor === undefined) {
      // Процесса нет — файлы врут: чистим, чтобы следующий запуск не считал
      // мертвеца живым.
      forgetDetached(files);
      return undefined;
    }
    const address = survivorAddress(declared, survivor);
    // Живой процесс — ещё не работающий сервис: адрес обязан отвечать. Иначе мы
    // выдали бы приложению строку, по которой никого нет.
    if (endpointOf(address) !== undefined && !(await answers(address))) return undefined;
    return survivorRunning(declared, address);
  };

  /**
   * Переживший процесс ЖИВ, но по адресу ещё молчит (DSK-7).
   *
   * «Молчит» и «его нет» — разные вещи, и различать их обязательно: агент на
   * первом запуске генерирует ключ и самоподписанный сертификат (SRV-3), а порт
   * мог на миг залипнуть. Сочти второе первым — и повторный запуск породил бы
   * ВТОРОЙ процесс на тех же портах, а первый остался бы жив, недостижим ни для
   * `stop()`, ни для `state()`, потому что файл идентификатора уже переписан.
   * Поэтому здесь ждут, а не запускают; смерть процесса ожидание прекращает —
   * тогда запускать и вправду можно.
   */
  const untilSurvivorAnswers = async (
    declared: ProfileService,
    files: DetachedFiles,
  ): Promise<BridgeServiceState | undefined> => {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const survivor = detachedSurvivor(files);
      if (survivor === undefined) {
        forgetDetached(files);
        return undefined;
      }
      const address = survivorAddress(declared, survivor);
      if (endpointOf(address) === undefined || (await answers(address))) {
        return survivorRunning(declared, address);
      }
      if (Date.now() >= deadline) {
        throw refuse(
          `сервис "${declared.id}": процесс ${String(survivor.pid)} пережил прежнюю сессию, ` +
            `но по адресу ${address} не отвечает`,
        );
      }
      await wait(READY_STEP_MS);
    }
  };

  const startFresh = async (id: BridgeServiceId): Promise<BridgeServiceState> => {
    const declared = declaredOf(id);
    const files = filesOf(declared);
    const live = owned.get(id);
    if (live?.alive === true) return stateOf(declared, true);
    const survivor = await survivorState(declared, files);
    if (survivor !== undefined) return survivor;
    if (files !== undefined) {
      const answered = await untilSurvivorAnswers(declared, files);
      if (answered !== undefined) return answered;
    }
    // Занятый адрес — не ошибка и не наш процесс: сервис, поднятый снаружи, и
    // есть тот, к которому пойдёт приложение. Владение мы себе не
    // приписываем, поэтому и не снимем его на закрытии окна.
    if (await answers(declared.address)) {
      owned.delete(id);
      report(`сервис "${id}": по адресу ${declared.address} уже отвечают`);
      return stateOf(declared, true);
    }
    const started = launch(declared, files);
    owned.set(id, started);
    // Сессию могли закрыть, ПОКА мы стартовали: `closeAll` снял тогда пустую
    // карту, и этот процесс остался бы жить, держа свой адрес занятым, — ровно
    // то, что DSK-7 обещает не допускать («сервис останавливается вместе с
    // окном»). Отвязываемого это не касается: он сессию переживает намеренно.
    if (closed && !declared.detached) {
      await kill(id, started);
      throw refuse(`сервис "${id}": сессия закрылась, пока он поднимался`);
    }
    try {
      await untilReady(declared, started);
    } catch (error) {
      await kill(id, started);
      if (files !== undefined) forgetDetached(files);
      throw error;
    }
    return stateOf(declared, true);
  };

  /** Запуски в полёте: параллельные вызовы `start` одного имени делят один. */
  const starting = new Map<BridgeServiceId, Promise<BridgeServiceState>>();
  /** Сессия закрыта: запуск, севший в это окно, снимает сам себя. */
  let closed = false;

  return {
    async start(id) {
      // Второй spawn того же сервиса осиротил бы первый процесс: запись в
      // `owned` перезаписалась бы, и снять его не смогли бы ни stop(), ни
      // закрытие сессии (DSK-7) — поэтому наложившиеся вызовы делят ОДИН запуск.
      const inFlight = starting.get(id);
      if (inFlight !== undefined) return inFlight;
      const run = startFresh(id);
      starting.set(id, run);
      try {
        return await run;
      } finally {
        starting.delete(id);
      }
    },
    async stop(id) {
      const declared = declaredOf(id);
      const files = filesOf(declared);
      const live = owned.get(id);
      if (live !== undefined) {
        await kill(id, live);
        if (files !== undefined) forgetDetached(files);
        return stateOf(declared, false);
      }
      // Отвязанный сервис останавливается ЯВНОЙ операцией и через границу
      // сессий (DSK-7): владения у этой сессии нет, а идентификатор процесса
      // остался в каталоге состояния.
      const survivor = files === undefined ? undefined : detachedSurvivor(files);
      // Пережившего без файлов не бывает — их отсутствие и означает «сервис не
      // отвязываемый»; названо это здесь одним условием, чтобы ниже не
      // утверждать того же восклицательными знаками.
      if (files !== undefined && survivor !== undefined) {
        // Сигнал шлётся только ТОМУ процессу, чей момент старта совпадает: PID
        // мог переиспользоваться после перезагрузки (DSK-7).
        //
        // Момент старта читается не везде: там, где платформа его не называет
        // (`startProc === 0` — всё, кроме Linux), «тот же процесс» вырождается в
        // «номер занят». Каталог состояния при этом переживает перезагрузку
        // (`userData`), а после неё номер держит уже кто угодно — например
        // редактор самого пользователя. Поэтому в таком случае мы шлём сигнал
        // только тому, кто ОТВЕЧАЕТ по адресу сервиса: это единственное, чем
        // его ещё можно опознать. Не отвечает — просто забываем запись.
        const identified = survivor.startProc !== 0 || (await answers(addressOf(declared, files)));
        if (!identified) {
          forgetDetached(files);
          return stateOf(declared, false);
        }
        await stopPid({ pid: survivor.pid, startProc: survivor.startProc }, graceMs);
        forgetDetached(files);
        return stateOf(declared, false);
      }
      return stateOf(declared, await answers(declared.address));
    },
    async state(id) {
      const declared = declaredOf(id);
      if (owned.get(id)?.alive === true) return stateOf(declared, true);
      const files = filesOf(declared);
      const survivor = await survivorState(declared, files);
      if (survivor !== undefined) return survivor;
      return stateOf(declared, await answers(declared.address));
    },
    certificatePins() {
      // Файлы читаются В МОМЕНТ вопроса и не кешируются: закрепление пишет сам
      // сервис, и сессия, задавшая вопрос, могла не поднимать его вовсе —
      // переживший прежнюю сессию процесс написал свой файл до неё (DSK-8).
      const pins = new Set<string>();
      for (const declared of profile.services) {
        // Непригодный каталог состояния (чужой владелец, права на запись всем)
        // `detachedFiles` называет отказом — и здесь этот отказ НЕ летит дальше:
        // вопрос задан проверкой сертификата, и исключение на нём означало бы
        // упавший контейнер вместо отвергнутого сертификата. Громко тот же отказ
        // звучит на запуске сервиса (`start`), где ему и место.
        let pin = '';
        try {
          const pinFile = pinFileOf(declared);
          if (pinFile === undefined) continue;
          // Закрепление НЕотвязываемого сервиса живёт ровно столько, сколько
          // поднявший его процесс: через границу сессий действует закрепление
          // отвязываемого, и только его (DSK-8). Поэтому у обычного сервиса
          // спрашивается ВЛАДЕНИЕ: файл, оставшийся от прежней сессии или
          // написанный процессом, которым эта сессия не владеет, доверия не
          // расширяет.
          if (!declared.detached && owned.get(declared.id)?.alive !== true) continue;
          pin = readPinFile(pinFile);
        } catch {
          continue;
        }
        if (pin !== '') pins.add(pin);
      }
      return [...pins];
    },
    owned() {
      return [...owned.values()].filter((live) => live.alive).length;
    },
    async closeAll() {
      closed = true;
      // Запуски В ПОЛЁТЕ дожидаются: их процесс появляется в `owned` только
      // после спавна, и снимок карты, взятый раньше, его не увидел бы. Отказ
      // такого запуска здесь не важен — важно, что он закончился.
      await Promise.allSettled([...starting.values()]);
      // Отвязываемый сервис сессию ПЕРЕЖИВАЕТ (DSK-7): закрытие снимает только
      // тех, кто отвязываемым себя не объявлял. Судьба отвязанного — политика
      // приложения (`server-manager` MGR-4), и решается она явной остановкой.
      const mortal = [...owned].filter(([, live]) => !live.detached);
      await Promise.all(mortal.map(([id, live]) => kill(id, live)));
    },
  };
}
