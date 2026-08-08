/**
 * Хранилище записей состояния областей — то, чем каркас выполняет ED-23
 * («состояние рабочей области <…> SHALL переживать переключение на другую
 * область и обратно»), ничего не зная о самом состоянии.
 *
 * Хранилище отдаёт ту же запись, а не равную ей: область, положившая в свою
 * запись позу камеры и множество раскрытых узлов, находит их на месте по
 * ссылке, не сериализуя и не сравнивая. Отсюда же — почему приведение типа
 * здесь одно и здесь же: наружу запись выходит своим типом, внутри лежит
 * пустым `AreaState`, и это ровно та граница, на которой каркас перестаёт
 * понимать содержимое.
 */
import type { AreaSetup, AreaState, WorkspaceArea } from './area.js';

export interface AreaStateStore {
  /** Запись области: заводится при первом обращении, дальше отдаётся та же. */
  of<S extends AreaState>(area: WorkspaceArea<S>, setup: AreaSetup): S;
  /** Запись по идентификатору — для тех, у кого вклада на руках нет. */
  get(areaId: string): AreaState | undefined;
  /** Области, у которых запись уже заведена, — то есть посещённые. */
  ids(): readonly string[];
}

export function createAreaStateStore(): AreaStateStore {
  const records = new Map<string, AreaState>();
  return {
    of<S extends AreaState>(area: WorkspaceArea<S>, setup: AreaSetup): S {
      const existing = records.get(area.id);
      if (existing !== undefined) return existing as S;
      const created = area.createState(setup);
      records.set(area.id, created);
      return created;
    },
    get: (areaId) => records.get(areaId),
    ids: () => [...records.keys()],
  };
}
