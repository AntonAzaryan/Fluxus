/**
 * Кодек плоского буфера (SHELL-3): roundtrip писатель → читатель в одном
 * потоке против прямого вызова — рассинхрон раскладки ловится здесь, а не
 * в воркере. Плюс переопределения заголовка (аккумулированные флаги и дельта
 * пола, SHELL-4) и защита версии раскладки.
 */
import { describe, expect, it } from 'vitest';
import { tick } from '@game-mvp/core';
import { ViewBuffer } from '@game-mvp/render';
import { CODEC_VERSION, readTick, requiredBytes, writeTick } from '../src/index.js';
import { PLAYER_ID, STEP, TICK_SECONDS, makeExtractor, makeRig, snapshotView } from './fixtures.js';

function inputFrame(tickNumber: number, seq: number) {
  return {
    tick: tickNumber,
    playerId: PLAYER_ID,
    seq,
    move: { x: STEP, y: 0 },
    aimDir: 0,
    buttons: 0,
  };
}

describe('кодек: roundtrip эквивалентен прямому вызову (SHELL-3)', () => {
  it('декодированный тик даёт тот же TickView, что и прямой', () => {
    const rig = makeRig({ castOnTicks: [2], breakFloorOnTick: 3 });
    const extractor = makeExtractor(rig);
    const grid = rig.scene.terrain!.grid;
    const direct = new ViewBuffer({
      tickSeconds: TICK_SECONDS,
      floorBits: new Uint8Array(grid.floor),
      clock: () => 0,
    });
    const decoded = new ViewBuffer({
      tickSeconds: TICK_SECONDS,
      floorBits: new Uint8Array(grid.floor),
      clock: () => 0,
    });

    for (let step = 1; step <= 5; step++) {
      const result = tick(rig.sim, rig.state, [inputFrame(rig.state.tick + 1, step)]);
      const ext = extractor.extract(result);

      const buffer = new ArrayBuffer(requiredBytes(ext.count, ext.floorDelta.length >>> 1));
      writeTick(buffer, ext);
      const wire = readTick(buffer, ext.events, ext.kindTable);

      direct.apply(ext);
      decoded.apply(wire);
      expect(snapshotView(decoded.view)).toEqual(snapshotView(direct.view));
    }
    // Сценарий не был пустым: герой двигался, каст пойман, пол выбит.
    expect(direct.view.entities.size).toBe(1);
    expect(direct.view.floorBits![0]).toBe(0);
  });

  it('переопределения при записи: аккумулированные флаги и дельта пола (SHELL-4)', () => {
    const rig = makeRig();
    const extractor = makeExtractor(rig);
    const ext = extractor.extract(tick(rig.sim, rig.state));

    const floorDelta = [0, 0, 3, 0];
    const buffer = new ArrayBuffer(requiredBytes(ext.count, 2));
    writeTick(buffer, ext, { snapAll: true, freshEvents: false, floorDelta });
    const wire = readTick(buffer, [], []);

    expect(wire.snapAll).toBe(true);
    expect(wire.freshEvents).toBe(false);
    expect([...(wire.floorDelta as Uint32Array)]).toEqual(floorDelta);
    expect(wire.tick).toBe(ext.tick);
    expect(wire.count).toBe(ext.count);
  });

  it('чужая версия раскладки — ошибка, а не мусор в кадре', () => {
    const buffer = new ArrayBuffer(requiredBytes(0, 0));
    new Uint32Array(buffer)[0] = CODEC_VERSION + 1;
    expect(() => readTick(buffer, [], [])).toThrow(/версия раскладки/);
  });

  it('буфер меньше нужного — ошибка записи с размерами', () => {
    const rig = makeRig();
    const extractor = makeExtractor(rig);
    const ext = extractor.extract(tick(rig.sim, rig.state));
    expect(() => writeTick(new ArrayBuffer(8), ext)).toThrow(/байт/);
  });
});
