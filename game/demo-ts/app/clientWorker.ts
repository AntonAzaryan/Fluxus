/**
 * Воркер СЕТЕВОГО режима оболочки (SHELL-1, SHELL-8): тонкий клиент матча.
 * Симуляции здесь нет — `tick()` не вызывается ни разу за сессию, и вызвать его
 * нечем (`NetworkShell` не получает `Simulation`).
 *
 * Один файл на оба сетевых режима страницы: матч своей вкладки и выделенный
 * стенд различаются здесь единственным аргументом — транспортом (SES-1, NTR-2).
 * Соло-режим живёт в `worker.ts` и этого файла не касается вовсе.
 */
import { connectWebSocket, type Transport } from '@game-mvp/net';
import { portTransport, shellPort } from '@game-mvp/client';
import { DEMO_PLAYERS } from './match.js';
import { slotCandidates } from './mode.js';
import { joinDemoMatch } from './netClient.js';
import { isDemoClientInit, type DemoClientInit, type DemoNotice } from './wiring.js';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

const port = shellPort(self as unknown as Worker);

/**
 * Как добраться до сервера матча. Пара портов — матч этой же вкладки, сокет —
 * стенд; `MatchClient` различия не видит (NTR-2).
 */
function transportFactory(init: DemoClientInit): () => Promise<Transport> {
  if (init.port !== undefined) {
    const shared = init.port;
    return () => Promise.resolve(portTransport(shellPort(shared)));
  }
  const url = init.url;
  if (url === undefined) throw new Error('демо: воркеру клиента не дали ни порта, ни адреса');
  return () => connectWebSocket(url);
}

scope.addEventListener('message', (event) => {
  if (!isDemoClientInit(event.data)) return;
  const init = event.data;
  // Политика выбора слота — одна и та же величина, что у главного потока
  // (`mode.ts`): порт матча своей вкладки одноразовый, и перебирать по нему
  // нечего — второй слот держит бот (BOT-7); у стенда кандидатов столько же,
  // сколько имён в ростере (design D4). Второй копии этого правила в сборке
  // нет: разойдись они, и тестировался бы не тот код, который поехал.
  const candidates = slotCandidates(
    init.port !== undefined ? { kind: 'local' } : { kind: 'server', url: init.url ?? '' },
    DEMO_PLAYERS,
  );
  void joinDemoMatch({ port, connect: transportFactory(init), candidates }).then((joined) => {
    if (joined.ok) return;
    const notice: DemoNotice = { t: 'demo-notice', message: joined.reason };
    port.post(notice);
  });
});
