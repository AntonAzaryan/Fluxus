/**
 * Guard свободы пакета рендера от DOM (`rendering` REND-19, `render-debug`
 * RDBG-3): ни одного обращения к странице в `src/` — ни узла, ни глобала.
 *
 * Почему сторож, если DOM и так не в `lib` пакета. Компилятор закрывает наивный
 * случай (`document.createElement` не типизируется), но не закрывает обход через
 * приведение: `(globalThis as { document?: X }).document` — обычное свойство, и
 * `tsc` о нём ничего не скажет. Сторож же говорит вслух и с причиной, и правка
 * его списка попадает в дифф на ревью (CLI-8) — снять правило можно, но не молча.
 *
 * Требование, которое он держит, у отладки прямое: «Текста в кадре отладочные
 * наложения MUST NOT рисовать: пакет рендера свободен от DOM (`rendering`
 * REND-19), а текст в сцене — это канвас-текстура, то есть DOM» (RDBG-3). Имена,
 * числа и перечни живут в дампе (RDBG-7) и в DOM-панели приложения.
 *
 * Канвас слоя миникарты пакету приносит СБОРКА фабрикой (`subsystems/fog.ts`,
 * `FogLayerCanvas` — структурный минимум), поэтому исключений у правила нет.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatViolations, scanDom, scanDomInSource } from '../../tests/guard/scanner.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('guard: в пакете рендера DOM не появляется (REND-19, RDBG-3)', () => {
  it('src/ не трогает страницу: ни document/window, ни узлов, ни их фабрик', () => {
    expect(formatViolations(scanDom({ rootDir: SRC }))).toBe('');
  });

  it('сторож не вакуумный: подпись в кадре канвас-текстурой краснит', () => {
    const violations = scanDomInSource(
      'labels.ts',
      "const canvas = document.createElement('canvas');\nexport const texture = canvas;\n",
    );
    expect(violations.map((violation) => violation.rule)).toEqual(['dom-in-render', 'dom-in-render']);
    expect(formatViolations(violations)).toMatch(/REND-19/);
  });

  it('обход через приведение globalThis ловится тоже — на имени члена', () => {
    const violations = scanDomInSource(
      'sneaky.ts',
      "const host = globalThis as { document?: { createElement(tag: string): unknown } };\n" +
        "export const node = host.document?.createElement('div');\n",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/createElement/);
  });

  it('своё поле по имени `document` сторожа не будит: ловится значение, а не имя', () => {
    const source =
      'class Preset {\n  private document = { resolution: 4 };\n' +
      '  get value(): number {\n    return this.document.resolution;\n  }\n}\nexport { Preset };\n';
    expect(scanDomInSource('quality.ts', source)).toEqual([]);
  });
});
