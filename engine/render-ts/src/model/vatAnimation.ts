/**
 * Скалярный бэкенд анимации батчевого яруса (REND-20, design D5).
 *
 * Машина состояний REND-4 у обоих ярусов одна (`animation.ts`); здесь — только
 * НОСИТЕЛЬ воспроизведения: вместо микшера и скелета запись батча несёт три
 * числа — две строки VAT-текстуры (`assets` ASSET-12) и вес их смешивания.
 * Скиннинг по ним делает вершинный шейдер, и покадрового обновления костей на
 * CPU у батчевого инстанса не остаётся.
 *
 * ПОЧЕМУ ДВЕ СТРОКИ, А НЕ ОДНА. Пара нужна кроссфейду (REND-4), но простаивать
 * между кроссфейдами ей незачем: в обычном воспроизведении та же пара держит
 * СОСЕДНИЕ кадры клипа, а вес — дробную часть фазы. Так запечённая частота
 * (30 кадров в секунду по умолчанию) перестаёт быть частотой картинки, и
 * шейдеру это не стоит ничего — выборок он делает те же две.
 *
 * Во время кроссфейда межкадрового сглаживания нет: пара занята позами двух
 * клипов, и третьей выборки в шейдере не заведено. Кроссфейд длится доли
 * секунды, поза уходящего клипа на это время замирает — известное упрощение,
 * а не недосмотр (design, Risks: «кроссфейд в батче усложняет шейдер»).
 */
import type { BakedClip } from '@game-mvp/assets';
import type { AnimationBackend } from './animation.js';

export class VatAnimationBackend implements AnimationBackend {
  onOneShotFinished: (() => void) | null = null;

  readonly clips: readonly BakedClip[];
  private readonly fps: number;
  /** Строка позы покоя: ею нарисована запись, которой клип не назначен (REND-18). */
  private readonly restFrame: number;

  private current = -1;
  /** Фаза активного клипа, секунды. */
  private phase = 0;
  /** Активный клип — one-shot: по концу зовёт `onOneShotFinished`. */
  private once = false;
  /** One-shot доигран и держит последний кадр (смерть — навсегда, REND-4). */
  private clamped = false;
  private fadeLeft = 0;
  private fadeDuration = 0;
  /** Замершая строка уходящего клипа на время кроссфейда; -1 — кроссфейда нет. */
  private fromRow = -1;

  /** Строка VAT первой позы — то, что уходит в атрибут записи батча. */
  rowA: number;
  /** Строка VAT второй позы: соседний кадр клипа либо поза входящего клипа. */
  rowB: number;
  /** Вес второй позы в смеси, `[0..1]`. */
  blend = 0;

  constructor(clips: readonly BakedClip[], fps: number, restFrame: number) {
    this.clips = clips;
    this.fps = fps;
    this.restFrame = restFrame;
    this.rowA = restFrame;
    this.rowB = restFrame;
  }

  get currentClip(): number {
    return this.current;
  }

  /**
   * Кадр, по которому читается маска видимости частей (ASSET-12): та поза, что
   * весит больше. Маска двоичная — смешивать в ней нечего, и «часть наполовину
   * видима» смысла не имеет.
   */
  get visibilityFrame(): number {
    return this.blend >= 0.5 ? this.rowB : this.rowA;
  }

  playLoop(index: number, crossfade: number): void {
    this.start(index, crossfade, false);
  }

  playOnce(index: number, crossfade: number): void {
    this.start(index, crossfade, true);
  }

  update(dt: number): void {
    if (this.fadeLeft > 0) {
      this.fadeLeft = Math.max(0, this.fadeLeft - dt);
      if (this.fadeLeft === 0) this.fromRow = -1;
    }
    const clip = this.current < 0 ? undefined : this.clips[this.current];
    if (clip === undefined) {
      this.rowA = this.restFrame;
      this.rowB = this.restFrame;
      this.blend = 0;
      return;
    }
    if (!this.clamped) {
      this.phase += dt;
      if (this.once) {
        if (this.phase >= clip.duration) {
          this.phase = clip.duration;
          this.once = false;
          this.clamped = true;
          // Машина может тут же переключить клип — строки считаются ПОСЛЕ.
          this.onOneShotFinished?.();
        }
      } else if (clip.duration > 0) {
        this.phase %= clip.duration;
      } else {
        this.phase = 0;
      }
    }
    this.recompute();
  }

  private start(index: number, crossfade: number, once: boolean): void {
    // Уходящая поза замирает на время перехода: третьей выборки в шейдере нет.
    if (crossfade > 0 && this.current >= 0) {
      this.fromRow = this.visibilityFrame;
      this.fadeDuration = crossfade;
      this.fadeLeft = crossfade;
    } else {
      this.fromRow = -1;
      this.fadeLeft = 0;
    }
    this.current = index;
    this.phase = 0;
    this.once = once;
    this.clamped = false;
    this.recompute();
  }

  /**
   * Фаза → строки VAT. Кадр клипа `k` лежит в строке `offset + k`, время кадра —
   * `k / fps` (`assets` ASSET-12), поэтому перевод — умножение, а не поиск.
   */
  private recompute(): void {
    const clip = this.current < 0 ? undefined : this.clips[this.current];
    if (clip === undefined) {
      this.rowA = this.restFrame;
      this.rowB = this.restFrame;
      this.blend = 0;
      return;
    }
    const last = clip.length - 1;
    let position = this.phase * this.fps;
    if (!(position > 0)) position = 0;
    let index = Math.floor(position);
    let fraction = position - index;
    if (index >= last) {
      index = last;
      fraction = 0;
    }
    if (this.fadeLeft > 0 && this.fromRow >= 0) {
      // Кроссфейд: пара занята позами двух клипов, вес — доля перехода.
      this.rowA = this.fromRow;
      this.rowB = clip.offset + Math.min(Math.round(position), last);
      this.blend = 1 - this.fadeLeft / this.fadeDuration;
      return;
    }
    this.rowA = clip.offset + index;
    this.rowB = clip.offset + Math.min(index + 1, last);
    this.blend = fraction;
  }
}
