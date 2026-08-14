/**
 * Профили приложений репозитория (DSK-1, DSK-5) и согласованность
 * Electron-клея — то немногое о клее, что проверяется без Electron.
 *
 * Профили — данные, и именно поэтому они проверяются: контейнер один на оба
 * приложения, различаются они манифестом, и разъехавшийся манифест — это
 * выданная возможность или ненайденный бандл, а не опечатка в конфиге.
 *
 * Клей проверяется текстом, а не запуском: `npm run check` зелёный в окружении
 * без установленного контейнера (DSK-6). Текстом при этом ловится ровно то, что
 * дороже всего потерять молча, — расхождение имён каналов между главным
 * процессом и preload (повтор вынужден песочницей) и настройки окна, которыми
 * держится DSK-5.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppProfile } from '../src/host/app.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PACKAGE, '../..');

describe('профили приложений репозитория', () => {
  it('редактор: бандл веб-приложения, дерево content/ на запись, полный мост', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/editor.app.json'));
    expect(profile.id).toBe('editor');
    expect(profile.bundle).toBe(join(REPO, 'editor/ui-ts/app/dist-desktop'));
    expect(profile.roots).toHaveLength(1);
    expect(profile.roots[0]).toMatchObject({
      id: 'content',
      directory: join(REPO, 'content'),
      writable: true,
      serve: true,
    });
    expect([...profile.capabilities].sort()).toEqual(['dialog', 'read', 'watch', 'window', 'write']);
  });

  it('игра: тот же контейнер, бандл демо, дерево только на чтение и пустой мост', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    expect(profile.id).toBe('game');
    expect(profile.bundle).toBe(join(REPO, 'engine/client-ts/demo/dist-desktop'));
    // DSK-5: «профиль игрового клиента SHALL ограничиваться чтением — записи в
    // дерево контента у игры MUST NOT быть». Здесь сильнее: моста нет вовсе,
    // ассеты приезжают раздачей (DSK-4).
    expect(profile.capabilities).toEqual([]);
    expect(profile.roots[0]?.writable).toBe(false);
    expect(profile.roots[0]?.serve).toBe(true);
  });

  it('оба профиля указывают на одно дерево контента', async () => {
    const editor = await loadAppProfile(join(PACKAGE, 'apps/editor.app.json'));
    const game = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    // Дерево контента одно (CONT-1), и профили расходиться в нём не вправе:
    // разойдясь, они показали бы автору и игроку разный контент.
    expect(game.roots[0]?.directory).toBe(editor.roots[0]?.directory);
  });
});

describe('согласованность Electron-клея', () => {
  const readGlue = (name: string): Promise<string> => readFile(join(PACKAGE, 'src/electron', name), 'utf8');
  const channelsOf = (source: string): string[] =>
    [...source.matchAll(/'(fluxus:[a-z-]+)'/g)].map((match) => match[1]!).sort();

  it('имена каналов главного процесса и preload совпадают', async () => {
    // Повтор вынужден песочницей preload (`require` соседа там нет). Разъехаться
    // он не должен: разошедшийся канал — это молча неработающая возможность.
    const declared = channelsOf(await readGlue('channels.ts'));
    const used = channelsOf(await readGlue('preload.cjs'));
    expect(declared.length).toBeGreaterThan(0);
    expect(used).toEqual(declared);
  });

  it('окно создаётся с изоляцией контекста и без Node в странице (DSK-5)', async () => {
    const main = await readGlue('main.ts');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
  });

  it('preload собирает поверхность по объявленным возможностям, а не целиком', async () => {
    const preload = await readGlue('preload.cjs');
    for (const capability of ['read', 'write', 'watch', 'dialog', 'window']) {
      expect(preload).toContain(`granted('${capability}')`);
    }
    expect(preload).toContain('exposeInMainWorld');
  });
});
