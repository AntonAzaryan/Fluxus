## 1. Сцена: каст целиком в JSON

- [ ] 1.1 В `content/scenes/duel.scene.json` дополнить систему `Cast` (order 30): внутри ветки `then` связать `let` направление `dir` как `vec [cos(aimDir), sin(aimDir)]`, где `aimDir` — `getComponent [e, "Input", "aimDir"]`
- [ ] 1.2 Там же добавить `spawnEntity` prefab'а `Fireball` с переопределением `Position` (позиция героя + `dir` × 29491) и `Velocity` (`dir` × 16384) — покомпонентно через `vec.x`/`vec.y`
- [ ] 1.3 Дополнить `emitEvent CastFireball` полями `dirX`/`dirY` рядом с существующими `entity`/`slot`/`tick`

## 2. Демо: снять нативную систему и упаковку

- [ ] 2.1 Удалить из `engine/client-ts/demo/sim.ts` систему `FireballLaunch`, функции `packAimDir`/`unpackAimDir`, константы `FIREBALL_SPEED`/`FIREBALL_SPAWN_OFFSET` и их регистрацию; поправить шапку модуля (нативной остаётся только `FireballImpact` — до этапа 31)
- [ ] 2.2 В `engine/client-ts/demo/main.ts` заменить `packAimDir` расчётом угла (`Math.atan2` → BAM, `& 0xffff`); поправить комментарий у `pendingCast`
- [ ] 2.3 В `engine/client-ts/demo/worker.ts` перевести `aimEvents` на `CastFireball` и убрать комментарий про этап 30

## 3. Проверка

- [ ] 3.1 `npm run typecheck` и `npm test` из корня — зелено
- [ ] 3.2 `npm run golden` из корня, разобрать дифф эталонов: ожидается только текст сцены в сценариях `match-*` и производные хеши; расхождение в состоянии сущностей — разобрать, а не принять
- [ ] 3.3 Прогнать демо-сцену вручную (`npm run dev -w @game-mvp/client`): каст летит в сторону клика, торс доворачивается (REND-5), дыра в полу на затухании по-прежнему появляется
