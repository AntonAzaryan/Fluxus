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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DESCRIPTIONS,
  controlCasePage,
  initialGalleryState,
} from '../src/gallery/controlCase.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import { documentValue, el, findAll, hasClass, walk, type UiNode } from '../src/dom/node.js';
import { statusChip } from '../src/widgets/chip.js';
import { STYLE_RULES } from '../src/tokens/stylesheet.js';
import { ICONS } from '../src/widgets/icon.js';
import {
  INVALID_CLASS_PREFIX,
  SEVERITY_ICONS,
  VALIDATION_CLASS,
  withValidation,
  type ValidationSeverity,
} from '../src/widgets/validation.js';
import {
  ContributionRegistry,
  CURVATURE_RULE,
  MANIFEST_RULE,
  SCENE_RULE,
  SYSTEM_RULE,
  createEditorSession,
  createOperationRegistry,
  createValidator,
  registerBuiltinOperations,
  registerValidationRules,
  type ValidationRule,
} from '@fluxus/editor-core';
import { SCENE_KINDS, sceneValidationRules } from '../src/areas/sceneProject.js';

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

  it('причина доступна целиком подсказкой: в строке её режет раскладка', () => {
    // Дефект, который это пиннит: в навигаторе длинная причина ужимала имя
    // документа до «sc…», а сама обрывалась на границе панели — без единого
    // способа прочитать её целиком. Потолок ширины ставит таблица стилей,
    // полный текст — подсказка, и текст этот тот же самый (ED-27).
    const reason = documentValue('у prefab’а «Fireball» нет записи в манифесте');
    const mark = markOf(withValidation(el('div', { classes: ['fx-row'] }), {
      severity: 'error',
      reason,
    }));
    expect(mark?.labels?.title).toEqual(reason);

    const rule = STYLE_RULES.find((entry) => entry.selector.endsWith('.fx-row > .fx-validation'));
    expect(rule?.declarations).toContain('max-width: 50%');
    // Уступает в тесной строке сперва причина, а не имя документа.
    expect(rule?.declarations).toContain('flex: 0 4 auto');
  });

  it('без состояния узел не меняется вовсе', () => {
    const plain = el('div', { classes: ['fx-control'] });
    expect(withValidation(plain, undefined)).toBe(plain);
  });

  it('состояние с пустой причиной не показывается вовсе', () => {
    // Тип требует причину, но пустую строку пропускает; пустая причина — это
    // ровно «различимо только оттенком», чего ED-22 не допускает.
    expect(() =>
      withValidation(el('div'), { severity: 'error', reason: documentValue('  ') }),
    ).toThrow('error');
  });

  it('имена классов строгости собирает один модуль пакета', () => {
    // Второй модуль, собирающий `fx-invalid--` или `fx-validation--` сам,
    // получил бы цвет строгости без иконки и причины. Таблица стилей эти имена
    // читает — она красит по ним, — но не строит.
    const dir = fileURLToPath(new URL('../src', import.meta.url));
    const builders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => /`\$\{?(INVALID_CLASS_PREFIX|VALIDATION_CLASS)/.test(
        readFileSync(`${dir}/${entry}`, 'utf8'),
      ));
    expect(builders).toEqual(['widgets/validation.ts']);
  });
});

describe('ED-22: чип строгости различим не только оттенком', () => {
  it.each(['error', 'warning', 'info'] as const)('тон %s приносит свою иконку', (tone) => {
    const chip = statusChip({ label: documentValue('3'), tone });
    const glyph = findAll(chip, (node) => node.attrs?.['data-icon'] !== undefined)[0];
    expect(glyph?.attrs?.['data-icon']).toBe(SEVERITY_ICONS[tone]);
  });

  it('иконки трёх тонов различны — иначе оттенок снова единственный признак', () => {
    const glyphs = (['error', 'warning', 'info'] as const).map(
      (tone) =>
        findAll(
          statusChip({ label: documentValue('3'), tone }),
          (node) => node.attrs?.['data-icon'] !== undefined,
        )[0]?.attrs?.['data-icon'],
    );
    expect(new Set(glyphs).size).toBe(3);
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

/**
 * ED-8: правила движка — часть набора, который приносит сборка редактора.
 *
 * Проверяется это здесь потому, что нарушение уже случалось молча: до прохода
 * `camera-effects-authoring` `sceneValidationRules()` возвращал одни
 * междокументные правила, `engineValidationRules()` звали только тесты
 * `editor/core-ts`, и `assets.manifest` — правило, которым ED-14 требует
 * подсвечивать секцию эффектов в реальном времени, — в собранном редакторе не
 * работало вовсе. Отсутствие правила ни один прогон интерфейса не красит: он
 * просто не показывает находок.
 */
describe('ED-8, ED-25: набор правил проекта', () => {
  const rules = sceneValidationRules();
  const byId = new Map(rules.map((rule) => [rule.id, rule]));

  it('правила движка в наборе есть, и каждое стоит на виде документа ЭТОГО проекта', () => {
    expect(byId.get(SCENE_RULE)?.appliesTo).toEqual([SCENE_KINDS.config]);
    expect(byId.get(MANIFEST_RULE)?.appliesTo).toEqual([SCENE_KINDS.visuals]);
    // Карта кривизны у проекта называется `terrain-curvature`, а не умолчанием
    // правила: с умолчанием оно не встало бы ни на один открытый документ.
    expect(byId.get(CURVATURE_RULE)?.appliesTo).toEqual([SCENE_KINDS.curvature]);
    // Систем-документов у проекта нет вовсе: его системы лежат списком внутри
    // конфига сцены (SYS-1, SER-7), и адреса их правило получает от сборки
    // (`systemSites`). С умолчальным видом `system` оно не встало бы ни на один
    // открытый документ — ровно та же беда, что у карты кривизны выше.
    expect(byId.get(SYSTEM_RULE)?.appliesTo).toEqual([SCENE_KINDS.config]);
  });

  it('находка правила систем адресует запись, а не конфиг целиком (ED-8, ED-30)', () => {
    const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    registerValidationRules(registry, rules);
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({
      id: 'scenes/arena.scene.json',
      kind: SCENE_KINDS.config,
      value: {
        components: [{ name: 'Pos', fields: { x: 'i32', y: 'i32' } }],
        prefabs: [{ name: 'grunt', components: { Pos: { x: 0, y: 0 } } }],
        capacity: 16,
        initial: [{ prefab: 'grunt' }],
        systems: [
          {
            name: 'haunt',
            order: 1,
            query: { all: ['Pos'] },
            // Компонента `Nope` в сцене нет — вердикт выносит `validateSystem`
            // ядра, а не редактор (ED-1).
            do: [
              { modifyComponent: { entity: { var: 'entity' }, component: 'Nope', values: {} } },
            ],
          },
        ],
      },
    });
    const report = createValidator({ rules: registry }).run(session);
    const issue = report.issues.find((found) => found.ruleId === SYSTEM_RULE);
    // Путь до записи — это то, чем находка отличается от «сцена не грузится»:
    // автор видит СВОЮ систему подсвеченной, а не документ целиком.
    expect(issue?.path).toEqual(['systems', 0]);
  });

  it('правило манифеста получило описание типов эффектов: секция проверяется по нему (ED-14)', () => {
    const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    registerValidationRules(registry, rules);
    const session = createEditorSession({
      operations: registerBuiltinOperations(createOperationRegistry()),
    });
    session.openDocument({
      id: 'visuals/manifest.json',
      kind: SCENE_KINDS.visuals,
      value: { entities: {}, cameraEffects: { events: { Boom: { effect: 'wobble-3000' } } } },
    });
    const report = createValidator({ rules: registry }).run(session);
    const issue = report.issues.find((found) => found.ruleId === MANIFEST_RULE);
    // Без описания правило о типах молчит — находка и есть доказательство, что
    // описание доехало до `validateManifest` (CAM-9).
    expect(issue?.severity).toBe('warning');
    expect(issue?.path).toEqual(['cameraEffects', 'events', 'Boom', 'effect']);
  });

  it('каждое правило в наборе ровно одно: двойная регистрация дублировала бы находки', () => {
    expect(byId.size).toBe(rules.length);
    // Реестр вкладов на повторный id отвечает отказом (ED-25) — набор, поданный
    // ему дважды, уронил бы сборку, а не удвоил находки молча.
    const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    registerValidationRules(registry, rules);
    expect(() => { registerValidationRules(registry, rules); }).toThrow();
  });
});
