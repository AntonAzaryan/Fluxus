# Tasks: core-tick-hot-path

Требования — `specs/ecs-foundation/spec.md` (CMD-1, CMD-5, QUERY-3) и `specs/data-driven-systems/spec.md` (SYS-5, SYS-10); разбор решений — design.md (D1–D8). Гейт один и он локальный: `npm run check` из корня репозитория (CI нет).

Замер «до/после» — скрипт масштабирования `npc-stress` из `docs/reviews/2026-09-02-core-tick-headroom.md`, строка «после» заносится туда же.

## 1. Требования (D1, D5, D6)

- [x] 1.1 `specs/ecs-foundation/spec.md`: MODIFIED CMD-1 — адрес команды записи поля бывает именами и handle'ом, канал один; MODIFIED CMD-5 — точечное чтение отвечает о поле, а не о способе адресации; MODIFIED QUERY-3 — нативная система вправе передать запросу свой буфер, запрет ОБЩЕГО буфера остаётся, дисциплина вложенности переходит к системе.
- [x] 1.2 `specs/data-driven-systems/spec.md`: MODIFIED SYS-5 — `queryInto` и `getByIndex` в контракте границы; MODIFIED SYS-10 — запрет переформулирован на изменяемую ссылку на колонку, добавлено чтение по индексу выборки с условиями годности.

## 2. Ядро: команда по handle (D1–D4)

- [x] 2.1 `engine/core-ts/src/types.ts`: `CommandBuffer.setFieldByHandle`; `SystemContext.queryInto` и `SystemContext.getByIndex`.
- [x] 2.2 `engine/core-ts/src/ecs/fieldTable.ts`: тип поля в плоской таблице (`types`) — им проверяется представимость handle-команды; `readByIndex` с мягким assert'ом владения, текст находки только на ветке отказа.
- [x] 2.3 `engine/core-ts/src/ecs/world.ts`: `setFieldByHandle` (тот же порядок проверок и та же пометка dirty, что у `setField`), `checkFieldByHandle`, `getFieldByIndex`, `lookupFieldHandle` (без броска — для точечного чтения буфера), `componentNameOf`/`fieldNameOf` (имена для трейса).
- [x] 2.4 `engine/core-ts/src/ecs/commands.ts`: журнал в типизированных массивах вместо списка объектов, структурные команды — в боковом списке; `setFieldByHandle`; валидация handle-команд по таблице полей; `peekField`, разрешающий имя в handle один раз на вызов; `commandData`/`noteApplied`, дающие ту же запись трейса; `reset` для переиспользования между тиками.
- [x] 2.5 `engine/core-ts/src/sim/tick.ts`: буфер живёт на `Simulation` и очищается на входе в тик; комментарий о пост-условии SYS-9 переписан под новую конструкцию.

## 3. Ядро: выборка в буферы вызывающего (D5–D7)

- [x] 3.1 `engine/core-ts/src/ecs/query.ts`: `queryInto` рядом с `query`, общее тело отбора; ёмкость — меньшая из длин буферов, ответ — полное число совпавших.
- [x] 3.2 `engine/core-ts/src/systems/queryBuffer.ts`: буфер выборки, которым владеет система; рост удвоением, но не меньше запрошенного, и повтор запроса.
- [x] 3.3 `engine/core-ts/src/sim/tick.ts`: `queryInto`/`getByIndex` в контексте тика; счётчик запросов считает отданный результат (D7).

## 4. Потребители (D8)

- [x] 4.1 Платформа NPC: `perception.ts` (кандидаты в буфер, позиция и сторона по индексу), `behavior.ts`, `movement.ts` (позиция, скорость и поля агента по индексу; записи по handle), `threat.ts`, `director.ts`, `routes.ts`, `runtime.ts` (записи таблицы угрозы по handle), `decide.ts` (слоты способностей по индексу).
- [x] 4.2 `engine/core-ts/src/systems/physics.ts`: обе выборки в буферы системы, позиции и поля коллайдера кандидата по индексу, запись позиции по handle.
- [x] 4.3 `engine/core-ts/src/systems/locomotion.ts`: выборка в буфер, записи состояния и скорости по handle.
- [x] 4.4 `engine/core-ts/src/systems/visibility.ts`: выборки целей, наблюдателей, кандидатов и источников в буферы системы; записи масок по handle.

## 5. Тесты

- [x] 5.1 `engine/core-ts/test/handleCommands.test.ts`: порядок применения при перемешанных каналах (CMD-3), отбрасывание команды мёртвой цели, представимость значения (ECS-3), пустая запись без владения (ECS-8), точечное чтение handle-команды именами (CMD-5), побитово равные записи трейса у обоих каналов (DIAG-5), состав и порядок `queryInto` против `query` (QUERY-2), буфер короче отбора, чтение по индексу против чтения по handle (SYS-10).
- [x] 5.2 `engine/core-ts/test/abortedTick.test.ts`: команды упавшей системы не доживают до следующего тика (SYS-9).
- [x] 5.3 `engine/core-ts/test/npc.test.ts`: проба дисциплины аллокаций считает оба канала запросов и проверяет, что счёт ненулевой.
- [x] 5.4 `engine/core-ts/test/handleRead.test.ts`: перечень поверхности контекста и комментарии о запрете приведены в соответствие с новой редакцией SYS-10.

## 6. Замер и документ

- [x] 6.1 `docs/reviews/2026-09-02-core-tick-headroom.md`: строка «после» в таблице замеров, гэпы 1–3 отмечены сделанными.

## 7. Гейт

- [x] 7.1 Тесты пакетов `engine/core-ts` и `engine/integration-ts`, затем `npm run check` из корня. Golden- и cost-эталоны не менялись; `bash .claude/skills/determinism-review/scripts/check.sh` чист.
