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
import { demoEdgePan, type EdgePanFrame } from '../app/cameraInput.js';

const RECT = { left: 0, top: 0, width: 800, height: 600 };
const MARGIN = 24;

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
