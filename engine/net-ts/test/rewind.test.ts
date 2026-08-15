/**
 * Сервер как ИСПОЛНИТЕЛЬ перемотки (NET-11): решение порождает симуляция —
 * геймплейная система ульты эмитит событие-запрос, — сервер дренирует его после
 * тика, проводит переходы машины состояний и ведёт точку остановки, пока
 * инициатор держит орган управления (REW-5, REW-7, WSM-2).
 *
 * Ульта здесь — настоящая JSON-система сцены с cooldown'ом и гейтом, а не вызов
 * `pause()/beginRewind()` из теста: предмет проверки в том и состоит, что
 * политика живёт в контенте, а механизм — у хоста (WSM-5). Балансных чисел в
 * сетевом слое при этом нет ни одного: глубина приезжает в payload события.
 */
import { describe, expect, it } from 'vitest';
import { fixed, type GameEvent, type SceneDef } from '@game-mvp/core';
import { MatchClient, type InputSample } from '../src/client/matchClient.js';
import { contentPack } from '../src/content/pack.js';
import { REWIND_REQUEST_EVENT, firstRewindRequest } from '../src/match/rewindRequest.js';
import type { ClientMessage } from '../src/protocol/messages.js';
import type { MatchConfig, MatchRewindOptions } from '../src/server/matchServer.js';
import { duelConfig, duelScene, harness, hello, inputMessageOf, wireInput } from './fixtures.js';

/** Бит ульты в `buttons` — раскладка СБОРКИ игры, сетевому слою не известная. */
const ULT_BUTTON = 7;
/** Глубина автостопа из payload запроса: политика контента (REW-1 — ориентир 420). */
const DEPTH_TICKS = 24;
const COOLDOWN_TICKS = 600;
const SNAPSHOT_EVERY = 2;

const e = { var: 'e' } as const;
const field = (component: string, name: string): object => ({ getComponent: [e, component, name] });

/**
 * Сцена дуэли плюс ульта отката: cooldown в собственном компоненте (он же —
 * exempt-компонент матча), гейт по фронту кнопки и по нулю cooldown'а, эмиссия
 * запроса с глубиной. Ровно та форма, которой пользуется демо.
 */
function ultScene(
  gated = true,
  depthTicks: number = DEPTH_TICKS,
  initiator: object | number = e,
): SceneDef {
  const scene = duelScene();
  const hero = scene.prefabs![0]!;
  const cast = {
    name: 'RewindCast',
    order: 40,
    query: { all: ['Input', 'Player', 'RewindCooldown'] },
    as: 'e',
    do: [
      {
        if: {
          cond: gated
            ? {
                and: [
                  { bitTest: [field('Input', 'buttons'), ULT_BUTTON] },
                  { '!': [{ bitTest: [field('Input', 'prevButtons'), ULT_BUTTON] }] },
                  { '==': [field('RewindCooldown', 'ticks'), 0] },
                ],
              }
            : true,
          then: [
            {
              modifyComponent: {
                entity: e,
                component: 'RewindCooldown',
                values: { ticks: field('RewindCooldown', 'max') },
              },
            },
            {
              emitEvent: {
                type: REWIND_REQUEST_EVENT,
                data: { initiator, depthTicks },
              },
            },
          ],
        },
      },
    ],
  };
  const cooldown = {
    name: 'RewindCooldownTick',
    order: 5,
    query: { all: ['RewindCooldown'] },
    as: 'e',
    do: [
      {
        if: {
          cond: { '>': [field('RewindCooldown', 'ticks'), 0] },
          then: [
            {
              modifyComponent: {
                entity: e,
                component: 'RewindCooldown',
                values: { ticks: { '-': [field('RewindCooldown', 'ticks'), 1] } },
              },
            },
          ],
        },
      },
    ],
  };

  return {
    ...scene,
    components: [
      ...scene.components,
      { name: 'RewindCooldown', fields: { max: 'i32', ticks: 'i32' } },
    ],
    prefabs: [
      {
        ...hero,
        components: { ...hero.components, RewindCooldown: { max: COOLDOWN_TICKS, ticks: 0 } },
      },
    ],
    systems: [...(scene.systems ?? []), cooldown, cast],
  };
}

function ultConfig(
  rewind: Partial<MatchRewindOptions> = {},
  gated = true,
  depthTicks: number = DEPTH_TICKS,
  initiator: object | number = e,
): MatchConfig {
  return duelConfig({
    scene: ultScene(gated, depthTicks, initiator),
    rewind: {
      interval: 5,
      capacity: 40,
      exempt: [{ component: 'RewindCooldown' }],
      holdButton: ULT_BUTTON,
      step: 3,
      holdTimeoutTicks: 8,
      ...rewind,
    },
  });
}

/**
 * Матч двух игроков без транспорта (NTR-3): ввод подаётся сообщениями прямо
 * серверу, темп двигает тест. Кадр адресуется тику `tick + inputDelay` — так же,
 * как его размечает клиент по присланному расписанию (NTR-7).
 */
function ultMatch(config: MatchConfig = ultConfig()) {
  const { server } = harness(config);
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  server.drain();
  let seq = 0;

  const send = (connection: number, buttons: number): void => {
    seq++;
    server.receive(
      connection,
      inputMessageOf(server.epoch, wireInput(server.tick + 2, seq, 0, 0, buttons)),
    );
  };

  /** Тиков расписания с вводом инициатора: `buttons` едет каждый тик. */
  const run = (ticks: number, buttons = 0, connection = 1): void => {
    for (let i = 0; i < ticks; i++) {
      send(connection, buttons);
      server.advance();
      server.drain();
    }
  };

  /** Удержание до возобновления мира: скраб кончается сам — автостопом. */
  const holdUntilResume = (buttons: number, maxTicks = 400): number => {
    let ticks = 0;
    while (server.mode !== 'Running' && ticks < maxTicks) {
      send(1, buttons);
      server.advance();
      server.drain();
      ticks++;
    }
    return ticks;
  };

  return { server, config, send, run, holdUntilResume };
}

const ULT = 1 << ULT_BUTTON;

describe('дренаж запроса перемотки сервером (NET-11, WSM-2)', () => {
  it('ульта из JSON-системы уводит мир в Rewinding через Paused', () => {
    const m = ultMatch();
    m.run(10);
    expect(m.server.mode).toBe('Running');

    // Кадр с битом ульты доезжает через `inputDelay`; тик, на котором система
    // эмитит запрос, — обычный живой тик.
    m.send(1, ULT);
    m.run(2);

    expect(m.server.mode).toBe('Rewinding');
    // Мир внутри тика не изменён событием: номер тика тот же, каким его
    // оставил последний живой тик.
    expect(m.server.tick).toBe(12);
  });

  it('матч без истории запрос игнорирует: перематывать нечем', () => {
    const config = duelConfig({ scene: ultScene() });
    const m = ultMatch(config);
    m.send(1, ULT);
    m.run(4);

    expect(m.server.mode).toBe('Running');
  });

  it('запрос вне Running не исполняется: перемотки в перемотке нет (REW-8)', () => {
    // Гейта у системы нет — запрос эмитится КАЖДЫЙ тик. Второго входа в
    // перемотку он не даёт: вне `Running` живых тиков нет, и дренировать нечего.
    const m = ultMatch(ultConfig({}, false));
    expect(() => { m.run(1); }).not.toThrow();
    expect(m.server.mode).toBe('Rewinding');

    // Скраб идёт своим чередом, а живой тик после каждого возобновления снова
    // просит перемотку — и снова получает её из `Running`, а не из `Rewinding`:
    // второго входа машина состояний не видит ни разу.
    expect(() => { m.run(20, ULT); }).not.toThrow();
  });

  it('запрос, поданный в остановленном мире, до машины состояний не доходит', () => {
    const m = ultMatch(ultConfig({}, false));
    m.run(1);
    m.server.pause();
    expect(m.server.mode).toBe('Paused');

    // Пауза мимо драйвера: ведение точки прекращается, а живых тиков, из
    // которых дренируется запрос, в `Paused` не бывает.
    expect(() => { m.run(10, ULT); }).not.toThrow();
    expect(m.server.mode).toBe('Paused');
  });
});

describe('драйвер скраба: удержание, отпускание, автостоп (REW-5, REW-7)', () => {
  it('точка перемотки идёт назад по шагу за цикл рассылки, пока бит удержан', () => {
    const m = ultMatch();
    m.run(20);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;
    expect(m.server.mode).toBe('Rewinding');

    // Два цикла рассылки удержания — два шага по три тика.
    m.run(2 * SNAPSHOT_EVERY, ULT);

    expect(m.server.tick).toBe(castTick - 6);
    expect(m.server.mode).toBe('Rewinding');
  });

  it('отпускание возобновляет мир с достигнутой точки (WSM-2)', () => {
    const m = ultMatch();
    m.run(20);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;
    m.run(2 * SNAPSHOT_EVERY, ULT);
    const stopped = m.server.tick;

    // Бит исчез в свежем кадре инициатора — это и есть отпускание.
    m.run(SNAPSHOT_EVERY, 0);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(stopped);
    expect(stopped).toBe(castTick - 6);
    // Перемотка наблюдаема сменой эпохи (NTR-16): номер тика пошёл вспять, и
    // эпоха растёт на КАЖДОМ таком восстановлении, а не один раз за перемотку.
    expect(m.server.epoch).toBe(2);
  });

  it('на глубине из запроса мир возобновляется сам, не дожидаясь отпускания', () => {
    const m = ultMatch();
    m.run(40);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;

    // Держим, пока сервер не остановится сам: 24 тика по 3 за цикл.
    m.holdUntilResume(ULT);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick - DEPTH_TICKS);
  });

  it('глубже фактической истории точка не уходит (SNAP-6)', () => {
    // Буфер мельче глубины запроса: пять снапшотов по интервалу 5 — 20 тиков.
    const m = ultMatch(ultConfig({ interval: 5, capacity: 5 }));
    m.run(40);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;

    m.holdUntilResume(ULT);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBeGreaterThan(castTick - DEPTH_TICKS);
    // Точка стоит на самом старом снапшоте буфера (тик 20 из пяти по интервалу
    // 5), а не на глубине запроса: глубже истории отматывать не от чего.
    expect(m.server.tick).toBe(20);
  });

  it('молчание инициатора равно отпусканию: дисконнект не вешает мир', () => {
    const m = ultMatch();
    m.run(20);
    m.send(1, ULT);
    m.run(2);

    // Инициатор пропал — кадров больше нет вовсе. Порог молчания в тиках
    // обязан вернуть мир в `Running` сам.
    for (let i = 0; i < 20; i++) {
      m.server.advance();
      m.server.drain();
    }

    expect(m.server.mode).toBe('Running');
  });

  it('чужой клиент скрабом не управляет: сервер читает только инициатора', () => {
    const m = ultMatch();
    m.run(20);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;

    // Инициатор отпустил, а второй игрок держит: сервер его бит не читает.
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      m.send(1, 0);
      m.send(2, ULT);
      m.server.advance();
      m.server.drain();
    }

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick);
  });
});

/** Событие-запрос с произвольным payload — то, что вправе прислать контент. */
function requestEvent(data: Readonly<Record<string, number>>): GameEvent[] {
  return [{ type: REWIND_REQUEST_EVENT, data }];
}

describe('испорченный запрос перемотки матч не роняет (REW-12)', () => {
  it('дробная глубина: запрос отброшен с диагностикой, тик идёт дальше', () => {
    const warnings: string[] = [];
    const request = firstRewindRequest(requestEvent({ initiator: 3, depthTicks: 4.8 }), (m) => {
      warnings.push(m);
    });

    expect(request).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('depthTicks');
  });

  it('отрицательная глубина — тот же исход', () => {
    const warnings: string[] = [];
    expect(
      firstRewindRequest(requestEvent({ initiator: 3, depthTicks: -1 }), (m) => { warnings.push(m); }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('payload без обязательных полей — тот же исход', () => {
    const warnings: string[] = [];
    expect(firstRewindRequest(requestEvent({}), (m) => { warnings.push(m); })).toBeUndefined();
    expect(
      firstRewindRequest(requestEvent({ initiator: 3 }), (m) => { warnings.push(m); }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('годный запрос за испорченным всё-таки исполняется', () => {
    const events: GameEvent[] = [
      ...requestEvent({ initiator: 3, depthTicks: 4.8 }),
      ...requestEvent({ initiator: 5, depthTicks: 12 }),
    ];

    expect(firstRewindRequest(events, () => undefined)).toEqual({ initiator: 5, depthTicks: 12 });
  });

  it('дробная глубина из JSON-системы не убивает цикл матча', () => {
    // Ровно тот путь, которым дефект приезжает в жизни: выражение DSL, давшее
    // дробное число. `advance()` обязан пройти, а мир — остаться в `Running`.
    const m = ultMatch(ultConfig({}, true, 24.5));
    m.run(10);
    m.send(1, ULT);
    expect(() => { m.run(4); }).not.toThrow();

    expect(m.server.mode).toBe('Running');
  });
});

describe('орган ведения скраба в конфиге матча (NET-11)', () => {
  it('номер бита вне 0..31 отвергается на сборке матча', () => {
    expect(() => harness(ultConfig({ holdButton: 32 }))).toThrow(/holdButton/);
    expect(() => harness(ultConfig({ holdButton: -1 }))).toThrow(/holdButton/);
    expect(() => harness(ultConfig({ holdButton: 1.5 }))).toThrow(/holdButton/);
  });

  it('удержание читается по самому свежему seq, а не по номеру тика', () => {
    // Номер тика клиент пересинхронизирует по каждому восстановлению (NTR-10) и
    // во время скраба УМЕНЬШАЕТ: пачка, в которой отпускание помечено меньшим
    // тиком, но большим `seq`, обязана читаться как отпускание.
    const m = ultMatch();
    m.run(20);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;
    expect(m.server.mode).toBe('Rewinding');

    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      m.server.receive(
        1,
        inputMessageOf(
          m.server.epoch,
          // Старший `seq` — на кадре с МЕНЬШИМ номером тика: свежесть меряется
          // счётчиком отправителя.
          wireInput(m.server.tick + 2, 900 + i * 2, 0, 0, ULT),
          wireInput(m.server.tick, 901 + i * 2, 0, 0, 0),
        ),
      );
      m.server.advance();
      m.server.drain();
    }

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick);
  });

  it('инициатор без слота матча не морозит мир на порог молчания', () => {
    // Контент назвал инициатором сущность, которой в мире нет: `slotOf` вернул
    // -1, и органа управления у этой перемотки не будет НИКОГДА. Ждать порог
    // молчания (здесь — целую секунду) незачем: мир возобновляется первым же
    // шагом драйвера.
    const m = ultMatch(ultConfig({ holdTimeoutTicks: 60 }, true, DEPTH_TICKS, 9999));
    m.run(20);
    m.send(1, ULT);
    m.run(2);
    expect(m.server.mode).toBe('Rewinding');
    const frozenAt = m.server.tick;

    m.run(1, ULT);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(frozenAt);
  });
});

describe('ввод замороженного мира маскируется на клиенте (NET-11, REW-5)', () => {
  const CAST_BUTTON = 1 << 0;

  /** Клиент и сервер без транспорта: сообщения переносит тест (NTR-3, NTR-12). */
  function clientRig(config: MatchConfig = ultConfig()) {
    const { server } = harness(config);
    const pack = contentPack({ [config.sceneRef]: config.scene });
    const client = new MatchClient({
      playerId: 'p1',
      version: config.version,
      content: pack,
      // Тот же номер, которым настроен сервер: раскладку битов знает сборка.
      holdButton: ULT_BUTTON,
    });
    client.start();
    client.drain();

    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));

    const deliver = (): void => {
      for (const out of server.drain()) {
        if (out.to === 1) client.receive(out.message, 0);
      }
    };
    deliver();

    const sent: ClientMessage[] = [];
    const step = (sample: InputSample): void => {
      client.advance();
      client.pushInput(sample, 0);
      for (const message of client.drain()) {
        sent.push(message);
        server.receive(1, message);
      }
      server.advance();
      deliver();
    };

    return { server, client, step, sent };
  }

  const move: InputSample['move'] = { x: fixed.fromInt(1), y: 0 };

  it('во время Rewinding уезжает только бит ведения скраба', () => {
    const rig = clientRig();
    for (let i = 0; i < 10; i++) rig.step({ move, aimDir: 0, buttons: 0 });
    // Каст ульты — обычный кадр идущего мира.
    rig.step({ move, aimDir: 0, buttons: 1 << ULT_BUTTON });
    for (let i = 0; i < 4; i++) rig.step({ move, aimDir: 0, buttons: 1 << ULT_BUTTON });
    expect(rig.client.mode).not.toBe('Running');

    const before = rig.sent.length;
    // Игрок смотрит на замороженный мир и жмёт всё подряд.
    rig.step({ move, aimDir: 0, buttons: CAST_BUTTON | (1 << ULT_BUTTON) });
    const frames = rig.sent.slice(before).flatMap((message) =>
      message.type === 'Input' ? message.frames : [],
    );

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.buttons).toBe(1 << ULT_BUTTON);
      expect(frame.moveX).toBe(0);
      expect(frame.moveY).toBe(0);
    }
  });

  it('в Running кадр уезжает как есть: маска — правило замороженного мира', () => {
    const rig = clientRig();
    for (let i = 0; i < 6; i++) rig.step({ move, aimDir: 0, buttons: 0 });
    const before = rig.sent.length;
    rig.step({ move, aimDir: 0, buttons: CAST_BUTTON });
    const frames = rig.sent.slice(before).flatMap((message) =>
      message.type === 'Input' ? message.frames : [],
    );

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.buttons).toBe(CAST_BUTTON);
    expect(frames[0]!.moveX).toBe(fixed.fromInt(1));
  });
});

describe('cooldown ульты переживает откат (REW-9)', () => {
  it('вторая ульта во время cooldown гейтится контентом', () => {
    const m = ultMatch();
    m.run(40);
    m.send(1, ULT);
    m.run(2);
    const castTick = m.server.tick;
    // Полный откат до автостопа и возобновление.
    m.holdUntilResume(ULT);
    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick - DEPTH_TICKS);

    // Кнопка нажата заново в возобновлённом мире: cooldown не откатился вместе
    // с миром (exempt-компонент), и гейт системы вторую перемотку не пускает.
    m.run(2, 0);
    m.send(1, ULT);
    m.run(4);

    expect(m.server.mode).toBe('Running');
  });
});
