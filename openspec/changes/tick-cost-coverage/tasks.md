# Tasks: tick-cost-coverage

## 1. Калитки и запись (PERF-3, design D1, D2)

- [x] 1.1 `core-ts/src/debug.ts`: семь полей контекста (`costAbilityCandidates`, `costProjectileSteps`, `costBuffSteps`, `costBuffCandidates`, `costVisibilityPairs`, `costTweenSteps`, `costEventsEmitted`), их сброс вместе с остальными, шесть калиток `countCost*` по образцу `countCostNpcNeighbors` с комментарием о единице и о том, почему строка своя (седьмая величина, `costEventsEmitted`, складывается в существующую `countEvent` — по доводу `countCommands`), семь строк в `recordTickCost` в алфавитном порядке `data`; проверить: `tickCost.test.ts` — запись содержит все поля, без стока калитки не исполняются и не аллоцируют
- [x] 1.2 Вызовы калиток в горячих местах: скан кандидатов таргетинга (`abilities/runtime.ts`), проход снарядов (`abilities/projectile.ts`), проходы `apply`/`advance` и перебор `host()` (`abilities/buffs.ts`), цикл пар видимости (`systems/visibility.ts`), проход твинов (`systems/tween.ts`), `emit` (`ecs/events.ts`, через `countEvent`); один вызов на цикл с числом; проверить: юнит-тесты в `core-ts/test/tickCost.test.ts` — каст со сканом двигает `abilityCandidates` ровно на число живых кандидатов запроса, снаряд в полёте даёт `projectileSteps` = 1 на тик, два инстанса одного баффа на одной цели дают `buffCandidates` ≥ 1, сцена с наблюдателем и двумя целями даёт `visibilityPairs` = 2, твин даёт `tweenSteps` = 1 на тик, `emit` даёт `eventsEmitted` = 1
- [x] 1.3 Детерминизм и инертность: два прогона одного сценария дают побитово тот же поток `TICK_COST`; `traceParity.test.ts`, `traceCli.test.ts`, `apiSurface.test.ts` зелёные; прогнать чек-лист `determinism-review`

## 2. Гейт и эталоны (PERF-4, design D3)

- [x] 2.1 `integration-ts/test/cost.test.ts`: секция `tick` собирается проходом по числовым полям `data` записи, а не перечнем (если перечень есть — убрать); проверить: тест зелёный до регенерации только с флагом `UPDATE_COST=1`, без него красный ровно новыми строками
- [x] 2.2 `npm run golden:cost` из корня; проверить: дифф `engine/tests/golden/*.cost.json` содержит ТОЛЬКО добавленные строки секции `tick`, ни одно старое значение и ни один `*.footprint.json` не изменились; повторный прогон — пустой дифф
- [x] 2.3 Прочитать новые числа на `npc-stress` (S/L): отношение L/S каждого нового счётчика записать в отчёт (квадратичность `visibilityPairs` и `buffCandidates`, если есть, — как факт, не как дефект change)

## 2b. Ось «число кастующих агентов» (PERF-6, design D4)

- [x] 2.4 `integration-ts/test/benchLoad.ts`: `ABILITY_STRESS`, синтетическая сцена оси (кастеры сеткой со слотом, цикл ввода системой сцены, шаг `unit` с фигурой, `refresh`-бафф на общих целях, снаряд, твин на носителях здоровья, туман с двумя сторонами и укрытиями) и `abilityStressSizes()` по образцу `npcStressSizes()` — малый размер каждым четвёртым кастером; `content/` не читается (CONT-4); проверить: прогон обоих размеров без ошибок, все шесть новых счётчиков > 0 на КАЖДОМ размере
- [x] 2.5 `integration-ts/test/cost.test.ts` и `test/footprint.test.ts`: документы `ability-stress.cost.json` и `ability-stress.footprint.json` осью `abilityCasters`; проверки «нагрузка не мёртвая на обоих размерах», воспроизводимость и рост L/S (скан таргетинга и пары видимости — быстрее оси, шаги снарядов — ровно осью); проверить: `npm run golden:cost` создаёт оба документа, повторный прогон — пустой дифф
- [x] 2.6 Артефакты change под ось: `proposal.md` (What Changes, Capabilities — MODIFIED PERF-6), `design.md` (снять ложную посылку Non-Goals, решение D4), дельта `specs/performance-budget/spec.md` (PERF-6 целиком плюс ось тика и сценарий квадратичного поиска хозяина); проверить: `openspec validate tick-cost-coverage --type change`

## 3. Документация

- [x] 3.1 CLAUDE.md, абзац о `*.cost.json`: одна фраза о том, что сводка тика держит счётчик на каждую платформу ядра (PERF-3), и упоминание третьей оси стороны симуляции; `docs/architecture.md`, строка `performance-budget` в таблице capability — упомянуть покрытие платформ
- [x] 3.2 `npm run check` из корня зелёный
