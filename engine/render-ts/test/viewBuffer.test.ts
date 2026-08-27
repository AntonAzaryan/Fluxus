/**
 * ViewBuffer: память курса сущности, переживающая её выход из доставленного
 * состояния (REND-2, REND-13).
 *
 * Курс приезжает только у ДВИЖУЩЕЙСЯ сущности — стоящая приносит `NaN`, то
 * есть «курс не менять» (`Extractor`). Сущность, ушедшую в туман, фильтр
 * снапшота вырезает из доставки целиком (`netcode` NET-12, FOW-7), и запись
 * буфера удаляется вместе с накопленным курсом: без памяти вернувшийся из
 * тумана СТОЯЩИЙ юнит вставал бы лицом на +X (yaw 0) до первого своего шага.
 */
import { describe, expect, it } from 'vitest';
import { LOCOMOTION_NORMAL } from '@fluxus/core';
import { type ExtractedTick } from '../src/index.js';
import { FACING_MEMORY_LIMIT, ViewBuffer } from '../src/viewBuffer.js';

/** Сущность доставки стенда: курс `NaN` — стоит, число — идёт этим курсом. */
interface Delivered {
  readonly id: number;
  readonly facing: number;
}

/**
 * Синтетическая доставка: проверяются правила буфера, а не мир, поэтому
 * колонки собираются прямо здесь — экстрактор в этом тесте не участвует.
 */
function extOf(
  tick: number,
  entities: readonly Delivered[],
  snapAll = false,
): ExtractedTick {
  const count = entities.length;
  return {
    tick,
    mode: 'Running' as const,
    isReplay: snapAll,
    snapAll,
    freshEvents: true,
    count,
    id: Float64Array.from(entities, (entity) => entity.id),
    kind: new Int32Array(count).fill(-1),
    x: new Float32Array(count),
    y: new Float32Array(count),
    level: new Uint8Array(count),
    flags: new Uint8Array(count),
    facingYaw: Float32Array.from(entities, (entity) => entity.facing),
    aimYaw: new Float32Array(count).fill(Number.NaN),
    motion: new Uint8Array(count).fill(LOCOMOTION_NORMAL),
    motionPhase: new Float32Array(count).fill(Number.NaN),
    flightPhase: new Float32Array(count).fill(Number.NaN),
    statNames: [],
    statCount: new Uint8Array(count),
    statIndex: new Int32Array(0),
    statValue: new Float64Array(0),
    statPairs: 0,
    events: [],
    floorDelta: [],
    kindTable: [],
  };
}

describe('ViewBuffer: курс переживает исчезновение сущности из доставки (REND-2, REND-13)', () => {
  const HEADING = -2.1; // курс, который ни при каких округлениях не равен нулю

  it('вернувшаяся из тумана стоящая сущность смотрит туда же, куда уходила', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const facingOf = (): number | undefined => buffer.view.entities.get(5)?.facingYaw;

    // Шла: курс доставлен и запомнен.
    buffer.apply(extOf(1, [{ id: 5, facing: HEADING }]));
    expect(facingOf()).toBeCloseTo(HEADING, 6);
    // Встала: `NaN` — «курс не менять», запись держит прежний.
    buffer.apply(extOf(2, [{ id: 5, facing: Number.NaN }]));
    expect(facingOf()).toBeCloseTo(HEADING, 6);

    // Ушла в туман: фильтр снапшота вырезал её из доставки, записи больше нет.
    buffer.apply(extOf(3, []));
    expect(buffer.view.entities.has(5)).toBe(false);

    // Вернулась СТОЯ: курса в доставке нет, и новая запись берёт запомненный —
    // разворота лицом на +X при выходе из тумана не происходит.
    buffer.apply(extOf(4, [{ id: 5, facing: Number.NaN }]));
    expect(facingOf()).toBeCloseTo(HEADING, 6);
  });

  it('сущность, курса которой не знали никогда, заводится нулевым (прежнее поведение)', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 7, facing: Number.NaN }]));
    expect(buffer.view.entities.get(7)?.facingYaw).toBe(0);
  });

  it('поток короткоживущих сущностей не отнимает память у живой (чистка по переполнению)', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    // Сущность 5 доставляется каждый тик, остальные живут по одному: словарь
    // курсов переваливает за потолок, чистка выбрасывает мёртвых, а живой
    // курс переживает её — ради него память и заведена.
    const flood = FACING_MEMORY_LIMIT * 3;
    buffer.apply(extOf(1, [{ id: 5, facing: HEADING }]));
    for (let tick = 2; tick < flood; tick++) {
      buffer.apply(
        extOf(tick, [
          { id: 5, facing: Number.NaN },
          { id: tick + FACING_MEMORY_LIMIT * 10, facing: 0.5 },
        ]),
      );
    }
    // Память ОГРАНИЧЕНА: за долгий матч она не растёт числом когда-либо
    // доставленных сущностей — иначе это утечка на весь матч.
    expect(buffer.facingMemorySize).toBeLessThanOrEqual(FACING_MEMORY_LIMIT);
    // Уходит в туман и возвращается стоя — курс тот же, что до потока.
    buffer.apply(extOf(flood, []));
    buffer.apply(extOf(flood + 1, [{ id: 5, facing: Number.NaN }]));
    expect(buffer.view.entities.get(5)?.facingYaw).toBeCloseTo(HEADING, 6);
  });

  it('живых сущностей больше потолка — память сбрасывается, а не растёт (чистить нечего)', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    // Все сущности живы одновременно: выбрасывать чистке нечего, и границу
    // держит только полный сброс. Курс живой сущности при этом не теряется —
    // он лежит в её записи, а не в памяти.
    const crowd = FACING_MEMORY_LIMIT + 64;
    const moving: Delivered[] = [];
    for (let id = 1; id <= crowd; id++) moving.push({ id, facing: HEADING });
    buffer.apply(extOf(1, moving));
    expect(buffer.facingMemorySize).toBeLessThanOrEqual(FACING_MEMORY_LIMIT);
    expect(buffer.view.entities.get(crowd)?.facingYaw).toBeCloseTo(HEADING, 6);
  });

  it('разрыв непрерывности гасит память: за стёртой ветвью id принадлежит другому (NTR-16)', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 5, facing: HEADING }]));
    buffer.apply(extOf(2, []));
    // Перемотка стёрла ветвь и откатила счётчик поколений: тот же упакованный
    // id достаётся ДРУГОЙ сущности, и курс прежней ей не наследуется.
    buffer.apply(extOf(1, [{ id: 5, facing: Number.NaN }], true));
    expect(buffer.view.entities.get(5)?.facingYaw).toBe(0);
    expect(buffer.facingMemorySize).toBe(0);
  });
});
