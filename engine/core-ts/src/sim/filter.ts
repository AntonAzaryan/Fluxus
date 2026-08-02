/**
 * Per-client фильтрация снапшота и событий (NET-12..15).
 *
 * Внешний слой НАД `TickResult`, а не система в scheduler'е (NET-12): сервер
 * тикает мир ОДИН раз, а затем режет из него персональные снапшоты — до 10 штук
 * на тик. Фильтр читает финальное состояние тика и не мутирует ни мир, ни
 * `TickResult`: он работает по копии.
 *
 * NET-14: отсутствие сущности в результате означает «ушла в туман», и ничем
 * больше. Смерть — только явное событие `EntityDied` от геймплейной системы;
 * фильтр событий не порождает и ни одну сущность мёртвой не помечает.
 *
 * ponytail: результат — полный `Snapshot` с копией мира, а не diff. Копия на
 * клиента на тик — ровно тот профиль нагрузки, который netcode-спека
 * («Стоимость per-client фильтрации») просит замерить; delta-компрессия и
 * per-client baseline — оптимизация потом (NET-8), не сейчас.
 */
import { query } from '../ecs/query.js';
import { cloneWorld, destroy, getField, isAlive } from '../ecs/world.js';
import { teamBit, VISIBILITY_COMPONENT } from '../systems/visibility.js';
import { takeSnapshot } from './tick.js';
import type { EntityId, GameEvent, SimulationState, Snapshot } from '../types.js';

/**
 * Без фильтрации: спектейтор, реплей, дебаг, golden-файлы CLI (NET-15, CLI-5).
 * Значение вне диапазона команд `[0, 31]` (FOW-2), поэтому с teamId не спутать.
 */
export const VIEWPOINT_ALL = -1;

/**
 * Предикат видимости события (NET-13). Подключаемый, потому что точная политика
 * при разной видимости источника и цели — открытый геймплейный вопрос в спеке
 * netcode, а не свойство ядра. Netcode-слой вправе поставить свой.
 */
export type EventVisibility = (event: GameEvent, isVisible: (entity: EntityId) => boolean) => boolean;

/**
 * Поля данных события, которые трактуются как ссылки на сущности. Конвенция
 * имён, а не типизация: `GameEvent.data` — плоская карта чисел (OBS-1).
 */
export const EVENT_ENTITY_FIELDS: readonly string[] = ['entity', 'other', 'source', 'target'];

/**
 * Политика по умолчанию (NET-13): событие уходит клиенту, если видима хотя бы
 * одна упомянутая в нём сущность («типично — источник ИЛИ цель»). Событие, ни
 * на кого не ссылающееся (сужение арены, конец раунда), считается общим.
 *
 * Консервативность здесь в том, что неизвестное поле-ссылку политика не
 * угадывает: сущность, названная полем не из `EVENT_ENTITY_FIELDS`, видимости
 * событию не добавляет. Заменяется целиком, а не патчится.
 */
export const relevantEntityVisible: EventVisibility = (event, isVisible) => {
  let referenced = false;
  for (const field of EVENT_ENTITY_FIELDS) {
    const value = event.data[field];
    if (value === undefined) continue;
    referenced = true;
    if (isVisible(value)) return true;
  }
  return !referenced;
};

/** `SimulationState` от `Snapshot` отличает rng: там реестр, здесь снятый срез. */
function isSnapshot(source: Snapshot | SimulationState): source is Snapshot {
  return Array.isArray(source.rng);
}

/**
 * Персональный снапшот для `viewpoint` (NET-12). Из мира вырезаются сущности,
 * чей бит команды не взведён в `Visibility.visibleTo`; сущности БЕЗ компонента
 * `Visibility` публичны и остаются всегда — террейн, арена и прочая обстановка
 * секретом не являются.
 *
 * Своя сущность в собственном снапшоте остаётся даже под `Stealth` (NET-15):
 * бит своей команды `VisibilitySystem` взводит безусловно (FOW-3).
 *
 * `viewpoint = VIEWPOINT_ALL` — фильтрации нет вовсе.
 */
export function filterSnapshot(
  source: Snapshot | SimulationState,
  viewpoint: number,
  eventVisibility: EventVisibility = relevantEntityVisible,
): Snapshot {
  // Копия всегда: возвращать чужой снапшот значило бы отдать наружу объект,
  // который вызывающий считает своим, а мы — своим результатом.
  const snapshot: Snapshot = isSnapshot(source)
    ? { ...source, world: cloneWorld(source.world), events: [...source.events] }
    : takeSnapshot(source);
  if (viewpoint === VIEWPOINT_ALL) return snapshot;

  const world = snapshot.world;
  const bit = teamBit(viewpoint);
  // Мир без компонента `Visibility` (сцена без FoW) даёт пустой запрос — фильтр
  // тогда ничего не режет, и это верно: скрывать нечего.
  for (const entity of query(world, { all: [VISIBILITY_COMPONENT] })) {
    if ((getField(world, entity, VISIBILITY_COMPONENT, 'visibleTo') & bit) === 0) destroy(world, entity);
  }

  // Видимость события считается по УЖЕ отфильтрованному миру: «сущность есть в
  // этом снапшоте» и «клиент про неё знает» — одно и то же (NET-13).
  const visible = (entity: EntityId): boolean => isAlive(world, entity);
  return { ...snapshot, events: snapshot.events.filter((event) => eventVisibility(event, visible)) };
}
