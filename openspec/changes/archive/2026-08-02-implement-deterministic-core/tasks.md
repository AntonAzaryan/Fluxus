## 1. Правка спек

- [x] 1.1 `openspec/specs/rng/spec.md` — RNG-1, RNG-3, RNG-7 по delta-спеке (xorshift128, FNV-1a 32, LE, splitmix32-развёртка)
- [x] 1.2 `openspec/specs/fixed-point-math/spec.md` — FP-4 по delta-спеке (определение debug-сборки)

## 2. Пакет

- [x] 2.1 `engine/core-ts`: package.json, tsconfig, vitest; сторонних зависимостей нет
- [x] 2.2 `src/types.ts` — контракты, общие для всех модулей

## 3. Этап 1 — fixed-point math

- [x] 3.1 `src/fixed.ts`: Q16.16, `mul` через hi/lo без BigInt, truncate toward zero, wrapping + debug assert (FP-1..4)
- [x] 3.2 `src/vector.ts`: Vec2 в Q16.16
- [x] 3.3 `src/mathApi.ts`: реализация `MathApi` как обязательной зависимости ядра (DI-2)
- [x] 3.4 Тесты: произведение > 2^53 против BigInt-эталона, `-1.5 → -1`, wrapping, assert в debug

## 4. Этап 2 — ECS foundation

- [x] 4.1 `src/ecs/world.ts`: world, entity index с versioning, реестр компонентов из JSON-схем + валидация (ECS-1, ECS-3, ECS-5)
- [x] 4.2 `src/ecs/query.ts`: `all/any/not/withinRadius/withTag`, материализация результата, порядок по `EntityId` (QUERY-1..3)
- [x] 4.3 `src/ecs/commands.ts`: Command Buffer, порядок применения = порядок создания (CMD-1, CMD-3, CMD-4)
- [x] 4.4 Тесты: удаление во время итерации, повторный запрос после своей команды видит старое состояние, два конкурентных изменения одного поля

## 5. Этап 3 — ID + RNG

- [x] 5.1 Generational ID: упаковка/распаковка, инвалидация ссылки после переиспользования слота (ID-1..3, ID-5)
- [x] 5.2 `src/rng.ts`: xorshift128, FNV-1a 32, splitmix32, реестр именованных стримов (RNG-1..4, RNG-7)
- [x] 5.3 Тесты: независимость стримов, воспроизводимость от seed, вырожденное нулевое состояние, зафиксированные константы для будущей cross-language сверки

## 6. Этап 4 — контракт системы

- [x] 6.1 `src/system.ts`: `System`, `SystemContext`, `SystemRegistry`; у системы нет канала записи, кроме `ctx.commands` (DET-7)
- [x] 6.2 DI: Math обязателен, Physics опционален — ядро собирается и тикает без него (DI-1..3)
- [x] 6.3 Тесты: тик без Physics API отрабатывает штатно

## 7. Этап 5 — event bus, scheduler, tick

- [x] 7.1 `src/events.ts`: EventBus, read-only `EventLog` (TICK-3, OBS-4)
- [x] 7.2 Scheduler: порядок по `order`, независимый от порядка регистрации; flush команд после каждой системы (DET-3, CMD-2)
- [x] 7.3 `src/tick.ts`: `tick(state, inputs) → TickResult`, `InputFrame`, заглушки `changes`/`mode`/`isReplay` (TICK-1..2, OBS-1)
- [x] 7.4 `TickObserver` + `dispatch` после `tick()` (OBS-2, OBS-3)
- [x] 7.5 Тесты: `tick` не мутирует переданный `state`; спавн в системе виден следующей по `order` в том же тике; порядок систем не зависит от порядка регистрации

## 8. Проверка

- [x] 8.1 `npm run typecheck` и `npm test` в `engine/core-ts` — зелёные
- [x] 8.2 `openspec validate --specs --strict`
- [x] 8.3 `openspec validate --change implement-deterministic-core --strict`
- [x] 8.4 Прогон одного сценария дважды даёт побитово одинаковое состояние (DET-1, в объёме доступных этапов)
