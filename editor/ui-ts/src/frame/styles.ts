/**
 * Правила каркаса рабочих областей: рельс, скелет и три его зоны (ED-23,
 * ED-24).
 *
 * Ширины зон живут здесь, а не среди виджетов, потому что они — свойство
 * скелета, а не панели: ED-24 требует, чтобы расположение зон совпадало во
 * всех областях, и одинаковость эта держится ровно на том, что размер зоны
 * задан в одном месте и не спрашивается у области. Область кладёт в зону
 * содержимое и не имеет способа сдвинуть её границу — свободной докировки
 * панелей в редакторе нет и по решению `editor-ui-shell/design.md` не будет:
 * подвинутый автором скелет перестаёт быть одинаковым.
 *
 * Прокрутка расписана по зонам не одинаково, и это тоже требование, а не вкус:
 * навигатор и инспектор прокручиваются сами (плотный список на сотню записей —
 * обычный случай ED-22), а поверхность правки не прокручивается вовсе. Внутри
 * неё может лежать кадр вьюпорта (ED-1, ED-13), а прокрученный кадр — это не
 * кадр игры; область, которой прокрутка нужна, заводит её у себя (`.fx-scroll`).
 *
 * Заголовки групп в прокручиваемых зонах — липкие. В инспекторе на сорок строк
 * заголовок группы уезжает вверх с третьей строки, и дальше автор смотрит на
 * поля, не зная, чьи они.
 */
import { SCOPE as S, type CssRule } from '../tokens/css.js';

/** Класс зоны навигатора — левая колонка скелета. */
export const NAVIGATOR_ZONE_CLASS = 'fx-zone--nav';

/** Класс зоны поверхности правки — середина скелета. */
export const SURFACE_ZONE_CLASS = 'fx-zone--surface';

/** Класс зоны инспектора — правая колонка скелета. */
export const INSPECTOR_ZONE_CLASS = 'fx-zone--inspector';

/** Прокручиваемый блок внутри зоны: заводит его область, не каркас. */
export const SCROLL_CLASS = 'fx-scroll';

/** Блок, занимающий зону целиком, — например, кадр вьюпорта в поверхности правки. */
export const FILL_CLASS = 'fx-fill';

/** Тот же блок, но с содержимым в колонку: полоса инструментов над кадром. */
export const FILL_COLUMN_CLASS = 'fx-fill--column';

export const FRAME_RULES: readonly CssRule[] = [
  { selector: `${S} .fx-frame__body`, declarations: ['display: flex', 'flex: 1', 'min-height: 0'] },
  {
    // Рельс — визуальное представление реестра областей (ED-23): сколько в
    // реестре вкладов, столько здесь знаков, и ни одного правила «на область».
    selector: `${S} .fx-rail`,
    declarations: [
      'width: calc(var(--fx-space-4) * 4)',
      'flex: none',
      'display: flex',
      'flex-direction: column',
      'background: var(--fx-surface-1)',
      'border-right: var(--fx-hairline) solid var(--fx-border)',
      'padding: var(--fx-space-2) 0',
      'gap: var(--fx-space-1)',
      'overflow: auto',
    ],
  },
  {
    selector: `${S} .fx-rail__item`,
    declarations: [
      'height: calc(var(--fx-space-4) * 3.5)',
      'flex: none',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'gap: var(--fx-space-half)',
      'background: none',
      'border: none',
      'padding: 0 var(--fx-space-half)',
      'color: var(--fx-text-muted)',
      'font-family: inherit',
      'cursor: pointer',
      'box-shadow: inset 3px 0 0 transparent',
      'transition: background var(--fx-motion-fast) var(--fx-motion-standard)',
    ],
  },
  {
    selector: `${S} .fx-rail__item:hover`,
    declarations: ['background: var(--fx-state-hover)'],
  },
  {
    // Активная рабочая область — одно из пяти мест, за которыми ED-22 закрепил
    // акцент. Полоса и цвет знака, а не заливка: заливка акцентом на знаке
    // 16 px съедает его форму, а форма здесь единственное, чем области
    // различаются с одного взгляда.
    selector: `${S} .fx-rail__item.fx-is-active`,
    role: 'interactive',
    declarations: [
      'color: var(--fx-accent-bright)',
      'background: var(--fx-state-selected)',
      'box-shadow: inset 3px 0 0 var(--fx-accent)',
    ],
  },
  {
    selector: `${S} .fx-rail__item:focus-visible`,
    role: 'interactive',
    declarations: ['outline: var(--fx-hairline) solid var(--fx-accent)', 'outline-offset: -2px'],
  },
  {
    selector: `${S} .fx-rail__label`,
    declarations: [
      'font-size: var(--fx-font-size-micro)',
      'max-width: 100%',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ],
  },
  {
    // Скелет: навигатор — поверхность — инспектор, в этом порядке и в этих
    // местах во всех областях (ED-24).
    selector: `${S} .fx-skeleton`,
    declarations: ['display: flex', 'flex: 1', 'min-width: 0', 'min-height: 0'],
  },
  {
    selector: `${S} .fx-zone`,
    declarations: ['display: flex', 'flex-direction: column', 'min-width: 0', 'min-height: 0'],
  },
  { selector: `${S} .${NAVIGATOR_ZONE_CLASS}`, declarations: ['width: 240px', 'flex: none'] },
  {
    selector: `${S} .${SURFACE_ZONE_CLASS}`,
    declarations: [
      'flex: 1',
      'min-width: 0',
      'background: var(--fx-surface-1)',
      // Не `auto`: прокрученный кадр вьюпорта перестаёт быть кадром игры.
      'overflow: hidden',
    ],
  },
  {
    selector: `${S} .${INSPECTOR_ZONE_CLASS}`,
    declarations: [
      'width: 356px',
      'flex: none',
      'border-right: none',
      'border-left: var(--fx-hairline) solid var(--fx-border)',
    ],
  },
  {
    // Заголовок группы держится у верхней кромки своей зоны, пока группа не
    // ушла с экрана целиком. Фон обязателен: без него строки просвечивают
    // сквозь заголовок ровно в момент прокрутки.
    selector: `${S} .${NAVIGATOR_ZONE_CLASS} .fx-section, ${S} .${INSPECTOR_ZONE_CLASS} .fx-section`,
    declarations: [
      'position: sticky',
      'top: 0',
      'z-index: 1',
      'background: var(--fx-surface-2)',
      'flex: none',
    ],
  },
  {
    selector: `${S} .${SCROLL_CLASS}`,
    declarations: ['flex: 1', 'min-height: 0', 'min-width: 0', 'overflow: auto'],
  },
  {
    selector: `${S} .${FILL_CLASS}`,
    declarations: ['flex: 1', 'display: flex', 'min-height: 0', 'min-width: 0'],
  },
  { selector: `${S} .${FILL_COLUMN_CLASS}`, declarations: ['flex-direction: column'] },
  // Кадр внутри такого блока занимает его целиком. Правило смотрит на кадр
  // снаружи и ничего в нём не красит: ни один токен здесь не читается (ED-22).
  { selector: `${S} .${FILL_CLASS} > .fx-viewport`, declarations: ['flex: 1'] },
];
