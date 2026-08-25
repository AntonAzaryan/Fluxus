/**
 * Подпорки тестов агента: временный каталог состояния, подставной стенд и
 * ожидание по условию.
 *
 * Каталог состояния временный у КАЖДОГО прогона: агент пишет туда сертификат,
 * токены и книгу процессов, и прогон, подмешавшийся к домашнему каталогу
 * человека, испортил бы ему пейринг.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAgent, type Agent, type AgentOptions } from '../src/agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Подставной стенд: тот же контракт stdio, ни движка, ни контента. */
export const FAKE_STAND = join(HERE, 'fixtures', 'fakeStand.mjs');

/** Настоящая запускалка стенда демо-арены — для сквозного прогона. */
export const REAL_STAND = join(HERE, '..', '..', 'demo-ts', 'bin', 'demo-serve.mjs');

/** Дерево контента репозитория: агенту оно законно — он слой игры (CONT-1). */
export const REPO_CONTENT = join(HERE, '..', '..', '..', 'content');

export interface Sandbox {
  readonly stateDir: string;
  readonly contentRoot: string;
  drop(): void;
}

/** Каталог состояния и минимальное дерево контента с одним документом матча. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'fluxus-agent-'));
  const contentRoot = join(root, 'content');
  mkdirSync(join(contentRoot, 'matches'), { recursive: true });
  writeFileSync(join(contentRoot, 'matches', 'duel.match.json'), '{"name":"duel"}\n');
  writeFileSync(join(contentRoot, 'matches', 'training.match.json'), '{"name":"training"}\n');
  // Документ, по которому подставной стенд падает ненулевым кодом: агент строит
  // аргументы сам, и попросить процесс упасть тест может только так.
  writeFileSync(join(contentRoot, 'matches', 'crash.match.json'), '{"name":"crash"}\n');
  // Немедленный выход ДО прослушивания порта — несостоявшийся запуск (MGR-2).
  writeFileSync(join(contentRoot, 'matches', 'die.match.json'), '{"name":"die"}\n');
  // Стенд с незнакомым статусом слота — дрейф стенда и агента (SRV-4).
  writeFileSync(join(contentRoot, 'matches', 'drift.match.json'), '{"name":"drift"}\n');
  return {
    stateDir: join(root, 'state'),
    contentRoot,
    drop() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Агент на подставном стенде: быстрый, детерминированный, без движка. */
export function fakeAgent(box: Sandbox, overrides: Partial<AgentOptions> = {}): Promise<Agent> {
  return startAgent({
    controlPort: 0,
    httpPort: 0,
    host: '127.0.0.1',
    stateDir: box.stateDir,
    standScript: FAKE_STAND,
    contentRoot: box.contentRoot,
    bundleDir: '',
    versions: { buildId: 'test-build', contentPackHash: 'test-hash', distribution: 'test' },
    ...overrides,
  });
}

/** Параметры запуска по умолчанию: остальное — умолчания стенда. */
export function startParams(overrides: Record<string, unknown> = {}) {
  return {
    match: 'matches/duel.match.json',
    port: 0,
    bot: '',
    botFillMs: null,
    onDisconnect: '',
    autoRestart: false,
    ...overrides,
  } as const as import('../src/protocol/messages.js').StartParams;
}

/** Ждёт условия до крайнего срока: медленная машина делает тест медленнее, а не красным. */
export async function until(condition: () => boolean, deadlineMs = 8000): Promise<boolean> {
  const edge = Date.now() + deadlineMs;
  while (Date.now() < edge) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return condition();
}
