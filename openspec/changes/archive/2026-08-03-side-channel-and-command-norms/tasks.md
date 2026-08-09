## 1. Спека tick-loop

- [x] 1.1 `specs/tick-loop/spec.md` — MODIFIED TICK-3: адресовать запрет игровому коду и внешнему слою во время нормального хода симуляции, перечислить три легальных операции ядра вне тика (расстановка `worldInit` — DET-1/ID-2; восстановление снапшота в `seekTo` — WSM-5/REW-2; exempt-поля — REW-9), запретить мутирующее публичное API мира общего назначения
- [x] 1.2 `specs/tick-loop/spec.md` — MODIFIED TICK-2: ширина `buttons` — u16 (биты 0..15, значения `0..65535`), TICK-2 — единственный владелец числа, JSON-схема обязана повторять границы; отдельно снять кажущееся противоречие с `bitTest` (EXPR-2 — общий оператор над `i32`-маской)

## 2. Спека ecs-foundation

- [x] 2.1 `specs/ecs-foundation/spec.md` — ADDED CMD-7: команда к не-живой сущности отбрасывается на flush, проверка по полному `EntityId` (сверено с `src/ecs/commands.ts:76`), не пересекается с точечным чтением буфера CMD-5
- [x] 2.2 `specs/ecs-foundation/spec.md` — MODIFIED QUERY-1: краевые случаи наборов компонентов — пустые `all`/`any`/`not` и неизвестный компонент в `not` не сужают выборку, неизвестный компонент в `all`/`any` даёт пустой результат (сверено с `src/ecs/query.ts:38` и `src/ecs/componentMask.ts:96`)

## 3. Спека netcode

- [x] 3.1 `specs/netcode/spec.md` — MODIFIED NET-12: нормировать побочный эффект вырезания на `generations`/`freeList` (сверено с `src/sim/filter.ts:96`) и следствие для NET-8 — baseline per-client delta от персонального снапшота клиента

## 4. Код: сужение публичной поверхности

- [x] 4.1 `engine/core-ts/src/index.ts` — сузить `export * as world` до read-only чтения мира; мутаторы `spawn`/`destroy`/`setField`/`addComponent`/`removeComponent`/`addTag` и служебные `createWorld`/`fromPlain`/`copyWorldInto`/`clearDirty` из публичной поверхности убрать (TICK-3)
- [x] 4.2 `engine/core-ts/src/index.ts` — опубликовать единственный мутирующий хелпер для расстановки `worldInit` под именем, называющим назначение (TICK-3, пункт 1)
- [x] 4.3 Проверить, что внутренние импорты `src/ecs/world.js` не тронуты: `src/sim/scenario.ts`, `src/sim/scene.ts`, `src/sim/rewind.ts`, `src/sim/filter.ts`, `src/sim/tick.ts` продолжают пользоваться мутаторами напрямую

## 5. Тесты

- [x] 5.1 Тест CMD-7: `destroy` + `spawn` + `setField` к одной сущности в одном буфере — команда отброшена, новая сущность того же слота значения не получает; отдельно — команда к сущности, убитой предыдущей системой, отбрасывается молча
- [x] 5.2 Тесты краевых случаев QUERY-1: пустые `all`/`any`/`not`, неизвестный компонент в `all`/`any`/`not`
- [x] 5.3 Тест публичной поверхности: `src/index.ts` не экспортирует мутаторов мира, `worldInit`-хелпер и read-only чтение доступны

## 6. Проверка

- [x] 6.1 `npx vitest run` зелёный, `npx tsc --noEmit` чистый
- [x] 6.2 `openspec validate side-channel-and-command-norms --strict` проходит
- [x] 6.3 `git diff --stat engine/tests/golden` пуст — рантайм-логика не менялась
- [x] 6.4 Границы `buttons` в `engine/schemas/scenario.schema.json` НЕ править: файл принадлежит параллельному change'у `events-in-systems`, приведение схемы к TICK-2 — за его владельцем
