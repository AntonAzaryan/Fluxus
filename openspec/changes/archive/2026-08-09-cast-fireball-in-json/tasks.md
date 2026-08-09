## 1. Сцена: каст целиком в JSON

- [x] 1.1 В `content/scenes/duel.scene.json` дополнить систему `Cast` (order 30): внутри ветки `then` связать `let` направление `dir` как `vec [cos(aimDir), sin(aimDir)]`, где `aimDir` — `getComponent [e, "Input", "aimDir"]`
- [x] 1.2 Там же добавить `spawnEntity` prefab'а `Fireball` с переопределением `Position` (позиция героя + `dir` × 29491) и `Velocity` (`dir` × 16384) — покомпонентно через `vec.x`/`vec.y`
- [x] 1.3 Дополнить `emitEvent CastFireball` полями `dirX`/`dirY` рядом с существующими `entity`/`slot`/`tick`

## 2. Демо: снять нативную систему и упаковку

- [x] 2.1 Удалить из `engine/client-ts/demo/sim.ts` систему `FireballLaunch`, функции `packAimDir`/`unpackAimDir`, константы `FIREBALL_SPEED`/`FIREBALL_SPAWN_OFFSET` и их регистрацию; поправить шапку модуля (нативной остаётся только `FireballImpact` — до этапа 31)
- [x] 2.2 В `engine/client-ts/demo/main.ts` заменить `packAimDir` расчётом угла (`Math.atan2` → BAM, `& 0xffff`); поправить комментарий у `pendingCast`
- [x] 2.3 В `engine/client-ts/demo/worker.ts` перевести `aimEvents` на `CastFireball` и убрать комментарий про этап 30

## 3. Проверка

- [x] 3.1 `npm run typecheck` и `npm test` из корня — зелено
- [x] 3.2 `npm run golden` из корня: эталоны обязаны остаться побитово прежними — они собраны из фикстур движка, а не из дерева контента (CONT-4); любой дифф здесь означает, что работа задела движок
- [x] 3.3 Headless-прогон сцены дуэли (сборка через `createDemoSimulation`, несколько тиков с битом каста): событие `CastFireball` одно, `dirX`/`dirY` совпадают с углом, снаряд заспавнен со скоростью 0.25 в ту же сторону
- [x] 3.4 Прогнать демо вручную (`npm run dev -w @game-mvp/client`): каст летит в сторону клика, торс доворачивается (REND-5), дыра в полу на затухании по-прежнему появляется
