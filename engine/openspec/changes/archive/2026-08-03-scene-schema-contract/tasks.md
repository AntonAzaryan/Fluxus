## 1. Спека (SER-5, SER-7)

- [x] 1.1 `serialization` SER-5: критерий «схема не строже загрузчика» через golden-эталоны + новый сценарий
- [x] 1.2 `serialization` SER-7: полный состав полей `SceneDef` (включая уже нормированные), без нормирования порядка порождённых компонентов; отдельная фраза про `scenario.visibility` (владение у CLI-2)

## 2. Схема (`dsl/schemas.ts`)

- [x] 2.1 `$defs/arena`: объект `{ center: $defs/vec2, radius: integer }`, добавить `vec2` в `$defs` схемы `scene` (уже есть в `$defs` схемы `scenario`)
- [x] 2.2 `scene.arena`: `$ref: '#/$defs/arena'`
- [x] 2.3 `scene.timeScale`: `{ type: 'boolean' }`
- [x] 2.4 `scene.tweens`: массив `{ target: string, onComplete?: Action[] }` (переиспользовать `$defs/action`)
- [x] 2.5 `scene.fog`: `{ type: 'boolean' }`
- [x] 2.6 `scenario.visibility`: объект `{ order?: integer }` (форма как у существующего `scenario.physics`)
- [x] 2.7 `npm run schemas` — перегенерировать `engine/schemas/scene.schema.json` и `engine/schemas/scenario.schema.json`

## 3. Тест соответствия схемы и golden (SER-5)

- [x] 3.1 Новый тест (~35 строк, без ajv): ручной рекурсивный обход JSON Schema с разрешением `$ref` в `$defs`, проверкой `additionalProperties: false` (неизвестное свойство — ошибка) и `required` (отсутствующее поле — ошибка)
- [x] 3.2 Прогнать каждый `engine/tests/golden/*.scenario.json` целиком против `engine/schemas/scenario.schema.json`
- [x] 3.3 Приёмка: временно закомментировать одно из добавленных полей в `schemas.ts`, убедиться, что тест падает на golden, использующем это поле, затем вернуть поле

## 4. Проверка

- [x] 4.1 `host npx vitest run` из `engine/core-ts` — зелёный, включая существующий `test/schemas.test.ts` (сверка закоммиченных файлов с генератором) и `test/golden.test.ts` без изменений golden
- [x] 4.2 `host npx tsc --noEmit` из `engine/core-ts` — чисто
- [x] 4.3 Подтверждено: `npm run golden` не меняет содержимое `engine/tests/golden/*`
- [x] 4.4 `host openspec validate scene-schema-contract --strict` — проходит
