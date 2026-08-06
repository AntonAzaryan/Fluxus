/**
 * Кодек плоского буфера (SHELL-3): roundtrip писатель → читатель в одном
 * потоке против прямого вызова — рассинхрон раскладки ловится здесь, а не
 * в воркере. Плюс переопределения заголовка (аккумулированные флаги и дельта
 * пола, SHELL-4) и защита версии раскладки.
 *
 * Отдельным блоком — кадр как недоверенные байты. Кодек единственное место в
 * репозитории, где данные разбираются вручную по смещениям, и раскладку задаёт
 * сам кадр: `count` и `floorPairs` читаются из заголовка и определяют, где
 * лежат все остальные секции. Значит, любое их значение обязано приводить либо
 * к корректному разбору, либо к названной ошибке — и никогда к чужой памяти
 * буфера или к сырому RangeError из конструктора TypedArray.
 */
import { describe, expect, it } from 'vitest';
import { tick, type WorldMode } from '@game-mvp/core';
import { ViewBuffer, type ExtractedTick } from '@game-mvp/render';
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

/** Слов в заголовке — знание раскладки, нужное только тестам, которые её ломают. */
const HEADER_WORDS = 8;
const H_MODE = 2;
const H_COUNT = 4;
const H_FLOOR_PAIRS = 5;

/**
 * Синтетический тик с заданными колонками: рукописный, а не снятый с
 * симуляции, потому что проверяются значения, которых симуляция не порождает,
 * — NaN в курсе, `kind = -1`, пустая сцена, предельные `level`/`flags`.
 */
function syntheticTick(overrides: Partial<ExtractedTick> = {}): ExtractedTick {
  const count = overrides.count ?? 0;
  const zeros = <T>(make: (n: number) => T): T => make(count);
  return {
    tick: 7,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: true,
    count,
    id: zeros((n) => new Float64Array(n)),
    kind: zeros((n) => new Int32Array(n)),
    x: zeros((n) => new Float32Array(n)),
    y: zeros((n) => new Float32Array(n)),
    level: zeros((n) => new Uint8Array(n)),
    flags: zeros((n) => new Uint8Array(n)),
    facingYaw: zeros((n) => new Float32Array(n)),
    aimYaw: zeros((n) => new Float32Array(n)),
    fall: zeros((n) => new Float32Array(n)),
    events: [],
    floorDelta: [],
    kindTable: [],
    ...overrides,
  };
}

/** Кадр целиком: буфер ровно нужного размера, записанный тик. */
function frameOf(ext: ExtractedTick): ArrayBuffer {
  const buffer = new ArrayBuffer(requiredBytes(ext.count, ext.floorDelta.length >>> 1));
  writeTick(buffer, ext);
  return buffer;
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

describe('кодек: значения на границах раскладки (SHELL-3)', () => {
  it('пустая сцена — валидный кадр в один заголовок, а не особый случай', () => {
    const wire = readTick(frameOf(syntheticTick({ count: 0 })), [], []);
    expect(wire.count).toBe(0);
    expect(wire.id).toHaveLength(0);
    expect(requiredBytes(0, 0)).toBe(HEADER_WORDS * 4);
  });

  it('NaN в курсе доезжает как NaN: это «не поворачивать», а не отсутствие поля', () => {
    const ext = syntheticTick({
      count: 2,
      facingYaw: Float32Array.from([NaN, 1.5]),
      aimYaw: Float32Array.from([0.25, NaN]),
    });

    const wire = readTick(frameOf(ext), [], []);
    expect(Number.isNaN(wire.facingYaw[0]!)).toBe(true);
    expect(wire.facingYaw[1]).toBeCloseTo(1.5, 6);
    expect(wire.aimYaw[0]).toBeCloseTo(0.25, 6);
    expect(Number.isNaN(wire.aimYaw[1]!)).toBe(true);
  });

  it('прогресс падения доезжает вместе с NaN «не падает» (REND-12)', () => {
    const ext = syntheticTick({
      count: 2,
      fall: Float32Array.from([NaN, 0.75]),
    });

    const wire = readTick(frameOf(ext), [], []);
    expect(Number.isNaN(wire.fall[0]!)).toBe(true);
    expect(wire.fall[1]).toBeCloseTo(0.75, 6);
  });

  it('отрицательный kind и предельные level/flags переживают roundtrip', () => {
    const ext = syntheticTick({
      count: 3,
      // kind = -1 — «не рисуется» (SHELL-5); секция знаковая, и это проверяется.
      kind: Int32Array.from([-1, 0, 2147483647]),
      level: Uint8Array.from([0, 128, 255]),
      flags: Uint8Array.from([0, 1, 255]),
      id: Float64Array.from([1, 2 ** 47, 2 ** 48 - 1]),
    });

    const wire = readTick(frameOf(ext), [], []);
    expect([...wire.kind]).toEqual([-1, 0, 2147483647]);
    expect([...wire.level]).toEqual([0, 128, 255]);
    expect([...wire.flags]).toEqual([0, 1, 255]);
    // EntityId 48-битный: Float64 держит его точно, округления быть не должно.
    expect([...wire.id]).toEqual([1, 2 ** 47, 2 ** 48 - 1]);
  });

  it.each(['Running', 'Paused', 'Rewinding'] as const)('режим %s доезжает собой', (mode) => {
    expect(readTick(frameOf(syntheticTick({ mode })), [], []).mode).toBe(mode);
  });

  it('неизвестный режим — ошибка записи, а не тихая подмена на Running', () => {
    // Появление четвёртого WorldMode без правки таблицы кодека: раньше кадр
    // уезжал с Running, и приёмник не отличил бы это от правды.
    const ext = syntheticTick({ mode: 'Frozen' as WorldMode });
    expect(() => frameOf(ext)).toThrow(/неизвестный режим/);
  });

  it('requiredBytes — точная граница: ровно столько пишется, на байт меньше уже нет', () => {
    for (const [count, pairs] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [3, 5],
      [17, 2],
    ] as const) {
      const ext = syntheticTick({ count, floorDelta: new Uint32Array(pairs * 2) });
      const need = requiredBytes(count, pairs);
      expect(() => writeTick(new ArrayBuffer(need), ext)).not.toThrow();
      expect(() => writeTick(new ArrayBuffer(need - 1), ext)).toThrow(/байт/);
    }
  });
});

describe('кодек: кадр как недоверенные байты (SHELL-3)', () => {
  /** Кадр с подменённым словом заголовка — способ подсунуть читателю ложь о раскладке. */
  function tampered(word: number, value: number): ArrayBuffer {
    const buffer = frameOf(syntheticTick({ count: 2 }));
    new Uint32Array(buffer)[word] = value;
    return buffer;
  }

  it('кадр короче заголовка — названная ошибка, а не RangeError из TypedArray', () => {
    expect(() => readTick(new ArrayBuffer(4), [], [])).toThrow(/заголовок/);
    expect(() => readTick(new ArrayBuffer(0), [], [])).toThrow(/заголовок/);
  });

  it('count из заголовка больше кадра — названная ошибка с обоими размерами', () => {
    expect(() => readTick(tampered(H_COUNT, 1000), [], [])).toThrow(/count=1000/);
  });

  it('floorPairs из заголовка больше кадра — та же названная ошибка', () => {
    expect(() => readTick(tampered(H_FLOOR_PAIRS, 4096), [], [])).toThrow(/floorPairs=4096/);
  });

  it('count у верхней границы u32 не уводит смещения в переполнение', () => {
    // 0xFFFFFFFF * 8 не помещается в i32: если бы раскладка считалась в
    // 32-битной арифметике, смещение секции стало бы отрицательным, и проверка
    // размера прошла бы. Считается в double — не проходит.
    expect(() => readTick(tampered(H_COUNT, 0xffffffff), [], [])).toThrow(/codec:/);
  });

  it('режим вне таблицы — ошибка, а не молчаливый Running', () => {
    expect(() => readTick(tampered(H_MODE, 9), [], [])).toThrow(/вне таблицы/);
  });

  it('версия проверяется раньше раскладки: чужой кадр не разбирается вовсе', () => {
    // Версия и count испорчены оба; отвечать читатель обязан про версию —
    // раскладка чужой версии ничего не значит, и жаловаться на неё бессмысленно.
    const buffer = frameOf(syntheticTick({ count: 2 }));
    const header = new Uint32Array(buffer);
    header[0] = CODEC_VERSION + 1;
    header[H_COUNT] = 1000;
    expect(() => readTick(buffer, [], [])).toThrow(/версия раскладки/);
  });
});
