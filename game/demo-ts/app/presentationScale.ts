/**
 * Мировой множитель часов презентации глазами демо (`rendering` REND-25) —
 * ПОЛИТИКА стенда, которой у движка нет.
 *
 * Механизм живёт в `ViewBuffer`: он принимает любое неотрицательное число и в
 * любом режиме. Стенд же решает две вещи, и обе — вкус приложения, а не норма:
 * когда множитель вообще правится и в каких границах он ходит.
 *
 * **Когда.** Только вне `Running` — на паузе и перемотке. Живой матч замедлять
 * нечем: сервер идёт своим темпом, множитель трогает лишь ход клипов и частиц,
 * и замедленный показ означал бы, что ноги отстают от собственного движения, —
 * рассинхрон картинки, а не эффект. Мир, о режиме которого ещё не сообщали,
 * считается живым: отсутствие доставки — не утверждение о паузе
 * (`client-shell` SHELL-9).
 *
 * **В каких границах.** Восьмушка снизу и четвёрка сверху: выше лежит кламп
 * кадрового шага (REND-25, design D1) и ускорять дальше нечего, ниже скраб
 * перестаёт читаться как движение. Ноль в границы не входит — он не ступень, а
 * заморозка, и приходит своей клавишей.
 */
import type { WorldMode } from '@fluxus/core';

/** Границы ступеней множителя в демо; ноль лежит вне их — он заморозка. */
export const PRESENTATION_SCALE_MIN = 0.125;
export const PRESENTATION_SCALE_MAX = 4;

/** Хост показа глазами этой политики: множитель, его сеттер и режим мира. */
export interface PresentationScalePort {
  /** Действующий множитель хода часов презентации (REND-25). */
  readonly timeScale: number;
  setTimeScale(scale: number): void;
  /** Режим ДОСТАВЛЕННОГО мира; null — доставок ещё не было. */
  readonly mode: WorldMode | null;
}

/**
 * Ступени множителя и заморозка. Состояние у политики одно — множитель, к
 * которому возвращает заморозка: сам множитель живёт в буфере, и второй его
 * копии здесь нет.
 */
export class PresentationScale {
  private readonly port: () => PresentationScalePort | null;
  /** Множитель до заморозки; из нуля умножением не выйти, и возврат нужен. */
  private beforeFreeze = 1;

  constructor(port: () => PresentationScalePort | null) {
    this.port = port;
  }

  /** Правится ли множитель прямо сейчас (см. шапку: только вне `Running`). */
  get allowed(): boolean {
    const port = this.port();
    return port !== null && (port.mode ?? 'Running') !== 'Running';
  }

  /**
   * Ступень вдвое в обе стороны, в границах стенда. Из заморозки ступень
   * выводит к запомненному множителю: умножение нуля осталось бы нулём, и `=`
   * из заморозки не вывел бы вовсе.
   */
  step(factor: number): void {
    const port = this.port();
    if (port === null || !this.allowed) return;
    const base = port.timeScale === 0 ? this.beforeFreeze : port.timeScale;
    const next = Math.min(
      Math.max(base * factor, PRESENTATION_SCALE_MIN),
      PRESENTATION_SCALE_MAX,
    );
    this.beforeFreeze = next;
    port.setTimeScale(next);
  }

  /** Заморозка показа (`k = 0`) и возврат к прежнему множителю. */
  toggleFreeze(): void {
    const port = this.port();
    if (port === null || !this.allowed) return;
    if (port.timeScale === 0) {
      port.setTimeScale(this.beforeFreeze);
      return;
    }
    this.beforeFreeze = port.timeScale;
    port.setTimeScale(0);
  }
}
