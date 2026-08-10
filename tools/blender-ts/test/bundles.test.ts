/**
 * Бандл вкладов конвейера против самих вкладов (ED-27, ED-28) — тот же
 * двусторонний гейт, что стоит у редактора, только на своём пространстве
 * ключей: правило без описания и причина без правила обнаруживаются тестом, а
 * не автором, увидевшим на находке голый ключ.
 *
 * Ключи считаются ВЫВОДОМ из правила (`validationDescriptionPaths`), а не
 * перечнем рядом с бандлом: рукописный перечень — та же таблица, которую ED-28
 * запрещает, и разошёлся бы он так же молча.
 */
import { describe, expect, it } from 'vitest';
import {
  RULE_FAILED,
  StringResources,
  isReportEmpty,
  reasonKey,
  ruleDescriptionKey,
  validationDescriptionPaths,
} from '@game-mvp/editor-core';
import { BLENDER_BUNDLES, SPATIAL_LAYER_SYNC_RULE, spatialLayerSyncRule } from '../src/index.js';
import { importSpatialLayerOperation } from '../src/operation.js';

const rule = spatialLayerSyncRule({ sources: { stateOf: () => ({ status: 'none' }) } });
const PATHS = validationDescriptionPaths([rule]);

describe('ED-28: бандл конвейера и его вклады сходятся в обе стороны', () => {
  for (const locale of ['ru', 'en']) {
    it(`локаль ${locale}: ни недокументированной причины, ни осиротевшего ключа`, () => {
      const resources = new StringResources({ locale, editor: BLENDER_BUNDLES });
      const report = resources.report(PATHS, locale);
      expect(report.undocumented).toEqual([]);
      expect(report.orphaned).toEqual([]);
      expect(isReportEmpty(report)).toBe(true);
    });
  }

  it('у правила есть описание и причина на каждый объявленный код', () => {
    for (const locale of ['ru', 'en']) {
      const bundle = BLENDER_BUNDLES[locale]!;
      expect(bundle[ruleDescriptionKey(SPATIAL_LAYER_SYNC_RULE)]).toBeDefined();
      for (const code of [...rule.reasonCodes, RULE_FAILED]) {
        expect(bundle[reasonKey(SPATIAL_LAYER_SYNC_RULE, code)], `${locale}/${code}`).toBeDefined();
      }
    }
  });

  it('описания операции и каждого её параметра есть в обеих локалях (ED-27)', () => {
    const keys = [
      importSpatialLayerOperation.descriptionKey,
      ...Object.values(importSpatialLayerOperation.params).map((spec) => spec.descriptionKey),
    ];
    for (const locale of ['ru', 'en']) {
      for (const key of keys) expect(BLENDER_BUNDLES[locale]![key], `${locale}/${key}`).toBeDefined();
    }
  });

  it('состав ключей у локалей один и тот же: ru и en равноправны (ED-27)', () => {
    expect(Object.keys(BLENDER_BUNDLES.ru!).sort()).toEqual(Object.keys(BLENDER_BUNDLES.en!).sort());
  });

  it('подстановки перевода те же, что в источнике: параметр не выдумывается и не теряется', () => {
    const placeholders = (text: string): readonly string[] =>
      [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!).sort();
    const en = BLENDER_BUNDLES.en!;
    const ru = BLENDER_BUNDLES.ru!;
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key] ?? ''), key).toEqual(placeholders(en[key]!));
    }
  });
});
