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
import { shellPort } from '@game-mvp/client';
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

/** Состояние сессии человеку: почему матча нет и что сейчас происходит. */
function notice(message: string): void {
  const envelope: DemoNotice = { t: 'demo-notice', message };
  port.post(envelope);
}

scope.addEventListener('message', (event) => {
  if (!isDemoClientInit(event.data)) return;
  const { connect, candidates } = rendezvousOf(event.data);
  // `notify` — состояние возврата в матч (NTR-17, design D8): «возвращаюсь»,
  // «вернуться не удалось», пустая строка на успехе. Тем же конвертом, что и
  // причина, по которой матча нет: у человека это одно и то же место на экране.
  void joinDemoMatch({ port, connect, candidates, notify: notice }).then((joined) => {
    if (joined.ok) return;
    notice(joined.reason);
  });
});
