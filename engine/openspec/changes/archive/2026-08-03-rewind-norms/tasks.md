## 1. Спека snapshot-rewind

- [x] 1.1 `specs/snapshot-rewind/spec.md` — MODIFIED REW-4: сузить «обычные системы выключены» до реакции на внешний ввод в реальном времени, явно исключив внутренний реплей `seekTo` (сверено с `src/sim/tick.ts:97` `advance()` и `src/sim/rewind.ts:139`), снять кажущееся противоречие с TIME-9
- [x] 1.2 `specs/snapshot-rewind/spec.md` — MODIFIED SNAP-6: заменить формулу глубины буфера на `interval × (count − 1)` (сверено с `RingHistory.depth`, `src/sim/history.ts:48`)
- [x] 1.3 Добавить сценарии, покрывающие новый текст: реплей внутри `seekTo` исполняет обычные системы; числовая проверка формулы SNAP-6

## 2. Проверка

- [x] 2.1 `openspec validate rewind-norms --strict` проходит
- [x] 2.2 Убедиться, что код в `core-ts` не тронут (это норм-only change)
