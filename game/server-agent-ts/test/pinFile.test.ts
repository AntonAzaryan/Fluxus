/**
 * Закрепление сертификата для десктоп-контейнера (`desktop-shell` DSK-8,
 * решение D5; `server-manager` MGR-5).
 *
 * Агент — отвязываемый сервис профиля менеджера, и его управляющий канал
 * существует ТОЛЬКО шифрованным (SRV-3). Self-signed сертификат Chromium
 * отвергает и внутри контейнера, поэтому агент называет контейнеру закрепление
 * сам: `--pin-file` — одна строка с тем же отпечатком, который закрепляет
 * клиент.
 *
 * Проверяется прогоном настоящей запускалки (`bin/agent.mjs`), а не вызовом
 * функции: флаг и момент записи — свойства запускалки, и подделать их вызовом
 * `startAgent` значило бы проверить не то.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCertificate, fingerprintOf } from '../src/state/certificate.js';
import { agentPaths } from '../src/state/paths.js';
import { FAKE_STAND, sandbox, type Sandbox } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const AGENT = join(HERE, '..', 'bin', 'agent.mjs');

const boxes: Sandbox[] = [];
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const box of boxes.splice(0)) box.drop();
});

/** Поднимает агента запускалкой и ждёт, пока он напишет файл закрепления. */
async function launch(box: Sandbox, pinFile: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      AGENT,
      '--control-port', '0',
      '--http-port', '0',
      '--host', '127.0.0.1',
      '--state', box.stateDir,
      '--content', box.contentRoot,
      '--stand', FAKE_STAND,
      '--pin-file', pinFile,
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } },
  );
  running.push(child);
  // Вывод копится целиком: он и есть объяснение, если файла так и не будет.
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { output += chunk; });

  const deadline = Date.now() + 60_000;
  while (!existsSync(pinFile) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  expect(existsSync(pinFile), output).toBe(true);
  return output;
}

describe('файл закрепления сертификата агента (DSK-8, решение D5)', () => {
  it('содержит ровно отпечаток сертификата, и перезапуск пишет то же значение', async () => {
    const box = sandbox();
    boxes.push(box);
    const pinFile = join(box.stateDir, 'agent.pin');

    await launch(box, pinFile);
    const written = readFileSync(pinFile, 'utf8').trim();
    // Ровно отпечаток и ничего больше: формат файла задаёт контейнер — одна
    // строка, SHA-256 в шестнадцатеричном нижнем регистре без разделителей.
    expect(written).toMatch(/^[0-9a-f]{64}$/);
    // И это отпечаток ЕГО сертификата — того же, который агент называет клиенту
    // и который клиент закрепляет по SRV-3.
    const paths = agentPaths(box.stateDir);
    expect(written).toBe(fingerprintOf(readFileSync(paths.certFile, 'utf8')));

    // Перезапуск на том же каталоге состояния переиспользует сертификат
    // (SRV-3), поэтому закрепление стабильно: ротация ему не нужна, а
    // менявшееся на каждый рестарт закрепление означало бы менеджер, у которого
    // канал к агенту отваливается после штатной перезагрузки машины.
    for (const child of running.splice(0)) child.kill('SIGKILL');
    // Файл уносится ПЕРЕД вторым запуском: иначе «то же значение» доказывал бы
    // файл, оставшийся от первого, а второй мог не писать вовсе.
    rmSync(pinFile, { force: true });
    await launch(box, pinFile);
    expect(readFileSync(pinFile, 'utf8').trim()).toBe(written);
  }, 180_000);

  it('отпечаток — стандартный SHA-256 сертификата: контейнер считает то же число (DSK-8, решение D4)', () => {
    const box = sandbox();
    boxes.push(box);
    const certificate = ensureCertificate(agentPaths(box.stateDir));
    // Контейнер импортировать `fingerprintOf` не вправе (DSK-3) и повторяет
    // алгоритм у себя. Разойтись двум счётам не даёт третий, независимый от них
    // обоих: разбор сертификата самим Node. С ним же сверяется и сторона
    // контейнера (`desktop/shell-ts/test/certificate.test.ts`).
    const byNode = new X509Certificate(certificate.cert).fingerprint256.replaceAll(':', '').toLowerCase();
    expect(certificate.fingerprint).toBe(byNode);
  });
});
