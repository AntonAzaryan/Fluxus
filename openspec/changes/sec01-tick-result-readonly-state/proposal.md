# Read-only отчёт о тике: `TickResult.state` перестаёт быть каналом записи

## Why

OBS-1 называет `TickResult` read-only отчётом о тике, а TICK-3 запрещает внешнему слою менять состояние вне тика. Валидация спек против кода (2026-09-01, `docs/reviews/spec-validation-2026-09-01/01-core-math.md`) показала, что типом это держалось только наполовину: мир (ECS) закрыт — `WorldState` непрозрачен, мутаторов наружу нет, — а соседние части состояния открыты настежь. `TickResult.state` объявлен как `SimulationState`, в котором `tick` и `mode` изменяемы, `events` — полноценная шина с `emit`/`clear`/`restore`, а `rng` — реестр с `restore`.

Практически это значит, что наблюдатель аналитики внутри `onTick` может написать `result.state.tick = 999`, `result.state.mode = 'Paused'` или `result.state.events.emit('DamageDealt', {amount: 999})`. Всё перечисленное — части состояния симуляции по SNAP-1: они входят в снапшот и восстанавливаются перемоткой. Их правка из observer'а — изменение состояния вне тика внешним слоем, то есть ровно тот side-channel, который отрицает TICK-3; отличается он от запрещённого только тем, что мир (ECS) при этом не тронут. Ни компилятор, ни тесты этого не замечали: `readonly` на полях `TickResult` запрещает подменить ссылку, но не запрещает переписать то, на что она указывает.

## What Changes

- **OBS-1:** поле `state` отчёта SHALL нести объём SNAP-1 read-only проекцией: канала записи у отчёта не остаётся ни в номер тика, ни в режим мира, ни в шину событий, ни в реестр стримов RNG. Отдельным абзацем сказано, почему `readonly` на полях самого отчёта этого не даёт, и что проверяемость нормы держится типом, а не примечанием. Новый сценарий — попытка наблюдателя поправить состояние через отчёт.
- **Код (сделан этим же заходом):** в `engine/core-ts/src/types.ts` появились `ReadonlySimulationState` и `ReadonlyRngRegistry`; `SimulationState` и `RngRegistry` расширяют их, поэтому состояние хоста по-прежнему передаётся в `tick()` без единой конверсии. `TickResult.state` типизирован проекцией.
- **Код, чтение через проекцию:** `takeSnapshot`, `HistoryProvider.record` и `filterSnapshot` принимают проекцию — все трое только читают состояние, а ведёт историю чаще всего именно наблюдатель, у которого на руках отчёт.
- **Тест:** типовая проверка в `engine/core-ts/test/tick.test.ts` — пять запрещённых записей под `@ts-expect-error`, тело намеренно не исполняется.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `tick-loop`: OBS-1 — поле `state` отчёта несёт объём SNAP-1 read-only проекцией.

## Impact

- `engine/core-ts`: `src/types.ts` (два новых типа, `TickResult.state`, `HistoryProvider.record`), `src/sim/tick.ts` (`takeSnapshot`), `src/sim/history.ts` (`RingHistory.record`), `src/sim/filter.ts` (`filterSnapshot`), тест `test/tick.test.ts`.
- Поведение симуляции не меняется ни на бит: правка чисто типовая, рантайм-объекты те же. Golden- и cost-эталоны не двигаются.
- Публичная рантайм-поверхность ядра (CLI-8, `test/api-surface.golden.json`) не меняется: добавлены типы, а не значения.
- Потребители отчёта (`engine/render-ts`, `engine/net-ts`, `engine/client-ts`, `engine/bot-ts`, `engine/integration-ts`) компилируются без правок — они и так только читали.
