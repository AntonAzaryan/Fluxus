/**
 * Строковые ресурсы (ED-27): «весь видимый автору текст интерфейса SHALL
 * приходить из строковых ресурсов; строковых литералов интерфейса вне ресурсов
 * MUST NOT быть».
 *
 * Одного взгляда на код тут мало: пакет будет расти, и подпись-литерал
 * появится не в этом коммите, а через десять. Поэтому проверка двусторонняя.
 *
 * Сверху — тип: текст узла имеет тип `UiText`, а `UiText` собирают ровно две
 * функции — `resourceText` (строка локали по ключу) и `documentValue`
 * (содержимое открытого документа, которое ED-27 не локализует вовсе). Литерал
 * в подпись компилятор не пропустит.
 *
 * Снизу — этот тест: он строит контрольный случай целиком и классифицирует
 * каждый видимый текст. Ресурс обязан разрешаться в обеих локалях (или, если
 * ресурса нет, показывать сам ключ — ED-28 требует именно этого). Значение
 * обязано лежать в файле данных документа. Третьего происхождения у текста на
 * странице не остаётся.
 *
 * Чего проверка не увидит, названо честно: строку, дописанную в DOM в обход
 * `UiNode` (её ловит только ревью); человеческий текст, положенный в файл
 * данных под видом значения документа; и текст, приходящий из чужого пакета
 * уже разрешённым. Первое закрывается тем, что писать в DOM умеет один модуль
 * пакета, остальные два — тем, что оба источника читаются глазами один раз.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DESCRIPTIONS,
  controlCasePage,
  initialGalleryState,
  sampleDocumentStrings,
} from '../src/gallery/controlCase.js';
import { REASON_PREFIX } from '@game-mvp/editor-core';
import {
  UI_BUNDLES,
  UI_KEY_PREFIX,
  VALIDATION_BUNDLES,
  uiResources,
} from '../src/i18n/uiBundles.js';
import { collectTexts, walk, type UiNode } from '../src/dom/node.js';
import { materialStrings } from '../src/areas/material.js';
import { sceneArea } from '../src/areas/scene.js';
import { systemsArea } from '../src/areas/systems.js';
import { buildFrame } from './support/frame.js';

/** Весь код пакета, а не только его библиотека: точка входа приложения — тоже интерфейс. */
const ROOTS = ['src', 'app'] as const;

function sources(): { readonly path: string; readonly text: string }[] {
  return ROOTS.flatMap((root) => {
    const dir = fileURLToPath(new URL(`../${root}`, import.meta.url));
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => ({ path: `${root}/${entry}`, text: readFileSync(`${dir}/${entry}`, 'utf8') }));
  });
}

/**
 * Бандлов у пакета два, и пространства у них разные: подпись интерфейса
 * называется по месту показа (`ui.*`), а причина находки — по правилу, которое
 * её сообщило (`validation.reason.*`, ключ выводит `reasonKey` ядра редактора).
 * Проверка на обоих одна и та же, поэтому и параметризована.
 */
const BUNDLES: readonly (readonly [string, typeof UI_BUNDLES, string])[] = [
  ['хром', UI_BUNDLES, UI_KEY_PREFIX],
  ['причины валидации', VALIDATION_BUNDLES, REASON_PREFIX],
];

describe('ED-27: бандлы строк пакета', () => {
  it.each(BUNDLES)('%s: локали ru и en равноправны — один и тот же набор ключей', (_name, bundles) => {
    const en = Object.keys(bundles.en ?? {}).sort();
    const ru = Object.keys(bundles.ru ?? {}).sort();
    expect(ru).toEqual(en);
    expect(en.length).toBeGreaterThan(0);
  });

  it.each(BUNDLES)('%s: все ключи в своём пространстве и ни один не пуст', (_name, bundles, prefix) => {
    for (const [locale, bundle] of Object.entries(bundles)) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(key.startsWith(prefix), `${locale}: ${key}`).toBe(true);
        expect(value.trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('ED-27: литерал не может дойти до текстового узла', () => {
  it('documentValue нигде не вызывается с литералом', () => {
    for (const file of sources()) {
      const offenders = file.text.match(/documentValue\(\s*['"`]/g) ?? [];
      expect(offenders, `${file.path}: подпись интерфейса под видом значения документа`).toEqual([]);
    }
  });

  it('текстовые атрибуты не проставляются мимо labels', () => {
    // Имена этих атрибутов знает один модуль — тот, что материализует узел.
    // Появление их где-то ещё означает текст в обход `UiText`. `style` в этом
    // же списке не из-за текста: строка стиля — произвольный CSS в обход
    // таблицы стилей, на которой держатся все структурные проверки ED-22.
    const forbidden: Readonly<Record<string, string>> = {
      'aria-label': 'src/dom/render.ts',
      placeholder: 'src/dom/render.ts',
      title: 'src/dom/render.ts',
      alt: 'src/dom/render.ts',
      // Имя `style` знают двое: тот, кто собирает атрибут из `vars`, и тот,
      // кто создаёт сам элемент `<style>` с таблицей стилей.
      style: 'src/tokens/stylesheet.ts',
    };
    for (const file of sources()) {
      if (file.path === 'src/dom/render.ts') continue;
      for (const [name, owner] of Object.entries(forbidden)) {
        if (file.path === owner) continue;
        for (const attribute of [`'${name}'`, `"${name}"`]) {
          expect(file.text.includes(attribute), `${file.path}: ${attribute}`).toBe(false);
        }
      }
    }
  });

  it('писать текст в DOM умеют только два модуля пакета', () => {
    // `dom/render.ts` — единственный, кто пишет видимый автору текст, и пишет
    // его только из `UiText`. `tokens/stylesheet.ts` пишет содержимое элемента
    // `<style>`: это CSS, а не текст интерфейса, и под ED-27 он не подпадает.
    const writers = sources().filter((file) => file.text.includes('textContent'));
    expect(writers.map((file) => file.path).sort()).toEqual([
      'src/dom/render.ts',
      'src/tokens/stylesheet.ts',
    ]);
  });
});

describe('ED-27: каждый видимый текст контрольного случая имеет происхождение', () => {
  const documentStrings = sampleDocumentStrings();
  const keySyntax = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_\-!=<>+*/%?]+)+$/;

  const pageIn = (locale: string) =>
    controlCasePage(
      uiResources(locale, SAMPLE_DESCRIPTIONS),
      initialGalleryState(),
      () => undefined,
    );

  it('страница вообще показывает текст — проверка не пустая', () => {
    expect(collectTexts(pageIn('ru')).length).toBeGreaterThan(50);
  });

  it.each(['ru', 'en'])('на локали %s текст — либо ресурс, либо документ', (locale) => {
    const resources = uiResources(locale, SAMPLE_DESCRIPTIONS);
    for (const text of collectTexts(pageIn(locale))) {
      if (text.origin === 'value') {
        expect(documentStrings.has(text.value), `значение не из документа: ${text.value}`).toBe(
          true,
        );
        continue;
      }
      const key = text.key ?? '';
      expect(keySyntax.test(key), `ключ не похож на ключ: ${key}`).toBe(true);
      // Либо ресурс разрешился, либо показан сам ключ — пустой подсказки
      // ED-28 не допускает, а прозы мимо ресурсов не остаётся.
      const resolved = resources.lookup(key);
      if (resolved === undefined) expect(text.value).toBe(key);
      else expect(text.value).toBe(resolved.text);
    }
  });

  it('смена локали меняет строки хрома и не трогает идентификаторы документа', () => {
    const ru = collectTexts(pageIn('ru'));
    const en = collectTexts(pageIn('en'));
    expect(ru.length).toBe(en.length);

    const changed = ru.filter((text, index) => text.value !== en[index]?.value);
    expect(changed.length, 'локаль ничего не изменила — строки не из ресурсов').toBeGreaterThan(0);
    for (const [index, text] of ru.entries()) {
      if (text.origin !== 'value') continue;
      expect(en[index]?.value, `идентификатор документа локализован: ${text.value}`).toBe(
        text.value,
      );
    }
  });

  it('ключи ресурсов, использованные страницей, объявлены в обеих локалях', () => {
    const used = new Set(
      collectTexts(pageIn('ru'))
        .filter((text) => text.origin === 'resource' && text.key?.startsWith(UI_KEY_PREFIX) === true)
        .map((text) => text.key ?? ''),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect(UI_BUNDLES.ru?.[key], `нет в ru: ${key}`).toBeDefined();
      expect(UI_BUNDLES.en?.[key], `нет в en: ${key}`).toBeDefined();
    }
  });

  it('ни один узел не несёт человеческого текста в машинных атрибутах', () => {
    // `value` здесь же: содержимое поля ввода автор читает так же, как подпись,
    // и учёт происхождения обязан его видеть. У `<option>` `value` — машинный
    // идентификатор выбора, поэтому проверка смотрит на видимые теги.
    const human = ['title', 'aria-label', 'placeholder', 'alt', 'style'];
    for (const node of walk(pageIn('ru'))) {
      for (const name of Object.keys(node.attrs ?? {})) {
        if (name === 'value' && node.tag === 'option') continue;
        expect(
          [...human, 'value'].includes(name),
          `${node.tag}: атрибут ${name} мимо labels`,
        ).toBe(false);
      }
    }
  });

  it('пользовательские свойства — единственный стиль, который несёт узел', () => {
    for (const node of walk(pageIn('ru'))) {
      for (const name of Object.keys(node.vars ?? {})) {
        expect(name.startsWith('--'), `${node.tag}: ${name}`).toBe(true);
      }
    }
  });
});

/**
 * Та же проверка на странице, которую монтирует приложение, — на каркасе с
 * обеими рабочими областями. Контрольный случай визуального языка её не
 * заменяет: подписи каркаса, подписи областей и содержимое их материала — три
 * разных источника текста, и ED-27 держит их все.
 */
describe('ED-27: каждый видимый текст каркаса имеет происхождение', () => {
  const materialCorpus = materialStrings();
  const areas = [sceneArea, systemsArea];

  const pagesIn = (locale: string): UiNode[] => {
    const { frame } = buildFrame(areas, locale);
    const pages = [frame.view()];
    for (const area of areas) {
      frame.activate(area.id);
      pages.push(frame.view());
    }
    return pages;
  };

  it('обе области вообще показывают текст — проверка не пустая', () => {
    for (const page of pagesIn('ru')) expect(collectTexts(page).length).toBeGreaterThan(10);
  });

  it.each(['ru', 'en'])('на локали %s текст — либо ресурс, либо материал', (locale) => {
    const resources = uiResources(locale);
    for (const page of pagesIn(locale)) {
      for (const text of collectTexts(page)) {
        if (text.origin === 'value') {
          expect(materialCorpus.has(text.value), `значение не из материала: ${text.value}`).toBe(
            true,
          );
          continue;
        }
        const key = text.key ?? '';
        const resolved = resources.lookup(key);
        expect(resolved, `ключ каркаса не разрешился: ${key}`).toBeDefined();
        expect(text.value).toBe(resolved?.text);
      }
    }
  });

  it('ключи каркаса и областей объявлены в обеих локалях', () => {
    // Пространства два — подписи и причины находок, — а свойство одно: ключ,
    // дошедший до страницы, обязан разрешаться в обеих локалях. Бандл, в котором
    // его ищут, выбирается по пространству, а не по тому, где он нашёлся.
    const declared = (locale: 'ru' | 'en', key: string): string | undefined =>
      key.startsWith(REASON_PREFIX) ? VALIDATION_BUNDLES[locale]?.[key] : UI_BUNDLES[locale]?.[key];
    const used = new Set(
      pagesIn('ru')
        .flatMap((page) => collectTexts(page))
        .filter((text) => text.origin === 'resource')
        .map((text) => text.key ?? ''),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect(
        key.startsWith(UI_KEY_PREFIX) || key.startsWith(REASON_PREFIX),
        `ключ вне пространств пакета: ${key}`,
      ).toBe(true);
      expect(declared('ru', key), `нет в ru: ${key}`).toBeDefined();
      expect(declared('en', key), `нет в en: ${key}`).toBeDefined();
    }
  });

  it('смена языка меняет подписи каркаса и не трогает имена материала', () => {
    const ru = pagesIn('ru').flatMap((page) => collectTexts(page));
    const en = pagesIn('en').flatMap((page) => collectTexts(page));
    expect(ru.length).toBe(en.length);
    expect(ru.filter((text, index) => text.value !== en[index]?.value).length).toBeGreaterThan(0);
    for (const [index, text] of ru.entries()) {
      if (text.origin !== 'value') continue;
      expect(en[index]?.value, `имя материала локализовано: ${text.value}`).toBe(text.value);
    }
  });

  it('ключи описаний вкладов тоже разрешаются: каталог ED-30 читает те же строки', () => {
    const resources = uiResources('en');
    for (const area of areas) {
      expect(resources.lookup(area.descriptionKey), area.id).toBeDefined();
      expect(resources.lookup(area.labelKey), area.id).toBeDefined();
      for (const editable of area.editableTypes) {
        expect(resources.lookup(editable.descriptionKey), editable.id).toBeDefined();
      }
    }
  });
});
