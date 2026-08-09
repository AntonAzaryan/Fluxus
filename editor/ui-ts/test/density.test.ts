/**
 * Шкала плотности (ED-22): «инспектор с несколькими десятками строк — обычный
 * случай работы редактора, а не исключение».
 *
 * Считается по контрольному случаю — той же странице, что монтирует
 * приложение, — и по значениям токенов, а не по словам о плотности. Материал
 * тянет в мобильные 48 dp на строку списка; при них в колонку инспектора
 * референса помещается шестнадцать строк вместо двадцати семи, и первый же
 * такой шаг делает этот тест красным.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_DESCRIPTIONS, controlCaseFields } from '../src/gallery/controlCase.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import { fieldTableHeight } from '../src/widgets/fieldTable.js';
import { STYLE_RULES } from '../src/tokens/stylesheet.js';
import { tokenPx } from '../src/tokens/tokens.js';
import { findAll, hasClass } from '../src/dom/node.js';
import { buildLoadedFrame, zoneOf } from './support/frame.js';

/**
 * Высота колонки инспектора в референсе раскладки (`mockup.svg`: панель от
 * верхнего бара до низа доски). Референс ненормативен, но как мерка «сколько
 * строк видно разом» он честнее выдуманного числа.
 */
const REFERENCE_COLUMN = 776;

const rowField = tokenPx('--fx-row-field');
const rowDense = tokenPx('--fx-row-dense');

const fields = controlCaseFields(uiResources('ru', SAMPLE_DESCRIPTIONS));
const rowCount = fields.groups.reduce((total, group) => total + group.rows.length, 0);

describe('ED-22: плотность на контрольном случае', () => {
  it('контрольный случай — действительно инспектор в несколько десятков строк', () => {
    expect(rowCount).toBeGreaterThanOrEqual(40);
    expect(fields.groups.length).toBeGreaterThanOrEqual(4);
  });

  it('в колонке инспектора разом видно не меньше 24 строк полей', () => {
    expect(Math.floor(REFERENCE_COLUMN / rowField)).toBeGreaterThanOrEqual(24);
  });

  it('в той же колонке разом видно не меньше 30 строк дерева или списка', () => {
    expect(Math.floor(REFERENCE_COLUMN / rowDense)).toBeGreaterThanOrEqual(30);
  });

  it('весь контрольный случай укладывается в две высоты колонки', () => {
    const height = fieldTableHeight(fields, { rowField, rowDense });
    expect(height).toBeLessThanOrEqual(REFERENCE_COLUMN * 2);
  });

  it('контрол помещается в строку поля с полем сверху и снизу', () => {
    const control = tokenPx('--fx-control-height');
    expect(control).toBeLessThan(rowField);
    expect((rowField - control) % 2).toBe(0);
  });

  it('шкала отступов кратна четырём, кроме одной половинной ступени', () => {
    const steps = ['--fx-space-1', '--fx-space-2', '--fx-space-3', '--fx-space-4'];
    for (const step of steps) expect(tokenPx(step) % 4, step).toBe(0);
    expect(tokenPx('--fx-space-half')).toBe(2);
  });
});

describe('ED-22: высоту строк задают токены, а не виджеты', () => {
  const heightDeclarations = STYLE_RULES.flatMap((rule) =>
    rule.declarations
      .filter((declaration) => /^(height|min-height):/.test(declaration))
      .map((declaration) => ({ selector: rule.selector, declaration })),
  );

  it('строка дерева, строка списка и строка полей берут высоту из токена плотности', () => {
    const rowSelectors = ['.fx-row', '.fx-field-row > *'];
    for (const selector of rowSelectors) {
      const found = heightDeclarations.filter((entry) => entry.selector.endsWith(selector));
      expect(found.length, selector).toBeGreaterThan(0);
      for (const entry of found) expect(entry.declaration).toContain('var(--fx-row-');
    }
  });

  it('ни одна высота в таблице стилей не задана числом мимо токенов', () => {
    // Исключения: страница и её корень (высота окна — не плотность), бегунок
    // переключателя и место под кадр — форма конкретного виджета, а не строка
    // списка.
    const allowed = ['html, body', '#editor-root', '.fx-toggle', '.fx-frame-slot'];
    // `min-height: 0` и `height: 100%` — идиомы раскладки flex, а не метрика.
    const idioms = /^(height|min-height):\s*(0|100%|auto|none)$/;
    for (const entry of heightDeclarations) {
      if (idioms.test(entry.declaration)) continue;
      if (allowed.some((selector) => entry.selector.includes(selector))) continue;
      expect(entry.declaration, entry.selector).toContain('var(--fx-');
    }
  });
});

/**
 * ED-22: «Хром SHALL оставаться достижимым на любой ширине окна: элемент
 * управления, не помещающийся в свою полосу, SHALL переноситься либо уходить в
 * явный аффорданс переполнения и MUST NOT оказываться за границей зоны без
 * следа».
 *
 * Проверка структурная, а не пиксельная: раскладку в headless-прогоне не
 * посчитать, а утверждение требования — про то, что элемент остаётся в
 * разметке и что правило полосы разрешает ему перенос, а не обрезает его.
 */
describe('ED-22: бар достижим на любой ширине', () => {
  const barRule = STYLE_RULES.find((rule) => rule.selector.endsWith('.fx-bar'));

  it('строка бара берёт высоту из того же токена, что и раньше', () => {
    // Высота не изменилась — изменилось только то, что она больше не потолок:
    // `min-height` вместо `height`, иначе вторая строка обрезалась бы.
    const height = barRule?.declarations.find((entry) => /^(min-)?height:/.test(entry));
    expect(height).toBe('min-height: calc(var(--fx-control-height-action) + var(--fx-space-4))');
    expect(barRule?.declarations).not.toContain('overflow: hidden');
  });

  it('не поместившийся элемент переносится, а не уходит за границу зоны', () => {
    expect(barRule?.declarations).toContain('flex-wrap: wrap');
  });

  it('перенос рвёт бар между группами, а не посреди пары настроек', () => {
    const group = STYLE_RULES.find((rule) => rule.selector.endsWith('.fx-bar__group'));
    expect(group?.declarations).toContain('display: flex');
    // Пару «уровень кисти / размер кисти» держит вместе порядок раскладки
    // flex: строки набираются целыми группами, и группа уезжает на следующую
    // строку целиком. Растягиваться она при этом не имеет права — иначе
    // группы разъехались бы по полосе и без всякого переноса.
    expect(group?.declarations).toContain('flex: 0 1 auto');
  });

  it('группа шире полосы переносится внутри себя, а не уходит за границу зоны', () => {
    // Последняя мера, а не первая: сжимается и переносится только та группа,
    // которая одна в строке всё равно не помещается (поверхность правки на
    // узком окне). Без этого поворот, перевод и удаление становились
    // недостижимы — ровно то, что ED-22 запрещает.
    const group = STYLE_RULES.find((rule) => rule.selector.endsWith('.fx-bar__group'));
    expect(group?.declarations).toContain('flex-wrap: wrap');
    expect(group?.declarations).toContain('min-width: 0');
  });

  it('ни один элемент бара не выпадает из разметки: они лежат в группах', async () => {
    const { frame } = await buildLoadedFrame();
    const bar = findAll(zoneOf(frame.view(), 'surface'), (node) => hasClass(node, 'fx-bar'))[0];
    expect(bar).toBeDefined();
    const groups = (bar?.children ?? []).filter((node) => hasClass(node, 'fx-bar__group'));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // Прямых детей у бара ровно столько, сколько групп: элемент, оставленный
    // мимо группы, переносился бы сам по себе и рвал бы пару.
    expect(bar?.children?.length).toBe(groups.length);
  });
});
