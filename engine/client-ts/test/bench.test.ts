/**
 * Замеры канала (design Risks, задача 4.5). Не микробенчмарк-сьют, а
 * сторожевые числа: печатаются при каждом прогоне, ассерты — только против
 * деградации на порядок. Полный «нажал→увидел» меряется браузерным стендом
 * (открытый вопрос № 2 обзора); здесь — структурные затраты оболочки.
 *
 * Ассерт идёт не по миллисекундам, а по ЭТАЛОННЫМ ЕДИНИЦАМ работы
 * (`engine/tests/bench/calibration.ts`): жёсткий порог wall-time в гейте
 * MUST NOT использоваться (`performance-budget` PERF-5) — он функция скорости
 * машины, а не стоимости кода, и на машине вдвое медленнее краснеет, ничего не
 * поймав. Калибровка меряет в том же процессе фиксированную синтетическую
 * нагрузку, и порог выражен её кратным: машина в отношении сокращается,
 * подорожание операции — нет.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ViewBuffer, type ExtractedTick } from '@fluxus/render';
import { readTick, requiredBytes, shellPort, writeTick, type TickEnvelope } from '../src/index.js';
import { benchUnits, calibrationLine } from '../../tests/bench/calibration.js';
import { growthOf, mib, sampleMemory } from '../../tests/bench/memory.js';

/** Синтетический тик на N сущностей — целевая сцена больше реальной. */
function syntheticTick(count: number, base = 0): ExtractedTick {
  const ext: ExtractedTick = {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: true,
    count,
    id: new Float64Array(count),
    kind: new Int32Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    level: new Uint8Array(count),
    flags: new Uint8Array(count),
    facingYaw: new Float32Array(count),
    aimYaw: new Float32Array(count),
    motion: new Uint8Array(count),
    motionPhase: new Float32Array(count),
    flightPhase: new Float32Array(count),
    timeScale: new Float32Array(count).fill(1),
    statNames: [],
    statCount: new Uint8Array(count),
    statIndex: new Int32Array(0),
    statValue: new Float64Array(0),
    statPairs: 0,
    events: [],
    floorDelta: [],
    kindTable: ['Hero'],
  };
  for (let i = 0; i < count; i++) {
    // Идентификатор поколенческий (ID-1); `base` сдвигает НАБОР целиком — так
    // сторож оборота (PERF-10) гоняет доставки со сменяющимся составом.
    ext.id[i] = (base + i) * 16777216 + i;
    ext.kind[i] = 0;
    ext.x[i] = (i % 24) + 0.5;
    ext.y[i] = ((i / 24) | 0) + 0.5;
    ext.flags[i] = 1;
    ext.facingYaw[i] = 1.5;
    ext.aimYaw[i] = Number.NaN;
  }
  return ext;
}

describe('замеры канала (информативно)', () => {
  beforeAll(() => {
    // Печать при каждом прогоне (PERF-5): по этой строке читаются остальные —
    // замеры печатаются и в миллисекундах, и в эталонных единицах машины.
    console.log(calibrationLine());
  });

  it('кодек: сериализация+чтение+apply 500 сущностей — доли миллисекунды', () => {
    const ENTITIES = 500;
    const TICKS = 1000;
    const ext = syntheticTick(ENTITIES);
    const buffer = new ArrayBuffer(requiredBytes(ENTITIES, 0));
    const view = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });

    // Прогрев JIT перед замером.
    for (let i = 0; i < 50; i++) {
      writeTick(buffer, ext);
      view.apply(readTick(buffer, ext.events, ext.kindTable));
    }
    const t0 = performance.now();
    for (let i = 0; i < TICKS; i++) {
      ext.tick = i + 1;
      writeTick(buffer, ext);
      view.apply(readTick(buffer, ext.events, ext.kindTable));
    }
    const perTickMs = (performance.now() - t0) / TICKS;

    const perTickUnits = benchUnits(perTickMs);
    console.log(
      `[bench] кодек+apply, ${ENTITIES} сущностей: ${(perTickMs * 1000).toFixed(1)} мкс/тик ` +
        `(${perTickUnits.toFixed(3)} эталонной единицы), буфер ${requiredBytes(ENTITIES, 0)} байт`,
    );
    expect(view.view.entities.size).toBe(ENTITIES);
    // Сторожевой порог: наблюдаемое — 0.1 эталонной единицы на тик (под чужой
    // нагрузкой на машине — до 0.3: замер длиннее калибровки и ловит
    // планировщика), порог на порядок выше. Ловит подорожание кодека, а не
    // медленную машину (PERF-5).
    expect(perTickUnits).toBeLessThan(1);
  });

  it('MessageChannel: round-trip конверта (доставка + ack) — единицы миллисекунд max', async () => {
    const ENTITIES = 500;
    const ROUNDS = 300;
    const ext = syntheticTick(ENTITIES);
    const channel = new MessageChannel();
    const samples: number[] = [];

    // Пир: вернуть буфер немедленно (как RemoteHost после apply).
    const peer = shellPort(channel.port2);
    peer.onMessage((message) => {
      const envelope = message as TickEnvelope;
      peer.post({ t: 'ret', buffer: envelope.buffer }, [envelope.buffer]);
    });

    let resolveRound: (() => void) | null = null;
    let started = 0;
    shellPort(channel.port1).onMessage(() => {
      samples.push(performance.now() - started);
      resolveRound?.();
    });

    for (let i = 0; i < ROUNDS; i++) {
      const buffer = new ArrayBuffer(requiredBytes(ENTITIES, 0));
      writeTick(buffer, ext);
      const envelope: TickEnvelope = { t: 'tick', buffer, events: [], kinds: [], expiredEvents: 0 };
      started = performance.now();
      const done = new Promise<void>((resolve) => {
        resolveRound = resolve;
      });
      channel.port1.postMessage(envelope, [buffer]);
      await done;
    }
    channel.port1.close();
    channel.port2.close();

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    const p50Units = benchUnits(p50);
    console.log(
      `[bench] round-trip конверта, ${ENTITIES} сущностей: p50 ${p50.toFixed(3)} мс ` +
        `(${p50Units.toFixed(4)} эталонной единицы), p99 ${p99.toFixed(3)} мс (${ROUNDS} раундов)`,
    );
    // Наблюдаемое — 0.008…0.014 эталонной единицы на раунд, порог на порядок
    // выше. Сторожат здесь МЕДИАНУ, а не хвост: p50 через очередь событий
    // устойчив и под нагрузкой (проверено — те же 0.016 мс), а p99 меряет
    // планировщик машины и порогом быть не может ни в каком выражении (PERF-5).
    expect(p50Units).toBeLessThan(0.15);
  });
});

/**
 * Сторож кучи на обороте приёма доставки (`performance-budget` PERF-10). Точные
 * величины состояния приёмника стережёт инвариант PERF-9 (`turnover.test.ts`);
 * здесь меряется то, чего он не видит по построению: удержание замыканиями и
 * слушателями, объекты кодека, внутренности среды.
 *
 * Конвенции те же, что у замеров выше и у сторожей ядра: прогрев до первой
 * точки, минимум из нескольких проб с полной сборкой перед каждой, печать при
 * КАЖДОМ прогоне, ассерт только о РОСТЕ между точками, отнесённом к занятому в
 * первой. Уровень кучи не ассертится ни в каком виде: он функция версии среды,
 * а не кода (PERF-10).
 */
describe('PERF-10: оборот доставки не растит кучу', () => {
  /** Сущностей в доставке и доставок в каждой половине окна. */
  const TURNOVER_ENTITIES = 500;
  const TURNOVER_ROUNDS = 300;
  /**
   * Запас порога: наблюдаемое — доли процента (оборот кучу не растит вовсе, весь
   * рост — дрожание сборщика и прогрев JIT). Порог на порядок выше наблюдаемого
   * и много ниже «роста порядка занятого объёма», который PERF-10 обязан ловить.
   */
  const MAX_GROWTH_RATIO = 0.25;

  it('куча между точками A и B не растёт: записи исчезнувших сущностей возвращаются', () => {
    const view = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const buffer = new ArrayBuffer(requiredBytes(TURNOVER_ENTITIES, 0));
    const half = (from: number): void => {
      for (let round = from; round < from + TURNOVER_ROUNDS; round++) {
        // Каждый раунд — НОВЫЙ набор идентификаторов: приёмник обязан снять
        // записи исчезнувших, а не копить их поколениями.
        const ext = syntheticTick(TURNOVER_ENTITIES, round * TURNOVER_ENTITIES);
        ext.tick = round + 1;
        writeTick(buffer, ext);
        view.apply(readTick(buffer, ext.events, ext.kindTable));
      }
    };

    half(0);
    const a = sampleMemory();
    half(TURNOVER_ROUNDS);
    const b = sampleMemory();
    const growth = growthOf(a, b);

    console.log(
      `[bench] куча, оборот доставки (${TURNOVER_ENTITIES} сущностей ×${TURNOVER_ROUNDS}): ` +
        `${mib(a.heapUsed)} → ${mib(b.heapUsed)} (рост ${(growth.ratio * 100).toFixed(1)} %, ` +
        `буферы ${mib(a.arrayBuffers)} → ${mib(b.arrayBuffers)})`,
    );
    expect(view.view.entities.size).toBe(TURNOVER_ENTITIES);
    expect(growth.ratio).toBeLessThan(MAX_GROWTH_RATIO);
  });
});
