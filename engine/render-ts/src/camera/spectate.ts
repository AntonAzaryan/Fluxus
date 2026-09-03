/**
 * Субъект наблюдения (CAM-10): за кем смотрит тот, кто в матче не играет —
 * зритель полного потока (`netcode-transport` NTR-9), отладка, будущий реплей.
 *
 * Входом конвейера, а не четвёртым режимом, и это несущее: вести сущность
 * follow (CAM-2) уже умеет — со сглаживанием, порогом рывка (CAM-5) и высотой
 * по поверхности. Наблюдателю не хватает не второго способа вести камеру, а
 * ОТВЕТА на вопрос «за кем»; четвёртый режим повторил бы follow целиком.
 *
 * Кандидаты отбираются по ОБЪЯВЛЕННОМУ стату (CAM-10): имя стата принадлежит
 * контенту (`match-hud` HUD-8), а не коду камеры. Второй объявленный стат —
 * команда — приезжает вместе с субъектом: показывать её или нет, решает
 * потребитель.
 *
 * Вход — только доставленное presentation-состояние (`rendering` REND-1):
 * ничего в мир отсюда не уходит, и своего канала к нему нет (CAM-1).
 */
import type { EntityId } from '@fluxus/core';

/** Сущность глазами перебора — структурный минимум доставленной записи. */
export interface SpectatorEntityView {
  readonly id: EntityId;
  /** Именованные доставленные статы (HUD-8); нет словаря — нет и кандидата. */
  readonly stats?: ReadonlyMap<string, number>;
}

export interface SpectatorSubjectsOptions {
  /**
   * Стат, наличие которого делает сущность кандидатом (CAM-10). Имя — вход, а
   * не константа: «кто здесь игрок» знает контент, а не камера.
   */
  readonly playerStat: string;
  /** Стат команды; объявлен — субъект несёт её значение, нет — команда null. */
  readonly teamStat?: string;
}

/** Текущий субъект наблюдения; `team` — null, если стат команды не объявлен либо не доставлен. */
export interface SpectatorSubject {
  readonly entity: EntityId;
  readonly team: number | null;
}

/**
 * Перебор субъектов наблюдения (CAM-10).
 *
 * Порядок — по возрастанию идентификатора: он детерминирован и не зависит ни от
 * порядка обхода доставленной карты, ни от того, кто когда появился. Перебор
 * цикличен в обе стороны.
 *
 * Смена состава субъекта не меняет: пока текущий есть в доставке, он остаётся
 * текущим. Это та же сторона CAM-5, которой free-камера обязана не реагировать
 * на откат, — только применённая к выбору, а не к позе: перемотка переставляет
 * сущности, но смотреть зритель продолжает за тем же.
 */
export class SpectatorSubjects {
  private readonly options: SpectatorSubjectsOptions;
  /** Кандидаты этой доставки, по возрастанию id. Буфер переиспользуется. */
  private readonly ids: EntityId[] = [];
  /** Команды кандидатов — параллельно `ids`; null-эквивалент здесь `NaN`. */
  private readonly teams: number[] = [];
  private currentId: EntityId | null = null;
  /** Запись субъекта переиспользуется: `current` спрашивают покадрово. */
  private readonly subject = { entity: 0 as EntityId, team: null as number | null };

  constructor(options: SpectatorSubjectsOptions) {
    this.options = options;
  }

  /** Кандидаты последней доставки в порядке перебора (CAM-10) — вход тестов и панели. */
  get candidates(): readonly EntityId[] {
    return this.ids;
  }

  /**
   * Текущий субъект; null — кандидатов нет. Это ОТВЕТ, а не отказ: потребитель
   * показывает то же, что показывал бы без цели (CAM-10).
   */
  get current(): SpectatorSubject | null {
    if (this.currentId === null) return null;
    const at = this.ids.indexOf(this.currentId);
    if (at < 0) return null;
    this.subject.entity = this.currentId;
    const team = this.teams[at] ?? Number.NaN;
    this.subject.team = Number.isNaN(team) ? null : team;
    return this.subject;
  }

  /**
   * Пересчёт по доставленному состоянию (REND-1). Зовётся на доставку, а не на
   * кадр: состав кандидатов меняется вместе с миром, а не с картинкой.
   *
   * Текущий субъект переживает пересчёт, пока он в доставке есть; исчезнувший
   * заменяется СЛЕДУЮЩИМ по порядку — тем, кто занял бы его место при переборе,
   * — а не первым попавшимся: зритель, у которого убили наблюдаемого, остаётся
   * там же, где смотрел.
   */
  sync(entities: Iterable<SpectatorEntityView>): void {
    const previous = this.currentId;
    this.ids.length = 0;
    this.teams.length = 0;
    for (const entity of entities) {
      const stats = entity.stats;
      if (stats?.has(this.options.playerStat) !== true) continue;
      // Вставка с сохранением порядка: кандидатов единицы (участники матча), и
      // сортировка целого массива на каждую доставку была бы дороже.
      const team = this.teamOf(stats);
      let at = this.ids.length;
      while (at > 0 && (this.ids[at - 1] ?? 0) > entity.id) at -= 1;
      this.ids.splice(at, 0, entity.id);
      this.teams.splice(at, 0, team);
    }
    if (previous !== null && this.ids.includes(previous)) return;
    this.currentId = previous === null ? (this.ids[0] ?? null) : this.afterMissing(previous);
  }

  /** Следующий кандидат по кругу; null — кандидатов нет. */
  next(): SpectatorSubject | null {
    return this.step(1);
  }

  /** Предыдущий кандидат по кругу; null — кандидатов нет. */
  prev(): SpectatorSubject | null {
    return this.step(-1);
  }

  /**
   * Наблюдать за названной сущностью; false — её среди кандидатов нет, и
   * текущий субъект не тронут: молчаливая подмена цели была бы хуже отказа.
   */
  select(entity: EntityId): boolean {
    if (!this.ids.includes(entity)) return false;
    this.currentId = entity;
    return true;
  }

  /** Снять наблюдение: субъекта нет, перебор начнётся с первого кандидата. */
  clear(): void {
    this.currentId = null;
  }

  // ------------------------------------------------------------ внутреннее

  private teamOf(stats: ReadonlyMap<string, number>): number {
    const name = this.options.teamStat;
    if (name === undefined) return Number.NaN;
    return stats.get(name) ?? Number.NaN;
  }

  /** Место исчезнувшего субъекта занимает следующий за ним по порядку (CAM-10). */
  private afterMissing(previous: EntityId): EntityId | null {
    for (const id of this.ids) {
      if (id > previous) return id;
    }
    return this.ids[0] ?? null;
  }

  private step(direction: 1 | -1): SpectatorSubject | null {
    if (this.ids.length === 0) {
      this.currentId = null;
      return null;
    }
    const at = this.currentId === null ? -1 : this.ids.indexOf(this.currentId);
    // Субъекта не было — перебор начинается с первого при шаге вперёд и с
    // последнего при шаге назад: обе стороны круга симметричны.
    const from = at < 0 ? (direction === 1 ? this.ids.length - 1 : 0) : at;
    const size = this.ids.length;
    const next = (from + direction + size) % size;
    this.currentId = this.ids[next] ?? null;
    return this.current;
  }
}
