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
import { FACING_MEMORY_LIMIT, ViewBuffer, interpolateYaw } from '../src/viewBuffer.js';

/**
 * Сущность доставки стенда: курс `NaN` — стоит, число — идёт этим курсом.
 * `pace` — персональная шкала времени (REND-38); не задана — обычный темп,
 * ровно как у сущности без компонента `TimeScale` (TIME-3).
 */
interface Delivered {
  readonly id: number;
  readonly facing: number;
  readonly pace?: number;
  /** Индекс вида в словаре доставки; не задан — `−1`, сущность не рисуется. */
  readonly kind?: number;
}

/**
 * Синтетическая доставка: проверяются правила буфера, а не мир, поэтому
 * колонки собираются прямо здесь — экстрактор в этом тесте не участвует.
 */
function extOf(
  tick: number,
  entities: readonly Delivered[],
  snapAll = false,
  /**
   * Смена ветви истории. По умолчанию совпадает со `snapAll` — так выглядит
   * реплеевая доставка; разрыв БЕЗ смены ветви (пауза матча, NTR-20) тесты
   * называют явным `false`.
   */
  branchChanged = snapAll,
): ExtractedTick {
  const count = entities.length;
  return {
    tick,
    mode: 'Running' as const,
    isReplay: branchChanged,
    snapAll,
    branchChanged,
    freshEvents: true,
    count,
    id: Float64Array.from(entities, (entity) => entity.id),
    kind: Int32Array.from(entities, (entity) => entity.kind ?? -1),
    x: new Float32Array(count),
    y: new Float32Array(count),
    level: new Uint8Array(count),
    simLevel: new Uint8Array(count),
    flags: new Uint8Array(count),
    facingYaw: Float32Array.from(entities, (entity) => entity.facing),
    aimYaw: new Float32Array(count).fill(Number.NaN),
    motion: new Uint8Array(count).fill(LOCOMOTION_NORMAL),
    motionPhase: new Float32Array(count).fill(Number.NaN),
    flightPhase: new Float32Array(count).fill(Number.NaN),
    timeScale: Float32Array.from(entities, (entity) => entity.pace ?? 1),
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

/**
 * Персональная шкала времени в записи (REND-38): величина ПОСЛЕДНЕГО
 * доставленного тика, без пары для интерполяции. Пары нет намеренно —
 * плавность спада даёт tween ауры в самой симуляции, а conflation (SHELL-4)
 * пропущенному тику и так не даёт быть показанным.
 */
describe('ViewBuffer: персональная шкала времени сущности (REND-38)', () => {
  const paceOf = (buffer: ViewBuffer, id: number): number | undefined =>
    buffer.view.entities.get(id)?.timeScale;

  it('шкала доезжает до записи, а сущность без неё идёт единицей, не нулём', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 5, facing: 0, pace: 0.2 }, { id: 6, facing: 0 }]));
    expect(paceOf(buffer, 5)).toBeCloseTo(0.2, 6);
    // РОВНО единица: умолчание `getEffectiveDelta` (TIME-3), а не ноль.
    expect(paceOf(buffer, 6)).toBe(1);
  });

  it('появившаяся сущность берёт шкалу своего первого тика, а не умолчание записи', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 7, facing: 0, pace: 0.5 }]));
    expect(paceOf(buffer, 7)).toBeCloseTo(0.5, 6);
  });

  it('следующий тик перебивает прежнюю величину: она не залипает', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 5, facing: 0, pace: 0.2 }]));
    buffer.apply(extOf(2, [{ id: 5, facing: 0, pace: 0.6 }]));
    expect(paceOf(buffer, 5)).toBeCloseTo(0.6, 6);
    // Аура отпустила — темп вернулся к обычному тем же путём.
    buffer.apply(extOf(3, [{ id: 5, facing: 0 }]));
    expect(paceOf(buffer, 5)).toBe(1);
  });
});

// ---- change `fog-observer-inputs`: ветвь истории, вид записи и пара курсов

describe('ViewBuffer: память курса гасит СМЕНА ВЕТВИ, а не всякий разрыв (SHELL-7)', () => {
  const HEADING = -2.1;

  it('пауза матча память не трогает: юнит возвращается из тумана прежним курсом', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 5, facing: HEADING }]));
    // Сущность в тумане: её записи нет, курс живёт только в памяти.
    buffer.apply(extOf(2, []));
    // Пауза (NTR-20): смена режима — разрыв картинки (`snapAll`), но ветвь
    // истории та же, и упакованные id принадлежат тем же сущностям.
    buffer.apply(extOf(3, [], true, false));
    buffer.apply(extOf(4, [{ id: 5, facing: Number.NaN }]));
    expect(buffer.view.entities.get(5)?.facingYaw).toBeCloseTo(HEADING, 6);
  });

  it('смена ветви память стирает: за стёртой ветвью id принадлежит другой сущности', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, [{ id: 5, facing: HEADING }]));
    buffer.apply(extOf(2, []));
    buffer.apply(extOf(3, [], true, true));
    buffer.apply(extOf(4, [{ id: 5, facing: Number.NaN }]));
    // Ноль — курс сущности, о которой ничего не известно: помнить чужой было бы
    // разворотом новорождённого по чужому следу (NTR-16).
    expect(buffer.view.entities.get(5)?.facingYaw).toBe(0);
  });
});

describe('ViewBuffer: живой id со сменившимся видом пересоздаёт запись (NTR-16)', () => {
  it('после разрыва переиспользованный id получает СВОЙ вид, а не прежний', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const ext = (tick: number, kind: number, snapAll = false): ExtractedTick => {
      const flat = extOf(tick, [{ id: 5, facing: 0, kind }], snapAll);
      return { ...flat, kindTable: ['Fireball', 'Hero'] };
    };
    buffer.apply(ext(1, 0));
    expect(buffer.view.entities.get(5)?.kind).toBe('Fireball');

    // Разрыв ветви: тот же упакованный id — уже другая сущность (снаряды
    // спавнятся постоянно, слот переиспользуется на первых же тиках). Вид
    // записи неизменен на всю её жизнь, поэтому запись обязана пересоздаться.
    buffer.apply(ext(2, 1, true));
    expect(buffer.view.entities.get(5)?.kind).toBe('Hero');
    // Пересозданная запись — появившаяся: snap без интерполяции (REND-2).
    expect(buffer.view.entities.get(5)?.spawned).toBe(true);
    expect(buffer.view.entities.get(5)?.snap).toBe(true);
  });

  it('тот же вид на разрыве запись не пересоздаёт', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const ext = (tick: number, snapAll = false): ExtractedTick => {
      const flat = extOf(tick, [{ id: 5, facing: 0, kind: 0 }], snapAll);
      return { ...flat, kindTable: ['Fireball'] };
    };
    buffer.apply(ext(1));
    const record = buffer.view.entities.get(5);
    buffer.apply(ext(2, true));
    expect(buffer.view.entities.get(5)).toBe(record);
    expect(buffer.view.entities.get(5)?.spawned).toBe(false);
  });
});

describe('ViewBuffer: курс — пара двух последних доставленных тиков (REND-2)', () => {
  it('пара скользит по доставленным тикам, а стоящая сущность её не двигает', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const view = () => buffer.view.entities.get(5)!;
    buffer.apply(extOf(1, [{ id: 5, facing: 0.5 }]));
    // Появление — разрыв: пара схлопнута, кадр ставит курс мгновенно.
    expect(view().prevFacingYaw).toBeCloseTo(0.5, 6);
    expect(view().facingYaw).toBeCloseTo(0.5, 6);

    buffer.apply(extOf(2, [{ id: 5, facing: 1.5 }]));
    expect(view().prevFacingYaw).toBeCloseTo(0.5, 6);
    expect(view().facingYaw).toBeCloseTo(1.5, 6);

    // Встала: `NaN` — «курс не менять». Пара обязана остаться прежней, иначе
    // остановка сама по себе доворачивала бы юнита.
    buffer.apply(extOf(3, [{ id: 5, facing: Number.NaN }]));
    expect(view().prevFacingYaw).toBeCloseTo(1.5, 6);
    expect(view().facingYaw).toBeCloseTo(1.5, 6);
  });

  it('разрыв непрерывности схлопывает пару, как схлопывает позицию', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const view = () => buffer.view.entities.get(5)!;
    buffer.apply(extOf(1, [{ id: 5, facing: 0 }]));
    buffer.apply(extOf(2, [{ id: 5, facing: 1 }]));
    buffer.apply(extOf(3, [{ id: 5, facing: 3 }], true));
    expect(view().snap).toBe(true);
    expect(view().prevFacingYaw).toBeCloseTo(3, 6);
    expect(view().facingYaw).toBeCloseTo(3, 6);
  });

  it('интерполяция идёт по КРАТЧАЙШЕЙ дуге, а не через всю окружность', () => {
    // Курс живёт на окружности: с +3.0 на −3.0 ближняя дуга — 2π − 6 ≈ 0.28
    // радиана ЧЕРЕЗ ±π, а линейная интерполяция прошла бы 6 радиан в обратную
    // сторону, развернув сущность длинной стороной.
    expect(interpolateYaw(3, -3, 0.5)).toBeCloseTo(Math.PI, 9);
    expect(interpolateYaw(3, -3, 1)).toBeCloseTo(3 + (2 * Math.PI - 6), 9);
    // Внутри одного оборота — обычная линейная доля.
    expect(interpolateYaw(0.5, 1.5, 0)).toBeCloseTo(0.5, 9);
    expect(interpolateYaw(0.5, 1.5, 1)).toBeCloseTo(1.5, 9);
    expect(interpolateYaw(0.5, 1.5, 0.25)).toBeCloseTo(0.75, 9);
  });
});
