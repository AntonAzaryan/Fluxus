## Why

`src/dsl/schemas.ts` порождает JSON Schema `scene` и `scenario` с `additionalProperties: false`,
но обе схемы отстают от загрузчика: `scene.arena`, `scene.timeScale`, `scene.tweens`, `scene.fog`
и `scenario.visibility` загрузчик (`sim/scene.ts`, `sim/scenario.ts`) принимает и использует, а
опубликованная схема их не знает — и потому отвергает как «лишнее свойство». Оба собственных
golden-эталона (`arena-time.scenario.json`, `visibility.scenario.json`) не проходят свою же
опубликованную схему. Это прямое нарушение SER-5: «схема не строже загрузчика», и оно бьёт по
редактору и внешнему тулингу первым же реальным конфигом.

## What Changes

- `serialization` SER-5: критерий соответствия схемы и загрузчика нормируется явно — опубликованная
  схема SHALL принимать все golden-сценарии репозитория; расхождение схемы с реально поддерживаемым
  полем — тот же красный тест, что и расхождение с порождающим кодом.
- `serialization` SER-7: состав документа конфига сцены нормируется полностью — перечисляются все
  поля `SceneDef` (`components`, `prefabs`, `systems`, `capacity`, `terrain`, `arena`, `timeScale`,
  `tweens`, `fog`), включая уже нормированные ранее. Относительный порядок компонентов, порождаемых
  `arena`/`timeScale`/`tweens`/`fog` между собой, этим change не нормируется — это отдельная задача
  `modifier-slots-and-actions`. Отдельно фиксируется, что генератор схем (SER-5) обязан публиковать
  и необязательное поле `visibility` документа сценария (CLI-2, `fog-of-war` FOW-4) — оно уже
  нормировано в `cli-testing` CLI-2 как поле самого документа, а не как содержимое `scene`.
- `dsl/schemas.ts`: добавляются недостающие поля в порождаемые схемы `scene` (`arena`, `timeScale`,
  `tweens`, `fog`) и `scenario` (`visibility`), с формой, соответствующей тому, что реально читают
  `sim/scene.ts` и `sim/scenario.ts`.
- `engine/schemas/scene.schema.json`, `engine/schemas/scenario.schema.json`: перегенерированы из
  обновлённого генератора.
- Новый тест: ручной (без ajv, запрещённого SER-5) рекурсивный обход JSON Schema, проверяющий каждый
  `tests/golden/*.scenario.json` против опубликованной схемы — красный, если из схемы убрать любое
  из добавленных полей.

## Capabilities

### New Capabilities

(нет)

### Modified Capabilities

- `serialization`: SER-5 (критерий «схема не строже загрузчика» через golden-эталоны), SER-7
  (полный состав полей конфига сцены, без нормирования порядка порождённых компонентов).

## Impact

- Код: `engine/core-ts/src/dsl/schemas.ts` (единственный правленый исходник), сгенерированные
  `engine/schemas/scene.schema.json` и `engine/schemas/scenario.schema.json`, новый тест в
  `engine/core-ts/test/`.
- Golden-эталоны (`engine/tests/golden/*.scenario.json`) не меняются: change трогает только
  схему и код валидации схем, не runtime-логику загрузчика.
- Открывает дорогу `modifier-slots-and-actions`: тот change ведёт SER-7 дальше от текста,
  синхронизированного здесь, и добавляет нормирование порядка порождённых компонентов и поле
  `slots`.
