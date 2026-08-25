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
import { createHostBridge } from '../src/host/bridge.js';
import type { BridgeServiceState } from '../src/bridge/types.js';

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

  it('игра: тот же контейнер, бандл демо, дерево только на чтение', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    expect(profile.id).toBe('game');
    expect(profile.bundle).toBe(join(REPO, 'game/demo-ts/app/dist-desktop'));
    // DSK-5: «профиль игрового клиента SHALL ограничиваться чтением — записи в
    // дерево контента у игры MUST NOT быть». Из дерева ей достаётся раздача
    // (DSK-4), а из моста — ровно одна возможность: поднять свой стенд матча.
    expect(profile.capabilities).toEqual(['service']);
    expect(profile.roots[0]?.writable).toBe(false);
    expect(profile.roots[0]?.serve).toBe(true);
  });

  it('игра: стенд матча объявлен сервисом, а не приезжает из страницы (DSK-7)', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    expect(profile.services).toHaveLength(1);
    expect(profile.services[0]).toMatchObject({
      id: 'match-stand',
      script: join(REPO, 'game/demo-ts/bin/demo-serve.mjs'),
      address: 'ws://127.0.0.1:8080',
    });
    // Порт в аргументах — подстановка из адреса: второй записи числа, с которой
    // адрес мог бы разойтись, в манифесте нет (design D1).
    expect(profile.services[0]?.args).toContain('{port}');
  });

  it('редактор сервисов не объявляет: возможности нет — поднимать нечего', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/editor.app.json'));
    expect(profile.services).toEqual([]);
    expect(profile.capabilities).not.toContain('service');
  });

  it('менеджер: оконная интеграция и отвязываемый агент, БЕЗ дерева контента (DSK-5, MGR-5)', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/server-manager.app.json'));
    expect(profile.id).toBe('server-manager');
    expect(profile.bundle).toBe(join(REPO, 'game/server-manager-ts/app/dist-desktop'));
    // «Ни чтения, ни записи дерева контента у него MUST NOT быть»: корней нет
    // вовсе, и возможностей чтения/записи профиль не объявляет. С контентом
    // менеджер работает только через управляющий протокол агента (решение D11).
    expect(profile.roots).toEqual([]);
    expect([...profile.capabilities].sort()).toEqual(['service', 'window']);
    expect(profile.capabilities).not.toContain('read');
    expect(profile.capabilities).not.toContain('write');
  });

  it('менеджер: агент объявлен ОТВЯЗЫВАЕМЫМ сервисом (DSK-7, MGR-5)', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/server-manager.app.json'));
    expect(profile.services).toHaveLength(1);
    expect(profile.services[0]).toMatchObject({
      id: 'agent',
      script: join(REPO, 'game/server-agent-ts/bin/agent.mjs'),
      detached: true,
    });
    // Адрес и материал автопейринга приезжают ЧЕРЕЗ сервис (MGR-5): путь
    // адресного файла подставляет контейнер, страница его не выбирает.
    expect(profile.services[0]?.args).toContain('{addressFile}');
    expect(profile.services[0]?.args).toContain('{port}');
    // Управляющий канал — на loopback (агент локальный), раздача — наружу
    // (SRV-8): иначе ссылка входа вела бы на машину тестера (MGR-2). Оба хоста
    // объявлены раздельно.
    const args = profile.services[0]!.args;
    expect(args[args.indexOf('--control-host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--host') + 1]).toBe('0.0.0.0');
    // И раздача клиента объявлена (`--bundle`), чтобы страница входа не была 404.
    expect(args).toContain('--bundle');
    // И он единственный отвязываемый: у игры стенд матча умирает с сессией.
    const game = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    expect(game.services[0]?.detached).toBe(false);
  });

  it('оба профиля указывают на одно дерево контента', async () => {
    const editor = await loadAppProfile(join(PACKAGE, 'apps/editor.app.json'));
    const game = await loadAppProfile(join(PACKAGE, 'apps/game.app.json'));
    // Дерево контента одно (CONT-1), и профили расходиться в нём не вправе:
    // разойдясь, они показали бы автору и игроку разный контент.
    expect(game.roots[0]?.directory).toBe(editor.roots[0]?.directory);
  });
});

describe('профиль менеджера как whitelist моста (DSK-5, MGR-5)', () => {
  /** Сервисы подставные: предмет проверки — форма моста, а не запуск процесса. */
  const stubServices = {
    start: (id: string): Promise<BridgeServiceState> =>
      Promise.resolve({ id, running: true, address: 'wss://127.0.0.1:1/?code=1' }),
    stop: (id: string): Promise<BridgeServiceState> =>
      Promise.resolve({ id, running: false, address: '' }),
    state: (id: string): Promise<BridgeServiceState> =>
      Promise.resolve({ id, running: false, address: '' }),
    owned: () => 0,
    closeAll: () => Promise.resolve(),
  };

  it('чтение и запись дерева контента из профиля менеджера — не отказ, а ОТСУТСТВИЕ канала', async () => {
    const profile = await loadAppProfile(join(PACKAGE, 'apps/server-manager.app.json'));
    const handle = createHostBridge({ profile, roots: [], services: stubServices });
    const bridge = handle.bridge;
    // Возможности, не объявленной профилем, не существует: не метод, отвечающий
    // отказом, а отсутствующее поле (DSK-5).
    expect(bridge.read).toBeUndefined();
    expect(bridge.write).toBeUndefined();
    expect(bridge.list).toBeUndefined();
    expect(bridge.stat).toBeUndefined();
    expect(bridge.watch).toBeUndefined();
    expect(bridge.choose).toBeUndefined();
    // А объявленное — есть: окно и сервис агента.
    expect(bridge.setTitle).toBeDefined();
    expect(bridge.startService).toBeDefined();
    expect(bridge.session.services).toEqual(['agent']);
    // Корней нет вовсе: раздавать и показывать нечего.
    expect(bridge.session.roots).toEqual([]);
    handle.close();
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
    for (const capability of ['read', 'write', 'watch', 'dialog', 'window', 'service']) {
      expect(preload).toContain(`granted('${capability}')`);
    }
    expect(preload).toContain('exposeInMainWorld');
  });
});
