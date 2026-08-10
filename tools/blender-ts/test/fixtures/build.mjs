#!/usr/bin/env node
/**
 * Сборка закоммиченных бинарных фикстур экспорта (задача 10.1, BLND-7).
 *
 * Запуск: `node tools/blender-ts/test/fixtures/build.mjs` (флаг `--check` —
 * только сверить дерево с выводом, ничего не записывая; тем же вопросом
 * занимается `test/fixtures.test.ts`, и здесь флаг нужен человеку, а не гейту).
 *
 * Blender при этом не зовётся и не требуется: `.glb` — это заголовок, JSON-чанк
 * и бинарный чанк, и собираются они из читаемых источников (`fixtureCatalogue.ts`).
 * Логики формата здесь нет ни строки: скрипт — вывод перечня в файлы.
 *
 * Шага сборки у него нет по той же причине, что у `bin/import.mjs`: типы Node
 * стрипает сам (>=22.18), а импорты вида `./x.js` ведут на `./x.ts` — так
 * написаны исходники репозитория для tsc, и хук проставляет это при резолве.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Настоящего .ts нет — резолвим как просили.
      }
    }
    return next(specifier, context);
  },
});

const { GENERATED_FIXTURES } = await import('../fixtureCatalogue.ts');

const here = fileURLToPath(new URL('.', import.meta.url));
const check = process.argv.includes('--check');

let stale = 0;
for (const fixture of GENERATED_FIXTURES) {
  const path = `${here}${fixture.name}`;
  const bytes = fixture.build();
  let current = null;
  try {
    current = new Uint8Array(readFileSync(path));
  } catch {
    // Файла ещё нет — первая сборка.
  }
  const same =
    current !== null &&
    current.byteLength === bytes.byteLength &&
    current.every((byte, index) => byte === bytes[index]);
  if (same) continue;
  stale++;
  if (check) {
    process.stderr.write(`устарела: ${fixture.name}\n`);
    continue;
  }
  writeFileSync(path, bytes);
  process.stdout.write(`записана: ${fixture.name} (${bytes.byteLength} Б)\n`);
}

if (check && stale > 0) {
  process.stderr.write(
    'дерево разошлось с перечнем: пере-соберите `node tools/blender-ts/test/fixtures/build.mjs`\n',
  );
  process.exitCode = 1;
} else if (stale === 0) {
  process.stdout.write(`фикстуры на месте: ${GENERATED_FIXTURES.length}\n`);
}
