# Tasks: wire-cost-baseline

## 1. Стенд провода (PERF-12, design D1, D2)

- [x] 1.1 `integration-ts/test/benchLoad.ts`: общие определения записей (генераторы ввода, число тиков, конфиг) вынесены из `matchGolden.test.ts` и используются обоими; `playWire(name)` — прогон записи через `playMatch` со сбором по слоту `snapshotBytes`, `snapshots`, `entitiesDelivered`, `eventsDelivered`, `bytesOther` из `HostReport` и применённых снапшотов; проверить: `matchGolden.test.ts` зелёный без изменения записей, два прогона `playWire` дают побитово одинаковый объект
- [x] 1.2 Утверждение `snapshotsSkipped === 0` для каждого соединения в тесте провода; проверить: тест зелёный

## 2. Ось клиентов (PERF-6, design D3)

- [x] 2.1 `wireClientsSizes()` — сцена с N героями и N клиентами (2/8), одинаковый ввод, 24 тика, по образцу `AxisSize`; проверить: матч на 8 клиентах доигрывается, у каждого клиента `latest` определён

## 3. Гейт и эталоны (PERF-4)

- [x] 3.1 `integration-ts/test/cost.test.ts`: секция `wire` в `match-*.cost.json` по слотам и документ `wire-clients.cost.json` (сумма по слотам и слот `p1` на размер); проверить: `UPDATE_COST=1` пишет, без флага сверяет точно
- [x] 3.2 `npm run golden:cost`; проверить: дифф — только секции `wire` и новый документ, остальные значения не двигались; отношение L/S суммы записать в отчёт

## 4. Документация

- [x] 4.1 CLAUDE.md (абзац о `*.cost.json`): секция `wire` и ось клиентов; `docs/architecture.md`, строка `performance-budget` — PERF-1..12
- [x] 4.2 `npm run check` из корня зелёный
