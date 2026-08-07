/**
 * Граница headless (ED-29: операции SHALL быть исполнимы без интерфейса)
 * держится не дисциплиной автора, а `lib` в tsconfig: без `DOM` обращение к
 * `document` в этом пакете не компилируется. Пиннится сама настройка —
 * компилятору нечего сказать о DOM-коде, которого ещё нет, так что `DOM` в
 * `lib` добавился бы незаметно, а обнаружился бы уже вьюпортом внутри
 * headless-пакета.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tsconfig = JSON.parse(
  readFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), 'utf8'),
) as { compilerOptions: { lib: string[] } };

describe('граница headless', () => {
  it('в `lib` пакета нет DOM', () => {
    expect(tsconfig.compilerOptions.lib).toEqual(['ES2022']);
  });
});
