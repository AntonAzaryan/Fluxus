/**
 * Стартовые бандлы редактора против реальных схем ядра (ED-28) и спутник
 * отпечатков перевода (ED-27, ED-28).
 *
 * Отчёт здесь — гейт, а не диагностика: поле схемы без описания и ресурс без
 * поля обнаруживаются тестом, а не глазами автора. Спутник сверяется с
 * генератором так же, как `engine/schemas/` со своим источником; пересобрать
 * его после правки перевода — `UPDATE_FINGERPRINTS=1 npx vitest run` из
 * `editor/core-ts`.
 *
 * Гейт стоит на двух пространствах ключей, и оба он выводит, а не перечисляет:
 * пути схем ядра (`editorDescriptionPaths`) и правила валидации с их причинами
 * (`validationDescriptionPaths` от самих правил). Источников правил два —
 * вклады слоя валидации и правило фазы записи (ED-21), которого до сохранения
 * не существует; третий источник пришлось бы добавить сюда, и незамеченным это
 * не останется: его строки в бандле числились бы осиротевшими, а без строк
 * автор увидел бы на находке голый ключ (ED-28).
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
  descriptionKey,
  editorDescriptionPaths,
  fingerprintFileContent,
  isReportEmpty,
  translationStatus,
} from '../src/i18n/index.js';
import {
  builtinValidationRules,
  reasonKey,
  ruleDescriptionKey,
  validationDescriptionPaths,
  RULE_FAILED,
} from '../src/validation/index.js';
import { GROUP_WRITE_REASONS } from '../src/project/index.js';

const en = EDITOR_BUNDLES['en']!;
const ru = EDITOR_BUNDLES['ru']!;
const companion = fileURLToPath(
  new URL('../src/i18n/locales/editor.ru.fingerprints.json', import.meta.url),
);

/** Все правила, которые пакет везёт с собой, — по ним считаются ключи причин. */
const SHIPPED_RULES = [...builtinValidationRules(), GROUP_WRITE_REASONS];

const PATHS = [...editorDescriptionPaths(), ...validationDescriptionPaths(SHIPPED_RULES)];

describe('ED-28: бандл редактора и схемы сходятся в обе стороны', () => {
  const paths = PATHS;

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

describe('ED-28: пространство валидации в отчёте участвует наравне со схемами', () => {
  it('правило без описания числится недокументированным, а лишняя причина — осиротевшей', () => {
    // Обе стороны на одном примере: правило, которого в бандле нет, и ключ
    // причины под кодом, которого правило не сообщает. Именно так выглядит
    // переименование — и именно по паре записей оно отличимо от удаления.
    const stranger = { id: 'test.stranger', reasonCodes: ['odd'] };
    const res = new StringResources({
      locale: 'en',
      editor: EDITOR_BUNDLES,
      project: { en: { [reasonKey('test.stranger', 'even')]: 'Orphaned reason' } },
    });
    const report = res.report([...PATHS, ...validationDescriptionPaths([stranger])], 'en');
    expect(report.undocumented).toEqual([
      reasonKey('test.stranger', 'odd'),
      reasonKey('test.stranger', RULE_FAILED),
      ruleDescriptionKey('test.stranger'),
    ]);
    expect(report.orphaned).toEqual([reasonKey('test.stranger', 'even')]);
  });

  it('коды выводятся из правил: у каждого правила описание и причина на каждый код', () => {
    // Перечня ключей рядом с бандлом нет — есть правила, и ключ каждого из них
    // спрашивается у бандла тем же выводом, каким его минтит находка.
    for (const rule of SHIPPED_RULES) {
      expect(en[ruleDescriptionKey(rule.id)], rule.id).toBeDefined();
      for (const code of [...rule.reasonCodes, RULE_FAILED]) {
        expect(en[reasonKey(rule.id, code)], `${rule.id}/${code}`).toBeDefined();
      }
    }
  });

  it('ключ причины — тот же ключ, что у описания поля: разбор и вывод сходятся', () => {
    // Точка внутри id правила — разделитель сегментов пути, а не символ имени:
    // иначе ключ из отчёта не совпал бы с ключом находки, и обе стороны отчёта
    // считались бы по разным строкам.
    expect(
      descriptionKey(validationDescriptionPaths([{ id: 'editor.curvatureGrid', reasonCodes: ['gridMismatch'] }])[1]!),
    ).toBe('validation.reason.editor.curvatureGrid.gridMismatch');
  });

  it('подстановки перевода те же, что в источнике: параметр не выдумывается и не теряется', () => {
    const placeholders = (text: string): readonly string[] =>
      [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!).sort();
    for (const key of Object.keys(en).filter((candidate) => candidate.startsWith('validation.'))) {
      expect(placeholders(ru[key] ?? ''), key).toEqual(placeholders(en[key]!));
    }
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
