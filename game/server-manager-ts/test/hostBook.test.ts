/**
 * Книга хостов и локальный агент (`server-manager` MGR-1, MGR-5; решения D6, D11).
 *
 * Предмет: адрес и материал автопейринга локального агента приходят ЧЕРЕЗ
 * объявленный сервис, а не зашиты в приложение, а удалённый хост запоминается
 * книгой вместе с токеном и закреплённым отпечатком.
 */
import { describe, expect, it } from 'vitest';
import { BRIDGE_API, BRIDGE_VERSION } from '@fluxus/desktop-shell/bridge';
import {
  hostBook,
  hostIdOf,
  memoryStorage,
  pageStorage,
  parseLocalAgentAddress,
  startLocalAgent,
  AGENT_SERVICE,
  HOST_BOOK_KEY,
  type ManagerBridge,
} from '../src/index.js';

describe('книга хостов в хранилище страницы (MGR-1, решение D11)', () => {
  it('хост запоминается адресом, токеном и отпечатком и переживает перезапуск', () => {
    const storage = memoryStorage();
    const book = hostBook(storage);
    book.remember({
      id: hostIdOf('wss://10.0.0.5:8443'),
      label: 'VPS',
      url: 'wss://10.0.0.5:8443',
      token: 'секрет',
      fingerprint: 'abc',
    });
    // Новая книга на том же хранилище — то же, что новый запуск страницы.
    const reopened = hostBook(storage);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get('wss://10.0.0.5:8443')).toMatchObject({ token: 'секрет', fingerprint: 'abc' });

    reopened.forget('wss://10.0.0.5:8443');
    expect(hostBook(storage).list()).toEqual([]);
  });

  it('ключ хоста — origin адреса: путь и параметры хоста не различают', () => {
    expect(hostIdOf('wss://10.0.0.5:8443/?code=1')).toBe('wss://10.0.0.5:8443');
    expect(hostIdOf('не адрес')).toBe('не адрес');
  });

  it('испорченная книга не роняет приложение и не «чинится» молча', () => {
    const storage = memoryStorage();
    storage.setItem(HOST_BOOK_KEY, '{не json');
    expect(hostBook(storage).list()).toEqual([]);
  });

  it('страница без хранилища работает так же — без памяти о хостах', () => {
    const storage = pageStorage({
      get localStorage(): never {
        // Так ведёт себя приватное окно и запрещённые данные сайта.
        throw new Error('доступ запрещён');
      },
    });
    const book = hostBook(storage);
    book.remember({ id: 'x', label: 'x', url: 'wss://x', token: '', fingerprint: '' });
    expect(book.list()).toHaveLength(1);
  });
});

/**
 * Мост профиля менеджера: оконная интеграция и один объявленный сервис (DSK-5).
 * Форма — контракт контейнера, а не выдумка теста: страница видит именно её.
 */
function bridgeWith(
  services: readonly string[],
  startService?: (id: string) => Promise<{ id: string; running: boolean; address: string }>,
): ManagerBridge {
  return {
    api: BRIDGE_API,
    version: BRIDGE_VERSION,
    session: { profile: 'server-manager', capabilities: ['window', 'service'], roots: [], services },
    ...(startService === undefined ? {} : { startService }),
  };
}

describe('локальный агент через объявленный сервис (MGR-5, решение D6)', () => {
  it('адрес и код автопейринга приезжают строкой сервиса, а не зашиты в приложение', async () => {
    const asked: string[] = [];
    const bridge = bridgeWith([AGENT_SERVICE], (id) => {
      asked.push(id);
      // Строку пишет САМ агент; контейнер её не строит и не разбирает (DSK-7).
      return Promise.resolve({
        id,
        running: true,
        address: 'wss://127.0.0.1:41234/?code=004242&fingerprint=deadbeef',
      });
    });

    const local = await startLocalAgent(bridge);
    // Страница назвала контейнеру ровно одно — идентификатор объявленного сервиса.
    expect(asked).toEqual([AGENT_SERVICE]);
    expect(local.url).toBe('wss://127.0.0.1:41234');
    expect(local.pairingCode).toBe('004242');
    expect(local.fingerprint).toBe('deadbeef');
  });

  it('профиль без сервиса агента — отказ, а не зашитый адрес', async () => {
    await expect(startLocalAgent(bridgeWith([]))).rejects.toThrow('не объявлял');
  });

  it('непонятый адрес — отказ: подключаться «куда-то по умолчанию» нельзя', async () => {
    expect(parseLocalAgentAddress('')).toBeUndefined();
    expect(parseLocalAgentAddress('мусор')).toBeUndefined();
    // Незашифрованный канал управляющим быть не может (SRV-3) — значит, это не
    // адрес нашего агента.
    expect(parseLocalAgentAddress('ws://127.0.0.1:8443')).toBeUndefined();
    const bridge = bridgeWith([AGENT_SERVICE], (id) =>
      Promise.resolve({ id, running: true, address: 'ws://127.0.0.1:8443' }),
    );
    await expect(startLocalAgent(bridge)).rejects.toThrow('не понимает');
  });
});
