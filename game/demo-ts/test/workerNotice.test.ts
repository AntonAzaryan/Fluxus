/**
 * Отказ сборки в воркере доезжает до человека (`game-content` CONT-5, Risks
 * дизайна change'а sec09): «отказ называется человеку (`showNotice`)… а не
 * оседает в консоли воркера».
 *
 * Предмет — именно новая дорога документов: они приезжают ИЗ РАЗДАЧИ, и негодный
 * документ дерева — обычное состояние правленого контента, а не невозможное.
 * Главный поток раскладку проверяет у себя (`main.ts`), но сторона матча может
 * не собраться и по другой причине, и тогда единственное место, где игрок узнаёт
 * причину, — конверт `demo-notice`. Молчание здесь выглядит зависшей страницей.
 *
 * Воркер поднимается ТЕМ ЖЕ модулем, каким его поднимает браузер: подменена
 * только область видимости воркера (`self`) — приёмник сообщений и обратный
 * канал. Своей копии обработчика в тесте нет (NTR-12).
 */
import { describe, expect, it } from 'vitest';
import type { DemoDocuments } from '../app/match.js';
import type { DemoNotice } from '../app/wiring.js';

type Listener = (event: { data: unknown }) => void;

interface WorkerScope {
  readonly listeners: Listener[];
  readonly posted: unknown[];
}

/** Область видимости воркера: `self` со своим приёмником и обратным каналом. */
function installScope(): WorkerScope {
  const listeners: Listener[] = [];
  const posted: unknown[] = [];
  (globalThis as { self?: unknown }).self = {
    addEventListener(_type: string, listener: Listener): void {
      listeners.push(listener);
    },
    postMessage(message: unknown): void {
      posted.push(message);
    },
  };
  return { listeners, posted };
}

/** Конверт документов, на котором раскладка обязана отказать: пак без сцены. */
function brokenDocuments(): DemoDocuments {
  return { match: { sceneRef: 'duel', players: ['p1'] }, scenes: {}, sceneIds: {} } as unknown as DemoDocuments;
}

function deliver(scope: WorkerScope, message: unknown): void {
  for (const listener of scope.listeners) listener({ data: message });
}

function noticesOf(scope: WorkerScope): DemoNotice[] {
  return scope.posted.filter(
    (message): message is DemoNotice => (message as { t?: string }).t === 'demo-notice',
  );
}

describe('воркер называет человеку, почему матча нет (CONT-5)', () => {
  it('соло-воркер: негодный документ раздачи становится сообщением, а не тишиной', async () => {
    const scope = installScope();
    await import('../app/worker.js');
    deliver(scope, { t: 'demo-solo-init', documents: brokenDocuments() });

    const notices = noticesOf(scope);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('соло-режим не поднялся');
    // Причина названа, а не спрятана: текст отказа сборки едет целиком.
    expect(notices[0]!.message).toContain('duel');
  });

  it('воркер сервера вкладки: та же дорога у авторитетной половины', async () => {
    const scope = installScope();
    await import('../app/serverWorker.js');
    deliver(scope, { t: 'demo-server-init', documents: brokenDocuments() });

    const notices = noticesOf(scope);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('сервер вкладки не поднялся');
    // Порт участника при этом наружу не уехал: матча нет, отдавать нечего.
    expect(scope.posted.some((message) => (message as { t?: string }).t === 'demo-server-ready')).toBe(false);
  });

  it('воркер клиента: сорвавшийся вход тоже сообщение, а не необработанный промис', async () => {
    const scope = installScope();
    await import('../app/clientWorker.js');
    // Ни порта, ни адреса — рандеву отказывает синхронно, внутри обработчика
    // сообщения: до этого change'а такой отказ уходил в консоль воркера.
    deliver(scope, { t: 'demo-client-init', documents: brokenDocuments() });

    const notices = noticesOf(scope);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('матч не поднялся');

    // И вторая дорога — отказ ВНУТРИ входа: адрес стенда есть, а документ негоден,
    // поэтому сборка мира матча падает уже в промисе. Именно он и оседал бы
    // необработанным отказом, не доехав до экрана.
    deliver(scope, { t: 'demo-client-init', documents: brokenDocuments(), url: 'ws://127.0.0.1:1' });
    await new Promise((done) => setTimeout(done, 0));
    const afterJoin = noticesOf(scope);
    expect(afterJoin).toHaveLength(2);
    expect(afterJoin[1]!.message).toContain('матч не поднялся');
    // Сеть при этом не трогалась: отказ пришёл раньше первой попытки соединения.
    expect(afterJoin[1]!.message).not.toContain('не удалось соединиться');
  });
});
