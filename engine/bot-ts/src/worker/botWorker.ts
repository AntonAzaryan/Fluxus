/**
 * Общая воркер-сторона бота (design D3): init-сообщение → поднятый `BotHost`.
 *
 * Рантайм-специфичного здесь нет ничего — ни `self`, ни `parentPort`: entry
 * браузера и entry node различаются только тем, откуда приезжает init-сообщение
 * (`browserEntry.ts`, `nodeEntry.ts`). Всё остальное — этот файл, и потому
 * «бот работает в обоих окружениях из одного кода» держится сборкой, а не
 * сравнением двух реализаций глазами.
 */
import { contentPack, type ContentPack } from '@game-mvp/net';
import { shellPort } from '@game-mvp/client/protocol';
import { portTransport } from '@game-mvp/client/portTransport';
import type { BotWorkerInit } from '../assembly.js';
import { brainFactoryByKind } from '../brains/registry.js';
import { BotHost } from '../host.js';

export interface BotWorkerOptions {
  /**
   * Запускать собственный темп сразу. Выключается прогоном, который двигает
   * ботов сам (NTR-12) — тем же основанием, по какому у хостов есть `step()`.
   */
  readonly autoRun?: boolean;
  readonly now?: () => number;
}

/**
 * Поднимает ботов init-сообщения: по `MatchClient` на слот, по транспорту на
 * порт, мозг — по имени из реестра (BOT-2, BOT-4).
 *
 * Профиль здесь уже разобран (`parseBotProfile` — сборка, отправляющая init):
 * воркеру приезжает документ, прошедший валидацию, и второй раз она не
 * повторяется.
 */
export function startBotWorker(init: BotWorkerInit, options: BotWorkerOptions = {}): BotHost {
  const pack: ContentPack & { readonly hash: string } = contentPack({ [init.sceneRef]: init.scene });
  const host = new BotHost();
  for (const [index, seat] of init.seats.entries()) {
    const port = init.ports[index];
    if (port === undefined) throw new Error(`startBotWorker: боту "${seat.playerId}" не дан порт`);
    host.add({
      playerId: seat.playerId,
      transport: portTransport(shellPort(port)),
      brain: brainFactoryByKind(seat.brain),
      profile: seat.profile,
      content: pack,
      // Хеш контент-пака считается ЗДЕСЬ, из своего контента: сверка версии
      // (`netcode` NET-16) обязана сравнивать то, что клиент реально поднял, а
      // не то, что о нём сказала сборка.
      version: { buildId: init.buildId, contentPackHash: pack.hash },
      ...(init.physics !== undefined ? { physics: init.physics } : {}),
      ...(init.visibility !== undefined ? { visibility: init.visibility } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
  host.start();
  if (options.autoRun !== false) host.run();
  return host;
}
