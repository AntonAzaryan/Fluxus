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
    const steps = ['--fx-space-1', '--fx-space-2', '--fx-space-3', '--fx-space-4', '--fx-space-6'];
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
