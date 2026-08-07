/**
 * Состояния валидации (ED-8) в интерфейсе (ED-22): различимы иконкой,
 * положением и текстом причины, а не только оттенком.
 *
 * Это требование, которое проще всего нарушить молча — покрасить рамку и
 * счесть работу сделанной. Поэтому проверяется не наличие цвета, а инвариант
 * разметки: у каждого узла с признаком нарушения внутри лежит блок с иконкой
 * своей формы и непустой причиной. Инвариант держится тем, что признак и блок
 * ставит один вызов `withValidation`, и разъединить их вызывающему нечем.
 */
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DESCRIPTIONS,
  controlCasePage,
  initialGalleryState,
} from '../src/gallery/controlCase.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import { documentValue, el, findAll, hasClass, walk, type UiNode } from '../src/dom/node.js';
import { ICONS } from '../src/widgets/icon.js';
import {
  INVALID_CLASS_PREFIX,
  SEVERITY_ICONS,
  VALIDATION_CLASS,
  withValidation,
  type ValidationSeverity,
} from '../src/widgets/validation.js';

const page = controlCasePage(
  uiResources('ru', SAMPLE_DESCRIPTIONS),
  initialGalleryState(),
  () => undefined,
);

function markOf(node: UiNode): UiNode | undefined {
  return findAll(node, (candidate) => hasClass(candidate, VALIDATION_CLASS))[0];
}

describe('ED-22: иконки состояний различаются формой', () => {
  it('каждой строгости — своя иконка', () => {
    const names = Object.values(SEVERITY_ICONS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('геометрия иконок строгостей попарно различна', () => {
    const shapes = Object.values(SEVERITY_ICONS).map((name) => ICONS[name].paths.join(' '));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('ED-22: признак нарушения не существует без иконки и причины', () => {
  const severities: readonly ValidationSeverity[] = ['error', 'warning', 'info'];

  it.each(severities)('withValidation ставит и признак, и объяснение: %s', (severity) => {
    const reason = documentValue(`${severity}-reason`);
    const node = withValidation(el('div', { classes: ['fx-control'] }), { severity, reason });

    expect(node.classes).toContain(`${INVALID_CLASS_PREFIX}${severity}`);
    const mark = markOf(node);
    expect(mark).toBeDefined();
    expect(mark?.attrs?.['data-severity']).toBe(severity);

    const iconNode = findAll(mark ?? node, (candidate) => candidate.attrs?.['data-icon'] !== undefined)[0];
    expect(iconNode?.attrs?.['data-icon']).toBe(SEVERITY_ICONS[severity]);

    const reasonNode = findAll(
      mark ?? node,
      (candidate) => hasClass(candidate, `${VALIDATION_CLASS}__reason`),
    )[0];
    expect(reasonNode?.text?.value).toBe(reason.value);
  });

  it('без состояния узел не меняется вовсе', () => {
    const plain = el('div', { classes: ['fx-control'] });
    expect(withValidation(plain, undefined)).toBe(plain);
  });
});

describe('ED-22: инвариант на контрольном случае', () => {
  const flagged = findAll(page, (node) =>
    (node.classes ?? []).some((className) => className.startsWith(INVALID_CLASS_PREFIX)),
  );

  it('на странице встречаются все три строгости — проверка не пустая', () => {
    const found = new Set(
      flagged.flatMap((node) =>
        (node.classes ?? [])
          .filter((className) => className.startsWith(INVALID_CLASS_PREFIX))
          .map((className) => className.slice(INVALID_CLASS_PREFIX.length)),
      ),
    );
    expect([...found].sort()).toEqual(['error', 'info', 'warning']);
  });

  it('у каждого помеченного узла внутри есть иконка и непустая причина', () => {
    expect(flagged.length).toBeGreaterThan(0);
    for (const node of flagged) {
      const severity = (node.classes ?? [])
        .find((className) => className.startsWith(INVALID_CLASS_PREFIX))
        ?.slice(INVALID_CLASS_PREFIX.length);
      const mark = markOf(node);
      expect(mark, `узел с ${String(severity)} без блока причины`).toBeDefined();
      expect(mark?.attrs?.['data-severity']).toBe(severity);

      const icons = [...walk(mark ?? node)].filter(
        (candidate) => candidate.attrs?.['data-icon'] !== undefined,
      );
      expect(icons.length, 'блок причины без иконки').toBeGreaterThan(0);

      const reason = findAll(
        mark ?? node,
        (candidate) => hasClass(candidate, `${VALIDATION_CLASS}__reason`),
      )[0];
      expect(reason?.text?.value.trim().length ?? 0, 'пустая причина').toBeGreaterThan(0);
    }
  });

  it('выделение и нарушение в одном дереве различаются не только цветом', () => {
    // Сценарий ED-22 «ошибка и выделение в одном списке»: у выделения —
    // признак активного состояния, у нарушения — иконка и причина.
    const rows = findAll(page, (node) => hasClass(node, 'fx-row'));
    const selected = rows.filter((row) => row.attrs?.['aria-selected'] === 'true');
    const broken = rows.filter((row) =>
      (row.classes ?? []).some((className) => className.startsWith(INVALID_CLASS_PREFIX)),
    );

    expect(selected.length).toBeGreaterThan(0);
    expect(broken.length).toBeGreaterThan(0);
    for (const row of selected) expect(markOf(row)).toBeUndefined();
    for (const row of broken) expect(row.attrs?.['aria-selected']).toBe('false');
  });
});
