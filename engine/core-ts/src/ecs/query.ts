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
import { distSqLe } from '../math/fixed.js';
import type { QuerySpec, Vec2, WorldState } from '../types.js';
import { POSITION_COMPONENT } from '../types.js';
import { componentId, componentMasks, entityIndexOf, getField, hasTag } from './world.js';
import { buildQueryMask, matchesAll, matchesAny, matchesNone } from './componentMask.js';
import { makeEntityId } from './entityIndex.js';

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

  // Слоты обходятся напрямую, без материализации массива живых сущностей на
  // каждый запрос (запросы зовутся системами каждый тик — это была бы лишняя
  // аллокация размером в мир). Порядок QUERY-2 сохраняется по построению, а id
  // упаковывается только для прошедших фильтр по маске.
  const entities = entityIndexOf(state);
  const result = new Float64Array(entities.aliveCount);
  let count = 0;

  for (let index = 0; index < entities.nextIndex; index++) {
    if (entities.alive[index] !== 1) continue;
    if (allMask && !matchesAll(masks, index, allMask)) continue;
    if (anyMask && !matchesAny(masks, index, anyMask)) continue;
    if (notMask && !matchesNone(masks, index, notMask)) continue;
    const entity = makeEntityId(index, entities.generations[index] ?? 0);
    if (spec.withTag !== undefined && !hasTag(state, entity, spec.withTag)) continue;
    if (spec.withinRadius && !withinRadius(state, entity, spec.withinRadius.center, spec.withinRadius.radius)) {
      continue;
    }
    result[count] = entity;
    count++;
  }

  return count === result.length ? result : result.subarray(0, count);
}

/**
 * Фильтр по радиусу. Владения `Position` он НЕ требует, а чтение поля тотально
 * (ECS-7): сущность без `Position` читает нейтральный ноль по обеим осям, то
 * есть оказывается в мировом начале координат — и попадает в любой радиус,
 * этого начала достигающий. Прежде она попадала бы туда же по значению из
 * ячейки, но невоспроизводимо; ECS-7 не создал этот эффект, а сделал его
 * определённым.
 *
 * Должен ли `withinRadius` подразумевать `all: ['Position']` — открытый вопрос
 * QUERY-1, а не следствие ECS-7: ответ на него ни одну норму чтения не меняет.
 * Guard `hasComponent` тут не помогает — ядро читает поле внутри фильтра
 * запроса, до всякого выражения контента.
 */
function withinRadius(state: WorldState, entity: number, center: Vec2, radius: number): boolean {
  if (componentId(state, POSITION_COMPONENT) === undefined) return false;
  const dx = getField(state, entity, POSITION_COMPONENT, 'x') - center.x;
  const dy = getField(state, entity, POSITION_COMPONENT, 'y') - center.y;
  return distSqLe(dx, dy, radius);
}
