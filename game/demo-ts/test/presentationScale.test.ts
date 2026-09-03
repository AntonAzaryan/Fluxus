/**
 * Политика мирового множителя часов презентации в демо (`rendering` REND-25,
 * change `presentation-time-scale`, design D5).
 *
 * Механизм — в `render-ts` (буфер принимает любое неотрицательное число в любом
 * режиме); здесь проверяется ровно то, что стенд решает сам: когда множитель
 * правится и в каких границах ходит.
 */
import { describe, expect, it } from 'vitest';
import type { WorldMode } from '@fluxus/core';
import {
  PRESENTATION_SCALE_MAX,
  PRESENTATION_SCALE_MIN,
  PresentationScale,
  type PresentationScalePort,
} from '../app/presentationScale.js';

/** Стенд: порт с изменяемым режимом и множителем — как хост доставок. */
function stand(mode: WorldMode | null = 'Paused'): {
  control: PresentationScale;
  port: PresentationScalePort & { mode: WorldMode | null; timeScale: number };
} {
  const port = {
    timeScale: 1,
    mode,
    setTimeScale(scale: number) {
      port.timeScale = scale;
    },
  };
  return { control: new PresentationScale(() => port), port };
}

describe('REND-25: множитель показа правится только вне живого мира', () => {
  it('в `Running` клавиши не меняют ничего', () => {
    const { control, port } = stand('Running');
    control.step(0.5);
    control.toggleFreeze();
    expect(port.timeScale).toBe(1);
    expect(control.allowed).toBe(false);
  });

  it('мир, о режиме которого не сообщали, считается живым (SHELL-9)', () => {
    const { control, port } = stand(null);
    control.step(0.5);
    expect(port.timeScale).toBe(1);
  });

  it('на паузе и перемотке ступень работает в обе стороны', () => {
    const { control, port } = stand('Paused');
    control.step(0.5);
    expect(port.timeScale).toBeCloseTo(0.5, 9);
    control.step(2);
    expect(port.timeScale).toBeCloseTo(1, 9);

    port.mode = 'Rewinding';
    control.step(2);
    expect(port.timeScale).toBeCloseTo(2, 9);
  });

  it('ступени держатся в границах стенда', () => {
    const { control, port } = stand('Rewinding');
    for (let i = 0; i < 10; i++) control.step(0.5);
    expect(port.timeScale).toBeCloseTo(PRESENTATION_SCALE_MIN, 9);
    for (let i = 0; i < 20; i++) control.step(2);
    expect(port.timeScale).toBeCloseTo(PRESENTATION_SCALE_MAX, 9);
  });

  it('заморозка возвращает прежний множитель, а не единицу', () => {
    const { control, port } = stand('Paused');
    control.step(0.5);
    expect(port.timeScale).toBeCloseTo(0.5, 9);

    control.toggleFreeze();
    expect(port.timeScale).toBe(0);
    control.toggleFreeze();
    expect(port.timeScale).toBeCloseTo(0.5, 9);
  });

  it('из заморозки выводит и ступень: умножение нуля осталось бы нулём', () => {
    const { control, port } = stand('Paused');
    control.toggleFreeze();
    expect(port.timeScale).toBe(0);
    control.step(2);
    expect(port.timeScale).toBeCloseTo(2, 9);
  });
});
