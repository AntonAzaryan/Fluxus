## 1. Plain-форма и Serializer

- [x] 1.1 `src/serialization.ts`: интерфейс `Serializer`, реализация `jsonSerializer` (SER-2)
- [x] 1.2 `worldToPlain` / `worldFromPlain` — entity index, маски, поля компонентов, теги
- [x] 1.3 `snapshotToPlain` / `snapshotFromPlain` — мир плюс состояния RNG-стримов
- [x] 1.4 Сортировка имён компонентов, полей и тегов при построении plain-формы (SER-6)
- [x] 1.5 Аксессоры мира, которых не хватает для выгрузки (внутренние массивы, теги)

## 2. Конфиг сцены (SER-7)

- [x] 2.1 `src/scene.ts`: тип `SceneDef` (`components`, `prefabs`, `systems`)
- [x] 2.2 `loadScene(def)` → `{ world, systems }`, с валидацией систем через `registerFromJson`
- [x] 2.3 Экспорт из `src/index.ts`

## 3. JSON-схемы (SER-5)

- [x] 3.1 `src/schemas.ts`: генерация схем компонента, prefab'а, системы и сцены
- [x] 3.2 Имена действий и операторов в схеме системы берутся из `actionNames` и `operators`
- [x] 3.3 `engine/schemas/*.json` — закоммиченные файлы; `npm run schemas` перегенерирует их через vitest (UPDATE_SCHEMAS=1), отдельного рантайма для TS-скриптов в проекте нет

## 4. Тесты

- [x] 4.1 Round-trip: мир → plain → мир, состояние и следующий выданный ID совпадают
- [x] 4.2 Round-trip снапшота: восстановленный мир продолжает симуляцию идентично
- [x] 4.3 Порядок ключей не зависит от порядка объявления компонентов и полей (SER-6)
- [x] 4.4 Байты двух прогонов одного сценария совпадают
- [x] 4.5 `loadScene` поднимает мир и системы; невалидная система роняет загрузку (SER-7)
- [x] 4.6 Закоммиченные `schemas/*.json` совпадают с генератором
- [x] 4.7 Схема системы содержит все имена из `actionNames` и `operators`

## 5. Проверка

- [x] 5.1 `npm test` и `npm run typecheck` в `core-ts` зелёные
- [x] 5.2 `openspec validate serialization-format --strict`
- [x] 5.3 `docs/architecture.md` §5 — этап 9 отмечен выполненным
