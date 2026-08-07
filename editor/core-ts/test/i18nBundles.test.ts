/**
 * Стартовые бандлы редактора против реальных схем ядра (ED-28) и спутник
 * отпечатков перевода (ED-27, ED-28).
 *
 * Отчёт здесь — гейт, а не диагностика: поле схемы без описания и ресурс без
 * поля обнаруживаются тестом, а не глазами автора. Спутник сверяется с
 * генератором так же, как `engine/schemas/` со своим источником; пересобрать
 * его после правки перевода — `UPDATE_FINGERPRINTS=1 npx vitest run` из
 * `editor/core-ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_BUNDLES,
  EDITOR_FINGERPRINTS,
  SOURCE_LOCALE,
  StringResources,
  confirmTranslations,
  editorDescriptionPaths,
  fingerprintFileContent,
  isReportEmpty,
  translationStatus,
} from '../src/i18n/index.js';

const en = EDITOR_BUNDLES['en']!;
const ru = EDITOR_BUNDLES['ru']!;
const companion = fileURLToPath(
  new URL('../src/i18n/locales/editor.ru.fingerprints.json', import.meta.url),
);

describe('ED-28: бандл редактора и схемы сходятся в обе стороны', () => {
  const paths = editorDescriptionPaths();

  it('пути схемы вообще есть — иначе отчёт был бы пуст по недосмотру', () => {
    expect(paths.length).toBeGreaterThan(100);
  });

  for (const locale of ['en', 'ru']) {
    it(`локаль ${locale}: ни недокументированных полей, ни осиротевших ключей`, () => {
      const res = new StringResources({ locale, editor: EDITOR_BUNDLES });
      const report = res.report(paths, locale);
      expect(report.undocumented).toEqual([]);
      expect(report.orphaned).toEqual([]);
      expect(isReportEmpty(report)).toBe(true);
    });
  }

  it('оператор с точкой в имени описан под экранированным ключом', () => {
    expect(en['operator.vec\\.add']).toBeDefined();
    expect(ru['operator.vec\\.add']).toBeDefined();
  });
});

describe('ED-27: `ru` и `en` равноправны', () => {
  it('ни один ключ не остался без перевода', () => {
    expect(translationStatus(en, ru, EDITOR_FINGERPRINTS['ru']!).missing).toEqual([]);
  });

  it('переводы подтверждены и не протухли', () => {
    const status = translationStatus(en, ru, EDITOR_FINGERPRINTS['ru']!);
    expect(status.stale).toEqual([]);
    expect(status.unconfirmed).toEqual([]);
  });
});

describe('ED-28: спутник отпечатков пересобираем', () => {
  it('файл на диске совпадает с тем, что даёт генератор', () => {
    const expected = fingerprintFileContent(
      confirmTranslations('ru', en, ru, EDITOR_FINGERPRINTS['ru'], SOURCE_LOCALE),
    );
    if (process.env['UPDATE_FINGERPRINTS'] === '1') writeFileSync(companion, expected);
    expect(readFileSync(companion, 'utf8')).toBe(expected);
  });
});
