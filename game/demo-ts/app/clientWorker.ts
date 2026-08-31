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
import { joinDemoMatch, type DemoJoined } from './netClient.js';
import { directRendezvous, tabRendezvous, type DemoRendezvous } from './rendezvous.js';
import {
  isDemoClientInit,
  type DemoClientInit,
  type DemoInputLead,
  type DemoNotice,
} from './wiring.js';

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

/** Как часто воркер сверяет запас разметки: человек читает его глазами. */
const LEAD_POLL_MS = 500;

/**
 * Запас разметки ввода (NTR-7) наружу — по изменению, а не каждым тиком:
 * величина целая и меняется редко, а конверт на тик был бы сообщением ради
 * сообщения. Читается у ТЕКУЩЕГО клиента сессии: возврат в матч поднимает новый
 * (NTR-17), и запас у него честно начинается заново.
 *
 * Закрытый клиент едет наружу как «нет величины»: матч кончился либо канал
 * оборвался, и последнее показание перестало быть замером — оставлять его на
 * экране значило бы утверждать про канал матча, которого нет. Опрос при этом
 * продолжается: возврат в матч (NTR-17) поднимает нового клиента в той же
 * сессии, и показание обязано вернуться само.
 */
function watchInputLead(joined: DemoJoined): void {
  let shown: number | undefined;
  let silent = false;
  setInterval(() => {
    const lead = joined.client.phase === 'closed' ? undefined : joined.client.metrics.inputLead;
    if (lead === undefined) {
      if (silent) return;
      silent = true;
      shown = undefined;
      port.post({ t: 'demo-input-lead' } satisfies DemoInputLead);
      return;
    }
    silent = false;
    if (lead === shown) return;
    shown = lead;
    port.post({ t: 'demo-input-lead', lead } satisfies DemoInputLead);
  }, LEAD_POLL_MS);
}

scope.addEventListener('message', (event) => {
  if (!isDemoClientInit(event.data)) return;
  const { connect, candidates } = rendezvousOf(event.data);
  // `notify` — состояние возврата в матч (NTR-17, design D8): «возвращаюсь»,
  // «вернуться не удалось», пустая строка на успехе. Тем же конвертом, что и
  // причина, по которой матча нет: у человека это одно и то же место на экране.
  void joinDemoMatch({ port, connect, candidates, notify: notice }).then((joined) => {
    if (!joined.ok) {
      notice(joined.reason);
      return;
    }
    watchInputLead(joined);
  });
});
