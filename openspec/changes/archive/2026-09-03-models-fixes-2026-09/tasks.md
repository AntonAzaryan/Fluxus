# Tasks

## 1. Спека

- [x] 1.1 `rendering` REND-22: выбор уровня отнесён к батчевому ярусу; добавлены абзац о детальном ярусе и сценарий «Детальный инстанс с цепочкой уровней»
- [x] 1.2 `openspec validate --specs --strict` и `npm run spec-graph -- check` зелены

## 2. Код

- [x] 2.1 `engine/render-ts/src/subsystems/models.ts`: комментарии `cullRecord`/`selectLod` цитируют оговорку REND-22 — почему выбор уровня стоит под `record.batch !== null`
