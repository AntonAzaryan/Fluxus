/**
 * Индекс точек маршрута (`npc-behavior` NPC-6): «маршрут R, точка N» → сущность.
 *
 * Маршрут — waypoint-ДАННЫЕ СЦЕНЫ: обычные сущности её начального состояния с
 * компонентом `Waypoint` рядом с позицией. Схему сцены это не расширяет, а
 * поиск пути не требуется вовсе — сцена без Navigation API тикает с NPC штатно
 * (DI-4, NAV-6).
 *
 * Индекс снимается один раз на прогон системы и живёт до его конца: он
 * производен от мира, состоянием симуляции не является и в снапшот не входит.
 *
 * Карта переиспользуется (`clear`, а не пересоздание), но запись в неё на
 * каждое наполнение — аллокация, и она здесь ОСТАВЛЕНА сознательно: величина
 * её — число точек маршрута, то есть данные сцены, которых у арены единицы, а
 * не число агентов. Аллокационная дисциплина ядра запрещает рост,
 * пропорциональный числу СУЩНОСТЕЙ, — сетка соседей (`grid.ts`) поэтому и
 * обходится открытой адресацией в типизированных массивах, а маршруты нет.
 *
 * ponytail: если у арены появятся сотни ориентиров, индекс переезжает на ту же
 * открытую адресацию — по профилю на реальной сцене, а не по вкусу.
 */
import { WAYPOINT_COMPONENT } from './components.js';
import type { NpcHandles } from './handles.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type SystemContext } from '../../types.js';

/**
 * Шаг ключа по маршруту. Номер точки в маршруте меньше него по построению
 * документа: маршрут — цепочка ориентиров дизайнера, а не траектория.
 */
const ROUTE_STRIDE = 4096;

export class NpcRoutes {
  private readonly points = new Map<number, EntityId>();
  private spec: QuerySpec | undefined;

  /** Снимает точки маршрутов текущего мира. */
  rebuild(ctx: SystemContext, position: string, handles: NpcHandles): void {
    this.spec ??= { all: [WAYPOINT_COMPONENT, position] };
    this.points.clear();
    for (const entity of ctx.query(this.spec)) {
      const route = ctx.getByHandle(entity, handles.waypointRoute);
      const index = ctx.getByHandle(entity, handles.waypointIndex);
      // Две точки на одном номере — опечатка расстановки; побеждает первая по
      // порядку обхода (QUERY-2), то есть исход остаётся детерминированным.
      const key = route * ROUTE_STRIDE + index;
      if (!this.points.has(key)) this.points.set(key, entity);
    }
  }

  /**
   * Точка маршрута; `NO_ENTITY` — маршрут кончился либо точки нет. Единственный
   * вопрос, который платформе к маршруту нужен: и следование, и вход
   * `routeRemaining`, и условие `routeDone` выражаются им одним, а «сколько
   * всего точек» не спрашивает никто — считать его на каждое наполнение значило
   * бы платить за ответ, которого не ждут.
   */
  at(route: number, index: number): EntityId {
    return this.points.get(route * ROUTE_STRIDE + index) ?? NO_ENTITY;
  }
}
