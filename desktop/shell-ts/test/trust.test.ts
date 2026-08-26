/**
 * Второе основание доверия контейнера — решение человека (DSK-8, решения
 * D1–D5).
 *
 * Проверяется здесь ровно то, что и должно быть проверено на чистом Node: книга
 * доверия на диске и ПОРЯДОК оснований. Диалога среды в гейте нет и быть не
 * может (DSK-6), поэтому вопрос человеку инъецируется колбэком — тем же швом,
 * которым клей Electron передаёт `dialog.showMessageBox`, а контрактный прогон
 * вне гейта — автоответ.
 *
 * Что здесь НЕ проверяется: настоящая проверка сертификата Chromium. Её
 * дополняет клей, и увидеть её можно только из окна — этим занят прогон
 * `contract:electron` (DSK-6).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCertificateTrust,
  createTrustAsk,
  openTrustBook,
  originOf,
  trustBookPath,
  trustPrompt,
  type TrustPrompt,
  type TrustQuestion,
} from '../src/host/trust.js';
import { dropTree, makeTree, PINNED_FINGERPRINT } from './support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Временный каталог данных контейнера и путь его книги доверия. Каталога
 * `userData` НЕТ: книга обязана завести его сама — у свежего профиля
 * пользователя её файла не существует вовсе.
 */
async function bookFile(): Promise<{ root: string; file: string }> {
  const root = await makeTree();
  cleanups.push(() => dropTree(root));
  return { root, file: join(root, 'userData', 'trust.json') };
}

/** Книга, написанная НЕ нами: чужой текст на месте файла. */
async function seedBook(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

const REMOTE = 'wss://198.51.100.7:8443';
const OTHER = 'wss://198.51.100.7:9443';
/** Отпечатки-фикстуры: форма настоящая, происхождение выдуманное. */
const HOST_PIN = 'a'.repeat(64);
const CHANGED_PIN = 'b'.repeat(64);

describe('книга доверия контейнера (DSK-8, решение D1)', () => {
  it('запись переживает перечтение', async () => {
    const { file } = await bookFile();
    const book = openTrustBook(file);
    // Пустой книги на диске ещё нет вовсе: незнакомый origin — пустая строка, а
    // не отказ чтения.
    expect(book.fingerprintOf(REMOTE)).toBe('');

    book.remember(REMOTE, HOST_PIN);
    expect(book.fingerprintOf(REMOTE)).toBe(HOST_PIN);
    // Читает ДРУГОЙ объект книги: решение человека переживает не только вопрос,
    // но и сессию, которая его задала.
    expect(openTrustBook(file).fingerprintOf(REMOTE)).toBe(HOST_PIN);

    // Второй origin не стирает первый, а перезапись — стирает только свою запись.
    book.remember(OTHER, CHANGED_PIN);
    book.remember(REMOTE, CHANGED_PIN);
    expect([...openTrustBook(file).entries()]).toEqual([
      [REMOTE, CHANGED_PIN],
      [OTHER, CHANGED_PIN],
    ]);
  });

  it('запись атомарна: недописанного файла рядом не остаётся', async () => {
    const { file } = await bookFile();
    const book = openTrustBook(file);
    book.remember(REMOTE, HOST_PIN);
    book.remember(OTHER, HOST_PIN);
    // Оборванная на полуслове книга читалась бы как пустая, и все решения
    // человека пришлось бы принимать заново, — поэтому пишется временный файл и
    // переименовывается. После записи временных имён быть не должно.
    expect(await readdir(join(file, '..'))).toEqual(['trust.json']);
  });

  it('мусорный файл читается как пустая книга, а не роняет чтение', async () => {
    const { file } = await bookFile();
    const book = openTrustBook(file);
    for (const garbage of ['', 'не json вовсе', '[]', 'null', '42', '"строка"']) {
      await seedBook(file, garbage);
      expect([...book.entries()], JSON.stringify(garbage)).toEqual([]);
      // «Не понял» у сверки сертификатов обязано означать отказ, а не
      // исключение: вопрос задан проверкой сертификата, и брошенное отсюда
      // означало бы упавший контейнер вместо отвергнутого сертификата.
      expect(book.fingerprintOf(REMOTE)).toBe('');
    }
  });

  it('чужие ключи не роняют чтение и не стирают соседей', async () => {
    const { file } = await bookFile();
    await seedBook(
      file,
      JSON.stringify({
        [REMOTE]: HOST_PIN,
        // Всё, что не отпечаток, — не запись книги: значение не той формы,
        // не строка вовсе, пустой ключ.
        'wss://мусор:1': 'закрепления тут нет',
        'wss://мусор:2': HOST_PIN.toUpperCase(),
        'wss://мусор:3': 17,
        'wss://мусор:4': null,
        '': HOST_PIN,
      }),
    );
    const book = openTrustBook(file);
    expect([...book.entries()]).toEqual([[REMOTE, HOST_PIN]]);
    expect(book.fingerprintOf(REMOTE)).toBe(HOST_PIN);
    expect(book.fingerprintOf('wss://мусор:1')).toBe('');

    // Дописав своё, книга сохраняет прочитанное и роняет непонятое: чужой ключ
    // не должен пережить запись, притворяясь решением человека.
    book.remember(OTHER, CHANGED_PIN);
    expect([...openTrustBook(file).entries()]).toEqual([
      [REMOTE, HOST_PIN],
      [OTHER, CHANGED_PIN],
    ]);
  });

  it('записью не является ничто, кроме «origin → отпечаток»', async () => {
    const { file } = await bookFile();
    const book = openTrustBook(file);
    expect(() => {
      book.remember('', HOST_PIN);
    }).toThrow(/книга доверия/);
    expect(() => {
      book.remember(REMOTE, '');
    }).toThrow(/книга доверия/);
    expect(() => {
      book.remember(REMOTE, HOST_PIN.toUpperCase());
    }).toThrow(/книга доверия/);
    expect([...book.entries()]).toEqual([]);
  });
});

describe('origin соединения из URL события (DSK-8, решение D1)', () => {
  it('порт — часть origin: другой порт спрашивает заново', () => {
    // Осознанно (решение D1, риски): другой порт — другой эндпоинт, и молчаливо
    // расширять решение человека на все порты хоста нельзя.
    expect(originOf('wss://198.51.100.7:8443/control')).toBe(REMOTE);
    expect(originOf('wss://198.51.100.7:9443/control')).toBe(OTHER);
    expect(originOf('wss://198.51.100.7:8443/другой/путь?вопрос=1')).toBe(REMOTE);
    expect(originOf('https://198.51.100.7:8443/')).toBe('https://198.51.100.7:8443');
  });

  it('непонятый URL — пустая строка, и она означает отказ', () => {
    expect(originOf('')).toBe('');
    expect(originOf('вовсе не адрес')).toBe('');
  });
});

/** Спрашивалка-протокол: помнит вопросы и отвечает заранее заданным ответом. */
function recordingAsk(answer: boolean): { ask: (q: TrustQuestion) => Promise<boolean>; asked: TrustQuestion[] } {
  const asked: TrustQuestion[] = [];
  return {
    asked,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  };
}

describe('порядок решения о сертификате (DSK-8, решения D2, D4, D5)', () => {
  it('закрепление объявленного сервиса — до всякого вопроса (решение D4)', async () => {
    const { file } = await bookFile();
    const human = recordingAsk(false);
    const trust = createCertificateTrust({
      file,
      pins: () => [PINNED_FINGERPRINT],
      ask: human.ask,
    });
    // Сценарий «Страница открывает шифрованный канал к объявленному сервису»:
    // локальный агент до диалога не доходит НИКОГДА — его закрепление написал он
    // сам, и вопрос человеку про него был бы регрессом MGR-5 «без вопросов
    // человеку». Спрашивалка здесь отвечает «нет» именно затем, чтобы порядок
    // был виден: спроси её кто-нибудь — канал бы не открылся.
    expect(await trust.decideCertificate(REMOTE, PINNED_FINGERPRINT)).toBe(true);
    expect(human.asked).toEqual([]);
    // И книга при этом не пишется: закрепление сервиса — не решение человека.
    expect([...openTrustBook(file).entries()]).toEqual([]);
  });

  it('незнакомый сертификат — вопрос человеку, согласие пишет книгу', async () => {
    const { file } = await bookFile();
    const human = recordingAsk(true);
    const trust = createCertificateTrust({ file, pins: () => [PINNED_FINGERPRINT], ask: human.ask });

    // Сценарий «Незнакомый сертификат — вопрос человеку».
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(true);
    expect(human.asked).toEqual([{ origin: REMOTE, fingerprint: HOST_PIN, known: '' }]);
    expect(openTrustBook(file).fingerprintOf(REMOTE)).toBe(HOST_PIN);

    // Сценарий «Известный origin молчит»: решение пережило вопрос, и второй раз
    // человека не тревожат.
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(true);
    expect(human.asked).toHaveLength(1);
  });

  it('решение читается из книги, написанной ПРЕЖНЕЙ сессией', async () => {
    const { file } = await bookFile();
    openTrustBook(file).remember(REMOTE, HOST_PIN);
    const human = recordingAsk(false);
    const trust = createCertificateTrust({ file, ask: human.ask });
    // Тот же сценарий «Известный origin молчит», но книгу писал не этот объект:
    // «Принятые человеком решения SHALL переживать сессию».
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(true);
    expect(human.asked).toEqual([]);
  });

  it('отказ отвергает соединение и в книгу не пишется (решение D5)', async () => {
    const { file } = await bookFile();
    const human = recordingAsk(false);
    const trust = createCertificateTrust({ file, ask: human.ask });

    // Сценарий «Чужой self-signed сертификат».
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(false);
    expect([...openTrustBook(file).entries()]).toEqual([]);
    // «Отказ в книгу не записывается, и следующая попытка спрашивает заново»:
    // отказ — решение о попытке, а не о хосте навсегда.
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(false);
    expect(human.asked).toHaveLength(2);
  });

  it('смена отпечатка известного origin — вопрос с ОБОИМИ отпечатками', async () => {
    const { file } = await bookFile();
    openTrustBook(file).remember(REMOTE, HOST_PIN);
    const human = recordingAsk(true);
    const trust = createCertificateTrust({ file, ask: human.ask });

    // Сценарий «Отпечаток известного origin изменился»: молчаливого принятия
    // нет, и глухого отказа нет тоже — есть предупреждение о смене.
    expect(await trust.decideCertificate(REMOTE, CHANGED_PIN)).toBe(true);
    expect(human.asked).toEqual([{ origin: REMOTE, fingerprint: CHANGED_PIN, known: HOST_PIN }]);
    // «...новым явным согласием, которое переписывает запись книги».
    expect(openTrustBook(file).fingerprintOf(REMOTE)).toBe(CHANGED_PIN);
  });

  it('смена, отклонённая человеком, оставляет прежнюю запись нетронутой', async () => {
    const { file } = await bookFile();
    openTrustBook(file).remember(REMOTE, HOST_PIN);
    const human = recordingAsk(false);
    const trust = createCertificateTrust({ file, ask: human.ask });

    expect(await trust.decideCertificate(REMOTE, CHANGED_PIN)).toBe(false);
    // Отказ не пишется в книгу ни в какой форме — в том числе не стирает
    // прежнее решение: хост, переживший подмену канала, остаётся известным.
    expect(openTrustBook(file).fingerprintOf(REMOTE)).toBe(HOST_PIN);
  });

  it('непонятый отпечаток и непонятый origin — отказ без вопроса', async () => {
    const { file } = await bookFile();
    const human = recordingAsk(true);
    const trust = createCertificateTrust({ file, ask: human.ask });
    // Сверять нечего: `certificateFingerprint` отдаёт пустую строку на всём,
    // что не сертификат, — и «нечего сверять» означает отказ, а не вопрос
    // человеку о пустом отпечатке.
    expect(await trust.decideCertificate(REMOTE, '')).toBe(false);
    expect(await trust.decideCertificate(REMOTE, 'не отпечаток')).toBe(false);
    // Вопрос без origin человек прочесть не сможет — спрашивать не о чем.
    expect(await trust.decideCertificate('', HOST_PIN)).toBe(false);
    expect(human.asked).toEqual([]);
  });

  it('сорвавшийся вопрос считается отказом, а не принятием', async () => {
    const { file } = await bookFile();
    const trust = createCertificateTrust({
      file,
      ask: () => Promise.reject(new Error('диалог не открылся')),
    });
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(false);
    expect([...openTrustBook(file).entries()]).toEqual([]);
  });

  it('незаписавшаяся книга не отменяет согласия на эту попытку', async () => {
    const { root } = await bookFile();
    // Книга по пути, которым файла быть не может: каталог занят файлом.
    await writeFile(join(root, 'занято'), 'не каталог');
    const said: string[] = [];
    const trust = createCertificateTrust({
      file: join(root, 'занято', 'trust.json'),
      ask: () => Promise.resolve(true),
      report: (text) => said.push(text),
    });
    // Человек сказал «доверяю» — превращать сбой записи в отказ соединения
    // нечестно; следствие названо вслух, и следующее подключение спросит заново.
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(true);
    expect(said.join('\n')).toContain('не пережило сессию');
  });
});

/**
 * Спрашивалка, которая ЖДЁТ: вопрос остаётся открытым, пока тест не ответит.
 * Так выглядит настоящий диалог среды — человек думает, а попытки соединения в
 * это время продолжают приходить.
 */
function openAsk(): {
  ask: (question: TrustQuestion) => Promise<boolean>;
  asked: TrustQuestion[];
  answer(trusted: boolean): void;
} {
  const asked: TrustQuestion[] = [];
  const waiting: ((trusted: boolean) => void)[] = [];
  return {
    asked,
    ask: (question) => {
      asked.push(question);
      return new Promise<boolean>((done) => waiting.push(done));
    },
    answer: (trusted) => {
      waiting.shift()?.(trusted);
    },
  };
}

/** Даёт микрозадачам и таймерам дойти: вопрос задаётся не мгновенно. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 10));

describe('схлопывание вопросов по origin (DSK-8, решение D3)', () => {
  it('параллельные решения одного origin ждут ОДИН вопрос', async () => {
    const { file } = await bookFile();
    const human = openAsk();
    const trust = createCertificateTrust({ file, ask: human.ask });

    // Ретраи WebSocket менеджера (переподключение хоста) иначе наплодили бы
    // стопку одинаковых диалогов: «одному origin — не больше одного открытого
    // вопроса».
    const first = trust.decideCertificate(REMOTE, HOST_PIN);
    const second = trust.decideCertificate(REMOTE, HOST_PIN);
    await settle();
    expect(human.asked).toHaveLength(1);

    human.answer(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);

    // Вопрос закрылся — следующий по тому же origin уже отвечен книгой.
    expect(await trust.decideCertificate(REMOTE, HOST_PIN)).toBe(true);
    expect(human.asked).toHaveLength(1);
  });

  it('отказ схлопнутого вопроса — отказ для обоих ждущих', async () => {
    const { file } = await bookFile();
    const human = openAsk();
    const trust = createCertificateTrust({ file, ask: human.ask });
    const first = trust.decideCertificate(REMOTE, HOST_PIN);
    const second = trust.decideCertificate(REMOTE, HOST_PIN);
    await settle();
    human.answer(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(human.asked).toHaveLength(1);
  });

  it('второй сертификат того же origin при открытом вопросе — отказ, а не второе окно', async () => {
    const { file } = await bookFile();
    const human = openAsk();
    const trust = createCertificateTrust({ file, ask: human.ask });
    const first = trust.decideCertificate(REMOTE, HOST_PIN);
    await settle();
    // Принять ЧУЖОЙ сертификат по ответу про первый нельзя, а второе окно
    // запрещено требованием. Остаётся отказ этой попытке: закроется вопрос —
    // следующая попытка спросит про неё честно.
    expect(await trust.decideCertificate(REMOTE, CHANGED_PIN)).toBe(false);
    expect(human.asked).toHaveLength(1);

    human.answer(true);
    expect(await first).toBe(true);

    const again = trust.decideCertificate(REMOTE, CHANGED_PIN);
    await settle();
    expect(human.asked).toHaveLength(2);
    // Спросили именно про смену: прежний отпечаток к этому моменту в книге.
    expect(human.asked[1]).toEqual({ origin: REMOTE, fingerprint: CHANGED_PIN, known: HOST_PIN });
    human.answer(true);
    expect(await again).toBe(true);
  });

  it('разные origin спрашиваются независимо', async () => {
    const { file } = await bookFile();
    const asked: TrustQuestion[] = [];
    const trust = createCertificateTrust({
      file,
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(true);
      },
    });
    await Promise.all([
      trust.decideCertificate(REMOTE, HOST_PIN),
      trust.decideCertificate(OTHER, CHANGED_PIN),
    ]);
    expect(asked.map((question) => question.origin)).toEqual([REMOTE, OTHER]);
  });
});

/** Показ вопроса средой: помнит показанное и отвечает заранее заданным ответом. */
function showing(answer: boolean): { show: (prompt: TrustPrompt) => Promise<boolean>; shown: TrustPrompt[] } {
  const shown: TrustPrompt[] = [];
  return {
    shown,
    show: (prompt) => {
      shown.push(prompt);
      return Promise.resolve(answer);
    },
  };
}

const QUESTION: TrustQuestion = { origin: REMOTE, fingerprint: HOST_PIN, known: '' };

describe('сборка вопроса человеку (DSK-8, решение D2)', () => {
  it('без флагов прогона спрашивают среду, а не аргумент запуска', async () => {
    const human = showing(true);
    const asked: TrustQuestion[] = [];
    const dialog = createTrustAsk({ argv: [], show: human.show, asked });
    expect(await dialog.ask(QUESTION)).toBe(true);
    // Показано ровно то, что собрал `trustPrompt`: клею текст не принадлежит.
    expect(human.shown).toEqual([trustPrompt(QUESTION)]);
    expect(asked).toEqual([]);
  });

  it('автоответ БЕЗ `--contract` не действует — спрашивают человека', async () => {
    const human = showing(false);
    const asked: TrustQuestion[] = [];
    // Обычный запуск с подсунутым `--trust-answer yes`: DSK-8 знает два
    // основания доверия, и «доверять всему, что попросят» не является ни одним
    // из них. Флаг обязан не значить ничего — отвечает среда, и она отказала.
    const dialog = createTrustAsk({ argv: ['--trust-answer', 'yes'], show: human.show, asked });
    expect(await dialog.ask(QUESTION)).toBe(false);
    expect(human.shown).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('в контрактном прогоне автоответ заменяет диалог, а вопрос остаётся настоящим', async () => {
    const human = showing(false);
    const asked: TrustQuestion[] = [];
    const dialog = createTrustAsk({
      argv: ['--contract', '--trust-answer', 'yes'],
      show: human.show,
      asked,
    });
    expect(await dialog.ask(QUESTION)).toBe(true);
    // Диалога не было — предъявлять его в прогоне некому (DSK-6), — а вопрос
    // записан: случай сьюта читает именно его.
    expect(human.shown).toEqual([]);
    expect(asked).toEqual([QUESTION]);

    // `--trust-answer no` — тот же путь с другим ответом; отсутствие флага при
    // `--contract` возвращает вопрос среде.
    const refusing = createTrustAsk({ argv: ['--contract', '--trust-answer', 'no'], show: human.show, asked });
    expect(await refusing.ask(QUESTION)).toBe(false);
    const plain = createTrustAsk({ argv: ['--contract'], show: human.show, asked });
    expect(await plain.ask(QUESTION)).toBe(false);
    expect(human.shown).toHaveLength(1);
  });

  it('закрытие окна отвечает ОТКАЗОМ за открытый вопрос', async () => {
    const shown: TrustPrompt[] = [];
    const dialog = createTrustAsk({
      argv: [],
      asked: [],
      // Так выглядит открытый диалог: человек думает и не отвечает никогда.
      show: (prompt) => {
        shown.push(prompt);
        return new Promise<boolean>(() => undefined);
      },
    });
    const first = dialog.ask(QUESTION);
    const second = dialog.ask({ origin: OTHER, fingerprint: CHANGED_PIN, known: '' });
    await settle();
    expect(shown).toHaveLength(2);

    // Окна больше нет: человек ответа не даст, а соединение, севшее его ждать,
    // висело бы вечно.
    dialog.closeAll();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    // Повторное закрытие безвредно: отвечать уже не за кого.
    dialog.closeAll();
  });

  it('сорвавшийся показ вопроса — отказ, а не зависшее соединение', async () => {
    const dialog = createTrustAsk({
      argv: [],
      asked: [],
      show: () => Promise.reject(new Error('окно не открылось')),
    });
    expect(await dialog.ask(QUESTION)).toBe(false);
  });
});

describe('путь книги доверия (DSK-8, решение D1)', () => {
  const BOOK = '/данные/контейнера/trust.json';

  it('вне контрактного прогона книга одна — в каталоге данных', () => {
    // Флаг запуска, подменяющий книгу, был бы ровно тем «ослаблением проверки
    // сертификатов флагом запуска», которое DSK-8 запрещает: подлинный профиль с
    // подлинным интерфейсом молча принимал бы подставной сертификат.
    expect(trustBookPath([], BOOK)).toBe(BOOK);
    expect(trustBookPath(['--app', 'apps/server-manager.app.json'], BOOK)).toBe(BOOK);
    expect(trustBookPath(['--trust-file', '/чужая/книга.json'], BOOK)).toBe(BOOK);
    expect(trustBookPath(['--smoke', '--trust-file', '/чужая/книга.json'], BOOK)).toBe(BOOK);
  });

  it('контрактный прогон вправе назвать свою — иначе случаи склеились бы', () => {
    // Прогон поднимает окна пачками, порты ему выдаёт ОС, и повторно выданный
    // номер означал бы решение, оставленное соседним случаем.
    expect(trustBookPath(['--contract', '--trust-file', '/прогон/книга.json'], BOOK)).toBe('/прогон/книга.json');
    // `--contract` сам по себе книгу не подменяет.
    expect(trustBookPath(['--contract'], BOOK)).toBe(BOOK);
    expect(trustBookPath(['--contract', '--trust-file'], BOOK)).toBe(BOOK);
  });
});

describe('текст вопроса человеку (DSK-8)', () => {
  it('незнакомый сертификат предъявляется с origin и отпечатком', () => {
    const prompt = trustPrompt({ origin: REMOTE, fingerprint: HOST_PIN, known: '' });
    expect(prompt.changed).toBe(false);
    expect(prompt.message).toContain(REMOTE);
    expect(prompt.detail).toContain(HOST_PIN);
  });

  it('смена предъявляется с ОБОИМИ отпечатками и названа сменой', () => {
    const prompt = trustPrompt({ origin: REMOTE, fingerprint: CHANGED_PIN, known: HOST_PIN });
    expect(prompt.changed).toBe(true);
    // «предупреждение о смене с прежним и новым отпечатками»: без прежнего
    // человеку нечего сличать, и предупреждение вырождается в обычный вопрос.
    expect(prompt.detail).toContain(HOST_PIN);
    expect(prompt.detail).toContain(CHANGED_PIN);
    expect(prompt.title).toContain('изменился');
  });
});
