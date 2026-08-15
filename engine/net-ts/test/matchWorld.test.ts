/**
 * Сборка мира матча (NTR-5) и прогон сегментированной записи (NTR-16) — их
 * отказы.
 *
 * Конфиг матча (`content/matches/*.match.json`) — документ недоверенный, и его
 * расстановка описана тем же SER-8, что расстановка сцены и сценария. До
 * перехода на общий `buildSimulation` ядра сетевой слой разбирал её собственным
 * сырым циклом `worldInitSpawn`, мимо проверок SER-8: битый список падал чем
 * придётся — «неизвестный prefab "undefined"», TypeError на не-объекте, «не
 * итерируемо» на не-списке, — и в какой из десяти записей ошибка, автор конфига
 * из сообщения не узнавал. Проверки ниже фиксируют, что второго разбора
 * расстановки больше нет и отказ называет запись.
 */
import { describe, expect, it } from 'vitest';
import { query, world as coreWorld, type SceneDef } from '@game-mvp/core';
import { buildMatchWorld } from '../src/match/world.js';
import { replaySegments } from '../src/match/replay.js';
import { duelConfig, duelScene, placedScene } from './fixtures.js';

/**
 * Сцена с собственной расстановкой и prefab'ом реквизита: она занимает первые
 * ID, участники матча встают за ней (SER-8). Хеш `worldInit` ниже посчитан на
 * ней же.
 */
function hashScene(): SceneDef {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [
      { name: 'Hero', components: { Player: { slot: 0 }, Position: { x: 0, y: 0 } } },
      { name: 'Prop', components: { Position: { x: 0, y: 0 } } },
    ],
    initial: [{ prefab: 'Prop', overrides: { Position: { x: 131072, y: 0 } } }],
    capacity: 8,
  };
}

/**
 * Значение посчитано ПРЕЖНИМ прологом `buildMatchWorld` (сырой цикл
 * `worldInitSpawn`) до перехода на `buildSimulation` и вписано сюда литералом.
 * Смысл именно в литерале: сверка с новой сборкой рядом сравнивала бы функцию с
 * собой, а хеш `worldInit` — то, по чему клиент и сервер решают, пускать ли в
 * матч (DET-1, NTR-5). Его изменение обязано быть решением, а не побочным
 * эффектом рефакторинга.
 */
const WORLD_INIT_HASH_BEFORE = '017aea91';

describe('расстановка конфига матча проверяется по SER-8', () => {
  it('честный конфиг собирается в тот же worldInit, что и до перехода на общую сборку', () => {
    const built = buildMatchWorld({
      scene: hashScene(),
      seed: 7,
      players: ['p1', 'p2'],
      initial: [
        { prefab: 'Hero', overrides: { Player: { slot: 0 } } },
        { prefab: 'Hero', overrides: { Player: { slot: 1 }, Position: { x: 196608, y: 0 } } },
      ],
    });
    expect(built.worldInitHash).toBe(WORLD_INIT_HASH_BEFORE);
    // Реквизит сцены плюс два героя матча — порядок «сцена → матч» (SER-8).
    expect(coreWorld.listAlive(built.state.world)).toHaveLength(3);
  });

  it('запись с нестроковым "prefab" — отказ с номером записи, а не половина расстановки', () => {
    const initial = [{ prefab: 'Hero' }, { prefab: 42 as unknown as string }];
    expect(() =>
      buildMatchWorld({ scene: hashScene(), seed: 7, players: ['p1'], initial }),
    ).toThrow(/конфиг матча: расстановка, запись #1: "prefab" — непустая строка \(SER-8\)/);
  });

  it('запись-не-объект и пустой "prefab" отвергаются там же', () => {
    const build = (initial: readonly { prefab: string }[]): void => {
      buildMatchWorld({ scene: hashScene(), seed: 7, players: ['p1'], initial });
    };
    expect(() => { build([null as unknown as { prefab: string }]); }).toThrow(
      /конфиг матча: расстановка, запись #0: запись — объект \(SER-8\)/,
    );
    expect(() => { build([{ prefab: '' }]); }).toThrow(
      /конфиг матча: расстановка, запись #0: "prefab" — непустая строка \(SER-8\)/,
    );
  });

  it('расстановка-не-список отвергается как формат, а не падает «не итерируемо»', () => {
    expect(() =>
      buildMatchWorld({
        scene: hashScene(),
        seed: 7,
        players: ['p1'],
        initial: { prefab: 'Hero' } as unknown as readonly { prefab: string }[],
      }),
    ).toThrow(/конфиг матча: расстановка — список записей \(SER-8\)/);
  });

  it('неизвестный prefab называет и номер записи, и само имя', () => {
    expect(() =>
      buildMatchWorld({
        scene: hashScene(),
        seed: 7,
        players: ['p1'],
        initial: [{ prefab: 'Hero' }, { prefab: 'Villain' }],
      }),
    ).toThrow(/конфиг матча: расстановка, запись #1 \("Villain"\)/);
  });

  it('расстановка сцены применяется первой и не замещается расстановкой матча', () => {
    // Та же проверка порядка, что держит golden `match-props` (NTR-8): реквизит
    // сцены — первые ID, герои матча за ним.
    const built = buildMatchWorld({
      scene: placedScene(),
      seed: 99,
      players: ['p1', 'p2'],
      initial: duelConfig().initial!,
    });
    const props = query(built.state.world, { all: ['Position'], not: ['Player'] });
    expect([...props]).toHaveLength(2);
    const heroes = query(built.state.world, { all: ['Player'] });
    expect([...heroes]).toHaveLength(2);
    // Реквизит сцены встал ПЕРЕД героями матча: порядок задаёт выданные ID
    // (ID-2, DET-6), и он же входит в хеш `worldInit` (DET-1, NTR-5).
    expect(Math.max(...props)).toBeLessThan(Math.min(...heroes));
  });

  it('матч без расстановки законен — отсутствующий список неотличим от пустого', () => {
    const built = buildMatchWorld({ scene: duelScene(), seed: 1, players: ['p1'] });
    expect(coreWorld.listAlive(built.state.world)).toHaveLength(0);
  });
});

describe('сломанный канонический лог отвергается (NTR-16)', () => {
  const config = duelConfig();
  const worldDef = {
    scene: config.scene,
    seed: config.seed,
    players: config.players,
    initial: config.initial!,
  };
  const frames = (tick: number): { tick: number; playerId: string; seq: number; move: { x: number; y: number }; aimDir: number; buttons: number }[] =>
    config.players.map((playerId) => ({
      tick,
      playerId,
      seq: 0,
      move: { x: 0, y: 0 },
      aimDir: 0,
      buttons: 0,
    }));

  it('сегмент без единого кадра — сломанный лог, а не законная эпоха', () => {
    // Эпоха, в которой не исполнено ни одного тика, сегмента не порождает
    // вовсе; пустой сегмент в записи означает, что писал его не сервер.
    expect(() =>
      replaySegments({ ...worldDef, segments: [{ epoch: 0, frames: [] }] }),
    ).toThrow(/сегмент эпохи 0 без единого кадра \(NTR-16\)/);
  });

  it('сегмент с дыркой внутри — не сплошной по тикам', () => {
    // Тики 1, 2, 4: сегмент покрывает исполненные тики подряд (NTR-16), и
    // пропуск внутри него не отличим от потерянного кадра.
    expect(() =>
      replaySegments({
        ...worldDef,
        segments: [{ epoch: 0, frames: [...frames(1), ...frames(2), ...frames(4)] }],
      }),
    ).toThrow(/сегмент эпохи 0 не сплошной по тикам \(NTR-16\)/);
  });

  it('сегмент, начинающийся впереди переигранного префикса, называет обе границы', () => {
    // Кадры с номером тика 0. Тик 0 — это `worldInit`, состояние ДО первого
    // `tick()`, и исполненным он не бывает: переигрывать перед таким сегментом
    // нечего, а мир на нужный тик так и не встаёт. Отказ по смыслу отличен от
    // «тик не покрыт»: дырки в префиксе нет, префикса нет вовсе.
    expect(() =>
      replaySegments({ ...worldDef, segments: [{ epoch: 0, frames: frames(0) }] }),
    ).toThrow(/сегмент эпохи 0 начинается с тика 0, а предыдущие сегменты доходят только до 0 \(NTR-16\)/);
  });
});
