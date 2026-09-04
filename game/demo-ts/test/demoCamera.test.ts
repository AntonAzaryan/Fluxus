/**
 * Политика ввода камеры демо (`app/cameraInput.ts`): край экрана как источник
 * панорамы (`camera` CAM-3) и его гейт в follow-режиме.
 *
 * Проверяется не механизм — `edgePanAxes` и переходы режимов закрыты тестами
 * `render-ts`, — а решение СБОРКИ: в каком кадре край вообще спрашивают. Оно
 * тут потому, что мышь в демо — орган прицела, и без гейта прицел в сторону
 * кромки арены откреплял бы камеру от героя (CAM-2: любой ввод панорамы в
 * follow открепляет). Проверка идёт до конца, до самого rig'а: гейт ценен ровно
 * тем, что режим после него не меняется.
 */
import { describe, expect, it } from 'vitest';
import { CameraRig, createCameraInput, resetCameraInput } from '@fluxus/render';
import { HeroFollowPoint } from '../app/cameraFollow.js';
import { demoEdgePan, type EdgePanFrame } from '../app/cameraInput.js';
import { DEAD_COMPONENT, FALLING_COMPONENT, stateBit } from '../app/sim.js';

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const MARGIN = 24;
/** Границы панорамирования размером с диск арены демо (CAM-3). */
const ARENA_BOUNDS = { minX: 0, minY: 0, maxX: 48, maxY: 48 };

/** Курсор в левой краевой полосе — то, что игрок видит как «веду камеру влево». */
function frame(overrides: Partial<EdgePanFrame> = {}): EdgePanFrame {
  return {
    mode: 'free',
    pointerOverHud: false,
    pointerX: 4,
    pointerY: 300,
    rect: RECT,
    margin: MARGIN,
    ...overrides,
  };
}

describe('панорама краем экрана: политика сборки демо', () => {
  it('в free-RTS край считается — механизм рендера на месте', () => {
    const edge = demoEdgePan(frame());
    expect(edge.x).toBeLessThan(0);
    expect(edge.y).toBe(0);
  });

  it('в follow край инертен: прицел мышью у кромки — не просьба о панораме', () => {
    expect(demoEdgePan(frame({ mode: 'follow' }))).toEqual({ x: 0, y: 0 });
  });

  it('курсор над интерактивом HUD гасит край в любом режиме', () => {
    expect(demoEdgePan(frame({ pointerOverHud: true }))).toEqual({ x: 0, y: 0 });
    expect(demoEdgePan(frame({ mode: 'follow', pointerOverHud: true }))).toEqual({ x: 0, y: 0 });
  });

  it('камера не откепляется от героя, пока игрок только целится в край (CAM-2)', () => {
    // РЕГРЕССИЯ: раньше главный поток отдавал оси края всегда, и первый же кадр
    // с курсором у кромки переводил rig в free — герой уезжал из кадра, а игрок
    // не просил ничего, кроме прицела.
    const rig = new CameraRig({ startX: 10, startY: 10 });
    const input = createCameraInput();
    const target = { x: 12, y: 12, snap: false };
    expect(rig.mode).toBe('follow');

    for (let i = 0; i < 10; i++) {
      const edge = demoEdgePan(frame({ mode: rig.mode }));
      input.edgeX = edge.x;
      input.edgeY = edge.y;
      rig.update(input, 1 / 60, target);
      resetCameraInput(input);
    }
    expect(rig.mode).toBe('follow');

    // А стрелки открепляют по-прежнему: ими игрок именно ведёт камеру.
    input.panX = -1;
    rig.update(input, 1 / 60, target);
    expect(rig.mode).toBe('free');

    // И в free край снова работает — иначе панорамировать было бы нечем.
    const edge = demoEdgePan(frame({ mode: rig.mode }));
    expect(edge.x).toBeLessThan(0);
  });
});

/**
 * Вторая политика той же сборки — за КАКОЙ точкой камера ведёт наблюдение,
 * пока герой выбыл из боя (`app/cameraFollow.ts`, CAM-2/CAM-5). Проверяется, как
 * и край, решение сборки: конвейер follow ведёт поданную точку и в этом не
 * ошибается — ошибалась подача.
 */
describe('follow-точка выбывшего героя: камера остаётся на месте боя (CAM-2)', () => {
  const DEAD = stateBit(DEAD_COMPONENT);
  const FALLING = stateBit(FALLING_COMPONENT);

  it('провалившийся с кромки герой камеру за арену не тянет', () => {
    // РЕГРЕССИЯ: follow вёл позу инстанса, а провалившийся герой продолжает
    // лететь ГОРИЗОНТАЛЬНО мимо арены сотни тиков до смерти по глубине —
    // камера уезжала за кромку и упиралась в границы панорамирования.
    const follow = new HeroFollowPoint();
    expect(follow.point(3, { pose: { x: 4, y: 20 }, states: 0, snap: false })).toEqual({
      x: 4,
      y: 20,
      snap: false,
    });
    // Тик провала: состояние приехало, точка ещё на кромке.
    expect(follow.point(3, { pose: { x: 2, y: 19 }, states: FALLING, snap: false })).toEqual({
      x: 4,
      y: 20,
      snap: false,
    });
    // Дальше герой улетает за пределы арены — точка держится.
    for (let i = 0; i < 300; i++) {
      const away = { x: -20 - i, y: 3 };
      expect(follow.point(3, { pose: away, states: FALLING | DEAD, snap: false })).toEqual({
        x: 4,
        y: 20,
        snap: false,
      });
    }
  });

  it('смерть на месте держит точку гибели, возрождение возвращает камеру герою', () => {
    const follow = new HeroFollowPoint();
    follow.point(3, { pose: { x: 28, y: 32 }, states: 0, snap: false });
    expect(follow.point(3, { pose: { x: 28, y: 32 }, states: DEAD, snap: false })).toEqual({
      x: 28,
      y: 32,
      snap: false,
    });
    // Возрождение: сущность снова в бою, точка — её, а признак разрыва доставки
    // едет как есть; порог рывка дальше решает CAM-5, а не эта политика.
    expect(follow.point(3, { pose: { x: 8, y: 24 }, states: 0, snap: true })).toEqual({
      x: 8,
      y: 24,
      snap: true,
    });
  });

  it('смена наблюдаемого (CAM-10) память места боя обнуляет', () => {
    const follow = new HeroFollowPoint();
    follow.point(3, { pose: { x: 28, y: 32 }, states: 0, snap: false });
    // Другой субъект, уже мёртвый: точка чужого боя ему не наследуется.
    expect(follow.point(4, { pose: { x: 40, y: 4 }, states: DEAD, snap: false })).toEqual({
      x: 40,
      y: 4,
      snap: false,
    });
  });

  it('инстанса нет — цели нет: конвейер остаётся там, где стоял', () => {
    const follow = new HeroFollowPoint();
    expect(follow.point(3, { pose: null, states: 0, snap: false })).toBeNull();
    expect(follow.point(null, { pose: { x: 1, y: 1 }, states: undefined, snap: false })).toBeNull();
  });

  it('камера в follow не покидает арену, пока герой летит мимо неё (CAM-3)', () => {
    // До конца, до самого rig'а: политика ценна ровно тем, что точка наблюдения
    // остаётся там, где герой был в бою.
    const rig = new CameraRig({ startX: 4, startY: 20, bounds: ARENA_BOUNDS });
    const input = createCameraInput();
    const follow = new HeroFollowPoint();
    rig.update(input, 1 / 60, follow.point(3, { pose: { x: 4, y: 20 }, states: 0, snap: true }));
    for (let i = 0; i < 600; i++) {
      const away = { x: -1 - i * 0.3, y: 20 - i * 0.2 };
      rig.update(input, 1 / 60, follow.point(3, { pose: away, states: FALLING, snap: false }));
      resetCameraInput(input);
    }
    expect(rig.mode).toBe('follow');
    expect(rig.focusX).toBeCloseTo(4, 3);
    expect(rig.focusY).toBeCloseTo(20, 3);
  });
});
