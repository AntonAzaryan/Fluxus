## 1. Правка спек

- [x] 1.1 `specs/data-driven-systems/spec.md` — EXPR-1: собственная реализация JsonLogic-совместимого AST
- [x] 1.2 `specs/data-driven-systems/spec.md` — EXPR-2: литералы в сыром Q16.16, `fromInt` для `i32`-полей
- [x] 1.3 `specs/data-driven-systems/spec.md` — EXPR-6: закрытая таблица операторов
- [x] 1.4 `openspec/config.yaml` — «JsonLogic (выражения)» → «JsonLogic-совместимый AST»

## 2. Реализация

- [x] 2.1 `src/expr.ts`: типы `Expression`, `ExprValue`, `ExprWorld`, интерфейс `ExpressionEvaluator` (EXPR-4)
- [x] 2.2 Рекурсивный спуск: литерал, узел с одним оператором, разрешение через `Object.hasOwn` (EXPR-6)
- [x] 2.3 Таблица операторов: арифметика Q16.16, сравнения, логика, `if`, `fromInt`/`toInt`
- [x] 2.4 Операторы доступа к миру: `var`, `tick`, `getComponent`, `hasComponent`, `isAlive`
- [x] 2.5 Векторные операторы через `MathApi.vec` (EXPR-2)
- [x] 2.6 Экспорт из `src/index.ts`

## 3. Тесты

- [x] 3.1 Арифметика идёт в Q16.16, а не в double (`0.5 * 0.5 = 0.25`, не `0.25 * 65536²`)
- [x] 3.2 Дистанция между сущностями через `getComponent` + `vec.length` (сценарий EXPR-2)
- [x] 3.3 `if` с порогом по HP — сценарий ACT-1 «бьёт сильнее по целям ниже 30%»
- [x] 3.4 `fromInt` обязателен для `i32`-поля: без него результат отличается (сценарий EXPR-2)
- [x] 3.5 Неизвестный оператор и `constructor` в позиции оператора падают с ошибкой (EXPR-6)
- [x] 3.6 Узел с двумя ключами и неизвестная переменная падают с ошибкой
- [x] 3.7 Sandbox: в `ExprWorld` нет `commands`/`events` — проверяется типом, тест фиксирует отсутствие оператора итерации (EXPR-3, EXPR-5)

## 4. Проверка

- [x] 4.1 `npm test` и `npm run typecheck` в `core-ts` зелёные
- [x] 4.2 `openspec validate 2026-08-02-expression-evaluator --strict`
- [x] 4.3 `docs/architecture.md` §5 — этап 6 отмечен выполненным
