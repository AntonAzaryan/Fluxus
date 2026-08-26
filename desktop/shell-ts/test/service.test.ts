/**
 * Механика объявленных сервисов (DSK-7) — то, чего общий сьют границы не видит:
 * подстановка адреса в аргументы, занятый адрес и владение процессом.
 *
 * Сьют проверяет ГРАНИЦУ и говорит только тем, что видит страница; здесь —
 * хост, у которого есть процессы и порты. Разделение то же, что у корней:
 * контракт в сьюте, файловая механика — в своих тестах.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeAppProfile } from '../src/bridge/profile.js';
import { createHostServices, endpointOf, serviceArgs } from '../src/host/service.js';
import {
  detachedFiles,
  forgetDetached,
  processStartTicks,
  readPinFile,
  sameProcess,
  serviceSpawnOptions,
} from '../src/host/detached.js';
import {
  DEAD_SERVICE_SCRIPT,
  DETACHED_SERVICE_SCRIPT,
  dropTree,
  freePort,
  makeTree,
  MARKED_SERVICE_SCRIPT,
  SERVICE_SCRIPT,
  squat,
  waitFor,
} from './support.js';

/**
 * Закрепление, которое пишет сервис-пустышка: своего сертификата у неё нет, и
 * отпечаток ей называет тот, кто её объявил (`--pin`). Форма — та же, что у
 * настоящего: 64 hex-знака нижнего регистра (решение D1).
 */
const SERVICE_PIN = 'b3'.repeat(32);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function profileWith(
  port: number,
  script = SERVICE_SCRIPT,
  args: readonly string[] = ['--port', '{port}', '--host', '{host}'],
  detached = false,
): ReturnType<typeof normalizeAppProfile> {
  return normalizeAppProfile(
    {
      id: 'game',
      title: 'Fluxus',
      bundle: 'dist',
      roots: [{ id: 'content', directory: 'content', serve: true }],
      capabilities: ['service'],
      services: [
        {
          id: 'stand',
          script,
          args: [...args],
          address: `tcp://127.0.0.1:${String(port)}`,
          detached,
        },
      ],
    },
    'game.app.json',
  );
}

describe('адрес — единственный источник правды о порте (design D1)', () => {
  it('хост и порт вынимаются из адреса, а смысла ему это не придаёт', () => {
    expect(endpointOf('ws://127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(endpointOf('tcp://[::1]:9000')).toEqual({ host: '::1', port: 9000 });
    // Адреса без порта бывают, и это не ошибка: готовность такого сервиса —
    // просто «процесс запущен».
    expect(endpointOf('ws://example')).toBeUndefined();
    expect(endpointOf('ерунда')).toBeUndefined();
  });

  it('подстановка кладёт порт адреса в аргументы', () => {
    const profile = profileWith(8080);
    expect(serviceArgs(profile.services[0]!)).toEqual(['--port', '8080', '--host', '127.0.0.1']);
  });

  it('путь адресного файла подставляет КОНТЕЙНЕР, а не манифест и не страница (DSK-7)', () => {
    const profile = profileWith(8080, SERVICE_SCRIPT, ['--address-file', '{addressFile}']);
    expect(serviceArgs(profile.services[0]!, '/state/stand.address')).toEqual([
      '--address-file',
      '/state/stand.address',
    ]);
    // Без каталога состояния подстановка пуста: выдумывать путь контейнер не
    // вправе — процесс тогда написал бы адрес неизвестно куда.
    expect(serviceArgs(profile.services[0]!)).toEqual(['--address-file', '']);
  });

  it('путь файла закрепления подставляется тем же способом (DSK-8, решение D2)', () => {
    const profile = profileWith(8080, SERVICE_SCRIPT, ['--pin-file', '{pinFile}']);
    expect(serviceArgs(profile.services[0]!, '/state/stand.address', '/state/stand.pin')).toEqual([
      '--pin-file',
      '/state/stand.pin',
    ]);
    // Признак закрепления — сама подстановка, и новых полей у профиля нет: чьё
    // объявление её не подставляет, тот закрепления не обещает и живёт как жил.
    expect(serviceArgs(profile.services[0]!)).toEqual(['--pin-file', '']);
    const plain = profileWith(8080, SERVICE_SCRIPT, ['--port', '{port}']);
    expect(serviceArgs(plain.services[0]!, '/state/stand.address', '/state/stand.pin')).toEqual([
      '--port',
      '8080',
    ]);
  });
});

describe('опции запуска отвязываемого сервиса (DSK-7, решение D6)', () => {
  it('обычный сервис наследует stdio и в свою группу процессов не уходит', () => {
    expect(serviceSpawnOptions(false, 'linux')).toEqual({ stdio: 'inherit' });
    expect(serviceSpawnOptions(false, 'win32')).toEqual({ stdio: 'inherit' });
  });

  it('отвязываемый уходит в свою группу и отпускает потоки — на обеих платформах', () => {
    // POSIX: `detached` — новая группа процессов, поэтому сигнал, адресованный
    // контейнеру, не приходит сервису.
    expect(serviceSpawnOptions(true, 'linux')).toEqual({ detached: true, stdio: 'ignore' });
    // Windows: групп процессов в том же смысле нет, но флаг означает то же —
    // «не умирать вместе с родителем»; отдельно гасится консольное окно,
    // которого у десктопного приложения быть не должно.
    expect(serviceSpawnOptions(true, 'win32')).toEqual({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('каталог состояния, открытый на запись чужим, — НАЗВАННЫЙ отказ (DSK-7)', async () => {
    // `mkdirSync(..., { mode })` выставляет права только при СОЗДАНИИ: каталог,
    // заведённый раньше нас соседом по машине (имя предсказуемо), сохраняет свои
    // права. А в нём — pid, которому уходит SIGKILL, и адрес, которым страница
    // предъявляет материал автопейринга (MGR-5, SRV-3).
    const root = await makeTree();
    cleanups.push(() => dropTree(root));
    const stateDir = join(root, 'services');
    // Прав POSIX Windows этими полями не выражает: утверждать по ним что-либо
    // было бы выдумкой, и проверка там не работает по построению.
    if (process.platform === 'win32') {
      expect(() => detachedFiles(stateDir, 'stand')).not.toThrow();
      return;
    }
    await mkdir(stateDir, { recursive: true, mode: 0o777 });
    await chmod(stateDir, 0o777);
    expect(() => detachedFiles(stateDir, 'stand')).toThrow(/на запись/);

    // Свой и закрытый каталог отказом не является: отказывает не проверка, а
    // конкретное положение дел.
    await chmod(stateDir, 0o700);
    expect(() => detachedFiles(stateDir, 'stand')).not.toThrow();
  });

  it('пере-обнаружение сверяет МОМЕНТ старта, а не только PID (DSK-7)', () => {
    // Голого «PID жив» мало: после перезагрузки его носит чужой процесс, и
    // тогда `stopPid` убил бы постороннего, а пере-обнаружение воскресило бы
    // фантомный сервис. Момент старта отличает наш процесс от занявшего номер.
    const startProc = process.platform === 'linux' ? processStartTicks(process.pid) : 0;
    expect(sameProcess({ pid: process.pid, startProc })).toBe(true);
    if (process.platform === 'linux') {
      expect(sameProcess({ pid: process.pid, startProc: startProc + 1 })).toBe(false);
    }
    // Момент неизвестен (не Linux, старый pid-файл) — падаем на существование.
    expect(sameProcess({ pid: process.pid, startProc: 0 })).toBe(true);
    expect(sameProcess({ pid: 2_147_483_646, startProc: 0 })).toBe(false);
  });
});

describe('жизненный цикл объявленного сервиса (DSK-7)', () => {
  it('поднятый сервис снимается вместе с сессией', async () => {
    const port = await freePort();
    const services = createHostServices({ profile: profileWith(port) });
    cleanups.push(() => services.closeAll());

    const started = await services.start('stand');
    expect(started.running).toBe(true);
    expect(services.owned()).toBe(1);

    await services.closeAll();
    expect(services.owned()).toBe(0);
    expect((await services.state('stand')).running).toBe(false);
  });

  it('занятый адрес уступается: процесса нет, а сервис работает', async () => {
    const port = await freePort();
    const release = await squat(port);
    cleanups.push(release);
    const services = createHostServices({ profile: profileWith(port) });
    cleanups.push(() => services.closeAll());

    const started = await services.start('stand');
    expect(started.running).toBe(true);
    // Своего процесса контейнер не поднял — и на закрытии окна чужой не снимет:
    // владение себе не приписано (design D3).
    expect(services.owned()).toBe(0);
    await services.stop('stand');
    expect((await services.state('stand')).running).toBe(true);
  });

  it('не поднявшийся сервис отвечает отказом, а не молчанием', async () => {
    const port = await freePort();
    const services = createHostServices({
      profile: profileWith(port, DEAD_SERVICE_SCRIPT),
      readyTimeoutMs: 2000,
    });
    cleanups.push(() => services.closeAll());

    await expect(services.start('stand')).rejects.toThrow('stand');
    expect(services.owned()).toBe(0);
  });

  it('незнакомое имя не доходит до запуска', async () => {
    const services = createHostServices({ profile: profileWith(await freePort()) });
    await expect(services.start('другой')).rejects.toThrow('не объявлен');
  });

  it('наложившиеся запуски делят один процесс, и сессия его снимает (DSK-7)', async () => {
    const port = await freePort();
    const tree = await makeTree();
    cleanups.push(() => dropTree(tree));
    const marks = join(tree, 'starts.log');
    const services = createHostServices({
      profile: profileWith(port, MARKED_SERVICE_SCRIPT, ['--port', '{port}', '--mark', marks]),
    });
    cleanups.push(() => services.closeAll());

    // Страница вправе позвать мост дважды, не дождавшись первого ответа: ручки
    // IPC исполняются параллельно. Второй spawn осиротил бы первый процесс —
    // перезаписанную запись в `owned` закрытие сессии уже не сняло бы.
    const [first, second] = await Promise.all([services.start('stand'), services.start('stand')]);
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(services.owned()).toBe(1);
    expect((await readFile(marks, 'utf8')).trim().split('\n')).toHaveLength(1);

    await services.closeAll();
    expect((await services.state('stand')).running).toBe(false);
  });
});

describe('закрепление сертификата объявленного сервиса (DSK-8)', () => {
  it('валидное содержимое читается, мусор и отсутствие — «закрепления нет» (решение D1)', async () => {
    const root = await makeTree();
    cleanups.push(() => dropTree(root));
    const files = detachedFiles(join(root, 'services'), 'stand');
    // Имя файла — имя сервиса из ОБЪЯВЛЕНИЯ, рядом с адресным и pid-файлом.
    expect(files.pinFile).toBe(join(root, 'services', 'stand.pin'));

    // Файла нет вовсе — закрепления нет: сервис его ещё не писал.
    expect(readPinFile(files.pinFile)).toBe('');
    await writeFile(files.pinFile, `  ${SERVICE_PIN}\n`);
    expect(readPinFile(files.pinFile)).toBe(SERVICE_PIN);

    // Всё, что не отпечаток, читается как отсутствие закрепления: у сверки
    // сертификатов «не понял» обязано означать отказ, а не сравнение с мусором.
    for (const garbage of [
      '',
      '\n',
      'закрепления тут нет',
      SERVICE_PIN.toUpperCase(),
      SERVICE_PIN.slice(0, 63),
      `${SERVICE_PIN}0`,
      `${SERVICE_PIN} ${SERVICE_PIN}`,
    ]) {
      await writeFile(files.pinFile, garbage);
      expect(readPinFile(files.pinFile), JSON.stringify(garbage)).toBe('');
    }
  });

  it('забытый сервис уносит и своё закрепление', async () => {
    const root = await makeTree();
    cleanups.push(() => dropTree(root));
    const files = detachedFiles(join(root, 'services'), 'stand');
    await writeFile(files.addressFile, 'tcp://127.0.0.1:1\n');
    await writeFile(files.pidFile, '1 0\n');
    await writeFile(files.pinFile, `${SERVICE_PIN}\n`);

    forgetDetached(files);
    // Оставленное закрепление продолжало бы расширять доверие на сертификат
    // сервиса, которого больше нет.
    expect(existsSync(files.pinFile)).toBe(false);
    expect(existsSync(files.addressFile)).toBe(false);
    expect(existsSync(files.pidFile)).toBe(false);
  });

  it('закрепление появляется после записи файла САМИМ сервисом и переживает сессию (решение D3)', async () => {
    const port = await freePort();
    const root = await makeTree();
    const stateDir = join(root, 'services');
    const profile = profileWith(
      port,
      DETACHED_SERVICE_SCRIPT,
      ['--port', '{port}', '--address-file', '{addressFile}', '--pin-file', '{pinFile}', '--pin', SERVICE_PIN],
      true,
    );
    const services = createHostServices({ profile, stateDir });
    cleanups.push(async () => {
      // Отвязываемый переживает сессию намеренно (DSK-7) — прогон уносит его
      // явной остановкой, а не надеждой на закрытие.
      await services.stop('stand');
      await services.closeAll();
    });
    cleanups.push(() => dropTree(root));

    // Закрепление строит не контейнер: пока сервис не написал файл, закреплять
    // нечего (DSK-8 — «контейнер MUST NOT строить закрепление сам»).
    expect(services.certificatePins()).toEqual([]);

    await services.start('stand');
    await waitFor(() => services.certificatePins().length > 0);
    expect(services.certificatePins()).toEqual([SERVICE_PIN]);

    // Новая сессия того же профиля на том же каталоге состояния: процесса она не
    // поднимала, а закрепление пережившего читает из того же файла (DSK-8,
    // сценарий «Сервис пережил сессию»).
    const next = createHostServices({ profile, stateDir });
    expect(next.certificatePins()).toEqual([SERVICE_PIN]);

    // Испорченный файл выпадает из множества целиком: доверять половине строки
    // не на чем.
    await writeFile(detachedFiles(stateDir, 'stand').pinFile, 'не отпечаток\n');
    expect(services.certificatePins()).toEqual([]);
  });

  it('непригодный каталог состояния — пустое множество, а не исключение', async () => {
    const root = await makeTree();
    cleanups.push(() => dropTree(root));
    const stateDir = join(root, 'services');
    const services = createHostServices({
      profile: profileWith(await freePort(), DETACHED_SERVICE_SCRIPT, ['--port', '{port}'], true),
      stateDir,
    });
    // Вопрос задаёт проверка сертификата: исключение здесь означало бы упавший
    // контейнер вместо отвергнутого сертификата. Громко тот же отказ звучит на
    // запуске сервиса.
    if (process.platform !== 'win32') {
      await mkdir(stateDir, { recursive: true, mode: 0o777 });
      await chmod(stateDir, 0o777);
      expect(() => detachedFiles(stateDir, 'stand')).toThrow(/на запись/);
    }
    expect(services.certificatePins()).toEqual([]);
  });

  it('сервис без закрепления множества не пополняет', async () => {
    const port = await freePort();
    const root = await makeTree();
    const stateDir = join(root, 'services');
    // Тот же отвязываемый сервис, но его объявление `{pinFile}` не подставляет:
    // «Сервис без файла закрепления SHALL вести себя как сегодня» (DSK-8).
    const services = createHostServices({
      profile: profileWith(
        port,
        DETACHED_SERVICE_SCRIPT,
        ['--port', '{port}', '--address-file', '{addressFile}'],
        true,
      ),
      stateDir,
    });
    cleanups.push(async () => {
      await services.stop('stand');
      await services.closeAll();
    });
    cleanups.push(() => dropTree(root));

    await services.start('stand');
    expect(services.certificatePins()).toEqual([]);
  });
});
