/**
 * Ульта отката на ВЫДЕЛЕННОМ стенде (`bin/demo-serve.mjs`, `npm run demo:serve`).
 *
 * Стенд поднимает матч не так, как вкладка: вкладка собирает конфиг кодом
 * (`app/match.ts`), а стенд раскладывает документ матча помощником запускалок
 * `@game-mvp/net/bin/matchFile.mjs` — тем же, которым его раскладывает
 * `serve.mjs`. Ровно на этом шве ульта и терялась: раскладка перечисляла секции
 * поимённо и не называла `rewind`, поэтому `MatchServer` собирался БЕЗ истории,
 * `$rewind/request` отбрасывался, а игрок видел ульту, которая жжёт cooldown и
 * не двигает мир. Во вкладке путь был цел — оттого 79 тестов перемотки и
 * оставались зелёными.
 *
 * Предмет теста поэтому не механизм перемотки (он закрыт тестами ядра, сети и
 * оболочки), а ДОРОГА до него: настоящий документ матча → конфиг → сервер →
 * запрос из настоящей сцены → `Rewinding`.
 *
 * Дерево контента читается напрямую: это тест ИГРЫ, и `content/` для него —
 * свои данные (CONT-1, CONT-4). Тому же слою в `engine/` это было бы запрещено,
 * поэтому раскладка как таковая проверяется формой документа —
 * `engine/net-ts/test/matchFile.test.ts`.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SceneDef } from '@game-mvp/core';
import { MatchServer, contentPack, type ClientMessage, type MatchConfig } from '@game-mvp/net';
import { matchConfigOf, readMatchFile } from '@game-mvp/net/bin/matchFile.mjs';
import { ACTION_BITS } from '../app/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

const MATCH_PATH = fileURLToPath(
  new URL('../../../content/matches/duel.match.json', import.meta.url),
);
const SCENE = sceneJson as unknown as SceneDef;

/** Секция `rewind` документа матча — как её читает человек, открыв файл. */
const DOCUMENT_REWIND = (matchJson as { readonly rewind?: Record<string, unknown> }).rewind;

const REWIND_BIT = 1 << ACTION_BITS.rewind;

/** Тиков до готовности ульты в сцене прогона — см. `sceneWithReadyUlt`. */
const READY_TICKS = 20;

/**
 * Сцена стенда с УКОРОЧЕННЫМ стартовым cooldown'ом ульты. Правится ровно одно
 * число, и оно балансное: стартовый остаток сцены — противопетлевая мера
 * (он обязан превышать глубину отката, иначе перемотка достаёт до тика, когда
 * слоты ещё не выданы), и держит это неравенство `demoAbilities.test.ts`.
 *
 * Предмет ЭТОГО теста — дорога запроса до сервера, и секунды ожидания в ней не
 * проверяют ничего, зато стоят прогону минуты чужого времени: тесты пакета идут
 * параллельно, и соседний файл начинает падать по тайм-ауту.
 */
function sceneWithReadyUlt(): SceneDef {
  const scene = structuredClone(SCENE) as {
    prefabs?: { name: string; components: Record<string, Record<string, number>> }[];
  };
  const slot = scene.prefabs?.find((prefab) => prefab.name === 'SlotRewind');
  expect(slot).toBeDefined();
  const cooldown = slot!.components.AbilityCooldown;
  expect(cooldown).toBeDefined();
  cooldown!.remaining = READY_TICKS;
  return scene as unknown as SceneDef;
}

/** Конфиг матча ровно тем путём, каким его собирает стенд. */
function standConfig(scene?: SceneDef): MatchConfig {
  const match = readMatchFile(MATCH_PATH);
  const scenes = scene === undefined ? match.scenes! : { [match.sceneRef!]: scene };
  return matchConfigOf(match, contentPack(scenes));
}

/**
 * Матч стенда без транспорта (NTR-3): оба слота заняты, ввод подаётся
 * сообщениями прямо серверу, темп двигает тест. Кадр адресуется тику
 * `tick + inputDelay` — так же, как его размечает клиент по расписанию (NTR-7).
 */
function standMatch(config: MatchConfig) {
  const server = new MatchServer(config);
  let seq = 0;
  const hello = (playerId: string): ClientMessage => ({
    type: 'Hello',
    playerId,
    version: config.version,
    observer: false,
  });
  config.players.forEach((playerId, slot) => {
    server.connect(slot + 1);
    server.receive(slot + 1, hello(playerId));
  });
  server.drain();

  /** Один тик расписания с вводом первого слота. */
  const step = (buttons: number): void => {
    seq++;
    server.receive(1, {
      type: 'Input',
      epoch: server.epoch,
      frames: [
        {
          tick: server.tick + (config.inputDelay ?? 2),
          seq,
          moveX: 0,
          moveY: 0,
          aimDir: 0,
          buttons,
        },
      ],
    });
    server.advance();
    server.drain();
  };

  return { server, step };
}

/**
 * Прожать ульту и дождаться входа в перемотку. Бит МИГАЕТ, а не держится: каст
 * идёт по фронту кнопки (определение `rewind` сцены), и удержание дало бы ровно
 * один фронт — на первом тике, когда ульта ещё на cooldown'е.
 */
function castUlt(m: ReturnType<typeof standMatch>): boolean {
  for (let ticks = 0; ticks < READY_TICKS + 32; ticks++) {
    if (m.server.mode !== 'Running') return true;
    m.step(ticks % 2 === 0 ? REWIND_BIT : 0);
  }
  return m.server.mode !== 'Running';
}

describe('стенд демо: ульта отката доезжает до сервера (NET-11, NTR-14)', () => {
  it('раскладка документа матча несёт секцию rewind дословно', () => {
    expect(DOCUMENT_REWIND).toBeDefined();
    expect(standConfig().rewind).toEqual(DOCUMENT_REWIND);
  });

  it('бит удержания скраба в матче — тот же, что жмёт игрок в демо', () => {
    // Раскладку битов знает сборка игры, а не сетевой слой (NET-11): совпасть
    // они обязаны, иначе сервер ведёт точку по чужой кнопке.
    expect(standConfig().rewind?.holdButton).toBe(ACTION_BITS.rewind);
  });

  it('сервер стенда собрал механизм перемотки, а не поднялся без истории', () => {
    const server = new MatchServer(standConfig());

    // `pause()` без контроллера бросает: проверка на собранную историю, а не на
    // непустое поле конфига.
    expect(() => { server.pause(); }).not.toThrow();
    expect(server.mode).toBe('Paused');
    server.beginRewind();
    expect(server.mode).toBe('Rewinding');
    server.pause();
    server.resume();
    expect(server.mode).toBe('Running');
  });

  /**
   * Дорога целиком — от каста до возобновления — одной проверкой, а не тремя:
   * каждая начиналась бы с ожидания готовности ульты, то есть прогоняла бы
   * настоящую сцену заново.
   */
  it('запрос из настоящей сцены уводит матч в Rewinding, ведёт точку и возвращает мир', () => {
    const config = standConfig(sceneWithReadyUlt());
    const m = standMatch(config);
    expect(m.server.mode).toBe('Running');

    expect(castUlt(m)).toBe(true);
    expect(m.server.mode).toBe('Rewinding');
    const castTick = m.server.tick;

    // Цикл рассылки удержания — один шаг скраба назад (REW-13).
    const cycle = (config.tickRate ?? 60) / (config.snapshotRate ?? 30);
    for (let i = 0; i < cycle; i++) m.step(REWIND_BIT);
    expect(m.server.tick).toBe(castTick - config.rewind!.step!);

    // Бит отпущен — мир возобновляется с достигнутой точки (WSM-2).
    for (let i = 0; i < cycle && m.server.mode !== 'Running'; i++) m.step(0);
    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBeLessThan(castTick);
  });

  it('короткий тап по ульте двигает мир, а не сжигает её впустую (РЕГРЕССИЯ, REW-13)', () => {
    // РЕГРЕССИЯ на настоящем контенте. Драйвер скраба ждал целый цикл рассылки
    // до первого шага и только там читал отпускание: тап по клавише ульты
    // возвращал мир на ТОТ ЖЕ тик, потратив cooldown в 1200 тиков. Игрок видел
    // ульту, которая «не работает», — и это второй фасад того же дефекта, что и
    // потерянная секция `rewind`.
    const config = standConfig(sceneWithReadyUlt());
    const m = standMatch(config);
    expect(castUlt(m)).toBe(true);
    expect(m.server.mode).toBe('Rewinding');
    const castTick = m.server.tick;

    // Бита нет уже в первом кадре после каста — короче нажатия не бывает.
    const cycle = (config.tickRate ?? 60) / (config.snapshotRate ?? 30);
    for (let i = 0; i < cycle + 1 && m.server.mode !== 'Running'; i++) m.step(0);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick - config.rewind!.step!);
  });
});
