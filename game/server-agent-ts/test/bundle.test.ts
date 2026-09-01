/**
 * Дистрибутив хоста (SRV-7, решение D10): собирается ОДНОЙ командой, версии
 * сходятся по построению, а собранный каталог САМОДОСТАТОЧЕН.
 *
 * Самодостаточность здесь проверяется тем единственным способом, которым её
 * можно проверить, — прогоном: агент поднимается ИЗ дистрибутива (не из
 * репозитория), поднимает по нему настоящий сервер матча и раздаёт дерево
 * контента. Обещание «каталог самодостаточен» иначе держалось бы на честном
 * слове.
 *
 * `vite build` клиента в гейт не входит: он проверяется тем, что его запускает
 * та же команда, а его отсутствие дистрибутив НАЗЫВАЕТ (`distribution.json`), а
 * не прячет. Сборка страницы игрока — шаг упаковки, а не предмет этого теста.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlClient, type ControlClient } from '../src/client/index.js';
import { nodeSocket } from '../src/client/node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const BUNDLE_SCRIPT = join(HERE, '..', 'bin', 'bundle.mjs');

interface Distribution {
  readonly name: string;
  readonly buildId: string;
  readonly contentPackHash: string;
  readonly client: string;
}

describe('дистрибутив хоста собирается одной командой (SRV-7)', () => {
  let work: string;
  let out: string;
  let distribution: Distribution;
  let agent: ChildProcess | undefined;
  let client: ControlClient | undefined;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'fluxus-bundle-'));
    out = join(work, 'host-bundle');
    execFileSync(
      process.execPath,
      [
        BUNDLE_SCRIPT,
        '--out', out,
        // Сборка страницы пропущена: `vite build` в гейт не входит. Состояние
        // чужих каталогов на предмет проверки при этом не влияет — страница
        // либо собрана ЭТОЙ командой, либо её нет вовсе (SRV-7), и подобрать
        // готовую сборке нечем.
        '--skip-client',
        '--quiet',
      ],
      {
        cwd: REPO,
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 120_000,
      },
    );
    distribution = JSON.parse(readFileSync(join(out, 'distribution.json'), 'utf8')) as Distribution;
  }, 180_000);

  afterAll(() => {
    client?.close();
    agent?.kill('SIGKILL');
    rmSync(work, { recursive: true, force: true });
  });

  it('состав дистрибутива согласован: агент, стенд, контент и версии', () => {
    // Агент и запускалка сервера матча — обе на месте, обе доступны по имени
    // пакета (`node_modules` дистрибутива).
    expect(existsSync(join(out, 'game/server-agent-ts/bin/agent.mjs'))).toBe(true);
    expect(existsSync(join(out, 'game/demo-ts/bin/demo-serve.mjs'))).toBe(true);
    expect(existsSync(join(out, 'node_modules/@fluxus/net'))).toBe(true);
    expect(existsSync(join(out, 'node_modules/ws'))).toBe(true);
    expect(existsSync(join(out, 'content/matches/duel.match.json'))).toBe(true);
    expect(existsSync(join(out, 'START.md'))).toBe(true);

    // Версии посчитаны из ТЕХ ЖЕ файлов, что уехали в дистрибутив (NET-16,
    // NTR-5): собрать его из разных версий нечем — второго источника нет.
    expect(distribution.buildId).not.toBe('');
    expect(distribution.contentPackHash).not.toBe('');
    // Отсутствие страницы игрока НАЗВАНО, а не подменено заглушкой, — и названо
    // ВМЕСТЕ С ПРИЧИНОЙ: голое «отсутствует» не отличило бы осознанный пропуск
    // сборки от сборки, не оставившей каталога.
    expect(distribution.client).toBe('отсутствует: сборка страницы пропущена (--skip-client)');
    // И каталога страницы в дистрибутиве нет: подобранная с диска чужая сборка
    // — тоже страница неизвестного возраста (SRV-7).
    expect(existsSync(join(out, 'client'))).toBe(false);
  });

  it('страницу со стороны взять нечем: дистрибутив из разных версий не собирается (SRV-7)', () => {
    // Клиентский бандл несёт документы контента в себе (сцена и документ матча
    // вкомпилированы в него), и версию — `buildId` плюс хеш контент-пака —
    // клиент считает из НИХ, а предъявляет её в рукопожатии (NTR-5). Готовая
    // страница со стороны поэтому и есть вторая версия внутри дистрибутива, а
    // «собрать дистрибутив из разных версий MUST NOT быть возможно».
    const prebuilt = join(work, 'prebuilt-client');
    mkdirSync(prebuilt, { recursive: true });
    writeFileSync(join(prebuilt, 'index.html'), 'страница со стороны\n');
    const outside = join(work, 'outside-bundle');

    let status = 0;
    let output = '';
    try {
      execFileSync(
        process.execPath,
        [BUNDLE_SCRIPT, '--out', outside, '--client-dist', prebuilt, '--quiet'],
        { cwd: REPO, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 120_000, encoding: 'utf8' },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      output = failure.stderr ?? '';
    }
    // Отказ ГРОМКИЙ и названный, а не молчаливое игнорирование флага: скрипт, в
    // котором он написан, обязан узнать, что поведение сменилось.
    expect(status).toBe(2);
    expect(output).toContain('--client-dist');
    expect(output).toContain('SRV-7');
    expect(existsSync(join(outside, 'distribution.json'))).toBe(false);
  }, 120_000);

  it('агент из дистрибутива поднимает сервер и раздаёт дерево, не заглядывая в репозиторий', async () => {
    const stateDir = join(work, 'state');
    const addressFile = join(stateDir, 'address');
    agent = spawn(
      process.execPath,
      [
        'game/server-agent-ts/bin/agent.mjs',
        '--control-port', '0',
        '--http-port', '0',
        '--host', '127.0.0.1',
        '--state', stateDir,
        '--content', 'content',
        '--stand', 'game/demo-ts/bin/demo-serve.mjs',
        '--address-file', addressFile,
      ],
      { cwd: out, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } },
    );
    let output = '';
    agent.stdout?.setEncoding('utf8');
    agent.stdout?.on('data', (chunk: string) => { output += chunk; });
    agent.stderr?.setEncoding('utf8');
    agent.stderr?.on('data', (chunk: string) => { output += chunk; });

    const deadline = Date.now() + 30_000;
    while (!existsSync(addressFile) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(existsSync(addressFile), output).toBe(true);

    // Адрес и материал автопейринга приезжают ОДНОЙ строкой (MGR-5, решение D6):
    // ни адрес, ни код в приложении не зашиты.
    const address = new URL(readFileSync(addressFile, 'utf8'));
    client = createControlClient(nodeSocket);
    const welcome = await client.connect({
      url: address.origin,
      pairingCode: address.searchParams.get('code') ?? '',
      label: 'проверка дистрибутива',
    });
    // Версии дистрибутива видны ДО запуска серверов (SRV-7).
    expect(welcome.versions.buildId).toBe(distribution.buildId);
    expect(welcome.versions.contentPackHash).toBe(distribution.contentPackHash);
    expect(welcome.fingerprint).toBe(address.searchParams.get('fingerprint'));

    // Настоящий сервер матча — по документу из дистрибутива.
    const started = await client.start({
      match: 'matches/duel.match.json',
      port: 0,
      bot: '',
      botFillMs: null,
      onDisconnect: '',
      autoRestart: false,
    });
    const entry = started.servers[0]!;
    expect(entry.state).toBe('listening');
    expect(entry.joinUrl).toContain('?server=');

    // Раздача дистрибутива отдаёт дерево контента: тестеру хватит браузера.
    const asset = await fetch(new URL(entry.joinUrl).origin + '/matches/duel.match.json');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('"players"');

    await client.stop(entry.id);
  }, 120_000);
});
