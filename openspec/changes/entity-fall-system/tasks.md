# entity-fall-system — tasks

## 1. Контент: падение в сцене дуэли

- [x] 1.1 `content/scenes/duel.scene.json`: добавить `arena` (центр — середина карты 24×24 в Q16.16, радиус с запасом покрывает карту), объявить компонент `Falling { progress: i32, duration: i32 }`, добавить `ArenaState: { support: 0 }` в prefab героя
- [x] 1.2 Там же: система `FallStart` (order 120): `forEachEvent FellThroughFloor` → `addComponent Falling { progress: 0, duration: 45 }` на сущность события + `modifyComponent Velocity → { x: 0, y: 0 }` (design §4; guard `if` на живость/наличие `Velocity` — по фактическим требованиям валидатора DSL)
- [x] 1.3 Там же: система `FallProgress` (order 121): `query all ["Falling"]` — инкремент `progress`; при `progress >= duration` → `emitEvent EntityDied { entity }` + `destroyEntity` (design §3)
- [x] 1.4 Там же: `not: ["Falling"]` в запросах `Movement`, `KillSwitch`, `Cast`
- [x] 1.5 `content/visuals/manifest.json`: маппинг события `FellThroughFloor` на one-shot клип падения у героя (REND-4)

## 2. Рендер: снижение по прогрессу падения (REND-12)

- [x] 2.1 `engine/render-ts/src/extractor.ts`: конфиг `fall?: { component, progressField, durationField }`, колонка `fall: Float32Array` — `progress/duration` кламп [0, 1], `NaN` — не падает
- [x] 2.2 `engine/render-ts/src/types.ts` + `viewBuffer.ts`: `EntityView.prevFall`/`currFall` (число, 0 — не падает; snap-правила позиции, spawn → prev = curr)
- [x] 2.3 `engine/render-ts/src/subsystems/models.ts`: в `updateFrame` смещение `holder.position.z` на `-fallDepth · t²` от интерполированного прогресса; опция `fallDepth` с дефолтом; наклон по поверхности не применяется при `t > 0` (REND-10, REND-12)
- [x] 2.4 `engine/client-ts/src/codec.ts`: колонка `fall` в f32-блоке плоской формы (encode/decode)
- [x] 2.5 `engine/client-ts/demo/worker.ts` (и однопоточная сборка, если конфиг дублируется): проводка `fall`-конфига extractor'а на компонент `Falling`

## 3. Тесты

- [x] 3.1 render-ts: extractor — колонка `fall` (нормировка, кламп, `NaN` без компонента/конфига); viewBuffer — prev/curr и snap; models — z-смещение и отключение наклона
- [x] 3.2 client-ts: codec round-trip с колонкой `fall` (включая `NaN`)
- [x] 3.3 integration-ts: инлайн-фикстура (CONT-4) — сцена с ареной, дырой и JSON-системами падения; сущность над дырой: `FellThroughFloor` на первом тике, `EntityDied` ровно через `duration` тиков, сущность уничтожена; сущность на полу — ничего не происходит

## 4. Проверка

- [x] 4.1 `npm run check` из корня — зелено
- [x] 4.2 `npm run golden` из корня: эталоны движка побитово прежние (CONT-4); дифф — сигнал, что задет движок
- [x] 4.3 Headless-прогон демо (`createDemoSimulation`): загнать героя на дыру `_`, убедиться в `FellThroughFloor` → `EntityDied` → исчезновении из мира
