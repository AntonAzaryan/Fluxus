/**
 * Граница палитры на кадре вьюпорта (ED-22): «хром интерфейса MUST NOT
 * окрашивать вьюпорт… палитра интерфейса заканчивается на границе вьюпорта».
 *
 * Проверяется структурно, а не по комментарию: кадр вычтен из каскада токенов
 * (класс области на него не надет, каждый токен на нём погашен), и ни одно
 * правило, метящее в кадр, не читает переменных набора. Служебные наложения
 * внутри кадра требование не запрещает — у них свой слой, который вносит
 * область токенов обратно, но прозрачным фоном.
 */
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DESCRIPTIONS,
  controlCasePage,
  initialGalleryState,
} from '../src/gallery/controlCase.js';
import { uiResources } from '../src/i18n/uiBundles.js';
import { findAll, hasClass, type UiNode } from '../src/dom/node.js';
import {
  STYLE_RULES,
  TOKEN_SCOPE_CLASS,
  VIEWPORT_CLASS,
  VIEWPORT_OVERLAY_CLASS,
} from '../src/tokens/stylesheet.js';
import { TOKENS } from '../src/tokens/tokens.js';

const page = controlCasePage(
  uiResources('ru', SAMPLE_DESCRIPTIONS),
  initialGalleryState(),
  () => undefined,
);

const frames: readonly UiNode[] = findAll(
  page,
  (node) => hasClass(node, VIEWPORT_CLASS),
);

const resetRule = STYLE_RULES.find((rule) => rule.selector === `.${VIEWPORT_CLASS}`);

describe('ED-22: кадр вычтен из каскада токенов', () => {
  it('правило кадра гасит каждый токен набора', () => {
    expect(resetRule).toBeDefined();
    const declarations = new Set(resetRule?.declarations ?? []);
    for (const token of TOKENS) {
      expect(declarations.has(`${token.name}: initial`), token.name).toBe(true);
    }
  });

  it('кадр не наследует ни цвета, ни шрифта хрома', () => {
    const declarations = resetRule?.declarations ?? [];
    expect(declarations).toContain('background: none');
    expect(declarations).toContain('color: initial');
    expect(declarations).toContain('font: initial');
  });

  it('ни одно правило, метящее в кадр, не читает токенов', () => {
    const aimed = STYLE_RULES.filter(
      (rule) =>
        rule.selector.includes(`.${VIEWPORT_CLASS}`) &&
        !rule.selector.includes(VIEWPORT_OVERLAY_CLASS),
    );
    expect(aimed.length).toBeGreaterThan(0);
    for (const rule of aimed) {
      expect(rule.declarations.join(';'), rule.selector).not.toContain('var(--fx-');
    }
  });
});

describe('ED-22: наложения внутри кадра требованием не запрещены', () => {
  it('кадр на странице есть и класса области токенов не несёт', () => {
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.classes).not.toContain(TOKEN_SCOPE_CLASS);
  });

  it('наложения лежат в отдельном слое, который вносит область токенов обратно', () => {
    const overlayed = frames.filter((frame) => (frame.children ?? []).length > 0);
    expect(overlayed.length).toBeGreaterThan(0);
    for (const frame of overlayed) {
      for (const layer of frame.children ?? []) {
        expect(layer.classes).toContain(VIEWPORT_OVERLAY_CLASS);
        expect(layer.classes).toContain(TOKEN_SCOPE_CLASS);
      }
    }
  });

  it('слой наложений сам кадр не закрашивает', () => {
    const rule = STYLE_RULES.find(
      (candidate) => candidate.selector === `.${VIEWPORT_CLASS} > .${VIEWPORT_OVERLAY_CLASS}`,
    );
    expect(rule?.declarations).toContain('background: none');
    expect(rule?.declarations).toContain('pointer-events: none');
  });
});
