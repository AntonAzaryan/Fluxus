/**
 * Правила палитры команд (ED-24). Живут рядом с самой палитрой по той же
 * причине, по какой ширины зон живут у каркаса: положение и размер всплывающего
 * — свойство палитры, и второго места, где они задаются, быть не должно.
 *
 * Палитра — единственное всплывающее каркаса, и накрывает она страницу целиком,
 * включая кадр вьюпорта. Слой перехвата при этом прозрачен, и это не упущение:
 * затемнение красило бы кадр, то есть показывало бы автору не тот кадр, который
 * увидит игрок (ED-22, ED-1). Отделяет палитру от страницы то же, чем отделён
 * любой всплывающий слой набора, — поверхность, рамка и тень.
 */
import { SCOPE as S, type CssRule } from '../tokens/css.js';
import { PALETTE_CLASS, PALETTE_SCRIM_CLASS } from './view.js';

export const PALETTE_RULES: readonly CssRule[] = [
  {
    selector: `${S} .${PALETTE_SCRIM_CLASS}`,
    declarations: [
      'position: fixed',
      'inset: 0',
      'z-index: 10',
      'background: none',
      'display: flex',
      'justify-content: center',
      'align-items: flex-start',
      'padding-top: 12vh',
    ],
  },
  {
    selector: `${S} .${PALETTE_CLASS}`,
    declarations: [
      'width: min(640px, 90vw)',
      'max-height: 60vh',
      'display: flex',
      'flex-direction: column',
      'min-height: 0',
      'background: var(--fx-surface-overlay)',
      'border: var(--fx-hairline) solid var(--fx-border-strong)',
      'border-radius: var(--fx-radius-md)',
      'box-shadow: var(--fx-elevation-overlay)',
      'overflow: hidden',
    ],
  },
  {
    selector: `${S} .${PALETTE_CLASS}__head`,
    declarations: [
      'display: flex',
      'align-items: center',
      'gap: var(--fx-space-2)',
      'padding: var(--fx-space-2) var(--fx-space-3)',
      'border-bottom: var(--fx-hairline) solid var(--fx-border-subtle)',
      'color: var(--fx-text-faint)',
      'flex: none',
    ],
  },
  {
    selector: `${S} .${PALETTE_CLASS}__query`,
    declarations: ['border: none', 'background: none', 'padding: 0'],
  },
  {
    selector: `${S} .${PALETTE_CLASS} > .fx-list`,
    declarations: ['overflow: auto', 'min-height: 0'],
  },
];
