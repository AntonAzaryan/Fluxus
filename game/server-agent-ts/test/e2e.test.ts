/**
 * Сквозной сценарий (задача 7.1 change'а `add-server-manager`): агент →
 * настоящий сервер матча → игрок и бот в слотах → дисконект с возвратом →
 * запирание → снятие → остановка.
 *
 * Здесь всё настоящее: агент по wss, запускалка стенда демо-арены дочерним
 * процессом, бот-заполнитель в слоте (BOT-7) и обычный `MatchClient` вторым
 * участником. Проверяется то, ради чего change заведён: админ видит СТАТУСЫ
 * (SRV-4) и меняет их админ-операциями (SRV-5), не подходя к процессу.
 *
 * Побитовая парность записи такого матча (NTR-8) проверяется НЕ здесь, а на
 * цельной вертикали (`engine/integration-ts/test/barredSlot.test.ts`): запись
 * матча стенд кладёт рядом только в отладочном прогоне (CLI-11), а перечень
 * параметров запуска у протокола закрыт (SRV-2) и отладочного флага в нём нет —
 * заводить его ради теста значило бы расширять протокол под тест.
 *
 * Дерево контента читается настоящее: агент и стенд — слой игры, и им это
 * законно (CONT-1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ClientHost, MatchClient, connectWebSocket, contentPack } from '@fluxus/net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent, type Agent } from '../src/agent.js';
import { createControlClient, type ControlClient } from '../src/client/index.js';
import { nodeSocket } from '../src/client/node.js';
import type { ServerEvent, SlotStatus } from '../src/protocol/messages.js';
import { REAL_STAND, REPO_CONTENT, sandbox, startParams, until, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const agents: Agent[] = [];
const clients: ControlClient[] = [];
const players: { close(): void }[] = [];

afterEach(async () => {
  for (const player of players.splice(0)) player.close();
  for (const client of clients.splice(0)) client.close();
  for (const agent of agents.splice(0)) {
    await agent.registry.stopAll();
    await agent.close();
  }
  for (const box of boxes.splice(0)) box.drop();
});

/** Сцена и версия матча — из ТОГО ЖЕ документа, которым агент поднимает сервер. */
function duel(): { scene: unknown; buildId: string; hash: string } {
  const document: unknown = JSON.parse(
    readFileSync(join(REPO_CONTENT, 'matches/duel.match.json'), 'utf8'),
  );
  const match = document as { buildId: string; contentPack: Record<string, string> };
  const scene: unknown = JSON.parse(
    readFileSync(join(REPO_CONTENT, 'matches', match.contentPack.duel ?? ''), 'utf8'),
  );
  return { scene, buildId: match.buildId, hash: contentPack({ duel: scene as never }).hash };
}

/** Обычный участник матча: тот же клиент, что у человека (NTR-12). */
async function joinAs(address: string, playerId: string): Promise<{ client: MatchClient; close(): void }> {
  const { scene, buildId, hash } = duel();
  const client = new MatchClient({
    playerId,
    version: { buildId, contentPackHash: hash },
    content: contentPack({ duel: scene as never }),
    physics: {},
    visibility: {},
  });
  const host = new ClientHost(client, await connectWebSocket(address), {
    now: () => Date.now(),
    // Ровный ввод: слот перестаёт быть молчащим, и статус его — «в бою».
    input: () => ({ move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 }),
  });
  host.start();
  const timer = setInterval(() => { host.step(); }, 16);
  timer.unref();
  const closer = {
    client,
    close: () => {
      clearInterval(timer);
      host.stop();
    },
  };
  players.push(closer);
  return closer;
}

/** Статус слота в последнем событии подписки. */
function statusOf(seen: readonly ServerEvent[], slot: number): SlotStatus | undefined {
  return seen[seen.length - 1]?.server.slots[slot]?.status;
}

/**
 * Наблюдался ли статус слота хоть раз. Смотреть только на последнее событие
 * здесь нельзя: политика стенда сажает в опустевший слот заместителя (BOT-14)
 * через пару секунд, и «разрыв» — состояние проходящее. Админ его видит, и тест
 * проверяет ровно это.
 */
function sawStatus(seen: readonly ServerEvent[], slot: number, status: SlotStatus): boolean {
  return seen.some((event) => event.server.slots[slot]?.status === status);
}

describe('сквозной сценарий: агент, бой, админ-операции (SRV-1..SRV-5)', () => {
  it('игрок и бот в слотах, дисконект с возвратом, запирание и снятие', async () => {
    const box = sandbox();
    boxes.push(box);
    const agent = await startAgent({
      controlPort: 0,
      httpPort: 0,
      host: '127.0.0.1',
      stateDir: box.stateDir,
      // Настоящая запускалка стенда демо-арены и настоящее дерево контента.
      standScript: REAL_STAND,
      contentRoot: REPO_CONTENT,
      bundleDir: '',
      versions: { buildId: 'e2e', contentPackHash: 'e2e', distribution: 'repo' },
    });
    agents.push(agent);

    const client = createControlClient(nodeSocket);
    clients.push(client);
    await client.connect({ url: agent.controlUrl, pairingCode: agent.tokens.issueCode(Date.now()) });

    // Запуск сервера: бот-заполнитель садится немедленно (BOT-7), а слот без
    // соединения в бою получает бота-заместителя (BOT-14).
    const started = await client.start(
      startParams({ match: 'matches/duel.match.json', botFillMs: 0, onDisconnect: 'bot' }),
    );
    const server = started.servers[0]!;
    expect(server.state).toBe('listening');

    const seen: ServerEvent[] = [];
    client.onEvent((event) => seen.push(event));
    await client.subscribe(server.id);

    // Человек занимает слот: он же — претендент, взводящий дедлайн заполнителя.
    const human = await joinAs(server.address, 'p1');
    await until(() => human.client.phase === 'playing', 20_000);
    expect(human.client.slot).toBe(0);

    // Оба слота заняты, матч идёт: статусы это и показывают (SRV-4).
    await until(() => statusOf(seen, 0) === 'active' && statusOf(seen, 1) === 'active', 30_000);
    expect(statusOf(seen, 1)).toBe('active');

    // Дисконект с возвратом (SRV-5): соединение рвётся, слот остаётся за
    // игроком, и он возвращается штатным реконнектом (NTR-17).
    await client.admin(server.id, 'disconnect-player', 0);
    await until(() => human.client.phase === 'closed', 10_000);
    expect(human.client.phase).toBe('closed');
    // Разрыв виден админу статусом слота; слот при этом остаётся за игроком
    // (NTR-6) — его временно ведёт заместитель по политике стенда (BOT-14).
    await until(() => sawStatus(seen, 0, 'disconnected'), 15_000);
    expect(sawStatus(seen, 0, 'disconnected')).toBe(true);

    // Возврат: тот же клиент входит заново и вытесняет заместителя (NTR-17,
    // NTR-18) — «слот остаётся за игроком, игрок переподключается».
    const back = await joinAs(server.address, 'p1');
    await until(() => back.client.phase === 'playing', 20_000);
    expect(back.client.slot).toBe(0);
    await until(() => statusOf(seen, 0) === 'active', 20_000);

    // Запирание (NTR-19): владельцу называется ЗАПРЕТ, слот числится `removed`
    // и из перечня не исчезает.
    await client.admin(server.id, 'bar-slot', 0);
    await until(() => back.client.phase === 'closed', 10_000);
    expect(back.client.closeDetail).toContain('slot-barred');
    await until(() => statusOf(seen, 0) === 'removed', 20_000);
    expect(seen[seen.length - 1]!.server.slots).toHaveLength(2);

    // Пока заперт — владелец не входит, и ему называется тот же исход.
    const refused = await joinAs(server.address, 'p1');
    await until(() => refused.client.phase === 'closed', 10_000);
    expect(refused.client.closeDetail).toContain('slot-barred');

    // Снятие: владелец возвращается штатным реконнектом.
    await client.admin(server.id, 'unbar-slot', 0);
    const returned = await joinAs(server.address, 'p1');
    await until(() => returned.client.phase === 'playing', 20_000);
    await until(() => statusOf(seen, 0) === 'active', 20_000);

    // Метрики подписки: круг соединения меряет ТРАНСПОРТ (NTR-11, решение D7) —
    // человек играет по настоящему ws, и «круга нет» у живого соединения было
    // бы дефектом. Первого круга ждём: ping идёт раз в секунду.
    await until(() => seen[seen.length - 1]?.server.slots[0]?.rtt.kind === 'measured', 15_000);
    const live = seen[seen.length - 1]!.server.slots[0]!;
    expect(live.rtt.kind).toBe('measured');
    expect(seen.some((event) => event.metrics !== null)).toBe(true);

    // Остановка сервера: реестр пуст, процесса нет.
    await client.stop(server.id);
    expect((await client.list()).servers).toEqual([]);
  }, 120_000);
});
