## 1. Спеки

- [x] 1.1 `openspec/specs/fixed-point-math/spec.md` — FP-2, FP-4, FP-5 по delta-спеке; FP-6 добавлено
- [x] 1.2 `openspec/specs/rng/spec.md` — RNG-8 добавлено
- [x] 1.3 `openspec/specs/ecs-foundation/spec.md` — ID-1 по delta-спеке

## 2. `src/debug.ts` — раскол assert/assertInvariant

- [x] 2.1 Добавить `AssertSink`, `setAssertSink`, мягкий `assert` через sink (не бросает)
- [x] 2.2 Добавить `assertInvariant` (бросает в обоих режимах)
- [x] 2.3 Экспортировать оба из `src/index.ts` (`assertInvariant`, `setAssertSink`) рядом с `assert`

## 3. `src/math/fixed.ts` — мягкие места

- [x] 3.1 `wrap` — throw → мягкий `assert`, возвращаемое значение не меняется
- [x] 3.2 `div` на ноль — убрать throw, оставить мягкий `assert` (результат уже `INT32_MAX`/`INT32_MIN`/`0`)
- [x] 3.3 `sqrt` от отрицательного — убрать throw, оставить мягкий `assert` (результат уже `0`)

## 4. `src/ecs/entityIndex.ts`

- [x] 4.1 `free` — переполнение `generation` → мягкий `assert`
- [x] 4.2 `createEntityIndex`, `makeEntityId`, `allocate` → `assertInvariant` (бросает в обоих режимах, без `if (DEBUG)`)

## 5. `src/ecs/componentMask.ts`

- [x] 5.1 `checkBounds` — обёртку `if (DEBUG)` перенести внутрь функции, вызывающий код зовёт её безусловно
- [x] 5.2 `checkBounds` — throw → мягкий `assert`
- [x] 5.3 Убрать ссылку на SNAP-5 в комментарии к структуре (строка ~7)

## 6. `src/math/rng.ts`

- [x] 6.1 `nextBelow` — проверка `bound < 1` → `assertInvariant` (бросает в обоих режимах)

## 7. Тесты

- [x] 7.1 `test/fixed.test.ts` — `div(_, 0)`, `wrap`-переполнение, `sqrt(<0)`: не `toThrow()`, а «значение то же самое в debug/release + sink вызван»
- [x] 7.2 `test/entityIndex.test.ts` — переполнение `generation`: sink вместо throw; `createEntityIndex`/`makeEntityId`/`allocate` — бросают в обоих режимах
- [x] 7.3 Новый тест `nextFixed`/`nextBelow` по формуле RNG-8 (конкретные входы/выходы, включая случай с отбраковкой)
- [x] 7.4 Новый тест `debug.ts` — мягкий `assert` не бросает и не меняет результат, `assertInvariant` бросает всегда

## 8. Проверка

- [x] 8.1 `host npx vitest run` в `engine/core-ts` — зелёный
- [x] 8.2 `host npx tsc --noEmit` в `engine/core-ts` — чистый
- [x] 8.3 `git diff --stat engine/tests/golden/` пуст после `vitest run` (golden не требует перегенерации)
- [x] 8.4 `host openspec validate arithmetic-and-rng-norms --strict` — проходит
