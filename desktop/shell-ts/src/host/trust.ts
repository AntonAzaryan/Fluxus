/**
 * Второе основание доверия контейнера — решение ЧЕЛОВЕКА (DSK-8, решения
 * D1–D5).
 *
 * Первое основание — закрепление объявленного сервиса (`service.ts`,
 * `certificatePins`): его написал сам сервис, и вопросов человеку оно не стоит.
 * Всё, что закреплением не покрыто, до этого change'а оставалось отвергнутым
 * навсегда — а значит, удалённый хост (`server-manager` MGR-5) из контейнера был
 * недостижим. Здесь появляется ровно тот путь, который есть у SSH и у
 * клиентского пиннинга агента (`server-control` SRV-3): предъявить человеку
 * origin и отпечаток, и запомнить его решение.
 *
 * ## Что здесь решается, а что — нет
 *
 * Решается ПОРЯДОК оснований (решение D2): закрепления сервисов → книга доверия
 * → вопрос. Сам вопрос сюда инъецируется колбэком `ask`: диалог среды бывает
 * только у реализации контейнера, а логика обязана жить на чистом Node и
 * проверяться в гейте (DSK-6). Клей Electron поэтому передаёт сюда
 * `dialog.showMessageBox` и не решает ничего сам, а контрактный сьют — автоответ.
 *
 * НЕ решается ничего про адрес сервиса: origin приезжает из URL события
 * `certificate-error`, то есть из соединения, которое открыла страница, — запрет
 * DSK-7 «контейнер адрес не разбирает» касается адресной строки СЕРВИСА и этим
 * не задевается.
 *
 * ## Почему «не понял» здесь всегда означает отказ
 *
 * У сверки сертификатов нет безопасного «не знаю»: непрочитанный отпечаток,
 * непонятый origin, битая книга — всё это ведёт к отказу или к вопросу, но
 * никогда к молчаливому принятию. Тот же счёт ведёт `readPinFile` (DSK-8).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isFingerprint } from './certificate.js';

/**
 * Origin соединения из URL события `certificate-error`; пустая строка — «URL не
 * понят».
 *
 * Origin, а не хост: «тот же VPS под другим портом» — другой эндпоинт, и молча
 * расширять решение человека на все порты хоста нельзя (решение D1, риски).
 * Схему сюда включает сам `URL.origin`; для схем, у которых кортежного origin
 * нет вовсе, ответом остаётся `протокол//хост` — но не пустая строка, иначе
 * книга потеряла бы ключ там, где соединение вполне реально.
 */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.origin !== '' && parsed.origin !== 'null') return parsed.origin;
  if (parsed.host === '') return '';
  return `${parsed.protocol}//${parsed.host}`;
}

/** Вопрос человеку о предъявленном сертификате (DSK-8). */
export interface TrustQuestion {
  /** Origin соединения — то, КУДА идёт страница. */
  readonly origin: string;
  /** Отпечаток предъявленного сертификата. */
  readonly fingerprint: string;
  /**
   * Прежний отпечаток этого origin; пустая строка — origin книге незнаком.
   * Непустой означает СМЕНУ: громкий случай, а не обычный первый вопрос.
   */
  readonly known: string;
}

/** Как спросить человека. Ответ — «доверять» либо «отклонить»; иного нет. */
export type TrustAsk = (question: TrustQuestion) => Promise<boolean>;

/** Текст вопроса: то, что человек обязан увидеть, прежде чем решить (DSK-8). */
export interface TrustPrompt {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  /** Смена отпечатка известного origin — предупреждение, а не обычный вопрос. */
  readonly changed: boolean;
}

/**
 * Текст вопроса живёт здесь, а не в клее, потому что он не оформление:
 * «предъявить с origin соединения и отпечатком SHA-256», а при смене — «с
 * прежним и новым отпечатками» — это требование DSK-8, и проверяется оно в
 * гейте. Клей превращает эти три строки в окно и ничего к ним не добавляет.
 *
 * Отпечаток печатается ровно в той форме, в какой его называет агент хоста при
 * запуске (`агент хоста поднят … отпечаток: …`, SRV-3): сверять человек будет
 * именно с ней, и вторая форма записи того же числа сделала бы сверку глазами
 * невозможной.
 */
export function trustPrompt(question: TrustQuestion): TrustPrompt {
  const changed = question.known !== '';
  if (!changed) {
    return {
      changed,
      title: 'Незнакомый сертификат',
      message: `Доверять сертификату ${question.origin}?`,
      detail:
        `Отпечаток SHA-256:\n${question.fingerprint}\n\n` +
        'Сверьте его с отпечатком, который назвал сам хост при запуске. ' +
        `Согласие откроет соединение и запомнит этот отпечаток за ${question.origin}: ` +
        'следующие подключения вопросов задавать не будут.',
    };
  }
  return {
    changed,
    title: 'Отпечаток хоста изменился',
    message: `Сертификат ${question.origin} — не тот, что был раньше!`,
    detail:
      `Прежний отпечаток:\n${question.known}\n\n` +
      `Предъявленный отпечаток:\n${question.fingerprint}\n\n` +
      'Так выглядит и перевыпуск сертификата на хосте, и подмена канала. ' +
      'Согласие перепишет запись книги доверия; отказ отвергнет соединение.',
  };
}

/** Показать собранный вопрос средствами среды: у контейнера — окно с кнопками. */
export type TrustDialogShow = (prompt: TrustPrompt) => Promise<boolean>;

export interface TrustAskOptions {
  /** Аргументы запуска: из них читается прогонный автоответ (DSK-6). */
  readonly argv: readonly string[];
  readonly show: TrustDialogShow;
  /**
   * Куда складывать заданные вопросы под автоответом: их читает случай
   * контрактного сьюта. У обычного запуска этот список не растёт — там
   * спрашивают человека.
   */
  readonly asked: TrustQuestion[];
}

export interface TrustDialog {
  readonly ask: TrustAsk;
  /**
   * Ответить ОТКАЗОМ за все открытые вопросы (DSK-8, решение D2): окна больше
   * нет, человек ответа не даст, а соединение, севшее его ждать, висело бы
   * вечно.
   */
  closeAll(): void;
}

/**
 * Путь книги доверия (DSK-8, решение D1): `trust.json` в каталоге данных
 * контейнера — и никакой другой.
 *
 * `--trust-file` подменяет его ТОЛЬКО в контрактном прогоне (`--contract`),
 * которому нужна своя книга: прогон поднимает окна пачками, порты ему выдаёт ОС,
 * и общая книга склеивала бы решения соседних случаев между собой.
 *
 * Вне прогона флаг не действует, и это не педантизм: книга — основание доверия
 * (DSK-8), и флаг запуска, подменяющий её файл, был бы ровно тем «ослаблением
 * проверки сертификатов флагом запуска», которое требование запрещает.
 * Сослаться на `--app` тут нельзя: чужой профиль приводит с собой ЧУЖОЙ бандл,
 * то есть видимое человеку чужое приложение, а подменённая книга оставляет
 * подлинный профиль с подлинным интерфейсом и молча принимает подставной
 * сертификат.
 */
export function trustBookPath(argv: readonly string[], userDataBook: string): string {
  if (!argv.includes('--contract')) return userDataBook;
  const at = argv.indexOf('--trust-file');
  const named = at < 0 ? undefined : argv[at + 1];
  return named ?? userDataBook;
}

/**
 * Автоответ на вопрос доверия (`--trust-answer yes|no`): им пользуется
 * контрактный прогон, которому диалог предъявить некому (DSK-6).
 *
 * Действует ТОЛЬКО вместе с `--contract`. У обычного запуска отвечает человек, и
 * второго пути у него нет: DSK-8 знает ровно два основания доверия — закрепление
 * объявленного сервиса и явное решение человека, — а «доверять всему, что
 * попросят» не является ни тем, ни другим.
 */
function trustAnswerOf(argv: readonly string[]): boolean | undefined {
  if (!argv.includes('--contract')) return undefined;
  const at = argv.indexOf('--trust-answer');
  const named = at < 0 ? undefined : argv[at + 1];
  if (named === undefined) return undefined;
  return named === 'yes';
}

/**
 * Собирает «спросить человека» из показа вопроса средой (DSK-8, решение D2).
 *
 * Здесь живёт всё, что можно проверить без Electron: гейт автоответа, счёт
 * открытых вопросов и ответ за них при закрытии окна. Среде остаётся показать
 * три строки и вернуть «да» или «нет» — этого на чистом Node не бывает, всё
 * остальное бывает (DSK-6).
 */
export function createTrustAsk(options: TrustAskOptions): TrustDialog {
  /** Открытые вопросы: закрытие окна отвечает за них «отклонить». */
  const pending = new Set<(trusted: boolean) => void>();

  const askHuman = (question: TrustQuestion): Promise<boolean> =>
    new Promise<boolean>((done) => {
      const answer = (trusted: boolean): void => {
        // Первый ответ забирает вопрос себе: закрытие окна и ответ человека
        // могут прийти оба, и второй обязан быть no-op.
        if (!pending.delete(answer)) return;
        done(trusted);
      };
      pending.add(answer);
      void options.show(trustPrompt(question)).then(answer, () => {
        answer(false);
      });
    });

  const automatic = trustAnswerOf(options.argv);
  return {
    ask:
      automatic === undefined
        ? askHuman
        : // Контрактный прогон: предъявлять диалог некому, и ответ задан
          // аргументом запуска. Сам вопрос при этом задаётся настоящий — прогон
          // его читает и сверяет с тем, что требует сценарий.
          (question) => {
            options.asked.push(question);
            return Promise.resolve(automatic);
          },
    closeAll() {
      for (const answer of [...pending]) answer(false);
    },
  };
}

/**
 * Книга доверия: «origin → отпечаток», переживающая сессию (DSK-8, решение D1).
 *
 * Файл читается В МОМЕНТ вопроса и не кешируется — по той же причине, по которой
 * не кешируются закрепления сервисов: писать книгу могла и не эта сессия.
 */
export interface TrustBook {
  /** Отпечаток, записанный за origin; пустая строка — origin книге незнаком. */
  fingerprintOf(origin: string): string;
  /** Записать решение человека. Бросает, если запись не удалась. */
  remember(origin: string, fingerprint: string): void;
  /** Все записи книги. Нужно проверкам, не решению. */
  entries(): ReadonlyMap<string, string>;
}

/** Счётчик временных имён: два вопроса подряд не должны делить один файл. */
let writeCounter = 0;

/**
 * Читает книгу с диска. Любая непонятость — ПУСТАЯ книга или пропущенная
 * запись, но никогда не исключение: вопрос задан проверкой сертификата, и
 * брошенное отсюда означало бы упавший контейнер вместо заданного вопроса.
 *
 * Значение, не являющееся отпечатком, отбрасывается поштучно: чужой ключ,
 * дописанный руками админа или оставшийся от другой версии файла, не должен
 * стирать решения человека, лежащие рядом.
 */
function readBook(file: string): Map<string, string> {
  const book = new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return book;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return book;
  for (const [origin, value] of Object.entries(raw as Record<string, unknown>)) {
    if (origin === '' || typeof value !== 'string' || !isFingerprint(value)) continue;
    book.set(origin, value);
  }
  return book;
}

export function openTrustBook(file: string): TrustBook {
  return {
    fingerprintOf(origin) {
      if (origin === '') return '';
      return readBook(file).get(origin) ?? '';
    },
    entries() {
      return readBook(file);
    },
    remember(origin, fingerprint) {
      if (origin === '' || !isFingerprint(fingerprint)) {
        throw new Error(`книга доверия: запись "${origin}" → "${fingerprint}" не отпечаток (DSK-8)`);
      }
      // Перечитываем ПЕРЕД записью: между прошлым чтением и решением человека
      // книгу мог дописать кто-то ещё, и запись снимка стёрла бы чужое решение.
      const book = readBook(file);
      book.set(origin, fingerprint);
      const sorted = [...book].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const text = `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
      mkdirSync(dirname(file), { recursive: true });
      // Запись атомарна тем же приёмом, что и запись корня (`root.ts`):
      // оборванная на полуслове книга читалась бы как пустая, и все решения
      // человека пришлось бы принимать заново.
      const temporary = `${file}.tmp-${String(process.pid)}-${String(writeCounter++)}`;
      try {
        // Права на книгу — свои: подменивший её сосед по машине расширил бы
        // доверие контейнера на свой сертификат. То же основание, что у
        // `mode: 0o600` файла закрепления.
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw new Error(
          `книга доверия "${file}" не записана: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export interface CertificateTrustOptions {
  /** Файл книги доверия в каталоге данных контейнера (решение D1). */
  readonly file: string;
  /** Закрепления объявленных сервисов (DSK-8); спрашиваются первыми (решение D4). */
  readonly pins?: () => readonly string[];
  /** Как спросить человека: диалог среды у клея, автоответ у контрактного прогона. */
  readonly ask: TrustAsk;
  readonly report?: (text: string) => void;
}

export interface CertificateTrust {
  /**
   * Принять ли сертификат, отвергнутый штатной проверкой платформы (DSK-8).
   *
   * Порядок оснований (решение D2): закрепление объявленного сервиса → книга
   * доверия → вопрос человеку. Всё, что не совпало ни с чем и на что человек не
   * ответил «доверять», остаётся отвергнутым.
   */
  decideCertificate(origin: string, fingerprint: string): Promise<boolean>;
}

export function createCertificateTrust(options: CertificateTrustOptions): CertificateTrust {
  const book = openTrustBook(options.file);
  const pins = options.pins ?? ((): readonly string[] => []);
  const report = options.report ?? ((): void => undefined);
  /** Открытые вопросы по origin (решение D3): одному origin — один вопрос. */
  const asking = new Map<string, { readonly fingerprint: string; readonly answer: Promise<boolean> }>();

  /** Спросить и запомнить согласие. Отказ в книгу не пишется (решение D5). */
  const askOnce = async (question: TrustQuestion): Promise<boolean> => {
    const trusted = await options.ask(question).catch((error: unknown) => {
      report(`доверие: вопрос о ${question.origin} сорвался (${String(error)}) — считаем отказом`);
      return false;
    });
    if (!trusted) {
      // Отказ — решение о ПОПЫТКЕ, а не о хосте навсегда: следующая попытка
      // спросит заново. Запоминать отказы значило бы завести и способ их
      // снимать, а такого UI у контейнера нет (Non-Goals).
      report(`доверие: ${question.origin} отклонён человеком`);
      return false;
    }
    try {
      book.remember(question.origin, question.fingerprint);
      report(`доверие: ${question.origin} принят человеком, отпечаток ${question.fingerprint}`);
    } catch (error) {
      // Незаписанная книга не отменяет согласия на ЭТУ попытку: человек сказал
      // «доверяю», и превращать сбой записи в отказ соединения нечестно.
      // Следствие названо вслух — следующее подключение спросит заново.
      report(
        `доверие: ${question.origin} принят, но решение не пережило сессию — ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return true;
  };

  return {
    async decideCertificate(origin, fingerprint) {
      // Отпечаток не посчитался (`certificateFingerprint` вернул пустое) —
      // сверять нечего, и «нечего сверять» здесь означает отказ.
      if (!isFingerprint(fingerprint)) {
        report(`доверие: сертификат ${origin === '' ? 'без origin' : origin} не разобран — отказ`);
        return false;
      }
      // Закрепления сервисов ПЕРВЫМИ (решение D4): локальный агент до диалога не
      // доходит никогда — его закрепление написал он сам, и вопрос человеку про
      // него был бы регрессом MGR-5 «без вопросов человеку».
      let pinned: readonly string[] = [];
      try {
        pinned = pins();
      } catch {
        // Непрочитанные закрепления — не основание принять и не повод упасть:
        // ниже остаются книга и вопрос.
        pinned = [];
      }
      if (pinned.includes(fingerprint)) return true;

      if (origin === '') {
        // Спросить не о чем: вопрос без origin человек прочесть не сможет.
        report('доверие: origin соединения не разобран — отказ');
        return false;
      }
      const known = book.fingerprintOf(origin);
      if (known === fingerprint) return true;

      const open = asking.get(origin);
      if (open !== undefined) {
        // Тот же origin с тем же сертификатом — та же попытка по сути: ретраи
        // WebSocket менеджера иначе наплодили бы стопку одинаковых окон.
        if (open.fingerprint === fingerprint) return await open.answer;
        // Тот же origin, но ДРУГОЙ сертификат, пока вопрос открыт: второго окна
        // быть не должно («одному origin — не больше одного открытого вопроса»),
        // а принять этот сертификат по ответу про чужой — тем более. Отказ; когда
        // вопрос закроется, следующая попытка спросит про него честно.
        report(`доверие: ${origin} предъявил второй сертификат, пока открыт вопрос о первом — отказ`);
        return false;
      }

      const answer = askOnce({ origin, fingerprint, known });
      asking.set(origin, { fingerprint, answer });
      try {
        return await answer;
      } finally {
        asking.delete(origin);
      }
    },
  };
}
