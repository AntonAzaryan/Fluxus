/**
 * Общая воркер-сторона бота (design D3): init-сообщение → поднятый `BotHost`.
 *
 * Рантайм-специфичного здесь нет ничего — ни `self`, ни `parentPort`: entry
 * браузера и entry node различаются только тем, откуда приезжает init-сообщение
 * (`browserEntry.ts`, `nodeEntry.ts`). Всё остальное — этот файл, и потому
 * «бот работает в обоих окружениях из одного кода» держится сборкой, а не
 * сравнением двух реализаций глазами.
 *
 * Init-сообщение здесь — ВХОД ИЗВНЕ: оно пересекло structured clone, то есть
 * пришло от другого потока и типом не гарантировано ничем. Поэтому профиль
 * разбирается и проверяется на этой стороне (BOT-6), а не принимается на веру.
 */
import { fixed, type SceneDef } from '@game-mvp/core';
import { contentPack, type ContentPack } from '@game-mvp/net';
import { shellPort } from '@game-mvp/client/protocol';
import { portTransport } from '@game-mvp/client/portTransport';
import type { BotWorkerInit } from '../assembly.js';
import { brainFactoryByKind } from '../brains/registry.js';
import type { ArenaCenter } from '../brains/classic/utility.js';
import { BotHost } from '../host.js';
import { parseBotProfile } from '../profile.js';

export interface BotWorkerOptions {
  /**
   * Запускать собственный темп сразу. Выключается прогоном, который двигает
   * ботов сам (NTR-12) — тем же основанием, по какому у хостов есть `step()`.
   */
  readonly autoRun?: boolean;
  readonly now?: () => number;
}

/**
 * Центр арены сцены как float (`arena` ARENA-1, BOT-5): величина живёт в ассете
 * сцены в Q16.16 и в компонентах не появляется, поэтому мозг получает её
 * сборкой. Сцена без арены — центр в начале координат: другого известного
 * ориентира у бота нет.
 */
function arenaCenter(scene: SceneDef): ArenaCenter {
  const center = scene.arena?.center;
  if (center === undefined) return { x: 0, y: 0 };
  return { x: fixed.toFloat(center.x), y: fixed.toFloat(center.y) };
}

/**
 * Поднимает ботов init-сообщения: по `MatchClient` на слот, по транспорту на
 * порт, мозг — по имени из реестра (BOT-2, BOT-4).
 */
export function startBotWorker(init: BotWorkerInit, options: BotWorkerOptions = {}): BotHost {
  const pack: ContentPack & { readonly hash: string } = contentPack({ [init.sceneRef]: init.scene });
  const assembly = {
    center: arenaCenter(init.scene),
    ...(init.names !== undefined ? { names: init.names } : {}),
  };
  const host = new BotHost();
  for (const [index, seat] of init.seats.entries()) {
    const port = init.ports[index];
    if (port === undefined) throw new Error(`startBotWorker: боту "${seat.playerId}" не дан порт`);
    host.add({
      playerId: seat.playerId,
      transport: portTransport(shellPort(port)),
      brain: brainFactoryByKind(seat.brain, assembly),
      // Валидация профиля на конструировании бота (BOT-6): документ приехал
      // сообщением, и «его уже проверила сборка» — предположение, а не факт.
      profile: parseBotProfile(seat.profile, `профиль бота "${seat.playerId}"`),
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
