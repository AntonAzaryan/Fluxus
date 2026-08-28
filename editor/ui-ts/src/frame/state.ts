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
 *
 * Запись принадлежит вкладу, а не его идентификатору. Разница видна ровно в
 * одном случае, и случай этот реальный: реестр вкладов умеет подмену по id
 * (`ContributionRegistry.override` — так проект перекрывает вклад редактора).
 * Подменивший вклад — другая область с другим состоянием, и отдать ему чужую
 * запись значило бы соврать в том самом единственном приведении типа: поля,
 * которых он ждёт, пришли бы от предшественника. Поэтому смена вклада заводит
 * новую запись, а «та же область» по-прежнему получает свою (ED-23).
 */
import type { AreaSetup, AreaState, WorkspaceArea } from './area.js';

export interface AreaStateStore {
  /** Запись области: заводится при первом обращении, дальше отдаётся та же. */
  of<S extends AreaState>(area: WorkspaceArea<S>, setup: AreaSetup): S;
  /**
   * Уже заведённая запись — или `undefined`, если её ещё нет. Спрашивает тот,
   * кому запись нужна, только если она существует: заводить её ради вопроса
   * значило бы открыть документы области, в которую автор ещё не входил.
   */
  peek(area: WorkspaceArea): AreaState | undefined;
}

interface AreaRecord {
  readonly area: WorkspaceArea;
  readonly state: AreaState;
}

export function createAreaStateStore(): AreaStateStore {
  const records = new Map<string, AreaRecord>();
  return {
    of<S extends AreaState>(area: WorkspaceArea<S>, setup: AreaSetup): S {
      const existing = records.get(area.id);
      if (existing?.area === area) return existing.state as S;
      const created = area.createState(setup);
      records.set(area.id, { area, state: created });
      return created;
    },
    peek(area: WorkspaceArea): AreaState | undefined {
      const existing = records.get(area.id);
      return existing?.area === area ? existing.state : undefined;
    },
  };
}
