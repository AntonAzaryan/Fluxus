## Why

`engine/core-ts` уже реализует правильное поведение (wrapping, насыщающее деление, `sqrt(<0) → 0`, Lemire-отбраковка в `nextBelow`), но нормы вокруг него неточны или неполны:

- `FP-4` требует единственный debug-assert без разделения на «мягкая диагностика» и «жёсткая граница инварианта» — а в коде уже есть обе разновидности (переполнение `wrap` — мягкое, `createEntityIndex`/`allocate` — жёсткое), и спека не даёт им имени.
- `FP-5` не говорит явно, что насыщение действует **в обоих** режимах сборки, а не только в release.
- `FP-2` формулирует умножение как `(i64(a)*i64(b))>>16`, что при знаковом операнде даёт floor, а не truncate toward zero (`FP-3`) — формулировка расходится сама с собой, хотя код (`src/math/fixed.ts:52-69`) уже считает верно через магнитуду и знак отдельно.
- `sqrt` от отрицательного числа не имеет нормы вовсе (`FP-6` не существует), хотя код уже возвращает 0.
- `nextFixed`/`nextBelow` не описаны дословно на уровне алгоритма (`RNG-8` не существует), хотя это часть детерминированного контракта: `nextBelow` — Lemire multiply-shift с переменным числом отбраковок, и это число входит в снапшот RNG-стрима (`RNG-5`) и сверяется между реализациями (`CLI-6`) — будущий Rust-порт обязан воспроизвести именно эту отбраковку, а не любой алгоритм с тем же распределением.
- `ID-1` не разделяет мягкое переполнение `generation` (уже описано) от жёсткой границы рождения `EntityId` (`createEntityIndex`, `makeEntityId`, `allocate`) — по коду это разные вещи: рождение бросает всегда, переполнение `generation` — только диагностика.

Без этого нормирования Rust-порт получит на выбор несколько прочтений одной и той же строчки спеки, что для арифметического ядра — прямой риск десинка.

## What Changes

- `assert` раскалывается на два примитива в `src/debug.ts`: мягкий `assert` (диагностика через подключаемый sink, не бросает, не меняет результат — работает в обеих сборках) и жёсткий `assertInvariant` (бросает всегда, в debug и в release).
- Мягкие места переводятся на `assert`: `wrap` (переполнение), `div` на ноль, `sqrt(<0)`, переполнение `generation` в `entityIndex.free`, `componentMask.checkBounds`.
- Жёсткие места переводятся на `assertInvariant`: `createEntityIndex`, `makeEntityId`, `allocate`, `nextBelow(bound)` при `bound < 1`.
- Возвращаемые значения не меняются нигде — только раскол диагностики.
- Новое `FP-6`: `sqrt` от отрицательного SHALL возвращать 0.
- Новое `RNG-8`: дословная норма для `nextFixed()` (старшие 16 бит `next()` как дробная часть Q16.16) и `nextBelow(bound)` (Lemire multiply-shift с отбраковкой по порогу `(2^32 − bound) mod bound`), включая то, что число отбраковок — часть детерминированного контракта.
- `ID-1` дополняется описанием жёсткой границы рождения `EntityId`.
- `src/index.ts` экспортирует `assertInvariant` и `setAssertSink` рядом с существующим `assert`.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `fixed-point-math`: `FP-2` (переформулировка «магнитуда через 64-битный промежуток, знак отдельно», без противоречия `FP-3`), `FP-4` (раскол assert/assertInvariant), `FP-5` (насыщение в обоих режимах явно), `FP-6` (новое — `sqrt(<0) → 0`).
- `rng`: `RNG-8` (новое — дословный алгоритм `nextFixed`/`nextBelow`, отбраковка как часть контракта).
- `ecs-foundation`: `ID-1` (жёсткая граница рождения `EntityId` через `assertInvariant`).

## Impact

- Спеки: `openspec/specs/fixed-point-math/spec.md`, `openspec/specs/rng/spec.md`, `openspec/specs/ecs-foundation/spec.md`.
- Код: `engine/core-ts/src/debug.ts`, `engine/core-ts/src/math/fixed.ts`, `engine/core-ts/src/ecs/entityIndex.ts`, `engine/core-ts/src/ecs/componentMask.ts`, `engine/core-ts/src/math/rng.ts`, `engine/core-ts/src/index.ts`.
- Тесты: `engine/core-ts/test/fixed.test.ts`, `engine/core-ts/test/entityIndex.test.ts`, новый тест на `debug.ts` (мягкий assert), новый нормативный тест на `nextFixed`/`nextBelow`.
- Не затрагивается: golden-эталоны (`engine/tests/golden/`) — поведение не меняется, только диагностика; ожидаемо не расходятся.
