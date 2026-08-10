/**
 * Визуальный язык как система (ED-22): роль акцента, ахроматическая база,
 * уровни поверхностей и состояния элементов.
 *
 * Проверяется не «красиво ли», а то, что требование называет прямо: акцент
 * один, закреплён за интерактивным состоянием и не несёт семантики состояния
 * данных. Проверить это по слитой в строку таблице стилей нечем, поэтому
 * правила и хранятся структурой с ролью — тест смотрит, какое правило какие
 * токены читает.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_RULES, editorStylesheet, type CssRule } from '../src/tokens/stylesheet.js';
import { TOKENS, tokensOf } from '../src/tokens/tokens.js';
import { findAll, hasClass, type UiNode } from '../src/dom/node.js';
import { ICONS } from '../src/widgets/icon.js';
import { keyLabel } from '../src/frame/keys.js';
import { CAMERA_KEYS } from '../src/areas/sceneCamera.js';
import { SCENE_AREA_KEYS, sceneArea } from '../src/areas/scene.js';
import { buildFrame, buildLoadedFrame, zoneOf } from './support/frame.js';

const body = (rule: CssRule): string => rule.declarations.join(';');
const mentions = (rule: CssRule, prefix: string): boolean => body(rule).includes(prefix);

/**
 * Селектор из нескольких через запятую — это несколько правил, записанных
 * вместе. Проверять их как одну строку значит разрешить протащить шестое место
 * акцента, приписав его к пятому: `.fx-a:hover, .fx-b:focus` содержит `:focus`,
 * а красит и наведение тоже.
 */
const parts = (rule: CssRule): readonly string[] => rule.selector.split(',').map((s) => s.trim());

/**
 * Правила, объявляющие токены, из проверки ролей исключены — и исключены по
 * имени, а не по признаку «есть объявление с `--fx-`»: иначе новое правило
 * выходило бы из-под проверки, просто объявив в себе любой токен.
 */
const declaring = ['.fx-tokens', '.fx-viewport'];
const painting = STYLE_RULES.filter((rule) => !declaring.includes(rule.selector));

describe('ED-22: набор токенов', () => {
  it('имена токенов уникальны и все с префиксом --fx-', () => {
    const names = TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith('--fx-'))).toBe(true);
  });

  it('базовые поверхности ахроматические — от чёрного к серому', () => {
    for (const token of tokensOf('surface')) {
      const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/.exec(token.value);
      expect(match, `${token.name} = ${token.value}`).not.toBeNull();
      const [r, g, b] = [match?.[1], match?.[2], match?.[3]].map((hex) => Number.parseInt(hex ?? '', 16));
      // Ахроматичность с допуском в две ступени: чистый серый вплоть до
      // #08090A референса, но не цветная поверхность.
      const spread = Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0);
      expect(spread, `${token.name} = ${token.value}`).toBeLessThanOrEqual(2);
    }
  });

  it('уровни поверхностей идут по возрастанию светлоты', () => {
    const levels = ['--fx-surface-canvas', '--fx-surface-1', '--fx-surface-2', '--fx-surface-3'];
    const lightness = levels.map((name) => {
      const token = TOKENS.find((candidate) => candidate.name === name);
      return Number.parseInt(token?.value.slice(1, 3) ?? '', 16);
    });
    expect([...lightness].sort((a, b) => a - b)).toEqual(lightness);
  });

  it('акцент один — лавовый, тёплый оранжево-красный', () => {
    const accents = tokensOf('accent');
    expect(accents.length).toBeGreaterThan(0);
    const solid = accents.filter((token) => token.value.startsWith('#'));
    for (const token of solid) {
      const r = Number.parseInt(token.value.slice(1, 3), 16);
      const g = Number.parseInt(token.value.slice(3, 5), 16);
      const b = Number.parseInt(token.value.slice(5, 7), 16);
      expect(r, token.name).toBeGreaterThan(g);
      expect(g, token.name).toBeGreaterThan(b);
    }
  });

  it('ступени текста идут от основной к едва заметной', () => {
    const ladder = ['--fx-text-primary', '--fx-text-secondary', '--fx-text-muted', '--fx-text-faint'];
    const levels = ladder.map((name) => {
      const token = TOKENS.find((candidate) => candidate.name === name);
      return Number.parseInt(token?.value.slice(1, 3) ?? '', 16);
    });
    expect([...levels].sort((a, b) => b - a)).toEqual(levels);
  });
});

describe('ED-22: акцент закреплён за интерактивным состоянием', () => {
  it('акцентный токен читают только правила интерактивного состояния', () => {
    for (const rule of painting) {
      if (!mentions(rule, 'var(--fx-accent')) continue;
      expect(rule.role, rule.selector).toBe('interactive');
    }
  });

  it('состояния данных красятся только валидационными токенами', () => {
    for (const rule of painting) {
      if (!mentions(rule, 'var(--fx-validation')) continue;
      expect(rule.role, rule.selector).toBe('validation');
    }
  });

  it('ни одно правило не смешивает акцент и состояние данных', () => {
    for (const rule of painting) {
      const both = mentions(rule, 'var(--fx-accent') && mentions(rule, 'var(--fx-validation');
      expect(both, rule.selector).toBe(false);
    }
  });

  it('акцент присутствует ровно в пяти местах, названных ED-22', () => {
    // Выделение, фокус, активная рабочая область, включённый переключатель,
    // primary-действие. Мест пять, признаков семь: активную область помечает
    // знак в рельсе (`fx-is-active`), а «включённый» носят переключатель
    // (`fx-is-on`), чип включённого инструмента (`fx-chip--active`) и
    // кнопка-знак с нажатым состоянием (`aria-pressed`, ED-31) — это один и
    // тот же случай, показанный тремя разными виджетами.
    const places = [
      'fx-button--primary',
      ':focus',
      'fx-is-selected',
      'fx-is-on',
      'fx-is-active',
      'fx-chip--active',
      "[aria-pressed='true']",
    ];
    const accented = painting.filter((rule) => mentions(rule, 'var(--fx-accent'));
    for (const place of places) {
      expect(
        accented.some((rule) => parts(rule).some((part) => part.includes(place))),
        place,
      ).toBe(true);
    }
    // Каждый селектор правила по отдельности: наведение, приписанное к фокусу
    // одной запятой, здесь и ловится.
    for (const rule of accented) {
      for (const part of parts(rule)) {
        expect(
          places.some((place) => part.includes(place)),
          part,
        ).toBe(true);
      }
    }
  });
});

describe('ED-22: таблица стилей', () => {
  it('каждое правило хрома действует только внутри области токенов', () => {
    const global = ['html', 'body', '#editor-root', '.fx-viewport'];
    for (const rule of STYLE_RULES) {
      for (const part of parts(rule)) {
        if (global.some((selector) => part.startsWith(selector))) continue;
        expect(part.startsWith('.fx-tokens'), part).toBe(true);
      }
    }
  });

  it('сериализуется в непустой CSS без незакрытых блоков', () => {
    const css = editorStylesheet();
    expect(css.length).toBeGreaterThan(0);
    expect((css.match(/\{/g) ?? []).length).toBe(STYLE_RULES.length);
    expect((css.match(/\}/g) ?? []).length).toBe(STYLE_RULES.length);
  });
});

/**
 * ED-31: «Инструменты и переключатели бара поверхности правки SHALL
 * опознаваться знаком, а не подписью… У каждого такого элемента SHALL быть
 * доступное имя и подсказка, и оба SHALL приходить строковыми ресурсами».
 *
 * Проверяется на собранной странице области, а не на списке знаков: заглушка
 * появляется не в наборе иконок, а в баре — там, где элементу «пока» ставят
 * чужой знак.
 */
const barsOf = (view: UiNode): UiNode[] => findAll(view, (node) => hasClass(node, 'fx-bar'));

const iconButtonsOf = (root: UiNode): UiNode[] =>
  findAll(root, (node) => hasClass(node, 'fx-button--icon'));

const iconNameOf = (node: UiNode): string | undefined =>
  findAll(node, (inner) => inner.attrs?.['data-icon'] !== undefined)[0]?.attrs?.['data-icon'];

describe('ED-31: инструменты вьюпорта — знак, имя, подсказка', () => {
  it('бар области сцены собран из знаковых элементов, а не из подписей', async () => {
    const { frame } = await buildLoadedFrame();
    const bar = barsOf(zoneOf(frame.view(), 'surface'))[0];
    expect(bar, 'у области сцены нет бара').toBeDefined();
    expect(iconButtonsOf(bar ?? { tag: 'div' }).length).toBeGreaterThanOrEqual(6);
  });

  it('у каждого знакового элемента есть имя и подсказка из ресурсов', async () => {
    const { frame, resources } = await buildLoadedFrame();
    for (const bar of barsOf(frame.view())) {
      for (const element of iconButtonsOf(bar)) {
        const name = element.labels?.ariaLabel;
        const title = element.labels?.title;
        expect(name?.origin, iconNameOf(element)).toBe('resource');
        expect(title?.origin, iconNameOf(element)).toBe('resource');
        expect(resources.lookup(name?.key ?? ''), name?.key).toBeDefined();
        // Знак объявлен и не подписан текстом: имя существует, но не нарисовано.
        expect(iconNameOf(element), name?.key).toBeDefined();
        expect(findAll(element, (inner) => inner.text !== undefined)).toHaveLength(0);
      }
    }
  });

  it('два элемента одного бара не несут одного знака', async () => {
    const { frame } = await buildLoadedFrame();
    for (const bar of barsOf(frame.view())) {
      const signs = iconButtonsOf(bar).map((element) => iconNameOf(element));
      expect(new Set(signs).size, signs.join(',')).toBe(signs.length);
    }
  });

  it('геометрия знаков различна попарно: чужой знак не различал бы элементы', () => {
    const shapes = Object.values(ICONS).map((geometry) => geometry.paths.join('|'));
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('переключатель облёта не меняет имени, а объявляет нажатое состояние', async () => {
    const { frame, stage } = await buildLoadedFrame();
    const flyOf = (): UiNode | undefined =>
      iconButtonsOf(frame.view()).find(
        (node) => node.labels?.ariaLabel?.key === 'ui.area.scene.cameraFly',
      );
    const before = flyOf();
    expect(before?.attrs?.['aria-pressed']).toBe('false');
    stage.toggleFly();
    const after = flyOf();
    // Имя то же самое, изменилось только состояние (ED-31, ED-22).
    expect(after?.labels?.ariaLabel?.key).toBe(before?.labels?.ariaLabel?.key);
    expect(after?.labels?.ariaLabel?.value).toBe(before?.labels?.ariaLabel?.value);
    expect(after?.attrs?.['aria-pressed']).toBe('true');
  });

  it('подсказка называет ту же клавишу, которая работает', async () => {
    const { frame } = await buildLoadedFrame();
    const fly = iconButtonsOf(frame.view()).find(
      (node) => node.labels?.ariaLabel?.key === 'ui.area.scene.cameraFly',
    );
    const declared = SCENE_AREA_KEYS.find((key) => key.code === CAMERA_KEYS.flyToggle);
    expect(declared).toBeDefined();
    // Перечень один: подсказка собрана из той же раскладки, по которой клавиша
    // и разбирается (ED-32), а не из второго списка «для подсказок».
    expect(fly?.labels?.title?.value).toContain(keyLabel(declared?.code ?? ''));
    expect(fly?.labels?.title?.suffix).toBe(` (${keyLabel(CAMERA_KEYS.flyToggle)})`);
  });

  it('недоступный элемент бара остаётся достижимым и объявленным (ED-26)', () => {
    // Без открытого проекта кадра нет, и кнопки камеры показаны недоступными.
    const { frame } = buildFrame([sceneArea]);
    const disabled = iconButtonsOf(frame.view()).filter(
      (node) => node.attrs?.['aria-disabled'] === 'true',
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const element of disabled) {
      // `aria-disabled`, а не `disabled`: из обхода элемент не выпадает.
      expect(element.attrs?.disabled).toBeUndefined();
      expect(element.labels?.ariaLabel?.origin).toBe('resource');
    }
  });
});
