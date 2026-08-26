/**
 * Подпорки тестов контейнера: временное дерево на диске и подставной
 * наблюдатель.
 *
 * Наблюдатель подставной по той же причине, по которой он инжектируется в
 * коде (`src/host/observe.ts`): семантика событий — поведение кода, а тайминги
 * `fs.watch` — поведение ядра ОС. Живой наблюдатель проверяется ровно одним
 * тестом (`watchLive.test.ts`), и там ожидание — по условию с крайним сроком, а
 * не по часам.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DirectoryObserver, DirectoryObserverOptions } from '../src/host/observe.js';

/** Временный каталог с записанными файлами; ключ — путь от его корня. */
export async function makeTree(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fluxus-shell-'));
  for (const [path, content] of Object.entries(files)) await putFile(root, path, content);
  return root;
}

export async function putFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function readText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

/** Содержимое файла, которого странице видеть не положено. */
export const OUTSIDE_SECRET = 'СЕКРЕТ ВНЕ КОРНЯ';

/**
 * Ссылка на КАТАЛОГ. На Windows обычная символическая ссылка требует
 * привилегии, а junction — нет; `realpath` разрешает обе одинаково, и DSK-5 про
 * то, КУДА путь разрешается, а не каким видом ссылки он туда ведёт. Так случай
 * «дерево привезло ссылку наружу» проверяется и там, где ссылки заводить
 * запрещено.
 */
export async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Умеет ли окружение заводить ссылку на ФАЙЛ.
 *
 * У каталога обход есть (`linkDirectory`), у файла — нет: junction'а для файла
 * не существует, а символическая ссылка на Windows остаётся привилегией (режим
 * разработчика либо администратор). Отсутствие привилегии — свойство машины, а
 * не дефект, поэтому случай файловой ссылки в такой среде ПРОПУСКАЕТСЯ явно:
 * назвать проверку непроведённой честнее, чем молча ослабить её до каталога.
 */
export const FILE_LINKS_ALLOWED = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'fluxus-link-'));
  try {
    writeFileSync(join(probe, 'target'), '');
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Кладёт по `path` внутри дерева ссылку на каталог `outside` (вне дерева), где
 * лежит `secret.txt`. Так дерево контента приезжает от чужого инструмента —
 * страница ссылок не создаёт (DSK-5).
 */
export async function linkOutside(root: string, path: string, outside: string): Promise<void> {
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), OUTSIDE_SECRET);
  await linkDirectory(outside, join(root, path));
}

export async function dropTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export interface FakeObserver {
  readonly observer: DirectoryObserver;
  /** Сколько наблюдений открыто прямо сейчас. */
  readonly open: number;
  /** Сообщить об изменении так, как это сделал бы `fs.watch`. */
  emit(relative: string | null): void;
}

export function fakeObserver(): FakeObserver {
  const opened: DirectoryObserverOptions[] = [];
  let live = 0;
  return {
    observer: (options) => {
      opened.push(options);
      live += 1;
      return {
        active: true,
        close: () => {
          live -= 1;
        },
      };
    },
    get open(): number {
      return live;
    },
    emit(relative) {
      for (const options of opened) options.changed(relative);
    },
  };
}

/** Ждёт условия до крайнего срока: медленная машина делает тест медленнее, а не красным. */
export async function waitFor(condition: () => boolean, deadlineMs = 4000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 10));
  }
  return condition();
}

/** Скрипт сервиса-пустышки: то, что объявляет профиль контрактного прогона (DSK-7). */
export const SERVICE_SCRIPT = fileURLToPath(new URL('./fixtures/service.mjs', import.meta.url));

/** Сервис, который выходит сразу: случай «не поднялся» без трассы в выводе гейта. */
export const DEAD_SERVICE_SCRIPT = fileURLToPath(
  new URL('./fixtures/deadService.mjs', import.meta.url),
);

/** Сервис, отмечающий каждый свой запуск строкой в файле `--mark` (DSK-7). */
export const MARKED_SERVICE_SCRIPT = fileURLToPath(
  new URL('./fixtures/markedService.mjs', import.meta.url),
);

/** Отвязываемый сервис: пишет свой адрес в файл и отмечает запуски (DSK-7). */
export const DETACHED_SERVICE_SCRIPT = fileURLToPath(
  new URL('./fixtures/detachedService.mjs', import.meta.url),
);

/**
 * Шифрованный сервис-пустышка (DSK-8): держит wss на self-signed сертификате,
 * который РОЖДАЕТ САМА на каждом запуске, и пишет его закрепление в
 * `--pin-file`. Нужен прогону вне гейта — тому, где сертификат отвергает
 * настоящий Chromium. Приватного ключа в репозитории поэтому нет: постоянство
 * отпечатка нужно не ей, а тесту счёта отпечатка ниже.
 */
export const TLS_SERVICE_SCRIPT = fileURLToPath(
  new URL('./fixtures/tlsService.mjs', import.meta.url),
);

/**
 * Committed self-signed СЕРТИФИКАТ фикстур — публичный, без ключа.
 *
 * Он и есть тот сертификат, который «отвергнут штатной проверкой платформы»
 * (DSK-8): цепочки у него нет по построению. Committed он ровно затем, чтобы
 * отпечаток в гейтовом тесте счёта (`certificate.test.ts`) был постоянным и
 * записанным здесь же числом.
 */
export const PINNED_CERTIFICATE = fileURLToPath(
  new URL('./fixtures/pinned.cert.pem', import.meta.url),
);

/** Отпечаток фикстуры: SHA-256 её DER в нижнем регистре без разделителей. */
export const PINNED_FINGERPRINT = 'e89a5aa6c449f36e668df04bcec3aee6081b2ba3bd29c17e0db3132481897cdd';

/**
 * Свободный порт: занимаем и сразу отпускаем. Гонка тут возможна в принципе, но
 * адрес сервиса обязан быть известен ДО запуска (его объявляет профиль), а
 * выбирать фиксированный номер в тесте — способ поссориться с соседом по машине.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Держит адрес занятым: так выглядит сервис, поднятый мимо контейнера. */
export async function squat(port: number): Promise<() => Promise<void>> {
  const server = createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((done) => {
    server.listen(port, '127.0.0.1', done);
  });
  return () =>
    new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
