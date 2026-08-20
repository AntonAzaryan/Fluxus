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
import { fixed, type SceneDef, type Serializer } from '@game-mvp/core';
import { contentPack, jsonSerializer, msgpackSerializer, type ContentPack } from '@game-mvp/net';
import { shellPort } from '@game-mvp/client/protocol';
import { portTransport } from '@game-mvp/client/portTransport';
import type { BotWireFormat, BotWorkerInit } from '../assembly.js';
import { parseBotBehavior } from '../behavior.js';
import { brainFactoryByKind } from '../brains/registry.js';
import type { ArenaCenter } from '../brains/layers/plan.js';
import { BotHost } from '../host.js';
import { parseBotProfile } from '../profile.js';
import { botTerrain } from '../terrainView.js';

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
 * Формат кадра по имени (SER-3). Резолвится ЗДЕСЬ, как и фабрика мозга: через
 * structured clone едут данные, а не объекты с функциями. Неизвестное имя —
 * отказ, а не тихое умолчание: бот, заговоривший не тем форматом, не отвергается
 * сервером, а просто не понимается им, и матч встаёт в лобби навсегда.
 */
const WIRE_FORMATS: Readonly<Record<string, Serializer>> = {
  json: jsonSerializer,
  msgpack: msgpackSerializer,
};

function serializerOf(format: BotWireFormat | undefined): Serializer | undefined {
  if (format === undefined) return undefined;
  // Имя приехало структурным клоном, то есть типом не гарантировано ничем —
  // проверка настоящая, а не формальность (как и разбор профиля рядом).
  const serializer = WIRE_FORMATS[format];
  if (serializer === undefined) {
    throw new Error(`startBotWorker: неизвестный формат кадра "${format}" (SER-3)`);
  }
  return serializer;
}

/**
 * Поднимает ботов init-сообщения: по `MatchClient` на слот, по транспорту на
 * порт, мозг — по имени из реестра (BOT-2, BOT-4).
 */
export function startBotWorker(init: BotWorkerInit, options: BotWorkerOptions = {}): BotHost {
  const pack: ContentPack & { readonly hash: string } = contentPack({ [init.sceneRef]: init.scene });
  // Рельеф разбирается ОДИН раз на воркер и делится всеми его ботами: сетка
  // иммутабельна (TERR-6), а разбор карт — работа, которую незачем повторять на
  // каждом месте.
  const terrain = botTerrain(init.scene);
  const assembly = {
    center: arenaCenter(init.scene),
    ...(terrain !== undefined ? { terrain } : {}),
    ...(init.names !== undefined ? { names: init.names } : {}),
  };
  const serializer = serializerOf(init.wireFormat);
  const host = new BotHost();
  for (const [index, seat] of init.seats.entries()) {
    const port = init.ports[index];
    if (port === undefined) throw new Error(`startBotWorker: боту "${seat.playerId}" не дан порт`);
    host.add({
      playerId: seat.playerId,
      transport: portTransport(shellPort(port)),
      // Документ поведения — СВОЙ у каждого места (BOT-8): профиль называет его
      // путь, и два бота одного матча вправе играть разную политику. Разбор,
      // как и у профиля, происходит на этой стороне границы: документ приехал
      // structured clone'ом, то есть типом не гарантирован ничем.
      brain: brainFactoryByKind(seat.brain, {
        ...assembly,
        ...(seat.behavior === undefined
          ? {}
          : {
              behavior: parseBotBehavior(
                seat.behavior,
                `документ поведения бота "${seat.playerId}"`,
              ),
            }),
      }),
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
      ...(serializer !== undefined ? { serializer } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
  host.start();
  if (options.autoRun !== false) host.run();
  return host;
}
