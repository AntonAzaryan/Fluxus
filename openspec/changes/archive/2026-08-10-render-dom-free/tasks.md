## 1. Охрана typecheck'ом

- [x] 1.1 Удалить `"DOM"` из `compilerOptions.lib` в `engine/render-ts/tsconfig.json`
- [x] 1.2 Прогнать `npm run typecheck -w @game-mvp/render` и убедиться, что пакет типизируется без DOM-деклараций; если всплыли DOM-типы в сигнатурах — вынести их за пакет, а не возвращать lib

## 2. Проверка

- [x] 2.1 `npm test -w @game-mvp/render` — тесты пакета зелёные в node-окружении
- [x] 2.2 `npm run check` из корня — весь гейт зелёный
- [x] 2.3 `openspec validate render-dom-free --strict` — delta-спека валидна
