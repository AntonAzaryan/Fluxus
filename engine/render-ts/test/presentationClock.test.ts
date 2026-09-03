/**
 * Мировой множитель хода часов презентации (REND-25, change
 * `presentation-time-scale`): что он множит, что не трогает и как складывается
 * с двумя другими множителями того же времени — темпом обратного хода (REND-25)
 * и персональной шкалой сущности (REND-38).
 *
 * Величина принадлежит СМОТРЯЩЕМУ: в доставке её нет, воркер о ней не знает.
 * Поэтому весь стенд — буфер с управляемыми часами и рукописные доставки.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LOCOMOTION_NORMAL, type WorldMode } from '@fluxus/core';
import {
  AnimationController,
  MixerAnimationBackend,
  ViewBuffer,
  type ExtractedTick,
} from '../src/index.js';

const TICK_SECONDS = 0.05;

/** Рукописная доставка одной сущности: буфер проверяется, а не экстрактор. */
function extOf(tick: number, mode: WorldMode = 'Running', snapAll = false): ExtractedTick {
  return {
    tick,
    mode,
    isReplay: false,
    snapAll,
    branchChanged: snapAll,
    freshEvents: true,
    full: true,
    removed: new Float64Array(0),
    removedCount: 0,
    count: 1,
    id: Float64Array.from([5]),
    kind: Int32Array.from([-1]),
    x: new Float32Array(1),
    y: new Float32Array(1),
    level: new Uint8Array(1),
    simLevel: new Uint8Array(1),
    flags: new Uint8Array(1),
    facingYaw: new Float32Array(1).fill(Number.NaN),
    aimYaw: new Float32Array(1).fill(Number.NaN),
    motion: new Uint8Array(1).fill(LOCOMOTION_NORMAL),
    motionPhase: new Float32Array(1).fill(Number.NaN),
    flightPhase: new Float32Array(1).fill(Number.NaN),
    timeScale: new Float32Array(1).fill(1),
    statNames: [],
    statCount: new Uint8Array(1),
    statIndex: new Int32Array(0),
    statValue: new Float64Array(0),
    statPairs: 0,
    events: [],
    floorDelta: [],
    kindTable: [],
  };
}

/** Стенд: доставки ровным каденсом по управляемым часам, кадр по требованию. */
function stand(timeScale?: number): {
  buffer: ViewBuffer;
  deliver: (ms: number, tick: number, mode?: WorldMode) => void;
  frame: (ms: number) => { dt: number; alpha: number; realDt: number };
} {
  let now = 0;
  const buffer = new ViewBuffer({
    tickSeconds: TICK_SECONDS,
    clock: () => now,
    ...(timeScale !== undefined ? { timeScale } : {}),
  });
  return {
    buffer,
    deliver: (ms, tick, mode = 'Running') => {
      now = ms;
      buffer.apply(extOf(tick, mode));
    },
    frame: (ms) => {
      now = ms;
      return buffer.frame(ms)!;
    },
  };
}

/** Ровный живой каденс: восемь доставок по 50 мс; возвращает момент последней. */
function steady(rig: ReturnType<typeof stand>, mode: WorldMode = 'Running'): number {
  let tick = 100;
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    rig.deliver(ms, mode === 'Rewinding' ? tick-- : tick++, mode);
    ms += 50;
  }
  return ms - 50;
}

describe('REND-25: мировой множитель множит ход подсистем', () => {
  it('шаг подсистем множится, а `realDt` и альфа — нет', () => {
    const plain = stand();
    const slowed = stand(0.25);
    const at = steady(plain);
    steady(slowed);
    // Первый кадр после доставки задаёт точку отсчёта часов кадра: `dt` меряется
    // от него, поэтому оба стенда делают по два кадра одинаковым шагом.
    plain.frame(at + 10);
    slowed.frame(at + 10);
    const full = plain.frame(at + 26);
    const quarter = slowed.frame(at + 26);

    expect(quarter.dt).toBeCloseTo(full.dt * 0.25, 9);
    // Реальное время кадра — часы HUD и дренаж переходов картинки: множителю
    // они не подчиняются (REND-25, REND-38).
    expect(quarter.realDt).toBeCloseTo(full.realDt, 9);
    // Альфа считается по каденсу ДОСТАВОК (REND-2): замедли её — и позиции
    // отстанут от потока тиков, то есть картинка разъедется с симуляцией.
    expect(quarter.alpha).toBeCloseTo(full.alpha, 9);
  });

  it('ноль тождествен замороженному миру', () => {
    const frozen = stand(0);
    const paused = stand();
    const at = steady(frozen);
    steady(paused);
    // Замороженный мир: доставка того же тика в `Paused` (ход остановлен режимом).
    paused.deliver(at, 108, 'Paused');
    frozen.frame(at + 10);
    paused.frame(at + 10);

    const byScale = frozen.frame(at + 26);
    const byMode = paused.frame(at + 26);
    expect(byScale.dt).toBe(0);
    expect(byScale.dt).toBe(byMode.dt);
    // Реальное время при этом идёт у обоих: переходы картинки дренируются им.
    expect(byScale.realDt).toBeGreaterThan(0);
  });

  it('темп обратного хода и множитель перемножаются, а не заменяют друг друга', () => {
    const plain = stand();
    const slowed = stand(0.5);
    // Живой каденс — по тику за доставку; скраб — по два тика за ту же
    // доставку, то есть вдвое быстрее (REND-25).
    const rewind = (rig: ReturnType<typeof stand>): number => {
      let ms = steady(rig) + 50;
      // Скраб начинается ОТ живого фронтира (последний доставленный тик — 107):
      // прыжок в далёкий тик дал бы первой пробой спан в сотню и увёл бы
      // сглаженную оценку темпа на десятки доставок вперёд.
      let tick = 105;
      for (let i = 0; i < 8; i++) {
        rig.deliver(ms, tick, 'Rewinding');
        tick -= 2;
        ms += 50;
      }
      return ms - 50;
    };
    const at = rewind(plain);
    rewind(slowed);
    plain.frame(at + 10);
    slowed.frame(at + 10);
    const fast = plain.frame(at + 26);
    const half = slowed.frame(at + 26);

    // Обратный ход: знак отрицательный у обоих, темп — вдвое от живого.
    expect(fast.dt).toBeLessThan(0);
    expect(Math.abs(fast.dt)).toBeCloseTo((16 / 1000) * 2, 6);
    // Множитель 0.5 поверх темпа 2 даёт ровно ход живого мира.
    expect(half.dt).toBeCloseTo(fast.dt * 0.5, 9);
    expect(Math.abs(half.dt)).toBeCloseTo(16 / 1000, 6);
  });

  it('отрицательный множитель — ошибка вызывающего, а не ход назад', () => {
    const rig = stand();
    expect(() => {
      rig.buffer.setTimeScale(-1);
    }).toThrow(/не меньше нуля/);
    expect(() => {
      rig.buffer.setTimeScale(Number.NaN);
    }).toThrow(/не меньше нуля/);
    // Прежняя величина уцелела: отказ не оставляет буфер в неопределённом ходе.
    expect(rig.buffer.timeScale).toBe(1);
  });

  it('величина наблюдаема в доставленном состоянии и обновляется кадром (RDBG-7)', () => {
    const rig = stand();
    steady(rig);
    expect(rig.buffer.view.presentationTimeScale).toBe(1);
    // Сеттер между доставками: кадр обязан показать свежую величину, не
    // дожидаясь следующей доставки.
    rig.buffer.setTimeScale(0.5);
    expect(rig.buffer.view.presentationTimeScale).toBe(0.5);
  });
});

describe('REND-38: личная шкала множится на мировой множитель', () => {
  /** Микшер с одним клипом: ход клипа читается его временем действия. */
  function clipRig(): { controller: AnimationController; timeOf: () => number } {
    const root = new THREE.Group();
    const bone = new THREE.Object3D();
    bone.name = 'b0';
    root.add(bone);
    const clip = new THREE.AnimationClip('Stand - 1', 10, [
      new THREE.VectorKeyframeTrack('b0.position', [0, 10], [0, 0, 0, 0, 0, 1]),
    ]);
    const mixer = new THREE.AnimationMixer(root);
    const backend = new MixerAnimationBackend(mixer, [clip]);
    const controller = new AnimationController(
      backend,
      { states: { idle: 'Stand' }, events: {} },
      { crossfade: 0 },
    );
    controller.setState('idle');
    return {
      controller,
      timeOf: () => mixer.clipAction(clip).time,
    };
  }

  it('мировой множитель × личная шкала — произведение, а не победа одного', () => {
    // Кадр приносит уже помноженный на мировой множитель шаг (REND-25), а
    // персональную шкалу подсистема моделей подставляет вторым множителем.
    const world = 0.5;
    const personal = 0.5;
    const dt = 0.1 * world;

    const both = clipRig();
    both.controller.update(dt, personal);
    const alone = clipRig();
    alone.controller.update(0.1, personal);

    expect(both.timeOf()).toBeCloseTo(0.1 * world * personal, 6);
    expect(both.timeOf()).toBeCloseTo(alone.timeOf() * world, 6);
  });
});
