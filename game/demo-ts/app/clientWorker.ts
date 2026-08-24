/**
 * Воркер СЕТЕВОГО режима оболочки (SHELL-1, SHELL-8): тонкий клиент матча.
 * Симуляции здесь нет — `tick()` не вызывается ни разу за сессию, и вызвать его
 * нечем (`NetworkShell` не получает `Simulation`).
 *
 * Один файл на оба сетевых режима страницы: матч своей вкладки и выделенный
 * стенд различаются здесь единственной величиной — рандеву (`rendezvous.ts`,
 * SES-1, SES-3), — а клиент не видит и её. Соло-режим живёт в `worker.ts` и
 * этого файла не касается вовсе.
 */
import { shellPort } from '@fluxus/client';
import { DEMO_PLAYERS } from './match.js';
import { joinDemoMatch } from './netClient.js';
import { directRendezvous, tabRendezvous, type DemoRendezvous } from './rendezvous.js';
import { isDemoClientInit, type DemoClientInit, type DemoNotice } from './wiring.js';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

const port = shellPort(self as unknown as Worker);

/** Рандеву из конверта сборки: порт матча этой же вкладки либо адрес стенда. */
function rendezvousOf(init: DemoClientInit): DemoRendezvous {
  if (init.port !== undefined) return tabRendezvous(init.port, DEMO_PLAYERS);
  if (init.url === undefined) throw new Error('демо: воркеру клиента не дали ни порта, ни адреса');
  return directRendezvous(init.url, DEMO_PLAYERS);
}

scope.addEventListener('message', (event) => {
  if (!isDemoClientInit(event.data)) return;
  const { connect, candidates } = rendezvousOf(event.data);
  void joinDemoMatch({ port, connect, candidates }).then((joined) => {
    if (joined.ok) return;
    const notice: DemoNotice = { t: 'demo-notice', message: joined.reason };
    port.post(notice);
  });
});
