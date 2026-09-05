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
import { contentPack } from '@fluxus/net';
import { readMatchFile } from '@fluxus/net/bin/matchFile.mjs';
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
  /** Второй агент — прогон по ПРАВЛЕНОМУ дереву того же дистрибутива. */
  let edited: ChildProcess | undefined;
  let editedClient: ControlClient | undefined;

  /**
   * Агент ИЗ дистрибутива: своё состояние, свой адресный файл, порты — нулевые.
   * Возвращает адрес, которым он представился (MGR-5): в нём же материал
   * автопейринга.
   */
  async function startFromBundle(name: string): Promise<{ process: ChildProcess; address: URL }> {
    const stateDir = join(work, name);
    const addressFile = join(stateDir, 'address');
    const process_ = spawn(
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
    process_.stdout.setEncoding('utf8');
    process_.stdout.on('data', (chunk: string) => { output += chunk; });
    process_.stderr.setEncoding('utf8');
    process_.stderr.on('data', (chunk: string) => { output += chunk; });

    const deadline = Date.now() + 30_000;
    while (!existsSync(addressFile) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(existsSync(addressFile), output).toBe(true);
    return { process: process_, address: new URL(readFileSync(addressFile, 'utf8')) };
  }

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
    editedClient?.close();
    agent?.kill('SIGKILL');
    edited?.kill('SIGKILL');
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

  it('страницу со стороны взять нечем: происхождение её кода не удостоверено (SRV-7)', () => {
    // Документы контента страница читает из раздачи дистрибутива (CONT-5), и
    // второй их копии в бандле нет — основание отказа поэтому не контент, а КОД:
    // `buildId` есть поле документа матча, который страница прочтёт вместе с
    // остальным, поэтому чужая сборка предъявила бы версию хозяина и прошла бы
    // сверку (NTR-5), исполняя другие правила. Удостоверяет происхождение кода
    // страницы только сборка вместе с дистрибутивом.
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
    const started = await startFromBundle('state');
    agent = started.process;
    // Адрес и материал автопейринга приезжают ОДНОЙ строкой (MGR-5, решение D6):
    // ни адрес, ни код в приложении не зашиты.
    const address = started.address;
    client = createControlClient(nodeSocket);
    const welcome = await client.connect({
      url: address.origin,
      pairingCode: address.searchParams.get('code') ?? '',
      label: 'проверка дистрибутива',
    });
    // Версии дистрибутива видны ДО запуска серверов (SRV-7). На нетронутом
    // дистрибутиве они совпадают с записью о сборке — и это свойство нетронутого
    // дистрибутива, а не инвариант: считает их агент по дереву, которое раздаёт.
    expect(welcome.versions.buildId).toBe(distribution.buildId);
    expect(welcome.versions.contentPackHash).toBe(distribution.contentPackHash);
    expect(welcome.fingerprint).toBe(address.searchParams.get('fingerprint'));

    // Настоящий сервер матча — по документу из дистрибутива.
    const running = await client.start({
      match: 'matches/duel.match.json',
      port: 0,
      bot: '',
      botFillMs: null,
      onDisconnect: '',
      autoRestart: false,
    });
    const entry = running.servers[0]!;
    expect(entry.state).toBe('listening');
    expect(entry.joinUrl).toContain('?server=');

    // Раздача дистрибутива отдаёт дерево контента: тестеру хватит браузера. По
    // этому же адресному пространству страница игрока читает документ матча и
    // конфиг сцены (CONT-5, SRV-8) — не из своего бандла.
    const asset = await fetch(new URL(entry.joinUrl).origin + '/matches/duel.match.json');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('"players"');

    await client.stop(entry.id);
  }, 120_000);

  it('правка контента внутри дистрибутива меняет версию, которую называет агент (SRV-7)', async () => {
    // Сценарий «Правка контента внутри дистрибутива»: конфиг сцены в дереве
    // правят, а страницу игрока не пересобирают. Сервер матча и заново открытая
    // страница читают ОДНО дерево (CONT-5) и сойдутся на новом хеше — значит,
    // агент обязан назвать менеджеру версию по правленому ДЕРЕВУ, а не по
    // записи о сборке: иначе он показал бы третью версию, которой нет ни у кого.
    const scenePath = join(out, 'content/scenes/duel.scene.json');
    const scene = JSON.parse(readFileSync(scenePath, 'utf8')) as {
      abilities: { cooldownTicks?: number }[];
    };
    scene.abilities[0]!.cooldownTicks = 123;
    writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);

    // Хеш считается ТЕМ ЖЕ кодом, каким его считают сервер, клиент и сам агент
    // (NET-17): вторая реализация хеширования проверяла бы саму себя.
    const document = readMatchFile(join(out, 'content/matches/duel.match.json'));
    const expected = contentPack(document.scenes!).hash;
    expect(expected).not.toBe(distribution.contentPackHash);

    // Агент версии считает НА СТАРТЕ: правка дерева видна следующему запуску,
    // как правка документа — следующему открытию страницы (Non-Goals дизайна).
    const started = await startFromBundle('state-edited');
    edited = started.process;
    editedClient = createControlClient(nodeSocket);
    const welcome = await editedClient.connect({
      url: started.address.origin,
      pairingCode: started.address.searchParams.get('code') ?? '',
      label: 'проверка правленого дерева',
    });
    expect(welcome.versions.contentPackHash).toBe(expected);
    // `buildId` документа матча правка сцены не трогает — половины версии
    // независимы (NET-16).
    expect(welcome.versions.buildId).toBe(distribution.buildId);
    // А запись о сборке осталась прежней, и это НЕ противоречие: она отвечает на
    // вопрос «что собрали», агент — на вопрос «что раздаём» (design D7).
    const record = JSON.parse(readFileSync(join(out, 'distribution.json'), 'utf8')) as Distribution;
    expect(record.contentPackHash).toBe(distribution.contentPackHash);
    expect(welcome.versions.distribution).toBe(record.name);
  }, 120_000);
});
