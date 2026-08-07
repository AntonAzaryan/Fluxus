/**
 * Набор токенов визуального языка редактора (ED-22) — единственный источник
 * цвета, типографики, сетки отступов и плотности во всём пакете.
 *
 * Токены объявлены таблицей, а не россыпью CSS-правил, по трём причинам,
 * каждая из которых — требование, а не вкус:
 *
 * - Сброс токенов на границе вьюпорта (ED-22: «хром MUST NOT окрашивать
 *   вьюпорт») строится обходом этой таблицы. Новый токен попадает в сброс сам;
 *   забыть его нельзя, потому что забывать нечего.
 * - Плотность (ED-22: «инспектор с несколькими десятками строк — обычный
 *   случай») проверяется тестом арифметически, по значениям из таблицы, а не
 *   на глаз по картинке.
 * - Роль акцента (ED-22: «акцент MUST NOT нести семантику состояния данных»)
 *   проверяется тем, какие правила таблицы стилей упоминают акцентные токены,
 *   а какие — валидационные. Разделение имён здесь и есть разделение ролей.
 *
 * Значения взяты из референса раскладки `mockup.svg` (архив change
 * `editor-ui-shell`), а не придуманы заново: референс ненормативен, но он —
 * та самая калибровка тёмной базы, под которую написано ED-22. Светлой темы
 * нет и не будет: роль одного акцента на ахроматической базе на светлом фоне
 * не воспроизводится, и вторая тема — невходящая задача, а не отложенная.
 */

/**
 * Группа токена. Группа — не украшение каталога: `accent` и `validation`
 * разделены именно потому, что ED-22 запрещает им меняться местами, а тест
 * различает правила по тому, токены какой группы они читают.
 */
export type TokenGroup =
  | 'surface'
  | 'state'
  | 'border'
  | 'text'
  | 'accent'
  | 'validation'
  | 'type'
  | 'space'
  | 'density'
  | 'shape'
  | 'elevation'
  | 'motion';

export interface Token {
  /** Имя CSS-переменной вместе с префиксом `--fx-`. */
  readonly name: string;
  readonly value: string;
  readonly group: TokenGroup;
}

/**
 * Уровни поверхностей — Material-овская elevation, выраженная светлотой, а не
 * тенью: на ахроматической тёмной базе тень под панелью не видна, а разница
 * светлоты видна. Отсюда порядок: чем выше уровень, тем светлее.
 *
 * `inset` выпадает из этого порядка сознательно — утопленное (поле ввода,
 * строка поиска) темнее своей панели, иначе поле не читается как приёмник
 * ввода. `overlay` тоже: всплывающее лежит над панелями всех уровней сразу и
 * читается рамкой и тенью, а не собственной светлотой.
 */
const SURFACES: readonly Token[] = [
  { name: '--fx-surface-canvas', value: '#08090A', group: 'surface' },
  { name: '--fx-surface-1', value: '#0E0E0E', group: 'surface' },
  { name: '--fx-surface-2', value: '#181818', group: 'surface' },
  { name: '--fx-surface-3', value: '#1C1C1C', group: 'surface' },
  { name: '--fx-surface-inset', value: '#101010', group: 'surface' },
  { name: '--fx-surface-overlay', value: '#0B0B0B', group: 'surface' },
];

/**
 * Состояния элемента по Material — hover, pressed, selected, disabled — как
 * слой поверхности, а не как отдельный цвет на каждый виджет. Акцента здесь
 * нет: выделение красится поверхностью, а акцентом помечается только полоса
 * активного состояния, и это правило живёт в таблице стилей.
 */
const STATES: readonly Token[] = [
  { name: '--fx-state-hover', value: '#1F1F1F', group: 'state' },
  { name: '--fx-state-selected', value: '#232323', group: 'state' },
  { name: '--fx-state-pressed', value: '#262626', group: 'state' },
  { name: '--fx-state-disabled-opacity', value: '0.38', group: 'state' },
];

const BORDERS: readonly Token[] = [
  { name: '--fx-border', value: '#2C2C2C', group: 'border' },
  { name: '--fx-border-subtle', value: '#242424', group: 'border' },
  { name: '--fx-border-strong', value: '#3A3A3A', group: 'border' },
];

/**
 * Четыре ступени текста — от основного к едва заметному. Пятая,
 * `--fx-text-on-accent`, существует только ради заливки акцентом: тёмный текст
 * на лавовом — единственное сочетание, дающее там читаемый контраст.
 */
const TEXTS: readonly Token[] = [
  { name: '--fx-text-primary', value: '#E8E8E8', group: 'text' },
  { name: '--fx-text-secondary', value: '#C8C8C8', group: 'text' },
  { name: '--fx-text-muted', value: '#9E9E9E', group: 'text' },
  { name: '--fx-text-faint', value: '#6E6E6E', group: 'text' },
  { name: '--fx-text-on-accent', value: '#180B04', group: 'text' },
];

/**
 * Единственный акцент — лавовый. Закреплён за интерактивным состоянием:
 * выделение, фокус, активная рабочая область, включённый переключатель,
 * primary-действие (ED-22). Ни один токен этой группы не смеет появиться в
 * правиле, показывающем состояние данных, — тест таблицы стилей это и пиннит.
 *
 * `gradient` — заливка primary-действия; `wash` — фон включённого состояния;
 * `bright` — акцент как текст (сплошной `--fx-accent` на тексте кегля 10–12 px
 * недостаточно контрастен к тёмной поверхности).
 */
const ACCENTS: readonly Token[] = [
  { name: '--fx-accent', value: '#FF6A2B', group: 'accent' },
  { name: '--fx-accent-bright', value: '#FF8F4D', group: 'accent' },
  { name: '--fx-accent-wash', value: '#2A1710', group: 'accent' },
  {
    name: '--fx-accent-gradient',
    value: 'linear-gradient(135deg, #FF8A3D 0%, #F04B12 100%)',
    group: 'accent',
  },
];

/**
 * Цвета состояний валидации (ED-8). Красный ошибки и лавовый акцент лежат в
 * одном секторе спектра — это не недосмотр палитры, а данность, которую ED-22
 * и признаёт: различать их цветом нельзя, поэтому виджет валидации обязан
 * нести иконку, положение и причину, а цвет здесь — только подкрепление.
 */
const VALIDATIONS: readonly Token[] = [
  { name: '--fx-validation-error', value: '#FF6B6E', group: 'validation' },
  { name: '--fx-validation-warning', value: '#E0A33C', group: 'validation' },
  { name: '--fx-validation-info', value: '#6FA8D6', group: 'validation' },
];

/**
 * Типографика: шесть кеглей, три начертания, один межстрочный интервал.
 * Кегли взяты из референса и меньше материаловских по одной причине —
 * плотность таблицы полей. Гарнитура — системный стек, ни одного веб-шрифта:
 * ноль новых зависимостей.
 */
const TYPE: readonly Token[] = [
  {
    name: '--fx-font-family',
    value: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
    group: 'type',
  },
  { name: '--fx-font-mono', value: 'ui-monospace, Menlo, Consolas, monospace', group: 'type' },
  { name: '--fx-font-size-micro', value: '9px', group: 'type' },
  { name: '--fx-font-size-caption', value: '10px', group: 'type' },
  { name: '--fx-font-size-body', value: '11.5px', group: 'type' },
  { name: '--fx-font-size-label', value: '12px', group: 'type' },
  { name: '--fx-font-size-title', value: '13px', group: 'type' },
  { name: '--fx-font-size-heading', value: '16px', group: 'type' },
  { name: '--fx-font-weight-regular', value: '400', group: 'type' },
  { name: '--fx-font-weight-medium', value: '600', group: 'type' },
  { name: '--fx-font-weight-strong', value: '700', group: 'type' },
  { name: '--fx-line-height-dense', value: '16px', group: 'type' },
];

/** Сетка отступов — шаг 4 px с одной половинной ступенью для плотных строк. */
const SPACE: readonly Token[] = [
  { name: '--fx-space-half', value: '2px', group: 'space' },
  { name: '--fx-space-1', value: '4px', group: 'space' },
  { name: '--fx-space-2', value: '8px', group: 'space' },
  { name: '--fx-space-3', value: '12px', group: 'space' },
  { name: '--fx-space-4', value: '16px', group: 'space' },
  { name: '--fx-space-6', value: '24px', group: 'space' },
];

/**
 * Шкала плотности. Её контрольный случай назван прямо в ED-22 — инспектор с
 * несколькими десятками строк, — и она под него посчитана, а не унаследована
 * от материаловской мобильной плотности (48 dp на строку списка: сорок строк
 * такой высоты не помещаются в колонку инспектора и вдвое).
 *
 * Высота строки — единственный источник высоты у всех строковых виджетов:
 * `--fx-row-field` для таблицы полей, `--fx-row-dense` для дерева и списка.
 * Разница в 4 px не косметическая: строка поля несёт внутри себя контрол
 * высотой `--fx-control-height`, и без вертикального поля контрол упирается
 * в соседние строки.
 */
const DENSITY: readonly Token[] = [
  { name: '--fx-row-field', value: '28px', group: 'density' },
  { name: '--fx-row-dense', value: '24px', group: 'density' },
  { name: '--fx-control-height', value: '20px', group: 'density' },
  { name: '--fx-control-height-action', value: '28px', group: 'density' },
  { name: '--fx-indent-step', value: '14px', group: 'density' },
  { name: '--fx-panel-padding', value: '16px', group: 'density' },
  { name: '--fx-icon-size', value: '12px', group: 'density' },
  { name: '--fx-icon-size-lg', value: '16px', group: 'density' },
];

const SHAPE: readonly Token[] = [
  { name: '--fx-radius-sm', value: '4px', group: 'shape' },
  { name: '--fx-radius-md', value: '6px', group: 'shape' },
  { name: '--fx-radius-pill', value: '999px', group: 'shape' },
  { name: '--fx-hairline', value: '1px', group: 'shape' },
];

const ELEVATION: readonly Token[] = [
  { name: '--fx-elevation-raised', value: '0 1px 0 rgba(0, 0, 0, 0.4)', group: 'elevation' },
  { name: '--fx-elevation-overlay', value: '0 8px 24px rgba(0, 0, 0, 0.55)', group: 'elevation' },
];

const MOTION: readonly Token[] = [
  { name: '--fx-motion-fast', value: '90ms', group: 'motion' },
  { name: '--fx-motion-standard', value: 'cubic-bezier(0.2, 0, 0, 1)', group: 'motion' },
];

/** Полный набор токенов. Порядок — как в объявлении групп, он же порядок в CSS. */
export const TOKENS: readonly Token[] = [
  ...SURFACES,
  ...STATES,
  ...BORDERS,
  ...TEXTS,
  ...ACCENTS,
  ...VALIDATIONS,
  ...TYPE,
  ...SPACE,
  ...DENSITY,
  ...SHAPE,
  ...ELEVATION,
  ...MOTION,
];

const BY_NAME: ReadonlyMap<string, Token> = new Map(TOKENS.map((token) => [token.name, token]));

/** Имена токенов группы — то, из чего собираются и объявление, и сброс. */
export function tokensOf(group: TokenGroup): readonly Token[] {
  return TOKENS.filter((token) => token.group === group);
}

export function tokenValue(name: string): string {
  const token = BY_NAME.get(name);
  if (token === undefined) throw new Error(`editor-ui: токена ${name} нет в наборе`);
  return token.value;
}

/**
 * Значение токена в пикселях. Нужно арифметике плотности: высота инспектора на
 * сорока строках считается из токенов, а не измеряется на скриншоте.
 */
export function tokenPx(name: string): number {
  const value = tokenValue(name);
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (match === null) throw new Error(`editor-ui: токен ${name} не задан в пикселях: ${value}`);
  return Number(match[1]);
}
