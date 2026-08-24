/**
 * Замеры канала (design Risks, задача 4.5). Не микробенчмарк-сьют, а
 * сторожевые числа: печатаются при каждом прогоне, ассерты — только против
 * деградации на порядок. Полный «нажал→увидел» меряется браузерным стендом
 * (открытый вопрос № 2 обзора); здесь — структурные затраты оболочки.
 */
import { describe, expect, it } from 'vitest';
import { ViewBuffer, type ExtractedTick } from '@fluxus/render';
import { readTick, requiredBytes, shellPort, writeTick, type TickEnvelope } from '../src/index.js';

/** Синтетический тик на N сущностей — целевая сцена больше реальной. */
function syntheticTick(count: number): ExtractedTick {
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
    ext.id[i] = i * 16777216 + i;
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

    console.log(
      `[bench] кодек+apply, ${ENTITIES} сущностей: ${(perTickMs * 1000).toFixed(1)} мкс/тик, ` +
        `буфер ${requiredBytes(ENTITIES, 0)} байт`,
    );
    expect(view.view.entities.size).toBe(ENTITIES);
    // Сторожевой порог: на порядок выше ожидаемого, ловит только деградацию.
    expect(perTickMs).toBeLessThan(5);
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
    console.log(
      `[bench] round-trip конверта, ${ENTITIES} сущностей: p50 ${p50.toFixed(3)} мс, ` +
        `p99 ${p99.toFixed(3)} мс (${ROUNDS} раундов)`,
    );
    expect(p50).toBeLessThan(5);
  });
});
