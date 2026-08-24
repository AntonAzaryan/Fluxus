/**
 * Анимационный контроллер инстанса (REND-4): механизм в коде, маппинг в данных.
 *
 * Механизм — разрешение записи манифеста в клип модели, loop/one-shot,
 * кроссфейд, возврат в локомоцию после one-shot (перенос `play()` прототипа).
 * Политика — таблицы манифеста «состояние → клип» и «событие → one-shot клип»
 * (ASSET-6); привязка конкретных клипов к состояниям и событиям кодом не
 * задаётся.
 *
 * МАШИНА СОСТОЯНИЙ ОДНА НА ОБА ЯРУСА (REND-20). Носитель воспроизведения —
 * `AnimationBackend`: у детального инстанса это `THREE.AnimationMixer` со
 * скелетом (`MixerAnimationBackend`), у батчевой записи — пара скаляров
 * «строка VAT + вес перехода» (`VatAnimationBackend`, `vatAnimation.ts`).
 * Разводить машину по ярусам было бы двумя реализациями REND-4, а требование
 * прямо велит поведению ярусов совпадать: одно и то же событие обязано дать
 * один и тот же клип независимо от того, чем инстанс нарисован.
 */
import * as THREE from 'three';

/**
 * Клип с точки зрения разрешения записи манифеста (REND-4): имя — всё, что
 * механизму нужно. Так одна реализация разрешения обслуживает и клипы THREE
 * детального яруса, и запечённые клипы батчевого (`assets` ASSET-12).
 */
export interface NamedClip {
  readonly name: string;
}

/**
 * Итог разрешения записи манифеста в клип (REND-4). Не `clip | null`: чтобы
 * предупреждение назвало причину, вызывающему нужно отличить запись, не
 * совпавшую ни с чем (опечатка), от записи, совпавшей с несколькими клипами —
 * и во втором случае знать, с какими именно.
 */
export type ClipResolution<TClip extends NamedClip = THREE.AnimationClip> =
  | { readonly status: 'resolved'; readonly clip: TClip; readonly index: number }
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
export function resolveClip<TClip extends NamedClip>(
  clips: readonly TClip[],
  entry: string,
): ClipResolution<TClip> {
  const needle = entry.toLowerCase();

  // Фаза 1: точное совпадение. Оно обязано бить совпадение по подстроке, иначе
  // на модель, где имя одного клипа — подстрока имени другого, на первый клип
  // сослаться нечем (REND-4).
  const exact = indicesOf(clips, (name) => name === needle);
  if (exact.length === 1) return resolved(clips, exact[0]!);
  // Два клипа с одним именем: точную ссылку выразить нечем — это та же
  // неоднозначность, а не повод выбрать любой из них.
  if (exact.length > 1) return ambiguous(clips, exact);

  // Фаза 2: подстрока. Остаётся потому, что у MDX-моделей имена секвенций несут
  // суффиксы вариантов (`Attack Slam`, `Attack Slam Two`), и подстрока — рабочий
  // способ сослаться на семейство; достаточно, чтобы точное совпадение её било.
  const partial = indicesOf(clips, (name) => name.includes(needle));
  if (partial.length === 1) return resolved(clips, partial[0]!);
  if (partial.length === 0) return { status: 'missing' };
  return ambiguous(clips, partial);
}

function indicesOf(
  clips: readonly NamedClip[],
  match: (lowerName: string) => boolean,
): number[] {
  const found: number[] = [];
  clips.forEach((clip, index) => {
    if (match(clip.name.toLowerCase())) found.push(index);
  });
  return found;
}

function resolved<TClip extends NamedClip>(
  clips: readonly TClip[],
  index: number,
): ClipResolution<TClip> {
  return { status: 'resolved', clip: clips[index]!, index };
}

function ambiguous<TClip extends NamedClip>(
  clips: readonly TClip[],
  indices: readonly number[],
): ClipResolution<TClip> {
  return { status: 'ambiguous', candidates: indices.map((index) => clips[index]!.name) };
}

// ------------------------------------------------------------------ бэкенд

/**
 * Носитель воспроизведения клипа — то единственное, чем ярусы (REND-20)
 * различаются в анимации. Контроллер знает про клипы только их номер: имена
 * разрешаются здесь же, в машине, а как номер превращается в позу — дело
 * бэкенда.
 */
export interface AnimationBackend {
  /** Клипы модели в порядке индексов — вход разрешения записи (REND-4). */
  readonly clips: readonly NamedClip[];
  /** Индекс звучащего клипа; -1 — ни одного. */
  readonly currentClip: number;
  /** Зацикленный клип с кроссфейдом от того, что звучало. */
  playLoop(index: number, crossfade: number): void;
  /** One-shot с фиксацией последнего кадра до возврата в локомоцию. */
  playOnce(index: number, crossfade: number): void;
  /**
   * Покадровое продвижение; здесь же срабатывает завершение one-shot. `dt` —
   * часы презентации СО ЗНАКОМ (REND-25): вперёд, стоп либо назад. При
   * обратном ходе завершением считается возврат one-shot к НАЧАЛУ клипа —
   * бэкенд зовёт тот же `onOneShotFinished`, и машина возвращает клип
   * состояния тем же путём, что после конца вперёд.
   */
  update(dt: number): void;
  /**
   * Кого звать по завершении one-shot; ставит контроллер при создании.
   * Обратный вызов, а не флаг, потому что момент завершения знает бэкенд
   * (микшер сообщает событием, скаляры — переполнением фазы), а решение
   * «возвращаться ли в локомоцию» принимает машина.
   */
  onOneShotFinished: (() => void) | null;
}

/** Бэкенд детального яруса: `THREE.AnimationMixer` поверх скелета инстанса. */
export class MixerAnimationBackend implements AnimationBackend {
  onOneShotFinished: (() => void) | null = null;

  readonly clips: readonly THREE.AnimationClip[];
  private readonly mixer: THREE.AnimationMixer;
  /** Активное действие (то, что сейчас вкроссфейжено). */
  private active: THREE.AnimationAction | null = null;
  /** Проигрываемый one-shot; по завершении о нём сообщает микшер. */
  private oneShot: THREE.AnimationAction | null = null;
  private current = -1;
  /**
   * Действия, заведённые этим бэкендом: по ним разносится направление хода
   * (REND-25). Набор ограничен числом клипов модели и растёт только на смене
   * клипа, а не в кадре.
   */
  private readonly actions = new Set<THREE.AnimationAction>();
  /** Знак хода клипов: +1 — вперёд, −1 — назад. Ноль часов — не направление, а стоп. */
  private direction = 1;

  constructor(mixer: THREE.AnimationMixer, clips: readonly THREE.AnimationClip[]) {
    this.mixer = mixer;
    this.clips = clips;
    // LoopOnce-действие сообщает о конце через микшер — здесь возврат в
    // локомоцию. При обратном ходе микшер шлёт то же событие по достижении
    // НАЧАЛА клипа (`direction: -1`), и развязка у машины одна на оба случая.
    this.mixer.addEventListener('finished', (event) => {
      if (event.action !== this.oneShot) return;
      this.oneShot = null;
      this.onOneShotFinished?.();
    });
  }

  get currentClip(): number {
    return this.current;
  }

  playLoop(index: number, crossfade: number): void {
    const action = this.claim(index);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    this.fadeTo(action, crossfade);
    this.current = index;
  }

  playOnce(index: number, crossfade: number): void {
    const action = this.claim(index);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true; // держим последний кадр до возврата в локомоцию
    this.fadeTo(action, crossfade);
    this.oneShot = action;
    this.current = index;
  }

  /**
   * Кадр микшера. Направление берёт ДЕЙСТВИЕ (`timeScale`), а сам микшер идёт
   * вперёд по модулю: его часы ведут не только фазы клипов, но и конверты
   * кроссфейдов, и отмотай мы их назад — начатый переход завис бы на входном
   * весе до конца перемотки. Пауза (`dt === 0`) останавливает и то и другое.
   */
  update(dt: number): void {
    const direction = dt < 0 ? -1 : 1;
    if (direction !== this.direction) {
      this.direction = direction;
      for (const action of this.actions) action.timeScale = direction;
    }
    this.mixer.update(Math.abs(dt));
  }

  /** Действие клипа под учётом бэкенда: ход у него — общий текущий (REND-25). */
  private claim(index: number): THREE.AnimationAction {
    const action = this.mixer.clipAction(this.clips[index]!);
    action.timeScale = this.direction;
    this.actions.add(action);
    return action;
  }

  private fadeTo(next: THREE.AnimationAction, crossfade: number): void {
    const previous = this.active;
    next.reset().fadeIn(crossfade).play();
    if (previous !== null && previous !== next) previous.fadeOut(crossfade);
    this.active = next;
  }
}

// -------------------------------------------------------------- контроллер

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
  /**
   * Тип события возрождения — то, что снимает фиксацию последнего кадра клипа
   * смерти (REND-4). Умолчания у него нет и быть не может: смерть — конвенция
   * ядра, а возрождение описывает СЦЕНА (в демо это `HeroRespawned` системы
   * `Respawn`), и назвать его вправе только сборка. Не названо — фиксация
   * снимается по-прежнему только разрывом непрерывности (`onSnap`, REND-2).
   */
  readonly reviveEvent?: string;
  /** Куда писать предупреждения о неразрешённых записях; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const DEFAULT_CROSSFADE = 0.15;
const DEFAULT_DEATH_EVENT = 'EntityDied';

export class AnimationController {
  private readonly backend: AnimationBackend;
  /** Таблицы манифеста; переподаваемы вместе с ним (REND-17). */
  private mapping: AnimationMapping;
  private readonly crossfade: number;
  private readonly deathEvent: string;
  /** Имя события возрождения; null — сборка его не назвала (REND-4). */
  private readonly reviveEvent: string | null;
  private readonly warn: (message: string) => void;
  /**
   * Записи манифеста, о которых уже предупредили. Дедуп идёт по самой записи,
   * а не по состоянию или событию: `setState` зовут на каждой смене состояния,
   * и без дедупликации одна опечатка затопила бы консоль (REND-4, тот же
   * контракт, что у отсутствующей кости в REND-5).
   */
  private readonly warnedEntries = new Set<string>();

  /** Идёт one-shot: смены состояния копятся и применяются по его завершении. */
  private oneShotPlaying = false;
  /** Текущее состояние локомоции (сейчас 'idle'/'move'). */
  private state: string | null = null;
  /** Клип, назначенный набором инстансов поверх состояния (REND-11); undefined — не назначен. */
  private override: string | undefined = undefined;
  private dead = false;

  constructor(
    backend: AnimationBackend,
    mapping: AnimationMapping,
    options: AnimationControllerOptions = {},
  ) {
    this.backend = backend;
    this.mapping = mapping;
    this.crossfade = options.crossfade ?? DEFAULT_CROSSFADE;
    this.deathEvent = options.deathEvent ?? DEFAULT_DEATH_EVENT;
    this.reviveEvent = options.reviveEvent ?? null;
    this.warn = options.warn ?? ((message) => { console.warn(message); });
    backend.onOneShotFinished = (): void => {
      this.oneShotPlaying = false;
      if (!this.dead) this.resumeLoop();
    };
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Имя активного клипа — для тестов и отладки. */
  get currentClipName(): string | null {
    const index = this.backend.currentClip;
    return index < 0 ? null : (this.backend.clips[index]?.name ?? null);
  }

  /**
   * Состояние локомоции из данных тика (REND-4). Пока играет one-shot, смена
   * запоминается и применяется по его завершении; так же и под фиксацией
   * смерти — труп клипа не меняет, но состояние копится: возрождение обязано
   * вернуть модель в клип ТЕКУЩЕГО состояния, а не того, в котором её застала
   * смерть.
   */
  setState(state: string): void {
    if (this.state === state) return;
    this.state = state;
    // Назначенный клип бьёт состояние: в документном режиме состояние всё равно
    // производить не из чего, а в игровом override не ставится (REND-11).
    if (this.dead || this.oneShotPlaying || this.override !== undefined) return;
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
    if (this.dead || this.oneShotPlaying) return;
    this.resumeLoop();
  }

  /**
   * Таблицы правленого манифеста поверх живого контроллера (REND-17): фаза
   * клипа и назначенный набором клип (REND-11) переживают подмену.
   *
   * Клип переигрывается ТОЛЬКО если сменилась запись, которая играла бы сейчас:
   * редактор отдаёт манифест на каждую правку, включая правку клипа состояния,
   * в котором инстанс не находится, и безусловное `resumeLoop` сбрасывало бы
   * фазу анимации на ровном месте. Дедупликация предупреждений идёт по самой
   * записи и не сбрасывается — та же строка второй раз консоль не топит (REND-4).
   */
  setMapping(mapping: AnimationMapping): void {
    const before = this.playingEntry();
    this.mapping = mapping;
    if (this.dead || this.oneShotPlaying) return;
    if (this.playingEntry() === before) return;
    this.resumeLoop();
  }

  /** Запись манифеста, звучащая сейчас: назначенный клип бьёт состояние (REND-11). */
  private playingEntry(): string | undefined {
    if (this.override !== undefined) return this.override;
    return this.state === null ? undefined : this.mapping.states?.[this.state];
  }

  /**
   * Событие тика → one-shot клип по таблице манифеста. Возвращает false, если
   * событие ничего не изменило. Событие смерти — one-shot с фиксацией
   * последнего кадра, событие возрождения эту фиксацию снимает (REND-4).
   */
  handleEvent(type: string): boolean {
    // Возрождение разбирается ДО гейта смерти: под фиксацией контроллер не
    // слышит событий вовсе, и событие, которое обязано её снять, — единственное
    // исключение. Оно же остаётся обычным событием: назвал манифест ему клип —
    // клип и сыграет one-shot'ом поверх вернувшейся локомоции.
    const revived = type === this.reviveEvent && this.releaseDeath();
    if (this.dead) return false;
    const entry = this.mapping.events?.[type];
    if (entry === undefined) return revived;
    const clip = this.clipFor(entry);
    // Запись есть, но не разрешилась — предупреждение уже выдано, one-shot не
    // играем: текущий клип остаётся, произвольный не подставляется (REND-4).
    if (clip < 0) return false;

    this.oneShotPlaying = true;
    this.backend.playOnce(clip, this.crossfade);
    if (type === this.deathEvent) this.dead = true;
    return true;
  }

  /**
   * Покадровое продвижение бэкенда; здесь же срабатывает возврат из one-shot.
   * `dt` — часы презентации со знаком (REND-25); направления машина не знает,
   * оно целиком у носителя воспроизведения.
   */
  update(dt: number): void {
    this.backend.update(dt);
  }

  /**
   * Доставка пришла разрывом (`snapAll`, REND-2): мир авторитетно ДРУГОЙ —
   * перемотка, реплей, смена ветви истории. Единственное, что здесь снимается, —
   * необратимость смерти.
   *
   * Смерть — one-shot с фиксацией последнего кадра навсегда (REND-4), и это
   * верно, пока время идёт вперёд: труп не встаёт. Перемотка через момент
   * смерти оживляет сущность в симуляции, а контроллер о её воскрешении узнать
   * неоткуда — `EntityDied` в прошлом не «разэмитится», и без этого сброса
   * живой персонаж навсегда остался бы лежать нулевым кадром клипа смерти.
   * Снап — ровно то указание, которого не хватало: «состояние теперь другое, а
   * непрерывности с прежним нет».
   *
   * Снап — не единственный путь: возрождение ИДУЩЕГО мира разрыва не даёт (мир
   * тот же и непрерывен), и снимает фиксацию названное сборкой событие
   * возрождения — `handleEvent` тем же `releaseDeath`.
   */
  onSnap(): void {
    this.releaseDeath();
  }

  /**
   * Снять фиксацию смерти и вернуться в клип текущего состояния. Возвращает
   * false, если снимать было нечего: контроллер живого инстанса — не «ещё не
   * умерший труп», и переигрывать ему клип не за чем (в частности, живой
   * one-shot ведёт своя шкала, и сбивать её фазу разрывом или возрождением
   * соседа нельзя).
   */
  private releaseDeath(): boolean {
    if (!this.dead) return false;
    this.dead = false;
    this.oneShotPlaying = false;
    this.resumeLoop();
    return true;
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
    if (clip < 0) return;
    this.backend.playLoop(clip, this.crossfade);
  }

  /**
   * Запись манифеста → индекс клипа, либо -1 с предупреждением, называющим
   * запись (REND-4). Тот же контракт, что у ссылки на отсутствующую кость в
   * REND-5: диагностировать и пропустить, а не подставить что-нибудь молча.
   */
  private clipFor(entry: string): number {
    const resolution = resolveClip(this.backend.clips, entry);
    if (resolution.status === 'resolved') return resolution.index;
    if (!this.warnedEntries.has(entry)) {
      this.warnedEntries.add(entry);
      this.warn(
        resolution.status === 'ambiguous'
          ? `render: запись анимации "${entry}" совпала по подстроке с несколькими клипами (${resolution.candidates.join(', ')}) — клип не сменён (REND-4)`
          : `render: запись анимации "${entry}" не совпала ни с одним клипом модели — клип не сменён (REND-4)`,
      );
    }
    return -1;
  }
}
