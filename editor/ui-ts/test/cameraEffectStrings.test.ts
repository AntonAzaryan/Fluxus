/**
 * Гейт «бандл описаний эффектов ↔ описание типов камеры» (ED-28, CAM-9) — в обе
 * стороны, по образцу `editor/core-ts/test/i18nBundles.test.ts`.
 *
 * Обе стороны считаются по одному источнику — `CAMERA_EFFECTS_DESCRIPTION`, — и
 * рукописного перечня ключей рядом с бандлом нет: он был бы той самой таблицей
 * «поле → ключ», которую ED-28 запрещает, и разошёлся бы с описанием молча на
 * первом же типе, добавленном без правки перечня.
 *
 * Что это ловит: новый тип эффекта в коде камеры без строк — красный тест, а не
 * голый ключ на экране автора; и обратное — строка, оставшаяся от удалённого
 * параметра.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA_EFFECTS_DESCRIPTION } from '@fluxus/render';
import type { CameraEffectsDescription } from '@fluxus/assets';
import {
  CAMERA_EFFECT_BUNDLES,
  cameraEffectKeys,
  effectParamKey,
  effectTypeKey,
} from '../src/i18n/cameraEffectBundles.js';
import { uiResources } from '../src/i18n/uiBundles.js';

const LOCALES = ['ru', 'en'] as const;

describe('ED-28: бандл описаний эффектов и описание камеры сходятся в обе стороны', () => {
  const required = cameraEffectKeys(CAMERA_EFFECTS_DESCRIPTION);

  it('ключи вообще есть — иначе гейт стоял бы на пустом множестве', () => {
    expect(required.length).toBeGreaterThan(10);
  });

  it.each(LOCALES)('локаль %s: у каждого типа и каждого его параметра есть описание', (locale) => {
    const bundle = CAMERA_EFFECT_BUNDLES[locale] ?? {};
    for (const key of required) expect(bundle[key], `нет в ${locale}: ${key}`).toBeDefined();
  });

  it.each(LOCALES)('локаль %s: осиротевших ключей нет', (locale) => {
    const known = new Set(required);
    for (const key of Object.keys(CAMERA_EFFECT_BUNDLES[locale] ?? {})) {
      expect(known.has(key), `ключ без поля в описании: ${key}`).toBe(true);
    }
  });

  it('тип без строк обнаруживается гейтом, а не автором на экране', () => {
    // Тот же вывод путей на описании с выдуманным типом: ключей у него нет ни в
    // одной локали — ровно так выглядит новый тип, добавленный в камеру.
    const invented: CameraEffectsDescription = {
      types: [{ id: 'gust', kind: 'impulse', params: [{ name: 'power', defaultValue: 1 }] }],
      binding: { impulse: [{ name: 'amplitude', defaultValue: 0.6 }], lasting: [] },
    };
    const keys = cameraEffectKeys(invented);
    expect(keys).toEqual([
      effectTypeKey('gust'),
      effectParamKey('gust', 'power'),
      effectParamKey('gust', 'amplitude'),
    ]);
    for (const key of keys) expect(CAMERA_EFFECT_BUNDLES.ru?.[key]).toBeUndefined();
  });

  it.each(LOCALES)('локаль %s: описания разрешаются ресурсами интерфейса', (locale) => {
    // Бандл влит в `uiResources` рядом с хромом: подсказка поля берётся оттуда
    // же, откуда подпись кнопки, — второй цепочки разрешения не заводится.
    const resources = uiResources(locale);
    for (const key of required) expect(resources.lookup(key), key).toBeDefined();
  });
});
