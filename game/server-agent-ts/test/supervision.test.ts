/**
 * Супервизия процессов серверов (SRV-1, SRV-6; решения D1, D5).
 *
 * Предмет проверки — то, что агент знает о ПРОЦЕССЕ: три сервера независимы,
 * упавший помечен кодом выхода и оставил материалы разбора, а книга процессов
 * переживает перезапуск агента. Как идёт матч внутри процесса, здесь не
 * проверяется вовсе: агент предметной логики матча не содержит (SRV-1), и
 * подставной стенд её не имеет.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive, processBook } from '../src/state/book.js';
import { agentPaths } from '../src/state/paths.js';
import type { Agent } from '../src/agent.js';
import { fakeAgent, sandbox, startParams, until, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await agent.registry.stopAll();
    await agent.close();
  }
  for (const box of boxes.splice(0)) box.drop();
});

async function agentOn(box: Sandbox): Promise<Agent> {
  const agent = await fakeAgent(box);
  agents.push(agent);
  return agent;
}

function box(): Sandbox {
  const created = sandbox();
  boxes.push(created);
  return created;
}

describe('агент — супервизор серверов хоста (SRV-1)', () => {
  it('три сервера на одном хосте независимы, реестр показывает все три', async () => {
    const agent = await agentOn(box());
    const first = await agent.registry.start(startParams());
    const second = await agent.registry.start(startParams());
    const third = await agent.registry.start(startParams({ match: 'matches/training.match.json' }));

    const list = agent.registry.list();
    expect(list).toHaveLength(3);
    expect(new Set(list.map((entry) => entry.port)).size).toBe(3);
    for (const entry of list) expect(entry.state).toBe('listening');
    expect(third.match).toBe('matches/training.match.json');

    // Остановка одного не задевает остальных: процесс-на-сервер (решение D1).
    await agent.registry.stop(second.id);
    const rest = agent.registry.list();
    expect(rest.map((entry) => entry.id).sort()).toEqual([first.id, third.id].sort());
    for (const entry of rest) expect(entry.state).toBe('listening');
  });

  it('краш одного не задевает ни соседей, ни самого агента', async () => {
    const agent = await agentOn(box());
    const healthy = await agent.registry.start(startParams());
    // Процесс, который упадёт сам ненулевым кодом.
    const doomed = await agent.registry.start(startParams({ match: 'matches/crash.match.json' }));

    await until(() => agent.registry.entry(doomed.id)?.state === 'crashed');
    // Упавший помечен `crashed` С КОДОМ ВЫХОДА (SRV-1), а не просто «пропал».
    expect(agent.registry.entry(doomed.id)?.exitCode).toBe(7);
    // Сосед работает, и агент по-прежнему поднимает новые серверы.
    expect(agent.registry.entry(healthy.id)?.state).toBe('listening');
    const third = await agent.registry.start(startParams());
    expect(third.state).toBe('listening');
  });

  it('упавший процесс помечается `crashed` с кодом выхода и оставляет материалы (SRV-6)', async () => {
    const current = box();
    const agent = await agentOn(current);
    const server = await agent.registry.start(startParams({ port: 0 }));
    // Убиваем процесс сервера снаружи — так же, как это делает OOM-killer.
    const entry = processBook(agentPaths(current.stateDir).bookFile).entries.find(
      (record) => record.id === server.id,
    );
    expect(entry).toBeDefined();
    process.kill(entry!.pid, 'SIGKILL');

    await until(() => agent.registry.entry(server.id)?.state === 'crashed');
    const crashed = agent.registry.entry(server.id);
    expect(crashed?.state).toBe('crashed');
    // Убитый сигналом процесс выходит без кода — материалы разбора всё равно
    // сохранены и НАЗВАНЫ в реестре (SRV-6).
    expect(crashed?.postmortem).not.toBeNull();
    expect(crashed?.postmortemFailure).toBeNull();
    const dir = crashed!.postmortem!;
    expect(existsSync(join(dir, 'exit.json'))).toBe(true);
    expect(existsSync(join(dir, 'log.txt'))).toBe(true);
    const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) as {
      signal: string | null;
      exitCode: number | null;
    };
    // Агент записывает то, что сообщила ОС, и недостающего не выдумывает.
    // Сигналов на Windows нет вовсе: `SIGKILL` там означает `TerminateProcess`,
    // и ядро называет КОД выхода, а сигнал — нет. Утверждение поэтому одно и то
    // же на обеих платформах — «выход убитого процесса НАЗВАН» (SRV-6), — а не
    // его posix-написание.
    if (process.platform === 'win32') expect(exit.exitCode).not.toBeNull();
    else expect(exit.signal).toBe('SIGKILL');
    // Хвост лога процесса — то, с чего начинается разбор ночного краша.
    expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toContain('подставной стенд поднят');
  });

});

describe('книга процессов и сверка на старте (решение D5)', () => {
  it('ПРОСИМАЯ остановка — `stopped`, даже когда процесс уходит от сигнала', async () => {
    const home = box();
    const agent = await agentOn(home);
    const entry = await agent.registry.start(startParams({ match: 'matches/deaf.match.json' }));
    // Стенд глух к SIGTERM: остановка доводится SIGKILL'ом, и кода `0` у такого
    // выхода нет вовсе. Вывести вердикт из кода — значит объявить крахом всякую
    // штатную остановку: на Windows иначе не уходит НИ ОДИН стенд.
    await agent.registry.stop(entry.id);

    // Остановленный сервер уходит из реестра — и уходит именно остановленным.
    expect(agent.registry.list()).toEqual([]);
    // Материалов разбора (SRV-6) остановка не оставляет: разбирать нечего.
    // Иначе каталог крашей рос бы на одну запись с КАЖДОЙ остановки сервера.
    const crashRoot = agentPaths(home.stateDir).crashDir;
    const crashes = existsSync(crashRoot) ? readdirSync(crashRoot) : [];
    expect(crashes).toEqual([]);
  });

  it('перезапуск агента при живом сервере сохраняет управление им', async () => {
    const current = box();
    const first = await agentOn(current);
    const server = await first.registry.start(startParams());
    const port = server.port;
    // Агент уходит, а сервер — нет: процессы серверов не его зависимость.
    await first.close();

    const second = await fakeAgent(current);
    agents.push(second);
    // Пережившие найдены по книге и вернулись в реестр (D5).
    expect(second.survivors.map((entry) => entry.id)).toEqual([server.id]);
    const adopted = second.registry.entry(server.id);
    expect(adopted?.state).toBe('listening');
    expect(adopted?.port).toBe(port);

    // И управление ими сохранилось ровно в той мере, в какой оно возможно:
    // остановка есть, а админ-операции до чужого stdio не доходят и говорят это.
    await expect(second.registry.admin(server.id, 'pause', -1)).rejects.toThrow('пережил прежнего агента');
    const pid = second.survivors[0]!.pid;
    await second.registry.stop(server.id);
    expect(processAlive(pid)).toBe(false);
  });

  it('запись без живого процесса уходит из книги: перезагрузка серверы не воскрешает', async () => {
    const current = box();
    const paths = agentPaths(current.stateDir);
    const bookFile = paths.bookFile;
    processBook(bookFile).add({
      id: 'srv-99',
      // Заведомо мёртвый идентификатор процесса: своего же PID тест не трогает.
      pid: 2_147_483_646,
      port: 65_000,
      match: 'matches/duel.match.json',
      startedAt: 0,
      startProc: 0,
    });

    const agent = await agentOn(current);
    expect(agent.survivors).toEqual([]);
    expect(agent.registry.list()).toEqual([]);
    expect(processBook(bookFile).entries).toEqual([]);
  });
});

describe('краш-постмортем без места на диске (SRV-6)', () => {
  it('сорвавшееся сохранение названо в реестре, а не потеряно молча', async () => {
    const current = box();
    const agent = await agentOn(current);
    const server = await agent.registry.start(startParams());
    // Каталог крашей подменяется файлом: `mkdir` по такому пути не пройдёт, и
    // сохранение сорвётся — ровно тот случай, который требование велит НАЗВАТЬ.
    const paths = agentPaths(current.stateDir);
    const { rmSync, writeFileSync } = await import('node:fs');
    rmSync(paths.crashDir, { recursive: true, force: true });
    writeFileSync(paths.crashDir, 'не каталог\n');

    const entry = processBook(paths.bookFile).entries.find((record) => record.id === server.id);
    process.kill(entry!.pid, 'SIGKILL');
    await until(() => agent.registry.entry(server.id)?.state === 'crashed');

    const crashed = agent.registry.entry(server.id);
    expect(crashed?.postmortem).toBeNull();
    expect(crashed?.postmortemFailure).not.toBeNull();
    // И каталог крашей остался тем, чем его подменили: агент его не «чинит».
    expect(readdirSync(paths.root)).toContain('crash');
  });
});
