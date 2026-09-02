## 1. Дельта спеки client-shell

- [x] 1.1 SHELL-6: запрос перехода машины состояний в сетевом режиме уезжает двумя путями — перемотка вводом (NET-11, REW-13), пауза матча сообщением `PauseRequest` (NTR-20); запрет исполнять переход у себя остаётся на обоих — проверка: `npx openspec validate sec08-client-shell-spec-alignment --type change --strict` зелёный
- [x] 1.2 SHELL-8: строка таблицы «переходы машины состояний мира» называет оба пути; таблица получает строку состояния паузы матча — проверка: та же валидация
- [x] 1.3 SHELL-9 (новый номер, свободный): доставка состояния паузы матча главному потоку отдельным сообщением канала, различимость отказов, молчание не есть пауза, локальный режим его не шлёт — проверка: та же валидация

## 2. Ссылки в коде

- [x] 2.1 `engine/client-ts/src/protocol.ts`: `PauseEnvelope` ссылается на SHELL-9 наравне с NTR-20 — проверка: `npm run spec-graph -- code SHELL-9` находит конверт
- [x] 2.2 `engine/client-ts/src/networkShell.ts`: `deliverPause` и `onControl` ссылаются на SHELL-9 и на два пути SHELL-6 — проверка: та же
- [x] 2.3 `engine/client-ts/src/remoteHost.ts`: приём конверта и поле `lastPause` ссылаются на SHELL-9 — проверка: та же

## 3. Ворота

- [x] 3.1 Пакетные тесты `@fluxus/client` зелёные (поведение не менялось — тесты обязаны пройти без правок)
- [x] 3.2 `npm run typecheck`, `npm run lint`, `npm run lint:dead`, `npm run spec-graph -- check`, `npx openspec validate --specs --strict` и `--changes --strict` зелёные
- [x] 3.3 Дельта слита в основные спеки (`openspec/specs/client-shell/spec.md`) — change остаётся незаархивированным
