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
import type { DemoDocuments } from './match.js';
import { joinDemoMatch, type DemoJoined } from './netClient.js';
import { observeDemoMatch, OBSERVER_PLAYER_ID } from './observerClient.js';
import type { MatchClient } from '@fluxus/net';
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

/**
 * Рандеву из конверта сборки: порт матча этой же вкладки либо адрес стенда.
 * Ростер — из документа матча того же конверта (CONT-5): имена слотов и версия,
 * которой клиент представляется, обязаны приехать из одного экземпляра.
 */
function rendezvousOf(init: DemoClientInit, documents: DemoDocuments): DemoRendezvous {
  const players = documents.match.players;
  if (init.port !== undefined) return tabRendezvous(init.port, players);
  if (init.url === undefined) throw new Error('демо: воркеру клиента не дали ни порта, ни адреса');
  return directRendezvous(init.url, players);
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

/**
 * Конец наблюдения человеку (NTR-21): матч кончился либо канал оборвался.
 *
 * Опросом, а не подпиской на транспорт: обработчик закрытия у канала один и
 * принадлежит оболочке (`ClientHost`), а возврата в матч у наблюдателя нет —
 * сообщить остаётся ровно один раз. Молчание вместо этого выглядело бы
 * замёрзшей картинкой без причины.
 */
function watchObserving(client: MatchClient): void {
  const timer = setInterval(() => {
    if (client.phase !== 'closed') return;
    clearInterval(timer);
    notice(`наблюдение окончено (${client.closeReason ?? '—'}): ${client.closeDetail}`);
  }, LEAD_POLL_MS);
}

scope.addEventListener('message', (event) => {
  if (!isDemoClientInit(event.data)) return;
  const { documents } = event.data;
  const { connect, candidates } = rendezvousOf(event.data, documents);
  // Наблюдатель (NTR-9, NTR-21) — другой род участия, а не другой сервер:
  // рандеву то же самое (SES-3), и отличается только то, что имени слота он не
  // предъявляет и ввода не отправляет. Возврата в матч у него нет: слот за ним
  // не числится, возвращаться некуда.
  if (event.data.observer === true) {
    void observeDemoMatch({
      port,
      documents,
      connect: () => connect(OBSERVER_PLAYER_ID),
    }).then((observing) => {
      if (!observing.ok) {
        notice(observing.reason);
        return;
      }
      watchObserving(observing.client);
    });
    return;
  }
  // `notify` — состояние возврата в матч (NTR-17, design D8): «возвращаюсь»,
  // «вернуться не удалось», пустая строка на успехе. Тем же конвертом, что и
  // причина, по которой матча нет: у человека это одно и то же место на экране.
  void joinDemoMatch({ port, documents, connect, candidates, notify: notice }).then((joined) => {
    if (!joined.ok) {
      notice(joined.reason);
      return;
    }
    watchInputLead(joined);
  });
});
