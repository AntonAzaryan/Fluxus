# План: сведение спек и кода ядра

> Рабочий план серии OpenSpec-change'ей. Источник находок — `spec-compliance-2026-08-03.md`
> (сверка ядра со спекой от 2026-08-03). Решения по развилкам приняты пользователем
> и зафиксированы в разделе «Принятые решения» — не переоткрывать их.

---

# Сведение спек и кода ядра: серия из 10 OpenSpec-change'ей

## Context

Сверка ядра со спецификацией (`engine/docs/spec-compliance-2026-08-03.md`) нашла 4 блокера,
13 расхождений «код ≠ спека» и 8 дефектов самих спек. База при этом зелёная: 320 тестов,
`openspec validate --specs --strict` = 16 passed. То есть ни один из существующих гейтов
эти расхождения не ловит.

CORE-3 объявляет спеку источником истины, поэтому каждое расхождение обязано быть закрыто
либо правкой кода, либо осознанной правкой спеки отдельным change'ем — «код прав по факту»
недопустимо. Цель серии: свести всё найденное и добавить гейты, которые не дадут разойтись
снова.

Сквозной принцип, заданный пользователем: **десинк недопустим**. Из него выведено ключевое
правило серии — ни одна проверка не может вести себя по-разному в debug и release.

### Принятые решения

1. **assert раскалывается на две функции.** `assert` — мягкий, только диагностика через
   подключаемый sink, результат операции не меняет. `assertInvariant` — жёсткий, бросает
   **в обоих сборках**. Мягкие: `wrap`, `div` на ноль, `sqrt(<0)`, переполнение
   `generation`, `componentMask.checkBounds`. Жёсткие, на границе рождения значения:
   `createEntityIndex`, `makeEntityId`, `allocate`, `nextBelow(bound)`.
2. **Новое FP-6:** `sqrt` от отрицательного SHALL возвращать 0 (обоснование как у FP-5).
   **FP-2** переформулируется: магнитуда через 64-битный промежуток, знак отдельно — иначе
   противоречит FP-3 (truncate toward zero).
3. **Дубль PHYS-7** разводится: tie-break сохраняет номер, «статика выводится» становится
   PHYS-10. «Статика раньше динамики» нормируется **в PHYS-7** (это правило порядка hit'ов),
   а не в PHYS-8.
4. **TWEEN-1 и TIME-7/FOW-3 правятся под код:** нормой становится таблица `TweenDef` с
   полем-индексом `def` и слотовое разложение `sources` — тот же приём, что уже нормирован в
   TERR-6 для карты пола. Число слотов становится полем конфига сцены (дефолт 4) по аналогии
   с `tileSize` из TERR-2; из этого автоматически следует устранение модульного синглтона и
   мутабельного `pending`-оверлея в `modifiers.ts`.
5. **Вводятся `addModifier`/`removeModifier`** в Action DSL.
6. **Контур событий замыкается в пределах тика:** `SystemContext.events` расширяется до
   чтения, в DSL появляется итерация по событиям тика и чтение поля события. Шина
   по-прежнему чистится на границе тика — видно только то, что эмитнули системы с меньшим
   `order`. EVT-4 уточняется: «переживает границу тика» — только в снапшоте.
7. **FOW-5:** бит своей команды взводится безусловно (нормируется как есть); сценарий
   «наблюдатель сверху» переписывается с учётом того, что cliff-отрезок перекрывает обзор по
   TERR-5. Направленный обзор с высоты — отдельный будущий change, в серию не входит.
8. **Хеш `worldInit` реализуется** на существующем `fnv1a32` и сортировке ключей плоской
   формы; выводится полем CLI, поэтому все golden перегенерируются — этот change идёт
   последним и один.

## Процессные ограничения OpenSpec (нарушение = молчаливая потеря правок)

- Порядок артефактов: `proposal.md` → `specs/<capability>/spec.md` (дельта) → `design.md`
  (необязателен) → `tasks.md`. Цикл: `/opsx:propose` → `/opsx:apply` → `/opsx:sync` →
  `/opsx:archive`.
- **`## MODIFIED Requirements` в этом репозитории содержит ПОЛНЫЙ блок требования со всеми
  сценариями, а не патч.** Два change'а на один ID затирают друг друга при sync, без
  конфликтного маркера. Отсюда все ограничения на параллельность ниже.
- **Переименование требования делается `REMOVED` + `ADDED`, не `MODIFIED`** — OpenSpec
  ключует по полной строке заголовка (проверено: сейчас два PHYS-7 проходят `--strict`).
- `## Purpose` и `## Open Questions` дельтой не выражаются — правятся задачами прямо в
  главной спеке.
- Правила `openspec/config.yaml`: исторический ID в заголовке, текст по-русски, модальность
  SHALL / MUST NOT, у каждого требования минимум один `#### Scenario`, новое требование
  получает следующий свободный номер в префиксе.
- `openspec` CLI есть **только на хосте**: `host openspec validate <change> --strict`.
  `vitest` в контейнере не запускается (нет нативного биндинга rolldown) — `host npx vitest
  run` из `core-ts`.
- **`sync` и `archive` делаю я вместе с пользователем**, не субагенты: скилл запрещает
  выбирать change автоматически. Субагенты доводят change до состояния «все задачи
  `- [x]`, тесты зелёные, `validate --strict` проходит» и останавливаются.

Свободные номера проверены по всему `openspec/` включая архив: **FP-6, RNG-8, CMD-7,
PHYS-10** — ноль вхождений. Новые номера в префиксах EVT/ACT не нужны.

## План: 10 change'ей, 4 волны

### Волна 1 — пять change'ей параллельно (наборы файлов не пересекаются)

| # | change | спеки → ID | код | golden |
|---|---|---|---|---|
| 1 | `arithmetic-and-rng-norms` | `fixed-point-math`: MOD FP-2, FP-4, FP-5 · ADD FP-6 · `rng`: ADD RNG-8 · `ecs-foundation`: MOD ID-1 | `debug.ts`, `math/fixed.ts`, `ecs/entityIndex.ts`, `ecs/componentMask.ts`, `math/rng.ts`, `index.ts` | нет |
| 2 | `physics-norms-and-cli-input` | `physics`: MOD PHYS-5, PHYS-6, PHYS-7 · REM PHYS-7(static) + ADD PHYS-10 · MOD PHYS-8 · `cli-testing`: MOD CLI-2 | `sim/scenario.ts` (одна строка), комментарии `systems/physics.ts` | нет |
| 3 | `spec-catchup-arena-fow` | `arena`: MOD ARENA-3, ARENA-5 · `fog-of-war`: MOD FOW-1, FOW-5 | нет | нет |
| 4 | `generated-field-norms` | `terrain`: MOD TERR-6 · `serialization`: MOD SER-6 | нет | нет |
| 10 | `rewind-norms` | `snapshot-rewind`: MOD REW-4, SNAP-6 | нет | нет |

Проверено: пять наборов спек не пересекаются (`fixed-point-math`+`rng`+`ecs-foundation` /
`physics`+`cli-testing` / `arena`+`fog-of-war` / `terrain`+`serialization` /
`snapshot-rewind`), код трогают только 1 и 2, и в разных файлах. Никто не пишет
`engine/schemas/` и `tests/golden/`.

### Волна 2 — строго последовательно, 5 → 6

| # | change | спеки → ID | код | golden |
|---|---|---|---|---|
| 5 | `scene-schema-contract` | `serialization`: MOD SER-5, SER-7 | `dsl/schemas.ts`, `schemas/scene.schema.json`, `schemas/scenario.schema.json` | нет |
| 6 | `modifier-slots-and-actions` | `time-system`: MOD TWEEN-1, TWEEN-2, TWEEN-3, TWEEN-4, TWEEN-6, TWEEN-7, TIME-7, TIME-8, TIME-9 · `fog-of-war`: MOD FOW-3 · `data-driven-systems`: MOD ACT-1 · `serialization`: MOD SER-7 (от синхронизированного текста change 5) | `systems/modifiers.ts`, `systems/time.ts`, `systems/visibility.ts`, `systems/tween.ts`, `sim/scene.ts`, `sim/scenario.ts`, `dsl/actions.ts`, `dsl/schemas.ts`, `index.ts`, `schemas/*.json` ×3 | +1 новый; **arena-time и visibility обязаны остаться побайтово теми же** |

Параллельность недоступна: обе пишут `dsl/schemas.ts` и три закоммиченных файла схем, и
change 6 обязана вести SER-7 вперёд от уже синхронизированного текста change 5.

### Волна 3 — два параллельно

| # | change | спеки → ID | код | golden |
|---|---|---|---|---|
| 7 | `events-in-systems` | `data-driven-systems`: MOD SYS-5, EVT-2, EVT-4, ACT-1 (carry-forward от change 6), ACT-3, EXPR-2 | `types.ts` (одна строка), `dsl/expr.ts`, `dsl/actions.ts`, `dsl/schemas.ts`, `schemas/*.json` ×3 | +1 новый |
| 8 | `side-channel-and-command-norms` | `tick-loop`: MOD TICK-2, TICK-3 · `ecs-foundation`: ADD CMD-7, MOD QUERY-1 · `netcode`: MOD NET-12 | `index.ts` | нет |

Change 7 обязан идти после change 6 из-за ACT-1. Change 8 такой связи не имеет, но остаётся
здесь: он правит `ecs-foundation`, который в волне 1 держит change 1.

### Волна 4 — один, в одиночестве

| # | change | спеки → ID | код | golden |
|---|---|---|---|---|
| 9 | `worldinit-hash` | `determinism-core`: MOD DET-1 · `cli-testing`: MOD CLI-3 | новый `sim/worldInit.ts`, `sim/scene.ts`, `sim/scenario.ts`, `index.ts`, **все правки `docs/architecture.md`** | **все 9 перегенерируются** |

Владеет всеми правками `architecture.md` (строка 49 `PHYS-1..10`, §6 п.12, §6 п.13) — иначе
это трёхсторонний конфликт волн 1 и 4. Регенерирует каждый эталон, поэтому ничего другого в
работе быть не должно.

## Покрытие отчёта

| пункт | change | | пункт | change |
|---|---|---|---|---|
| B1 | 1 | | S11 | 3 |
| B2 | 7 | | S12 | 8 (ADD CMD-7) |
| B3 | 6 | | S13 | 8 (нормируем как есть, кода 0) |
| B4 | 5 | | C1 | 2 |
| S1 | 6 (+ TWEEN-2/3/4/6/7) | | C2 | 1 |
| S2 | 6 | | C3 | 8 (тот же TICK-3, что S9) |
| S3 | 7 | | C4 | 10 + 6 (TIME-9) |
| S4 | 5 | | C5 | 6 (кламп сырым Q16.16) |
| S5 | 2 | | C6 | 10 |
| S6 | 4 (имена полей) + 6 (слоты) | | C7 | 3 (п.12) + 9 (п.13) |
| S7 | 1 (ADD RNG-8) | | C8 | 1 |
| S8 | 2 + 3 (потолок радиуса) | | §4.1 | 2 |
| S9 | 8 | | §4.2 | 7 (ACT-3) |
| S10 | 3 (норма) + 6 (FOW-3 несёт) | | §4.3 | 8 (QUERY-1) |
| | | | §4.4 | 8 (TICK-2 — владелец ширины `buttons`) |
| | | | §4.5 | не входит: уже живой Open Question в `terrain` |
| | | | §4.6 | 6 (место регистрации `ArenaSystem`) |

## Известные ловушки

1. **Change 1 golden-нейтрален, и это доказуемо, а не на глаз.** `DEBUG` истинен под
   vitest, каждый assert сейчас бросает, и `golden.test.ts` зелёный — значит ни один
   golden-сценарий не доходит ни до `wrap`, ни до `div(_, 0)`, ни до `sqrt(<0)`.
   Приёмка: golden совпадают **без** `npm run golden`.
2. **Value-path в change 1 почти не меняется.** `fixed.ts:80` уже возвращает насыщение,
   `fixed.ts:112` уже возвращает `0` — FP-5 и FP-6 не требуют новых расчётов, весь диф это
   удаление одного `throw` и раскол одной функции.
3. **Change 6: побайтовая тождественность golden держится на позиции схем в списках.**
   `slotName` при `slots = 4` даёт `id0..id3` — имена сохраняются. Но эталоны кодируют
   битовые id компонентов, а `VISION_MODIFIERS.schema` стоит **последней** в
   `FOW_COMPONENTS`, тогда как `TIME_SCALE_MODIFIERS.schema` — **второй** в
   `TIME_COMPONENTS`. Сдвиг любой схемы при де-синглетонизации перепишет оба эталона.
4. **Changes 5, 6, 7 валят `schemas.test.ts` до `npm run schemas`** — определения `action` и
   `expression` встроены в три закоммиченных файла схем.
5. **Change 7 меньше, чем кажется:** `ReadonlyEventLog` уже существует (`types.ts:189`), а
   `tick.ts:118` уже передаёт в контекст полный `EventLog`. Нативная половина — расширение
   одной строки типа, `tick.ts` не трогается вовсе.
6. **ACT-1 и SER-7 требуют carry-forward.** Дельта change 7 по ACT-1 и дельта change 6 по
   SER-7 должны писаться от синхронизированного текста предшественника. Это отдельная первая
   задача в `tasks.md`, а не допущение.
7. **CLI-6 не трогаем:** `cli-testing/spec.md:101` ссылается на tie-break PHYS-7, который
   номер сохраняет. Переномерации требует только ссылка внутри CLI-2 (`:44`), плюс PHYS-5
   (`:70`) и PHYS-6 (`:90`).

## Валидатор JSON Schema для change 5: без ajv

Ни `ajv`, ни любого другого валидатора в `core-ts/node_modules` и `engine/node_modules` нет,
транзитивно тоже не пришло. SER-5 при этом прямо запрещает ядру зависеть от валидатора JSON
Schema.

Дефект B4 односторонний: загрузчик принимает поля, которые схема отвергает. Чтобы это
поймать, нужны ровно три правила — разрешение `$ref` в `$defs`, неизвестное свойство при
`additionalProperties: false`, отсутствующее `required`. `type`, `pattern`, `minimum`,
`enum`, `oneOf` проверять не нужно: SER-5 уже устанавливает, что загрузчик строго строже, и
второй проверяльщик этих правил может только начать с ним расходиться. Это ~35 строк
рекурсивного обхода в самом тест-файле: ни зависимости, ни кода в `src/`.

## Состав задач по change'ам

Последняя группа везде — `## N. Проверка` с `npm test`, `npm run typecheck`, состоянием
golden и `openspec validate <change> --strict`. Ниже — только содержательные группы.

**1 `arithmetic-and-rng-norms`** · design.md: да, короткий (таблица мягкое/жёсткое + интерфейс sink)
1. Спеки: FP-2, FP-4 (раскол assert/assertInvariant), FP-5, ADD FP-6, ADD RNG-8
   (`nextFixed` = старшие 16 бит; `nextBelow` = Lemire multiply-shift с отбраковкой по
   порогу `(2^32 − s) mod s`), ID-1.
2. `debug.ts`: `assert` через подключаемый sink без броска; `assertInvariant` бросает в обоих
   режимах.
3. Мягкие: `fixed.ts` wrap / div / sqrt, переполнение `generation` в `entityIndex.free`,
   `componentMask.checkBounds` (обёртка `if (DEBUG)` внутри самой функции).
4. Жёсткие: `createEntityIndex`, `makeEntityId`, `allocate`, `nextBelow(bound)`.
5. `componentMask.ts:7` — убрать ссылку на SNAP-5 (C8).
6. `index.ts` — экспорт `assertInvariant` и установки sink.
7. Тесты: переписать `fixed.test.ts:123,144,153,196` и `entityIndex.test.ts:157` под
   «значение то же, диагностика в sink»; нормативные тесты `nextFixed`/`nextBelow`; тест
   «мягкий assert не бросает и не меняет результат».

**2 `physics-norms-and-cli-input`** · design.md: нет
1. `physics`: REM PHYS-7(static) + ADD PHYS-10; MOD PHYS-5 и PHYS-6 (ссылки на PHYS-10;
   `ratio` — деление с насыщением и floor; предел ~181 единицы).
2. `physics`: MOD PHYS-7 — статика раньше динамики, строгое `<` при равной дистанции;
   MOD PHYS-8 — разложение X→Y, `separation` в 64 битах, правило хода из пересечения.
3. `cli-testing`: MOD CLI-2 — ссылка на PHYS-10, поле `visibility`, буква про `inputs[]`.
4. `scenario.ts:78` — `def.inputs !== undefined` вместо `.length > 0`; тест на `"inputs": []`
   без `players`.
5. Комментарии `physics.ts`: `PHYS-1..9` → `PHYS-1..10`.

**3 `spec-catchup-arena-fow`** · design.md: нет
1. `arena`: MOD ARENA-3, ARENA-5 — компонент `ArenaState`, участие как решение контента.
2. `fog-of-war`: MOD FOW-5 — бит своей команды безусловно, до радиуса / укрытий / уровня;
   сценарий «наблюдатель сверху» под перекрытие cliff-отрезком по TERR-5. MOD FOW-1 — потолок
   эффективного радиуса со ссылкой на PHYS-6.
3. Задачей прямо в спеке: открытый вопрос «направленный обзор с высоты» в
   `fog-of-war` `## Open Questions`.

**4 `generated-field-norms`** · design.md: нет
1. `terrain`: MOD TERR-6 — имена полей карты пола с zero-padding.
2. `serialization`: MOD SER-6 — любая порождённая раскладка «список → слоты» даёт имена,
   сортируемые лексикографически (без привязки к модификаторам).

**10 `rewind-norms`** · design.md: нет
1. `snapshot-rewind`: MOD REW-4 — реплей внутри `seekTo` есть часть rewind-механизма, а не
   исполнение «обычных систем».
2. MOD SNAP-6 — глубина как `interval × (count − 1)`.

**5 `scene-schema-contract`** · design.md: да, короткий (запись решения «минимальная проверка вместо ajv»)
1. `serialization`: MOD SER-5 — красный тест «golden-сценарии против опубликованной схемы»;
   MOD SER-7 — полный состав сцены и порядок порождённых компонентов
   floor → arena → timeScale → tween → fow.
2. `schemas.ts`: `arena`, `timeScale`, `tweens`, `fog` в `scene`; `visibility` в `scenario`.
3. `npm run schemas`.
4. Новый тест: ~35-строчный обход (`$ref`, `additionalProperties: false`, `required`) по всем
   `tests/golden/*.scenario.json`.

**6 `modifier-slots-and-actions`** · design.md: да, самый нужный (где живёт `ModifierList`, как до него дотягивается Action Executor и `VisibilitySystem`, почему `maskWords` не меняются)
1. Перечитать синхронизированный SER-7 из change 5 и вести его текст вперёд.
2. `time-system`: MOD TWEEN-1 (таблица `TweenDef` + поле `def`), TWEEN-2 (нумерация easing),
   TWEEN-3, TWEEN-4, TWEEN-6 (один твин на сущность), TWEEN-7 (`ignoreTimeScale`), TIME-7
   (слоты, `id == 0` = свободен, запрет нулевого id, переполнение = ошибка, дефолт
   `FIXED_ONE`, кламп сырым Q16.16), TIME-8 (управление из DSL), TIME-9 (формулировка по
   REW-4).
3. `fog-of-war`: MOD FOW-3 — слоты; «кроме собственной команды» согласно FOW-5 из change 3.
4. `data-driven-systems`: MOD ACT-1 — переписать абзац-исключение, добавить
   `addModifier`/`removeModifier`.
5. `serialization`: MOD SER-7 — поле `slots` с дефолтом 4.
6. `modifiers.ts`: убрать `pending`-оверлей и модульное состояние, `modifierList` — фабрика.
7. `time.ts`, `visibility.ts`: убрать синглтоны, `TIME_COMPONENTS`/`FOW_COMPONENTS` —
   функции, **позиции схем в списках сохранить**.
8. `scene.ts`: создание списков при загрузке, порядок дописывания компонентов не менять;
   `scenario.ts`: проброс в `VisibilitySystem`, регистрация `ArenaSystem` рядом с
   `TimeScale`/`Tween` (§4.6).
9. `actions.ts` + `schemas.ts` + `npm run schemas`; `index.ts` — снять экспорт синглтонов.
10. Тесты: `time.test.ts` (11 мест), `visibility.test.ts`, `tween.test.ts`,
    `actions.test.ts`. Новый golden на стакинг источников из JSON.
11. Приёмка: `arena-time.golden.json` и `visibility.golden.json` побайтово без изменений.

**7 `events-in-systems`** · design.md: да (форма узла итерации, чтение поля, почему только в пределах тика)
1. Перечитать синхронизированный ACT-1 из change 6 и вести его текст вперёд.
2. `data-driven-systems`: MOD SYS-5 (полный листинг: `terrain?`, `arena?`,
   `getEffectiveDelta`, новая форма `events`), EVT-2, EVT-4 («переживает границу тика» —
   только в снапшоте), ACT-1, EXPR-2 (чтение поля события), ACT-3 (порядок при
   целочисленных именах полей).
3. `types.ts`: `events: EventEmitter & ReadonlyEventLog` — одна строка, `tick.ts` не трогать.
4. `actions.ts`: узел итерации по событиям тика с фильтром по типу; `actions.ts:190` —
   сортированные ключи вместо `Object.entries`.
5. `expr.ts`: чтение поля события. `schemas.ts` + `npm run schemas`.
6. Тесты: `expr.test.ts`, `actions.test.ts`, `evaluatedSystem.test.ts`. Новый golden:
   JSON-система реагирует на `Collision`.

**8 `side-channel-and-command-norms`** · design.md: нет
1. `tick-loop`: MOD TICK-3 — исключения `worldInit`, `seekTo`/WSM-5, exempt-поля REW-9 (S9 и
   C3 одним блоком); MOD TICK-2 — единственный владелец ширины `buttons`.
2. `ecs-foundation`: ADD CMD-7 — команда к мёртвой сущности отбрасывается; MOD QUERY-1 —
   краевые случаи пустых `any`/`not` и неизвестного компонента.
3. `netcode`: MOD NET-12 — вырезание через `destroy` меняет generations и freeList,
   нормируется как есть.
4. `index.ts`: сузить `export * as world` до read-only плюс явные `worldInit`-хелперы.

**9 `worldinit-hash`** · design.md: да (каноническая форма и её состав)
1. `determinism-core`: MOD DET-1 — что входит в хеш. `cli-testing`: MOD CLI-3 — поле вывода.
2. Новый `sim/worldInit.ts` на существующем `fnv1a32` (`math/rng.ts:20`) и сортировке ключей
   плоской формы (SER-6).
3. `scene.ts`/`scenario.ts`: расчёт и вывод; `index.ts`: экспорт.
4. Тесты: стабильность при переформатировании ассета, различие при другой сетке.
5. `docs/architecture.md`: строка 49 `PHYS-1..10`, §6 п.12 переформулировать, п.13 снять.
6. `npm run golden` — все 9 эталонов.

## Как распараллеливаю

Волны 1 и 3 запускаю субагентами одновременно (пять и два соответственно), волну 2
последовательно, волну 4 одним агентом. Каждому агенту в промпте: мост `host <команда>`,
правила OpenSpec из этого плана, его собственный список файлов и **явный запрет трогать
что-либо вне списка**.

Субагент доводит change до состояния «все задачи `- [x]`, `host npx vitest run` зелёный,
`host npx tsc --noEmit` чистый, `host openspec validate <change> --strict` проходит» и
останавливается. `/opsx:sync` и `/opsx:archive` делаю я вместе с пользователем после каждой
волны — скилл запрещает выбирать change автоматически, а sync — это агентный merge дельты в
главную спеку, который нельзя выполнять вслепую.

## Verification

После каждой волны, до sync:
- `cd engine/core-ts && host npx vitest run` — все тесты зелёные;
- `host npx tsc --noEmit` — чисто;
- `host openspec validate --specs --strict` — 16 capability проходят (гейт глобальный:
  поломка одного change'а красит всё);
- `host openspec validate <change> --strict` для каждого change'а волны;
- `git status` — изменены только файлы из списка соответствующего change'а.

Отдельные приёмочные проверки, которые легко пропустить:
- волна 1: `git diff --stat engine/tests/golden/` пуст;
- change 6: `arena-time.golden.json` и `visibility.golden.json` побайтово не изменились;
- changes 5, 6, 7: `engine/schemas/*.json` перегенерированы (`npm run schemas`) и
  `schemas.test.ts` зелёный;
- change 5: новый тест валидности golden-сценариев по схеме краснеет, если убрать любое из
  добавленных полей;
- change 9: `npm run golden`, затем повторный `npm test` — эталоны стабильны, а хеш
  `worldInit` не меняется при переформатировании ассета террейна.

Итоговая сверка: перечитать `docs/spec-compliance-2026-08-03.md` и убедиться, что каждый
пункт закрыт либо правкой, либо явно зафиксирован как открытый вопрос (§4.5 и направленный
обзор с высоты — единственные два, которые остаются открытыми осознанно).
