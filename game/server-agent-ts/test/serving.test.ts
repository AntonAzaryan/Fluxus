/**
 * Раздача клиента тестерам (SRV-8, решение D10) и словарь линий стенда (D2).
 *
 * Предмет раздачи: страница и дерево контента отдаются, ЗАПИСИ нет ни в каком
 * виде, а ссылка входа указывает на раздаваемую страницу с адресом сервера. То
 * есть ровно сценарий «тестер без окружения»: человеку достаточно браузера и
 * ссылки.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServe, type HttpServe } from '../src/httpServer.js';
import {
  CONTROL_LINE_PREFIX,
  decodeStandCommand,
  decodeStandLine,
  encodeStandCommand,
  encodeStandLine,
} from '../src/stand/lines.js';
import { sandbox, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const serves: HttpServe[] = [];

afterEach(async () => {
  for (const serve of serves.splice(0)) await serve.close();
  for (const box of boxes.splice(0)) box.drop();
});

async function serving(): Promise<{ serve: HttpServe; box: Sandbox }> {
  const box = sandbox();
  boxes.push(box);
  const bundleDir = join(box.contentRoot, '..', 'bundle');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'index.html'), '<!doctype html><title>Fluxus</title>');
  writeFileSync(join(bundleDir, 'app.js'), 'export const app = 1;\n');
  mkdirSync(join(box.contentRoot, 'visuals'), { recursive: true });
  writeFileSync(join(box.contentRoot, 'visuals', 'manifest.json'), '{"visuals":{}}');
  const serve = await startHttpServe({ port: 0, host: '127.0.0.1', bundleDir, contentRoot: box.contentRoot });
  serves.push(serve);
  return { serve, box };
}

describe('раздача клиента и дерева контента (SRV-8)', () => {
  it('страница и ассеты дерева отдаются одним адресным пространством', async () => {
    const { serve } = await serving();
    const base = `http://127.0.0.1:${String(serve.port)}`;

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Fluxus');
    expect(page.headers.get('content-type')).toContain('text/html');

    // Ассет дерева — по ID-пути (ASSET-2), тем же адресом, что и в браузере.
    const asset = await fetch(`${base}/visuals/manifest.json`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('{"visuals":{}}');

    // Чего нет ни в одном слое — того нет.
    expect((await fetch(`${base}/нет-такого.png`)).status).toBe(404);
  });

  it('раздача ТОЛЬКО на чтение: записи в дерево через агента не существует', async () => {
    const { serve, box } = await serving();
    const base = `http://127.0.0.1:${String(serve.port)}`;
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      const response = await fetch(`${base}/visuals/manifest.json`, { method, body: 'x' });
      expect(response.status).toBe(405);
    }
    // И дерево осталось нетронутым.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(box.contentRoot, 'visuals', 'manifest.json'), 'utf8')).toBe('{"visuals":{}}');
  });

  it('выход за корень раздачи не проходит', async () => {
    const { serve } = await serving();
    const base = `http://127.0.0.1:${String(serve.port)}`;
    for (const escape of ['/../../secret', '/visuals/../../secret', '/%2e%2e/secret']) {
      expect((await fetch(`${base}${escape}`)).status).toBe(404);
    }
  });

  it('битая процент-последовательность — 404, а не падение агента', async () => {
    const { serve } = await serving();
    const base = `http://127.0.0.1:${String(serve.port)}`;
    // `decodeURIComponent('%')` бросает `URIError`; необработанное исключение в
    // обработчике запроса уронило бы весь агент — процесс, супервизирующий
    // каждый сервер матча. Раздача не аутентифицирована, так что путь этот
    // открыт кому угодно.
    for (const bad of ['/%', '/%zz', '/visuals/%E0%A4%A', '/%C0']) {
      expect((await fetch(`${base}${bad}`)).status).toBe(404);
    }
    // И агент по-прежнему жив: следующий обычный запрос отвечает.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('ссылка входа указывает на раздаваемую страницу с адресом сервера', async () => {
    const { serve } = await serving();
    const link = serve.joinUrl('ws://127.0.0.1:8080');
    const url = new URL(link);
    expect(url.port).toBe(String(serve.port));
    // Адрес сервера — ПАРАМЕТР страницы агента (решение D10), а не отдельный
    // документ и не зашитая в бандл константа.
    expect(url.searchParams.get('server')).toBe('ws://127.0.0.1:8080');
  });

  it('публичный хост в ссылке входа не loopback: тестер на другой машине войдёт', async () => {
    const box = sandbox();
    boxes.push(box);
    const bundleDir = join(box.contentRoot, '..', 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'index.html'), '<!doctype html>');
    // Слушаем на всех интерфейсах, но НАЗЫВАЕМ себя конкретным хостом (SRV-8):
    // loopback-ссылка вела бы тестера на его же машину.
    const serve = await startHttpServe({
      port: 0,
      host: '0.0.0.0',
      advertiseHost: 'host.example',
      bundleDir,
      contentRoot: box.contentRoot,
    });
    serves.push(serve);
    expect(serve.host).toBe('host.example');
    const link = new URL(serve.joinUrl('ws://host.example:8080'));
    // И страница, и адрес сервера в параметре ведут на публичный хост.
    expect(link.hostname).toBe('host.example');
    expect(link.searchParams.get('server')).toBe('ws://host.example:8080');
  });
});

describe('словарь линий стенда (решение D2)', () => {
  it('управляющая линия маркирована, а строка лога — нет', () => {
    const line = encodeStandLine({
      t: 'ready',
      port: 8080,
      players: ['p1'],
      buildId: 'b',
      contentPackHash: 'h',
    });
    expect(line.startsWith(CONTROL_LINE_PREFIX)).toBe(true);
    expect(decodeStandLine(line.trim())).toMatchObject({ t: 'ready', port: 8080 });

    // Обычная строка лога управляющей не является — и это единственное, что их
    // различает: смешать их без маркировки нельзя (риск дизайна).
    expect(decodeStandLine('матч #1 тик 120 [running]')).toBeUndefined();
    // Битая управляющая линия тоже не отчёт: принять её значило бы показать
    // админу состояние, которого стенд не сообщал.
    expect(decodeStandLine(`${CONTROL_LINE_PREFIX}{не json`)).toBeUndefined();
    expect(decodeStandLine(`${CONTROL_LINE_PREFIX}{"t":"чужое"}`)).toBeUndefined();
  });

  it('команда разбирается, а незнакомая — нет', () => {
    const encoded = encodeStandCommand({ id: 3, cmd: 'bar-slot', slot: 1 });
    expect(decodeStandCommand(encoded.trim())).toEqual({ id: 3, cmd: 'bar-slot', slot: 1 });
    expect(decodeStandCommand('{"id":1,"cmd":"взорвать"}')).toBeUndefined();
    expect(decodeStandCommand('{"cmd":"pause"}')).toBeUndefined();
    expect(decodeStandCommand('не json')).toBeUndefined();
  });
});
