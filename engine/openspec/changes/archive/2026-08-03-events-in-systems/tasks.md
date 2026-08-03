## 1. Carry-forward синхронизированных спек

- [x] 1.1 Прочитать УЖЕ СИНХРОНИЗИРОВАННЫЙ `openspec/specs/data-driven-systems/spec.md` и вести дельту ACT-1 вперёд от него: сохранить весь текст change'а `modifier-slots-and-actions` (`addTween`/`addModifier`/`removeModifier` в наборе, конвенция сырых `i32`-аргументов, требование к `component`, сценарии про замедление и про отсутствующий список), добавив только `forEachEvent`
- [x] 1.2 То же для EXPR-2, ACT-3, SYS-5, EVT-2, EVT-4: полный текущий текст как отправная точка
- [x] 1.3 Проверить, что каждый блок `## MODIFIED Requirements` содержит ПОЛНОЕ требование со всеми сценариями и что строка заголовка совпадает с главной спекой дословно
- [x] 1.4 Не трогать `openspec/specs/tick-loop/`, `openspec/specs/ecs-foundation/`, `openspec/specs/netcode/` и `src/index.ts` — файлы параллельного change'а `side-channel-and-command-norms`

## 2. Спека

- [x] 2.1 SYS-5: листинг приведён к фактическому контракту (`events: EventEmitter & ReadonlyEventLog`, `terrain?`, `arena?`, `modifiers?`, `getEffectiveDelta`); норма про паттерн опциональной зависимости DI-3 с перечислением условий присутствия каждого поля; оговорка про `TimeContext`/этап 15 заменена нормой про представление времени в контракте
- [x] 2.2 EVT-2: read-only-доступ к шине плюс узел итерации в DSL как условие выполнимости; горизонт видимости (только меньший `order`, шина чистится на границе тика); материализация обхода на входе в узел; цепочка реакций через `order`, а не подписку
- [x] 2.3 EVT-4: broadcast как общее чтение одной шины, запрет механизма подписки; «переживает границу тика» уточнено — только в снапшоте (EVT-3, REW-10); Command Buffer в снапшот не входит
- [x] 2.4 ACT-1: `forEachEvent { type, as, do }` в наборе; обязательность фильтра по типу; `as` связывает ссылку на событие, действительную только внутри тела; `forEachEvent` в списке действий, создающих область видимости
- [x] 2.5 EXPR-2: `eventField [event, field]` в наборе операторов; без преобразования масштаба; отсутствующее поле — ошибка с типом события и полем; диапазон `bitTest` `[0, 31]` как свойство контейнера `i32`
- [x] 2.6 ACT-3: сортировка лексикографическая независимо от вида имени, запрет опоры на порядок перечисления ключей объекта на любом шаге; сценарий на `"9"`/`"10"`

## 3. Нативный контракт

- [x] 3.1 `src/types.ts`: `SystemContext.events: EventEmitter & ReadonlyEventLog` (объявления `ReadonlyEventLog`/`EventEmitter` уже выше по файлу — переносить ничего не нужно)
- [x] 3.2 `src/sim/tick.ts` НЕ менять: он уже передаёт полный `EventLog`

## 4. DSL: чтение событий

- [x] 4.1 `src/dsl/expr.ts`: `ExprWorld` получает `events: ReadonlyEventLog` (именно read-only-часть — sandbox EXPR-3 держится на типе)
- [x] 4.2 `src/dsl/expr.ts`: оператор `eventField [event, field]` — индекс события выражением, имя поля строковым литералом, без преобразования масштаба; отсутствующее поле — ошибка с типом события и полем
- [x] 4.3 `src/dsl/actions.ts`: действие `forEachEvent { type, as, do }` — обход шины до длины на момент входа, фильтр по `type`, индекс события в тело как обычная переменная
- [x] 4.4 `src/dsl/evaluatedSystem.ts`: ветка `eventField` в `checkExpression` (аргумент 0 — выражение, аргумент 1 — литерал); `forEachEvent` валидируется существующей конвенцией имён без правок

## 5. ACT-3 и схема ввода

- [x] 5.1 `src/dsl/actions.ts`: `modifyComponent` перебирает явно отсортированные ключи вместо `Object.entries`
- [x] 5.2 `src/dsl/schemas.ts`: границы u16 у `inputFrame.buttons` (`minimum: 0`, `maximum: 65535`) — владелец ширины поля TICK-2
- [x] 5.3 `host npm run schemas` — перегенерировать `engine/schemas/*.json` (новые узлы попадают в `$defs/action` и `$defs/expression` сами)

## 6. Тесты

- [x] 6.1 `test/expr.test.ts`: стаб `ExprWorld` получает шину; `eventField` читает поле, ошибка на отсутствующем поле называет тип и поле; `eventField` в списке операторов
- [x] 6.2 `test/actions.test.ts`: `forEachEvent` обходит только события своего типа в порядке публикации; событие, эмитнутое телом, в текущем обходе не участвует; переменная тела не видна снаружи; `forEachEvent` в списке имён действий
- [x] 6.3 `test/actions.test.ts`: `modifyComponent` с полями `"9"` и `"10"` создаёт команды в лексикографическом порядке (краснеет на старом `Object.entries`)
- [x] 6.4 `test/evaluatedSystem.test.ts`: JSON-система реагирует на событие системы с меньшим `order`; валидация ловит опечатку в `eventField` и несвязанную ссылку на событие вне тела
- [x] 6.5 Новый golden-сценарий `collision-bounce`: JSON-система с `order` больше физики читает `Collision`, берёт нормаль через `eventField` и разворачивает скорость — доказательство, что PHYS-9 выразим из данных

## 7. Проверка

- [x] 7.1 `host npx tsc --noEmit` — чисто
- [x] 7.2 `host npx vitest run` — зелёный
- [x] 7.3 `git diff --stat engine/tests/golden/` — в диффе только новая пара файлов `collision-bounce.*`
- [x] 7.4 `host openspec validate events-in-systems --strict` — проходит
- [x] 7.5 `git status` — только файлы из плана change'а
