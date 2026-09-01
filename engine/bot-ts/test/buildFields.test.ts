/**
 * Зависимости сборки мира на пути к боту (`netcode-transport` NTR-14): «обе
 * стороны SHALL поднимать мир матча общим путём сборки, и обе стороны SHALL
 * получать зависимости сборки из одного описания матча».
 *
 * Бот — обычный клиент матча (BOT-2, BOT-4): он предсказывает тики (NTR-10) и
 * обязан поднимать мир тем же набором систем, что сервер. Но путь у него длиннее
 * человеческого — четыре пересадки, и на каждой поле можно потерять молча:
 * `attachBots` → init-сообщение воркера → общие опции воркера → `BotSeat` →
 * `MatchClient`. Тише всего теряется первая: сборка игры вливает раскладку
 * запускалок спредом (`...demoClientBuildOptions(config)`), а спред в
 * объектный литерал избыточные поля не проверяет — секция, которой нет в
 * `AttachBotsOptions`, исчезает без единого слова компилятора. Ровно так бот
 * остался без `locomotion`, когда человеческий клиент его уже получал.
 *
 * Поэтому проверка здесь ТИПОВАЯ и идёт от раскладки запускалок
 * (`CLIENT_BUILD_FIELDS` в `@fluxus/net/bin/matchFile.mjs` — тот самый
 * единственный список, от которого считает и тест слоя запускалок): секция,
 * добавленная в неё и не проведённая через пересадки бота, делает `Missing`
 * непустым, и `npm run typecheck` краснеет ещё до прогона.
 *
 * Импорт списка — ТИПОВОЙ: `matchFile.mjs` тянет `node:fs` и хук резолва,
 * которых у воркер-сборки бота нет; импорт типа стирается компиляцией. Тот же
 * приём и та же причина, что в `game/demo-ts/app/match.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CLIENT_BUILD_FIELDS } from '@fluxus/net/bin/matchFile.mjs';
import type { BotWorkerInit } from '../src/assembly.js';
import type { BotSeatOptions } from '../src/host.js';
import type { AttachBotsOptions } from '../src/worker/spawn.js';

/** Секция раскладки клиента, не доехавшая до пересадки. */
type Missing<Stop> = Exclude<(typeof CLIENT_BUILD_FIELDS)[number], keyof Stop>;

describe('зависимости сборки доезжают до бота (NTR-14, BOT-4)', () => {
  it('каждая пересадка принимает всю раскладку клиента матча', () => {
    // Пересадка первая: главная половина сборки, куда игра вливает раскладку.
    const attach: [Missing<AttachBotsOptions>] extends [never] ? true : false = true;
    // Вторая: init-сообщение воркера — те же поля переезжают границу потока.
    const init: [Missing<BotWorkerInit>] extends [never] ? true : false = true;
    // Третья: место бота, откуда поля уходят в `MatchClient`.
    const seat: [Missing<BotSeatOptions>] extends [never] ? true : false = true;
    expect([attach, init, seat]).toEqual([true, true, true]);
  });
});
