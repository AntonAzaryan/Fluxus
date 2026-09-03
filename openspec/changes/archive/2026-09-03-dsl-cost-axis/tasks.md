# Tasks: dsl-cost-axis

## 1. Нагрузка (PERF-6, CONT-4, design D1, D2)

- [x] 1.1 `integration-ts/test/benchLoad.ts`: `DSL_SCALE = 'dsl-scale'`, сцена `dslScene(entities)` с четырьмя JSON-системами design D1 (движение, ветвление, запрос с фильтром, эмиссия события) и сущностями сеткой, `dslScaleSizes()` по образцу `npcStressSizes()` (64/256, 24 тика); проверить: `runScenario` на обоих размерах без ошибок, `TICK_COST` даёт `expressions > 0` и `commandsApplied > 0` на каждом тике

## 2. Гейт и эталоны (PERF-4, design D3)

- [x] 2.1 `integration-ts/test/cost.test.ts`: прогон оси `dslEntities` тем же путём, что `npc-stress`, документ `engine/tests/golden/dsl-scale.cost.json`; `footprint.test.ts` — `dsl-scale.footprint.json`; проверить: `UPDATE_COST=1` создаёт оба документа, без флага тест сверяет точно
- [x] 2.2 `npm run golden:cost` из корня; проверить: дифф — только два новых документа, существующие эталоны не двигались; отношение L/S у `expressions` и `commandsApplied` записать в отчёт (ожидание ≈ 4)

## 3. Документация

- [x] 3.1 CLAUDE.md (абзац о `*.cost.json`): `dsl-scale.cost.json` как третья ось стороны симуляции; `docs/architecture.md`, строка `performance-budget`
- [x] 3.2 `npm run check` из корня зелёный
