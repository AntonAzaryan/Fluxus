/**
 * Управляющий протокол агента (SRV-2, SRV-4, SRV-5, SRV-7; решения D3, D9).
 *
 * Проверяется он через ту же клиентскую библиотеку, которой пользуется менеджер
 * (`client/`): второй клиент в тестах означал бы, что проверено одно, а
 * работает другое.
 *
 * Предмет: версия в рукопожатии и названный отказ при её несовпадении, операции
 * реестра, события подписки БЕЗ опроса, транзит админ-операций до стенда и
 * названные отказы. Сам матч здесь подставной (`fakeStand.mjs`) — предмет
 * проверки протокол, а не бой.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_PROTOCOL_VERSION } from '../src/protocol/messages.js';
import type { ServerEvent } from '../src/protocol/messages.js';
import {
  createControlClient,
  type ControlClient,
  type ControlSocket,
  type OpenedSocket,
} from '../src/client/index.js';
import { nodeSocket } from '../src/client/node.js';
import type { Agent } from '../src/agent.js';
import { fakeAgent, sandbox, startParams, until, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const agents: Agent[] = [];
const clients: ControlClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const agent of agents.splice(0)) {
    await agent.registry.stopAll();
    await agent.close();
  }
  for (const box of boxes.splice(0)) box.drop();
});

/** Агент с уже выданным токеном: пейринг проверяется отдельно (`security.test.ts`). */
async function paired(): Promise<{ agent: Agent; client: ControlClient }> {
  const box = sandbox();
  boxes.push(box);
  const agent = await fakeAgent(box);
  agents.push(agent);
  const code = agent.tokens.issueCode(Date.now());
  const client = createControlClient(nodeSocket);
  clients.push(client);
  await client.connect({ url: agent.controlUrl, pairingCode: code, label: 'тест' });
  return { agent, client };
}

describe('рукопожатие с версией протокола (SRV-2)', () => {
  it('несовпадение версий — названный отказ с версиями обеих сторон', async () => {
    const box = sandbox();
    boxes.push(box);
    const agent = await fakeAgent(box);
    agents.push(agent);
    const code = agent.tokens.issueCode(Date.now());

    // Клиент «старой версии»: сообщение собирается руками, потому что
    // библиотека своей версией не врёт — и это правильно.
    const stale = createControlClient(async (url, pinned) => {
      const opened = await nodeSocket(url, pinned);
      return {
        ...opened,
        socket: {
          ...opened.socket,
          send: (text: string) => {
            const parsed: unknown = JSON.parse(text);
            const message = parsed as { t?: string };
            opened.socket.send(
              message.t === 'hello'
                ? JSON.stringify({ ...message, protocol: CONTROL_PROTOCOL_VERSION - 1 })
                : text,
            );
          },
        },
      };
    });
    clients.push(stale);

    await expect(stale.connect({ url: agent.controlUrl, pairingCode: code })).rejects.toMatchObject({
      reason: 'protocol-version',
    });
    // И операции недоступны: канал закрыт отказом, а не «почти работает».
    await expect(stale.list()).rejects.toMatchObject({ reason: 'closed' });
  });

  it('пир, закрывший канал до ответа на рукопожатие, — названный отказ, а не зависание (SRV-2)', async () => {
    // Мёртвый пир или чужой WebSocket: канал открылся, но на `hello` не ответил
    // и закрылся. `connect()` ОБЯЗАН завершиться названным исходом, а не висеть
    // до дедлайна — иначе менеджер замер бы на добавлении хоста без объяснения.
    let closed: ((reason: string) => void) | undefined;
    const mute: ControlSocket = {
      send: () => {
        // На `hello` пир не отвечает — рвёт канал: `onClose` разрешает
        // рукопожатие названным исходом (правка находки 4).
        setTimeout(() => closed?.(''), 0);
      },
      close: () => {},
      onMessage: () => {},
      onClose: (handler) => { closed = handler; },
    };
    const deaf = createControlClient(
      (): Promise<OpenedSocket> => Promise.resolve({ socket: mute, fingerprint: '' }),
    );
    clients.push(deaf);
    await expect(deaf.connect({ url: 'wss://пир.нет' })).rejects.toMatchObject({ reason: 'malformed' });
    // И это ОТКАЗ, а не полуоткрытое состояние: подключения нет.
    expect(deaf.connected).toBe(false);
  });

  it('версии протокола и дистрибутива видны в рукопожатии (SRV-7)', async () => {
    const { client, agent } = await paired();
    const again = createControlClient(nodeSocket);
    clients.push(again);
    const code = agent.tokens.issueCode(Date.now());
    const welcome = await again.connect({ url: agent.controlUrl, pairingCode: code });
    expect(welcome.versions).toEqual({
      buildId: 'test-build',
      contentPackHash: 'test-hash',
      distribution: 'test',
    });
    expect(welcome.fingerprint).toBe(agent.certificate.fingerprint);
    expect(client.connected).toBe(true);
  });
});

describe('операции реестра и подписка (SRV-2)', () => {
  it('перечень серверов, запуск с параметрами и остановка', async () => {
    const { client } = await paired();
    expect((await client.list()).servers).toEqual([]);

    const started = await client.start(startParams());
    const entry = started.servers[0]!;
    expect(entry.state).toBe('listening');
    expect(entry.match).toBe('matches/duel.match.json');
    expect(entry.address).toContain('ws://127.0.0.1:');
    // Ссылка входа игрока (SRV-8) — часть записи реестра, а не отдельный вопрос.
    expect(entry.joinUrl).toContain('?server=');

    expect((await client.list()).servers).toHaveLength(1);
    await client.stop(entry.id);
    expect((await client.list()).servers).toEqual([]);
  });

  it('перечень документов матча приезжает от агента, а не из дерева контента клиента', async () => {
    const { client } = await paired();
    const matches = (await client.matches()).matches;
    expect(matches).toContain('matches/duel.match.json');
    expect(matches).toContain('matches/training.match.json');
  });

  it('смена статуса игрока доходит подписчику БЕЗ опроса реестра', async () => {
    const { client } = await paired();
    const started = await client.start(startParams());
    const id = started.servers[0]!.id;
    const seen: ServerEvent[] = [];
    client.onEvent((event) => seen.push(event));
    await client.subscribe(id);

    // Запирание слота (NTR-19) через управляющий канал: статус игрока обязан
    // приехать СОБЫТИЕМ — реестр никто не опрашивает.
    await client.admin(id, 'bar-slot', 0);
    await until(() =>
      seen.some((event) => event.server.slots.some((slot) => slot.status === 'removed')),
    );
    const removed = seen
      .flatMap((event) => event.server.slots)
      .find((slot) => slot.status === 'removed');
    expect(removed?.slot).toBe(0);
    // Игрок ОСТАЛСЯ в перечне слотов, а не исчез из него (SRV-5).
    const last = seen[seen.length - 1]!;
    expect(last.server.slots).toHaveLength(2);

    // Снятие возвращает его в строй тем же путём.
    await client.admin(id, 'unbar-slot', 0);
    await until(() => {
      const latest = seen[seen.length - 1];
      return latest?.server.slots.every((slot) => slot.status !== 'removed') === true;
    });
    expect(seen[seen.length - 1]!.server.slots.some((slot) => slot.status === 'removed')).toBe(false);
  });

  it('метрики приезжают только подписчику деталей (решение D9)', async () => {
    const { client } = await paired();
    const started = await client.start(startParams());
    const id = started.servers[0]!.id;
    const seen: ServerEvent[] = [];
    client.onEvent((event) => seen.push(event));

    // Без подписки отчёт метрик не собирается вовсе — и в событии их нет.
    await client.admin(id, 'pause', -1);
    await until(() => seen.length > 0);
    expect(seen[seen.length - 1]!.metrics).toBeNull();

    await client.subscribe(id);
    await until(() => seen.some((event) => event.metrics !== null));
    const detailed = seen.reverse().find((event) => event.metrics !== null);
    expect(detailed?.metrics?.tickP99Ms).toBeGreaterThan(0);
    expect(detailed?.metrics?.rssBytes).toBeGreaterThan(0);
  });

  it('пауза и возобновление матча идут тем же каналом (SRV-5, NTR-20)', async () => {
    const { client } = await paired();
    const started = await client.start(startParams());
    const id = started.servers[0]!.id;
    // Состояние паузы наблюдается СОБЫТИЕМ (SRV-2): отчёт стенда доезжает своим
    // темпом, и ждать его опросом реестра значило бы проверять расписание.
    const seen: ServerEvent[] = [];
    client.onEvent((event) => seen.push(event));

    await client.admin(id, 'pause', -1);
    await until(() => seen.some((event) => event.server.pause === 'frozen'));
    expect((await client.list()).servers[0]?.pause).toBe('frozen');

    await client.admin(id, 'resume', -1);
    await until(() => seen[seen.length - 1]?.server.pause === 'running');
    expect((await client.list()).servers[0]?.pause).toBe('running');

    // Отказ сервера матча передаётся НАЗВАННЫМ, а не молчанием (SRV-5).
    await expect(client.admin(id, 'resume', -1)).rejects.toMatchObject({
      reason: 'refused-by-server',
    });
  });
});

describe('названные отказы операций (SRV-2)', () => {
  it('незнакомый сервер, слот вне ростера и занятый порт названы по причине', async () => {
    const { client, agent } = await paired();
    await expect(client.stop('srv-нет')).rejects.toMatchObject({ reason: 'unknown-server' });

    const started = await client.start(startParams());
    const id = started.servers[0]!.id;
    await expect(client.admin(id, 'bar-slot', 9)).rejects.toMatchObject({ reason: 'unknown-slot' });

    // Явно заданный занятый порт — названный отказ, а не молчаливое
    // переназначение (MGR-2, риск дизайна).
    const busy = started.servers[0]!.port;
    await expect(client.start(startParams({ port: busy }))).rejects.toMatchObject({
      reason: 'port-busy',
    });

    // Документа матча нет в дистрибутиве — тоже названная причина.
    await expect(client.start(startParams({ match: 'matches/нет.match.json' }))).rejects.toMatchObject({
      reason: 'unknown-match',
    });
    expect(agent.registry.list()).toHaveLength(1);
  });

  it('документ матча вне дерева контента — отказ, а не выход за корень (SRV-2, D11)', async () => {
    const { client, agent } = await paired();
    // Параметр запуска — документ из перечня агента (`matches()`), а не
    // произвольный путь: `../../../etc/hosts` увёл бы `spawn` за корень.
    for (const escape of ['../../../etc/hosts', 'matches/../../secret', '/etc/hosts']) {
      await expect(client.start(startParams({ match: escape }))).rejects.toMatchObject({
        reason: 'unknown-match',
      });
    }
    // Профиль бота — тем же предикатом.
    await expect(
      client.start(startParams({ bot: '../../../etc/passwd' })),
    ).rejects.toMatchObject({ reason: 'unknown-match' });
    expect(agent.registry.list()).toEqual([]);
  });
});

describe('подписка: доставка и освобождение (SRV-2, решение D9)', () => {
  it('два подписчика на один сервер — оба получают строки лога (SRV-2)', async () => {
    const box = sandbox();
    boxes.push(box);
    const agent = await fakeAgent(box);
    agents.push(agent);
    const two = [0, 1].map(() => {
      const client = createControlClient(nodeSocket);
      clients.push(client);
      return client;
    });
    for (const client of two) {
      await client.connect({ url: agent.controlUrl, pairingCode: agent.tokens.issueCode(Date.now()) });
    }
    const started = await two[0]!.start(startParams());
    const id = started.servers[0]!.id;

    const logs: string[][] = [[], []];
    two.forEach((client, index) => {
      client.onEvent((event) => { if (event.log.length > 0) logs[index]!.push(...event.log); });
    });
    for (const client of two) await client.subscribe(id);

    // `takeLog` разрушающий: слей его на каждого подписчика по отдельности, и
    // второй получил бы пустоту. Оба обязаны увидеть одни и те же строки.
    await until(() => logs[0]!.length > 0 && logs[1]!.length > 0, 12_000);
    expect(logs[0]!.length).toBeGreaterThan(0);
    expect(logs[1]!.length).toBeGreaterThan(0);
  });

  it('закрытие последнего подписчика гасит сбор метрик в процессе (решение D9)', async () => {
    const { client, agent } = await paired();
    const started = await client.start(startParams());
    const id = started.servers[0]!.id;
    const seen: ServerEvent[] = [];
    client.onEvent((event) => seen.push(event));
    await client.subscribe(id);
    // Подписка включила сбор: метрики появляются.
    await until(() => seen.some((event) => event.metrics !== null), 12_000);

    // Закрытие соединения БЕЗ явной отписки: упавший менеджер оставил бы стенд
    // подписанным навсегда, если бы `close` не снимал подписки.
    client.close();
    // Сбор гасится → следующий отчёт стенда снова без метрик. Наблюдаем это
    // новым подписчиком: старый ушёл.
    const watcher = createControlClient(nodeSocket);
    clients.push(watcher);
    await watcher.connect({ url: agent.controlUrl, pairingCode: agent.tokens.issueCode(Date.now()) });
    const after: ServerEvent[] = [];
    watcher.onEvent((event) => after.push(event));
    await watcher.subscribe(id);
    await watcher.unsubscribe(id);
    // После снятия обеих подписок ни один отчёт метрик не собирается.
    const mark = after.length;
    await until(() => after.length > mark, 5_000);
    expect(after.slice(mark).every((event) => event.metrics === null)).toBe(true);
  });
});
