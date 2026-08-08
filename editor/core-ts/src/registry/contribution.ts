/**
 * Реестр вкладов — механизм расширения редактора (ED-25).
 *
 * Один универсальный реестр на все пять видов вклада, а не пять почти
 * одинаковых классов: виды вклада отличаются тем, что вклад описывает, а не
 * тем, как он хранится. Идиома взята у `SystemRegistry` ядра — регистрация с
 * проверкой однозначности и перечисление в порядке, не зависящем от порядка
 * регистрации.
 *
 * Реестр ничего не исполняет и ничего не рисует: он хранит описания. Поведение
 * вклада (что делает команда, чем рисует область, как проверяет правило)
 * приносит тот слой, который этим поведением владеет: он расширяет интерфейс
 * вклада своим типом и подставляет его параметром реестра. Иначе headless-ядро
 * держало бы у себя типы DOM-слоя, а ED-29 отделяет операции от интерфейса
 * физически (в `lib` пакета нет DOM).
 */

/** Вид вклада — ровно пять из ED-25. Служит префиксом сообщений и ключей. */
export type ContributionKind = 'area' | 'tool' | 'field' | 'command' | 'rule';

/** Общее у всех вкладов: чем вклад адресуем и чем он объяснён человеку. */
export interface Contribution {
  readonly id: string;
  /**
   * Ключ строкового ресурса описания (ED-28). Текста здесь нет: он приходит из
   * бандла и служит описанием и в интерфейсе, и в машинном каталоге (ED-30).
   *
   * Ключ объявлен вкладом, а не вычислен каркасом, и запрету ED-28 это не
   * противоречит: запрещена таблица «поле → ключ», а вычисление предписано «из
   * пути поля в схеме». У вклада схемы нет и пути в ней нет — вычислять не из
   * чего. Ключ здесь той же природы, что `id`: собственное объявление вклада, а
   * не запись соответствия чему-то другому, которая могла бы с ним разойтись.
   * Ключи полей по-прежнему считает `descriptionKey` слоя локалей, и второй
   * точки их вывода в пакете нет.
   */
  readonly descriptionKey: string;
}

/**
 * Сторона реестра, доступная только на чтение. Каталог (ED-30) и интерфейс
 * читают вклады через неё: потребителю чтения незачем уметь регистрировать, а
 * ковариантный по вкладу интерфейс принимает реестр, расширенный слоем выше.
 */
export interface ContributionReader<T extends Contribution> {
  get(id: string): T | undefined;
  has(id: string): boolean;
  all(): readonly T[];
}

export interface ContributionRegistryOptions<T extends Contribution> {
  readonly kind: ContributionKind;
  /**
   * Занимаемый вкладом единоличный ресурс: горячая клавиша области, тип поля
   * для редактора поля, сочетание клавиш команды. Реестр не знает, что это за
   * ресурс, — он знает только, что двое на нём не помещаются.
   */
  readonly claimOf?: (contribution: T) => string | undefined;
  /** Имя ресурса для сообщения об ошибке. */
  readonly claimName?: string;
}

export class ContributionRegistry<T extends Contribution> implements ContributionReader<T> {
  readonly kind: ContributionKind;
  private readonly byId = new Map<string, T>();
  private readonly claimOf: (contribution: T) => string | undefined;
  private readonly claimName: string;
  private ordered: readonly T[] | null = null;

  constructor(options: ContributionRegistryOptions<T>) {
    this.kind = options.kind;
    this.claimOf = options.claimOf ?? (() => undefined);
    this.claimName = options.claimName ?? 'ресурс';
  }

  /**
   * Регистрация вклада. Ничего, кроме самого реестра, при этом не меняется —
   * это и есть ED-25: расширение, правящее уже зарегистрированное или каркас,
   * перестаёт быть расширением на втором же случае.
   */
  register(contribution: T): void {
    const { id } = contribution;
    if (id.length === 0) throw new Error(`${this.kind}: у вклада пустой id`);
    if (this.byId.has(id)) {
      throw new Error(`${this.kind}: вклад "${id}" уже зарегистрирован`);
    }
    checkDescriptionKey(this.kind, contribution);
    this.checkClaim(contribution);
    this.byId.set(id, contribution);
    this.ordered = null;
  }

  /**
   * Подмена вклада по id (та же роль, что у `SystemRegistry.override` в ядре):
   * проект перекрывает редактор поля или команду редактора, не заводя второй
   * вклад с тем же назначением. Подмена отсутствующего — ошибка, а не тихая
   * регистрация: молчаливое расхождение имён обнаружилось бы отсутствием
   * поведения, а не отказом.
   */
  override(contribution: T): void {
    const { id } = contribution;
    if (!this.byId.has(id)) {
      throw new Error(`${this.kind}: override вклада "${id}", который не зарегистрирован`);
    }
    this.byId.delete(id);
    checkDescriptionKey(this.kind, contribution);
    this.checkClaim(contribution);
    this.byId.set(id, contribution);
    this.ordered = null;
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Вклады в порядке, не зависящем от порядка регистрации: последовательность
   * вызовов `register` — свойство кода, собирающего редактор, а не набора
   * вкладов, а машинный каталог (ED-30) обязан быть одним и тем же при любой
   * сборке. Сравнение — по кодовым точкам, а не `localeCompare`: локаль
   * пользователя не влияет на машинный выход (ED-27).
   */
  all(): readonly T[] {
    this.ordered ??= [...this.byId.values()].sort((a, b) => compareIds(a.id, b.id));
    return this.ordered;
  }

  private checkClaim(contribution: T): void {
    const claim = this.claimOf(contribution);
    if (claim === undefined) return;
    for (const other of this.byId.values()) {
      if (this.claimOf(other) === claim) {
        throw new Error(
          `${this.kind}: ${this.claimName} "${claim}" — за вкладом "${other.id}",` +
            ` на неё же претендует "${contribution.id}"`,
        );
      }
    }
  }
}

/**
 * Ключ описания обязателен: вклад без него попадёт в машинный каталог (ED-30)
 * с пустым описанием, а пустое описание неотличимо от отсутствующего — то
 * самое прятание отсутствия, которое ED-28 запрещает показом самого ключа.
 * Проверка при регистрации, а не при сборке каталога: отказ обязан приходить
 * тому, кто вклад пишет, а не тому, кто его читает.
 */
function checkDescriptionKey(kind: ContributionKind, contribution: Contribution): void {
  if (contribution.descriptionKey.trim() === '') {
    throw new Error(`${kind}: у вклада "${contribution.id}" пустой ключ описания`);
  }
}

/** Порядок кодовых точек: одинаков в любой локали и в любой среде. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
