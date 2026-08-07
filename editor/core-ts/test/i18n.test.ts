/**
 * Строковые ресурсы: локали (ED-27) и подсказки к полям (ED-28).
 *
 * Тесты пинят механизм, а не тексты: какой ключ выводится из пути, в каком
 * порядке разрешается ресурс, что видно, когда ресурса нет, и почему смена
 * языка не может изменить документ. Содержание стартовых бандлов проверяет
 * `i18nBundles.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  StringResources,
  catalogDescriptions,
  confirmTranslations,
  descriptionKey,
  fingerprint,
  keyKind,
  reportResources,
  schemaPathOf,
  translationStatus,
  type FingerprintFile,
  type LocaleBundle,
  type SchemaPath,
} from '../src/i18n/index.js';

const EN: LocaleBundle = {
  'component.Health.max': 'Upper bound of health.',
  'component.Health.value': 'Current health.',
  'ui.save': 'Save',
};

const RU: LocaleBundle = {
  'component.Health.max': 'Верхняя граница здоровья.',
  'ui.save': 'Сохранить',
};

function resources(project?: Record<string, LocaleBundle>): StringResources {
  return new StringResources({ locale: 'ru', editor: { en: EN, ru: RU }, project });
}

describe('ED-28: ключ выводится из пути поля в схеме', () => {
  it('ключ — путь схемы, а не запись рукописной таблицы', () => {
    expect(descriptionKey(['component', 'Health', 'max'])).toBe('component.Health.max');
    expect(descriptionKey(['action', 'spawnEntity'])).toBe('action.spawnEntity');
    expect(descriptionKey(['cameraEffect', 'shake', 'amplitude'])).toBe('cameraEffect.shake.amplitude');
  });

  it('имя с точкой не сливается с вложенным путём', () => {
    // Оператор DSL называется `vec.add` — случай не гипотетический.
    expect(descriptionKey(['operator', 'vec.add'])).not.toBe(descriptionKey(['operator', 'vec', 'add']));
    expect(descriptionKey(['operator', 'vec.add'])).toBe('operator.vec\\.add');
  });

  it('путь без имени и пустой сегмент — ошибка, а не тихо испорченный ключ', () => {
    expect(() => descriptionKey(['component', ''])).toThrow();
    expect(() => schemaPathOf('component', [])).toThrow();
  });

  it('вид читается из самого ключа, а не из списка известных видов', () => {
    // ED-25: список видов внутри слоя ресурсов означал бы, что новое
    // редактируемое правит каркас. Вид — первый сегмент до неэкранированной
    // точки, и разбор одинаков для любого вида, включая ещё не существующий.
    expect(keyKind('component.Health.max')).toBe('component');
    expect(keyKind('operator.vec\\.add')).toBe('operator');
    expect(keyKind('своиВклад.thing')).toBe('своиВклад');
    // Ключ без точки видом не обладает и ни с одним видом путей не совпадёт.
    expect(keyKind('save')).toBe('');
  });

  it('описание находится по пути, а не по отдельно заведённому ключу', () => {
    const path: SchemaPath = ['component', 'Health', 'max'];
    expect(resources().describe(path)).toBe(RU[descriptionKey(path)]);
  });
});

describe('ED-28: цепочка разрешения', () => {
  it('описание на текущей локали', () => {
    expect(resources().describe(['component', 'Health', 'max'])).toBe('Верхняя граница здоровья.');
  });

  it('нет на текущей локали — берётся `en`', () => {
    const hint = resources().hint(['component', 'Health', 'value']);
    expect(hint.text).toBe('Current health.');
    expect(hint.hit?.locale).toBe('en');
  });

  it('нет ни на одной локали — показывается сам ключ', () => {
    const hint = resources().hint(['component', 'Health', 'regen']);
    expect(hint.text).toBe('component.Health.regen');
    expect(hint.hit).toBeUndefined();
  });

  it('пустая подсказка не показывается: пустой ресурс равен отсутствующему', () => {
    const res = new StringResources({
      locale: 'ru',
      editor: { en: EN, ru: { ...RU, 'component.Health.value': '   ' } },
    });
    expect(res.describe(['component', 'Health', 'value'])).toBe('Current health.');
  });

  it('бандл проекта поверх бандла редактора — внутри одной локали', () => {
    const res = resources({ ru: { 'component.Health.max': 'Максимум здоровья юнита.' } });
    expect(res.lookup('component.Health.max')).toEqual({
      text: 'Максимум здоровья юнита.',
      locale: 'ru',
      source: 'project',
    });
  });

  it('локаль снаружи, источник внутри: `ru` редактора выигрывает у `en` проекта', () => {
    const res = resources({ en: { 'component.Health.max': 'Project override.' } });
    expect(res.describe(['component', 'Health', 'max'])).toBe('Верхняя граница здоровья.');
  });
});

describe('ED-28: двусторонний отчёт о рассогласовании', () => {
  it('переименование поля даёт и недокументированное поле, и осиротевший ключ', () => {
    const report = resources().report([['component', 'Health', 'maxHealth']], 'ru');
    expect(report.undocumented).toContain('component.Health.maxHealth');
    expect(report.orphaned).toContain('component.Health.max');
  });

  it('строки хрома в отчёт не попадают', () => {
    const report = resources().report([['component', 'Health', 'max']], 'ru');
    expect(report.orphaned).not.toContain('ui.save');
  });

  it('вид, о путях которого не спросили, в осиротевшие не записывается', () => {
    // Отчёт покрывает ровно те виды, чьи пути ему подали. Иначе слою ресурсов
    // пришлось бы знать список видов — то есть каркасу пришлось бы знать
    // редактируемое (ED-25).
    const res = new StringResources({
      locale: 'ru',
      editor: { ru: { 'component.Health.max': 'Есть', 'операция.тык': 'Есть' } },
    });
    expect(res.report([['component', 'Health', 'max']], 'ru').orphaned).toEqual([]);
    expect(res.report([['операция', 'иная']], 'ru').orphaned).toEqual(['операция.тык']);
  });

  it('ресурс с пустым текстом оставляет поле недокументированным', () => {
    const report = reportResources([['component', 'Health', 'max']], []);
    expect(report).toEqual({ undocumented: ['component.Health.max'], orphaned: [] });
  });
});

describe('ED-30: описания каталога — те же строки, что видит человек на `en`', () => {
  it('резолвер каталога отвечает по ключу и не следует за локалью пользователя', () => {
    const res = resources();
    const catalog = catalogDescriptions(res);
    expect(res.locale).toBe('ru');
    expect(catalog.describe('component.Health.max')).toBe(EN['component.Health.max']);
    res.setLocale('ru');
    expect(catalog.describe('component.Health.max')).toBe(EN['component.Health.max']);
    // Ресурса нет — виден сам ключ: отсутствие описания машинный потребитель
    // обязан различать так же, как человек (ED-28).
    expect(catalog.describe('component.Health.regen')).toBe('component.Health.regen');
  });
});

describe('ED-28: протухший перевод отличим от актуального', () => {
  const source = { 'component.Health.max': 'Upper bound of health.' };
  const translated = { 'component.Health.max': 'Верхняя граница здоровья.' };
  const confirmed = confirmTranslations('ru', source, translated, undefined);

  it('подтверждённый перевод чист', () => {
    expect(translationStatus(source, translated, confirmed)).toEqual({
      stale: [],
      unconfirmed: [],
      missing: [],
    });
  });

  it('английское описание переписали, перевод не тронули — перевод протух', () => {
    const rewritten = { 'component.Health.max': 'Upper bound of health, in Q16.16.' };
    expect(translationStatus(rewritten, translated, confirmed).stale).toEqual(['component.Health.max']);
  });

  it('повторное подтверждение не стирает признак: перевод-то прежний', () => {
    const rewritten = { 'component.Health.max': 'Upper bound of health, in Q16.16.' };
    const again = confirmTranslations('ru', rewritten, translated, confirmed);
    expect(translationStatus(rewritten, translated, again).stale).toEqual(['component.Health.max']);
  });

  it('перевод правили — он ждёт пересборки спутника, а после неё чист', () => {
    const rewritten = { 'component.Health.max': 'Upper bound of health, in Q16.16.' };
    const retranslated = { 'component.Health.max': 'Верхняя граница здоровья, в Q16.16.' };
    expect(translationStatus(rewritten, retranslated, confirmed).unconfirmed).toEqual([
      'component.Health.max',
    ]);
    const again = confirmTranslations('ru', rewritten, retranslated, confirmed);
    expect(translationStatus(rewritten, retranslated, again)).toEqual({
      stale: [],
      unconfirmed: [],
      missing: [],
    });
  });

  it('непереведённый ключ — отдельное состояние, а не протухание', () => {
    expect(translationStatus({ ...source, 'ui.save': 'Save' }, translated, confirmed).missing).toEqual([
      'ui.save',
    ]);
  });

  it('отпечаток различает разный текст и не различает одинаковый', () => {
    expect(fingerprint('Upper bound of health.')).toBe(fingerprint('Upper bound of health.'));
    expect(fingerprint('Upper bound of health.')).not.toBe(fingerprint('Upper bound of health'));
  });
});

describe('ED-27: локали переключаются, документы не меняются', () => {
  /**
   * Сцена как документ на диске. Каноническую сериализацию несёт round-trip
   * ED-21 (W1-6); здесь важно другое — у слоя ресурсов нет пути к документу,
   * поэтому один и тот же документ даёт один и тот же текст в любой локали.
   */
  const scene = {
    components: [{ name: 'Health', fields: { max: 'fixed', value: 'fixed' } }],
    prefabs: [{ name: 'Fighter', components: { Health: { max: 65536, value: 65536 } } }],
  };
  const save = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`;

  it('смена языка не меняет ни байта: «открыл — сохранил» даёт пустой дифф', () => {
    const res = resources();
    const before = save(scene);
    res.setLocale('en');
    res.describe(['component', 'Health', 'max']);
    res.setLocale('ru');
    for (const field of Object.keys(scene.components[0]!.fields)) {
      res.hint(['component', 'Health', field]);
    }
    expect(save(scene)).toBe(before);
  });

  it('язык переключается без перезапуска: тот же экземпляр отвечает по-новому', () => {
    const res = resources();
    const changed = vi.fn();
    const unsubscribe = res.onChange(changed);
    expect(res.describe(['component', 'Health', 'max'])).toBe('Верхняя граница здоровья.');
    res.setLocale('en');
    expect(res.describe(['component', 'Health', 'max'])).toBe('Upper bound of health.');
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('имена компонентов и полей не локализуются: ключ и путь те же в любой локали', () => {
    const res = resources();
    const ru = res.hint(['component', 'Health', 'max']);
    res.setLocale('en');
    const en = res.hint(['component', 'Health', 'max']);
    expect(en.key).toBe(ru.key);
    expect(en.path).toEqual(ru.path);
    expect(en.text).not.toBe(ru.text);
    expect(scene.components[0]!.name).toBe('Health');
  });

  it('локаль — настройка пользователя, а не свойство проекта', () => {
    // В дереве контента лежит бандл `ru`, пользователь открыл редактор на `en`:
    // язык остаётся пользовательским, состав бандлов проекта его не выбирает.
    const res = new StringResources({ locale: 'en', editor: { en: EN, ru: RU } });
    res.setProjectBundles({ ru: { 'component.Health.max': 'Проектное описание.' } });
    expect(res.locale).toBe('en');
    expect(res.describe(['component', 'Health', 'max'])).toBe('Upper bound of health.');
  });
});

describe('ED-27: спутник отпечатков — машинные данные вне бандла', () => {
  it('бандл остаётся плоской картой строк', () => {
    for (const bundle of [EN, RU]) {
      for (const value of Object.values(bundle)) expect(typeof value).toBe('string');
    }
  });

  it('спутник называет локаль и её источник', () => {
    const file: FingerprintFile = confirmTranslations('ru', EN, RU, undefined);
    expect(file.locale).toBe('ru');
    expect(file.source).toBe('en');
  });
});
