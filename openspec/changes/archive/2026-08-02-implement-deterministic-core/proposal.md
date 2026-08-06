## Why

Спеки описывают ядро целиком, но кода нет ни строки. Этапы 1–5 roadmap (`docs/architecture.md` §5) — минимальный срез, после которого симуляция реально тикает: `tick(state, inputs) → TickResult` на нативных системах. До него ни один нормативный сценарий нельзя проверить исполнением, а `CORE-3` («спека — источник истины») остаётся непроверяемым утверждением.

Реализация вскрыла две дыры в спеках. Обе — не разногласия с требованием, а места, где требование обязывает к побитовой парности TS↔Rust, но не называет алгоритм, поэтому парность недостижима:

- `RNG-1` перечисляет три кандидата PRNG и не выбирает; `RNG-3` задаёт `seed = hash(worldSeed, streamName)` без указания хеша; `RNG-7` требует «зафиксированный одинаково порядок байт», сам его не фиксируя.
- `FP-4` требует assert в «debug-сборке», но что такое debug-сборка вне Rust — не определено.

## What Changes

- Новый пакет `engine/core-ts` — TS-реализация ядра (`CORE-1`), этапы 1–5:
  - **fixed-point math**: Q16.16 на `i32`, `mul` через hi/lo без `BigInt`, truncate toward zero, wrapping-переполнение + debug-assert, векторы.
  - **ECS foundation**: собственное SoA-хранилище по JSON-схемам, битовые маски принадлежности компонентов, Query API (`all/any/not/withinRadius/withTag`) с материализованным результатом, Command Buffer с flush per-system.
  - **Entity IDs + RNG**: generational `{index, generation}`, монотонный счётчик в world state; именованные стримы от world seed.
  - **System contract**: `System` / `SystemContext` / `SystemRegistry`, DI Math (обязательный) и Physics (опциональный).
  - **Tick loop**: EventBus, Scheduler по `order`, `tick()`, `TickResult`, `TickObserver`.
- `rng`: зафиксирован конкретный PRNG (xorshift128 на u32), хеш имени стрима (FNV-1a 32) и порядок байт при сидинге.
- `fixed-point-math`: определено, что такое debug-сборка, в терминах, воспроизводимых в обеих реализациях.

Заглушки, разрешённые `architecture.md` §5: `TickResult.changes` — пустой `ChangeSet` до этапа 9; `mode`/`isReplay` — константы `Running`/`false` до этапа 12.

## Capabilities

### New Capabilities

Нет. Реализуются уже существующие.

### Modified Capabilities

- `rng`: RNG-1 — выбран xorshift128; RNG-3 — хеш назван (FNV-1a 32); RNG-7 — зафиксирован порядок байт и способ развёртки seed в состояние генератора.
- `fixed-point-math`: FP-4 — определено понятие debug-сборки для обеих реализаций; FP-5 (новое) — деление на ноль насыщающее.
- `ecs-foundation`: ECS-1 — сторонняя ECS-библиотека не используется; ID-1 — зафиксирована разрядность и запрет 32-битных контейнеров для списков id; QUERY-1 — включающая граница радиуса; QUERY-2 — порядок по возрастанию raw-индекса.

## Impact

- Спеки: `openspec/specs/rng/spec.md`, `openspec/specs/fixed-point-math/spec.md`, `openspec/specs/ecs-foundation/spec.md`.
- Код: новый пакет `engine/core-ts` (`src/`, `test/`, `bench/`), сторонних runtime-зависимостей нет.
- Не затрагивается: `draft/` — остаётся песочницей, кодом-референсом, не базой.
- Следующие этапы (6+, evaluator и далее) опираются на контракты `System`/`SystemContext`, зафиксированные здесь.
