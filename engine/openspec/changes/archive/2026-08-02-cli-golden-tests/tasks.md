## 1. Прогон сценария

- [x] 1.1 `src/scenario.ts`: `ScenarioDef` — сцена, seed, ticks, начальная расстановка, инпуты (CLI-2)
- [x] 1.2 `runScenario(def)` — загрузка сцены, расстановка, цикл тиков, запись на тик (CLI-3)
- [x] 1.3 Инпуты раскладываются по тикам по собственному полю `tick` (TICK-2)
- [x] 1.4 События тика попадают в запись; ключи `data` сортируются (SER-6)
- [x] 1.5 `runScenarioBytes` — тот же документ в pretty JSON; экспорт из `src/index.ts`

## 2. CLI

- [x] 2.1 `bin/sim.mjs`: `node bin/sim.mjs <scenario.json>` → снапшоты в stdout (CLI-1)
- [x] 2.2 Запуск без сборки: resolve-хук `./x.js` → `./x.ts`, `engines.node >= 22.18`
- [x] 2.3 Скрипты `npm run sim` и `npm run golden`

## 3. Golden-сьют (CLI-4, CLI-5)

- [x] 3.1 `engine/tests/golden/` вне `core-ts`; `*.scenario.json` + `*.golden.json`
- [x] 3.2 `movement` — запрос, арифметика Q16.16, `modifyComponent`, overrides расстановки
- [x] 3.3 `burning` — смерть по условию, событие, спавн по номеру тика, переиспользование слота ID
- [x] 3.4 `test/golden.test.ts` — адаптер: находит сценарии, сверяет строку целиком
- [x] 3.5 `UPDATE_GOLDEN=1` перезаписывает эталоны, обычный прогон только сверяет

## 4. Схема сценария (SER-5)

- [x] 4.1 `scenario.schema.json` порождается тем же генератором, `$ref` на схему сцены
- [x] 4.2 Файл перегенерирован через `npm run schemas`, тест сверки зелёный

## 5. Проверка

- [x] 5.1 Два прогона одного сценария дают те же байты (DET-1)
- [x] 5.2 Вывод `bin/sim.mjs` совпадает с эталоном байт в байт — CLI и сьют не разошлись
- [x] 5.3 `npm test` и `npm run typecheck` в `core-ts` зелёные
- [x] 5.4 `openspec validate cli-golden-tests --strict`
- [x] 5.5 `docs/architecture.md` §5 — этап 10 отмечен выполненным
