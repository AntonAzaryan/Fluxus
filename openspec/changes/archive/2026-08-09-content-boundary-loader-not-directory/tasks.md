# Tasks: content-boundary-loader-not-directory

## 1. Синхронизация спеки

- [x] 1.1 Перепроверить очередь на конкурирующие дельты `game-content` (`openspec/changes/*/specs/`) — при появлении перестроить свою по слитому тексту
- [x] 1.2 Синхронизировать дельту CONT-2 в `openspec/specs/game-content/spec.md`
- [x] 1.3 `openspec validate --specs --strict` зелёный

## 2. Проверка соответствия

- [x] 2.1 Убедиться, что действующее положение соответствует новому тексту без правок кода: парный документ грузится модулем ассетов (`assets-ts`), загрузчик сцены его не читает, `contentBoundary.test.ts` зелёный
