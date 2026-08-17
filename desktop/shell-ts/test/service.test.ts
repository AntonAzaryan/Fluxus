/**
 * Механика объявленных сервисов (DSK-7) — то, чего общий сьют границы не видит:
 * подстановка адреса в аргументы, занятый адрес и владение процессом.
 *
 * Сьют проверяет ГРАНИЦУ и говорит только тем, что видит страница; здесь —
 * хост, у которого есть процессы и порты. Разделение то же, что у корней:
 * контракт в сьюте, файловая механика — в своих тестах.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeAppProfile } from '../src/bridge/profile.js';
import { createHostServices, endpointOf, serviceArgs } from '../src/host/service.js';
import { DEAD_SERVICE_SCRIPT, freePort, SERVICE_SCRIPT, squat } from './support.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function profileWith(port: number, script = SERVICE_SCRIPT): ReturnType<typeof normalizeAppProfile> {
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
          args: ['--port', '{port}', '--host', '{host}'],
          address: `tcp://127.0.0.1:${String(port)}`,
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
});
