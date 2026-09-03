# Design: wire-cost-baseline

## Context

- **Стенд есть.** `integration-ts/test/fixtures.ts`: `harness()` (LoopbackHub + MatchServer + MatchHost), `connectClient`, `playMatch(ticks, inputs, config)` — детерминированный loopback-матч с генераторами ввода `walkRight`, `fuzzInput`; `matchGolden.test.ts` записывает `match-*` именно им. `MatchHost.report()` отдаёт `HostReport.connections[]` с `snapshotBytes`, `snapshots`, `bytes`, `snapshotsSkipped` по соединению (NTR-11, NTR-22).
- **Кодек детерминирован.** `@msgpack/msgpack` кодирует значение по построению: фиксированные числа — целые, порядок ключей — порядок конструирования `toWireSnapshot`. Ни времени, ни случайности.
- **Состав доставленного** виден на клиенте: `client.latest` — применённый персональный снапшот (число сущностей и событий в нём).
- **Форма документов.** `match-*.cost.json` — секции по стадиям (`tick`, `extract`, пресеты); документ оси — `{ axis, small, large, cost: { small, large } }`.

## Goals / Non-Goals

**Goals:** секция `wire` по слоту на записях; ось `clients` с документом `wire-clients.cost.json`; величины — из `HostReport` и снапшотов, без второго кодека; регенерация `golden:cost`.

**Non-Goals:** не транспорт (WebSocket, backlog — время и ОС, PERF-5 при надобности); не память сервера (CLI-11); не правка проекции NET-18 и фильтра — если числа покажут лишнее, это отдельный change; не `*.footprint.json` для провода — состояние провода не хранится.

## Decisions

### D1. Источник величин

`snapshotBytes`, `snapshots` — из `HostReport.connections[i]` после прогона; `entitiesDelivered`, `eventsDelivered` — сумма по применённым снапшотам клиента слота (счёт на каждой итерации `playMatch`, где `client.latest` обновился); `eventBytes` — байты сообщений `Events` соединения = `bytes − snapshotBytes` минус хендшейк (если хендшейк не выделяется отчётом — считать `bytesOther` как есть и назвать честно). Утверждение `snapshotsSkipped === 0` — в тесте.

### D2. Записи

`playMatch` вызывается с теми же генераторами и числом тиков, что в `matchGolden.test.ts` (вынести общие определения в `benchLoad.ts`, чтобы стенд записи и стенд провода не разошлись). Секция `wire` в `match-*.cost.json`: `{ "p1": { snapshotBytes, snapshots, entitiesDelivered, eventsDelivered, bytesOther }, "p2": … }`. `extract`/`tick` этих документов не трогаются.

### D3. Ось `clients`

Сцена дуэли с N героями (`Player.slot` 0..N−1, команды через одну) и N клиентами, одинаковый ввод (`walkRight`), 24 тика; `small` = 2, `large` = 8 (в пределах продуктовых «до 10»). Документ `wire-clients.cost.json`: по размеру — сумма по всем слотам и то же по слоту `p1`; L/S суммы читается против L/S = 4.

## Risks / Trade-offs

- **Вложенность стенда** — `playMatch` асинхронен через `settle()`; `cost.test.ts` синхронен. Тест провода — отдельный `it` с `async`, документ пишется тем же помощником эталона.
- **Хендшейк в байтах** — не снапшот и константен; входит в `bytesOther` с комментарием.
