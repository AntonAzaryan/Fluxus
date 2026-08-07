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
import { UI_BUNDLES, UI_KEY_PREFIX, uiResources } from '../src/i18n/uiBundles.js';
import { collectTexts, walk } from '../src/dom/node.js';

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

describe('ED-27: бандл строк хрома', () => {
  it('локали ru и en равноправны — один и тот же набор ключей', () => {
    const en = Object.keys(UI_BUNDLES.en ?? {}).sort();
    const ru = Object.keys(UI_BUNDLES.ru ?? {}).sort();
    expect(ru).toEqual(en);
    expect(en.length).toBeGreaterThan(0);
  });

  it('все ключи лежат в пространстве хрома и ни один не пуст', () => {
    for (const [locale, bundle] of Object.entries(UI_BUNDLES)) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(key.startsWith(UI_KEY_PREFIX), `${locale}: ${key}`).toBe(true);
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
    // Появление их где-то ещё означает текст в обход `UiText`.
    for (const file of sources()) {
      if (file.path.endsWith('render.ts')) continue;
      for (const attribute of ["'aria-label'", '"aria-label"', "'placeholder'", '"placeholder"']) {
        expect(file.text.includes(attribute), `${file.path}: ${attribute}`).toBe(false);
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
    const human = ['title', 'aria-label', 'placeholder', 'alt'];
    for (const node of walk(pageIn('ru'))) {
      for (const name of Object.keys(node.attrs ?? {})) {
        expect(human.includes(name), `${node.tag}: атрибут ${name} мимо labels`).toBe(false);
      }
    }
  });
});
