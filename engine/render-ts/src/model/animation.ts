/**
 * Анимационный контроллер инстанса (REND-4): механизм в коде, маппинг в данных.
 *
 * Механизм — проигрывание клипа по подстроке имени, loop/one-shot, кроссфейд,
 * возврат в локомоцию после one-shot (перенос `play()` прототипа). Политика —
 * таблицы манифеста «состояние → клип» и «событие → one-shot клип» (ASSET-6);
 * привязка конкретных клипов к состояниям и событиям кодом не задаётся.
 */
import * as THREE from 'three';

/**
 * Клип по подстроке имени без учёта регистра; не нашли — фолбэк на первый
 * клип модели (как `play()` прототипа: у WC3-моделей первый — Stand).
 */
export function resolveClip(
  clips: readonly THREE.AnimationClip[],
  nameSubstring: string,
): THREE.AnimationClip | null {
  if (clips.length === 0) return null;
  const needle = nameSubstring.toLowerCase();
  return clips.find((clip) => clip.name.toLowerCase().includes(needle)) ?? clips[0]!;
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
}

const DEFAULT_CROSSFADE = 0.15;
const DEFAULT_DEATH_EVENT = 'EntityDied';

export class AnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips: readonly THREE.AnimationClip[];
  private readonly mapping: AnimationMapping;
  private readonly crossfade: number;
  private readonly deathEvent: string;

  /** Активное действие (то, что сейчас вкроссфейжено). */
  private active: THREE.AnimationAction | null = null;
  /** Проигрываемый one-shot; по завершении возвращаемся в локомоцию. */
  private oneShot: THREE.AnimationAction | null = null;
  /** Текущее состояние локомоции ('idle'/'move' в MVP). */
  private state: string | null = null;
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
    // LoopOnce-действие сообщает о конце через микшер — здесь возврат в локомоцию.
    this.mixer.addEventListener('finished', (event) => {
      if (event.action !== this.oneShot) return;
      this.oneShot = null;
      if (!this.dead) this.playState(this.state);
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
    if (this.oneShot !== null) return;
    this.playState(state);
  }

  /**
   * Событие тика → one-shot клип по таблице манифеста. Возвращает false, если
   * событие не замаплено. Событие смерти — one-shot с фиксацией последнего
   * кадра навсегда (REND-4).
   */
  handleEvent(type: string): boolean {
    if (this.dead) return false;
    const substring = this.mapping.events?.[type];
    if (substring === undefined) return false;
    const clip = resolveClip(this.clips, substring);
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

  private playState(state: string | null): void {
    if (state === null) return;
    const substring = this.mapping.states?.[state];
    // Нет записи в манифесте — нет смены: политика в данных, а не фолбэк в коде.
    if (substring === undefined) return;
    const clip = resolveClip(this.clips, substring);
    if (clip === null) return;

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    this.fadeTo(action);
  }

  private fadeTo(next: THREE.AnimationAction): void {
    const previous = this.active;
    next.reset().fadeIn(this.crossfade).play();
    if (previous !== null && previous !== next) previous.fadeOut(this.crossfade);
    this.active = next;
  }
}
