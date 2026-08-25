#!/usr/bin/env node
/**
 * Агент хоста (`server-control` SRV-1..SRV-8): headless-демон, который поднимает
 * серверы матча, наблюдает их и отдаёт один управляющий эндпоинт.
 *
 *   node game/server-agent-ts/bin/agent.mjs [--control-port 8443] [--http-port 8088]
 *                                           [--host 0.0.0.0] [--control-host <интерфейс>]
 *                                           [--advertise <публичный хост>] [--state <каталог>]
 *                                           [--content content] [--bundle <каталог>]
 *                                           [--stand <запускалка>] [--address-file <файл>]
 *
 * `--advertise` — публичный хост, которым агент называет игровой эндпоинт и
 * ссылку входа (SRV-8). Без него он выводится из хоста РАЗДАЧИ (`--host`), а при
 * «слушать на всех» (`0.0.0.0`) — из имени машины: loopback-ссылка тестеру
 * бесполезна. `--control-host` привязывает УПРАВЛЯЮЩИЙ канал отдельно от раздачи:
 * у агента, поднятого контейнером (MGR-5), control — loopback, раздача — наружу.
 *   node game/server-agent-ts/bin/agent.mjs pair [--state <каталог>] [--label "менеджер"]
 *
 * Команда `pair` — ЕДИНСТВЕННАЯ локальная команда агента (SRV-3): она предъявляет
 * короткоживущий код, который клиент обменивает на долгоживущий токен. Серверами
 * она не управляет: способ управления агентом один — управляющий протокол
 * (SRV-1).
 *
 * `--address-file` пишет адрес управляющего эндпоинта вместе с материалом
 * автопейринга — тот самый способ, каким адрес отвязываемого сервиса
 * пере-обнаруживается через границу сессий (`desktop-shell` DSK-7, решение D6) и
 * каким страница менеджера получает адрес локального агента, не зашивая его в
 * себя (`server-manager` MGR-5). Токен в файле каталога состояния лежит открытым
 * текстом — та же осознанная цена, что и у самого файла токенов (решение D4).
 *
 * Флаги принимаются обеими формами — `--port=8443` и `--port 8443` — тем же
 * разбором, что и у прочих запускалок репозитория (CLI-11).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, option } from '@fluxus/net/bin/matchFile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fromRepo = (relative) => resolve(HERE, '../../..', relative);

if (flag('help')) {
  process.stdout.write(
    'usage: node game/server-agent-ts/bin/agent.mjs [--control-port 8443] [--http-port 8088]\n' +
      '       [--host 0.0.0.0] [--control-host <интерфейс>] [--advertise <публичный хост>]\n' +
      '       [--state <каталог>] [--content content] [--bundle <каталог>] [--stand <запускалка>]\n' +
      '       [--address-file <файл>]\n' +
      '       node .../agent.mjs pair [--state <каталог>] [--label "менеджер"]\n',
  );
  process.exit(0);
}

const { agentPaths, defaultStateDir, tokenStore } = await import('../src/index.ts');

const stateDir = option('state', defaultStateDir());

// Локальная команда пейринга (SRV-3). Отдельным процессом от агента намеренно:
// код предъявляет ЧЕЛОВЕК У МАШИНЫ, и работать это обязано при уже запущенном
// демоне — поэтому перечень кодов живёт файлом каталога состояния, а не памятью
// процесса.
if (process.argv[2] === 'pair') {
  const paths = agentPaths(stateDir);
  const code = tokenStore(paths.tokensFile).issueCode(Date.now());
  process.stdout.write(
    `код пейринга: ${code}\n` +
      '  действует 5 минут и обменивается на токен ОДИН раз (SRV-3)\n' +
      `  каталог состояния: ${paths.root}\n`,
  );
  process.exit(0);
}

const { readMatchFile } = await import('@fluxus/net/bin/matchFile.mjs');
const { contentPack } = await import('@fluxus/net');
const { startAgent } = await import('../src/index.ts');

const contentRoot = resolve(process.cwd(), option('content', fromRepo('content')));
const standScript = resolve(process.cwd(), option('stand', fromRepo('game/demo-ts/bin/demo-serve.mjs')));
const bundleArg = option('bundle', '');
const addressFile = option('address-file', '');

/**
 * Каталог клиентского бандла: относительный путь ищется сперва от cwd
 * (дистрибутив хоста запускается из своего корня — `--bundle client`), затем от
 * корня репозитория (профиль контейнера задаёт репо-относительный путь, а cwd у
 * поднятого сервиса непредсказуем). Пустая строка — бандла нет, `/` не отдаётся.
 */
function resolveBundle(arg) {
  if (arg === '') return '';
  const fromCwd = resolve(process.cwd(), arg);
  return existsSync(fromCwd) ? fromCwd : fromRepo(arg);
}
const bundleDir = resolveBundle(bundleArg);

/**
 * Версии дистрибутива (SRV-7). В собранном host bundle они приезжают
 * `distribution.json`, где сошлись ПО ПОСТРОЕНИЮ (решение D10); в репозитории
 * дистрибутива нет, и агент называет то, что видит сам: buildId документа матча
 * и хеш его контент-пака, посчитанный ТЕМ ЖЕ кодом, каким его считают стенд и
 * клиент (NET-16, NTR-5).
 */
function versions() {
  try {
    const distribution = JSON.parse(
      readFileOrEmpty(resolve(contentRoot, '..', 'distribution.json')) || '{}',
    );
    if (typeof distribution.buildId === 'string' && distribution.buildId !== '') {
      return {
        buildId: distribution.buildId,
        contentPackHash: String(distribution.contentPackHash ?? ''),
        distribution: String(distribution.name ?? 'host-bundle'),
      };
    }
  } catch {
    // Испорченный `distribution.json` не должен мешать агенту подняться: версии
    // назовутся ниже — по тому, что видно в дереве контента.
  }
  try {
    const match = readMatchFile(resolve(contentRoot, 'matches/duel.match.json'));
    return {
      buildId: match.buildId ?? '',
      contentPackHash: contentPack(match.scenes).hash,
      distribution: 'repo',
    };
  } catch {
    return { buildId: '', contentPackHash: '', distribution: 'repo' };
  }
}

function readFileOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Публичный хост (SRV-8): им агент называет игровой эндпоинт и ссылку входа.
// Пусто — агент выведет его сам (хост раздачи, а при «слушать на всех» — имя
// машины).
const advertise = option('advertise', '');
// Интерфейс управляющего канала отдельно от раздачи (MGR-5): у поднятого
// контейнером агента control — loopback, а раздача — наружу. Пусто — как `host`.
const controlHost = option('control-host', '');

const agent = await startAgent({
  controlPort: Number(option('control-port', 8443)),
  httpPort: Number(option('http-port', 8088)),
  host: option('host', '0.0.0.0'),
  ...(controlHost === '' ? {} : { controlHost }),
  ...(advertise === '' ? {} : { advertiseHost: advertise }),
  stateDir,
  standScript,
  contentRoot,
  bundleDir,
  versions: versions(),
});

// Автопейринг локального агента (MGR-5): адрес и токен уезжают адресным файлом,
// который читает контейнер и отдаёт странице как адрес сервиса. Страница ничего
// не зашивает в себя и ничего не выбирает — она получает строку.
if (addressFile !== '') {
  const code = agent.tokens.issueCode(Date.now());
  const url = `${agent.controlUrl}?code=${code}&fingerprint=${agent.certificate.fingerprint}`;
  mkdirSync(dirname(resolve(process.cwd(), addressFile)), { recursive: true });
  writeFileSync(resolve(process.cwd(), addressFile), url, { mode: 0o600 });
}

process.stdout.write(
  `агент хоста поднят\n` +
    `  управляющий канал: ${agent.controlUrl}\n` +
    `  отпечаток: ${agent.certificate.fingerprint}\n` +
    (agent.httpUrl === '' ? '' : `  раздача клиента: ${agent.httpUrl}\n`) +
    `  каталог состояния: ${agent.paths.root}\n` +
    `  стенд: ${standScript}\n` +
    `  контент: ${contentRoot}\n` +
    (agent.survivors.length > 0
      ? `  пережившие прошлый запуск процессы: ${agent.survivors.map((entry) => `${entry.id}:${entry.pid}`).join(', ')}\n`
      : '') +
    '  пейринг: npm run agent:pair\n',
);

const shutdown = async () => {
  await agent.close();
  process.stdout.write('\nагент остановлен\n');
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
