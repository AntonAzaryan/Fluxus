/**
 * Query API (QUERY-1..3): декларативные фильтры (`all`/`any`/`not`/
 * `withinRadius`/`withTag`), комбинируемые в одном запросе.
 *
 * Результат материализуется на момент вызова (QUERY-3): последующие
 * структурные изменения мира на уже отданный результат не влияют.
 *
 * Порядок — по возрастанию raw-индекса сущности (QUERY-2). Он получается по
 * построению: обходим слоты слева направо. Сортировки нет, и по той же причине
 * доступ к SoA-массивам последовательный.
 *
 * Контейнер результата — Float64Array: EntityId 48-битный, Uint32Array молча
 * усёк бы его при generation >= 256 (ID-1).
 */
import type { QuerySpec, Vec2, WorldState } from '../types.js';
import { POSITION_COMPONENT } from '../types.js';
import { componentId, componentMasks, getField, hasTag, listAlive } from './world.js';
import { buildQueryMask, matchesAll, matchesAny, matchesNone } from './componentMask.js';
import { indexOf } from './entityIndex.js';

const EMPTY = new Float64Array(0);

/** Имена компонентов → маска-фильтр. Неизвестное имя делает `all`/`not` тривиально невыполнимым/пустым. */
function maskOf(state: WorldState, names: readonly string[]): Uint32Array | 'unknown' {
  const ids: number[] = [];
  for (const name of names) {
    const id = componentId(state, name);
    if (id === undefined) return 'unknown';
    ids.push(id);
  }
  return buildQueryMask(componentMasks(state), ids);
}

export function query(state: WorldState, spec: QuerySpec): Float64Array {
  const masks = componentMasks(state);

  const allMask = spec.all ? maskOf(state, spec.all) : undefined;
  // Требуется компонент, которого нет в мире вообще — результат заведомо пуст.
  if (allMask === 'unknown') return EMPTY;
  const anyMask = spec.any ? maskOf(state, spec.any) : undefined;
  if (anyMask === 'unknown') return EMPTY;
  // Запрет по несуществующему компоненту никого не отсеивает — фильтр опускаем.
  const notMaskRaw = spec.not ? maskOf(state, spec.not) : undefined;
  const notMask = notMaskRaw === 'unknown' ? undefined : notMaskRaw;

  const candidates = listAlive(state);
  const result = new Float64Array(candidates.length);
  let count = 0;

  for (const entity of candidates) {
    const index = indexOf(entity);
    if (allMask && !matchesAll(masks, index, allMask)) continue;
    if (anyMask && !matchesAny(masks, index, anyMask)) continue;
    if (notMask && !matchesNone(masks, index, notMask)) continue;
    if (spec.withTag !== undefined && !hasTag(state, entity, spec.withTag)) continue;
    if (spec.withinRadius && !withinRadius(state, entity, spec.withinRadius.center, spec.withinRadius.radius)) {
      continue;
    }
    result[count] = entity;
    count++;
  }

  return count === candidates.length ? result : result.subarray(0, count);
}

function withinRadius(state: WorldState, entity: number, center: Vec2, radius: number): boolean {
  if (componentId(state, POSITION_COMPONENT) === undefined) return false;
  const dx = getField(state, entity, POSITION_COMPONENT, 'x') - center.x;
  const dy = getField(state, entity, POSITION_COMPONENT, 'y') - center.y;
  return distSqLe(dx, dy, radius);
}

// ponytail: сравнение сумм квадратов в fixed-point без sqrt (QUERY-1: граница
// включающая, округление sqrt меняло бы состав результата у самой границы).
// dx*dx+dy*dy на i32-координатах может вылететь за 2^53 (safe integer) —
// поэтому считаем точно как беззнаковые 64 бита (пара 32-битных слов) через
// разложение на 16-битные половины. Это временное место: единая MathApi должна
// получить такой же 64-битный компаратор, чтобы им пользовались и другие
// системы (столкновения, LoS).

type U64 = readonly [hi: number, lo: number];

const TWO_16 = 0x10000;
const TWO_32 = 0x100000000;

/** Точное |a|*|a| для i32 как беззнаковое 64-битное число (hi,lo — 32-битные слова). */
function sq64(a: number): U64 {
  const v = Math.abs(a);
  const hi16 = Math.floor(v / TWO_16);
  const lo16 = v % TWO_16;

  const loLo = lo16 * lo16; // < 2^32, точно
  const cross = hi16 * lo16 * 2; // < 2^32, точно
  const hiHi = hi16 * hi16; // < 2^32, точно

  const crossLo = cross % TWO_16;
  const crossHi = Math.floor(cross / TWO_16);

  const loRaw = loLo + crossLo * TWO_16; // < 2^33, точно
  const carry = Math.floor(loRaw / TWO_32);
  return [hiHi + crossHi + carry, loRaw % TWO_32];
}

function add64(a: U64, b: U64): U64 {
  const loRaw = a[1] + b[1];
  const carry = Math.floor(loRaw / TWO_32);
  return [a[0] + b[0] + carry, loRaw % TWO_32];
}

function le64(a: U64, b: U64): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

/** dx²+dy² <= radius² — включая границу (QUERY-1). */
function distSqLe(dx: number, dy: number, radius: number): boolean {
  return le64(add64(sq64(dx), sq64(dy)), sq64(radius));
}
