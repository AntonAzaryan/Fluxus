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
import { ControlClientError, type ControlSocketFactory } from '@fluxus/server-agent/client';
import { nodeSocket } from '@fluxus/server-agent/client/node';
import type { ServerEntry, StartParams } from '@fluxus/server-agent/protocol';
import {
  createManagerSession,
  managerView,
  memoryStorage,
  startParamsOf,
  walk,
  LAUNCH_FIELDS,
  type ManagerSession,
  type ManagerState,
  type PageStorage,
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

/**
 * Каталог агента: дерево контента и каталог состояния. Отдельно от самого
 * агента, потому что ВТОРОЙ агент на том же каталоге — это перезапуск агента
 * (решение D5), и его серверы он находит по книге процессов.
 */
function agentHome(matchDocs: readonly string[] = ['duel', 'training']): string {
  const root = mkdtempSync(join(tmpdir(), 'fluxus-manager-'));
  trees.push(root);
  const contentRoot = join(root, 'content');
  mkdirSync(join(contentRoot, 'matches'), { recursive: true });
  for (const name of matchDocs) {
    writeFileSync(join(contentRoot, 'matches', `${name}.match.json`), `{"name":"${name}"}\n`);
  }
  return root;
}

async function agentOn(root: string): Promise<Agent> {
  const agent = await startAgent({
    controlPort: 0,
    httpPort: 0,
    host: '127.0.0.1',
    stateDir: join(root, 'state'),
    standScript: STAND,
    contentRoot: join(root, 'content'),
    bundleDir: '',
    versions: { buildId: 'host-build', contentPackHash: 'host-hash', distribution: 'test' },
  });
  agents.push(agent);
  return agent;
}

function liveAgent(matchDocs: readonly string[] = ['duel', 'training']): Promise<Agent> {
  return agentOn(agentHome(matchDocs));
}

function manager(storage: PageStorage = memoryStorage()): ManagerSession {
  const session = createManagerSession({ connect: nodeSocket, storage, label: 'тест' });
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

/**
 * Добавление хоста — MGR-1 («удалённый добавляется адресом и пейрингом»), а
 * требование к его отказу приезжает из протокола, которым менеджер только и
 * управляет: SRV-2, «Отказ любой операции SHALL быть наблюдаем как отказ с
 * названной причиной». Отказ ЗАПУСКА сервера — требование соседнего блока ниже,
 * и проверяется он там, на занятом порте; сюда его клауза не относится.
 *
 * Живой агент этот случай не покрывает — у него всё получается, — а самый
 * частый исход добавления хоста ровно этот: канал не открылся. Поэтому здесь
 * канал подставной, и предмет проверки — что человек видит, пока попытка идёт, и
 * что он видит, когда она кончилась ничем.
 */
describe('отказ подключения к хосту наблюдаем (MGR-1, SRV-2)', () => {
  it('хост виден с первой секунды попытки, а её исход назван причиной', async () => {
    let refuse: (() => void) | undefined;
    // Канал, который сам собой не разрешается: так выглядит адрес, который не
    // отвечает и не отказывает.
    const hanging: ControlSocketFactory = () =>
      new Promise((_open, reject) => {
        refuse = () => {
          reject(new ControlClientError('connect-failed', 'самоподписанный сертификат не принят'));
        };
      });
    const session = createManagerSession({ connect: hanging, storage: memoryStorage() });
    sessions.push(session);

    // Подписка, а НЕ чтение `session.state` напрямую: состояние — живой геттер
    // над картой хостов, и запись в неё видна из него ещё до всякого
    // уведомления. Страница же перерисовывается ровно и только по `onChange`
    // (`app/main.ts`), поэтому проверять надо приход уведомления: без него
    // хост, уже лежащий в состоянии, на экране не появится до самого исхода
    // попытки — тот самый дефект, ради которого всё это и написано.
    const notified: boolean[] = [];
    session.onChange(() => notified.push(session.state.hosts[0]?.connecting ?? false));

    const attempt = session.addRemote('wss://127.0.0.1:8443', 'код', 'VPS');

    // Уведомление пришло СРАЗУ, и в нём хост назван подключающимся.
    expect(notified[0]).toBe(true);
    // Пока попытка идёт, хост УЖЕ в списке и назван подключающимся: иначе
    // человек смотрит на пустое место и не знает, случилось ли хоть что-то.
    expect(session.state.hosts[0]?.connecting).toBe(true);
    expect(nodesOf(managerView(session.state), 'mg-host__state')[0]?.text).toContain('подключается');

    refuse?.();
    await attempt;
    // И об исходе подписчик тоже узнал — вторым уведомлением, уже не «идёт».
    expect(notified.length).toBeGreaterThan(1);
    expect(notified[notified.length - 1]).toBe(false);
    expect(session.state.hosts[0]?.connecting).toBe(false);
    expect(session.state.hosts[0]?.connected).toBe(false);
    // Причина названа И в строке хоста, И общим сообщением: отказ операции
    // обязан быть наблюдаем как отказ с названной причиной (SRV-2).
    expect(nodesOf(managerView(session.state), 'mg-host__failure')[0]?.text).toContain(
      'самоподписанный сертификат не принят',
    );
    expect(nodesOf(managerView(session.state), 'mg-notice')[0]?.text).toContain('connect-failed');
  });

  it('УМЕРШИЙ канал тоже назван: хост перестаёт числиться живым', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS');
    expect(session.state.hosts[0]?.connected).toBe(true);

    // Агент ушёл (машина выключилась, сеть пропала, токен отозван — SRV-3).
    // Канал закрывается, и об этом обязано быть сказано: молчащий менеджер
    // показывал бы прошлое состояние как настоящее — живой хост и его серверы,
    // которых давно нет (MGR-2), — а узналось бы это отказом первой же кнопки.
    await agent.close();
    await until(() => session.state.hosts[0]?.connected === false, 5000);

    expect(session.state.hosts[0]?.connected).toBe(false);
    expect(session.state.hosts[0]?.failure).toContain('канал закрыт');
    expect(nodesOf(managerView(session.state), 'mg-host__failure')[0]?.text).toContain('канал закрыт');
  });

  it('серверы двух хостов не путаются одинаковыми идентификаторами (MGR-2, MGR-3)', async () => {
    // Реестр нумерует серверы У СЕБЯ (`srv-1`, `srv-2`…), поэтому у двух хостов
    // первые серверы называются одинаково. Опознавай менеджер сервер голым
    // идентификатором — и остановка на одном хосте закрывала бы детали чужого,
    // а подсветка выбранного зажигалась бы сразу в двух строках.
    const first = await liveAgent();
    const second = await liveAgent();
    const session = manager();
    await session.addLocal(first.controlUrl, first.tokens.issueCode(Date.now()), '');
    await session.addRemote(second.controlUrl, second.tokens.issueCode(Date.now()), 'VPS');
    const hostA = session.state.hosts[0]!.id;
    const hostB = session.state.hosts[1]!.id;

    await session.start(hostA, params());
    await session.start(hostB, params());
    const rows = session.state.servers;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entry.id).toBe(rows[1]!.entry.id);

    await session.select(hostB, rows[1]!.entry.id);
    expect(session.state.details?.host).toBe(hostB);
    // Подсвечена РОВНО одна строка — та, чей хост выбран.
    const selected = nodesOf(managerView(session.state), 'mg-server--selected');
    expect(selected).toHaveLength(1);

    // Остановка сервера ДРУГОГО хоста деталей не закрывает.
    await session.stop(hostA, rows[0]!.entry.id);
    expect(session.state.details?.host).toBe(hostB);
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

/**
 * Строка ОБЩЕГО списка (MGR-2) перечислена в требовании поимённо: «состояние
 * процесса, фаза матча, счётчик рестартов, занятость слотов, адрес». Проверяется
 * она на собранном состоянии, а не на живом агенте, ровно по той причине, по
 * которой представление вообще отделено от сессии: предмет здесь — ЧТО показано
 * при данной записи реестра, и живой агент, у которого счётчик кругов равен
 * нулю, этого утверждения не держит.
 */
describe('строка списка серверов (MGR-2)', () => {
  const entry = (over: Partial<ServerEntry> = {}): ServerEntry => ({
    id: 'srv-1',
    state: 'listening',
    address: 'ws://host:8080',
    port: 8080,
    match: 'matches/duel.match.json',
    phase: 'running',
    pause: 'running',
    restarts: 2,
    exitCode: null,
    postmortem: null,
    postmortemFailure: null,
    joinUrl: 'http://host:8088/?server=ws%3A%2F%2Fhost%3A8080',
    slots: [],
    ...over,
  });

  const stateWith = (record: ServerEntry): ManagerState => ({
    hosts: [],
    servers: [{ host: 'h', hostLabel: 'этот компьютер', entry: record }],
    details: undefined,
    launchHost: '',
    matches: [],
    killOnExit: true,
    notice: '',
  });

  it('несёт счётчик рестартов, а не прячет его в деталях', () => {
    const row = nodesOf(managerView(stateWith(entry())), 'mg-server__restarts')[0];
    // Круги матча видны В СПИСКЕ: сервер, отыгравший ночь подряд, отличается от
    // только что поднятого без единого клика.
    expect(row?.text).toBe('рестартов: 2');
  });

  it('перечисляет всё, что названо требованием: состояние, фазу, слоты, адрес', () => {
    const view = managerView(stateWith(entry()));
    expect(nodesOf(view, 'mg-server__state')[0]?.text).toBe('listening');
    expect(nodesOf(view, 'mg-server__phase')[0]?.text).toBe('running');
    expect(nodesOf(view, 'mg-server__slots')[0]?.text).toBe('0/0');
    expect(nodesOf(view, 'mg-server__address')[0]?.text).toBe('ws://host:8080');
  });
});

/**
 * «Менеджер SHALL позволять запустить сервер с параметрами запуска (SRV-2)», а
 * SRV-2 называет эти параметры поимённо: документ матча, порт, профиль бота,
 * дедлайн бот-заполнителя, политика разрыва, авто-рестарт. Параметр, вместо
 * которого форма подставляет константу, — это параметр, которого у админа нет.
 */
describe('форма запуска отдаёт все параметры запуска (MGR-2, SRV-2)', () => {
  it('в форме есть поле на каждый параметр SRV-2', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const fields = walk(managerView(session.state))
      .filter((item) => item.tag === 'input' || item.tag === 'select')
      .map((item) => item.action);
    for (const name of Object.values(LAUNCH_FIELDS)) expect(fields).toContain(name);
  });

  it('поля переводятся в параметры запуска, а пустые — в умолчания стенда', () => {
    // Пустая форма: документ — показанное умолчание, порт «авто», а остальное
    // решает стенд. Ноль вместо `null` у дедлайна означал бы «заполнить ботами
    // немедленно» — не то же самое, что «как решит стенд» (BOT-7).
    expect(startParamsOf(new Map(), 'matches/duel.match.json').params).toEqual({
      match: 'matches/duel.match.json',
      port: 0,
      bot: '',
      botFillMs: null,
      onDisconnect: '',
      autoRestart: true,
    });

    // Заполненная форма доезжает до параметров ЦЕЛИКОМ, включая выключенный
    // авто-рестарт: «отыграть один матч и остановиться» — решение админа.
    const filled = new Map([
      [LAUNCH_FIELDS.match, 'matches/training.match.json'],
      [LAUNCH_FIELDS.port, '8081'],
      [LAUNCH_FIELDS.bot, 'bots/normal.json'],
      [LAUNCH_FIELDS.botFill, '15000'],
      [LAUNCH_FIELDS.onDisconnect, 'pause'],
      [LAUNCH_FIELDS.autoRestart, 'no'],
    ]);
    expect(startParamsOf(filled, 'matches/duel.match.json').params).toEqual({
      match: 'matches/training.match.json',
      port: 8081,
      bot: 'bots/normal.json',
      botFillMs: 15_000,
      onDisconnect: 'pause',
      autoRestart: false,
    });
  });

  it('непонятое поле — названный отказ, а не подставленное умолчание (MGR-2, SRV-2)', async () => {
    // «Пусто» и «введено неверно» — разные вещи: свести вторую к первой значит
    // поднять сервер не там, где просил человек. Ровно это молчаливое
    // переназначение отвергает и агент — занятый порт он называет отказом, а не
    // переезжает на свободный.
    for (const bad of ['808l', '70000', '-1', '1e3']) {
      const form = startParamsOf(new Map([[LAUNCH_FIELDS.port, bad]]), 'matches/duel.match.json');
      expect(form.params).toBeUndefined();
      expect(form.failure).toContain(bad);
    }
    const deadline = startParamsOf(new Map([[LAUNCH_FIELDS.botFill, 'скоро']]), 'matches/duel.match.json');
    expect(deadline.params).toBeUndefined();
    expect(deadline.failure).toContain('дедлайн');

    // И причина доезжает до человека тем же путём, что отказы агента (SRV-2).
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    session.refuse(startParamsOf(new Map([[LAUNCH_FIELDS.port, '808l']]), '').failure);
    expect(nodesOf(managerView(session.state), 'mg-notice')[0]?.text).toContain('808l');
    // Сервер при этом не поднялся: отказ — это отказ, а не запуск с умолчанием.
    expect(agent.registry.list()).toEqual([]);
  });

  it('выключенный авто-рестарт доезжает до агента параметром запуска', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    const chosen = new Map([
      [LAUNCH_FIELDS.match, 'matches/duel.match.json'],
      [LAUNCH_FIELDS.autoRestart, 'no'],
      [LAUNCH_FIELDS.onDisconnect, 'hold'],
    ]);
    await session.start(host, startParamsOf(chosen, '').params!);
    expect(session.state.notice).toBe('');
    expect(agent.registry.list()).toHaveLength(1);

    // Запись реестра ни авто-рестарта, ни политики разрыва не несёт, поэтому
    // утверждение держится единственным доступным наблюдением — тем, ЧТО агент
    // передал стенду: `--once` (авто-рестарт выключен) и `--on-disconnect hold`.
    // Без него тест утверждал бы лишь «сервер поднялся».
    const server = session.state.servers[0]!.entry.id;
    await session.select(host, server);
    expect(
      await until(() => (session.state.details?.log.join(' ') ?? '').includes('аргументы:')),
    ).toBe(true);
    const log = session.state.details!.log.join(' ');
    expect(log).toContain('--once');
    expect(log).toContain('--on-disconnect hold');
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
    // Размер снапшотов и пропущенные по очереди — рядом (NTR-22): «канал узкий»
    // третьим ответом к пингу и длительности тика.
    expect(nodesOf(before, 'mg-slot__snapshots')[0]?.text).toContain('4.0 КиБ');
    expect(nodesOf(before, 'mg-slot__snapshots')[0]?.text).toContain('пропущено 3');

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

/**
 * Хост УБИРАЕТСЯ, и это операция книги, а не остановка серверов. MGR-1 говорит
 * про добавление («удалённый добавляется адресом и пейрингом»), а убирание — его
 * обратная сторона: то, что менеджер помнит, он обязан уметь забыть, иначе
 * пейринг был бы билетом в одну сторону.
 */
describe('забытый хост (MGR-1)', () => {
  it('уходит из списка и из книги, но его серверы продолжают работать', async () => {
    const storage = memoryStorage();
    const first = await liveAgent();
    const second = await liveAgent();
    const session = manager(storage);
    await session.addRemote(first.controlUrl, first.tokens.issueCode(Date.now()), 'VPS-1');
    await session.addRemote(second.controlUrl, second.tokens.issueCode(Date.now()), 'VPS-2');
    const [one, two] = session.state.hosts.map((host) => host.id);

    await session.start(two!, params());
    await session.select(two!, session.state.servers[0]!.entry.id);
    expect(session.state.details?.host).toBe(two);

    // Забыт ЧУЖОЙ хост: детали выбранного сервера к нему отношения не имеют, и
    // закрывать их незачем — сервер опознаётся парой «хост + идентификатор».
    await session.forget(one!);
    expect(session.state.hosts.map((host) => host.id)).toEqual([two]);
    expect(session.state.details?.host).toBe(two);

    await session.forget(two!);
    expect(session.state.hosts).toEqual([]);
    expect(session.state.servers).toEqual([]);
    expect(session.state.details).toBeUndefined();
    // Забыть хост — не то же, что остановить его серверы: матч идёт дальше, и
    // политика завершения (MGR-4) тут ни при чём.
    expect(second.registry.list()).toHaveLength(1);

    // И книга его больше не помнит: следующий запуск менеджера сам к нему не идёт.
    const next = manager(storage);
    await next.restore();
    expect(next.state.hosts).toEqual([]);
  });

  it('отписавшийся от смен состояния больше не уведомляется', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS');

    let seen = 0;
    const stop = session.onChange(() => { seen += 1; });
    session.setKillOnExit(false);
    expect(seen).toBe(1);

    // Отписка — не пожелание: страница, ушедшая со сцены, перерисовываться не
    // должна, иначе её узлы живут ровно столько, сколько живёт сессия.
    stop();
    await session.forget(session.state.hosts[0]!.id);
    expect(seen).toBe(1);
  });
});

/**
 * Отказ ЛЮБОЙ операции наблюдаем как отказ с названной причиной (`server-control`
 * SRV-2) — включая операции, до протокола не доехавшие. Канал вправе умереть
 * между отрисовкой кнопки и нажатием на неё, и человек в этот момент видит
 * прежний экран: кнопки на месте, хост в списке. Нажатие обязано ответить
 * причиной, а не отклонённым промисом, который в странице не ловит никто.
 */
describe('операция без канала — названный отказ (MGR-2, MGR-3, SRV-2)', () => {
  it('после смерти канала каждая кнопка называет причину', async () => {
    const agent = await liveAgent();
    const session = manager();
    await session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params());
    const server = session.state.servers[0]!.entry.id;

    await agent.close();
    await until(() => session.state.hosts[0]?.connected === false, 5000);

    for (const operation of [
      (): Promise<void> => session.start(host, params()),
      (): Promise<void> => session.stop(host, server),
      (): Promise<void> => session.select(host, server),
      (): Promise<void> => session.admin(host, server, 'pause'),
    ]) {
      await operation();
      expect(session.state.notice).toContain('не подключён');
    }

    // Строка сервера при этом ОСТАЁТСЯ: список показывает последнее известное
    // состояние вместе с названной причиной, а не пустеет молча (MGR-2).
    expect(session.state.servers).toHaveLength(1);
    expect(nodesOf(managerView(session.state), 'mg-notice')[0]?.text).toContain('не подключён');
  });

  it('операция над хостом, которого в списке нет, названа отдельно', async () => {
    const session = manager();
    // Не «не подключён», а «в списке нет»: адрес, которого менеджер не знает,
    // и хост, чей канал умер, чинятся по-разному.
    await session.start('wss://127.0.0.1:1', params());
    expect(session.state.notice).toContain('в списке нет');
  });

  it('обновление списка не срывается о мёртвый хост', async () => {
    const alive = await liveAgent();
    const dead = await liveAgent();
    const session = manager();
    await session.addRemote(alive.controlUrl, alive.tokens.issueCode(Date.now()), 'живой');
    await session.addRemote(dead.controlUrl, dead.tokens.issueCode(Date.now()), 'мёртвый');
    const [aliveId, deadId] = session.state.hosts.map((host) => host.id);
    await session.start(aliveId!, params());

    await dead.close();
    await until(() => session.state.hosts[1]?.connected === false, 5000);

    // Второй менеджер поднимает на живом хосте ещё один сервер: список первого
    // устарел, и `refresh` обязан его догнать, а не отказать из-за соседа.
    const other = manager();
    await other.addRemote(alive.controlUrl, alive.tokens.issueCode(Date.now()), 'VPS');
    await other.start(other.state.hosts[0]!.id, params());

    await session.refresh();
    expect(session.state.notice).toBe('');
    expect(session.state.servers.filter((row) => row.host === aliveId)).toHaveLength(2);
    expect(session.state.servers.filter((row) => row.host === deadId)).toEqual([]);
  });
});

describe('переключение деталей (MGR-3, решение D9)', () => {
  it('прежний сервер отписывается, а ушедший хост переключению не мешает', async () => {
    const first = await liveAgent();
    const second = await liveAgent();
    const session = manager();
    await session.addLocal(first.controlUrl, first.tokens.issueCode(Date.now()), '');
    await session.addRemote(second.controlUrl, second.tokens.issueCode(Date.now()), 'VPS');
    const [one, two] = session.state.hosts.map((host) => host.id);
    await session.start(one!, params());
    await session.start(two!, params());
    const rows = session.state.servers;

    await session.select(one!, rows[0]!.entry.id);
    // Переключение на чужой сервер: подписка на прежний снимается — без
    // читателя отчёт метрик не собирается (D9), и оставленная подписка держала
    // бы сбор на сервере, деталей которого никто не смотрит.
    await session.select(two!, rows[1]!.entry.id);
    expect(session.state.notice).toBe('');
    expect(session.state.details?.host).toBe(two);
    await until(() => session.state.details?.metrics !== null);

    // Хост деталей ушёл вместе со своим сервером: отписываться уже не от чего,
    // и переключение на другой хост это не срывает.
    await second.close();
    await until(() => session.state.hosts[1]?.connected === false, 5000);
    await session.select(one!, rows[0]!.entry.id);
    expect(session.state.notice).toBe('');
    expect(session.state.details?.host).toBe(one);
  });
});

describe('добавление хоста дважды (MGR-1)', () => {
  it('поздняя попытка вытесняет раннюю, и второго канала к агенту не остаётся', async () => {
    const agent = await liveAgent();
    const session = manager();
    // Человек нажал «добавить» дважды — либо `restore()` пошёл по книге, пока
    // добавление ещё идёт. Обе попытки настоящие: у каждой свой одноразовый код
    // пейринга (SRV-3), обе доходят до рукопожатия.
    await Promise.all([
      session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS'),
      session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS'),
    ]);

    // Хост ОДИН, и он рабочий: ранняя попытка ушла молча, не подменив исход
    // поздней своим и не оставив открытым второй канал к тому же агенту.
    expect(session.state.hosts).toHaveLength(1);
    expect(session.state.hosts[0]?.connected).toBe(true);
    await session.start(session.state.hosts[0]!.id, params());
    expect(session.state.notice).toBe('');
    expect(agent.registry.list()).toHaveLength(1);
  });

  it('хост подключён, даже если книга его не запомнила', async () => {
    const agent = await liveAgent();
    // Так ведёт себя хранилище с исчерпанной квотой: читается прекрасно, а
    // пишется отказом.
    const full: PageStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('квота исчерпана'); },
    };
    const session = manager(full);
    await session.addRemote(agent.controlUrl, agent.tokens.issueCode(Date.now()), 'VPS');

    // Канал открыт, хост работает — потеряна только память о нём, и сказано об
    // этом именно так, а не отказом подключения (MGR-1, SRV-2).
    expect(session.state.hosts[0]?.connected).toBe(true);
    expect(session.state.notice).toContain('не запомнен');
    await session.start(session.state.hosts[0]!.id, params());
    expect(agent.registry.list()).toHaveLength(1);
  });
});

/**
 * Ночной краш (SRV-6): «утром реестр показывает `crashed` с кодом выхода и путём
 * к сохранённым материалам; разбор начинается с чтения файлов». Значит, в
 * упавший сервер надо УМЕТЬ кликнуть: подписка на его детали невозможна —
 * собирать метрики негде, — но код выхода, каталог разбора и хвост лога обязаны
 * открыться (MGR-3).
 */
describe('детали упавшего сервера открываются (MGR-3, SRV-6)', () => {
  it('клик по `crashed` показывает код выхода, материалы разбора и хвост лога', async () => {
    const agent = await liveAgent(['duel', 'crash']);
    const session = manager();
    await session.addLocal(agent.controlUrl, agent.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;
    await session.start(host, params('matches/crash.match.json'));
    const server = session.state.servers[0]!.entry.id;

    // Смена состояния приезжает СОБЫТИЕМ, без опроса (SRV-2).
    expect(await until(() => session.state.servers[0]?.entry.state === 'crashed')).toBe(true);

    await session.select(host, server);
    // Отказа нет: подписка на мёртвый процесс невозможна, но детали открылись.
    expect(session.state.notice).toBe('');
    const details = session.state.details;
    expect(details?.entry.state).toBe('crashed');
    expect(details?.entry.exitCode).toBe(7);
    expect(details?.entry.postmortem).not.toBeNull();
    expect(details?.log.length).toBeGreaterThan(0);

    const view = managerView(session.state);
    const postmortem = nodesOf(view, 'mg-details__postmortem')[0]?.text ?? '';
    // Человек читает код выхода и путь к каталогу разбора прямо в окне: искать
    // его руками по диску — не то, чем начинается утро (SRV-6).
    expect(postmortem).toContain('код выхода: 7');
    expect(postmortem).toContain(details!.entry.postmortem!);
    expect(nodesOf(view, 'mg-log__line').length).toBeGreaterThan(0);
    // Причина неполноты деталей НАЗВАНА (SRV-2): подписки на процесс, которого
    // нет, не бывает, и человек видит, почему в окне нет счётчиков.
    expect(nodesOf(view, 'mg-details__limited')[0]?.text).toContain('not-running');
    // Счётчики у мёртвого процесса не собираются (D9) и подменяться нулями не
    // должны.
    expect(nodesOf(view, 'mg-metrics')[0]?.text).toBe('счётчики: —');
    // Админ-операции над ушедшим процессом недоступны кнопкой, а не отказом
    // после нажатия (SRV-5).
    expect(walk(view).find((item) => item.action === 'pause')?.disabled).toBe(true);
  });

  it('сервер, переживший прежнего агента: детали открыты, админ-операции — нет (MGR-3, SRV-5)', async () => {
    // Второй производитель отказа `not-running`: процесс ЖИВ и держит порт,
    // поэтому запись числится `listening`, — но stdio ушло вместе с прежним
    // агентом, и ни одна админ-операция до него не доходит. Судить о доступности
    // операций по одному состоянию процесса поэтому нельзя.
    const home = agentHome();
    const first = await agentOn(home);
    const before = manager();
    await before.addLocal(first.controlUrl, first.tokens.issueCode(Date.now()), '');
    await before.start(before.state.hosts[0]!.id, params());
    const server = before.state.servers[0]!.entry.id;
    before.close();
    // Агент уходит, сервер — нет: процессы серверов не его зависимость (D5).
    await first.close();

    const second = await agentOn(home);
    expect(second.survivors.map((entry) => entry.id)).toEqual([server]);
    const session = manager();
    await session.addLocal(second.controlUrl, second.tokens.issueCode(Date.now()), '');
    const host = session.state.hosts[0]!.id;

    await session.select(host, server);
    expect(session.state.notice).toBe('');
    expect(session.state.details?.entry.state).toBe('listening');

    const view = managerView(session.state);
    // Материалов разбора у него нет и быть не должно: процесс не выходил, и
    // строка «код выхода: —» сообщала бы о крахе, которого не случилось (SRV-6).
    expect(nodesOf(view, 'mg-details__postmortem')).toEqual([]);
    // А причина, по которой детали неполны, названа — и названа его словами.
    expect(nodesOf(view, 'mg-details__limited')[0]?.text).toContain('пережил прежнего агента');
    // Кнопка админ-операции над матчем недоступна: агент откажет ей ВСЕГДА, и
    // обещать её человеку значило бы обещать отказ (SRV-5). Ищется она внутри
    // ДЕТАЛЕЙ и по классу: фазы матча у пережившего сервера нет (отчёт от него
    // больше не приходит), поэтому называется она «возобновить», а не «пауза».
    const panel = nodesOf(view, 'mg-details')[0]!;
    expect(nodesOf(panel, 'mg-action--primary')[0]?.disabled).toBe(true);
    // Слотов у него нет вовсе: ростер приезжал линией `ready` прежнего процесса,
    // и выдумывать его агент не станет — перечень пуст, а не заполнен догадками.
    expect(nodesOf(panel, 'mg-slot')).toEqual([]);
  });
});
