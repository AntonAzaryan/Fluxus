# Tasks: sec02-field-write-without-ownership

Требование — `specs/ecs-foundation/spec.md` (**ECS-8**, новый номер префикса ECS), разбор решений — design.md (D1–D5). Гейт один и он локальный: `npm run check` из корня репозитория (CI нет).

Изменение заводилось по факту сделанной работы: валидация спек против кода (`docs/reviews/spec-validation-2026-09-01/02-ecs-dsl.md`) назвала молчание спеки о записи в невладеющее поле и показала, чем оно кончается на кросс-языковой сверке.

## 1. Требование (D1–D5)

- [x] 1.1 `specs/ecs-foundation/spec.md`: ADDED ECS-8 — запись поля компонента, которым сущность не владеет либо в которой не жива, пуста; состав компонентов записью не меняется; отбрасывание молчаливое, диагностика мягким assert'ом (FP-4); порядок проверок (имена, представимость, владение); исход команды в трейсе не меняется.
- [x] 1.2 Перенести дельту в `openspec/specs/ecs-foundation/spec.md`. Изменение при этом НЕ архивируется: оно остаётся в очереди как запись о принятом решении. Проверка — `npx openspec validate --specs --strict` и `npm run spec-graph -- check`.

## 2. Код (D3, D4, D5)

- [x] 2.1 `engine/core-ts/src/ecs/world.ts`: `setField` отбрасывает запись без владения — одна распаковка id (`aliveIndexOf`), затем маска; мягкий assert в debug; `markDirty` на этой ветке не зовётся.
- [x] 2.2 `engine/core-ts/src/types.ts`: код диагностики `COMPONENT_WRITE_WITHOUT_OWNERSHIP` рядом с кодом чтения.

## 3. Тест

- [x] 3.1 `engine/core-ts/test/componentWrite.test.ts`: ячейка и маска не тронуты, dirty-срез пуст, не-живой адресат, порядок проверок (непредставимое значение и опечатка в имени по-прежнему бросают), обе стороны буфера (`removeComponent` раньше записи и `addComponent` раньше записи), ровно одна запись диагностики в debug и неизменная плоская форма мира.

## 4. Гейт

- [x] 4.1 Тесты пакета ядра (включая golden), `npm run typecheck`, `npm run lint`, `npm run lint:dead`, `npm run spec-graph -- check`, `npx openspec validate --specs --strict` и `--changes --strict`.
