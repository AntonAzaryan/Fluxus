# Tasks: tick-cost-coverage

## 1. Калитки и запись (PERF-3, design D1, D2)

- [ ] 1.1 `core-ts/src/debug.ts`: семь полей контекста (`costAbilityCandidates`, `costProjectileSteps`, `costBuffSteps`, `costBuffCandidates`, `costVisibilityPairs`, `costTweenSteps`, `costEventsEmitted`), их сброс вместе с остальными, семь калиток `countCost*` по образцу `countCostNpcNeighbors` с комментарием о единице и о том, почему строка своя, семь строк в `recordTickCost` в алфавитном порядке `data`; проверить: `tickCost.test.ts` — запись содержит все поля, без стока калитки не исполняются и не аллоцируют
- [ ] 1.2 Вызовы калиток в горячих местах: скан кандидатов таргетинга (`abilities/runtime.ts`), проход снарядов (`abilities/projectile.ts`), проходы `apply`/`advance` и перебор `host()` (`abilities/buffs.ts`), цикл пар видимости (`systems/visibility.ts`), проход твинов (`systems/tween.ts`), `emit` (`ecs/events.ts`); один вызов на цикл с числом, на итерацию — только у `emit`; проверить: юнит-тесты в `core-ts/test/tickCost.test.ts` — каст со сканом двигает `abilityCandidates` ровно на число живых кандидатов запроса, снаряд в полёте даёт `projectileSteps` = 1 на тик, два инстанса одного баффа на одной цели дают `buffCandidates` ≥ 1, сцена с наблюдателем и двумя целями даёт `visibilityPairs` = 2, твин даёт `tweenSteps` = 1 на тик, `emit` даёт `eventsEmitted` = 1
- [ ] 1.3 Детерминизм и инертность: два прогона одного сценария дают побитово тот же поток `TICK_COST`; `traceParity.test.ts`, `traceCli.test.ts`, `apiSurface.test.ts` зелёные; прогнать чек-лист `determinism-review`

## 2. Гейт и эталоны (PERF-4, design D3)

- [ ] 2.1 `integration-ts/test/cost.test.ts`: секция `tick` собирается проходом по числовым полям `data` записи, а не перечнем (если перечень есть — убрать); проверить: тест зелёный до регенерации только с флагом `UPDATE_COST=1`, без него красный ровно новыми строками
- [ ] 2.2 `npm run golden:cost` из корня; проверить: дифф `engine/tests/golden/*.cost.json` содержит ТОЛЬКО добавленные строки секции `tick`, ни одно старое значение и ни один `*.footprint.json` не изменились; повторный прогон — пустой дифф
- [ ] 2.3 Прочитать новые числа на `npc-stress` (S/L): отношение L/S каждого нового счётчика записать в отчёт (квадратичность `visibilityPairs` и `buffCandidates`, если есть, — как факт, не как дефект change)

## 3. Документация

- [ ] 3.1 CLAUDE.md, абзац о `*.cost.json`: одна фраза о том, что сводка тика держит счётчик на каждую платформу ядра (PERF-3); `docs/architecture.md`, строка `performance-budget` в таблице capability — упомянуть покрытие платформ
- [ ] 3.2 `npm run check` из корня зелёный
