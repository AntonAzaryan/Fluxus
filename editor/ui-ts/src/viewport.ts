/**
 * Кадр вьюпорта — единственное место интерфейса, из которого палитра редактора
 * вычтена (ED-22).
 *
 * Вьюпорт есть кадр игры (ED-1, ED-13): тонировать его хромом значит
 * показывать автору не то, что увидит игрок. Запрет выражен структурой, а не
 * договорённостью:
 *
 * - узел кадра не несёт класса области токенов, поэтому ни одно правило хрома
 *   (все они написаны потомками `.fx-tokens`) на него не действует;
 * - класс `.fx-viewport` гасит каждый токен набора, поэтому и наследование
 *   переменных из хрома-предка кадра не достаёт;
 * - фон, цвет и шрифт сброшены на начальные — кадр рисует тот, кто рисует
 *   игру, а не таблица стилей редактора.
 *
 * Служебные наложения внутри кадра ED-22 не запрещает: подсветка выделения и
 * gizmo — часть работы автора, а не окраска кадра. Для них есть отдельный
 * слой, который заново вносит область токенов, но прозрачным фоном, — кадр под
 * ним остаётся кадром.
 */
import { el, type UiNode } from './dom/node.js';
import {
  TOKEN_SCOPE_CLASS,
  VIEWPORT_CLASS,
  VIEWPORT_OVERLAY_CLASS,
} from './tokens/stylesheet.js';
import type { UiText } from './dom/node.js';

export interface ViewportSpec {
  readonly label: UiText;
  /** Идентификатор узла, в который рендер движка ставит свой холст. */
  readonly hostId: string;
  /** Наложения поверх кадра: подсветка выделения, gizmo, индикация режима. */
  readonly overlays?: readonly UiNode[];
}

/**
 * Кадр вьюпорта. Возвращённый узел сознательно не принимает произвольных детей:
 * содержимое кадра приносит рендер движка, а всё, что от интерфейса, — только
 * через слой наложений.
 */
export function viewportFrame(spec: ViewportSpec): UiNode {
  const overlays = spec.overlays ?? [];
  return el('div', {
    classes: [VIEWPORT_CLASS],
    attrs: { id: spec.hostId, role: 'img' },
    labels: { ariaLabel: spec.label },
    children:
      overlays.length === 0
        ? []
        : [
            el('div', {
              classes: [VIEWPORT_OVERLAY_CLASS, TOKEN_SCOPE_CLASS],
              children: overlays,
            }),
          ],
  });
}
