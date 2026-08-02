## 1. Контракт CommandBuffer (CMD-6)

- [x] 1.1 `src/types.ts`: `spawn(prefab, overrides?)` — карта «компонент → поле → значение»
- [x] 1.2 `src/ecs/world.ts`: `spawn` применяет переопределение поверх prefab'а, падает на компоненте вне prefab'а
- [x] 1.3 `src/ecs/commands.ts`: команда `spawn` несёт переопределение до flush

## 2. Action Executor

- [x] 2.1 `src/actions.ts`: типы `Action`, `ActionScope`, закрытая таблица действий (ACT-1)
- [x] 2.2 Действия над компонентами: `modifyComponent`, `addComponent`, `removeComponent`
- [x] 2.3 Структурные действия: `spawnEntity`, `destroyEntity` — только командами (CMD-4)
- [x] 2.4 `emitEvent` — через `EventEmitter`, данные из выражений
- [x] 2.5 Управляющие действия: `if`, `let`, `forEach` с вложенной областью видимости
- [x] 2.6 Порядок команд: сортировка имён полей в `values`/`overrides`/`data` (ACT-3)
- [x] 2.7 Экспорт из `src/index.ts`

## 3. Тесты

- [x] 3.1 `modifyComponent` создаёт команду, а не мутирует мир до flush (ACT-2, CMD-1)
- [x] 3.2 Два `modifyComponent` подряд читают состояние на начало системы (CMD-5)
- [x] 3.3 Порядок команд не зависит от порядка ключей в `values`, включая имя поля `"0"` (ACT-3)
- [x] 3.4 `forEach` с `withinRadius` от выражения; тело видит переменную из `as`
- [x] 3.5 `let` затеняет внешнюю переменную и не протекает наружу
- [x] 3.6 `if` выбирает ветку, `else` необязателен
- [x] 3.7 `spawnEntity` с переопределением позиции; компонент вне prefab'а — ошибка (CMD-6)
- [x] 3.8 `emitEvent` кладёт событие с вычисленными данными
- [x] 3.9 Неизвестное действие и узел с двумя ключами падают с ошибкой (ACT-1)

## 4. Проверка

- [x] 4.1 `npm test` и `npm run typecheck` в `core-ts` зелёные
- [x] 4.2 `openspec validate action-executor --strict`
- [x] 4.3 `docs/architecture.md` §5 — этап 7 отмечен выполненным
