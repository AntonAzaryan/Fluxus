/**
 * Менеджер против ЖИВОГО агента (`server-manager` MGR-1..MGR-4).
 *
 * Живого, а не подставного, потому что MGR-1 — это утверждение о СПОСОБЕ:
 * «менеджер SHALL управлять серверами только через управляющий протокол
 * агента». Заглушка протокола проверяла бы, что менеджер разговаривает сам с
 * собой; здесь он разговаривает с настоящим агентом по настоящему wss.
 *
 * Сервером матча при этом служит подставной стенд (`fixtures/stand.mjs`):
 * предмет проверки — список, детали и админ-операции, а не бой. Настоящий бой
 * под агентом проверяется сквозным прогоном в пакете агента.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgent, type Agent } from '@fluxus/server-agent';
import { nodeSocket } from '@fluxus/server-agent/client/node';
import type { StartParams } from '@fluxus/server-agent/protocol';
import {
  createManagerSession,
  managerView,
  memoryStorage,
  walk,
  type ManagerSession,
  type UiNode,
} from '../src/index.js';

const STAND = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stand.mjs');

const agents: Agent[] = [];
const sessions: ManagerSession[] = [];
const trees: string[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const agent of agents.splice(0)) {
    await agent.registry.stopAll();
    await agent.close();
  }
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

async function liveAgent(matchDocs: readonly string[] = ['duel', 'training']): Promise<Agent> {
  const root = mkdtempSync(join(tmpdir(), 'fluxus-manager-'));
  trees.push(root);
  const contentRoot = join(root, 'content');
  mkdirSync(join(contentRoot, 'matches'), { recursive: true });
  for (const name of matchDocs) {
    writeFileSync(join(contentRoot, 'matches', `${name}.match.json`), `{"name":"${name}"}\n`);
  }
  const agent = await startAgent({
    controlPort: 0,
    httpPort: 0,
    host: '127.0.0.1',
    stateDir: join(root, 'state'),
    standScript: STAND,
    contentRoot,
    bundleDir: '',
    versions: { buildId: 'host-build', contentPackHash: 'host-hash', distribution: 'test' },
  });
  agents.push(agent);
  return agent;
}

function manager(): ManagerSession {
  const session = createManagerSession({ connect: nodeSocket, storage: memoryStorage(), label: 'тест' });
  sessions.push(session);
  return session;
}

const params = (match = 'matches/duel.match.json'): StartParams => ({
  match,
  port: 0,
  bot: '',
  botFillMs: null,
  onDisconnect: '',
  autoRestart: false,
});

/** Узлы представления с данным классом: тест смотрит на то же, что человек. */
function nodesOf(view: UiNode, cls: string): UiNode[] {
  return walk(view).filter((item) => (item.cls ?? '').split(' ').includes(cls));
}

async function until(condition: () => boolean, deadlineMs = 8000): Promise<boolean> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return condition();
}

describe('менеджер — клиент агентов (MGR-1)', () => {
  it('добавленный хост неотличим от локального в операциях', async () => {
    const agent = await liveAgent();
    const session = manager();
    const code = agent.tokens.issueCode(Date.now());
    // Локальный хост добавляется адресом и кодом от объявленного сервиса
    // (MGR-5), удалённый — адресом и кодом пейринга (MGR-1). Дальше разницы нет.
    await session.addLocal(agent.controlUrl, code, agent.certificate.fingerprint);

    const remoteCode = agent.tokens.issueCode(Date.now());
    const remote = manager();
    await remote.addRemote(agent.controlUrl, remoteCode, 'VPS');

    expect(session.state.hosts[0]?.connected).toBe(true);
    expect(remote.state.hosts[0]?.connected).toBe(true);
    // Версии дистрибутива видны до запуска серверов (SRV-7).
    expect(session.state.hosts[0]?.buildId).toBe('host-build');

    // Одна и та же операция над одним и тем же агентом с двух сторон.
    await session.start(session.state.hosts[0]!.id, params());
    await remote.refresh();
    expect(remote.state.servers).toHaveLength(1);
    expect(session.state.servers).toHaveLength(1);
  });

  it('удалённый хост запоминается книгой: следующий запуск подключается без кода', async () => {
    const agent = await liveAgent();
    const storage = memoryStorage();
    const first = createManagerSession({ connect: nodeSocket, storage });
    sessions.push(first);
    await first.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS');
    expect(first.state.hosts[0]?.connected).toBe(true);
    first.close();

    // Новая сессия на том же хранилище — то же, что новый запуск менеджера.
    const next = createManagerSession({ connect: nodeSocket, storage });
    sessions.push(next);
    await next.restore();
    expect(next.state.hosts[0]?.connected).toBe(true);
    expect(next.state.hosts[0]?.label).toBe('VPS');
  });
});

describe('список серверов и запуск (MGR-2)', () => {
  it('запуск, ссылка входа и названная причина отказа', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;

    // Перечень документов матча — от агента (решение D11), а не из дерева.
    expect(session.state.matches).toContain('matches/duel.match.json');

    await session.start(host, params());
    expect(session.state.notice).toBe('');
    const row = session.state.servers[0]!;
    expect(row.entry.state).toBe('listening');

    const view = managerView(session.state);
    // Ссылка входа игрока доступна для каждого сервера (SRV-8, MGR-2).
    const join = nodesOf(view, 'mg-action').find((item) => item.action === 'copy-join');
    expect(join?.args?.[0]).toContain('?server=');

    // Занятый порт — причина, НАЗВАННАЯ агентом, а не «сервер не появился».
    await session.start(host, { ...params(), port: row.entry.port });
    expect(session.state.notice).toContain('port-busy');
    expect(nodesOf(managerView(session.state), 'mg-notice')[0]?.text).toContain('port-busy');
  });

  it('список документов принадлежит ЦЕЛЕВОМУ хосту, запуск целится в него (MGR-2, D11)', async () => {
    // Два хоста с РАЗНЫМ набором документов: один общий и по одному своему.
    const local = await liveAgent(['duel', 'onlyLocal']);
    const remote = await liveAgent(['duel', 'onlyRemote']);
    const session = manager();
    await session.addLocal(local.controlUrl, local.tokens.issueCode(Date.now()), '');
    await session.addRemote(remote.controlUrl, remote.tokens.issueCode(Date.now()), 'VPS');
    const localId = session.state.hosts.find((h) => h.local)!.id;
    const remoteId = session.state.hosts.find((h) => !h.local)!.id;

    // По умолчанию цель — локальный хост (MGR-5), и список — его документов.
    expect(session.state.launchHost).toBe(localId);
    expect(session.state.matches).toContain('matches/onlyLocal.match.json');
    expect(session.state.matches).not.toContain('matches/onlyRemote.match.json');
    // Форма показывает документы ЦЕЛЕВОГО хоста, а не общий список.
    const localOptions = nodesOf(managerView(session.state), 'mg-input')
      .find((n) => n.action === 'launch-match')!
      .children!.map((o) => o.value);
    expect(localOptions).toContain('matches/onlyLocal.match.json');
    expect(localOptions).not.toContain('matches/onlyRemote.match.json');

    // Переключаем цель на удалённый — список меняется на ЕГО документы.
    session.setLaunchHost(remoteId);
    expect(session.state.launchHost).toBe(remoteId);
    expect(session.state.matches).toContain('matches/onlyRemote.match.json');
    expect(session.state.matches).not.toContain('matches/onlyLocal.match.json');

    // Узел `<select>` хоста несёт ВЫБРАННОЕ значение и среди опций (правка
    // находки 3): перевод в DOM выставляет его ПОСЛЕ добавления опций, а данные
    // для этого — здесь. Без выбранной опции список хоста показал бы не ту цель.
    const hostSelect = walk(managerView(session.state)).find((n) => n.action === 'launch-host')!;
    expect(hostSelect.value).toBe(remoteId);
    expect(hostSelect.children?.map((o) => o.value)).toContain(remoteId);

    // И запуск целится именно в удалённый хост, а не в первый попавшийся.
    await session.start(remoteId, params('matches/onlyRemote.match.json'));
    expect(session.state.notice).toBe('');
    expect(remote.registry.list()).toHaveLength(1);
    expect(local.registry.list()).toEqual([]);
  });
});

describe('окно деталей сервера (MGR-3)', () => {
  it('игрока убирают и возвращают — он всё время виден в перечне', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params());
    const server = session.state.servers[0]!.entry.id;
    await session.select(host, server);
    // Ждём ОТЧЁТА стенда, а не просто перечня слотов: до первого отчёта агент
    // знает лишь ростер из линии `ready` и статусов не выдумывает.
    await until(() => session.state.details?.entry.slots[0]?.status === 'active');

    const before = managerView(session.state);
    expect(nodesOf(before, 'mg-slot')).toHaveLength(2);
    // Пинг и отклик живого соединения видны рядом со статусом (MGR-3).
    expect(nodesOf(before, 'mg-slot__rtt')[0]?.text).toContain('мс');
    expect(nodesOf(before, 'mg-slot__response')[0]?.text).toContain('45');

    // «Убрать» — это запирание слота (NTR-19).
    await session.admin(host, server, 'bar-slot', 0);
    await until(() => session.state.details?.entry.slots[0]?.status === 'removed');
    const barred = managerView(session.state);
    // Игрок ОСТАЛСЯ в перечне, со статусом `removed`, а не пропал.
    expect(nodesOf(barred, 'mg-slot')).toHaveLength(2);
    expect(nodesOf(barred, 'mg-slot__status')[0]?.text).toBe('убран');
    const back = nodesOf(barred, 'mg-action').find((item) => item.action === 'unbar-slot');
    expect(back?.text).toBe('вернуть');

    await session.admin(host, server, 'unbar-slot', 0);
    await until(() => session.state.details?.entry.slots[0]?.status === 'active');
    expect(nodesOf(managerView(session.state), 'mg-slot__status')[0]?.text).toBe('в бою');
  });

  it('пауза матча видна в деталях, а метрики приходят по подписке', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params());
    const server = session.state.servers[0]!.entry.id;
    await session.select(host, server);

    await session.admin(host, server, 'pause');
    await until(() => session.state.details?.entry.pause === 'frozen');
    const frozen = managerView(session.state);
    expect(nodesOf(frozen, 'mg-details__state')[0]?.text).toContain('пауза: frozen');
    // Кнопка деталей называет ДЕЙСТВИЕ, а не состояние: замороженный матч
    // возобновляют.
    expect(walk(frozen).find((item) => item.action === 'resume')?.text).toBe('возобновить');

    // Метрики собираются только по подписке (решение D9) — и она уже сделана
    // выбором сервера.
    await until(() => session.state.details?.metrics !== null);
    expect(nodesOf(managerView(session.state), 'mg-metrics')[0]?.text).toContain('тик p99');

    await session.admin(host, server, 'resume');
    await until(() => session.state.details?.entry.pause === 'running');
    expect(walk(managerView(session.state)).find((item) => item.action === 'pause')?.text).toBe('пауза');

    // Отказ сервера матча показывается названным (SRV-5).
    await session.admin(host, server, 'resume');
    expect(session.state.notice).toContain('refused-by-server');
  });
});

describe('политика завершения менеджера (MGR-4)', () => {
  it('с включённым тумблером закрытие останавливает серверы локального агента', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params());
    expect(agent.registry.list()).toHaveLength(1);

    // Умолчание переключателя — ВКЛЮЧЁН (MGR-4).
    expect(session.state.killOnExit).toBe(true);
    await session.closing();
    expect(agent.registry.list()).toEqual([]);
  });

  it('с выключенным — серверы переживают закрытие, и следующий запуск их находит', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params());

    session.setKillOnExit(false);
    expect(managerView(session.state).children?.[0]?.children?.[1]?.text).toContain('нет');
    await session.closing();
    // Матчи не прерывались: реестр агента показывает их как прежде.
    expect(agent.registry.list()).toHaveLength(1);
    session.close();

    const next = manager();
    await next.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    // Следующий запуск менеджера НАХОДИТ их в реестре и показывает без
    // перезапуска.
    expect(next.state.servers).toHaveLength(1);
    expect(next.state.servers[0]?.entry.state).toBe('listening');
  });

  it('на серверы удалённых хостов закрытие локального менеджера не влияет', async () => {
    const local = await liveAgent();
    const remote = await liveAgent();
    const session = manager();
    await session.addLocal(local.controlUrl, local.tokens.issueCode(Date.now()), '');
    await session.addRemote(remote.controlUrl, remote.tokens.issueCode(Date.now()), 'VPS');
    const [localHost, remoteHost] = session.state.hosts;
    await session.start(localHost!.id, params());
    await session.start(remoteHost!.id, params());

    await session.closing();
    // Локальные остановлены, удалённые — нет, и это не зависит от тумблера.
    expect(local.registry.list()).toEqual([]);
    expect(remote.registry.list()).toHaveLength(1);
  });
});
