## 1. Дерево контента

- [x] 1.1 Создать `content/` с поддеревьями `scenes/`, `matches/`, `visuals/` (решение 2 design)
- [x] 1.2 `git mv` presentation-контента: `engine/client-ts/demo/public/assets/{manifest.json → visuals/manifest.json, models/* → visuals/models/, textures/* → visuals/textures/}`
- [x] 1.3 Поправить ID внутри `content/visuals/manifest.json`: `models/…` → `visuals/models/…`, `textures/…` → `visuals/textures/…` (ID — путь от корня дерева, CONT-2)
- [x] 1.4 `git mv` обеих сцен как есть: `engine/net-ts/examples/content/duel.scene.json` → `content/scenes/duel-net.scene.json`, `engine/client-ts/demo/scene.json` → `content/scenes/duel-demo.scene.json` (решение 3 design — слияние отложено, CONT-3 этим change'ем не выполняется)
- [x] 1.5 `git mv engine/net-ts/examples/duel.match.json content/matches/duel.match.json`, переписать `contentPack` на `../scenes/duel-net.scene.json`; удалить опустевший `engine/net-ts/examples/`

## 2. Оболочки

- [x] 2.1 `engine/client-ts/demo/vite.config.ts`: `publicDir` — корень `content/`, `server.fs.allow` — корень репозитория
- [x] 2.2 `engine/client-ts/demo/worker.ts`: импорт сцены из `content/scenes/duel-demo.scene.json`
- [x] 2.3 `engine/client-ts/demo/main.ts`: база `fetch` — корень дерева контента (`/` вместо `/assets/`), запрос манифеста по ID `visuals/manifest.json`
- [x] 2.4 Проверить, что `engine/net-ts/bin/matchFile.mjs` правок не требует: пути `contentPack` уже резолвятся от `dirname` файла матча (CONT-5)

## 3. Проверка границы (CONT-1)

- [x] 3.1 Добавить в `engine/tests/guard/` сканер расположения контента: обход `engine/*/`, списки расширений и имён контентных документов и список исключений — данными в файле (решение 5 design)
- [x] 3.2 Адаптер-тест в `engine/integration-ts/test/`: сканер по всем пакетам движка, исключения `engine/tests/golden/**` и `**/test/fixtures/**` (CONT-4)
- [x] 3.3 Проверить, что проверка ловит нарушение: временно положить `*.scene.json` в пакет движка — тест краснеет и называет файл и правило

## 4. Приёмка

- [x] 4.1 `npm test` и `npm run typecheck` из корня — зелёные
- [x] 4.2 `npm run golden` из корня — дифф эталонов **пуст** (переезд байтов, не поведения; риск 1 design)
- [x] 4.3 Тесты движка проходят при отсутствующем дереве контента: временно переименовать `content/`, прогнать `npm test`, вернуть (CONT-4, риск 4 design)
- [x] 4.4 Руками: `npm run dev -w @game-mvp/client` — демо поднимается, сцена грузится, модель и обе текстуры видны (риск 2 design — автотестом не покрывается)
- [x] 4.5 Руками: локальный матч на два процесса из `content/matches/duel.match.json` — `serve` поднимается, `play` подключается, хендшейк сходится

## 5. Документация

- [x] 5.1 `README.md`: `content/` в карте репозитория, обновлённые пути в примерах команд
- [x] 5.2 `docs/architecture.md`: дерево контента в разделе слоёв и в таблице «механизм против политики»
- [x] 5.3 `CLAUDE.md`: где живёт контент и что фикстуры движка контентом не являются
- [x] 5.4 `engine/net-ts/README.md`: путь до конфига матча в примерах запуска
- [x] 5.5 Скил `json-system`: контент авторится в `content/`, а не в пакетах движка
- [x] 5.6 `openspec validate --specs --strict` и `openspec validate extract-game-content-tree --strict` — зелёные

## 6. Долг

- [x] 6.1 Завести следующий change на слияние сцен и паритет оболочек: он владеет невыполненным CONT-3 (открытый вопрос 1 design)
