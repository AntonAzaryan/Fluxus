## 1. Дерево контента

- [ ] 1.1 Создать `content/` с поддеревьями `scenes/`, `matches/`, `visuals/` (решение 2 design)
- [ ] 1.2 `git mv` presentation-контента: `engine/client-ts/demo/public/assets/{manifest.json → visuals/manifest.json, models/* → visuals/models/, textures/* → visuals/textures/}`
- [ ] 1.3 Поправить ID внутри `content/visuals/manifest.json`: `models/…` → `visuals/models/…`, `textures/…` → `visuals/textures/…` (ID — путь от корня дерева, CONT-2)
- [ ] 1.4 Слить две сцены дуэли в `content/scenes/duel.scene.json`, взяв надмножество клиентского демо (решение 3 design); удалить `engine/net-ts/examples/content/duel.scene.json` и `engine/client-ts/demo/scene.json`
- [ ] 1.5 `git mv engine/net-ts/examples/duel.match.json content/matches/duel.match.json`, переписать `contentPack` на `../scenes/duel.scene.json`; удалить опустевший `engine/net-ts/examples/`

## 2. Оболочки

- [ ] 2.1 `engine/client-ts/demo/vite.config.ts`: `publicDir` — корень `content/`, `server.fs.allow` — корень репозитория
- [ ] 2.2 `engine/client-ts/demo/worker.ts`: импорт сцены из `content/scenes/duel.scene.json`
- [ ] 2.3 `engine/client-ts/demo/main.ts`: база `fetch` — корень дерева контента (`/` вместо `/assets/`), запрос манифеста по ID `visuals/manifest.json`
- [ ] 2.4 Проверить, что `engine/net-ts/bin/matchFile.mjs` правок не требует: пути `contentPack` уже резолвятся от `dirname` файла матча (CONT-5)

## 3. Проверка границы (CONT-1)

- [ ] 3.1 Добавить в `engine/tests/guard/` сканер расположения контента: обход `engine/*/`, списки расширений и имён контентных документов и список исключений — данными в файле (решение 5 design)
- [ ] 3.2 Адаптер-тест в `engine/integration-ts/test/`: сканер по всем пакетам движка, исключения `engine/tests/golden/**` и `**/test/fixtures/**` (CONT-4)
- [ ] 3.3 Проверить, что проверка ловит нарушение: временно положить `*.scene.json` в пакет движка — тест краснеет и называет файл и правило

## 4. Приёмка

- [ ] 4.1 `npm test` и `npm run typecheck` из корня — зелёные
- [ ] 4.2 `npm run golden` из корня — дифф эталонов **пуст** (переезд байтов, не поведения; риск 1 design)
- [ ] 4.3 Тесты движка проходят при отсутствующем дереве контента: временно переименовать `content/`, прогнать `npm test`, вернуть (CONT-4, риск 4 design)
- [ ] 4.4 Руками: `npm run dev -w @game-mvp/client` — демо поднимается, сцена грузится, модель и обе текстуры видны (риск 2 design — автотестом не покрывается)
- [ ] 4.5 Руками: локальный матч на два процесса из `content/matches/duel.match.json` — `serve` поднимается, `play` подключается, хендшейк сходится

## 5. Документация

- [ ] 5.1 `README.md`: `content/` в карте репозитория, обновлённые пути в примерах команд
- [ ] 5.2 `docs/architecture.md`: дерево контента в разделе слоёв и в таблице «механизм против политики»
- [ ] 5.3 `CLAUDE.md`: где живёт контент и что фикстуры движка контентом не являются
- [ ] 5.4 `engine/net-ts/README.md`: путь до конфига матча в примерах запуска
- [ ] 5.5 Скил `json-system`: контент авторится в `content/`, а не в пакетах движка
- [ ] 5.6 `openspec validate --specs --strict` и `openspec validate extract-game-content-tree --strict` — зелёные
