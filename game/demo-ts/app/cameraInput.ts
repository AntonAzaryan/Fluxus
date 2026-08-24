/**
 * Политика ввода камеры демо: что именно СБОРКА считает панорамированием
 * (`camera` CAM-3). Механизм — `edgePanAxes` рендера, здесь только решение, в
 * каких кадрах его вообще спрашивать; отдельным модулем — чтобы решение
 * проверялось тестом, а не только глазами в браузере (`main.ts` тянет THREE и
 * DOM и в vitest не поднимается).
 *
 * Гасится край в двух случаях, и оба — про то, что курсор в краевой полосе
 * означает НЕ панораму.
 *
 * Первый — курсор над интерактивом HUD: миникарта стоит в краевой полосе, и без
 * этого клик по её краю гасился бы панорамой.
 *
 * Второй — камера в follow (закреплена на герое): край здесь и есть тот
 * ДВУСМЫСЛЕННЫЙ источник панорамы, который CAM-2 разрешает освободить от
 * открепления. Мышь в этой сборке — орган ПРИЦЕЛА: `ЛКМ` бьёт в точку под
 * курсором, а захват и заряд каста целятся ею всё время удержания (`main.ts`,
 * `pointerAimSource`). Игрок, целящийся в сторону кромки арены, уводит курсор в
 * краевую полосу постоянно и панорамы при этом не просит — то есть прицел в
 * край срывал бы слежение за героем. Стрелки и drag средней кнопкой открепляют
 * по-прежнему: их двусмысленности нет, ими игрок именно ведёт камеру, и
 * однозначный источник открепления у сборки обязан остаться (CAM-2). В free-RTS
 * край работает как работал — там открепляться уже не от чего, и панорама краем
 * экрана остаётся основным способом вести камеру.
 */
import { edgePanAxes, type CameraMode } from '@fluxus/render';

/** Общий литерал покоя: функция зовётся покадрово и мусора не оставляет. */
const IDLE: { readonly x: number; readonly y: number } = Object.freeze({ x: 0, y: 0 });

export interface EdgePanRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgePanFrame {
  /** Режим камеры этого кадра; `null` — rig ещё не собран (манифест не приехал). */
  readonly mode: CameraMode | null;
  readonly pointerOverHud: boolean;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly rect: EdgePanRect;
  /** Ширина краевой полосы, px (`CameraConfig.edgeMarginPx`). */
  readonly margin: number;
}

/** Оси панорамы краем экрана для этого кадра; `{0, 0}` — край не считается. */
export function demoEdgePan(frame: EdgePanFrame): { readonly x: number; readonly y: number } {
  if (frame.pointerOverHud || frame.mode === 'follow') return IDLE;
  return edgePanAxes(frame.pointerX, frame.pointerY, frame.rect, frame.margin);
}
