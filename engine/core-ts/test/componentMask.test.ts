import { describe, expect, it } from 'vitest';
import {
  buildQueryMask,
  clearComponent,
  clearEntity,
  cloneMasks,
  createMasks,
  hasComponent,
  isEmptyMask,
  matchesAll,
  matchesAny,
  matchesNone,
  setComponent,
} from '../src/ecs/componentMask.js';

describe('componentMask', () => {
  it('set/has/clear одного компонента', () => {
    const m = createMasks(4, 8);
    expect(hasComponent(m, 0, 3)).toBe(false);
    setComponent(m, 0, 3);
    expect(hasComponent(m, 0, 3)).toBe(true);
    clearComponent(m, 0, 3);
    expect(hasComponent(m, 0, 3)).toBe(false);
  });

  it('set/has/clear нескольких компонентов на одной сущности', () => {
    const m = createMasks(4, 10);
    setComponent(m, 1, 0);
    setComponent(m, 1, 5);
    setComponent(m, 1, 9);
    expect(hasComponent(m, 1, 0)).toBe(true);
    expect(hasComponent(m, 1, 5)).toBe(true);
    expect(hasComponent(m, 1, 9)).toBe(true);
    expect(hasComponent(m, 1, 1)).toBe(false);

    clearComponent(m, 1, 5);
    expect(hasComponent(m, 1, 0)).toBe(true);
    expect(hasComponent(m, 1, 5)).toBe(false);
    expect(hasComponent(m, 1, 9)).toBe(true);
  });

  it('граница слова: id 31, 32, 63 не протекают в соседний слот', () => {
    const m = createMasks(2, 64); // wordsPerEntity = 2
    expect(m.wordsPerEntity).toBe(2);

    setComponent(m, 0, 31); // старший бит первого слова — ловушка `1 << 31`
    expect(hasComponent(m, 0, 31)).toBe(true);
    expect(hasComponent(m, 0, 32)).toBe(false); // не протёк в следующий слот
    expect(hasComponent(m, 0, 63)).toBe(false);

    setComponent(m, 0, 32); // первый бит второго слова
    expect(hasComponent(m, 0, 31)).toBe(true); // предыдущий бит не задет
    expect(hasComponent(m, 0, 32)).toBe(true);
    expect(hasComponent(m, 0, 63)).toBe(false);

    setComponent(m, 0, 63); // старший бит второго слова — снова ловушка `1 << 31`
    expect(hasComponent(m, 0, 63)).toBe(true);
    expect(hasComponent(m, 0, 31)).toBe(true);
    expect(hasComponent(m, 0, 32)).toBe(true);

    // прямая проверка значения слова: бит 31 не должен превращать слово в отрицательное число
    expect(m.words[1]).toBe(((1 << 0) | (1 << 31)) >>> 0);
    expect(m.words[1]).toBeGreaterThan(0); // если бы протекла знаковая версия, тут было бы отрицательное
  });

  it('более 32 компонентов: биты не пересекаются между соседними сущностями', () => {
    const m = createMasks(3, 40); // wordsPerEntity = 2
    expect(m.wordsPerEntity).toBe(2);

    setComponent(m, 0, 31);
    setComponent(m, 1, 32);
    setComponent(m, 2, 39);

    expect(hasComponent(m, 0, 31)).toBe(true);
    expect(hasComponent(m, 0, 32)).toBe(false);
    expect(hasComponent(m, 0, 39)).toBe(false);

    expect(hasComponent(m, 1, 31)).toBe(false);
    expect(hasComponent(m, 1, 32)).toBe(true);
    expect(hasComponent(m, 1, 39)).toBe(false);

    expect(hasComponent(m, 2, 31)).toBe(false);
    expect(hasComponent(m, 2, 32)).toBe(false);
    expect(hasComponent(m, 2, 39)).toBe(true);
  });

  it('matchesAll: все биты фильтра должны присутствовать', () => {
    const m = createMasks(2, 8);
    setComponent(m, 0, 0);
    setComponent(m, 0, 2);

    const need02 = buildQueryMask(m, [0, 2]);
    const need012 = buildQueryMask(m, [0, 1, 2]);

    expect(matchesAll(m, 0, need02)).toBe(true);
    expect(matchesAll(m, 0, need012)).toBe(false); // компонента 1 нет
  });

  it('matchesAny: достаточно одного совпадения', () => {
    const m = createMasks(2, 8);
    setComponent(m, 0, 2);

    const filter = buildQueryMask(m, [1, 2, 3]);
    expect(matchesAny(m, 0, filter)).toBe(true);

    const other = buildQueryMask(m, [1, 3]);
    expect(matchesAny(m, 0, other)).toBe(false);
  });

  it('matchesNone: ни один бит фильтра не должен присутствовать', () => {
    const m = createMasks(2, 8);
    setComponent(m, 0, 2);

    const filter = buildQueryMask(m, [1, 3]);
    expect(matchesNone(m, 0, filter)).toBe(true);

    const filterHit = buildQueryMask(m, [1, 2]);
    expect(matchesNone(m, 0, filterHit)).toBe(false);
  });

  it('пустой фильтр: all и any матчат всё, none тоже матчит всё (нет запрещённых компонентов)', () => {
    const m = createMasks(1, 8);
    const empty = buildQueryMask(m, []);
    expect(isEmptyMask(empty)).toBe(true);

    // сущность вообще без компонентов
    expect(matchesAll(m, 0, empty)).toBe(true);
    expect(matchesAny(m, 0, empty)).toBe(true);
    expect(matchesNone(m, 0, empty)).toBe(true);

    // и сущность с компонентами — пустой фильтр всё равно не сужает выборку
    setComponent(m, 0, 3);
    expect(matchesAll(m, 0, empty)).toBe(true);
    expect(matchesAny(m, 0, empty)).toBe(true);
    expect(matchesNone(m, 0, empty)).toBe(true);
  });

  it('clearEntity снимает все биты сущности и не задевает соседей', () => {
    const m = createMasks(3, 40); // wordsPerEntity = 2
    setComponent(m, 1, 0);
    setComponent(m, 1, 35);
    setComponent(m, 0, 5);
    setComponent(m, 2, 39);

    clearEntity(m, 1);

    expect(hasComponent(m, 1, 0)).toBe(false);
    expect(hasComponent(m, 1, 35)).toBe(false);
    // соседи не задеты
    expect(hasComponent(m, 0, 5)).toBe(true);
    expect(hasComponent(m, 2, 39)).toBe(true);
  });

  it('cloneMasks: мутация клона не задевает оригинал', () => {
    const m = createMasks(2, 8);
    setComponent(m, 0, 1);

    const clone = cloneMasks(m);
    expect(clone.words).not.toBe(m.words); // отдельный TypedArray, не alias

    setComponent(clone, 0, 2);
    clearComponent(clone, 1, 1); // no-op, но проверяем независимость и на индексе без изменений

    expect(hasComponent(clone, 0, 2)).toBe(true);
    expect(hasComponent(m, 0, 2)).toBe(false); // оригинал не изменился

    expect(hasComponent(m, 0, 1)).toBe(true);
    expect(hasComponent(clone, 0, 1)).toBe(true);
  });

  it('buildQueryMask на пустом списке даёт пустую маску нужной длины', () => {
    const m = createMasks(1, 40); // wordsPerEntity = 2
    const empty = buildQueryMask(m, []);
    expect(empty.length).toBe(m.wordsPerEntity);
    expect(isEmptyMask(empty)).toBe(true);
  });
});
