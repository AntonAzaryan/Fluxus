/**
 * Анимационный контроллер инстанса (REND-4): механизм в коде, маппинг в данных.
 *
 * Механизм — разрешение записи манифеста в клип модели, loop/one-shot,
 * кроссфейд, возврат в локомоцию после one-shot (перенос `play()` прототипа).
 * Политика — таблицы манифеста «состояние → клип» и «событие → one-shot клип»
 * (ASSET-6); привязка конкретных клипов к состояниям и событиям кодом не
 * задаётся.
 */
import * as THREE from 'three';

/**
 * Итог разрешения записи манифеста в клип (REND-4). Не `clip | null`: чтобы
 * предупреждение назвало причину, вызывающему нужно отличить запись, не
 * совпавшую ни с чем (опечатка), от записи, совпавшей с несколькими клипами —
 * и во втором случае знать, с какими именно.
 */
export type ClipResolution =
  | { readonly status: 'resolved'; readonly clip: THREE.AnimationClip }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly string[] };

/**
 * Запись манифеста → клип модели: сперва точное совпадение имени, затем
 * единственное совпадение по подстроке; регистр не учитывается (REND-4).
 *
 * Обе фазы — полные проходы, а не `find` с ранним выходом: неоднозначность
 * видна только по всем кандидатам сразу, а именно она была источником дефекта
 * «`Idle` тихо разрешался в `2H_Melee_Idle`» — исход зависел от того, в каком
 * порядке экспортёр разложил секвенции. Клипов у модели десятки, а проход идёт
 * при смене состояния, а не в кадре, поэтому цена полного прохода неощутима.
 *
 * Фолбэка на первый клип модели здесь нет намеренно: тихая подмена клипа —
 * ровно то, что REND-4 запрещает, а порядок клипов задаёт файл модели, а не
 * автор манифеста.
 */
export function resolveClip(
  clips: readonly THREE.AnimationClip[],
  entry: string,
): ClipResolution {
  const needle = entry.toLowerCase();

  // Фаза 1: точное совпадение. Оно обязано бить совпадение по подстроке, иначе
  // на модель, где имя одного клипа — подстрока имени другого, на первый клип
  // сослаться нечем (REND-4).
  const exact = clips.filter((clip) => clip.name.toLowerCase() === needle);
  if (exact.length === 1) return { status: 'resolved', clip: exact[0]! };
  // Два клипа с одним именем: точную ссылку выразить нечем — это та же
  // неоднозначность, а не повод выбрать любой из них.
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.map((clip) => clip.name) };

  // Фаза 2: подстрока. Остаётся потому, что у MDX-моделей имена секвенций несут
  // суффиксы вариантов (`Attack Slam`, `Attack Slam Two`), и подстрока — рабочий
  // способ сослаться на семейство; достаточно, чтобы точное совпадение её било.
  const partial = clips.filter((clip) => clip.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { status: 'resolved', clip: partial[0]! };
  if (partial.length === 0) return { status: 'missing' };
  return { status: 'ambiguous', candidates: partial.map((clip) => clip.name) };
}

/** Маппинг манифеста визуалов (ASSET-6): состояние → клип, событие → one-shot клип. */
export interface AnimationMapping {
  readonly states?: Readonly<Record<string, string>>;
  readonly events?: Readonly<Record<string, string>>;
}

export interface AnimationControllerOptions {
  /** Длительность кроссфейда, секунды. */
  readonly crossfade?: number;
  /** Тип события смерти — конвенция ядра (`EntityDied`), клип же берётся из манифеста. */
  readonly deathEvent?: string;
  /** Куда писать предупреждения о неразрешённых записях; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const DEFAULT_CROSSFADE = 0.15;
const DEFAULT_DEATH_EVENT = 'EntityDied';

export class AnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips: readonly THREE.AnimationClip[];
  private readonly mapping: AnimationMapping;
  private readonly crossfade: number;
  private readonly deathEvent: string;
  private readonly warn: (message: string) => void;
  /**
   * Записи манифеста, о которых уже предупредили. Дедуп идёт по самой записи,
   * а не по состоянию или событию: `setState` зовут на каждой смене состояния,
   * и без дедупликации одна опечатка затопила бы консоль (REND-4, тот же
   * контракт, что у отсутствующей кости в REND-5).
   */
  private readonly warnedEntries = new Set<string>();

  /** Активное действие (то, что сейчас вкроссфейжено). */
  private active: THREE.AnimationAction | null = null;
  /** Проигрываемый one-shot; по завершении возвращаемся в локомоцию. */
  private oneShot: THREE.AnimationAction | null = null;
  /** Текущее состояние локомоции ('idle'/'move' в MVP). */
  private state: string | null = null;
  /** Клип, назначенный набором инстансов поверх состояния (REND-11); undefined — не назначен. */
  private override: string | undefined = undefined;
  private dead = false;

  constructor(
    mixer: THREE.AnimationMixer,
    clips: readonly THREE.AnimationClip[],
    mapping: AnimationMapping,
    options: AnimationControllerOptions = {},
  ) {
    this.mixer = mixer;
    this.clips = clips;
    this.mapping = mapping;
    this.crossfade = options.crossfade ?? DEFAULT_CROSSFADE;
    this.deathEvent = options.deathEvent ?? DEFAULT_DEATH_EVENT;
    this.warn = options.warn ?? ((message) => console.warn(message));
    // LoopOnce-действие сообщает о конце через микшер — здесь возврат в локомоцию.
    this.mixer.addEventListener('finished', (event) => {
      if (event.action !== this.oneShot) return;
      this.oneShot = null;
      if (!this.dead) this.resumeLoop();
    });
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Имя активного клипа — для тестов и отладки. */
  get currentClipName(): string | null {
    return this.active?.getClip().name ?? null;
  }

  /**
   * Состояние локомоции из данных тика (REND-4). Пока играет one-shot, смена
   * запоминается и применяется по его завершении; после смерти игнорируется.
   */
  setState(state: string): void {
    if (this.dead || this.state === state) return;
    this.state = state;
    // Назначенный клип бьёт состояние: в документном режиме состояние всё равно
    // производить не из чего, а в игровом override не ставится (REND-11).
    if (this.oneShot !== null || this.override !== undefined) return;
    this.playState(state);
  }

  /**
   * Клип, назначенный набором инстансов (REND-11): играет зацикленно поверх
   * состояния и разрешается по тем же правилам, что запись манифеста (REND-4).
   * `undefined` снимает назначение и возвращает клип текущего состояния —
   * умолчание документного набора и единственное, что видит поток тиков.
   */
  setClipOverride(entry: string | undefined): void {
    if (this.override === entry) return;
    this.override = entry;
    if (this.dead || this.oneShot !== null) return;
    this.resumeLoop();
  }

  /**
   * Событие тика → one-shot клип по таблице манифеста. Возвращает false, если
   * событие не замаплено. Событие смерти — one-shot с фиксацией последнего
   * кадра навсегда (REND-4).
   */
  handleEvent(type: string): boolean {
    if (this.dead) return false;
    const entry = this.mapping.events?.[type];
    if (entry === undefined) return false;
    const clip = this.clipFor(entry);
    // Запись есть, но не разрешилась — предупреждение уже выдано, one-shot не
    // играем: текущий клип остаётся, произвольный не подставляется (REND-4).
    if (clip === null) return false;

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true; // держим последний кадр до возврата в локомоцию
    this.fadeTo(action);
    this.oneShot = action;
    if (type === this.deathEvent) this.dead = true;
    return true;
  }

  /** Покадровое продвижение микшера; здесь же срабатывает возврат из one-shot. */
  update(dt: number): void {
    this.mixer.update(dt);
  }

  /** Зацикленный клип, к которому возвращаются: назначенный набором либо клип состояния. */
  private resumeLoop(): void {
    if (this.override !== undefined) {
      this.playLoop(this.override);
      return;
    }
    this.playState(this.state);
  }

  private playState(state: string | null): void {
    if (state === null) return;
    const entry = this.mapping.states?.[state];
    // Нет записи в манифесте — нет смены и нет диагностики: отсутствие записи
    // не ошибка (REND-4), политика в данных, а не фолбэк в коде. Предупреждает
    // только запись, которая есть, но ни во что не разрешается.
    if (entry === undefined) return;
    this.playLoop(entry);
  }

  private playLoop(entry: string): void {
    const clip = this.clipFor(entry);
    if (clip === null) return;

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    this.fadeTo(action);
  }

  /**
   * Запись манифеста → клип, либо null с предупреждением, называющим запись
   * (REND-4). Тот же контракт, что у ссылки на отсутствующую кость в REND-5:
   * диагностировать и пропустить, а не подставить что-нибудь молча.
   */
  private clipFor(entry: string): THREE.AnimationClip | null {
    const resolution = resolveClip(this.clips, entry);
    if (resolution.status === 'resolved') return resolution.clip;
    if (!this.warnedEntries.has(entry)) {
      this.warnedEntries.add(entry);
      this.warn(
        resolution.status === 'ambiguous'
          ? `render: запись анимации "${entry}" совпала по подстроке с несколькими клипами (${resolution.candidates.join(', ')}) — клип не сменён (REND-4)`
          : `render: запись анимации "${entry}" не совпала ни с одним клипом модели — клип не сменён (REND-4)`,
      );
    }
    return null;
  }

  private fadeTo(next: THREE.AnimationAction): void {
    const previous = this.active;
    next.reset().fadeIn(this.crossfade).play();
    if (previous !== null && previous !== next) previous.fadeOut(this.crossfade);
    this.active = next;
  }
}
