## 1. Ядро: sin/cos в Q16.16 (FP-7, FP-8)

- [x] 1.1 `engine/core-ts/src/math/fixed.ts`: литерал `SIN_TABLE` (257 узлов по формуле FP-8), `sin` (маска оборота, сведение к четверти, интерполяция с усечением, знак после магнитуды), `cos = sin(a + 16384)`
- [x] 1.2 `engine/core-ts/src/types.ts`: `MathApi.sin`/`MathApi.cos`; `engine/core-ts/src/math/mathApi.ts`: проводка
- [x] 1.3 Тесты `engine/core-ts/test/fixed.test.ts`: точные значения на осях, заворачивание `a + k·65536` и отрицательных углов, `cos(a) === sin(a+16384)`, узлы таблицы против формулы `Math.round(Math.sin(2π·i/1024)·65536)`, сверка всех 65536 углов с float-эталоном в допуске ±2, монотонность на первой четверти

## 2. DSL: операторы выражений (EXPR-2)

- [x] 2.1 `engine/core-ts/src/dsl/expr.ts`: `sin`/`cos` через `num1`
- [x] 2.2 Тест `engine/core-ts/test/expr.test.ts`: `sin`/`cos` из выражения, разворот угла в вектор `vec [cos, sin]`

## 3. Схемы и прогон

- [x] 3.1 `npm run schemas` — операторы перечислены в `system.schema.json`, регенерация обязательна
- [x] 3.2 Зелёные `npm test` и `npm run typecheck` из корня; `engine/tests/golden/` без диффа
