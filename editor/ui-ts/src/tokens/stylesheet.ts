/* eslint-disable max-lines -- baseline */
/**
 * Таблица стилей визуального языка (ED-22) — как данные, а не как строка.
 *
 * Правило здесь несёт не только селектор и объявления, но и роль: за что оно
 * красит. Роль — не документация: ED-22 закрепляет акцент за интерактивным
 * состоянием и запрещает ему нести семантику состояния данных, а проверить это
 * по слитой в одну строку CSS нечем. Разложенное на правила с ролями — можно,
 * и `test/visualLanguage.test.ts` это и делает.
 *
 * Граница вьюпорта тоже выражена здесь структурно. Вьюпорт есть кадр игры
 * (ED-1, ED-13), и хром не имеет права его окрашивать, поэтому:
 *
 * - все правила хрома написаны потомками `.fx-tokens`, и красят они по классу
 *   хрома. Кадр лежит внутри этой области — он потомок корня приложения, — и
 *   удерживает его не область, а то, что других классов он не несёт вовсе
 *   (`viewportFrame` иных не ставит, `test/viewport.test.ts` это пиннит);
 * - `.fx-viewport` гасит каждый токен набора (`--x: initial` делает свойство
 *   гарантированно недействительным, и `var(--x)` перестаёт что-либо давать),
 *   а список гасимого берётся обходом `TOKENS` — новый токен попадает в сброс
 *   сам. Это и есть главный замок: наследование переменных из хрома-предка до
 *   содержимого кадра не достаёт;
 * - служебные наложения внутри вьюпорта (подсветка выделения, gizmo) ED-22 не
 *   запрещает, поэтому у вьюпорта есть слой `.fx-viewport__overlay`, который
 *   заново вносит область токенов — но прозрачным фоном и ниже кадра по дереву,
 *   а наследование идёт сверху вниз, так что вернуть палитру на сам кадр этим
 *   слоем нельзя.
 */
import { FRAME_RULES } from '../frame/styles.js';
import { PALETTE_RULES } from '../palette/styles.js';
import { EDITOR_ROOT_ID } from '../root.js';
import {
  APP_CLASS,
  SCOPE as S,
  VIEWPORT_CLASS,
  VIEWPORT_OVERLAY_CLASS,
  type CssRule,
} from './css.js';
import { TOKENS, tokenValue } from './tokens.js';

/**
 * Имена классов и тип правила объявлены в `css.ts`: их читает и каркас, чьи
 * правила этот модуль подмешивает в каскад. Публичная поверхность пакета от
 * переезда не изменилась — они по-прежнему выходят отсюда.
 */
export {
  APP_CLASS,
  TOKEN_SCOPE_CLASS,
  VIEWPORT_CLASS,
  VIEWPORT_OVERLAY_CLASS,
} from './css.js';
export type { CssRule, RuleRole } from './css.js';

/** Идентификатор элемента `<style>`, в который ставится эта таблица. */
export const STYLESHEET_ELEMENT_ID = 'fx-visual-language';

/** Объявление всех токенов — единственное место, где они получают значения. */
const scopeRule: CssRule = {
  selector: S,
  declarations: [
    ...TOKENS.map((token) => `${token.name}: ${token.value}`),
    'font-family: var(--fx-font-family)',
    'font-size: var(--fx-font-size-body)',
    'line-height: var(--fx-line-height-dense)',
    'color: var(--fx-text-primary)',
    '-webkit-font-smoothing: antialiased',
  ],
};

/**
 * Сброс на границе кадра. Собирается из `TOKENS`, поэтому «забыть погасить
 * новый токен» физически некуда: список гасимого и список объявляемого — один
 * и тот же массив.
 */
const viewportRule: CssRule = {
  selector: `.${VIEWPORT_CLASS}`,
  declarations: [
    ...TOKENS.map((token) => `${token.name}: initial`),
    'position: relative',
    'background: none',
    'color: initial',
    'font: initial',
    'overflow: hidden',
  ],
};

const BASE_RULES: readonly CssRule[] = [
  { selector: 'html, body', declarations: ['margin: 0', 'height: 100%'] },
  // Фон окна берётся из того же набора, что и всё остальное: значение, а не
  // переменная, потому что `body` лежит вне области действия токенов.
  {
    selector: 'body',
    declarations: [`background: ${tokenValue('--fx-surface-canvas')}`],
  },
  // Разметка страницы приложения не знает ни цвета, ни метрики: единственное,
  // что `app/index.html` объявляет сам, — что корень существует. Всё остальное,
  // включая высоту корня, приходит отсюда (ED-22: один источник визуального
  // языка).
  { selector: `#${EDITOR_ROOT_ID}`, declarations: ['height: 100%', 'display: flex'] },
  scopeRule,
  {
    selector: `${S}, ${S} *, ${S} *::before, ${S} *::after`,
    declarations: ['box-sizing: border-box'],
  },
  {
    // Корень приложения — либо сам носитель области токенов, либо узел внутри
    // неё: оба случая красятся одинаково, и оба лежат внутри области.
    selector: `${S}.${APP_CLASS}, ${S} .${APP_CLASS}`,
    declarations: [
      'background: var(--fx-surface-canvas)',
      'flex: 1',
      'min-width: 0',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
    ],
  },
  viewportRule,
  {
    // Слой наложений накрывает кадр целиком, но не красит его и не перехватывает
    // ввод: указатель должен доходить до кадра, а наложению, которому нужен
    // клик (gizmo из `viewport-services`), его вернёт собственное правило.
    selector: `.${VIEWPORT_CLASS} > .${VIEWPORT_OVERLAY_CLASS}`,
    declarations: [
      'position: absolute',
      'inset: 0',
      'background: none',
      'pointer-events: none',
      'padding: var(--fx-space-2)',
    ],
  },
];

/**
 * Раскладка — только то, из чего собран контрольный случай: ряд областей,
 * колонка с шагом сетки, кластер в строку. Раскладка каркаса (ED-23, ED-24)
 * сюда не входит и лежит у самого каркаса (`frame/styles.ts`): ширины зон —
 * свойство скелета, и два источника одного и того же здесь не заводятся.
 */
const LAYOUT_RULES: readonly CssRule[] = [
  { selector: `${S} .fx-main`, declarations: ['display: flex', 'flex: 1', 'min-height: 0'] },
  {
    selector: `${S} .fx-stack`,
    declarations: [
      'display: flex',
      'flex-direction: column',
      'gap: var(--fx-space-2)',
      'padding: var(--fx-space-3)',
    ],
  },
  {
    selector: `${S} .fx-cluster`,
    declarations: [
      'display: flex',
      'align-items: center',
      'gap: var(--fx-space-2)',
      'flex-wrap: wrap',
    ],
  },
  {
    selector: `${S} .fx-bar__title`,
    declarations: [
      'font-size: var(--fx-font-size-title)',
      'font-weight: var(--fx-font-weight-medium)',
      'flex: none',
    ],
  },
  {
    selector: `${S} .fx-bar__search`,
    declarations: ['flex: 1', 'min-width: 0', 'margin: 0 var(--fx-space-3)'],
  },
  // Место под кадр: рамка и размер принадлежат слоту, а не кадру. Кадр внутри
  // не красится ничем — ни одно правило `.fx-viewport` не читает токенов.
  {
    selector: `${S} .fx-frame-slot`,
    declarations: [
      'height: 220px',
      'display: flex',
      'border: var(--fx-hairline) solid var(--fx-border)',
      'border-radius: var(--fx-radius-md)',
      'overflow: hidden',
    ],
  },
  { selector: `${S} .fx-frame-slot > .fx-viewport`, declarations: ['flex: 1'] },
];

const SURFACE_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-panel`,
    declarations: [
      'background: var(--fx-surface-2)',
      'border-right: var(--fx-hairline) solid var(--fx-border)',
      'padding: 0 var(--fx-panel-padding)',
      'overflow: auto',
      'min-width: 0',
    ],
  },
  {
    selector: `${S} .fx-surface`,
    declarations: ['background: var(--fx-surface-1)', 'flex: 1', 'min-width: 0', 'overflow: auto'],
  },
  {
    selector: `${S} .fx-card`,
    declarations: [
      'background: var(--fx-surface-3)',
      'border: var(--fx-hairline) solid var(--fx-border)',
      'border-radius: var(--fx-radius-md)',
      'padding: var(--fx-space-2) var(--fx-space-3)',
      'box-shadow: var(--fx-elevation-raised)',
    ],
  },
  {
    selector: `${S} .fx-section`,
    declarations: [
      'height: var(--fx-row-dense)',
      'display: flex',
      'align-items: center',
      'gap: var(--fx-space-2)',
      'font-size: var(--fx-font-size-caption)',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'color: var(--fx-text-faint)',
      'border-bottom: var(--fx-hairline) solid var(--fx-border-subtle)',
    ],
  },
  {
    // Хром достижим на любой ширине окна (ED-22): не поместившийся элемент
    // переносится, а не уходит за границу зоны. Отсюда `flex-wrap` и
    // `min-height` вместо фиксированной высоты — строка бара в высоту не
    // изменилась, но вторая строка ей больше не запрещена.
    selector: `${S} .fx-bar`,
    declarations: [
      'background: var(--fx-surface-2)',
      'border-bottom: var(--fx-hairline) solid var(--fx-border)',
      'min-height: calc(var(--fx-control-height-action) + var(--fx-space-4))',
      'display: flex',
      'align-items: center',
      'flex-wrap: wrap',
      'gap: var(--fx-space-2)',
      'padding: var(--fx-space-1) var(--fx-space-3)',
      'flex: none',
    ],
  },
  {
    // Группа бара: перенос рвёт бар между группами, а не посреди пары
    // «уровень кисти / размер кисти». Держит пару вместе не запрет переноса, а
    // порядок раскладки flex — строки набираются целыми группами, и группа
    // уезжает на следующую строку целиком, пока она в строку помещается.
    //
    // Своего переноса группа при этом не запрещает, и это не косметика:
    // группа, которая шире всей полосы (поверхность правки на узком окне),
    // при `flex: none` просто уходила бы за границу зоны — поворот и удаление
    // становились недостижимы. ED-22 требует обратного, поэтому такая группа
    // сжимается и переносится внутри себя — последней мерой, а не первой.
    selector: `${S} .fx-bar__group`,
    declarations: [
      'display: flex',
      'align-items: center',
      'flex-wrap: wrap',
      'gap: var(--fx-space-2)',
      'flex: 0 1 auto',
      'min-width: 0',
    ],
  },
];

const ICON_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-icon`,
    declarations: [
      'width: var(--fx-icon-size)',
      'height: var(--fx-icon-size)',
      'flex: none',
      'display: block',
      'overflow: visible',
    ],
  },
  { selector: `${S} .fx-icon--lg`, declarations: ['width: var(--fx-icon-size-lg)', 'height: var(--fx-icon-size-lg)'] },
  { selector: `${S} .fx-icon__stroke`, declarations: ['fill: none', 'stroke: currentColor', 'stroke-width: 1.4', 'stroke-linecap: round', 'stroke-linejoin: round'] },
  { selector: `${S} .fx-icon__fill`, declarations: ['fill: currentColor', 'stroke: none'] },
];

const BUTTON_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-button`,
    declarations: [
      'height: var(--fx-control-height-action)',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'gap: var(--fx-space-1)',
      'padding: 0 var(--fx-space-3)',
      'border-radius: var(--fx-radius-sm)',
      'border: var(--fx-hairline) solid transparent',
      'background: none',
      'color: var(--fx-text-secondary)',
      'font-family: inherit',
      'font-size: var(--fx-font-size-label)',
      'font-weight: var(--fx-font-weight-regular)',
      'cursor: pointer',
      'transition: background var(--fx-motion-fast) var(--fx-motion-standard)',
    ],
  },
  {
    selector: `${S} .fx-button--secondary`,
    declarations: ['border-color: var(--fx-border-strong)'],
  },
  {
    selector: `${S} .fx-button--ghost`,
    declarations: ['color: var(--fx-text-muted)', 'padding: 0 var(--fx-space-2)'],
  },
  {
    // Кнопка-знак (ED-31): квадрат по высоте контрола — подписи в ней нет, и
    // горизонтальные поля кнопки с подписью растянули бы её в прямоугольник.
    selector: `${S} .fx-button--icon`,
    declarations: ['width: var(--fx-control-height-action)', 'padding: 0', 'flex: none'],
  },
  {
    // Нажатое состояние переключателя — тот же «включённый переключатель», за
    // которым ED-22 закрепил акцент, а не второй акцент: у `fx-toggle` он же.
    selector: `${S} .fx-button[aria-pressed='true']`,
    role: 'interactive',
    declarations: [
      'background: var(--fx-accent-wash)',
      'border-color: var(--fx-accent)',
      'color: var(--fx-accent-bright)',
    ],
  },
  {
    // Primary-действие — одно из пяти мест, за которыми ED-22 закрепил акцент.
    selector: `${S} .fx-button--primary`,
    role: 'interactive',
    declarations: [
      'background: var(--fx-accent-gradient)',
      'color: var(--fx-text-on-accent)',
      'font-weight: var(--fx-font-weight-strong)',
      'border-radius: var(--fx-radius-pill)',
      'padding: 0 var(--fx-space-4)',
    ],
  },
  {
    selector: `${S} .fx-button:hover:not([aria-disabled='true'])`,
    declarations: ['background-color: var(--fx-state-hover)'],
  },
  {
    selector: `${S} .fx-button--primary:hover:not([aria-disabled='true'])`,
    role: 'interactive',
    declarations: ['background-color: transparent', 'filter: brightness(1.08)'],
  },
  {
    selector: `${S} .fx-button:active:not([aria-disabled='true'])`,
    declarations: ['background-color: var(--fx-state-pressed)'],
  },
  {
    // Фокус — второе из пяти мест акцента.
    selector: `${S} .fx-button:focus-visible`,
    role: 'interactive',
    declarations: [
      'outline: var(--fx-hairline) solid var(--fx-accent)',
      'outline-offset: 1px',
    ],
  },
  {
    selector: `${S} .fx-button[aria-disabled='true']`,
    declarations: ['opacity: var(--fx-state-disabled-opacity)', 'cursor: default'],
  },
];

const FIELD_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-control`,
    declarations: ['display: flex', 'flex-direction: column', 'gap: var(--fx-space-half)', 'min-width: 0'],
  },
  {
    selector: `${S} .fx-input`,
    declarations: [
      'height: var(--fx-control-height)',
      'width: 100%',
      'min-width: 0',
      'background: var(--fx-surface-inset)',
      'border: var(--fx-hairline) solid var(--fx-border)',
      'border-radius: var(--fx-radius-sm)',
      'color: var(--fx-text-primary)',
      'font-family: inherit',
      'font-size: var(--fx-font-size-body)',
      'padding: 0 var(--fx-space-2)',
    ],
  },
  {
    selector: `${S} .fx-input--number`,
    declarations: ['font-variant-numeric: tabular-nums', 'text-align: right'],
  },
  {
    selector: `${S} .fx-input[readonly]`,
    declarations: ['color: var(--fx-text-muted)', 'background: var(--fx-surface-1)'],
  },
  {
    // Фокус в поле — акцентная рамка вместо нейтральной.
    selector: `${S} .fx-input:focus`,
    role: 'interactive',
    declarations: ['outline: none', 'border-color: var(--fx-accent)'],
  },
  {
    selector: `${S} .fx-select`,
    declarations: [
      'appearance: none',
      'padding-right: var(--fx-space-4)',
      'cursor: pointer',
    ],
  },
  {
    selector: `${S} .fx-select-wrap`,
    declarations: ['position: relative', 'display: flex', 'align-items: center', 'min-width: 0'],
  },
  {
    selector: `${S} .fx-select-wrap > .fx-icon`,
    declarations: [
      'position: absolute',
      'right: var(--fx-space-1)',
      'color: var(--fx-text-faint)',
      'pointer-events: none',
    ],
  },
];

const TOGGLE_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-toggle`,
    declarations: [
      'width: 34px',
      'height: 18px',
      'flex: none',
      'border-radius: var(--fx-radius-pill)',
      'background: var(--fx-border)',
      'border: none',
      'padding: 2px',
      'display: inline-flex',
      'justify-content: flex-start',
      'cursor: pointer',
      'transition: background var(--fx-motion-fast) var(--fx-motion-standard)',
    ],
  },
  {
    selector: `${S} .fx-toggle__knob`,
    declarations: [
      'width: 14px',
      'height: 14px',
      'border-radius: var(--fx-radius-pill)',
      'background: var(--fx-text-muted)',
    ],
  },
  {
    // Включённый переключатель — третье из пяти мест акцента (ED-22).
    selector: `${S} .fx-toggle.fx-is-on`,
    role: 'interactive',
    declarations: ['background: var(--fx-accent)', 'justify-content: flex-end'],
  },
  {
    selector: `${S} .fx-toggle.fx-is-on > .fx-toggle__knob`,
    role: 'interactive',
    declarations: ['background: var(--fx-text-on-accent)'],
  },
  {
    selector: `${S} .fx-toggle:focus-visible`,
    role: 'interactive',
    declarations: ['outline: var(--fx-hairline) solid var(--fx-accent)', 'outline-offset: 2px'],
  },
  {
    selector: `${S} .fx-toggle[aria-disabled='true']`,
    declarations: ['opacity: var(--fx-state-disabled-opacity)', 'cursor: default'],
  },
];

const ROW_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-tree, ${S} .fx-list`,
    declarations: ['display: flex', 'flex-direction: column', 'min-width: 0'],
  },
  {
    selector: `${S} .fx-row`,
    declarations: [
      'height: var(--fx-row-dense)',
      'display: flex',
      'align-items: center',
      'gap: var(--fx-space-1)',
      'padding-right: var(--fx-space-2)',
      'font-size: var(--fx-font-size-body)',
      'color: var(--fx-text-muted)',
      'cursor: default',
      'flex: none',
      'min-width: 0',
      'box-shadow: inset 3px 0 0 transparent',
    ],
  },
  {
    // Строка, в которой лежит собранный блок, а не подпись (ED-5): карточка
    // оператора, стопка вложенных строк, поле с подписью сверху. Плотность
    // приходит тем же токеном и остаётся плотностью — строка с одной подписью
    // и чипом по-прежнему ровно `--fx-row-dense`, — но потолком быть
    // перестаёт: `height` обрезал бы вложенное, и блоки Cast'а накладывались
    // бы друг на друга вместо того, чтобы встать друг под другом.
    selector: `${S} .fx-row--block`,
    declarations: [
      'height: auto',
      'min-height: var(--fx-row-dense)',
      'align-items: flex-start',
      'flex-wrap: wrap',
      'gap: var(--fx-space-1)',
      'padding: var(--fx-space-half) var(--fx-space-2) var(--fx-space-half) 0',
    ],
  },
  {
    // Вложенный блок занимает остаток строки: собранное под оператором шире
    // подписи слота, и прижимать его к её ширине значило бы читать документ
    // колонкой в три символа.
    //
    // Уже своего содержимого он при этом не становится (`min-width` остаётся
    // `auto`): у формулы Cast'а вложенность доходит до восьми уровней, и
    // разрешённое сжатие ниже min-content схлопывало бы её в столбик пикеров
    // шириной в стрелку. Не поместившееся уходит в прокрутку поверхности —
    // это след, а `.fx-surface` для того и `overflow: auto` (ED-22).
    selector: `${S} .fx-row--block > .fx-card, ${S} .fx-row--block > .fx-stack`,
    declarations: ['flex: 1 1 auto'],
  },
  {
    // Подпись слота не сжимается: имя места в документе — то, по чему блок и
    // читается, и укоротить его до многоточия значило бы спрятать адрес.
    selector: `${S} .fx-row--block > .fx-row__secondary`,
    declarations: ['flex: none', 'line-height: var(--fx-row-dense)'],
  },
  {
    selector: `${S} .fx-row:hover`,
    declarations: ['background: var(--fx-state-hover)'],
  },
  {
    // Выделение — четвёртое из пяти мест акцента. Полоса слева, а не заливка:
    // заливка акцентом на плотном списке съедает читаемость подписи.
    selector: `${S} .fx-row.fx-is-selected`,
    role: 'interactive',
    declarations: [
      'background: var(--fx-state-selected)',
      'color: var(--fx-text-primary)',
      'box-shadow: inset 3px 0 0 var(--fx-accent)',
    ],
  },
  {
    // Фокус клавиатуры — не выделение: по списку ходят стрелками, и строка под
    // фокусом может быть не той, что выбрана. Признак поэтому другой — рамка,
    // та же, что у кнопки и у поля.
    selector: `${S} .fx-row:focus-visible`,
    role: 'interactive',
    declarations: ['outline: var(--fx-hairline) solid var(--fx-accent)', 'outline-offset: -1px'],
  },
  {
    // Строка, которую сейчас нечем применить, приглушена — тем же способом, что
    // недоступная кнопка (ED-26). Признак несёт разметка (`aria-disabled`), а
    // прозрачность лишь показывает его.
    selector: `${S} .fx-row[aria-disabled='true']`,
    declarations: ['opacity: var(--fx-state-disabled-opacity)'],
  },
  {
    selector: `${S} .fx-row__label`,
    declarations: ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap', 'min-width: 0'],
  },
  {
    selector: `${S} .fx-row__secondary`,
    declarations: ['color: var(--fx-text-faint)', 'font-size: var(--fx-font-size-caption)'],
  },
  {
    selector: `${S} .fx-row__trailing`,
    declarations: ['margin-left: auto', 'color: var(--fx-text-faint)', 'font-size: var(--fx-font-size-caption)', 'display: flex', 'align-items: center', 'gap: var(--fx-space-1)'],
  },
  {
    selector: `${S} .fx-row__twisty`,
    declarations: [
      'width: var(--fx-indent-step)',
      'height: var(--fx-indent-step)',
      'flex: none',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'color: var(--fx-text-faint)',
      'background: none',
      'border: none',
      'padding: 0',
      'cursor: pointer',
    ],
  },
  {
    selector: `${S} .fx-tree .fx-row`,
    declarations: ['padding-left: calc(var(--fx-space-2) + var(--fx-indent-step) * var(--fx-depth, 0))'],
  },
  {
    selector: `${S} .fx-list .fx-row`,
    declarations: ['padding-left: var(--fx-space-2)'],
  },
];

const FIELD_TABLE_RULES: readonly CssRule[] = [
  {
    // Таблица полей — сетка на три колонки: подпись, контрол, признак типа.
    // Одна сетка на всю таблицу, а не сетка на строку: иначе колонки соседних
    // строк разъезжаются, и инспектор на сорок строк читается как лестница.
    selector: `${S} .fx-fields`,
    declarations: [
      'display: grid',
      'grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) auto',
      'align-items: center',
      'column-gap: var(--fx-space-2)',
      'min-width: 0',
    ],
  },
  { selector: `${S} .fx-field-row`, declarations: ['display: contents'] },
  {
    selector: `${S} .fx-field-row > *`,
    declarations: ['min-height: var(--fx-row-field)', 'display: flex', 'align-items: center', 'min-width: 0'],
  },
  {
    selector: `${S} .fx-field-row__label`,
    declarations: [
      'gap: var(--fx-space-1)',
      'color: var(--fx-text-muted)',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ],
  },
  {
    selector: `${S} .fx-field-row__note`,
    declarations: [
      'color: var(--fx-text-faint)',
      'font-size: var(--fx-font-size-caption)',
      'font-family: var(--fx-font-mono)',
      'justify-content: flex-end',
    ],
  },
  {
    selector: `${S} .fx-fields > .fx-section`,
    declarations: ['grid-column: 1 / -1'],
  },
  {
    selector: `${S} .fx-hint`,
    declarations: [
      'width: var(--fx-icon-size)',
      'height: var(--fx-icon-size)',
      'flex: none',
      'padding: 0',
      'border: none',
      'background: none',
      'color: var(--fx-text-faint)',
      'cursor: help',
    ],
  },
  {
    // Наведение — не одно из пяти мест, за которыми ED-22 закрепил акцент,
    // поэтому знак вопроса под курсором всего лишь становится заметнее.
    selector: `${S} .fx-hint:hover`,
    declarations: ['color: var(--fx-text-secondary)'],
  },
  {
    // Фокус — одно из пяти. Рамка та же, что у кнопки: признак фокуса в
    // интерфейсе один, иначе клавиатурный обход читается как разные элементы.
    selector: `${S} .fx-hint:focus-visible`,
    role: 'interactive',
    declarations: [
      'color: var(--fx-accent-bright)',
      'outline: var(--fx-hairline) solid var(--fx-accent)',
      'outline-offset: 1px',
    ],
  },
];

/**
 * Состояния валидации (ED-8). Ни одно правило здесь не читает акцентных
 * токенов, и наоборот — это и есть «акцент MUST NOT нести семантику состояния
 * данных» в проверяемом виде.
 *
 * Само сообщение — отдельный блок под контролом (положение), с иконкой формы,
 * различной для каждой строгости (иконка), и с текстом причины (причина).
 * Все три признака ED-22 несёт разметка, а не цвет.
 */
const VALIDATION_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-validation`,
    role: 'validation',
    declarations: [
      'display: flex',
      'align-items: flex-start',
      'gap: var(--fx-space-1)',
      'font-size: var(--fx-font-size-caption)',
      'line-height: var(--fx-line-height-dense)',
      'min-width: 0',
    ],
  },
  {
    selector: `${S} .fx-validation__reason`,
    role: 'validation',
    declarations: ['min-width: 0'],
  },
  {
    selector: `${S} .fx-validation--error`,
    role: 'validation',
    declarations: ['color: var(--fx-validation-error)'],
  },
  {
    selector: `${S} .fx-validation--warning`,
    role: 'validation',
    declarations: ['color: var(--fx-validation-warning)'],
  },
  {
    selector: `${S} .fx-validation--info`,
    role: 'validation',
    declarations: ['color: var(--fx-validation-info)'],
  },
  {
    selector: `${S} .fx-invalid--error > .fx-input, ${S} .fx-invalid--error > .fx-select-wrap > .fx-input`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-error)'],
  },
  {
    selector: `${S} .fx-invalid--warning > .fx-input, ${S} .fx-invalid--warning > .fx-select-wrap > .fx-input`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-warning)'],
  },
  {
    selector: `${S} .fx-invalid--info > .fx-input, ${S} .fx-invalid--info > .fx-select-wrap > .fx-input`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-info)'],
  },
  {
    // В строке дерева и списка сообщение уходит в хвост строки: положение
    // отличает его от подписи, а не только цвет.
    //
    // Хвост — не половина строки: без потолка длинная причина съедала подпись
    // до многоточия, и документ в навигаторе назывался «sc…». Тесно в строке
    // обоим, и порядок уступок задан: сжимается сперва причина (она урезается
    // осмысленно — иконка строгости остаётся, а текст целиком приходит
    // подсказкой, `withValidation`), и только потом имя, по которому строку и
    // находят.
    selector: `${S} .fx-row > .fx-validation`,
    role: 'validation',
    declarations: [
      'margin-left: auto',
      'align-items: center',
      'white-space: nowrap',
      'flex: 0 4 auto',
      'max-width: 50%',
      'overflow: hidden',
    ],
  },
  {
    selector: `${S} .fx-row > .fx-validation > .fx-validation__reason`,
    role: 'validation',
    declarations: ['overflow: hidden', 'text-overflow: ellipsis'],
  },
];

const CHIP_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-chip`,
    declarations: [
      'height: var(--fx-icon-size-lg)',
      'display: inline-flex',
      'align-items: center',
      'gap: var(--fx-space-half)',
      'padding: 0 var(--fx-space-2)',
      'border-radius: var(--fx-radius-pill)',
      'border: var(--fx-hairline) solid var(--fx-border)',
      'background: var(--fx-surface-3)',
      'color: var(--fx-text-muted)',
      'font-size: var(--fx-font-size-micro)',
      'white-space: nowrap',
      'flex: none',
    ],
  },
  {
    // Пятое место акцента: чип активного состояния — включённый инструмент,
    // текущая рабочая область. Состояния данных у чипа свои цвета, ниже.
    selector: `${S} .fx-chip--active`,
    role: 'interactive',
    declarations: [
      'background: var(--fx-accent-wash)',
      'border-color: var(--fx-accent)',
      'color: var(--fx-accent-bright)',
    ],
  },
  {
    selector: `${S} .fx-chip--error`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-error)', 'color: var(--fx-validation-error)'],
  },
  {
    selector: `${S} .fx-chip--warning`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-warning)', 'color: var(--fx-validation-warning)'],
  },
  {
    selector: `${S} .fx-chip--info`,
    role: 'validation',
    declarations: ['border-color: var(--fx-validation-info)', 'color: var(--fx-validation-info)'],
  },
];

const TOOLTIP_RULES: readonly CssRule[] = [
  {
    selector: `${S} .fx-tooltip`,
    declarations: [
      'max-width: 380px',
      'background: var(--fx-surface-overlay)',
      'border: var(--fx-hairline) solid var(--fx-border-strong)',
      'border-radius: var(--fx-radius-md)',
      'box-shadow: var(--fx-elevation-overlay)',
      'padding: var(--fx-space-2) var(--fx-space-3)',
      'display: flex',
      'flex-direction: column',
      'gap: var(--fx-space-half)',
      'color: var(--fx-text-secondary)',
      'font-size: var(--fx-font-size-body)',
    ],
  },
  {
    selector: `${S} .fx-tooltip__title`,
    declarations: ['color: var(--fx-text-primary)', 'font-weight: var(--fx-font-weight-medium)'],
  },
  {
    selector: `${S} .fx-tooltip__code`,
    declarations: [
      'font-family: var(--fx-font-mono)',
      'font-size: var(--fx-font-size-micro)',
      'color: var(--fx-text-faint)',
    ],
  },
];

/**
 * Все правила визуального языка в порядке каскада. Правила каркаса идут после
 * поверхностей, и это не косметика: зона скелета — это панель, которой каркас
 * задал ширину и сторону рамки, а специфичность у `.fx-panel` и
 * `.fx-zone--inspector` одна и та же. Встань каркас раньше — снятая им правая
 * рамка вернулась бы обратно, и инспектор получил бы обе.
 */
export const STYLE_RULES: readonly CssRule[] = [
  ...BASE_RULES,
  ...LAYOUT_RULES,
  ...SURFACE_RULES,
  ...FRAME_RULES,
  ...PALETTE_RULES,
  ...ICON_RULES,
  ...BUTTON_RULES,
  ...FIELD_RULES,
  ...TOGGLE_RULES,
  ...ROW_RULES,
  ...FIELD_TABLE_RULES,
  ...VALIDATION_RULES,
  ...CHIP_RULES,
  ...TOOLTIP_RULES,
];

function serialize(rule: CssRule): string {
  return `${rule.selector} {\n  ${rule.declarations.join(';\n  ')};\n}`;
}

/** Таблица стилей целиком — то, что уходит в `<style>`. */
export function editorStylesheet(): string {
  return STYLE_RULES.map(serialize).join('\n\n');
}

/**
 * Ставит таблицу в документ один раз. Идемпотентна: повторный вызов при
 * перемонтировании интерфейса не плодит вторую копию каскада.
 */
export function installStylesheet(doc: Document): HTMLStyleElement {
  const existing = doc.getElementById(STYLESHEET_ELEMENT_ID);
  if (existing !== null) return existing as HTMLStyleElement;
  const style = doc.createElement('style');
  style.id = STYLESHEET_ELEMENT_ID;
  style.textContent = editorStylesheet();
  doc.head.append(style);
  return style;
}
