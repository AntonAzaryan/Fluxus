## 1. Carry-forward синхронизированных спек

- [x] 1.1 Прочитать УЖЕ СИНХРОНИЗИРОВАННЫЙ `openspec/specs/serialization/spec.md` (SER-6, SER-7) и вести дельту SER-7 вперёд от него: сохранить весь текст change'а `scene-schema-contract` (полный состав полей, абзац про `scenario.visibility`), заменив только фразу «Относительный порядок … этим требованием не определяется» и соответствующий сценарий
- [x] 1.2 Прочитать синхронизированные REW-4 (`snapshot-rewind`), FOW-5 (`fog-of-war`), TERR-6 (`terrain`), SER-6 и вести TIME-9 / FOW-3 / TIME-7 в их рамке, а не переопределять их правила
- [x] 1.3 Проверить, что каждый блок `## MODIFIED Requirements` содержит ПОЛНОЕ требование со всеми сценариями (включая унаследованные) и что строка заголовка совпадает с главной спекой дословно

## 2. Спека

- [x] 2.1 `time-system` TWEEN-1: таблица `TweenDef` в конфиге сцены + компонент из скалярных полей `def, duration, easing, elapsed, from, ignoreTimeScale, to`; обоснование через ECS-3; иммутабельность таблицы (SNAP-1); ссылка за пределы таблицы — ошибка
- [x] 2.2 `time-system` TWEEN-2: нормативная нумерация `linear = 0`, `instant = 1`; расширение только дописыванием; неизвестный номер — ошибка
- [x] 2.3 `time-system` TWEEN-3: `target` живёт в `TweenDef`, ровно две непустые части, разбор один раз на сцену
- [x] 2.4 `time-system` TWEEN-4: `onComplete` живёт в `TweenDef`, исполняется через Command Buffer после записи конечного значения
- [x] 2.5 `time-system` TWEEN-6: потолок «один твин на сущность», параллельные твины — отдельными сущностями
- [x] 2.6 `time-system` TWEEN-7: `ignoreTimeScale` — поле компонента, `i32`
- [x] 2.7 `time-system` TIME-7: слотовое разложение со ссылкой на SER-6 (не переопределяя правило), число слотов из конфига сцены с дефолтом 4, `id == 0` — свободен, нулевой id запрещён, переполнение — ошибка, нейтральный дефолт `65536`, кламп сырым Q16.16 `[3276, 262144]`
- [x] 2.8 `time-system` TIME-8: управление и из DSL (`addModifier`/`removeModifier`); запрет состояния вне мира у распределителя слотов со ссылками на TICK-4, DI-1, REW-7; сценарии на два добавления в одном тике, две симуляции, повторный `seekTo`
- [x] 2.9 `time-system` TIME-9: рамка синхронизированного REW-4 — норма про фазу ожидания, реплей внутри `seekTo` читает TimeScale штатно
- [x] 2.10 `fog-of-war` FOW-3: слоты по правилу TIME-7/SER-6, клампы сырым Q16.16, формулировка собственной видимости согласована с FOW-5 (бит своей команды до всех фильтров)
- [x] 2.11 `data-driven-systems` ACT-1: абзац-исключение заменён, `addTween`/`addModifier`/`removeModifier` в наборе, конвенция сырых `i32`-аргументов, требование к `component`
- [x] 2.12 `serialization` SER-7: carry-forward + поле `modifierSlots` (дефолт 4) + нормированный порядок порождённых компонентов `floor → arena → timeScale → tween → fow` + регистрация систем состава сцены загрузчиком
- [x] 2.13 `ecs-foundation` CMD-5: точечное чтение отложенного значения поля через буфер, запрет перечисления команд, соответствие последней команде (CMD-3)

## 3. Command Buffer: чтение отложенного (CMD-5)

- [x] 3.1 `types.ts`: `CommandBuffer.peekField(entity, component, field): number | undefined`
- [x] 3.2 `ecs/commands.ts`: реализация обратным проходом по накопленным командам `setField`; `ponytail:`-комментарий с потолком O(команд)
- [x] 3.3 Тест в `test/ecs.test.ts`: значение видно до flush, `undefined` без команды, последняя команда побеждает (CMD-3), после flush буфер пуст

## 4. Де-синглетонизация `modifierList`

- [x] 4.1 `types.ts`: перенести интерфейс `ModifierList` из `systems/modifiers.ts` (contract рядом с остальными; `types.ts` не должен импортировать из `systems/`), добавить `ModifierRegistry = ReadonlyMap<string, ModifierList>`
- [x] 4.2 `systems/modifiers.ts`: убрать `pendingTick`/`pending`/`claim`; `slotId` = `ctx.commands.peekField(...) ?? ctx.get(...)`; экспортировать `DEFAULT_MODIFIER_SLOTS`; добавить `requireModifierList(registry, component)` (общая точка ошибки для DSL и сборки)
- [x] 4.3 `systems/time.ts`: снять `TIME_SCALE_MODIFIERS`; `timeComponents(mods)` возвращает `[TIME_SCALE_SCHEMA, mods.schema]` (модификаторы — индекс 1, как было); `TimeScaleSystem` получает список конструктором; `TIME_SCALE_MIN = 3276` целым, с комментарием про усечение и TIME-7
- [x] 4.4 `systems/visibility.ts`: снять `VISION_MODIFIERS`; `fowComponents(mods)` возвращает `[VISION, VISIBILITY, STEALTH, TEAM, mods.schema]` (модификаторы — индекс 4, как было); `VisibilitySystem` получает список конструктором, `effectiveRadius` — параметром
- [x] 4.5 `sim/tick.ts`: `Simulation.modifiers?` и `SystemContext.modifiers` в сборке контекста (форма как у `physics`/`terrain`/`arena`)
- [x] 4.6 `sim/scene.ts`: поле `modifierSlots` с дефолтом 4 и проверкой «≥ 1»; создание обоих списков; реестр в `Scene.modifiers`; регистрация `TimeScaleSystem` со списком; порядок дописывания компонентов НЕ менять
- [x] 4.7 `sim/scene.ts`: перенести регистрацию `ArenaSystem` сюда (§4.6, SER-7 — системы состава сцены регистрирует загрузчик)
- [x] 4.8 `sim/scenario.ts`: убрать регистрацию `ArenaSystem`; `VisibilitySystem` получает список из реестра сцены; `modifiers` уходит в `Simulation`
- [x] 4.9 `index.ts`: снять экспорт `TIME_SCALE_MODIFIERS`, `VISION_MODIFIERS`, `TIME_COMPONENTS`, `FOW_COMPONENTS`; экспортировать `timeComponents`, `fowComponents`, `DEFAULT_MODIFIER_SLOTS`, `requireModifierList`, имена компонентов списков

## 5. Действия DSL (ACT-1, TIME-8)

- [x] 5.1 `dsl/actions.ts`: `addModifier { entity, component, id, value }` и `removeModifier { entity, component, id }` через `requireModifierList(ctx.modifiers, component)`
- [x] 5.2 `dsl/schemas.ts`: `scene.modifierSlots` (`integer`, `minimum: 1`); новые действия попадают в `$defs/action` сами (порождается из `actionNames`)
- [x] 5.3 `host npm run schemas` — перегенерировать `engine/schemas/*.json` (без этого краснеет `test/schemas.test.ts`)

## 6. Тесты

- [x] 6.1 `test/time.test.ts`: сцена через `timeScale: true`, список из `scene.modifiers`, TimeScaleSystem регистрирует сцена; ~11 обращений к синглтону переписаны
- [x] 6.2 `test/time.test.ts`: два `add` в ОДНОМ тике занимают разные слота (замена оверлея работает); переполнение слотов — ошибка; нулевой id — ошибка
- [x] 6.3 `test/time.test.ts`: две сцены в одном процессе не влияют друг на друга через распределение слотов (DI-1)
- [x] 6.4 `test/rewind.test.ts` или `test/time.test.ts`: повторный `seekTo` на тот же тик даёт то же состояние (REW-7) — оверлея от прошлого прохода нет
- [x] 6.5 `test/visibility.test.ts` и `test/filter.test.ts`: `fog: true` + список из реестра сцены
- [x] 6.6 `test/actions.test.ts`: `addModifier`/`removeModifier` в наборе имён; постановка и снятие источника; два добавления в одном теле занимают разные слоты; ошибка при отсутствующем списке
- [x] 6.7 `test/time.test.ts`: `modifierSlots: 12` даёт имена `id00`…`id11` (SER-6)
- [x] 6.8 Новый golden-сценарий `modifier-stack`: JSON-система ставит два источника одной сущности через `addModifier` в одном тике и снимает один через `removeModifier` — доказательство, что TIME-8 выразим из данных

## 7. Проверка

- [x] 7.1 `host npx tsc --noEmit` — чисто
- [x] 7.2 `host npx vitest run` — зелёный
- [x] 7.3 `git diff --stat engine/tests/golden/` — `arena-time.golden.json` и `visibility.golden.json` ВНЕ диффа; в диффе только новая пара файлов `modifier-stack.*`
- [x] 7.4 `host openspec validate modifier-slots-and-actions --strict` — проходит
- [x] 7.5 `git status` — только файлы из плана change'а
