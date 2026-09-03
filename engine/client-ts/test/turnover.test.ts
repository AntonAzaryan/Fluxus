/**
 * Оборот идентификаторов на приёме доставки (`performance-budget` PERF-9):
 * состав доставки меняется от тика к тику, и состояние приёмника расти от этого
 * MUST NOT.
 *
 * Проверяется здесь ПОЛНЫЙ путь канала (SHELL-3, SHELL-4) — сериализация
 * конверта, чтение и применение, — а не один лишь `ViewBuffer`: карты приёмника
 * наполняет именно он, но идентификаторы приезжают через кодек, и проверять
 * возврат записей мимо него значило бы проверять не тот путь, которым идёт игра.
 *
 * Утверждение точное и эталона не требует: ожидаемое значение известно заранее —
 * записей ровно столько, сколько сущностей в доставке, сколько бы раз состав ни
 * сменился.
 */
import { describe, expect, it } from 'vitest';
import {
  ViewBuffer,
  createFootprint,
  withFootprintSink,
  type ExtractedTick,
  type FootprintState,
} from '@fluxus/render';
import { readTick, requiredBytes, writeTick } from '../src/index.js';

/** Сущностей в доставке и сколько из них держат свои идентификаторы. */
const ENTITIES = 64;
const STABLE = 4;
/**
 * Доставок прогрева и доставок между точками A и B.
 *
 * Прогрев ДЛИННЫЙ намеренно: память курсов приёмника ограничена потолком
 * (`FACING_MEMORY_LIMIT` рендера, несколько тысяч записей), и чистится она по
 * переполнению, а не каждой доставкой. Точка A обязана лежать ЗА первым
 * переполнением — иначе тест сравнивал бы две точки на растущем участке и
 * краснел бы на ограниченной величине, приняв её рост за утечку. Шестьдесят
 * сменяющихся идентификаторов на доставку доводят словарь до потолка примерно к
 * семидесятой; сотня с запасом.
 */
const WARMUP = 120;
const SPAN = 120;

/**
 * Доставка раунда с ВРАЩАЮЩИМИСЯ идентификаторами: первые `STABLE` сущностей
 * свои id держат (игрок и его команда живут весь матч), остальные приходят
 * новыми и исчезают следующей доставкой — так выглядит поток видимых врагов под
 * туманом (FOW-8).
 */
function rotatingTick(round: number): ExtractedTick {
  const ext: ExtractedTick = {
    tick: round + 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    branchChanged: false,
    freshEvents: true,
    full: true,
    removed: new Float64Array(0),
    removedCount: 0,
    count: ENTITIES,
    id: new Float64Array(ENTITIES),
    kind: new Int32Array(ENTITIES),
    x: new Float32Array(ENTITIES),
    y: new Float32Array(ENTITIES),
    level: new Uint8Array(ENTITIES),
    simLevel: new Uint8Array(ENTITIES),
    flags: new Uint8Array(ENTITIES),
    facingYaw: new Float32Array(ENTITIES),
    aimYaw: new Float32Array(ENTITIES),
    motion: new Uint8Array(ENTITIES),
    motionPhase: new Float32Array(ENTITIES),
    flightPhase: new Float32Array(ENTITIES),
    timeScale: new Float32Array(ENTITIES).fill(1),
    statNames: [],
    statCount: new Uint8Array(ENTITIES),
    statIndex: new Int32Array(0),
    statValue: new Float64Array(0),
    statPairs: 0,
    events: [],
    floorDelta: [],
    kindTable: ['Hero'],
  };
  for (let i = 0; i < ENTITIES; i++) {
    ext.id[i] = i < STABLE ? i + 1 : 1_000_000 + round * ENTITIES + i;
    ext.x[i] = i % 8;
    ext.y[i] = Math.floor(i / 8);
    // Курс доставлен: без него память курсов не заводится вовсе и оборот её не
    // проверял бы.
    ext.facingYaw[i] = 1;
    ext.aimYaw[i] = Number.NaN;
    ext.motionPhase[i] = Number.NaN;
    ext.flightPhase[i] = Number.NaN;
  }
  return ext;
}

/** Величины состояния приёмника после `rounds` доставок оборота, начиная с `from`. */
function deliver(view: ViewBuffer, buffer: ArrayBuffer, from: number, rounds: number): void {
  for (let round = from; round < from + rounds; round++) {
    const ext = rotatingTick(round);
    writeTick(buffer, ext);
    view.apply(readTick(buffer, ext.events, ext.kindTable));
  }
}

describe('PERF-9: оборот идентификаторов не растит состояния приёма доставки', () => {
  it('записи и память курсов в точках A и B равны', () => {
    const sink = createFootprint();
    const view = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const buffer = new ArrayBuffer(requiredBytes(ENTITIES, 0));
    let a: FootprintState | null = null;
    let b: FootprintState | null = null;
    withFootprintSink(sink, () => {
      deliver(view, buffer, 0, WARMUP);
      a = { ...sink.state };
      deliver(view, buffer, WARMUP, SPAN);
      b = { ...sink.state };
    });

    // Величины — пики за прогон: выросшая между точками означает, что приём
    // перестал снимать запись исчезнувшей сущности (PERF-9).
    expect(b).toEqual(a);
    expect(a!.viewRecords).toBe(ENTITIES);
    // Память курсов живёт по своему правилу — потолком, а не составом доставки
    // (`ViewBuffer.facingMemory`). Равенство точек выше и означает, что потолок
    // ДЕЙСТВУЕТ: до него величина растёт, за ним держится, и число оборотов её
    // больше не двигает. Проверка «за потолком» здесь именно такая — «сильно
    // больше состава доставки»: сам потолок — константа рендера, и переписывать
    // её здесь значило бы завести второе её определение.
    expect(a!.viewFacingMemory).toBeGreaterThan(ENTITIES * 4);
  });

  it('нагрузка не выродилась: состав доставки действительно сменяется', () => {
    const first = [...rotatingTick(0).id];
    const second = [...rotatingTick(1).id];
    expect(first.filter((id) => second.includes(id))).toHaveLength(STABLE);
    // Живых записей ровно столько, сколько в последней доставке: приёмник
    // держит СОСТАВ, а не историю.
    const view = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const buffer = new ArrayBuffer(requiredBytes(ENTITIES, 0));
    deliver(view, buffer, 0, 3);
    expect(view.view.entities.size).toBe(ENTITIES);
  });
});
