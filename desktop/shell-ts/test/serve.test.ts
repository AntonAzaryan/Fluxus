/**
 * Раздача (DSK-4): разбор адреса запроса, порядок слоёв, тип содержимого.
 *
 * Контрактный сьют проверяет, что ассет доезжает до приложения; здесь — правила,
 * по которым он доезжает, включая те, что видны только на краях: закодированный
 * путь, запрос с query, каталог без документа входа.
 */
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHostRoot } from '../src/host/root.js';
import { createStaticServer, mimeOf, requestPath } from '../src/host/serve.js';
import { dropTree, makeTree, text } from './support.js';

describe('адрес запроса', () => {
  it('декодируется, теряет query и нормализуется', () => {
    expect(requestPath('/visuals/models/hero.mdx')).toBe('visuals/models/hero.mdx');
    expect(requestPath('/visuals/%D0%B3%D0%B5%D1%80%D0%BE%D0%B9.png')).toBe('visuals/герой.png');
    expect(requestPath('/index.html?v=2')).toBe('index.html');
    expect(requestPath('/')).toBe('');
  });

  it('выход за корни — не адрес вовсе', () => {
    expect(requestPath('/../secret')).toBeNull();
    expect(requestPath('/%E0%A4%A')).toBeNull();
  });
});

describe('тип содержимого', () => {
  it('известные расширения — свои типы, прочее — байты', () => {
    expect(mimeOf('index.html')).toContain('text/html');
    expect(mimeOf('assets/app.js')).toContain('text/javascript');
    expect(mimeOf('scenes/duel.scene.json')).toContain('application/json');
    expect(mimeOf('visuals/models/hero.glb')).toBe('model/gltf-binary');
    expect(mimeOf('visuals/models/hero.mdx')).toBe('application/octet-stream');
  });
});

describe('слои раздачи', () => {
  it('порядок слоёв решает совпадение имён, а отсутствие — общий отказ', async () => {
    const workspace = await makeTree({
      'bundle/index.html': 'бандл',
      'bundle/assets/app.js': 'app',
      'content/index.html': 'дерево',
      'content/visuals/manifest.json': '{"visuals":{}}',
    });
    const bundle = createHostRoot({ id: 'bundle', directory: `${workspace}/bundle`, serve: true });
    const content = createHostRoot({ id: 'content', directory: `${workspace}/content`, serve: true });
    const server = createStaticServer({ layers: [bundle, content] });

    const first = await server.serve('/index.html');
    expect(first.ok && text(first.bytes)).toBe('бандл');
    expect(first.ok && first.root).toBe('bundle');

    const asset = await server.serve('/visuals/manifest.json');
    expect(asset.ok && asset.root).toBe('content');

    const root = await server.serve('/');
    expect(root.ok && text(root.bytes)).toBe('бандл');

    const missing = await server.serve('/нет.png');
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.status).toBe(404);
    expect(!missing.ok && missing.reason).toContain('bundle, content');

    const outside = await server.serve('/../secret');
    expect(!outside.ok && outside.status).toBe(400);

    // Каталог без документа входа — не файл: раздача его не выдумывает.
    const directory = await server.serve('/visuals');
    expect(directory.ok).toBe(false);

    bundle.close();
    content.close();
    await dropTree(workspace);
  });

  it('ссылка из дерева наружу не раздаётся, а отвергается (DSK-5)', async () => {
    // Раздача — это слой, до которого страница дотягивается без всякого моста
    // (профиль игры моста не имеет вовсе), поэтому обход через ссылку внутри
    // дерева проверяется именно здесь: иначе пакет контента, привёзший ссылку,
    // сделал бы локальные файлы доступными обычным `fetch`.
    const workspace = await makeTree({
      'bundle/index.html': 'бандл',
      'content/visuals/manifest.json': '{"visuals":{}}',
      'secret.txt': 'СЕКРЕТ ВНЕ КОРНЯ',
    });
    await symlink(join(workspace, 'secret.txt'), join(workspace, 'content/secret-link.txt'));
    await symlink(workspace, join(workspace, 'content/outside'), 'dir');
    const bundle = createHostRoot({ id: 'bundle', directory: `${workspace}/bundle`, serve: true });
    const content = createHostRoot({ id: 'content', directory: `${workspace}/content`, serve: true });
    const server = createStaticServer({ layers: [bundle, content] });

    for (const path of ['/secret-link.txt', '/outside/secret.txt']) {
      const answer = await server.serve(path);
      expect(answer.ok, path).toBe(false);
      expect(!answer.ok && answer.status, path).toBe(400);
      expect(!answer.ok && answer.reason, path).toContain('DSK-5');
    }
    // А обычный ассет того же корня по-прежнему доезжает.
    const asset = await server.serve('/visuals/manifest.json');
    expect(asset.ok && text(asset.bytes)).toBe('{"visuals":{}}');

    bundle.close();
    content.close();
    await dropTree(workspace);
  });
});
