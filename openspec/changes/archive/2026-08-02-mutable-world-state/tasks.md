## 1. Правка спек

- [x] 1.1 `specs/tick-loop/spec.md` — TICK-1: `tick()` мутирует состояние на месте
- [x] 1.2 `specs/snapshot-rewind/spec.md` — SNAP-4: интервал снятия как параметр `HistoryProvider`
- [x] 1.3 `specs/snapshot-rewind/spec.md` — SNAP-5: structural sharing запрещён при мутабельном мире
- [x] 1.4 `specs/snapshot-rewind/spec.md` — SNAP-6: `count × interval` покрывает глубину политики
- [x] 1.5 `specs/snapshot-rewind/spec.md` — REW-2: восстановление = ближайший снапшот + реплей вперёд

## 2. Реализация

- [x] 2.1 `src/tick.ts`: `tick()` мутирует `state`, `TickResult.state` — та же ссылка
- [x] 2.2 `src/types.ts`: `SimulationState` мутабелен, `rng` — реестр; добавлен тип `Snapshot`
- [x] 2.3 `src/tick.ts`: `takeSnapshot()` / `restoreSnapshot()` как механика истории
- [x] 2.4 `cloneWorld` остаётся, но вызывается только при снятии и восстановлении снапшота

## 3. Тесты

- [x] 3.1 `tick()` возвращает ту же ссылку на state, номер тика продвинут
- [x] 3.2 Снапшот переживает последующие тики и не «едет» вслед за живым миром
- [x] 3.3 Снапшот + реплей вперёд даёт то же состояние, что честный прогон (REW-2)
- [x] 3.4 Состояние RNG-стримов входит в снапшот и восстанавливается (RNG-5)
- [x] 3.5 Мутационная проверка: снапшот без копии мира валит тесты 3.2 и 3.3

## 4. Замеры

- [x] 4.1 `bench/query.bench.ts` — стоимость полной копии мира на 5000 сущностей
- [x] 4.2 Вопросы, требующие замеров на будущих этапах (интервалы `HistoryProvider`, стоимость `seekTo` при скрабе), вынесены в `## Open Questions` спеки `snapshot-rewind`

## 5. Проверка

- [x] 5.1 `npm run typecheck` и `npm test` — зелёные
- [x] 5.2 `openspec validate --specs --strict`
- [x] 5.3 `openspec validate --changes --strict`
