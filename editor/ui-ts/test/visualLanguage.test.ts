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
    // primary-действие. Активная область и включённый инструмент носят один и
    // тот же чип состояния.
    const places = [
      'fx-button--primary',
      ':focus',
      'fx-is-selected',
      'fx-is-on',
      'fx-chip--active',
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
